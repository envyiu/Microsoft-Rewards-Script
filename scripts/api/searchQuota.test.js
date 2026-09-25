import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const ReactFunc = require('../../dist/browser/ReactFunc.js').default
const BrowserFunc = require('../../dist/browser/BrowserFunc.js').default
const { mapFlyoutToDashboard } = require('../../dist/browser/FlyoutDashboard.js')
const { classifyRewardsPage, finiteNonNegative } = require('../../dist/browser/RewardsState.js')
const { SearchProgress } = require('../../dist/functions/activities/search/SearchProgress.js')
const { Search } = require('../../dist/functions/activities/search/BrowserSearch.js')

const logger = { debug() {}, info() {}, warn() {}, error() {} }
const parser = new ReactFunc({ isMobile: true, logger })

function earnPage(pointsCounters) {
    const flight = `67:["$","$L1",null,{"model":{"pointsCounters":${JSON.stringify(pointsCounters)}}}]`
    return `<html><script>self.__next_f.push([1,${JSON.stringify(flight)}])</script></html>`
}

function flyout() {
    return {
        userInfo: { isRewardsUser: true, balance: 0, profile: { attributes: {} } },
        flyoutResult: {
            userStatus: { isRewardsUser: true, availablePoints: 0, counters: { ActivityAndQuiz: [], DailyPoint: [] } }
        }
    }
}

test('reads separate desktop and mobile quotas from Rewards earn-page flight data', () => {
    const html = earnPage({
        dailyOffer: 105,
        pc: { max: 90, progress: 0, originalMax: 90 },
        mobile: { max: 60, progress: 0, originalMax: 60 }
    })
    assert.deepEqual(parser.searchCountersFromEarnPage(html), {
        pc: { max: 90, progress: 0 },
        mobile: { max: 60, progress: 0 }
    })
})

test('missing mobile counter means mobile search is not offered, not a shared quota', () => {
    assert.deepEqual(parser.searchCountersFromEarnPage(earnPage({ pc: { max: 30, progress: 9 } })), {
        pc: { max: 30, progress: 9 },
        mobile: null
    })
})

test('rejects absent or malformed page counters instead of inventing 0/0', () => {
    assert.equal(parser.searchCountersFromEarnPage('<html>login redirect</html>'), null)
    assert.equal(parser.searchCountersFromEarnPage(earnPage({ pc: { max: 'oops', progress: 0 } })), null)
})

test('accepts a verified Rewards page without Daily Set or offers', () => {
    const snapshot = {
        offers: [],
        reportable: [],
        streaks: [],
        streakProtection: null,
        account: { level: 2, pointsProgress: null, pointsRemaining: null, lifetimeEarn: null, availablePoints: 0 }
    }
    assert.equal(
        classifyRewardsPage({
            url: 'https://rewards.bing.com/earn',
            html: '<script>self.__next_f.push([1,"verified"])</script>',
            snapshot,
            actionCount: 2,
            rewardsAccountConfirmed: true
        }),
        'rewards-ready'
    )
    assert.equal(finiteNonNegative(0), 0)
    assert.equal(finiteNonNegative(-1), null)
    assert.equal(finiteNonNegative(Number.NaN), null)
})

test('distinguishes loading, login, verification and locked Rewards routes', () => {
    const empty = {
        offers: [],
        reportable: [],
        streaks: [],
        streakProtection: null,
        account: { level: null, pointsProgress: null, pointsRemaining: null, lifetimeEarn: null, availablePoints: null }
    }
    const state = (url, html) =>
        classifyRewardsPage({ url, html, snapshot: empty, actionCount: 0, rewardsAccountConfirmed: false })
    assert.equal(state('https://rewards.bing.com/earn', '<script>self.__next_f.push([])</script>'), 'loading')
    assert.equal(state('https://login.live.com/login.srf', '<input id="usernameEntry">'), 'login-required')
    assert.equal(state('https://login.live.com/', '<div data-testid="codeEntry">'), 'verification-required')
    assert.equal(state('https://rewards.bing.com/', '<h1 id="serviceAbuseLandingTitle">Locked</h1>'), 'unrecoverable')
})

test('flyout rejects missing or invalid balances but preserves a confirmed zero', () => {
    assert.equal(mapFlyoutToDashboard(flyout()).dashboard.userStatus.availablePoints, 0)
    const missing = flyout()
    delete missing.userInfo.balance
    delete missing.flyoutResult.userStatus.availablePoints
    assert.throws(() => mapFlyoutToDashboard(missing), /available-points balance/)
    const invalid = flyout()
    invalid.userInfo.balance = -1
    invalid.flyoutResult.userStatus.availablePoints = 'oops'
    assert.throws(() => mapFlyoutToDashboard(invalid), /available-points balance/)
})

test('balance cache is isolated by account, platform and UTC day', () => {
    let email = 'one@example.test'
    let mobile = true
    const bot = {
        get currentAccountEmail() {
            return email
        },
        get isMobile() {
            return mobile
        },
        logger
    }
    const browserFunc = new BrowserFunc(bot)
    browserFunc.rememberBalance(10, 'fixture')
    assert.equal(browserFunc.cachedBalance().value, 10)

    email = 'two@example.test'
    assert.equal(browserFunc.cachedBalance(), null)
    email = 'one@example.test'
    mobile = false
    assert.equal(browserFunc.cachedBalance(), null)
    assert.equal([...browserFunc.pointCache.keys()].length, 1)
})

test('bootstrap retries a slow Rewards DOM and dismisses the welcome dialog without requiring Daily Set', async () => {
    let attempt = 0
    let welcomeClicks = 0
    const empty = {
        offers: [],
        reportable: [],
        streaks: [],
        streakProtection: null,
        account: { level: null, pointsProgress: null, pointsRemaining: null, lifetimeEarn: null, availablePoints: null }
    }
    const ready = {
        ...empty,
        account: { ...empty.account, level: 2, availablePoints: 0 }
    }
    const html = () =>
        attempt < 2
            ? '<html><script>self.__next_f.push([])</script></html>'
            : '<html><script>self.__next_f.push([1,{"isRewardsUser":true,"availablePoints":0}])</script></html>'
    const response = {
        ok: () => true,
        text: async () => html(),
        status: () => 200
    }
    const page = {
        goto: async () => {
            attempt = 1
        },
        reload: async () => {
            attempt += 1
        },
        url: () => 'https://rewards.bing.com/earn',
        content: async () => html(),
        request: { get: async () => response },
        waitForSelector: async () =>
            welcomeClicks === 0
                ? {
                      click: async () => {
                          welcomeClicks += 1
                      }
                  }
                : null,
        waitForLoadState: async () => {}
    }
    const bot = {
        isMobile: true,
        logger,
        nextActions: {},
        nextRouterStateTree: '',
        reactSnapshot: null,
        reactSnapshots: { mobile: null, desktop: null },
        browser: {
            react: {
                snapshotPage: () => (attempt < 2 ? empty : ready),
                extractActionIds: () => ({ byName: {}, all: [] }),
                buildId: () => 'fixture-build',
                routerStateTree: () => 'fixture-router'
            }
        },
        refreshCurrentRewardsContext: async () => false
    }

    await new BrowserFunc(bot).bootstrap(page)
    assert.equal(attempt, 2)
    assert.equal(welcomeClicks, 1)
    assert.equal(bot.reactSnapshot.account.availablePoints, 0)
})

test('dashboard enrichment and search progress use the real platform-specific quotas', async () => {
    const html = earnPage({ pc: { max: 90, progress: 30 }, mobile: { max: 60, progress: 15 } })
    const bot = {
        isMobile: true,
        logger,
        cookies: { mobile: [], desktop: [] },
        browser: { react: parser },
        http: { request: async () => ({ data: html, headers: {} }) }
    }
    const browserFunc = new BrowserFunc(bot)
    const dashboard = mapFlyoutToDashboard(flyout())
    await browserFunc.updateSearchCountersFromEarnPage(dashboard, undefined, {})

    const progress = new SearchProgress({ browser: { func: { getDashboardData: async () => dashboard } } })
    assert.equal((await progress.getMissing(false)).totalPoints, 60)
    assert.equal((await progress.getMissing(true)).totalPoints, 45)
})

test('search progress distinguishes confirmed zero quota from unavailable counters', async () => {
    const confirmed = mapFlyoutToDashboard(flyout())
    confirmed.dashboard.userStatus.counters.pcSearch = [
        { offerId: 'PCSearch', pointProgress: 90, pointProgressMax: 90 }
    ]
    confirmed.dashboard.userStatus.counters.mobileSearch = [
        { offerId: 'MobileSearch', pointProgress: 60, pointProgressMax: 60 }
    ]
    const confirmedProgress = new SearchProgress({
        browser: { func: { getDashboardData: async () => confirmed } }
    })
    assert.deepEqual(await confirmedProgress.getSnapshot(false), {
        missing: { mobilePoints: 0, desktopPoints: 0, edgePoints: 0, totalPoints: 0 },
        quotaAvailable: true
    })
    assert.deepEqual(await confirmedProgress.getSnapshot(true), {
        missing: { mobilePoints: 0, desktopPoints: 0, edgePoints: 0, totalPoints: 0 },
        quotaAvailable: true
    })

    const unavailable = mapFlyoutToDashboard(flyout())
    const unavailableProgress = new SearchProgress({
        browser: { func: { getDashboardData: async () => unavailable } }
    })
    assert.equal((await unavailableProgress.getSnapshot(false)).quotaAvailable, false)
    assert.equal((await unavailableProgress.getSnapshot(true)).quotaAvailable, false)
})

test('a failed quota refresh does not turn known remaining points into a completed smart search', async () => {
    const known = mapFlyoutToDashboard(flyout())
    known.dashboard.userStatus.counters.mobileSearch = [
        { offerId: 'MobileSearch', pointProgress: 15, pointProgressMax: 60 }
    ]
    const unavailable = mapFlyoutToDashboard(flyout())
    let reads = 0
    const entries = []
    const bot = {
        userData: { currentPoints: 100 },
        config: { searchSettings: { runOnZeroPoints: true } },
        logger: {
            debug() {},
            warn() {},
            error() {},
            info(...args) {
                entries.push(args)
            }
        },
        browser: {
            func: {
                getDashboardData: async () => (++reads === 1 ? known : unavailable)
            }
        }
    }
    const search = new Search(bot)
    search.runSearchSession = async (_page, _isMobile, tracker) => {
        assert.equal(await tracker.prepare(), true)
        assert.equal(await tracker.measure(), 0)
        assert.equal(tracker.remaining, 45)
        assert.equal(tracker.done(), false)
        return { totalGained: 0, performed: 1, stagnant: 1 }
    }
    await search.doSearch({ goto: async () => {} }, true, 5)
    const smartEnd = entries.find(([, title]) => title === 'SMART-SEARCH-END')
    assert.match(smartEnd[2], /points=0 \| remaining=45 \| quotaAvailable=true$/)
})
