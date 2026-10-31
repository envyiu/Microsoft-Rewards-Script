import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const require = createRequire(import.meta.url)
const dist = process.env.MRS_URGENT_TEST_DIST || fileURLToPath(new URL('../../dist/', import.meta.url))
const load = entry => require(path.join(dist, entry))
const { loadExecutionPlan } = load('interface/ExecutionPlan.js')
const { waitForActivity, waitForSearch } = load('util/ActivityTiming.js')
const { default: Activities } = load('functions/Activities.js')
const { Search } = load('functions/activities/search/BrowserSearch.js')
const { MicrosoftRewardsBot } = load('index.js')

test('quota plans disable every activity, search and background worker', () => {
    const plan = loadExecutionPlan(JSON.stringify({ version: 1, jobId: 'check-14', type: 'quota' }))
    const bot = Object.create(MicrosoftRewardsBot.prototype)
    bot.config = {
        workers: Object.fromEntries(
            [
                'doDailySet',
                'doMorePromotions',
                'doClaimBonusPoints',
                'doPunchCards',
                'doAppPromotions',
                'doDailyCheckIn',
                'doReadToEarn',
                'doActivateSearchPerk',
                'doVisualSearch',
                'doBonusSearches',
                'doMobileSearch',
                'doDesktopSearch'
            ].map(w => [w, true])
        ),
        ensureStreakProtection: true,
        experimental: { edgeBrowsing: true },
        searchSettings: { parallelSearching: true }
    }
    bot.applyExecutionPlan(plan)
    assert.ok(Object.values(bot.config.workers).every(v => v === false))
    assert.equal(bot.config.ensureStreakProtection, false)
    assert.equal(bot.config.experimental.edgeBrowsing, false)
    assert.equal(bot.config.searchSettings.parallelSearching, false)
})

test('old plans remain bounded while urgent batches accept compatible workers and reject malformed flags', () => {
    const plan = { version: 1, jobId: 'test', type: 'workers', workers: ['dailySet', 'morePromotions', 'punchCards'] }
    assert.throws(() => loadExecutionPlan(JSON.stringify(plan)), /one or two/)
    assert.equal(loadExecutionPlan(JSON.stringify({ ...plan, urgent: true })).workers.length, 3)
    assert.throws(() => loadExecutionPlan(JSON.stringify({ ...plan, urgent: 'true' })), /boolean/)
    assert.equal(
        loadExecutionPlan(
            JSON.stringify({ version: 1, jobId: 'old', type: 'search', platform: 'mobile', searchBudget: 8 })
        ).searchBudget,
        8
    )
})

test('activity pacing is removed only for urgent execution plans', async () => {
    const waits = []
    const bot = { executionPlan: { urgent: true }, utils: { wait: async time => waits.push(time) } }
    await waitForActivity(bot, 15000)
    assert.deepEqual(waits, [])
    bot.executionPlan.urgent = false
    await waitForActivity(bot, '5sec')
    assert.deepEqual(waits, ['5sec'])
})

test('urgent batches report completed workers independently and wait for both punchcard stages', async () => {
    const completed = []
    const bot = {
        executionPlan: { urgent: true, type: 'workers' },
        logger: { workerFailureCount: 0, warn() {} },
        markCompletedSmartWorkers: (_available, _data, _baseline, worker) => completed.push(worker)
    }
    const activities = new Activities(bot)
    await activities.trackWorker('dailySet', async () => 1)
    await activities.trackWorker('morePromotions', async () => {
        bot.logger.workerFailureCount++
    })
    await activities.trackWorker('punchCards', async () => {}, undefined, false)
    assert.deepEqual(completed, ['dailySet'])
    await activities.trackWorker('punchCards', async () => {})
    assert.deepEqual(completed, ['dailySet', 'punchCards'])
    await assert.rejects(
        activities.trackWorker('readToEarn', async () => {
            throw new Error('fixture failure')
        })
    )
    assert.ok(!completed.includes('readToEarn'))
})

test('urgent browser search uses direct fill and still waits for real results readiness', async () => {
    const calls = []
    let releaseNavigation
    let releaseResults
    const navigation = new Promise(resolve => {
        releaseNavigation = resolve
    })
    const results = new Promise(resolve => {
        releaseResults = resolve
    })
    const bot = {
        executionPlan: { urgent: true },
        config: {
            searchSettings: {
                scrollRandomResults: false,
                clickRandomResults: false,
                searchDelay: { min: 1000, max: 2000 }
            }
        },
        utils: { wait: async time => calls.push(['wait', time]), randomDelay: () => 5 },
        browser: { utils: { ghostClick: async () => {}, tryDismissAllMessages: async () => {} } },
        logger: { warn: () => {} }
    }
    const page = {
        evaluate: async () => {},
        keyboard: {
            press: async () => {},
            type: async () => {
                calls.push(['type'])
            }
        },
        locator: selector => ({
            fill: async query => calls.push(['fill', query]),
            waitFor: async () => {
                if (selector === '#b_results') await results
            }
        }),
        waitForURL: predicate => {
            assert.equal(predicate(new URL('http://fixture.test/search?q=ready')), true)
            return navigation
        }
    }
    let finished = false
    const searching = new Search(bot).bingSearch(page, 'ready', false).then(() => {
        finished = true
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(finished, false)
    releaseNavigation()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(finished, false)
    releaseResults()
    await searching
    assert.ok(calls.some(call => call[0] === 'fill' && call[1] === 'ready'))
    assert.ok(!calls.some(call => call[0] === 'type'))
    assert.equal(calls.filter(call => call[0] === 'wait').length, 1)
})

test('urgent search keeps a 5-8 second credit gap while ordinary searches retain their configured delay', async () => {
    const waits = []
    const ranges = []
    const bot = {
        executionPlan: { urgent: true },
        utils: {
            wait: async time => waits.push(time),
            randomDelay: (min, max) => {
                ranges.push([min, max])
                return 6500
            }
        }
    }
    await waitForSearch(bot, 45000)
    assert.deepEqual(ranges, [[5000, 8000]])
    assert.deepEqual(waits, [6500])
    bot.executionPlan.urgent = false
    await waitForSearch(bot, 45000)
    assert.deepEqual(waits, [6500, 45000])
})
