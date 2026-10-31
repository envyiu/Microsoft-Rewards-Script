import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import path from 'node:path'

const require = createRequire(import.meta.url)
const load = entry => require(path.join(process.env.MRS_TEST_DIST || path.resolve('dist'), entry))
const { MorePromotions } = load('functions/activities/rewards/MorePromotions.js')
const { default: ReactFunc } = load('browser/ReactFunc.js')
const logger = Object.fromEntries(['info', 'debug', 'warn', 'error'].map(key => [key, () => {}]))

test('RSC offers retain activity routing metadata across duplicate payload fragments', () => {
    const parser = new ReactFunc({ logger })
    const offers = parser.parseOffers(
        JSON.stringify([
            { offerId: 'card', hash: 'test-hash', points: 10 },
            { offerId: 'card', promotionType: 'urlreward', name: 'exploreonbing-test' }
        ])
    )
    assert.equal(offers.length, 1)
    assert.equal(offers[0].promotionType, 'urlreward')
    assert.equal(offers[0].name, 'exploreonbing-test')
    assert.equal(offers[0].reportable, true)
})

async function runCards(skipNonPointTasks, refresh = true) {
    const calls = []
    const card = (offerId, extra = {}) => ({
        offerId,
        title: offerId,
        promotionType: 'urlreward',
        pointProgressMax: 10,
        priority: -1,
        attributes: { promotional: 'True' },
        ...extra
    })
    const live = (offerId, extra = {}) => ({
        offerId,
        title: offerId,
        promotionType: 'urlreward',
        points: 10,
        reportable: true,
        isCompleted: false,
        isLocked: false,
        ...extra
    })
    const snapshot = {
        offers: [
            live('new'),
            live('search', { name: 'exploreonbing-test' }),
            live('daily'),
            live('rsc-daily'),
            live('child'),
            live('locked', { reportable: false, isLocked: true }),
            live('completed', { reportable: false, isCompleted: true }),
            live('unknown', { promotionType: 'search' })
        ],
        dailySet: [live('rsc-daily')]
    }
    const bot = {
        logger,
        config: { skipNonPointTasks, activities: { urlReward: true, searchOnBing: true } },
        executionPlan: { urgent: true },
        reactSnapshot: snapshot,
        utils: { randomDelay: () => 0, wait: async () => {} },
        browser: { func: { refreshEarnSnapshot: async () => (refresh ? snapshot : null) } },
        activities: {
            doUrlReward: async promotion => calls.push(promotion.offerId),
            doSearchOnBing: async promotion => calls.push(promotion.offerId)
        }
    }
    await new MorePromotions(bot).run({
        dashboard: {
            morePromotions: [card('legacy'), card('zero', { pointProgressMax: 0 })],
            morePromotionsWithoutPromotionalItems: [card('legacy')],
            dailySetPromotions: { today: [card('daily')] },
            punchCards: [{ parentPromotion: card('parent'), childPromotions: [card('child')] }]
        }
    })
    return calls
}

test('Keep earning merges RSC cards, preserves promotional cards, deduplicates and excludes other workers', async () => {
    assert.deepEqual(await runCards(true), ['legacy', 'new', 'search'])
})

test('zero-point preference and cached snapshot fallback are respected', async () => {
    assert.deepEqual(await runCards(false, false), ['legacy', 'zero', 'new', 'search'])
})

test('modern quiz, puzzle and missing-type cards survive flight parsing and activity dispatch', async () => {
    // Synthetic payloads exercising the four pending card labels from the screenshot.
    const titles = ['Do you know the answer?', 'Plan a trip', 'Complete this puzzle', 'Do you know the answer?']
    const payload = titles.map((title, index) => ({
        offerId: `keep-${index}`,
        title,
        points: 5,
        hash: `fixture-${index}`,
        activityType: 80 + index,
        ...(index === 0 ? { promotionType: 'quiz' } : index === 2 ? { promotionType: 'puzzle' } : {})
    }))
    payload.push(
        { offerId: 'pcchild-quest', points: 5, hash: 'fixture', activityType: 90 },
        { offerId: 'disabled', points: 5, hash: 'fixture', activityType: 90, isDisabled: true },
        { offerId: 'future', points: 5, hash: 'fixture', activityType: 90, date: '2099-01-01' }
    )
    const parser = new ReactFunc({ logger })
    const html = `<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify(payload))}])</script>`
    const snapshot = parser.snapshotPage(html)
    assert.equal(snapshot.offers.length, 7)
    assert.equal(snapshot.offers.find(offer => offer.offerId === 'disabled').reportable, false)
    assert.equal(snapshot.offers.find(offer => offer.offerId === 'future').reportable, false)
    const calls = []
    const bot = {
        logger,
        config: { skipNonPointTasks: true, activities: { urlReward: true } },
        executionPlan: { urgent: true },
        utils: { randomDelay: () => 0, wait: async () => {} },
        browser: { func: { refreshEarnSnapshot: async () => snapshot } },
        activities: { doUrlReward: async promotion => calls.push([promotion.offerId, promotion.activityType]) }
    }
    await new MorePromotions(bot).run({ dashboard: {} })
    assert.deepEqual(
        calls,
        titles.map((_, index) => [`keep-${index}`, String(80 + index)])
    )
})

test('unsupported cards without an explicit report activity never fall back to type 11', async () => {
    const { PromotionActivityRunner } = load('functions/activities/rewards/PromotionActivityRunner.js')
    let reports = 0
    const bot = {
        logger,
        config: { activities: { urlReward: true } },
        executionPlan: { urgent: true },
        utils: { randomDelay: () => 0, wait: async () => {} },
        activities: { doUrlReward: async () => reports++ }
    }
    await new PromotionActivityRunner(bot).run([
        { offerId: 'unknown', promotionType: 'unknown' },
        { offerId: 'quota', promotionType: 'search', activityType: '1' }
    ])
    assert.equal(reports, 0)
})

test('worker completion requires a fresh snapshot confirming every attempted card', async () => {
    for (const state of ['pending', 'completed', 'missing', 'unavailable']) {
        const offer = {
            offerId: 'verification-card',
            title: 'test',
            promotionType: 'urlreward',
            points: 5,
            reportable: true,
            isCompleted: false
        }
        let refreshes = 0
        const bot = {
            logger,
            config: { skipNonPointTasks: true, activities: { urlReward: true } },
            utils: { randomDelay: () => 0, wait: async () => {} },
            browser: {
                func: {
                    refreshEarnSnapshot: async () => {
                        if (++refreshes === 1) return { offers: [offer] }
                        if (state === 'unavailable') return null
                        if (state === 'missing') return { offers: [] }
                        return { offers: [{ ...offer, isCompleted: state === 'completed' }] }
                    }
                }
            },
            activities: { doUrlReward: async () => {} }
        }
        await new MorePromotions(bot).run({ dashboard: {} })
        assert.equal(bot.morePromotionsVerified, state === 'completed', state)
        assert.equal(refreshes, 2)
    }
})

test('signed cards missing type and quiz/puzzle cards reach the real claim payload builder', async () => {
    const { UrlReward } = load('functions/activities/api/UrlReward.js')
    const records = [
        'a:{"activityType":"42","promotional":"True"}',
        'b:"fixture-hash"',
        'c:5',
        '1:{"offerId":"no-type","hash":"$b","points":"$c","attributes":"$a"}',
        '2:{"offerId":"quiz","hash":"fixture-quiz","points":5,"promotionType":"quiz"}',
        '3:{"offerId":"puzzle","hash":"fixture-puzzle","points":5,"promotionType":"puzzle"}'
    ].join('\n')
    const parser = new ReactFunc({ logger })
    const html = `<script>self.__next_f.push([1,${JSON.stringify(records)}])</script>`
    const snapshot = parser.snapshotPage(html)
    const noType = snapshot.offers.find(offer => offer.offerId === 'no-type')
    assert.equal(noType.hash, 'fixture-hash')
    assert.equal(noType.points, 5)
    assert.equal(noType.activityType, 42)
    const requests = []
    let reads = 0
    const bot = {
        logger,
        config: { skipNonPointTasks: true, activities: { urlReward: true } },
        executionPlan: { urgent: true },
        utils: { randomDelay: () => 0, wait: async () => {} },
        userData: { currentPoints: 100, gainedPoints: 0 },
        nextActions: { reportActivity: 'fixture-action' },
        browser: {
            react: { routerStateTree: () => 'fixture-tree' },
            func: {
                refreshEarnSnapshot: async () =>
                    ++reads === 1
                        ? snapshot
                        : {
                              offers: snapshot.offers.map(offer => ({ ...offer, isCompleted: true }))
                          },
                ensureOffer: async id => snapshot.offers.find(offer => offer.offerId === id),
                reportServerAction: async (_action, payload, options) => {
                    assert.equal(options.url, 'https://rewards.bing.com/earn')
                    assert.equal(options.referer, 'https://rewards.bing.com/earn')
                    requests.push(payload)
                    return { acknowledged: true, status: 200, availablePoints: 100 + requests.length * 5 }
                }
            }
        }
    }
    bot.activities = { doUrlReward: promotion => new UrlReward(bot).doUrlReward(promotion) }
    await new MorePromotions(bot).run({ dashboard: {} })
    assert.deepEqual(
        requests.map(payload => [payload[0], payload[1], payload[2].offerid]),
        [
            ['fixture-hash', 42, 'no-type'],
            ['fixture-quiz', 11, 'quiz'],
            ['fixture-puzzle', 11, 'puzzle']
        ]
    )
    assert.equal(requests[0][2].isPromotional, 'true')
    assert.equal(bot.userData.gainedPoints, 0) // No per-offer progress evidence; aggregate balance is not attributable credit.
    assert.equal(bot.morePromotionsVerified, true)
})

test('non-claimable promotional banners absent from earn never block Keep earning', async () => {
    const cards = ['main-promo', 'extra-promo'].map(offerId => ({
        offerId,
        promotionType: 'urlreward',
        pointProgressMax: 5
    }))
    const calls = []
    const bot = {
        logger,
        config: { skipNonPointTasks: true, activities: { urlReward: true } },
        executionPlan: { urgent: true },
        utils: { randomDelay: () => 0, wait: async () => {} },
        browser: { func: { refreshEarnSnapshot: async () => ({ offers: [] }) } },
        activities: { doUrlReward: async promotion => calls.push(promotion.offerId) }
    }
    await new MorePromotions(bot).run({ dashboard: { promotionalItem: cards[0], promotionalItems: [cards[1]] } })
    assert.deepEqual(calls, [])
    assert.equal(bot.morePromotionsVerified, true)
})

test('production regression: weekly flyout banner is excluded while Plan a trip remains claimable', async () => {
    const trip = {
        offerId: 'WW_Rewards_Campaign_Global_EU_Expansion_BingOffer1',
        title: 'Plan a trip',
        points: 5,
        hash: 'fixture-trip',
        reportable: true,
        isCompleted: false
    }
    const banner = {
        offerId: 'Restructure_Weekly_Bonus_Flyout_HVA',
        title: 'Bing Star bonus',
        promotionType: 'urlreward',
        pointProgressMax: 50
    }
    const calls = []
    const bot = {
        logger,
        config: { skipNonPointTasks: true, activities: { urlReward: true } },
        executionPlan: { urgent: true },
        utils: { randomDelay: () => 0, wait: async () => {} },
        browser: { func: { refreshEarnSnapshot: async () => ({ offers: [trip] }) } },
        activities: { doUrlReward: async promotion => calls.push(promotion.offerId) }
    }
    await new MorePromotions(bot).run({ dashboard: { promotionalItem: banner } })
    assert.deepEqual(calls, [trip.offerId])
    // A real pending card must continue blocking completion after a failed/no-credit claim.
    assert.equal(bot.morePromotionsVerified, false)
})

test('503 claim fallback reuses account browser context and keeps its acknowledgment checks', async () => {
    const { default: BrowserFunc } = load('browser/BrowserFunc.js')
    for (const status of [200, 503]) {
        const calls = []
        const page = {
            isClosed: () => false,
            request: {
                post: async (url, options) => {
                    calls.push({ url, options })
                    return { ok: () => status === 200, status: () => status, text: async () => 'fixture-response' }
                }
            }
        }
        const bot = {
            logger,
            fingerprint: { headers: {} },
            cookies: { desktop: [] },
            mainDesktopPage: page,
            http: {
                request: async () => {
                    throw Object.assign(new Error('503'), { status: 503 })
                }
            },
            utils: { serverActionAcknowledged: value => value === 'fixture-response' },
            browser: { react: { availablePointsFromPayload: () => 105 } }
        }
        const func = new BrowserFunc(bot)
        let synced = false
        func.syncActiveCookies = async () => {
            synced = true
        }
        const action = () =>
            func.reportServerAction('fixture-action', ['fixture-hash'], {
                browserFallback: true,
                url: 'https://rewards.bing.com/earn'
            })
        if (status === 200) {
            assert.deepEqual(await action(), { status: 200, acknowledged: true, availablePoints: 105 })
            assert.equal(synced, true)
        } else await assert.rejects(action, /status code 503/)
        assert.equal(calls.length, 1)
        assert.equal(calls[0].options.headers['Next-Action'], 'fixture-action')
        assert.equal(calls[0].options.headers.Cookie, undefined)
    }
})

for (const promotional of [true, false]) {
    test(`UrlReward matches native server-action promotional encoding (${promotional}) without fallback or retries`, async () => {
        const { UrlReward } = load('functions/activities/api/UrlReward.js')
        const { default: BrowserFunc } = load('browser/BrowserFunc.js')
        const { default: Utils } = load('util/Utils.js')
        const errors = [],
            calls = []
        const offerId = 'WW_Rewards_Campaign_Global_EU_Expansion_BingOffer1'
        const offer = { offerId, hash: 'synthetic-trip-hash', points: 5, pointProgress: 0, reportable: true, isPromotional: promotional }
        const bot = {
            isMobile: true,
            logger: { ...logger, error: (_platform, _title, message) => errors.push(message) },
            config: { skipNonPointTasks: true },
            utils: new Utils(),
            fingerprint: { headers: {} },
            cookies: { mobile: [], desktop: [] },
            userData: { currentPoints: 440, gainedPoints: 0, timezoneOffset: '0', geoLocale: 'VN' },
            nextActions: { reportActivity: 'synthetic-action' },
            reactSnapshot: { offers: [offer] },
            nextRouterStateTree: 'synthetic-router',
            refreshCurrentRewardsContext: async () => {
                throw new Error('Must not retry a valid request')
            },
            http: {
                request: async request => {
                    const body = JSON.parse(request.data)
                    calls.push(body)
                    // The real endpoint returned 503 for a boolean in the controlled live comparison.
                    if (typeof body[2].isPromotional !== 'string')
                        throw Object.assign(new Error('status code 503'), { status: 503 })
                    return { status: 200, headers: {}, data: '0:{}\n1:true\n' }
                }
            },
            browser: { react: { availablePointsFromPayload: () => 445 } }
        }
        bot.browser.func = new BrowserFunc(bot)
        bot.browser.func.refreshEarnSnapshot = async () => ({ offers: [{ ...offer, pointProgress: 5, isCompleted: true }], account: { availablePoints: 445 } })
        await new UrlReward(bot).doUrlReward({ offerId })
        assert.equal(calls.length, 1)
        assert.deepEqual(calls[0], [
            'synthetic-trip-hash',
            11,
            {
                offerid: offerId,
                isPromotional: promotional ? 'true' : '$undefined',
                timezoneOffset: '0'
            }
        ])
        assert.equal(bot.userData.gainedPoints, 5)
        assert.equal(bot.userData.currentPoints, 445)
        assert.deepEqual(errors, [])
    })
}
