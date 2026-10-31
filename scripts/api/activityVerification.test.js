import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
const require = createRequire(import.meta.url)
const load = entry => require(path.join(process.env.MRS_TEST_DIST || path.resolve('dist'), entry))
const { default: ReactFunc } = load('browser/ReactFunc.js')
const { DailySet } = load('functions/activities/rewards/DailySet.js')
const { ReadToEarn, parseReadToEarnState } = load('functions/activities/app/ReadToEarn.js')
const { MicrosoftRewardsBot } = load('index.js')
function logger(events = []) {
    return Object.fromEntries(
        ['debug', 'info', 'warn', 'error'].map(level => [
            level,
            (_platform, title, message) => events.push({ level, title, message })
        ])
    )
}
const offer = (id, complete = false) => ({
    offerId: id,
    title: id,
    hash: 'synthetic',
    points: 10,
    date: '10/25/2026',
    isCompleted: complete,
    isLocked: false
})
function flight(items, expiresAt = '$D2026-10-25T17:00:00.000Z') {
    return `<script>self.__next_f.push([1,${JSON.stringify('1:' + JSON.stringify({ dailySetItems: items, expiresAt }))}])</script>`
}
test('active Rewards Daily Set overrides UTC date gating and resolves Flight references', t => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-24T18:00:00Z') })
    const parser = new ReactFunc({ logger: logger() })
    const snapshot = parser.snapshotPage(flight([offer('daily-1'), offer('daily-2')]))
    assert.equal(snapshot.dailySet.length, 2)
    assert.ok(snapshot.dailySet.every(o => o.reportable))
    assert.ok(snapshot.offers.every(o => o.reportable))
    assert.equal(parser.snapshotPage(flight([{ ...offer('tomorrow'), date: '10/26/2026' }])).dailySet, null)
})
test('missing, expired or malformed Daily Set data stays unknown; an explicit empty set is known', t => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-25T03:00:00Z') })
    const parser = new ReactFunc({ logger: logger() })
    assert.equal(parser.snapshotPage('<html>loading</html>').dailySet, null)
    assert.equal(parser.snapshotPage(flight([offer('old')], '$D2026-10-24T17:00:00Z')).dailySet, null)
    assert.equal(parser.snapshotPage(flight([{ offerId: 'bad' }])).dailySet, null)
    assert.deepEqual(parser.snapshotPage(flight([])).dailySet, [])
})
for (const result of ['complete', 'pending', 'unavailable']) {
    test(`Daily Set uses live cards missing from the legacy dashboard and requires ${result} verification`, async () => {
        const events = [],
            attempts = []
        const cards = [
            { ...offer('a'), isPromotional: false },
            { ...offer('b'), isPromotional: false }
        ]
        let reads = 0
        const bot = {
            isMobile: true,
            logger: logger(events),
            config: { activities: { urlReward: true } },
            executionPlan: { urgent: true },
            utils: { getFormattedDate: () => '10/24/2026' },
            browser: {
                func: {
                    refreshEarnSnapshot: async () => {
                        reads++
                        if (reads === 1) return { offers: cards, dailySet: cards }
                        if (result === 'unavailable') return null
                        return {
                            offers: cards,
                            dailySet: cards.map(o => ({ ...o, isCompleted: result === 'complete' }))
                        }
                    }
                }
            },
            activities: { doUrlReward: async p => attempts.push(p.offerId) }
        }
        const data = { dashboard: { dailySetPromotions: {} } }
        await new DailySet(bot).run(data)
        assert.deepEqual(attempts, ['a', 'b'])
        assert.equal(bot.dailySetVerified, result === 'complete')
        assert.equal(data.dashboard.dailySetPromotions['10/24/2026'].length, 2)
    })
}
test('an absent Daily Set snapshot cannot be marked already complete', async () => {
    const bot = { logger: logger(), browser: { func: { refreshEarnSnapshot: async () => null } } }
    await new DailySet(bot).run({ dashboard: { dailySetPromotions: {} } })
    assert.equal(bot.dailySetVerified, false)
})
const app = (progress, max = 30, balance = 470) => ({
    response: {
        balance,
        promotions: [
            {
                attributes: {
                    offerid: 'ENUS_readarticle3_30points',
                    pointmax: String(max),
                    pointprogress: String(progress)
                }
            }
        ]
    }
})
function reader(states, postBalance = 473) {
    const events = []
    let gets = 0,
        posts = 0
    const bot = {
        accessToken: 'synthetic',
        isMobile: true,
        logger: logger(events),
        executionPlan: { urgent: true },
        config: { searchSettings: { readDelay: { min: 0, max: 0 } } },
        utils: { wait: async () => {}, randomDelay: () => 0 },
        userData: { currentPoints: 472, gainedPoints: 0, geoLocale: 'VN', langCode: 'en' },
        browser: {
            func: {
                getAppDashboardData: async channel => {
                    assert.equal(channel, 'SAAndroid')
                    return states[Math.min(gets++, states.length - 1)]
                }
            }
        },
        http: {
            request: async () => {
                posts++
                return { status: 200, data: { response: { balance: postBalance } } }
            }
        }
    }
    return { bot, events, counts: () => ({ gets, posts }) }
}
test('Read to Earn accepts counter-confirmed credit despite a lower app baseline than browser balance', async () => {
    const { bot, counts } = reader([app(0, 3, 470), app(3, 3, 473)])
    await new ReadToEarn(bot).doReadToEarn()
    assert.equal(bot.readToEarnVerified, true)
    assert.equal(bot.userData.gainedPoints, 3)
    assert.equal(bot.userData.currentPoints, 473)
    assert.equal(counts().posts, 1)
})
test('Read to Earn waits for delayed counter credit before posting another article', async () => {
    const { bot, counts } = reader([app(0, 3), app(0, 3), app(3, 3, 473)])
    await new ReadToEarn(bot).doReadToEarn()
    assert.equal(bot.readToEarnVerified, true)
    assert.equal(counts().posts, 1)
})
test('HTTP 200 without article progress stops after bounded attempts and never completes the worker', async () => {
    const { bot, counts, events } = reader([app(0)])
    await new ReadToEarn(bot).doReadToEarn()
    assert.equal(bot.readToEarnVerified, false)
    assert.equal(bot.userData.gainedPoints, 0)
    assert.equal(counts().posts, 3)
    assert.ok(!events.some(e => e.message.startsWith('Completed Read to Earn')))
})
test('confirmed full read quota is complete without posting; absent or malformed quota stays pending', async () => {
    for (const data of [app(30), { response: { promotions: [] } }, app('oops'), {}]) {
        const { bot, counts } = reader([data])
        await new ReadToEarn(bot).doReadToEarn()
        assert.equal(
            bot.readToEarnVerified,
            data === undefined
                ? false
                : parseReadToEarnState(data)?.offered === true && parseReadToEarnState(data).remaining === 0
        )
        assert.equal(counts().posts, 0)
    }
    assert.equal(parseReadToEarnState(app('')), null)
})
test('scheduler completion markers require explicit Daily Set and Read to Earn verification', () => {
    const events = [],
        bot = Object.create(MicrosoftRewardsBot.prototype)
    Object.assign(bot, {
        executionPlan: { type: 'workers', workers: ['dailySet', 'readToEarn'] },
        logger: { ...logger(events), workerFailureCount: 0 },
        utils: { getFormattedDate: () => 'today' },
        nextActions: { reportActivity: 'synthetic' }
    })
    for (const worker of ['dailySet', 'readToEarn'])
        bot.markCompletedSmartWorkers(true, { dashboard: { dailySetPromotions: {} } }, 0, worker)
    assert.ok(!events.some(e => e.title === 'SMART-WORKER-END'))
    bot.dailySetVerified = true
    bot.readToEarnVerified = true
    for (const worker of ['dailySet', 'readToEarn'])
        bot.markCompletedSmartWorkers(true, { dashboard: { dailySetPromotions: {} } }, 0, worker)
    assert.equal(events.filter(e => e.title === 'SMART-WORKER-END').length, 2)
})
