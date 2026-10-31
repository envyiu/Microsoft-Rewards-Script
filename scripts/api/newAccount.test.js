/* global document, window */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { addAccounts, listManagedAccounts } from '../../packages/contracts/accountStore.js'
import { preRewardsActive, newAccountStatus } from '../../packages/contracts/newAccount.js'
const require = createRequire(import.meta.url)

test('only newly imported Outlook/Hotmail accounts default to new-account mode; explicit choice is preserved', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msrw-new-account-'))
    const env = { ACCOUNT_1_EMAIL: 'existing@outlook.com' }
    try {
        fs.writeFileSync(path.join(root, '.env'), 'ACCOUNT_1_EMAIL=existing@outlook.com\n')
        const result = addAccounts(root, [
            { email: 'new@outlook.com' }, { email: 'new@hotmail.com' },
            { email: 'normal@example.test' }, { email: 'old@outlook.com', newAccountMode: false }
        ], env)
        assert.deepEqual(result.accounts.map(a => a.newAccountMode), [true, true, false, false])
        assert.equal(listManagedAccounts(env).find(a => a.index === 1).newAccountMode, false)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('eligibility is fail-closed and starts exactly at 168 hours', () => {
    const account = { newAccountMode: true }
    assert.equal(preRewardsActive(account, {}), true)
    assert.equal(preRewardsActive(account, { newAccount: { readyAt: 'bad' } }), true)
    const state = { newAccount: { readyAt: '2026-11-06T00:00:00Z' } }
    assert.equal(preRewardsActive(account, state, Date.parse(state.newAccount.readyAt) - 1), true)
    assert.equal(preRewardsActive(account, state, Date.parse(state.newAccount.readyAt)), false)
    assert.equal(newAccountStatus({}, {}), null)
})

test('guard installation is idempotent and does not expose query strings in audit events', async () => {
    const { installPreRewardsGuard } = require('../../common/preRewardsGuard.cjs')
    let calls = 0, handler
    const events = []
    const context = { route: async (_pattern, fn) => { calls++; handler = fn } }
    await installPreRewardsGuard(context, { onBlocked: location => events.push(location) })
    await installPreRewardsGuard(context)
    await handler({ request: () => ({ url: () => 'https://rewards.bing.com/earn?secret=private' }), abort: async () => {} })
    assert.equal(calls, 1)
    assert.deepEqual(events, ['rewards.bing.com/earn'])
})

test('new account execution plans accept count-only search and reject unknown services or forged dates', () => {
    const { loadExecutionPlan } = require('../../dist/interface/ExecutionPlan.js')
    const plan = { version: 1, jobId: 'test', type: 'warmup', platform: 'desktop', searchBudget: 5, services: ['onedrive'] }
    assert.equal(loadExecutionPlan(JSON.stringify(plan)).type, 'warmup')
    assert.throws(() => loadExecutionPlan(JSON.stringify({ ...plan, services: ['redeem'] })))
    assert.throws(() => loadExecutionPlan(JSON.stringify({ ...plan, rewardsEligibleAt: 'bad' })))
    assert.throws(() => loadExecutionPlan(JSON.stringify({ ...plan, searchBudget: 6 })))
    assert.throws(() => loadExecutionPlan(JSON.stringify({ ...plan, urgent: true })))
})

test('real browser routing blocks Rewards navigation, iframe, background fetch and popup before the network', async () => {
    const { chromium } = await import('patchright')
    const { installPreRewardsGuard } = require('../../common/preRewardsGuard.cjs')
    const browser = await chromium.launch({ headless: true })
    try {
        const context = await browser.newContext({ serviceWorkers: 'block' })
        const network = []
        await context.route('**/*', async route => {
            network.push(route.request().url())
            await route.fulfill({ status: 200, contentType: 'text/html', body: '<html>Microsoft fixture</html>' })
        })
        await installPreRewardsGuard(context)
        const page = await context.newPage()
        await page.goto('https://www.bing.com/search?q=test')
        await page.evaluate(async () => {
            await fetch('https://www.bing.com/rewards/panelflyout/getuserinfo').catch(() => {})
            const frame = document.createElement('iframe')
            frame.src = 'https://rewards.bing.com/dashboard'
            document.body.appendChild(frame)
            window.open('https://rewards.bing.com/earn')
        })
        await page.waitForTimeout(200)
        await assert.rejects(page.goto('https://rewards.bing.com/earn', { timeout: 3000 }))
        assert.deepEqual(network, ['https://www.bing.com/search?q=test'])
    } finally { await browser.close() }
})

test('Microsoft-only login does not finalize Rewards and checkpoints the authenticated Bing session', async () => {
    const { Login } = require('../../dist/browser/auth/Login.js')
    const { closeSessionStore } = require('../../dist/util/SessionStore.js')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msrw-auth-only-'))
    const destinations = []
    const cookies = [{ name: '_U', value: 'fixture', domain: '.bing.com', path: '/', expires: -1, secure: true, httpOnly: true, sameSite: 'Lax' }]
    const context = { cookies: async () => cookies, storageState: async () => ({ cookies, origins: [] }) }
    const page = { context: () => context, goto: async url => { destinations.push(url) }, isClosed: () => false }
    const logger = { info() {}, debug() {}, warn() {}, error() {} }
    const bot = { isMobile: false, config: { sessionPath: root, experimental: { blockMedia: false } }, logger, utils: { wait: async () => {} }, browser: { utils: { reloadBadPage: async () => {}, disableFido: async () => {} } } }
    const login = new Login(bot)
    login.detectCurrentState = async () => 'LOGGED_IN'
    login.finalizeLogin = async () => { throw new Error('Rewards finalization is forbidden') }
    try {
        await login.login(page, { email: 'fixture@example.test' }, { rewards: false })
        assert.equal(destinations.length, 1)
        assert.ok(destinations[0].startsWith('https://www.bing.com/fd/auth/signin'))
        assert.ok(fs.existsSync(path.join(root, 'sessions.db')))
    } finally { closeSessionStore(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('OneDrive first-use marketing redirect follows only the visible Microsoft product sign-in link', async () => {
    const { Login } = require('../../dist/browser/auth/Login.js')
    const login = new Login({ logger: { info() {}, debug() {}, warn() {}, error() {} } })
    login.rewardsLogin = false
    login.serviceHost = 'onedrive.live.com'
    const destinations = []
    const link = { isVisible: async () => true, getAttribute: async () => 'https://go.microsoft.com/fwlink/p/?LinkID=2119709' }
    const page = { url: () => 'https://www.microsoft.com/en-us/microsoft-365/onedrive/online-cloud-storage',
        getByRole: () => ({ count: async () => 1, nth: () => link }), goto: async url => { destinations.push(url) } }
    assert.equal(await login.handleState('UNKNOWN', page, {}), true)
    assert.equal(destinations.length, 1)
    assert.equal(new URL(destinations[0]).hostname, 'go.microsoft.com')
    assert.equal(login.firstPartyWelcomeActions, 1)
})

test('a new account cannot enter the normal runtime with an absent or future eligibility date', async () => {
    const { MicrosoftRewardsBot } = require('../../dist/index.js')
    const bot = Object.create(MicrosoftRewardsBot.prototype)
    bot.executionPlan = { type: 'search', platform: 'desktop' }
    await assert.rejects(bot.Main({ newAccountMode: true }), /eligibility/)
    bot.executionPlan.rewardsEligibleAt = '2999-01-01T00:00:00Z'
    await assert.rejects(bot.Main({ newAccountMode: true }), /eligibility/)
})
