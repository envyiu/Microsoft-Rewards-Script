import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { runRewardsOnboarding } = require('../../dist/functions/RewardsOnboarding.js')
const { Login } = require('../../dist/browser/auth/Login.js')

test('fresh Rewards membership without lifetime is recognized only beside its welcome controls', async () => {
    const { chromium } = await import('patchright')
    const browser = await chromium.launch({ headless: true })
    try {
        const page = await browser.newPage()
        await page.setContent('<h2>Welcome to<br>Microsoft Rewards</h2><button>Get started</button>')
        const account = { level: 1, pointsProgress: 0, pointsRemaining: 500, lifetimeEarn: null }
        const login = new Login({ isMobile: true, logger: { info() {} }, browser: { react: { snapshotPage: () => ({ account }) } } })
        assert.equal(await login.hasAuthenticatedRewardsPayload(page), true)
        await page.getByRole('button').evaluate(button => button.remove())
        assert.equal(await login.hasAuthenticatedRewardsPayload(page), false)
        await page.setContent('<h2>Welcome to<br>Microsoft Rewards</h2><button>Get started</button>')
        account.level = null
        assert.equal(await login.hasAuthenticatedRewardsPayload(page), false)
    } finally { await browser.close() }
})

test('onboarding follows the first-time UI, selects manual goal tracking and verifies progress without redeeming', async () => {
    const { chromium } = await import('patchright')
    const browser = await chromium.launch({ headless: true })
    const events = []
    try {
        const context = await browser.newContext()
        await context.route('https://rewards.bing.com/**', async route => {
            const pathname = new URL(route.request().url()).pathname
            const script = `<script>
              const done=JSON.parse(localStorage.getItem('steps')||'[]');
              function mark(step){if(!done.includes(step)){done.push(step);localStorage.setItem('steps',JSON.stringify(done))}}
              function tour(button){button.setAttribute('aria-expanded','true');sessionStorage.setItem(button.textContent,'1');if(['Your progress','Daily set','Your activity','Achievements'].every(k=>sessionStorage.getItem(k)))mark('tour');const dialog=document.createElement('section');dialog.setAttribute('role','dialog');dialog.style='position:fixed;inset:0;z-index:999;background:white';dialog.innerHTML='<p>Use Microsoft, earn points</p><button onclick="this.parentElement.remove()">Close</button>';document.body.appendChild(dialog)}
              function go(step,url){mark(step);location.href=url}
            </script>`
            let body
            if (pathname === '/dashboard') body = `<div id="welcome"><div><h2>Welcome to<br>Microsoft Rewards</h2></div><button onclick="localStorage.setItem('welcomed','yes');this.parentElement.remove()">Get started</button></div>
              <script>if(localStorage.getItem('welcomed'))document.getElementById('welcome').remove()</script>
              <h1>Get started with Rewards</h1><p id="progress"></p>
              <script>document.getElementById('progress').textContent=done.length+'/7 tasks'</script>
              ${['Your progress', 'Daily set', 'Your activity', 'Achievements'].map(label => `<button aria-expanded="false" onclick="tour(this)">${label}</button>`).join('')}
              <a data-step="goal" href="/redeem">Set a Rewards goal</a>
              <button data-step="browse" onclick="go('browse','/earn')">Browse the Earn page</button>
              <button data-step="level" onclick="go('level','/level')">Learn your level</button><script>
                document.querySelectorAll('[data-step]').forEach(el=>{if(done.includes(el.dataset.step))el.remove()});
              </script>`
            else if (pathname === '/redeem') body = '<a href="/redeem/roblox">Roblox Digital Card</a>'
            else if (pathname === '/redeem/roblox') body = `<button onclick="localStorage.setItem('package','840')">840 Robux</button><button>1050 Robux</button>
              <button onclick="localStorage.setItem('redeemed','yes')">Redeem now</button>
              <label style="position:relative;display:block;padding:10px">Set as your Rewards goal<input type="checkbox" role="switch" style="position:absolute;opacity:0;width:1px;height:1px" onchange="document.getElementById('goal').hidden=false"><span style="position:absolute;inset:0"></span></label>
              <div id="goal" role="dialog" hidden><h2>Set a Rewards goal</h2>
                <label><input type="radio" name="mode" id="auto">Auto-redeem your reward</label>
                <label style="position:relative">Track and manually redeem your reward<input type="radio" name="mode" id="manual" style="position:absolute;opacity:0;width:1px;height:1px"><span style="position:absolute;inset:0"></span></label>
                <button onclick="if(document.getElementById('manual').checked){mark('goal');document.getElementById('okay').hidden=false}">Next</button>
                <button id="okay" hidden onclick="document.getElementById('goal').hidden=true">Okay</button></div>`
            else body = '<p>Microsoft Rewards page</p>'
            await route.fulfill({ contentType: 'text/html', body: script + body })
        })
        const page = await context.newPage()
        page.on('pageerror', error => events.push({ message: error.message }))
        await page.goto('https://rewards.bing.com/dashboard')
        const logger = { info: (_mobile, title, message) => events.push({ title, message }), warn: (_mobile, title, message) => events.push({ title, message }) }
        await runRewardsOnboarding({ isMobile: false, logger }, page)
        assert.equal(await page.evaluate(() => localStorage.getItem('welcomed')), 'yes')
        assert.equal(await page.evaluate(() => localStorage.getItem('redeemed')), null)
        assert.equal(await page.evaluate(() => localStorage.getItem('package')), '840', JSON.stringify(events) + await page.content())
        assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('steps') || '[]')), ['tour', 'goal', 'browse', 'level'])
        assert.equal(events.filter(e => e.message.includes('status=verified')).length, 4)
        await runRewardsOnboarding({ isMobile: false, logger }, page)
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('steps')).length), 4)
    } finally { await browser.close() }
})
