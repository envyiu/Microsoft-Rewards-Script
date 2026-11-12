import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
const require = createRequire(import.meta.url)
const dist = process.env.MRS_TEST_DIST || path.resolve('dist')
const { Login } = require(path.join(dist, 'browser/auth/Login.js'))
const { MobileAccessLogin } = require(path.join(dist, 'browser/auth/methods/MobileAccessLogin.js'))
const { EmailLogin } = require(path.join(dist, 'browser/auth/methods/EmailLogin.js'))
const { isAccountReviewUrl, safeAuthorizationLocation } = require(path.join(dist, 'browser/auth/AuthorizationRoute.js'))
function fixture() {
    const messages = []
    const logger = Object.fromEntries(
        ['debug', 'info', 'warn', 'error'].map(level => [
            level,
            (_mobile, title, message) => messages.push({ level, title, message })
        ])
    )
    const bot = {
        isMobile: true,
        logger,
        utils: { wait: async () => {} },
        browser: { utils: { tryDismissAllMessages: async () => {} } }
    }
    return { bot, messages }
}

test('a checkpoint during state detection never enters email or records a fatal login error', async () => {
    const { bot, messages } = fixture()
    bot.config = { experimental: { blockMedia: false } }
    bot.browser.utils.reloadBadPage = async () => {}
    bot.browser.utils.disableFido = async () => {}
    const login = new Login(bot)
    login.hasStoredAuthCookies = async () => false
    login.detectCurrentState = async () => {
        bot.shuttingDown = true
        return 'EMAIL_INPUT'
    }
    let handled = false
    login.handleState = async () => {
        handled = true
        return false
    }
    const page = { context: () => ({}), goto: async () => {}, isClosed: () => false }
    await assert.rejects(login.login(page, { email: 'fixture@example.test' }), /interrupted/)
    assert.equal(handled, false)
    assert.ok(!messages.some(m => m.level === 'error'))
    assert.ok(messages.some(m => m.message === 'Login interrupted by session checkpoint'))
})

test('closing the email field for a checkpoint does not log missing-field or login errors', async () => {
    const { bot, messages } = fixture()
    const page = {
        waitForSelector: async () => {
            bot.shuttingDown = true
            throw new Error('page closed')
        }
    }
    assert.equal(await new EmailLogin(bot).enterEmail(page, 'fixture@example.test'), 'error')
    assert.deepEqual(messages, [])
})
function bingPage({ authenticated = true, review = false } = {}) {
    let url = 'https://rewards.bing.com/earn'
    const navigations = []
    return {
        navigations,
        url: () => url,
        isClosed: () => false,
        goto: async target => {
            navigations.push(target)
            url = target.includes('action=interactive')
                ? review
                    ? 'https://account.live.com/Abuse?private=sensitive'
                    : 'https://www.bing.com/'
                : target
        },
        context: () => ({ cookies: async () => (authenticated ? [{ name: '_U', value: 'synthetic-cookie' }] : []) }),
        waitForSelector: async () => {
            if (authenticated) return {}
            throw new Error('No signed-in profile')
        }
    }
}
test('a valid stored Bing session does not trigger another interactive login', async () => {
    const { bot, messages } = fixture(),
        page = bingPage()
    assert.equal(await new Login(bot).verifyBingSession(page, {}), true)
    assert.deepEqual(page.navigations, ['https://www.bing.com'])
    assert.ok(messages.some(m => m.message.includes('existing browser session')))
})
test('Bing review redirect stops promptly without falsely declaring the account locked', async () => {
    const { bot, messages } = fixture(),
        page = bingPage({ authenticated: false, review: true })
    assert.equal(await new Login(bot).verifyBingSession(page, {}), false)
    assert.equal(page.navigations.length, 2)
    assert.ok(!messages.some(m => m.message.includes('verified successfully')))
    assert.ok(!JSON.stringify(messages).includes('sensitive'))
})
test('a mobile guest Bing page is not accepted merely because it is a mobile browser', async () => {
    const { bot, messages } = fixture()
    assert.equal(await new Login(bot).verifyBingSession(bingPage({ authenticated: false }), {}), false)
    assert.ok(!messages.some(m => m.message.includes('verified successfully')))
})
test('an OAuth request review redirect permits one browser-context check without an authorization retry loop', async () => {
    const { bot, messages } = fixture()
    let browserAttempts = 0
    bot.newBrowserPage = async () => {
        browserAttempts++
        return { goto: async () => {}, url: () => 'https://account.live.com/Abuse', close: async () => {} }
    }
    const page = {
        context: () => ({}),
        request: {
            get: async () => ({
                url: () => 'https://account.live.com/Abuse?login_hint=private@example.test',
                status: () => 200
            })
        }
    }
    assert.equal(await new MobileAccessLogin(bot, page).get('one@example.test'), '')
    assert.equal(browserAttempts, 1)
    assert.ok(messages.some(m => m.message.includes('account-review redirect')))
    assert.ok(!JSON.stringify(messages).includes('private@example.test'))
})
test('browser OAuth fallback detects a late review redirect and closes only the OAuth page', async () => {
    const { bot, messages } = fixture()
    let current = 'https://login.live.com/oauth20_authorize.srf',
        closed = false
    const oauth = {
        goto: async () => {},
        url: () => current,
        locator: () => ({ first: () => ({ isVisible: async () => false }) }),
        getByRole: () => ({ first: () => ({ isVisible: async () => false }) }),
        waitForURL: async predicate => {
            current = 'https://account.live.com/Abuse'
            assert.equal(predicate(new URL(current)), true)
        },
        close: async () => {
            closed = true
        }
    }
    bot.newBrowserPage = async () => oauth
    const page = { context: () => ({}), request: { get: async () => ({ url: () => current, status: () => 200 }) } }
    assert.equal(await new MobileAccessLogin(bot, page).get('one@example.test'), '')
    assert.ok(closed)
    assert.ok(messages.some(m => m.message.includes('OAuth browser result')))
})
test('successful OAuth code exchange retains the existing behavior without exposing codes or tokens', async () => {
    const { bot, messages } = fixture()
    bot.http = { request: async () => ({ data: { access_token: 'synthetic-private-token' } }) }
    const page = {
        request: {
            get: async () => ({
                url: () => 'https://login.live.com/oauth20_desktop.srf?code=synthetic-private-code',
                status: () => 200
            })
        }
    }
    assert.equal(await new MobileAccessLogin(bot, page).get('one@example.test'), 'synthetic-private-token')
    assert.ok(!JSON.stringify(messages).includes('synthetic-private-code'))
    assert.ok(!JSON.stringify(messages).includes('synthetic-private-token'))
})
test('account review detection is host scoped and diagnostic locations never include OAuth queries', () => {
    assert.equal(isAccountReviewUrl('https://account.live.com/Abuse'), true)
    assert.equal(isAccountReviewUrl('https://example.test/Abuse'), false)
    assert.equal(isAccountReviewUrl('https://account.live.com/AbuseNotThis'), false)
    assert.equal(
        safeAuthorizationLocation('https://login.live.com/oauth20_desktop.srf?code=private#fragment'),
        'login.live.com/oauth20_desktop.srf'
    )
})

function flyoutAccount() {
    return {
        userInfo: { isRewardsUser: true, balance: 0, profile: { attributes: {} } },
        flyoutResult: { userStatus: { isRewardsUser: true, availablePoints: 0, counters: {} } }
    }
}
test('mobile Bing without desktop profile markup reuses a server-validated session', async () => {
    const { bot } = fixture(),
        page = bingPage()
    page.waitForSelector = async () => {
        throw new Error('Mobile homepage has no #id_n')
    }
    let requests = 0
    page.request = {
        get: async () => {
            requests++
            return { status: () => 200, json: async () => flyoutAccount() }
        }
    }
    assert.equal(await new Login(bot).verifyBingSession(page, {}), true)
    assert.deepEqual(page.navigations, ['https://www.bing.com'])
    assert.equal(requests, 1)
})
for (const scenario of ['guest', 'error', 'malformed', 'timeout']) {
    test(`Bing flyout ${scenario} is not accepted as authenticated`, async () => {
        const { bot } = fixture(),
            page = bingPage()
        page.waitForSelector = async () => {
            throw new Error('No profile')
        }
        page.request = {
            get: async () => {
                if (scenario === 'timeout') throw new Error('Request timeout')
                const data = scenario === 'malformed' ? {} : flyoutAccount()
                if (scenario === 'guest') data.userInfo.isRewardsUser = false
                if (scenario === 'error') data.isError = true
                return { status: () => 200, json: async () => data }
            }
        }
        assert.equal(await new Login(bot).hasAuthenticatedBingSession(page), false)
    })
}
test('a missing auth cookie cannot be replaced by guest markup or an API response', async () => {
    const { bot } = fixture(),
        page = bingPage({ authenticated: false })
    page.request = {
        get: async () => {
            throw new Error('Must not request without an auth cookie')
        }
    }
    assert.equal(await new Login(bot).hasAuthenticatedBingSession(page), false)
})
for (const stored of [true, false]) {
    test(`login starts at ${stored ? 'earn for a saved session' : 'the auth route for a fresh session'}`, async () => {
        const { bot } = fixture(),
            page = bingPage({ authenticated: stored })
        bot.browser.utils.reloadBadPage = async () => {}
        bot.browser.utils.disableFido = async () => {}
        const login = new Login(bot)
        login.detectCurrentState = async () => 'LOGGED_IN'
        login.finalizeLogin = async () => {}
        await login.login(page, {})
        assert.deepEqual(page.navigations, [
            stored ? 'https://rewards.bing.com/earn' : 'https://rewards.bing.com/auth/login'
        ])
    })
}
test('a stalled Rewards login route gets one earn recovery rather than an endless navigation loop', async () => {
    const { bot } = fixture()
    bot.config = {}
    let attempts = 0
    const page = {
        url: () => 'https://rewards.bing.com/auth/login?private=secret',
        goto: async () => {
            attempts++
        }
    }
    const login = new Login(bot)
    await login.handleState('UNKNOWN', page, {})
    await login.handleState('UNKNOWN', page, {})
    assert.equal(attempts, 1)
})
test('an unrecognized earn page is reloaded once after three checks without discarding its session', async () => {
    const { bot, messages } = fixture()
    bot.config = {}
    const navigations = []
    const page = {
        url: () => 'https://rewards.bing.com/earn',
        goto: async target => navigations.push(target)
    }
    const login = new Login(bot)
    await login.handleState('UNKNOWN', page, {})
    await login.handleState('UNKNOWN', page, {})
    assert.equal(navigations.length, 0)
    await login.handleState('UNKNOWN', page, {})
    for (let i = 0; i < 25; i++) await login.handleState('UNKNOWN', page, {})
    assert.deepEqual(navigations, ['https://rewards.bing.com/earn'])
    assert.ok(messages.some(m => m.message.includes('reloading once with the existing session')))
})
test('unrecognized account-review pages never enter earn-page recovery', async () => {
    const { bot } = fixture()
    bot.config = {}
    let navigations = 0
    const page = { url: () => 'https://account.live.com/Abuse', goto: async () => navigations++ }
    const login = new Login(bot)
    for (let i = 0; i < 4; i++) await login.handleState('UNKNOWN', page, {})
    assert.equal(navigations, 0)
})
for (const authRoute of [true, false]) {
    test(`generic Rewards text ${authRoute ? 'on an auth route' : 'with only tracking cookies'} does not prove login`, async () => {
        const { bot } = fixture()
        const locator = { first: () => locator, innerText: async () => 'Microsoft Rewards' }
        const page = {
            waitForLoadState: async () => {},
            url: () => `https://rewards.bing.com/${authRoute ? 'auth/login' : 'earn'}`,
            context: () => ({ cookies: async () => [{ name: authRoute ? '_U' : 'MUID', value: 'synthetic' }] }),
            locator: () => locator
        }
        const login = new Login(bot)
        login.checkSelector = async () => false
        assert.equal(await login.detectCurrentState(page), 'UNKNOWN')
    })
}

test('a filtered non-login error banner returns UNKNOWN instead of undefined and enters Rewards recovery', async () => {
    const { bot, messages } = fixture()
    bot.config = {}
    const navigations = []
    const locator = { first: () => locator, innerText: async () => '' }
    const page = {
        waitForLoadState: async () => {},
        url: () => 'https://rewards.bing.com/dashboard',
        context: () => ({ cookies: async () => [] }),
        locator: () => locator,
        goto: async target => navigations.push(target)
    }
    const login = new Login(bot)
    login.checkSelector = async (_page, selector) => selector === login.selectors.errorAlert
    const state = await login.detectCurrentState(page)
    assert.equal(state, 'UNKNOWN')
    for (let i = 0; i < 5; i++) await login.handleState(state, page, {})
    assert.ok(
        messages.some(m => m.title === 'LOGIN' && m.message.includes('Unknown state at rewards.bing.com/dashboard'))
    )
    assert.deepEqual(navigations, ['https://rewards.bing.com/earn'])
})

for (const points of [0, 115]) {
    test(`current Rewards mobile membership with ${points} points is recognized without legacy profile controls or auth-cookie names`, async () => {
        const { bot } = fixture()
        const ReactFunc = require(path.join(dist, 'browser/ReactFunc.js')).default
        bot.browser.react = new ReactFunc(bot)
        const payload = JSON.stringify({
            level: 1,
            pointsProgress: points,
            pointsRemaining: 500 - points,
            lifetimeEarn: points
        })
        const locator = { first: () => locator, innerText: async () => 'Microsoft Rewards' }
        const page = {
            waitForLoadState: async () => {},
            url: () => 'https://rewards.bing.com/dashboard',
            context: () => ({ cookies: async () => [] }),
            locator: () => locator,
            content: async () => `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`
        }
        const login = new Login(bot)
        login.checkSelector = async () => false
        assert.equal(await login.detectCurrentState(page), 'LOGGED_IN')
        page.url = () => 'https://rewards.bing.com/auth/login'
        assert.equal(await login.detectCurrentState(page), 'UNKNOWN')
        page.url = () => 'https://account.live.com/Abuse'
        assert.equal(await login.detectCurrentState(page), 'UNKNOWN')
    })
}
test('generic Rewards content, public offers and a default header balance cannot replace personalized membership evidence', async () => {
    const { bot } = fixture()
    const ReactFunc = require(path.join(dist, 'browser/ReactFunc.js')).default
    bot.browser.react = new ReactFunc(bot)
    const locator = { first: () => locator, innerText: async () => 'Microsoft Rewards' }
    const page = {
        waitForLoadState: async () => {},
        url: () => 'https://rewards.bing.com/dashboard',
        context: () => ({ cookies: async () => [] }),
        locator: () => locator,
        content: async () => '<script>self.__next_f.push([1,"{\\"availablePoints\\":0}"])</script>'
    }
    const login = new Login(bot)
    login.checkSelector = async () => false
    assert.equal(await login.detectCurrentState(page), 'UNKNOWN')
})

for (const [selector, expected] of [['send-code', 'email-code-required'], ['password', 'password-required']]) {
    test(`OAuth stops promptly for ${expected} without sending codes or exposing proof details`, async () => {
        const { bot, messages } = fixture()
        let closed = false, waited = false
        const invisible = { first: () => ({ isVisible: async () => false }) }
        const oauth = {
            goto: async () => {}, url: () => 'https://login.live.com/oauth20_authorize.srf',
            locator: value => value === 'input[type="password"]' && selector === 'password' ? { first: () => ({ isVisible: async () => true }) } : invisible,
            getByRole: () => ({ first: () => ({ isVisible: async () => selector === 'send-code' }) }),
            waitForURL: async () => { waited = true }, close: async () => { closed = true }
        }
        bot.newBrowserPage = async () => oauth
        const page = { context: () => ({}), request: { get: async () => ({ url: oauth.url, status: () => 200 }) } }
        assert.equal(await new MobileAccessLogin(bot, page).get('one@example.test'), '')
        assert.equal(closed, true)
        assert.equal(waited, false)
        assert.ok(messages.some(m => m.message === `App authorization needs user action | reason=${expected}`))
        assert.ok(!JSON.stringify(messages).includes('one@example.test'))
    })
}
test('OAuth code lookalikes on another host are never exchanged', async () => {
    const { bot } = fixture()
    let exchanged = false
    bot.http = { request: async () => { exchanged = true; return { data: {} } } }
    bot.newBrowserPage = async () => ({ goto: async () => {}, url: () => 'https://example.test/oauth20_desktop.srf?code=private', locator: () => ({ first: () => ({ isVisible: async () => false }) }), getByRole: () => ({ first: () => ({ isVisible: async () => false }) }), waitForURL: async () => {}, close: async () => {} })
    const page = { context: () => ({}), request: { get: async () => ({ url: () => 'https://example.test/oauth20_desktop.srf?code=private', status: () => 200 }) } }
    assert.equal(await new MobileAccessLogin(bot, page).get('one@example.test'), '')
    assert.equal(exchanged, false)
})
