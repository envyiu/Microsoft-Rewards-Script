import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
const require = createRequire(import.meta.url)
const { NormalSession, setNormalSession } = require('../../dist/util/NormalSession.js')
const { learningQuery } = require('../../dist/util/Learning.js')
const { loadExecutionPlan } = require('../../dist/interface/ExecutionPlan.js')
const { MicrosoftRewardsBot } = require('../../dist/index.js')

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'normal-session-'))
    const file = path.join(directory, 'queries.jsonl'),
        previous = process.env.MRS_NORMAL_QUERY_JOURNAL
    process.env.MRS_NORMAL_QUERY_JOURNAL = file
    fs.writeFileSync(file, '', { mode: 0o600 })
    t.after(() => {
        if (previous === undefined) delete process.env.MRS_NORMAL_QUERY_JOURNAL
        else process.env.MRS_NORMAL_QUERY_JOURNAL = previous
        setNormalSession(new NormalSession(null))
        fs.rmSync(directory, { recursive: true, force: true })
    })
    const plan = {
        version: 1,
        jobId: 'session',
        type: 'accountSession',
        workers: [],
        searchBudget: 5,
        platform: 'desktop',
        environment: 'desktop'
    }
    const guard = new NormalSession(plan)
    setNormalSession(guard)
    const quota = (progress = 0, max = 90, readAt = new Date().toISOString()) =>
        guard.observe(
            'SMART-QUOTA',
            JSON.stringify({
                readAt,
                desktop: max == null ? null : { max, progress },
                mobile: { max: 60, progress: 0 }
            }),
            'info'
        )
    return { guard, quota, plan, file }
}

test('app OAuth errors and missing quota do not create an account-wide failure', t => {
    const { guard } = fixture(t)
    guard.observe('LOGIN-APP', 'Mobile token exchange failed | error=temporarily_unavailable', 'warn')
    guard.setFailureScope('app')
    guard.observe('LOGIN', 'authentication error 401', 'error')
    guard.setFailureScope('account')
    guard.observe('SMART-QUOTA', 'quota remains unavailable', 'warn')
    assert.equal(guard.failureReason(), null)
    assert.throws(() => guard.reserve('desktop'), { code: 'SESSION_QUOTA_UNAVAILABLE' })
})

test('normal and quest query kinds share five durable reservations, including restart', async t => {
    const { guard, quota, plan, file } = fixture(t)
    let progress = 0,
        sent = 0
    quota()
    guard.configure(
        async () => quota(++progress * 3),
        async () => {}
    )
    for (const kind of ['normal', 'activity', 'activity', 'bonus', 'activity']) {
        await learningQuery(kind, false, async () => {
            sent++
        })
    }
    await assert.rejects(
        () =>
            learningQuery('normal', false, async () => {
                sent++
            }),
        { code: 'SESSION_QUERY_LIMIT' }
    )
    assert.equal(sent, 5)
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 5)
    const reloaded = new NormalSession(plan)
    reloaded.observe(
        'SMART-QUOTA',
        JSON.stringify({ readAt: new Date().toISOString(), desktop: { max: 90, progress: 15 } }),
        'info'
    )
    assert.throws(() => reloaded.reserve('desktop'), { code: 'SESSION_QUERY_LIMIT' })
})

test('visual search has a separate durable four-attempt allowance when common search is full or unknown', async t => {
    const { guard, quota, plan, file } = fixture(t)
    plan.workers = ['visualSearch']
    quota(90)
    for (let n = 0; n < 2; n++) await learningQuery('visual', false, async () => {})
    quota(0, null)
    await learningQuery('visual', false, async () => {})
    assert.equal(guard.queries, 0)
    assert.equal(guard.normalSearchRemaining, 5)
    assert.equal(fs.readFileSync(file, 'utf8'), '')
    const reloaded = new NormalSession(plan)
    reloaded.reserve('desktop', 'visual')
    assert.throws(() => reloaded.reserve('desktop', 'visual'), { code: 'SESSION_VISUAL_LIMIT' })
    assert.throws(() => reloaded.reserve('desktop', 'normal'), { code: 'SESSION_QUOTA_UNAVAILABLE' })
    assert.equal(reloaded.queries, 0)
})

test('visual allowance cannot authorize ordinary search or bypass account protection', async t => {
    const { guard, plan, quota } = fixture(t)
    plan.workers = ['visualSearch']
    quota(90)
    guard.reserve('desktop', 'visual')
    guard.beginSend('visual')
    assert.throws(() => guard.authorizeHttpSearch('https://www.bing.com/search?q=ordinary'), {
        code: 'SESSION_UNRESERVED_QUERY'
    })
    guard.endSend()
    guard.beginSend('visual')
    assert.doesNotThrow(() => guard.authorizeHttpSearch('https://www.bing.com/images/search?bcid=fixture'))
    guard.observe('LOGIN', 'verification required', 'error')
    assert.throws(() => guard.reserve('desktop', 'visual'), { code: 'ACCOUNT_SESSION_STOPPED' })
})

test('visual search remains eligible after all five common query reservations are consumed', async t => {
    const { guard, plan, quota } = fixture(t)
    plan.workers = ['visualSearch']
    quota()
    for (let n = 0; n < 5; n++) guard.reserve('desktop', 'activity')
    assert.throws(() => guard.reserve('desktop', 'normal'), { code: 'SESSION_QUERY_LIMIT' })
    await learningQuery('visual', false, async () => {})
    assert.equal(guard.queries, 5)
    assert.equal(guard.activityQueries, 5)
})

test('uncertain send still consumes a query and cannot be refunded by telemetry failure', async t => {
    const { guard, quota, file } = fixture(t)
    quota()
    await assert.rejects(
        () =>
            learningQuery('activity', false, async () => {
                throw new Error('uncertain result')
            }),
        /uncertain/
    )
    assert.equal(guard.queries, 1)
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1)
})

test('missing, stale, wrong-platform, malformed and complete quota never permits a probe', async t => {
    const { guard, quota } = fixture(t)
    const send = () => learningQuery('activity', false, async () => assert.fail('query must not be sent'))
    await assert.rejects(send, { code: 'SESSION_QUOTA_UNAVAILABLE' })
    quota(0, 90, new Date(Date.now() - 11 * 60000).toISOString())
    await assert.rejects(send, { code: 'SESSION_QUOTA_UNAVAILABLE' })
    quota(-1)
    await assert.rejects(send, { code: 'SESSION_QUOTA_UNAVAILABLE' })
    quota(90)
    await assert.rejects(send, { code: 'SESSION_QUOTA_UNAVAILABLE' })
    quota(0)
    await assert.rejects(() => learningQuery('normal', true, async () => assert.fail()), {
        code: 'SESSION_QUOTA_UNAVAILABLE'
    })
    assert.equal(guard.queries, 0)
})

test('two stagnant queries reconcile once after 60 seconds and stop without a third query', async t => {
    const { guard, quota } = fixture(t)
    const waits = [],
        reads = []
    quota()
    guard.configure(
        async () => {
            reads.push(true)
            quota()
        },
        async ms => {
            waits.push(ms)
            await assert.rejects(() => learningQuery('activity', false, async () => assert.fail()), {
                code: 'SESSION_SEARCH_STOPPED'
            })
        }
    )
    await learningQuery('activity', false, async () => {})
    await learningQuery('normal', false, async () => {})
    assert.deepEqual(waits, [60000])
    assert.equal(reads.length, 3)
    assert.equal(guard.searchBlocked, true)
    assert.equal(guard.queries, 2)
    await assert.rejects(() => learningQuery('normal', false, async () => assert.fail()), {
        code: 'SESSION_SEARCH_STOPPED'
    })
})

test('delayed confirmed progress can resume, but quota loss stops the session search', async t => {
    const { guard, quota } = fixture(t)
    let reads = 0
    quota()
    guard.configure(
        async () => {
            reads++
            quota(reads >= 3 ? 3 : 0)
        },
        async () => {}
    )
    await learningQuery('activity', false, async () => {})
    await learningQuery('activity', false, async () => {})
    assert.equal(guard.searchBlocked, false)
    guard.configure(
        async () => {
            guard.observe('GET-DASHBOARD-DATA', 'Could not read search quota from Rewards earn page', 'warn')
        },
        async () => {}
    )
    await learningQuery('activity', false, async () => {})
    assert.equal(guard.searchBlocked, true)
    assert.equal(guard.queries, 3)
})

test('Flyout 9 is data uncertainty; explicit challenge/lock persists and unsupported tasks do not hold account', t => {
    const { guard, quota, file } = fixture(t)
    guard.observe('ACTIVITY', 'task not supported', 'error')
    assert.equal(guard.failureReason(), null)
    guard.observe('GET-DASHBOARD-DATA', 'Flyout error code=9', 'error')
    assert.equal(guard.failureReason(), 'data')
    guard.observe('LOGIN', 'verification required', 'warn')
    assert.equal(guard.failureReason(), 'verification')
    quota()
    assert.throws(() => guard.reserve('desktop'), { code: 'ACCOUNT_SESSION_STOPPED' })
    assert.equal(JSON.parse(fs.readFileSync(file + '.outcome', 'utf8')).failure, 'verification')
    guard.observe('LOGIN', 'account is locked', 'error')
    assert.equal(guard.failureReason(), 'locked')
})

test('accountSession contract rejects platform mixing and excessive tasks or queries', t => {
    const { plan } = fixture(t)
    for (const patch of [
        { searchBudget: 6 },
        { environment: 'mobile' },
        { workers: ['bonusSearches'] },
        { workers: ['dailySet', 'dailySet'] },
        { workers: ['dailySet', 'morePromotions', 'punchCards', 'streakProtection', 'visualSearch'] }
    ])
        assert.throws(() => loadExecutionPlan(JSON.stringify({ ...plan, ...patch })), /Invalid conservative/)
})

test('one accountSession reuses one login/browser and stops before the next task after auth failure', async t => {
    const { guard, plan } = fixture(t)
    plan.workers = ['dailySet', 'morePromotions', 'punchCards']
    const bot = Object.create(MicrosoftRewardsBot.prototype),
        calls = []
    const data = { dashboard: { userStatus: { availablePoints: 10 }, userProfile: { attributes: { country: 'US' } } } }
    const context = {
        route: async () => {},
        cookies: async () => [],
        close: async () => calls.push('close'),
        browser: () => ({ close: async () => {} })
    }
    Object.assign(bot, {
        executionPlan: plan,
        normalSession: guard,
        config: { workers: {} },
        accountLocale: { country: 'US' },
        userData: {},
        cookies: { mobile: [], desktop: [] },
        http: { setDefaultHeaders: () => {} },
        utils: { wait: async () => {} },
        browserFactory: {
            createBrowser: async () => {
                calls.push('browser')
                return { context, fingerprint: {} }
            }
        },
        newBrowserPage: async () => ({}),
        login: { login: async () => calls.push('login') },
        logger: { info: () => {}, warn: () => {} },
        browser: {
            func: {
                checkpointActiveSession: async () => {},
                getDashboardData: async () => data,
                getCurrentPoints: async () => null
            }
        },
        activities: {
            doDailySet: async () => calls.push('dailySet'),
            doMorePromotions: async () => {
                calls.push('morePromotions')
                guard.observe('LOGIN', 'login failed', 'error')
            },
            doPunchCardsDesktop: async () => calls.push('punchCards')
        }
    })
    await assert.rejects(
        () => bot.runAccountSession({ email: 'synthetic@example.test', geoLocale: 'US', langCode: 'en' }),
        { code: 'ACCOUNT_SESSION_STOPPED' }
    )
    assert.deepEqual(calls, ['browser', 'login', 'dailySet', 'morePromotions', 'close'])
})

test('browser and HTTP search guards reject unreserved requests without spending or resetting budget', async t => {
    const { guard, quota } = fixture(t)
    let handler,
        allowed = 0,
        aborted = 0,
        progress = 0
    await guard.protectBrowser({
        route: async (_pattern, callback) => {
            handler = callback
        }
    })
    const request = url =>
        handler({
            request: () => ({ url: () => url }),
            fallback: async () => {
                allowed++
            },
            abort: async () => {
                aborted++
            }
        })
    quota()
    guard.configure(
        async () => quota(++progress),
        async () => {}
    )
    await request('https://www.bing.com/search?q=unreserved')
    assert.equal(guard.queries, 0)
    await learningQuery('activity', false, () => request('https://www.bing.com/search?q=reserved'))
    await request('https://www.bing.com/search?q=unreserved-again')
    assert.throws(() => guard.authorizeHttpSearch('https://www.bing.com/search?q=raw'), {
        code: 'SESSION_UNRESERVED_QUERY'
    })
    await learningQuery('normal', false, async () =>
        guard.authorizeHttpSearch('https://www.bing.com/search?q=api-reserved')
    )
    assert.equal(guard.queries, 2)
    assert.equal(allowed, 1)
    assert.equal(aborted, 2)
})

test('real browser blocks an unreserved navigation and popup; reserved task navigation is counted once', async t => {
    const { guard, quota } = fixture(t)
    const { chromium } = require('patchright')
    const browser = await chromium.launch({ headless: true })
    t.after(() => browser.close())
    const context = await browser.newContext({ serviceWorkers: 'block' })
    let network = 0
    await context.route('**/*', async route => {
        if (route.request().url().includes('/search')) network++
        await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<html><body>synthetic search result</body></html>'
        })
    })
    await guard.protectBrowser(context)
    let page = await context.newPage()
    quota()
    guard.configure(
        async () => quota(3),
        async () => {}
    )
    await assert.rejects(() => page.goto('https://www.bing.com/search?q=raw'))
    assert.equal(network, 0)
    await page.close()
    page = await context.newPage()
    await learningQuery('activity', false, () => page.goto('https://www.bing.com/search?q=task'))
    assert.equal(network, 1)
    const opened = context.waitForEvent('page')
    await page.evaluate(() => globalThis.open('https://www.bing.com/search?q=popup'))
    const popup = await opened
    await popup.waitForLoadState('domcontentloaded').catch(() => {})
    assert.equal(network, 1)
    assert.equal(guard.queries, 1)
})

test('exhausted daily normal search allowance leaves quest query allowance unchanged and survives journal reload', async t => {
    const { guard, plan, quota } = fixture(t)
    plan.normalSearchBudget = 1
    quota()
    guard.reserve('desktop', 'normal')
    assert.equal(guard.normalSearchRemaining, 0)
    assert.throws(() => guard.reserve('desktop', 'normal'), { code: 'SESSION_QUERY_LIMIT' })
    guard.reserve('desktop', 'activity')
    guard.reserve('desktop', 'bonus')
    const reloaded = new NormalSession(plan)
    quota()
    assert.equal(reloaded.normalSearchRemaining, 0)
    reloaded.observe(
        'SMART-QUOTA',
        JSON.stringify({ readAt: new Date().toISOString(), desktop: { max: 90, progress: 0 } }),
        'info'
    )
    reloaded.reserve('desktop', 'activity')
    assert.equal(reloaded.queries, 4)
    assert.throws(
        () => loadExecutionPlan(JSON.stringify({ ...plan, normalSearchBudget: 6 })),
        /Invalid normal search budget/
    )
})

test('cross-midnight search sessions cannot spend yesterday allowance in the new day; quest queries still run', async t => {
    const { quota } = fixture(t)
    const oldDay = process.env.MRS_DAILY_SEARCH_DAY,
        oldZone = process.env.MRS_DAILY_SEARCH_TIMEZONE
    process.env.MRS_DAILY_SEARCH_DAY = '2000-01-01'
    process.env.MRS_DAILY_SEARCH_TIMEZONE = 'Asia/Ho_Chi_Minh'
    t.after(() => {
        if (oldDay == null) delete process.env.MRS_DAILY_SEARCH_DAY
        else process.env.MRS_DAILY_SEARCH_DAY = oldDay
        if (oldZone == null) delete process.env.MRS_DAILY_SEARCH_TIMEZONE
        else process.env.MRS_DAILY_SEARCH_TIMEZONE = oldZone
    })
    quota()
    let sends = 0
    for (const kind of ['normal', 'warmup'])
        await assert.rejects(
            () =>
                learningQuery(kind, false, async () => {
                    sends++
                }),
            { code: 'SESSION_QUERY_LIMIT' }
        )
    await learningQuery('activity', false, async () => {
        sends++
    })
    assert.equal(sends, 1)
})

test('recoverable bootstrap network warning does not stop a session; terminal network errors do', t => {
    const { guard, quota } = fixture(t)
    guard.observe(
        'BOOTSTRAP',
        'Failed to fetch /dashboard HTML | status=503 - snapshot and action discovery may be incomplete',
        'warn'
    )
    assert.equal(guard.failureReason(), null)
    quota()
    assert.doesNotThrow(() => guard.reserve('desktop'))
    guard.observe('FLOW', 'Request failed: ECONNRESET', 'error')
    assert.equal(guard.failureReason(), 'network')
    assert.throws(() => guard.assertActive(), { code: 'ACCOUNT_SESSION_STOPPED' })
})

test('mobile conservative searches keep Bing open across consecutive queries with random clicks enabled', async t => {
    const { guard, plan } = fixture(t)
    plan.platform = plan.environment = 'mobile'
    const quota = (progress = 0) =>
        guard.observe(
            'SMART-QUOTA',
            JSON.stringify({ readAt: new Date().toISOString(), mobile: { max: 60, progress } }),
            'info'
        )
    const { Search } = require('../../dist/functions/activities/search/BrowserSearch.js')
    let sent = 0
    quota()
    guard.configure(
        async () => quota(++sent * 3),
        async () => {}
    )
    const noop = async () => {}
    const bot = {
        normalSession: guard,
        config: {
            searchSettings: { clickRandomResults: true, scrollRandomResults: false, searchDelay: { min: 1, max: 1 } }
        },
        utils: { wait: noop, randomDelay: () => 1 },
        browser: { utils: { ghostClick: noop, cursor: () => ({ scrollTo: noop }) } }
    }
    const search = new Search(bot)
    search.browseResults = async () => {}
    const page = {
        evaluate: noop,
        keyboard: { press: noop, type: noop },
        locator: () => ({ waitFor: noop, fill: noop }),
        waitForURL: noop
    }
    for (let i = 0; i < 5; i++) await search.bingSearch(page, `fixture ${i}`, true)
    assert.equal(guard.queries, 5)
    assert.equal(sent, 5)
    assert.equal(guard.failureReason(), null)
})
