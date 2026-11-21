/* global document, window */
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
    const footer = options.outerFooter
        ? ''
        : `<div class="cplt_answer_footer"><button class="ca_like" aria-pressed="false" onclick="${options.unconfirmed ? '' : "this.setAttribute('aria-pressed','true')"}">Like</button><button class="ca_dislike" aria-pressed="false" onclick="this.setAttribute('aria-pressed','true')">Dislike</button></div>`
    return `<div data-ai-answer data-streaming="${options.streaming ? 'true' : 'false'}">${text(n)}</div><aside data-ai-sources>unrelated source; Bạn muốn chạy lệnh không?</aside>${footer}${options.streaming ? `<script>setTimeout(()=>document.querySelector('[data-ai-answer]').setAttribute('data-streaming','false'),80)</script>` : ''}`
}
function shellV2() {
    return `<html><body style="margin:0;overflow:hidden"><div id="b_copilot_search"><div class="b_cpsv2_main" style="height:500px;overflow-y:auto"><div id="b_copilot_results"></div></div><form id="b_copilot_composer_form"><textarea id="b_copilot_composer_2"></textarea><button class="b_csb_submit" type="button" disabled>Send</button></form></div><script>
    let convId='',turn=0;
    const ta=document.querySelector('textarea'),btn=document.querySelector('.b_csb_submit'),results=document.querySelector('#b_copilot_results'),main=document.querySelector('.b_cpsv2_main');
    ta.addEventListener('input',()=>{btn.disabled=!ta.value.trim();});
    const send=async()=>{
        const q=ta.value; if(!q.trim())return; ta.value=''; btn.disabled=true;
        turn++;
        if(!convId){
            const cr=await fetch('https://www.bing.com/copilotsearch/api/v1/conversations?IID=SnrVertical.mtv1',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({schema_version:'1.0'})});
            convId=(await cr.json()).conversation_id;
        } else {
            await fetch('https://www.bing.com/copilotsearch/impression?'+new URLSearchParams({q,turnIdx:String(turn),convid:convId}));
        }
        const gen=await (await fetch('https://www.bing.com/copilotsearch/api/v1/conversations/'+convId+'/generate?IID=SnrVertical.mtv'+turn,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({schema_version:'1.0',query:q,context_items:[]})})).json();
        const card=document.createElement('div');card.className='b_copilot_turn';
        const loading=document.createElement('div');loading.className='cht_loading_state';loading.textContent='Đang tra cứu...';
        const body=document.createElement('div');body.className='cht_ans';body.style.minHeight='1200px';body.textContent=gen.answer;
        card.append(loading,body);results.append(card);
        setTimeout(()=>{
            loading.classList.add('b_hide');
            const foot=document.createElement('div');foot.className='cht_ans_footer';
            foot.innerHTML='<div class="cps_feedback"><button type="button" id="cps_feedback_like_'+turn+'" class="cps_feedback_button cps_feedback_like" aria-pressed="false" onclick="this.setAttribute(\\'aria-pressed\\',\\'true\\')">Like</button><button type="button" id="cps_feedback_dislike_'+turn+'" class="cps_feedback_button cps_feedback_dislike" aria-pressed="false" onclick="this.setAttribute(\\'aria-pressed\\',\\'true\\')">Dislike</button></div>';
            card.append(foot);
            window.__v2MainScroll=()=>{return {st:main.scrollTop,sh:main.scrollHeight,ch:main.clientHeight}};
        },50);
    };
    ta.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();send();}});
    btn.addEventListener('click',send);
    </script></body></html>`
}
function shell(options) {
    if (options.v2) return shellV2()
    const initial = options.landing
        ? ''
        : `<li class="ca_turn" turnid="1"><iframe style="width:95%;height:450px" src="https://www.bing.com/search?q=fixture&convid=fixture-conversation&convsig=synthetic&turnindex=1&cpltsrchif=1"></iframe></li>`
    return `<html><body><data id="convId" value="fixture-conversation"></data><div id="b_copilot_search"><ol class="ca_container">${initial}</ol><textarea id="b_copilot_composer_2"></textarea><button class="b_copilot_send">Send</button></div><script>
    ${options.rewardsProbe ? "fetch('https://rewards.bing.com/earn').catch(()=>{})" : ''}
    let turn=${options.landing ? 0 : 1};
    const send=async()=>{
        const input=document.querySelector('textarea'); const q=input.value; input.value='';
        if(turn===0 && ${!!options.initialNavigation}) {location.href='https://www.bing.com/copilotsearch?q='+encodeURIComponent(q);return;}
        const u=new URL('https://www.bing.com/search');u.search=new URLSearchParams({q,convid:'fixture-conversation',convsig:'synthetic',turnindex:String(++turn),cpltsrchif:'1'});
        const li=document.createElement('li');li.className='ca_turn';li.setAttribute('turnid',String(turn));
        if(turn===1) {const f=document.createElement('iframe');f.style='width:95%;height:450px';f.src=u;li.append(f);document.querySelector('.ca_container').append(li);}
        else {const html=await(await fetch(u)).text();li.innerHTML=html;document.querySelector('.ca_container').append(li);}
        if(${!!options.outerFooter}){const f=document.createElement('div');f.className='ca_answer_footer';f.innerHTML='<button class="ca_like" aria-pressed="false" onclick="this.setAttribute(\\'aria-pressed\\',\\'true\\')">Like</button><button class="ca_dislike" aria-pressed="false">Dislike</button>';li.append(f);}
        if(${!!options.noComposer}&&turn===1){input.remove();document.querySelector('.b_copilot_send').remove();}
    };
    document.querySelector('textarea').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();send();}});
    document.querySelector('.b_copilot_send').addEventListener('click',send);
    </script></body></html>`
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
    const typedValues = [],
        enterQueries = [],
        domClicks = []
    await context.exposeBinding('__recordInput', (_source, value) => typedValues.push(value))
    await context.exposeBinding('__recordEnter', () => enterQueries.push(guard.queries))
    await context.exposeBinding('__recordClick', (_source, info) => domClicks.push(info))
    await context.addInitScript(() => {
        document.addEventListener(
            'input',
            e => {
                if (e.target.tagName === 'TEXTAREA') window.__recordInput(e.target.value)
            },
            true
        )
        document.addEventListener(
            'keydown',
            e => {
                if (e.key === 'Enter') window.__recordEnter()
            },
            true
        )
        document.addEventListener(
            'mousedown',
            e => {
                const el = e.target
                window.__recordClick({
                    tag: el?.tagName,
                    id: el?.id,
                    cls: el?.className,
                    x: e.clientX,
                    y: e.clientY
                })
            },
            true
        )
    })
    const requests = [],
        events = [],
        timings = [],
        cursors = new WeakMap(),
        clicks = []
    let v2Turn = 0
    // Last fallback is entirely synthetic: no Microsoft network traffic is allowed.
    await context.route('**/*', async route => {
        const u = new URL(route.request().url())
        const method = route.request().method()
        requests.push({
            path: u.pathname,
            method,
            turn: u.searchParams.get('turnindex') || u.searchParams.get('turnIdx'),
            q: u.searchParams.get('q'),
            body: route.request().postData() || null
        })
        if (u.pathname === '/copilotsearch')
            await route.fulfill({
                status: 200,
                contentType: 'text/html; charset=utf-8',
                body: shell({ ...options, landing: u.searchParams.get('q') === '' })
            })
        else if (method === 'POST' && u.pathname === '/copilotsearch/api/v1/conversations')
            await route.fulfill({
                status: 201,
                contentType: 'application/json',
                body: JSON.stringify({ conversation_id: 'v2-conv-1', state: 'active' })
            })
        else if (method === 'POST' && /\/copilotsearch\/api\/v1\/conversations\/[^/]+\/generate$/.test(u.pathname)) {
            v2Turn++
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ answer: text(v2Turn) })
            })
        } else if (u.pathname === '/copilotsearch/impression') await route.fulfill({ status: 204, body: '' })
        else if (u.pathname === '/search')
            await route.fulfill({
                status: 200,
                contentType: 'text/html; charset=utf-8',
                body: options.unavailable
                    ? '<html>Unavailable</html>'
                    : answerHtml(Number(u.searchParams.get('turnindex')), {
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
        utils: {
            randomDelay: (min, max) => {
                timings.push([min, max])
                return 0
            },
            wait: ms => new Promise(r => setTimeout(r, Math.min(Number(ms), 5)))
        },
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
                                scrollTo: async where => {
                                    events.push(`scroll:${where}`)
                                },
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
        initialWaitMs: options.unavailable ? 100 : 10000,
        followupWaitMs: 10000,
        totalMs: options.totalMs || 60000,
        pollMs: 5
    })
    t.after(async () => {
        await context.close()
        setNormalSession(new NormalSession(null))
        if (old === undefined) delete process.env.MRS_NORMAL_QUERY_JOURNAL
        else process.env.MRS_NORMAL_QUERY_JOURNAL = old
        fs.rmSync(dir, { recursive: true, force: true })
    })
    return {
        ai,
        bot,
        guard,
        context,
        source,
        requests,
        events,
        journal,
        clicks,
        timings,
        typedValues,
        enterQueries,
        domClicks
    }
}

for (const mobile of [false, true])
    test(`AI browser ${mobile ? 'Mobile' : 'Desktop'}: streaming, Like and two bound followups consume exactly one query`, async t => {
        const f = await fixture(t, { mobile, streaming: true, realCursor: !mobile })
        assert.equal(
            await f.ai.run(f.source, 'fixture', mobile, 'normal', { ai: true, feedback: 'like', followups: 1 }),
            true,
            JSON.stringify({ events: f.events, reqs: f.requests, typed: f.typedValues, enter: f.enterQueries })
        )
        assert.equal(f.guard.queries, 1)
        assert.equal(f.guard.normalSearchUsed, 1)
        assert.equal(fs.readFileSync(f.journal, 'utf8').trim().split('\n').length, 1)
        assert.equal(f.requests.filter(r => r.path === '/copilotsearch').length, 1)
        assert.equal(f.requests.find(r => r.path === '/copilotsearch').q, '')
        assert.deepEqual(f.typedValues.filter((value, i, values) => i === 0 || value !== values[i - 1]).slice(0, 7), [
            'f',
            'fi',
            'fix',
            'fixt',
            'fixtu',
            'fixtur',
            'fixture'
        ])
        assert.equal(f.enterQueries[0], 1)
        assert.ok(f.timings.some(([min, max]) => min === 5000 && max === 8000))
        assert.ok(f.timings.some(([min, max]) => min === 1000 && max === 1500))
        assert.ok(f.events.indexOf('stage=reading') < f.events.indexOf('stage=scrolled-bottom'))
        assert.ok(f.events.indexOf('stage=scrolled-bottom') < f.events.indexOf('stage=feedback-like'))
        assert.deepEqual(
            f.requests.filter(r => r.path === '/search').map(r => r.turn),
            ['1', '2', '3'],
            JSON.stringify({ events: f.events, domClicks: f.domClicks })
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
    await page.goto('https://www.bing.com/copilotsearch?q=')
    assert.equal(f.guard.queries, 0)
    await page.locator('textarea').type('fixture')
    f.guard.reserve('desktop')
    f.guard.beginSend()
    assert.equal(guard.armInitial(), true)
    await page.locator('textarea').press('Enter')
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
    assert.ok(f.guard.queries <= 1)
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

test('pressing Enter may navigate to the filled query, but only after the empty landing and one reservation', async t => {
    const f = await fixture(t, { initialNavigation: true })
    assert.equal(
        await f.ai.run(f.source, 'fixture', false, 'normal', { ai: true, feedback: 'none', followups: 0 }),
        true
    )
    assert.deepEqual(
        f.requests.filter(r => r.path === '/copilotsearch').map(r => r.q),
        ['', 'fixture']
    )
    assert.equal(f.guard.queries, 1)
    assert.equal(f.enterQueries[0], 1)
    assert.equal(f.requests.filter(r => r.path === '/search').length, 1)
})

test('Stop during the reading pause prevents scrolling and feedback', async t => {
    const f = await fixture(t)
    f.bot.utils.randomDelay = (min, max) => {
        f.timings.push([min, max])
        return min === 5000 ? 5000 : 0
    }
    const info = f.bot.logger.info
    f.bot.logger.info = (mobile, title, message) => {
        info(mobile, title, message)
        if (message === 'stage=reading')
            setTimeout(() => {
                f.bot.shuttingDown = true
            }, 20)
    }
    await assert.rejects(
        () => f.ai.run(f.source, 'fixture', false, 'normal', { ai: true, feedback: 'like', followups: 1 }),
        /interrupted/
    )
    assert.ok(!f.events.includes('stage=scrolled-bottom'))
    assert.ok(!f.events.includes('stage=feedback-like'))
    assert.equal(f.context.pages().length, 1)
})

for (const mobile of [false, true])
    test(`Bing v2 ${mobile ? 'Mobile' : 'Desktop'}: REST conversation, b_cpsv2_main scroll, feedback and followups work`, async t => {
        const f = await fixture(t, { v2: true, mobile, realCursor: true })
        let mainScrollBeforeClose = null
        const origNewPage = f.bot.newBrowserPage
        f.bot.newBrowserPage = async () => {
            const p = await origNewPage()
            const origClose = p.close.bind(p)
            p.close = async opts => {
                mainScrollBeforeClose = await p
                    .evaluate(() => {
                        const m = document.querySelector('.b_cpsv2_main')
                        return m ? { st: m.scrollTop, sh: m.scrollHeight, ch: m.clientHeight } : null
                    })
                    .catch(() => null)
                return origClose(opts)
            }
            return p
        }
        assert.equal(
            await f.ai.run(f.source, 'fixture', mobile, 'normal', { ai: true, feedback: 'like', followups: 1 }),
            true
        )
        assert.equal(f.guard.queries, 1)
        assert.equal(f.enterQueries[0], 1)
        assert.equal(
            f.requests.filter(r => r.method === 'POST' && r.path === '/copilotsearch/api/v1/conversations').length,
            1
        )
        assert.equal(
            f.requests.filter(
                r => r.method === 'POST' && r.path === '/copilotsearch/api/v1/conversations/v2-conv-1/generate'
            ).length,
            3,
            JSON.stringify({ events: f.events, domClicks: f.domClicks, reqs: f.requests, enter: f.enterQueries })
        )
        assert.equal(f.requests.filter(r => r.path === '/copilotsearch/impression').length, 2)
        assert.ok(mainScrollBeforeClose && mainScrollBeforeClose.st > 100, JSON.stringify(mainScrollBeforeClose))
        assert.ok(f.timings.some(([min, max]) => min === 5000 && max === 8000))
        assert.ok(f.timings.some(([min, max]) => min === 1000 && max === 1500))
        assert.ok(f.events.indexOf('stage=reading') < f.events.indexOf('stage=scrolled-bottom'))
        assert.ok(f.events.indexOf('stage=scrolled-bottom') < f.events.indexOf('stage=feedback-like'))
        assert.ok(f.events.includes('stage=followup-2-completed'))
        assert.ok(f.events.includes('stage=followup-3-completed'))
        assert.equal(f.context.pages().length, 1)
    })

test('Bing v1 outer turn footer and ca_like outside iframe complete and vote cleanly', async t => {
    const f = await fixture(t, { outerFooter: true, realCursor: true })
    assert.equal(
        await f.ai.run(f.source, 'fixture', false, 'normal', { ai: true, feedback: 'like', followups: 1 }),
        true,
        JSON.stringify({ events: f.events, domClicks: f.domClicks, reqs: f.requests, enter: f.enterQueries })
    )
    assert.ok(
        f.events.includes('stage=initial-completed'),
        JSON.stringify({ events: f.events, domClicks: f.domClicks })
    )
    assert.ok(f.events.includes('stage=feedback-like'), JSON.stringify({ events: f.events, domClicks: f.domClicks }))
    assert.ok(
        f.events.includes('stage=followup-2-completed'),
        JSON.stringify({ events: f.events, domClicks: f.domClicks })
    )
})

test('AiConversation enforces v2 REST bounds and rejects forged or un-armed calls', async t => {
    const f = await fixture(t, { v2: true })
    const page = await f.context.newPage()
    const guard = new AiConversation(page, 'fixture')
    await guard.install()
    await page.goto('https://www.bing.com/copilotsearch?q=')
    const postJson = (url, body) =>
        page.evaluate(
            async ([u, b]) => {
                try {
                    const r = await fetch(u, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify(b)
                    })
                    return r.ok
                } catch {
                    return false
                }
            },
            [url, body]
        )
    const getUrl = url =>
        page.evaluate(async u => {
            try {
                const r = await fetch(u)
                return r.status < 400
            } catch {
                return false
            }
        }, url)

    // Un-armed initial conversation creation is rejected
    assert.equal(await postJson('https://www.bing.com/copilotsearch/api/v1/conversations', {}), false)
    assert.equal(f.guard.queries, 0)

    f.guard.reserve('desktop')
    f.guard.beginSend()
    assert.equal(guard.armInitial(), true)
    assert.equal(await postJson('https://www.bing.com/copilotsearch/api/v1/conversations', {}), true)
    // Duplicate conversation creation rejected
    assert.equal(await postJson('https://www.bing.com/copilotsearch/api/v1/conversations', {}), false)
    // Wrong query in generate rejected
    assert.equal(
        await postJson('https://www.bing.com/copilotsearch/api/v1/conversations/v2-conv-1/generate', {
            query: 'evil'
        }),
        false
    )
    // Valid turn 1 generate succeeds once, then replay rejected
    assert.equal(
        await postJson('https://www.bing.com/copilotsearch/api/v1/conversations/v2-conv-1/generate', {
            query: 'fixture'
        }),
        true
    )
    f.guard.endSend()
    assert.equal(
        await postJson('https://www.bing.com/copilotsearch/api/v1/conversations/v2-conv-1/generate', {
            query: 'fixture'
        }),
        false
    )
    // Un-armed turn 2 rejected
    assert.equal(
        await postJson('https://www.bing.com/copilotsearch/api/v1/conversations/v2-conv-1/generate', {
            query: 'next'
        }),
        false
    )
    // Arm turn 2 -> wrong convId rejected, right convId + impression accepted once
    assert.equal(await guard.arm('next', 2), true)
    assert.equal(
        await postJson('https://www.bing.com/copilotsearch/api/v1/conversations/other-conv/generate', {
            query: 'next'
        }),
        false
    )
    assert.equal(await getUrl('https://www.bing.com/copilotsearch/impression?q=next&turnIdx=2&convid=v2-conv-1'), true)
    assert.equal(
        await postJson('https://www.bing.com/copilotsearch/api/v1/conversations/v2-conv-1/generate', {
            query: 'next'
        }),
        true
    )
    assert.equal(f.guard.queries, 1)
})

test('AiConversation allows bounded searchharderbfpr companion fetches only after initial turn', async t => {
    const f = await fixture(t)
    const page = await f.context.newPage()
    const guard = new AiConversation(page, 'fixture')
    await guard.install()
    await page.goto('https://www.bing.com/copilotsearch?q=')
    const request = url =>
        page.evaluate(async u => {
            try {
                const r = await fetch(u)
                return r.status < 400
            } catch {
                return false
            }
        }, url)
    const harderUrl =
        'https://www.bing.com/search?q=fixture&shm=co&traffictype=searchharderbfpr&mgidx=0&cpltsrchif=1&convid=fixture-conversation'

    // Before initial turn 1 is rejected
    assert.equal(await request(harderUrl), false)

    await page.locator('textarea').type('fixture')
    f.guard.reserve('desktop')
    f.guard.beginSend()
    assert.equal(guard.armInitial(), true)
    await page.locator('textarea').press('Enter')
    f.guard.endSend()
    await page.locator('iframe').waitFor()
    await page.waitForTimeout(80)

    // Allowed once after turn 1, then replay and forged variants are rejected
    assert.equal(await request(harderUrl), true)
    assert.equal(await request(harderUrl), false)
    assert.equal(await request(harderUrl.replace('q=fixture', 'q=other')), false)
    assert.equal(await request(harderUrl.replace('fixture-conversation', 'other-conv')), false)
    assert.equal(await request(harderUrl.replace('mgidx=0', 'mgidx=9')), false)
    assert.equal(f.guard.queries, 1)
})
