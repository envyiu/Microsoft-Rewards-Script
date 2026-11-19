import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const dist = process.env.MRS_TEST_DIST || path.resolve('dist')

const {
    isFviaInboxesEmail,
    matchesMaskedEmailHint,
    extractMicrosoftVerificationCode,
    fetchFviaInboxesMessages,
    pollFviaInboxesCode
} = require(path.join(dist, 'browser/auth/methods/FviaInboxesMail.js'))
const { Login } = require(path.join(dist, 'browser/auth/Login.js'))
const { NormalSession } = require(path.join(dist, 'util/NormalSession.js'))

function jsonResponse(data, status = 200) {
    const body = JSON.stringify(data)
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        text: async () => body,
        json: async () => data
    }
}

function createAuthFixture({ normalSession = null } = {}) {
    const messages = []
    const logger = Object.fromEntries(
        ['debug', 'info', 'warn', 'error'].map(level => [
            level,
            (_mobile, title, message) => messages.push({ level, title, message: String(message) })
        ])
    )
    const bot = {
        isMobile: false,
        shuttingDown: false,
        normalSession,
        config: { experimental: { blockMedia: false }, errorDiagnostics: false },
        logger,
        utils: { wait: async () => {} },
        browser: {
            utils: {
                tryDismissAllMessages: async () => {},
                reloadBadPage: async () => {},
                disableFido: async () => {},
                ghostClick: async (page, selector) => page._click(selector)
            }
        }
    }
    return { bot, messages }
}

function createFakeAuthPage(initialScreen, transitions) {
    let screen = structuredClone(initialScreen)
    const clicks = []
    const filled = []
    const typed = []
    let url = 'https://login.live.com/'
    let closed = false

    const resolveMatches = selector => {
        if (selector === '[data-testid="tile"]') return screen.tiles || []
        if (selector === '[data-testid="viewFooter"] [role="button"]') return screen.footerButtons || []
        if (selector === 'button[data-testid="primaryButton"]')
            return screen.primaryButton ? [screen.primaryButton] : []
        if (selector === '#back-button') return screen.backButton ? [screen.backButton] : []
        if (selector === 'div[role="alert"]') return screen.alert ? [{ text: screen.alert }] : []
        if (selector === '[data-testid="subtitle"], div#oneTimeCodeDescription, [data-testid="description"]') {
            return screen.subtitle ? [{ text: screen.subtitle }] : []
        }
        if (
            selector === 'input#proof-confirmation-email-input' ||
            selector === '[data-testid="proof-confirmation"]' ||
            selector === 'input#proof-confirmation-email-input input' ||
            selector === '[data-testid="proof-confirmation"] input'
        ) {
            return screen.recoverySelector === selector ||
                (selector === 'input#proof-confirmation-email-input' && screen.recoveryMode === 'emailVerification') ||
                (selector === '[data-testid="proof-confirmation"]' && screen.recoveryMode === 'recovery')
                ? [{ id: 'recovery' }]
                : []
        }
        if (
            selector ===
            '[data-testid="codeEntry"] input, [data-testid="codeInputWrapper"] input, input[id="otc-confirmation-input"], input[name="otc"]'
        ) {
            return screen.otpBoxes ? Array.from({ length: screen.otpBoxes }, (_, idx) => ({ idx })) : []
        }
        if (selector === '[data-testid="codeEntry"]' || selector === 'div[data-testid="codeEntry"]') {
            return screen.otpBoxes ? [{ text: 'otp' }] : []
        }
        if (selector === '[data-testid="passwordEntry"]') return screen.password ? [{ id: 'password' }] : []
        if (selector === 'input[type="password"]') return screen.password ? [{ id: 'password' }] : []
        if (selector === 'input#usernameEntry' || selector === 'input[type="email"]') {
            return screen.email ? [{ id: 'email' }] : []
        }
        if (selector === 'button[type="submit"]') return screen.submitButton ? [{ text: 'Next' }] : []
        if (selector === 'button[data-testid="primaryButton"], button[type="submit"]') {
            return screen.primaryButton ? [screen.primaryButton] : screen.submitButton ? [{ text: 'Next' }] : []
        }
        if (selector === '[data-testid="identityBanner"]') return screen.identityBanner ? [{ text: 'user' }] : []
        if (selector === 'img[data-testid="accessibleImg"][src*="picker_verify_email"]') {
            return screen.emailIconOld ? [{}] : []
        }
        if (selector === 'img[data-testid="accessibleImg"][src*="picker_remote_ngc"]') return []
        if (selector.includes('>> nth=')) {
            const [base, nthPart] = selector.split('>> nth=').map(part => part.trim())
            const idx = Number(nthPart)
            const list = resolveMatches(base)
            return list[idx] ? [list[idx]] : []
        }
        return []
    }

    const advance = event => {
        const next = transitions(event, screen)
        if (next) {
            if (next.url) url = next.url
            if (next.screen) screen = structuredClone(next.screen)
        }
    }

    const makeLocatorItem = (selector, index) => {
        const matches = resolveMatches(selector)
        const item = matches[index]
        return {
            isVisible: async () => Boolean(item),
            innerText: async () => item?.text || '',
            count: async () => (item ? 1 : 0),
            first: () => makeLocatorItem(selector, 0),
            evaluate: async fn => {
                if (!item) return { text: '', accessibleText: '', structuralAttributes: '' }
                return item.evalResult || fn({ textContent: item.text || '', attributes: [] })
            },
            click: async () => {
                if (!item) return false
                clicks.push(item.id || item.text || selector)
                advance({ type: 'click', selector, item })
                return true
            },
            fill: async val => {
                if (!item) return
                filled.push({ selector, index, val })
            },
            inputValue: async () => ''
        }
    }

    const page = {
        clicks,
        filled,
        typed,
        context: () => ({ cookies: async () => [] }),
        url: () => url,
        isClosed: () => closed,
        close: () => {
            closed = true
        },
        goto: async target => {
            url = target
        },
        reload: async () => {},
        waitForLoadState: async () => {},
        waitForSelector: async selector => {
            const matches = resolveMatches(selector)
            if (!matches.length) throw new Error(`Not visible: ${selector}`)
            return makeLocatorItem(selector, 0)
        },
        $: async selector => {
            const matches = resolveMatches(selector)
            return matches.length ? makeLocatorItem(selector, 0) : null
        },
        fill: async (selector, val) => {
            filled.push({ selector, val })
        },
        locator: selector => {
            const matches = resolveMatches(selector)
            return {
                count: async () => matches.length,
                first: () => makeLocatorItem(selector, 0),
                nth: idx => makeLocatorItem(selector, idx),
                innerText: async () => matches[0]?.text || '',
                isVisible: async () => matches.length > 0
            }
        },
        keyboard: {
            type: async val => {
                typed.push(val)
            },
            press: async key => {
                if (key === 'Enter') {
                    advance({ type: 'submit' })
                }
            }
        },
        _click: async selector => {
            const matches = resolveMatches(selector)
            if (!matches.length) return false
            const item = matches[0]
            clicks.push(item.id || item.text || selector)
            advance({ type: 'click', selector, item })
            return true
        }
    }

    return page
}

test('isFviaInboxesEmail allows only exact fviainboxes.com domain', () => {
    assert.equal(isFviaInboxesEmail('nguyenminh1a2b@fviainboxes.com'), true)
    assert.equal(isFviaInboxesEmail('  USER.Test+tag@FVIAINBOXES.COM  '), true)

    assert.equal(isFviaInboxesEmail(''), false)
    assert.equal(isFviaInboxesEmail(null), false)
    assert.equal(isFviaInboxesEmail(undefined), false)
    assert.equal(isFviaInboxesEmail('invalid-email'), false)
    assert.equal(isFviaInboxesEmail('@fviainboxes.com'), false)
    assert.equal(isFviaInboxesEmail('user@gmail.com'), false)
    assert.equal(isFviaInboxesEmail('user@outlook.com'), false)
    assert.equal(isFviaInboxesEmail('user@sub.fviainboxes.com'), false)
    assert.equal(isFviaInboxesEmail('user@fviainboxes.com.evil.com'), false)
})

test('matchesMaskedEmailHint accepts matching/missing hints and rejects conflicting destinations', () => {
    const recovery = 'nguyenminh1a2b@fviainboxes.com'
    assert.equal(matchesMaskedEmailHint(recovery, null), true)
    assert.equal(matchesMaskedEmailHint(recovery, ''), true)
    assert.equal(matchesMaskedEmailHint(recovery, 'Enter your recovery email address.'), true)
    assert.equal(matchesMaskedEmailHint(recovery, 'We will send a code to ng***@fviainboxes.com'), true)
    assert.equal(matchesMaskedEmailHint(recovery, 'Gửi mã đến ng***@fv***.com'), true)
    assert.equal(matchesMaskedEmailHint(recovery, 'We will send a code to ng***@gmail.com'), false)
    assert.equal(matchesMaskedEmailHint(recovery, 'We will send a code to xx***@fviainboxes.com'), false)
})

test('extractMicrosoftVerificationCode supports login single-use & recovery codes and enforces strict filters', () => {
    const address = 'letrung4a9k@fviainboxes.com'
    const sinceMs = Date.parse('2026-11-20T01:00:00Z')

    const singleUsePayload = {
        result: [
            {
                id: 'msg-1',
                from: 'Microsoft account team <account-security-noreply@accountprotection.microsoft.com>',
                to: address,
                received_at: '2026-11-20T01:00:05Z',
                subject: 'Your single-use code',
                text: 'Hi, Your single-use code is: 749201. Do not share it.'
            }
        ]
    }
    assert.deepEqual(extractMicrosoftVerificationCode(singleUsePayload, { address, sinceMs }), {
        code: '749201',
        messageId: 'msg-1'
    })

    const htmlVietnamesePayload = {
        result: [
            {
                id: 'msg-2',
                sender: 'security@microsoft.com',
                recipient: address,
                received_at: '2026-11-20T01:00:10Z',
                subject: 'Mã bảo mật tài khoản Microsoft',
                body: '<style>.box{color:#123456}</style><a href="https://microsoft.com/123456">link</a><p>Mã xác minh của bạn là <b>839201</b></p>'
            }
        ]
    }
    assert.deepEqual(extractMicrosoftVerificationCode(htmlVietnamesePayload, { address, sinceMs }), {
        code: '839201',
        messageId: 'msg-2'
    })

    // Rejects spoofed senders, mismatched recipients, old timestamps, missing timezone, known IDs, and unanchored multi-code emails
    for (const override of [
        { from: 'Microsoft <fake@evil.example>' },
        { from: 'Microsoft <fake@microsoft.com.evil.com>' },
        { to: 'other@fviainboxes.com' },
        { received_at: '2026-11-20T00:59:20Z' },
        { received_at: '2026-11-20' },
        { id: 'known-1' },
        { text: 'Use 123456 or 654321' },
        { subject: 'Newsletter', text: 'Your points summary 123456' }
    ]) {
        const res = extractMicrosoftVerificationCode(
            {
                result: [{ ...singleUsePayload.result[0], ...override }]
            },
            { address, sinceMs, knownMessageIds: new Set(['known-1']) }
        )
        assert.equal(res, null)
    }

    // Picks newest message when multiple valid messages exist
    const multiMsg = {
        result: [
            {
                id: 'old-new',
                from: 'security@accountprotection.microsoft.com',
                to: address,
                received_at: '2026-11-20T01:00:02Z',
                subject: 'Microsoft security code',
                text: 'Security code: 111222'
            },
            {
                id: 'newest',
                from: 'security@accountprotection.microsoft.com',
                to: address,
                received_at: '2026-11-20T01:00:25Z',
                subject: 'Microsoft security code',
                text: 'Security code: 333444'
            }
        ]
    }
    assert.deepEqual(extractMicrosoftVerificationCode(multiMsg, { address, sinceMs }), {
        code: '333444',
        messageId: 'newest'
    })
})

test('fetchFviaInboxesMessages pre-filters before downloading message detail bodies', async () => {
    const address = 'phamhoa1z2x@fviainboxes.com'
    const sinceMs = Date.parse('2026-11-20T01:00:00Z')
    const detailCalls = []

    const fetchImpl = async rawUrl => {
        const url = new URL(rawUrl)
        if (url.pathname === '/messages') {
            return jsonResponse({
                result: [
                    {
                        id: 'old-known',
                        from: 'security@accountprotection.microsoft.com',
                        received_at: '2026-11-20T01:00:01Z',
                        subject: 'Your single-use code'
                    },
                    {
                        id: 'non-ms',
                        from: 'spam@example.com',
                        received_at: '2026-11-20T01:00:02Z',
                        subject: 'Promo'
                    },
                    {
                        id: 'valid-target',
                        from: 'account-security-noreply@accountprotection.microsoft.com',
                        received_at: '2026-11-20T01:00:10Z',
                        subject: 'Your single-use code'
                    }
                ]
            })
        }
        if (url.pathname === '/message') {
            detailCalls.push(url.searchParams.get('id'))
            return jsonResponse('Your single-use code is: 556677.')
        }
        throw new Error(`Unexpected URL: ${rawUrl}`)
    }

    const payload = await fetchFviaInboxesMessages(address, {
        sinceMs,
        knownMessageIds: new Set(['old-known']),
        fetchImpl
    })
    assert.deepEqual(detailCalls, ['valid-target'])
    assert.deepEqual(extractMicrosoftVerificationCode(payload, { address, sinceMs }), {
        code: '556677',
        messageId: 'valid-target'
    })
})

test('pollFviaInboxesCode retries transient errors and aborts immediately when requested', async () => {
    const address = 'trananh9a8b@fviainboxes.com'
    const sinceMs = Date.parse('2026-11-20T01:00:00Z')

    let attempts = 0
    const retryResult = await pollFviaInboxesCode({
        address,
        sinceMs,
        timeoutMs: 5000,
        pollIntervalMs: 10,
        sleep: async () => {},
        fetchImpl: async () => {
            attempts++
            if (attempts === 1) return jsonResponse({}, 503)
            if (attempts === 2) throw new TypeError('fetch failed')
            return jsonResponse({
                result: [
                    {
                        id: 'm3',
                        from: 'security@accountprotection.microsoft.com',
                        received_at: '2026-11-20T01:00:05Z',
                        subject: 'Your single-use code',
                        text: 'Single-use code: 901234'
                    }
                ]
            })
        }
    })
    assert.equal(attempts, 3)
    assert.deepEqual(retryResult, { code: '901234', messageId: 'm3' })

    let abortFlag = false
    let abortFetches = 0
    const abortedResult = await pollFviaInboxesCode({
        address,
        sinceMs,
        timeoutMs: 5000,
        pollIntervalMs: 10,
        shouldAbort: () => abortFlag,
        sleep: async () => {
            abortFlag = true
        },
        fetchImpl: async () => {
            abortFetches++
            return jsonResponse({ result: [] })
        }
    })
    assert.equal(abortedResult, null)
    assert.equal(abortFetches, 1)

    let http404Fetches = 0
    const nonTransientResult = await pollFviaInboxesCode({
        address,
        sinceMs,
        timeoutMs: 5000,
        pollIntervalMs: 10,
        sleep: async () => {},
        fetchImpl: async () => {
            http404Fetches++
            return jsonResponse({}, 404)
        }
    })
    assert.equal(nonTransientResult, null)
    assert.equal(http404Fetches, 1)
})

test('SIGN_IN_METHOD_PICKER prioritizes email-code over password for fviainboxes and keeps password first otherwise', async () => {
    const recoverySecret = 'nguyenphuong4c2d@fviainboxes.com'
    const otpSecret = '482913'
    let codeRequested = false

    const { bot, messages } = createAuthFixture()
    const login = new Login(bot)
    login.fviaFetchImpl = async rawUrl => {
        const url = new URL(rawUrl)
        if (url.pathname === '/messages') {
            const stale = {
                id: 'old-stale',
                from: 'account-security-noreply@accountprotection.microsoft.com',
                received_at: new Date(Date.now() - 1000).toISOString(),
                subject: 'Your single-use code',
                text: 'Your single-use code is: 000111'
            }
            const fresh = {
                id: 'otp-1',
                from: 'account-security-noreply@accountprotection.microsoft.com',
                received_at: new Date(Date.now() + 1000).toISOString(),
                subject: 'Your single-use code',
                text: `Your single-use code is: ${otpSecret}`
            }
            return jsonResponse({ result: codeRequested ? [stale, fresh] : [stale] })
        }
        return jsonResponse({ result: [] })
    }
    login.fviaPollOptions = { timeoutMs: 2000, pollIntervalMs: 5, sleep: async () => {} }
    login.finalizeLogin = async () => {}

    const pickerScreen = {
        tiles: [
            {
                id: 'tile-password',
                text: 'Use your password',
                evalResult: {
                    text: 'Use your password',
                    accessibleText: '',
                    structuralAttributes: 'd=m11.78 10.22a.75'
                }
            },
            {
                id: 'tile-email',
                text: 'Email a code to ng***@fviainboxes.com',
                evalResult: {
                    text: 'Email a code to ng***@fviainboxes.com',
                    accessibleText: '',
                    structuralAttributes: 'd=m5.25 4h13.5a3.25'
                }
            }
        ]
    }

    const pageFvia = createFakeAuthPage(pickerScreen, event => {
        if (event.type === 'click' && event.item?.id === 'tile-email') {
            codeRequested = true
            return {
                screen: {
                    otpBoxes: 6,
                    subtitle: 'Enter the code we sent to ng***@fviainboxes.com',
                    primaryButton: { id: 'verify-btn', text: 'Next' }
                }
            }
        }
        if (event.type === 'click' && event.item?.id === 'verify-btn') {
            return {
                url: 'https://rewards.bing.com/earn',
                screen: {}
            }
        }
        return null
    })
    pageFvia.context = () => ({ cookies: async () => [] })
    // Override detectCurrentState once url becomes rewards.bing.com/earn
    const origDetect = login.detectCurrentState.bind(login)
    login.detectCurrentState = async page =>
        page.url().includes('rewards.bing.com/earn') ? 'LOGGED_IN' : origDetect(page)

    await login.login(pageFvia, {
        email: 'primary@outlook.com',
        password: 'super-secret-password',
        recoveryEmail: recoverySecret
    })

    assert.equal(pageFvia.clicks[0], 'tile-email')
    assert.ok(pageFvia.typed.includes(otpSecret))
    assert.equal(pageFvia.typed.includes('000111'), false)
    assert.equal(
        pageFvia.filled.some(f => f.val === 'super-secret-password'),
        false
    )
    const logsSerialized = JSON.stringify(messages)
    assert.equal(logsSerialized.includes(recoverySecret), false)
    assert.equal(logsSerialized.includes(otpSecret), false)

    // Non-fviainboxes account must still select PASSWORD first
    const { bot: gmailBot } = createAuthFixture()
    const gmailLogin = new Login(gmailBot)
    gmailLogin.finalizeLogin = async () => {}
    const pageGmail = createFakeAuthPage(pickerScreen, event => {
        if (event.type === 'click' && event.item?.id === 'tile-password') {
            return { url: 'https://rewards.bing.com/earn', screen: {} }
        }
        return null
    })
    const origGmailDetect = gmailLogin.detectCurrentState.bind(gmailLogin)
    gmailLogin.detectCurrentState = async page =>
        page.url().includes('rewards.bing.com/earn') ? 'LOGGED_IN' : origGmailDetect(page)

    await gmailLogin.login(pageGmail, {
        email: 'primary@outlook.com',
        password: 'super-secret-password',
        recoveryEmail: 'backup@gmail.com'
    })
    assert.equal(pageGmail.clicks[0], 'tile-password')
})

test('PASSWORD_INPUT switches to Other ways (skipping Forgot password) and completes via fviainboxes OTP', async () => {
    const recoverySecret = 'hoangnam3k7m@fviainboxes.com'
    const otpCode = '615273'
    let codeRequested = false
    const { bot } = createAuthFixture()
    const login = new Login(bot)
    login.fviaFetchImpl = async () =>
        jsonResponse({
            result: codeRequested
                ? [
                      {
                          id: 'otp-pw-switch',
                          from: 'security@accountprotection.microsoft.com',
                          received_at: new Date(Date.now() + 1000).toISOString(),
                          subject: 'Your single-use code',
                          text: `Single-use code: ${otpCode}`
                      }
                  ]
                : []
        })
    login.fviaPollOptions = { timeoutMs: 2000, pollIntervalMs: 5, sleep: async () => {} }
    login.finalizeLogin = async () => {}

    const page = createFakeAuthPage(
        {
            password: true,
            footerButtons: [
                { id: 'forgot-btn', text: 'Forgot password?' },
                { id: 'other-ways-btn', text: 'Other ways to sign in' }
            ]
        },
        event => {
            if (event.type === 'click' && event.item?.id === 'other-ways-btn') {
                return {
                    screen: {
                        tiles: [
                            {
                                id: 'tile-email',
                                text: 'Email a code',
                                evalResult: {
                                    text: 'Email a code',
                                    accessibleText: '',
                                    structuralAttributes: 'd=m5.25 4h13.5a3.25'
                                }
                            }
                        ]
                    }
                }
            }
            if (event.type === 'click' && event.item?.id === 'tile-email') {
                codeRequested = true
                return {
                    screen: {
                        otpBoxes: 1,
                        subtitle: 'Enter code sent to ho***@fviainboxes.com',
                        primaryButton: { id: 'submit-otp', text: 'Sign in' }
                    }
                }
            }
            if (event.type === 'click' && event.item?.id === 'submit-otp') {
                return { url: 'https://rewards.bing.com/earn', screen: {} }
            }
            return null
        }
    )

    const origDetect = login.detectCurrentState.bind(login)
    login.detectCurrentState = async p => (p.url().includes('rewards.bing.com/earn') ? 'LOGGED_IN' : origDetect(p))

    await login.login(page, {
        email: 'primary@outlook.com',
        password: 'pw-value',
        recoveryEmail: recoverySecret
    })

    assert.equal(page.clicks.includes('forgot-btn'), false)
    assert.deepEqual(
        page.clicks.filter(c => !c.includes('codeEntry')),
        ['other-ways-btn', 'tile-email', 'submit-otp']
    )
    assert.ok(page.clicks.some(c => c.includes('codeEntry')))
    assert.ok(page.typed.includes(otpCode))
})

test('identityBanner Send-code primary action is preferred over footer password option for fviainboxes', async () => {
    let codeRequested = false
    const { bot } = createAuthFixture()
    const login = new Login(bot)
    login.fviaFetchImpl = async () =>
        jsonResponse({
            result: codeRequested
                ? [
                      {
                          id: 'otp-banner',
                          from: 'security@accountprotection.microsoft.com',
                          received_at: new Date(Date.now() + 1000).toISOString(),
                          subject: 'Your single-use code',
                          text: 'Your single-use code is: 778899'
                      }
                  ]
                : []
        })
    login.fviaPollOptions = { timeoutMs: 2000, pollIntervalMs: 5, sleep: async () => {} }
    login.finalizeLogin = async () => {}

    const page = createFakeAuthPage(
        {
            identityBanner: true,
            primaryButton: { id: 'send-code-btn', text: 'Send code' },
            footerButtons: [{ id: 'use-pwd-btn', text: 'Use your password' }],
            subtitle: 'We will send a code to vu***@fviainboxes.com'
        },
        event => {
            if (event.type === 'click' && event.item?.id === 'send-code-btn') {
                codeRequested = true
                return {
                    screen: {
                        otpBoxes: 6,
                        subtitle: 'Enter code sent to vu***@fviainboxes.com',
                        primaryButton: { id: 'verify-btn', text: 'Next' }
                    }
                }
            }
            if (event.type === 'click' && event.item?.id === 'verify-btn') {
                return { url: 'https://rewards.bing.com/earn', screen: {} }
            }
            return null
        }
    )

    const origDetect = login.detectCurrentState.bind(login)
    login.detectCurrentState = async p => (p.url().includes('rewards.bing.com/earn') ? 'LOGGED_IN' : origDetect(p))

    await login.login(page, {
        email: 'primary@outlook.com',
        password: 'pw-value',
        recoveryEmail: 'vutrang2b4c@fviainboxes.com'
    })

    assert.deepEqual(
        page.clicks.filter(c => !c.includes('codeEntry')),
        ['send-code-btn', 'verify-btn']
    )
    assert.ok(page.clicks.some(c => c.includes('codeEntry')))
    assert.ok(page.typed.includes('778899'))
})

test('falls back cleanly to password on fviainboxes timeout and resolves post-password verification challenge', async () => {
    // 1) OTP timeout falls back to password without looping
    const { bot } = createAuthFixture()
    const loginTimeout = new Login(bot)
    loginTimeout.fviaFetchImpl = async () => jsonResponse({ result: [] })
    loginTimeout.fviaPollOptions = { timeoutMs: 15, pollIntervalMs: 5, sleep: async () => {} }
    loginTimeout.finalizeLogin = async () => {}

    const timeoutPage = createFakeAuthPage(
        {
            identityBanner: true,
            primaryButton: { id: 'send-code-btn', text: 'Send code' },
            footerButtons: [{ id: 'use-pwd-btn', text: 'Use your password' }]
        },
        event => {
            if (event.type === 'click' && event.item?.id === 'send-code-btn') {
                return {
                    screen: {
                        otpBoxes: 6,
                        footerButtons: [{ id: 'otp-use-pwd', text: 'Use your password' }]
                    }
                }
            }
            if (event.type === 'click' && event.item?.id === 'otp-use-pwd') {
                return {
                    screen: {
                        password: true,
                        footerButtons: [{ id: 'other-ways', text: 'Other ways to sign in' }],
                        submitButton: true
                    }
                }
            }
            if (event.type === 'click' && event.item?.text === 'Next') {
                return { url: 'https://rewards.bing.com/earn', screen: {} }
            }
            return null
        }
    )
    timeoutPage.browserClick = false
    // Simulate password submit advancing to rewards
    const origDetect1 = loginTimeout.detectCurrentState.bind(loginTimeout)
    let pwdEntered = false
    loginTimeout.emailLogin.enterPassword = async () => {
        pwdEntered = true
        timeoutPage.url = () => 'https://rewards.bing.com/earn'
        return 'ok'
    }
    loginTimeout.detectCurrentState = async p =>
        p.url().includes('rewards.bing.com/earn') ? 'LOGGED_IN' : origDetect1(p)

    await loginTimeout.login(timeoutPage, {
        email: 'primary@outlook.com',
        password: 'pw-value',
        recoveryEmail: 'buitam5f6g@fviainboxes.com'
    })
    assert.equal(pwdEntered, true)
    assert.equal(timeoutPage.clicks.includes('other-ways'), false)

    // 2) Post-password verification challenge still auto-fills recoveryEmail and fetches OTP
    const { bot: postBot, messages: postLogs } = createAuthFixture()
    const loginChallenge = new Login(postBot)
    const recEmail = 'danglong8h9j@fviainboxes.com'
    const challengeOtp = '345678'
    let currentStage = 'PASSWORD_INPUT'
    loginChallenge.fviaFetchImpl = async rawUrl => {
        const u = new URL(rawUrl)
        if (u.pathname === '/messages') {
            return jsonResponse({
                result:
                    currentStage === 'OTP_CODE_ENTRY'
                        ? [
                              {
                                  id: 'post-pwd-otp',
                                  from: 'security@accountprotection.microsoft.com',
                                  received_at: new Date(Date.now() + 1000).toISOString(),
                                  subject: 'Microsoft security code',
                                  text: `Your security code is ${challengeOtp}`
                              }
                          ]
                        : []
            })
        }
        return jsonResponse({ result: [] })
    }
    loginChallenge.fviaPollOptions = { timeoutMs: 2000, pollIntervalMs: 5, sleep: async () => {} }
    loginChallenge.finalizeLogin = async () => {}

    const challengeStagePage = {
        context: () => ({ cookies: async () => [] }),
        url: () => (currentStage === 'LOGGED_IN' ? 'https://rewards.bing.com/earn' : 'https://login.live.com/'),
        isClosed: () => false,
        goto: async () => {},
        reload: async () => {},
        waitForLoadState: async () => {},
        typed: [],
        waitForSelector: async sel => {
            if (currentStage === 'EMAIL_VERIFICATION_INPUT' && sel === 'input#proof-confirmation-email-input') {
                return { click: async () => {}, fill: async () => {} }
            }
            throw new Error('not visible')
        },
        $: async () => null,
        locator: sel => {
            if (sel === '[data-testid="subtitle"], div#oneTimeCodeDescription, [data-testid="description"]') {
                return {
                    first: () => ({
                        isVisible: async () => currentStage !== 'PASSWORD_INPUT',
                        innerText: async () => 'Verify da***@fviainboxes.com'
                    })
                }
            }
            if (
                sel ===
                '[data-testid="codeEntry"] input, [data-testid="codeInputWrapper"] input, input[id="otc-confirmation-input"], input[name="otc"]'
            ) {
                return {
                    count: async () => (currentStage === 'OTP_CODE_ENTRY' ? 6 : 0),
                    nth: () => ({
                        isVisible: async () => currentStage === 'OTP_CODE_ENTRY',
                        click: async () => {},
                        fill: async () => {},
                        inputValue: async () => challengeOtp[0]
                    })
                }
            }
            return { count: async () => 0, first: () => ({ isVisible: async () => false }) }
        },
        keyboard: {
            type: async val => {
                challengeStagePage.typed.push(val)
            },
            press: async key => {
                if (key === 'Enter' && currentStage === 'EMAIL_VERIFICATION_INPUT') currentStage = 'OTP_CODE_ENTRY'
                else if (key === 'Enter' && currentStage === 'OTP_CODE_ENTRY') currentStage = 'LOGGED_IN'
            }
        }
    }
    loginChallenge.emailLogin.enterPassword = async () => {
        currentStage = 'EMAIL_VERIFICATION_INPUT'
        return 'ok'
    }
    loginChallenge.detectCurrentState = async () => currentStage

    await loginChallenge.login(challengeStagePage, {
        email: 'primary@outlook.com',
        password: 'pw-value',
        recoveryEmail: recEmail
    })

    assert.deepEqual(challengeStagePage.typed, [recEmail, challengeOtp])
    const serialized = JSON.stringify(postLogs)
    assert.equal(serialized.includes(recEmail), false)
    assert.equal(serialized.includes(challengeOtp), false)
})

test('NormalSession permits fviainboxes recovery/OTP completion and enforces verification hold for others or terminal failures', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msrw-fvia-norm-'))
    const prevJournal = process.env.MRS_NORMAL_QUERY_JOURNAL
    t.after(() => {
        if (prevJournal === undefined) delete process.env.MRS_NORMAL_QUERY_JOURNAL
        else process.env.MRS_NORMAL_QUERY_JOURNAL = prevJournal
        fs.rmSync(dir, { recursive: true, force: true })
    })

    const makeNormalSession = name => {
        const journalPath = path.join(dir, `${name}.jsonl`)
        fs.writeFileSync(journalPath, '', { mode: 0o600 })
        process.env.MRS_NORMAL_QUERY_JOURNAL = journalPath
        return new NormalSession({
            version: 1,
            jobId: name,
            type: 'accountSession',
            platform: 'desktop',
            environment: 'desktop',
            searchBudget: 5,
            workers: ['dailySet']
        })
    }

    // 1) @fviainboxes.com account inside NormalSession succeeds through EMAIL_VERIFICATION_INPUT -> OTP_CODE_ENTRY -> LOGGED_IN
    const okSession = makeNormalSession('ok')
    const { bot: okBot } = createAuthFixture({ normalSession: okSession })
    const okLogin = new Login(okBot)
    let stage = 'EMAIL_VERIFICATION_INPUT'
    okLogin.fviaFetchImpl = async () =>
        jsonResponse({
            result:
                stage === 'OTP_CODE_ENTRY'
                    ? [
                          {
                              id: 'norm-otp',
                              from: 'security@accountprotection.microsoft.com',
                              received_at: new Date(Date.now() + 1000).toISOString(),
                              subject: 'Your single-use code',
                              text: 'Code: 192837'
                          }
                      ]
                    : []
        })
    okLogin.fviaPollOptions = { timeoutMs: 2000, pollIntervalMs: 5, sleep: async () => {} }
    okLogin.finalizeLogin = async () => {}

    const okPage = {
        context: () => ({ cookies: async () => [] }),
        url: () => (stage === 'LOGGED_IN' ? 'https://rewards.bing.com/earn' : 'https://login.live.com/'),
        isClosed: () => false,
        goto: async () => {},
        waitForLoadState: async () => {},
        waitForSelector: async sel => {
            if (stage === 'EMAIL_VERIFICATION_INPUT' && sel === 'input#proof-confirmation-email-input') {
                return { click: async () => {}, fill: async () => {} }
            }
            throw new Error('not visible')
        },
        $: async () => null,
        locator: sel => {
            if (
                sel ===
                '[data-testid="codeEntry"] input, [data-testid="codeInputWrapper"] input, input[id="otc-confirmation-input"], input[name="otc"]'
            ) {
                return {
                    count: async () => (stage === 'OTP_CODE_ENTRY' ? 1 : 0),
                    nth: () => ({
                        isVisible: async () => stage === 'OTP_CODE_ENTRY',
                        click: async () => {},
                        fill: async () => {},
                        inputValue: async () => '192837'
                    })
                }
            }
            return { count: async () => 0, first: () => ({ isVisible: async () => false }) }
        },
        keyboard: {
            type: async () => {},
            press: async key => {
                if (key === 'Enter' && stage === 'EMAIL_VERIFICATION_INPUT') stage = 'OTP_CODE_ENTRY'
                else if (key === 'Enter' && stage === 'OTP_CODE_ENTRY') stage = 'LOGGED_IN'
            }
        }
    }
    okLogin.detectCurrentState = async () => stage

    await okLogin.login(okPage, {
        email: 'primary@outlook.com',
        password: '',
        recoveryEmail: 'normok1a2b@fviainboxes.com'
    })
    assert.equal(okSession.failureReason(), null)

    // 2) @fviainboxes.com failure with no password fallback marks NormalSession 'verification'
    const failSession = makeNormalSession('fail')
    const { bot: failBot } = createAuthFixture({ normalSession: failSession })
    const failLogin = new Login(failBot)
    failLogin.fviaFetchImpl = async () => jsonResponse({ result: [] })
    failLogin.fviaPollOptions = { timeoutMs: 15, pollIntervalMs: 5, sleep: async () => {} }
    failLogin.detectCurrentState = async () => 'OTP_CODE_ENTRY'
    const failPage = {
        context: () => ({ cookies: async () => [] }),
        url: () => 'https://login.live.com/',
        isClosed: () => false,
        goto: async () => {},
        locator: () => ({ count: async () => 0, first: () => ({ isVisible: async () => false }) })
    }

    await assert.rejects(
        () =>
            failLogin.login(failPage, {
                email: 'primary@outlook.com',
                password: '',
                recoveryEmail: 'normfail1a2b@fviainboxes.com'
            }),
        { code: 'ACCOUNT_SESSION_STOPPED' }
    )
    assert.equal(failSession.failureReason(), 'verification')

    // 3) Non-fviainboxes account still stops immediately at detection time with 'verification'
    const legacySession = makeNormalSession('legacy')
    const { bot: legacyBot } = createAuthFixture({ normalSession: legacySession })
    const legacyLogin = new Login(legacyBot)
    legacyLogin.detectCurrentState = async () => 'EMAIL_VERIFICATION_INPUT'
    await assert.rejects(
        () =>
            legacyLogin.login(failPage, {
                email: 'primary@outlook.com',
                password: 'pw',
                recoveryEmail: 'other@gmail.com'
            }),
        { code: 'ACCOUNT_SESSION_STOPPED' }
    )
    assert.equal(legacySession.failureReason(), 'verification')
})
