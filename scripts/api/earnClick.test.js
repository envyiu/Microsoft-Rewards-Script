import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
const require = createRequire(import.meta.url)
const load = file => require(path.join(process.env.MRS_TEST_DIST || path.resolve('dist'), file))
const { chromium } = require('patchright')
const { clickEarnCards, earnClickDestination } = load('functions/activities/rewards/RenderedEarnActions.js')
const { readEarnPage } = load('browser/parsers/EarnPageParser.js')
const { default: BrowserFunc } = load('browser/BrowserFunc.js')
const { default: ReactFunc } = load('browser/ReactFunc.js')
const { MorePromotions } = load('functions/activities/rewards/MorePromotions.js')

for (const url of [
    'https://youtube.com/watch?v=fixture',
    'https://youtu.be/fixture',
    '/earn',
    'https://bing.com/search?q=puzzle'
])
    test(`Earn destination allows ${url}`, () =>
        assert.equal(earnClickDestination(url, 'https://rewards.bing.com/earn'), true))
for (const url of [
    'https://youtube.com.evil.test/watch',
    'javascript:alert(1)',
    'https://rewards.bing.com/redeem/item',
    'https://bing.com/file.apk',
    'https://user:pass@youtube.com/watch'
])
    test(`Earn destination rejects ${url}`, () =>
        assert.equal(earnClickDestination(url, 'https://rewards.bing.com/earn'), false))

async function fixture(run, { credit = true, urlReward = true, unsupported = false, unlock = false } = {}) {
    const browser = await chromium.launch({ headless: true })
    try {
        const context = await browser.newContext()
        const main = await context.newPage()
        const sentinel = await context.newPage()
        const clicked = [],
            events = []
        let balance = 100,
            delayedReads = 0
        const done = new Set()
        await context.route('https://www.youtube.com/**', route =>
            route.fulfill({ contentType: 'text/html', body: '<h1>Fixture video</h1>' })
        )
        await context.route('https://www.bing.com/**', route =>
            route.fulfill({ contentType: 'text/html', body: '<h1>Fixture puzzle</h1>' })
        )
        await context.route('https://rewards.bing.com/**', async route => {
            const url = new URL(route.request().url())
            if (url.pathname === '/credit') {
                const id = url.searchParams.get('id')
                clicked.push(id)
                if (credit) {
                    done.add(id)
                    balance += ['video', 'fungi'].includes(id) ? 15 : 5
                    delayedReads = 1
                }
                return route.fulfill({ body: 'ok' })
            }
            const delayed = delayedReads-- > 0
            const card = (id, title, points, destination, extra = '') =>
                `<a data-offerid="${id}" href="${destination}" target="_blank" ${extra} onclick="fetch('/credit?id=${id}')"><h3>${title}</h3><span class="locked_point">lock icon</span><div class="rounded-cornerCircular ${done.has(id) && !delayed ? 'bg-statusSuccessRewardsBg' : ''}"><p class="text-metadata">${points}</p></div></a>`
            const body = `<main><header><button aria-expanded="false"><p>${balance}</p></button></header><section id="moreactivities"><button aria-expanded="false" aria-controls="cards" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#cards').hidden=false">Keep earning</button><div id="cards" hidden>
                ${card('video', 'Put on your dancing shoes', 15, 'https://www.youtube.com/watch?v=fixture')}
                ${card('puzzle', 'Complete this puzzle', 5, 'https://www.bing.com/search?q=puzzle')}
                ${card('disabled', 'Really disabled', 15, 'https://www.youtube.com/watch?v=disabled', 'aria-disabled="true"')}
                ${unsupported ? card('redeem', 'Redeem points', 50, '/redeem/item') : ''}
                ${unlock && done.has('video') ? card('fungi', 'Glowing fungi', 15, 'https://www.youtube.com/watch?v=fungi') : ''}
                </div></section></main>`
            await route.fulfill({ contentType: 'text/html', body })
        })
        await main.goto('https://rewards.bing.com/earn')
        const bot = {
            logger: Object.fromEntries(
                ['info', 'debug', 'warn', 'error'].map(level => [
                    level,
                    (_p, title, message) => events.push({ title, message })
                ])
            ),
            config: { activities: { urlReward, searchOnBing: false }, skipNonPointTasks: true },
            utils: { wait: async () => {}, randomDelay: () => 0 },
            userData: { currentPoints: 100, gainedPoints: 0 },
            newBrowserPage: received => {
                assert.equal(received, context)
                return context.newPage()
            },
            browser: {}
        }
        bot.browser.react = new ReactFunc(bot)
        bot.browser.func = Object.assign(Object.create(BrowserFunc.prototype), { bot, getActivePage: () => main })
        await run({ bot, context, main, sentinel, clicked, events, balance: () => balance })
    } finally {
        await browser.close()
    }
}

test('lock icons remain clickable; actual disabled controls remain disabled', () =>
    fixture(async ({ main }) => {
        const { cards } = await readEarnPage(main)
        assert.equal(cards.find(c => c.offerIds.includes('video')).disabled, false)
        assert.equal(cards.find(c => c.offerIds.includes('video')).lockIcon, true)
        assert.equal(cards.find(c => c.offerIds.includes('disabled')).disabled, true)
    }))
test('clicks locked-icon YouTube and puzzle cards with no hash, verifies delayed credit and closes only owned tabs', () =>
    fixture(async ({ bot, context, main, sentinel, clicked, events, balance }) => {
        const state = await clickEarnCards(bot)
        assert.deepEqual(clicked, ['video', 'puzzle'])
        assert.equal(balance(), 120)
        assert.equal(bot.userData.gainedPoints, 0)
        assert.ok(
            events.some(
                e =>
                    e.title === 'EARN-CARD-CLICK' &&
                    e.message.includes('balanceDelta=15') &&
                    e.message.includes('completionVerified=true')
            )
        )
        assert.ok(events.some(e => e.message.includes('Complete this puzzle') && e.message.includes('balanceDelta=5')))
        assert.deepEqual(new Set(context.pages()), new Set([main, sentinel]))
        assert.equal(state.complete, true)
        await clickEarnCards(bot, state)
        assert.deepEqual(clicked, ['video', 'puzzle'])
    }))
test('uncredited clicks remain pending and are never clicked twice within one run', () =>
    fixture(
        async ({ bot, clicked, events }) => {
            const state = await clickEarnCards(bot)
            await clickEarnCards(bot, state)
            assert.deepEqual(clicked, ['video', 'puzzle'])
            assert.equal(state.complete, false)
            assert.ok(
                events.some(e => e.message.includes('completionVerified=false') && e.message.includes('balanceDelta=0'))
            )
        },
        { credit: false }
    ))
test('activity opt-out does not click visible cards', () =>
    fixture(
        async ({ bot, clicked }) => {
            const state = await clickEarnCards(bot)
            assert.equal(state.complete, true)
            assert.deepEqual(clicked, [])
        },
        { urlReward: false }
    ))
test('failed rendered reads cannot mark Keep earning complete from a stale API snapshot', async () => {
    const bot = {
        logger: Object.fromEntries(['info', 'debug', 'warn', 'error'].map(k => [k, () => {}])),
        config: { activities: { urlReward: true }, skipNonPointTasks: true },
        browser: {
            func: {
                refreshEarnSnapshot: async () => ({
                    offers: [],
                    renderedEarnAvailable: false,
                    morePromotionsAvailable: true
                })
            }
        }
    }
    await new MorePromotions(bot).run({ dashboard: {} })
    assert.equal(bot.morePromotionsVerified, false)
})

test('a second discovery wave clicks newly exposed cards without replaying completed ones', () =>
    fixture(
        async ({ bot, clicked }) => {
            const state = await clickEarnCards(bot)
            assert.deepEqual(clicked, ['video', 'puzzle', 'fungi'])
            assert.equal(state.complete, true)
        },
        { unlock: true }
    ))
test('an unsupported point link is retained as pending without following redemption', () =>
    fixture(
        async ({ bot, clicked }) => {
            const state = await clickEarnCards(bot)
            assert.deepEqual(clicked, ['video', 'puzzle'])
            assert.equal(state.complete, false)
        },
        { unsupported: true }
    ))

test('only explicit search execution plans enable piggyback Earn scans; warmup rejects the flag', () => {
    const { loadExecutionPlan } = load('interface/ExecutionPlan.js')
    const { MicrosoftRewardsBot } = load('index.js')
    const plan = loadExecutionPlan(
        JSON.stringify({
            version: 1,
            jobId: 'scan',
            type: 'search',
            platform: 'desktop',
            searchBudget: 5,
            recheckEarn: true
        })
    )
    const bot = Object.create(MicrosoftRewardsBot.prototype)
    bot.config = { workers: { doMorePromotions: true, doDesktopSearch: true }, experimental: {}, searchSettings: {} }
    bot.applyExecutionPlan(plan)
    assert.equal(bot.config.workers.doMorePromotions, true)
    assert.equal(bot.config.workers.doDesktopSearch, true)
    assert.throws(() => loadExecutionPlan(JSON.stringify({ ...plan, type: 'warmup', services: [] })), /recheck/)
    assert.throws(() => loadExecutionPlan(JSON.stringify({ ...plan, recheckEarn: 'true' })), /recheck/)
})
