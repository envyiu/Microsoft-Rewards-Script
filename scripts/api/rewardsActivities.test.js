import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const load = file => require(path.join(process.env.MRS_TEST_DIST || path.resolve('dist'), file))
const { default: ReactFunc } = load('browser/ReactFunc.js')
const { PunchCards } = load('functions/activities/rewards/PunchCards.js')
const { MorePromotions } = load('functions/activities/rewards/MorePromotions.js')
const events = []
const logger = Object.fromEntries(
    ['info', 'warn', 'error', 'debug'].map(level => [
        level,
        (_p, title, message) => events.push({ level, title, message })
    ])
)
const flight = text => `<script>self.__next_f.push([1,${JSON.stringify(text)}])</script>`

test('Flight record IDs stay scoped to each page, including lazy and property references', () => {
    const parser = new ReactFunc({ logger })
    const earn = flight(
        'a:"earn-hash"\nb:{"props":{"value":5}}\n1:{"offerId":"earn","hash":"$a","points":"$b:props:value"}'
    )
    const dashboard = flight('a:"dashboard-hash"\n1:{"offerId":"dashboard","hash":"$a","points":10}')
    const snapshot = parser.snapshotPage([earn, dashboard])
    assert.equal(snapshot.offers.find(o => o.offerId === 'earn').hash, 'earn-hash')
    assert.equal(snapshot.offers.find(o => o.offerId === 'earn').points, 5)
    assert.equal(snapshot.offers.find(o => o.offerId === 'dashboard').hash, 'dashboard-hash')
})

test('daily streak is independent of protection; zero is known and malformed/absent is unknown', () => {
    const parser = new ReactFunc({ logger, currentAccountEmail: 'fixture@example.test' })
    for (const n of [0, 2, 55]) {
        const snapshot = parser.snapshotPage(
            flight(`1:{"streakCounter":${n},"isProtectionEnabled":true}\n2:{"isProtectionOn":true,"remainingDays":13}`)
        )
        assert.equal(snapshot.dailyStreak, n)
        assert.equal(snapshot.streakProtection.streakCounter, n)
    }
    assert.equal(parser.snapshotPage(flight('1:{"streakCounter":2}')).dailyStreak, 2)
    for (const n of ['"2"', '-1', '1.5', 'null'])
        assert.equal(parser.snapshotPage(flight(`1:{"streakCounter":${n}}`)).dailyStreak, null)
    assert.equal(parser.snapshotPage('<html>login</html>').morePromotionsAvailable, false)
})

test('quest cards use their resolved subtree for title, points and progress, without duplicate quest_ IDs', () => {
    const parser = new ReactFunc({ logger })
    const element = (tag, props) => ['$', tag, null, props]
    const card = element('div', {
        children: [
            element('img', { alt: 'Halloween' }),
            element('p', { children: ['+', '50'] }),
            element('span', { children: '0/6 tasks' })
        ]
    })
    const html = flight(
        `1:${JSON.stringify({ href: '/earn/quest/campaign-with-hyphen', children: '$L2' })}\n2:${JSON.stringify(card)}\n3:{"id":"quest_campaign-with-hyphen"}`
    )
    assert.deepEqual(parser.snapshotQuestList(html), [
        {
            offerId: 'campaign-with-hyphen',
            title: 'Halloween',
            pointProgressMax: 50,
            complete: false,
            completedTasks: 0,
            totalTasks: 6
        }
    ])
})

test('quest parsing keeps signed generic IDs and enclosing multi-day instructions', () => {
    const parser = new ReactFunc({ logger })
    const html = flight(
        '1:["$","div",null,{"className":"step","children":[["$","p",null,{"children":"Search for 5 out of 10 days. Searches must be at least 24 hours apart."}],["$","button",null,{"offerId":"campaign-search","hash":"fixture","ariaLabel":"Start searching","activityType":42,"isCompleted":false}]]}]'
    )
    const child = parser.snapshotQuestPage(html)[0]
    assert.equal(child.offerId, 'campaign-search')
    assert.equal(child.activityType, 42)
    assert.match(child.description, /24 hours apart/)
})

function questFixture({ acknowledge = true, deferred = false, disappear = false } = {}) {
    let stage = 0
    const requests = [],
        logs = []
    const parent = {
        offerId: 'quest-test',
        title: 'Halloween',
        pointProgressMax: 0,
        complete: false,
        completedTasks: 0
    }
    const child = (id, extra = {}) => ({
        offerId: id,
        hash: 'fixture-hash',
        points: 0,
        isCompleted: false,
        isLocked: false,
        isDisabled: false,
        reportable: true,
        ...extra
    })
    const activation = child('pcchild1_urlreward_activate', {
        title: 'Activate quest',
        activityType: 42,
        isPromotional: true
    })
    const followup = child('pcchild2_urlreward_followup')
    const bot = {
        logger: { ...logger, info: (_p, _t, m) => logs.push(m) },
        executionPlan: { urgent: true },
        config: { skipNonPointTasks: true, autoClaimPunchcardRewards: false },
        utils: { randomDelay: () => 0 },
        userData: { currentPoints: 100, gainedPoints: 0, timezoneOffset: '0' },
        nextActions: { reportActivity: 'fixture-action' },
        browser: {
            react: { questRouterStateTree: id => id },
            func: {
                reportServerAction: async (_a, payload) => {
                    requests.push(payload)
                    if (acknowledge) stage++
                    return { acknowledged: acknowledge, status: 200 }
                },
                getCurrentPoints: async () => 100
            }
        }
    }
    const worker = new PunchCards(bot)
    worker.getParentQuests = async () => [{ ...parent, complete: stage === 2, completedTasks: stage }]
    worker.getQuestChildren = async () =>
        deferred
            ? [child('pcchild2_urlreward_search', { description: 'Search for 5 out of 10 days, 24 hours apart' })]
            : stage === 0
              ? [activation, { ...followup, isLocked: true, reportable: false }]
              : stage === 1
                ? [...(disappear ? [] : [{ ...activation, isCompleted: true, reportable: false }]), followup]
                : [activation, followup].map(c => ({ ...c, isCompleted: true, reportable: false }))
    return { bot, worker, requests, logs }
}

for (const disappear of [true, false])
    test(`quest activation refreshes newly unlocked zero-point steps and verifies completion (completed CTA disappears=${disappear})`, async () => {
        const { bot, worker, requests } = questFixture({ disappear })
        await worker.runMobile({ dashboard: {} })
        assert.equal(requests.length, 2)
        assert.equal(requests[0][1], 42)
        assert.equal(requests[0][2].isPromotional, 'true')
        assert.equal(bot.punchCardsVerified, true)
    })

test('unacknowledged quest does not loop, report success, or earn a Smart completion marker', async () => {
    const { bot, worker, requests, logs } = questFixture({ acknowledge: false })
    await worker.runMobile({ dashboard: {} })
    assert.equal(requests.length, 1)
    assert.equal(bot.punchCardsVerified, false)
    assert.ok(!logs.some(m => m.includes('COMPLETE')))
    assert.ok(logs.some(m => m.includes('reported=0')))
})

test('multi-day searches are deferred without fabricating completion or sending reports', async () => {
    const { bot, worker, requests, logs } = questFixture({ deferred: true })
    await worker.runMobile({ dashboard: {} })
    assert.equal(requests.length, 0)
    assert.equal(bot.punchCardsVerified, true) // today's actionable steps checked, quest remains in progress
    assert.ok(logs.some(m => m.includes('waiting-day-or-search')))
    assert.ok(!logs.some(m => m.includes('COMPLETE')))
})

test('quest parser failure and empty unknown lists cannot complete the worker', async () => {
    const { bot, worker } = questFixture()
    worker.getParentQuests = async () => []
    await worker.runMobile({ dashboard: {} })
    assert.equal(bot.punchCardsVerified, false)
})

test('Keep earning executes newly unlocked cards and does not verify omitted or missing-hash cards', async () => {
    const card = (offerId, extra = {}) => ({
        offerId,
        title: offerId,
        points: 5,
        hash: 'fixture',
        reportable: true,
        isCompleted: false,
        ...extra
    })
    for (const missingHash of [false, true]) {
        const calls = []
        let reads = 0
        const bot = {
            logger,
            config: { skipNonPointTasks: true, activities: { urlReward: true } },
            executionPlan: { urgent: true },
            utils: { randomDelay: () => 0 },
            browser: {
                func: {
                    refreshEarnSnapshot: async () => ({
                        morePromotionsAvailable: true,
                        offers:
                            ++reads === 1
                                ? [card('first')]
                                : [
                                      card('first', { isCompleted: true, reportable: false }),
                                      card(
                                          'second',
                                          reads === 2
                                              ? { hash: missingHash ? null : 'fixture', reportable: !missingHash }
                                              : { isCompleted: true, reportable: false }
                                      )
                                  ]
                    })
                }
            },
            activities: { doUrlReward: async p => calls.push(p.offerId) }
        }
        await new MorePromotions(bot).run({ dashboard: {} })
        assert.deepEqual(calls, missingHash ? ['first'] : ['first', 'second'])
        assert.equal(bot.morePromotionsVerified, !missingHash)
    }
})

test('pending Keep earning uses an ordinary browser visit once and verifies server state afterwards', async () => {
    const card = {
        offerId: 'keep',
        title: 'Do you know the answer?',
        points: 5,
        hash: 'fixture',
        promotionType: 'urlreward',
        destination: 'https://www.bing.com/search?q=fixture',
        reportable: true,
        isCompleted: false
    }
    for (const enabled of [true, false]) {
        let complete = false,
            visits = 0,
            closes = 0
        const bot = {
            logger,
            config: { skipNonPointTasks: true, activities: { urlReward: enabled } },
            executionPlan: { urgent: true },
            utils: { randomDelay: () => 0 },
            mainDesktopPage: { isClosed: () => false, context: () => 'same-account-context' },
            newBrowserPage: async context => {
                assert.equal(context, 'same-account-context')
                return {
                    goto: async url => {
                        assert.equal(url, card.destination)
                        visits++
                        complete = true
                    },
                    close: async () => closes++
                }
            },
            browser: {
                func: {
                    ensureOffer: async () => card,
                    refreshEarnSnapshot: async () => ({
                        offers: [{ ...card, isCompleted: complete, reportable: !complete }]
                    })
                }
            },
            activities: { doUrlReward: async () => {} }
        }
        await new MorePromotions(bot).run({ dashboard: {} })
        assert.equal(visits, enabled ? 1 : 0)
        assert.equal(closes, visits)
        assert.equal(bot.morePromotionsVerified, enabled)
    }
})

test('seven-day onboarding searches are deferred even when the signed CTA is unlocked', async () => {
    const { bot, worker, requests } = questFixture()
    worker.getQuestChildren = async () => [
        {
            offerId: 'pcchild8_onboarding',
            hash: 'fixture',
            title: 'Search now, Search for 7 days',
            description: 'Search at least once a day for seven days',
            isLocked: false,
            isCompleted: false,
            reportable: true
        }
    ]
    await worker.runMobile({ dashboard: {} })
    assert.equal(requests.length, 0)
    assert.equal(bot.punchCardsVerified, true)
})
