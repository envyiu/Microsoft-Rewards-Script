import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('patchright')
const { createCursor } = require('ghost-cursor-playwright-port')
const { AiSearch } = require('../../dist/functions/activities/search/AiSearch.js')
const { AiConversation } = require('../../dist/functions/activities/search/AiConversation.js')
const { NormalSession, setNormalSession } = require('../../dist/util/NormalSession.js')
const { installPreRewardsGuard } = require('../../common/preRewardsGuard.cjs')

let browser
test.before(async () => {
    browser = await chromium.launch({ headless: true })
})
test.after(async () => {
    await browser?.close()
})
const text = n =>
    `Đây là phần giải thích đầy đủ thứ ${n} về chủ đề đang thảo luận. Bạn có muốn biết thêm về cấu hình máy tính, giá bán tại Việt Nam hoặc so sánh các phiên bản không?`
function answerHtml(n, options = {}) {
    return `<div data-ai-answer data-streaming="${options.streaming ? 'true' : 'false'}">${text(n)}</div><aside data-ai-sources>unrelated source; Bạn muốn chạy lệnh không?</aside><div class="cplt_answer_footer"><button class="ca_like" aria-pressed="false" onclick="${options.unconfirmed ? '' : "this.setAttribute('aria-pressed','true')"}">Like</button><button class="ca_dislike" aria-pressed="false" onclick="this.setAttribute('aria-pressed','true')">Dislike</button></div>${options.streaming ? `<script>setTimeout(()=>document.querySelector('[data-ai-answer]').setAttribute('data-streaming','false'),80)</script>` : ''}`
}
function shell(options) {
    return `<html><body><data id="convId" value="fixture-conversation"></data><div id="b_copilot_search"><ol class="ca_container"><li class="ca_turn" turnid="1"><div class="ca_userquery">User input, not the answer</div><iframe style="width:95%;height:450px" src="https://www.bing.com/search?q=fixture&convid=fixture-conversation&convsig=synthetic&turnindex=1&cpltsrchif=1"></iframe></li></ol>${options.noComposer ? '' : '<textarea id="b_copilot_composer_2"></textarea><button class="b_copilot_send">Send</button>'}</div><script>
    ${options.rewardsProbe ? "fetch('https://rewards.bing.com/earn').catch(()=>{})" : ''}
    let turn=1;
    document.querySelector('.b_copilot_send')?.addEventListener('click',async()=>{
        const input=document.querySelector('textarea'); const q=input.value; input.value='';
        const u=new URL('https://www.bing.com/search');u.search=new URLSearchParams({q,convid:'fixture-conversation',convsig:'synthetic',turnindex:String(++turn),cpltsrchif:'1'});
        const html=await (await fetch(u)).text();const li=document.createElement('li');li.className='ca_turn';li.setAttribute('turnid',String(turn));li.innerHTML=html;document.querySelector('.ca_container').append(li);
    });</script></body></html>`
}
async function fixture(t, options = {}) {
    const context = await browser.newContext({
        isMobile: options.mobile || false,
        viewport: options.mobile ? { width: 400, height: 850 } : { width: 1200, height: 950 },
        serviceWorkers: 'block'
    })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msrw-ai-fixture-')),
        journal = path.join(dir, 'query.jsonl')
    fs.writeFileSync(journal, '')
    const old = process.env.MRS_NORMAL_QUERY_JOURNAL
    process.env.MRS_NORMAL_QUERY_JOURNAL = journal
    const plan = {
        version: 1,
        type: options.warmup ? 'warmup' : 'accountSession',
        platform: options.mobile ? 'mobile' : 'desktop',
        searchBudget: 5,
        normalSearchBudget: 5,
        workers: []
    }
    const guard = new NormalSession(plan)
    setNormalSession(guard)
    const quota = () =>
        guard.observe(
            'SMART-QUOTA',
            JSON.stringify({
                readAt: new Date().toISOString(),
                desktop: { max: 90, progress: 0 },
                mobile: { max: 60, progress: 0 }
            }),
            'info'
        )
    quota()
    guard.configure(
        async () => quota(),
        async () => {}
    )
    const requests = [],
        events = [],
        cursors = new WeakMap(),
        clicks = []
    // Last fallback is entirely synthetic: no Microsoft network traffic is allowed.
    await context.route('**/*', async route => {
        const u = new URL(route.request().url())
        requests.push({ path: u.pathname, turn: u.searchParams.get('turnindex') })
        if (u.pathname === '/copilotsearch')
            await route.fulfill({
                status: 200,
                contentType: 'text/html; charset=utf-8',
                body: options.unavailable ? '<html><div id="b_copilot_search">Unavailable</div></html>' : shell(options)
            })
        else if (u.pathname === '/search')
            await route.fulfill({
                status: 200,
                contentType: 'text/html; charset=utf-8',
                body: answerHtml(Number(u.searchParams.get('turnindex')), {
                    ...options,
                    streaming: options.streaming && u.searchParams.get('turnindex') === '1'
                })
            })
        else await route.fulfill({ status: 200, body: '' })
    })
    if (options.warmup) await installPreRewardsGuard(context)
    else await guard.protectBrowser(context)
    const source = await context.newPage()
    await source.goto('https://www.bing.com/')
    const bot = {
        shuttingDown: false,
        isMobile: !!options.mobile,
        executionPlan: plan,
        normalSession: guard,
        newBrowserPage: () => context.newPage(),
        config: { searchSettings: { searchDelay: { min: 20000, max: 40000 } } },
        logger: { info: (_mobile, _title, message) => events.push(message) },
        utils: { randomDelay: () => 0, wait: ms => new Promise(r => setTimeout(r, Math.min(Number(ms), 5))) },
        browser: {
            utils: {
                cursor: page => {
                    let cursor = cursors.get(page)
                    if (!cursor) {
                        if (options.realCursor)
                            cursor = createCursor(page, undefined, false, {
                                click: { hesitate: 0, waitForClick: 0, moveDelay: 0 }
                            })
                        else
                            cursor = {
                                click: async handle => {
                                    clicks.push(true)
                                    await handle.click({ timeout: 1000 })
                                },
                                scroll: async () => {},
                                scrollIntoView: async handle => handle.scrollIntoViewIfNeeded()
                            }
                        cursors.set(page, cursor)
                    }
                    return cursor
                }
            }
        }
    }
    const ai = new AiSearch(bot, {
        random: () => 0,
        initialWaitMs: options.unavailable ? 100 : 2000,
        followupWaitMs: 2000,
        totalMs: options.totalMs || 15000,
        pollMs: 5
    })
    t.after(async () => {
        await context.close()
        setNormalSession(new NormalSession(null))
        if (old === undefined) delete process.env.MRS_NORMAL_QUERY_JOURNAL
        else process.env.MRS_NORMAL_QUERY_JOURNAL = old
        fs.rmSync(dir, { recursive: true, force: true })
    })
    return { ai, bot, guard, context, source, requests, events, journal, clicks }
}

for (const mobile of [false, true])
    test(`AI browser ${mobile ? 'Mobile' : 'Desktop'}: streaming, Like and two bound followups consume exactly one query`, async t => {
        const f = await fixture(t, { mobile, streaming: true, realCursor: !mobile })
        assert.equal(
            await f.ai.run(f.source, 'fixture', mobile, 'normal', { ai: true, feedback: 'like', followups: 1 }),
            true
        )
        assert.equal(f.guard.queries, 1)
        assert.equal(f.guard.normalSearchUsed, 1)
        assert.equal(fs.readFileSync(f.journal, 'utf8').trim().split('\n').length, 1)
        assert.equal(f.requests.filter(r => r.path === '/copilotsearch').length, 1)
        assert.deepEqual(
            f.requests.filter(r => r.path === '/search').map(r => r.turn),
            ['1', '2', '3'],
            JSON.stringify(f.events)
        )
        assert.ok(f.events.includes('stage=feedback-like'))
        assert.ok(f.events.includes('stage=followup-3-completed'))
        assert.equal(f.context.pages().length, 1)
        assert.equal(f.source.url(), 'https://www.bing.com/')
    })
for (const feedback of ['none', 'dislike'])
    test(`AI ${feedback} sends no followup`, async t => {
        const f = await fixture(t)
        assert.equal(await f.ai.run(f.source, 'fixture', false, 'normal', { ai: true, feedback, followups: 1 }), true)
        assert.equal(f.requests.filter(r => r.path === '/search').length, 1)
        assert.ok(f.events.includes(`stage=feedback-${feedback}`), JSON.stringify(f.events))
    })
test('unconfirmed Like and missing composer never send a followup', async t => {
    for (const options of [{ unconfirmed: true }, { noComposer: true }]) {
        const f = await fixture(t, options)
        await f.ai.run(f.source, 'fixture', false, 'normal', { ai: true, feedback: 'like', followups: 1 })
        assert.equal(f.requests.filter(r => r.path === '/search').length, 1)
    }
})
test('unavailable initial AI keeps reservation, closes tab and reports false', async t => {
    const f = await fixture(t, { unavailable: true })
    assert.equal(
        await f.ai.run(f.source, 'fixture', false, 'normal', { ai: true, feedback: 'none', followups: 0 }),
        false
    )
    assert.equal(f.guard.queries, 1)
    assert.equal(f.context.pages().length, 1)
})
test('warmup uses the same bounded AI flow without reading Rewards or common quota', async t => {
    const f = await fixture(t, { warmup: true, mobile: true, rewardsProbe: true })
    assert.equal(
        await f.ai.run(f.source, 'fixture', true, 'warmup', { ai: true, feedback: 'like', followups: 1 }),
        true
    )
    assert.equal(f.guard.queries, 0)
    assert.ok(!f.requests.some(r => /rewards/.test(r.path)))
    assert.equal(f.requests.filter(r => r.path === '/copilotsearch').length, 1)
})
test('conversation permission rejects duplicate turns, changed conversation, extra main searches and cross-tab use', async t => {
    const f = await fixture(t)
    const page = await f.context.newPage()
    const guard = new AiConversation(page, 'fixture')
    await guard.install()
    f.guard.reserve('desktop')
    f.guard.beginSend()
    await page.goto('https://www.bing.com/copilotsearch?q=fixture')
    f.guard.endSend()
    await page.locator('iframe').waitFor()
    await page.waitForTimeout(80)
    const request = url =>
        page.evaluate(async u => {
            try {
                await fetch(u)
                return true
            } catch {
                return false
            }
        }, url)
    const base = 'https://www.bing.com/search?cpltsrchif=1&convid=fixture-conversation&turnindex=2&q=next'
    assert.equal(await guard.arm('next', 2), true)
    assert.equal(await request(base), true)
    assert.equal(await request(base), false)
    assert.equal(await request(base.replace('fixture-conversation', 'other-conversation')), false)
    assert.equal(await request('https://www.bing.com/search?q=extra'), false)
    assert.equal(await request('https://www.bing.com/copilotsearch?q=extra'), false)
    assert.equal(await guard.arm('third', 3), true)
    assert.equal(await guard.arm('fourth', 4), false)
    const other = await f.context.newPage()
    await assert.rejects(() => other.goto(base))
    assert.equal(f.guard.queries, 1)
})
test('Stop interrupts an unanswered AI turn without leaving a tab', async t => {
    const f = await fixture(t, { unavailable: true })
    const promise = f.ai.run(f.source, 'fixture', false, 'normal', { ai: true, feedback: 'none', followups: 0 })
    setTimeout(() => {
        f.bot.shuttingDown = true
    }, 20)
    await assert.rejects(() => promise, /interrupted/)
    assert.equal(f.context.pages().length, 1)
})

test('AI deadline cancels the child tab while keeping the initial reservation and source session', async t => {
    const f = await fixture(t, { unavailable: true, totalMs: 50 })
    assert.equal(
        await f.ai.run(f.source, 'fixture', false, 'normal', { ai: true, feedback: 'none', followups: 0 }),
        false
    )
    assert.equal(f.guard.queries, 1)
    assert.equal(f.context.pages().length, 1)
})
test('closed AI conversations cannot replay a followup or refund quota after journal reload', async t => {
    const f = await fixture(t)
    await f.ai.run(f.source, 'fixture', false, 'normal', { ai: true, feedback: 'like', followups: 1 })
    const reloaded = new NormalSession(f.bot.executionPlan)
    assert.equal(reloaded.queries, 1)
    assert.throws(() => reloaded.authorizeHttpSearch('https://www.bing.com/copilotsearch?q=fixture'), {
        code: 'SESSION_UNRESERVED_QUERY'
    })
    await assert.rejects(() =>
        f.source.goto('https://www.bing.com/search?q=followup&convid=fixture-conversation&turnindex=2&cpltsrchif=1')
    )
    assert.equal(f.guard.queries, 1)
})
