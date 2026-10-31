import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const dist = process.env.MRS_TEST_DIST || path.resolve('dist')
const { MicrosoftRewardsBot } = require(path.join(dist, 'index.js'))
const { default: Activities } = require(path.join(dist, 'functions/Activities.js'))

function fixture(urgent = false) {
    const events = []
    const bot = Object.create(MicrosoftRewardsBot.prototype)
    bot.executionPlan = { type: 'workers', urgent, workers: ['dailySet', 'morePromotions', 'punchCards'] }
    bot.logger = { workerFailureCount: 0 }
    for (const level of ['info', 'debug', 'warn', 'error']) {
        bot.logger[level] = (_platform, title, message) => {
            if (level === 'error') bot.logger.workerFailureCount++
            events.push({ level, title, message })
        }
    }
    const trip = {
        offerId: 'trip',
        title: 'Plan a trip',
        promotionType: 'urlreward',
        points: 5,
        hash: 'synthetic',
        reportable: true,
        isCompleted: false
    }
    bot.config = { skipNonPointTasks: true, activities: { urlReward: true } }
    bot.utils = { getFormattedDate: () => 'today' }
    bot.userData = { currentPoints: 435, gainedPoints: 0 }
    bot.nextActions = { reportActivity: 'synthetic-action' }
    let reports = 0,
        refreshes = 0
    bot.browser = {
        func: {
            refreshEarnSnapshot: async () => ({ offers: [trip], dailySet: [] }),
            ensureOffer: async () => trip,
            reportServerAction: async () => {
                reports++
                throw new Error('status code 503')
            }
        },
        react: { routerStateTree: () => 'synthetic-tree' }
    }
    bot.refreshCurrentRewardsContext = async () => {
        refreshes++
        return true
    }
    bot.activities = new Activities(bot)
    return {
        bot,
        events,
        data: { dashboard: { dailySetPromotions: { today: [] } } },
        counts: () => ({ reports, refreshes })
    }
}
for (const urgent of [false, true]) {
    test(`${urgent ? 'urgent' : 'regular'} Daily Set stays complete when the following promotion repeatedly returns 503`, async () => {
        const { bot, events, data, counts } = fixture(urgent)
        await bot.activities.doDailySet(data)
        await bot.activities.doMorePromotions(data)
        // The removed end-of-batch path must never override independent outcomes.
        bot.markCompletedSmartWorkers(true, data, 0)
        assert.deepEqual(
            events.filter(e => e.title === 'SMART-WORKER-END').map(e => e.message),
            ['worker=dailySet']
        )
        assert.deepEqual(
            events.filter(e => e.title === 'SMART-WORKER-PENDING').map(e => e.message),
            ['worker=morePromotions | reason=activity-error']
        )
        assert.equal(bot.morePromotionsVerified, false)
        assert.equal(bot.userData.currentPoints, 435)
        assert.equal(bot.userData.gainedPoints, 0)
        assert.deepEqual(counts(), { reports: 2, refreshes: 1 })
    })
}
test('a thrown worker cannot erase an earlier completion or poison the next worker', async () => {
    const { bot, events, data } = fixture()
    await bot.activities.doDailySet(data)
    await assert.rejects(
        bot.activities.trackWorker('morePromotions', async () => {
            throw new Error('503')
        })
    )
    bot.executionPlan.workers.push('activateSearchPerk')
    await bot.activities.trackWorker('activateSearchPerk', async () => {}, data)
    assert.deepEqual(
        events.filter(e => e.title === 'SMART-WORKER-END').map(e => e.message),
        ['worker=dailySet', 'worker=activateSearchPerk']
    )
})
test('punchcard stages preserve their own failures and tracking resets between accounts', async () => {
    const { bot, events, data } = fixture()
    await bot.activities.trackWorker(
        'punchCards',
        async () => {
            bot.logger.workerFailureCount++
        },
        data,
        false
    )
    await bot.activities.trackWorker('punchCards', async () => {}, data)
    assert.ok(!events.some(e => e.title === 'SMART-WORKER-END'))
    bot.activities.resetWorkerTracking()
    await bot.activities.trackWorker('punchCards', async () => {}, data, false)
    await bot.activities.trackWorker('punchCards', async () => {}, data)
    assert.deepEqual(
        events.filter(e => e.title === 'SMART-WORKER-END').map(e => e.message),
        ['worker=punchCards']
    )
})
