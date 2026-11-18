/* global document, window */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { addAccounts, listManagedAccounts, updateAccount } from '../../packages/contracts/accountStore.js'
import { preRewardsActive, newAccountStatus } from '../../packages/contracts/newAccount.js'
const require = createRequire(import.meta.url)

test('new imports default to domain-specific warmup; legacy accounts and explicit choices are preserved', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msrw-new-account-'))
    const env = { ACCOUNT_1_EMAIL: 'existing@outlook.com' }
    try {
        fs.writeFileSync(path.join(root, '.env'), 'ACCOUNT_1_EMAIL=existing@outlook.com\n')
        const result = addAccounts(
            root,
            [
                { email: 'new@outlook.com' },
                { email: 'new@hotmail.com' },
                { email: 'normal@example.test' },
                { email: 'old@outlook.com', newAccountMode: false }
            ],
            env
        )
        assert.deepEqual(
            result.accounts.map(a => a.newAccountMode),
            [true, true, true, false]
        )
        assert.deepEqual(
            result.accounts.map(a => a.newAccountPolicy),
            ['standard168h', 'standard168h', 'search72h', 'standard168h']
        )
        assert.equal(listManagedAccounts(env).find(a => a.index === 1).newAccountMode, false)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
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
    let calls = 0,
        handler
    const events = []
    const context = {
        route: async (_pattern, fn) => {
            calls++
            handler = fn
        }
    }
    await installPreRewardsGuard(context, { onBlocked: location => events.push(location) })
    await installPreRewardsGuard(context)
    await handler({
        request: () => ({ url: () => 'https://rewards.bing.com/earn?secret=private' }),
        abort: async () => {}
    })
    assert.equal(calls, 1)
    assert.deepEqual(events, ['rewards.bing.com/earn'])
})

test('new account execution plans accept count-only search and reject unknown services or forged dates', () => {
    const { loadExecutionPlan } = require('../../dist/interface/ExecutionPlan.js')
    const plan = {
        version: 1,
        jobId: 'test',
        type: 'warmup',
        platform: 'desktop',
        searchBudget: 5,
        services: ['onedrive']
    }
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
    } finally {
        await browser.close()
    }
})

test('Microsoft-only login does not finalize Rewards and checkpoints the authenticated Bing session', async () => {
    const { Login } = require('../../dist/browser/auth/Login.js')
    const { closeSessionStore } = require('../../dist/util/SessionStore.js')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msrw-auth-only-'))
    const destinations = []
    const cookies = [
        {
            name: '_U',
            value: 'fixture',
            domain: '.bing.com',
            path: '/',
            expires: -1,
            secure: true,
            httpOnly: true,
            sameSite: 'Lax'
        }
    ]
    const context = { cookies: async () => cookies, storageState: async () => ({ cookies, origins: [] }) }
    const page = {
        context: () => context,
        goto: async url => {
            destinations.push(url)
        },
        isClosed: () => false
    }
    const logger = { info() {}, debug() {}, warn() {}, error() {} }
    const bot = {
        isMobile: false,
        config: { sessionPath: root, experimental: { blockMedia: false } },
        logger,
        utils: { wait: async () => {} },
        browser: { utils: { reloadBadPage: async () => {}, disableFido: async () => {} } }
    }
    const login = new Login(bot)
    login.detectCurrentState = async () => 'LOGGED_IN'
    login.finalizeLogin = async () => {
        throw new Error('Rewards finalization is forbidden')
    }
    try {
        await login.login(page, { email: 'fixture@example.test' }, { rewards: false })
        assert.equal(destinations.length, 1)
        assert.ok(destinations[0].startsWith('https://www.bing.com/fd/auth/signin'))
        assert.ok(fs.existsSync(path.join(root, 'sessions.db')))
    } finally {
        closeSessionStore()
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('OneDrive first-use marketing redirect follows only the visible Microsoft product sign-in link', async () => {
    const { Login } = require('../../dist/browser/auth/Login.js')
    const login = new Login({ logger: { info() {}, debug() {}, warn() {}, error() {} } })
    login.rewardsLogin = false
    login.serviceHost = 'onedrive.live.com'
    const destinations = []
    const link = {
        isVisible: async () => true,
        getAttribute: async () => 'https://go.microsoft.com/fwlink/p/?LinkID=2119709'
    }
    const page = {
        url: () => 'https://www.microsoft.com/en-us/microsoft-365/onedrive/online-cloud-storage',
        getByRole: () => ({ count: async () => 1, nth: () => link }),
        goto: async url => {
            destinations.push(url)
        }
    }
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

test('search72h import persists its policy; edits and reloads never reclassify legacy accounts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msrw-search72-import-'))
    const env = {
        ACCOUNT_1_EMAIL: 'legacy@gmail.com',
        ACCOUNT_2_EMAIL: 'legacy@outlook.com',
        ACCOUNT_2_NEW_ACCOUNT_MODE: 'true'
    }
    try {
        fs.writeFileSync(
            path.join(root, '.env'),
            Object.entries(env)
                .map(([k, v]) => `${k}=${v}`)
                .join('\n')
        )
        const added = addAccounts(
            root,
            [{ email: 'NEW@GMAIL.COM' }, { email: 'own@company.test' }, { email: 'NEW@HOTMAIL.COM' }],
            env
        ).accounts
        assert.deepEqual(
            added.map(a => a.newAccountPolicy),
            ['search72h', 'search72h', 'standard168h']
        )
        assert.ok(added.every(a => a.newAccountMode))
        assert.equal(env[`ACCOUNT_${added[0].index}_NEW_ACCOUNT_POLICY`], 'search72h')
        updateAccount(root, 1, { langCode: 'vi' }, env)
        updateAccount(root, 2, { langCode: 'vi' }, env)
        const loaded = listManagedAccounts(env)
        assert.equal(loaded.find(a => a.index === 1).newAccountMode, false)
        assert.equal(loaded.find(a => a.index === 1).newAccountPolicy, 'standard168h')
        assert.equal(loaded.find(a => a.index === 2).newAccountMode, true)
        assert.equal(loaded.find(a => a.index === 2).newAccountPolicy, 'standard168h')
        assert.throws(
            () => addAccounts(root, [{ email: 'bad@gmail.com', newAccountPolicy: 'invalid' }], env),
            /policy/i
        )
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('search-only execution plan forbids service visits, artifacts and mismatched lifecycle dates', () => {
    const { loadExecutionPlan } = require('../../dist/interface/ExecutionPlan.js')
    const plan = {
        version: 1,
        jobId: 'search-only',
        type: 'warmup',
        platform: 'desktop',
        searchBudget: 5,
        services: [],
        newAccountPolicy: 'search72h'
    }
    assert.equal(loadExecutionPlan(JSON.stringify(plan)).newAccountPolicy, 'search72h')
    assert.throws(() => loadExecutionPlan(JSON.stringify({ ...plan, services: ['outlook'] })), /Search-only/)
    assert.throws(() => loadExecutionPlan(JSON.stringify({ ...plan, artifacts: ['todo'] })), /Search-only/)
    const dates = { warmupStartedAt: '2026-11-01T00:00:00Z', warmupReadyAt: '2026-11-04T00:00:00Z' }
    assert.equal(loadExecutionPlan(JSON.stringify({ ...plan, ...dates })).newAccountPolicy, 'search72h')
    assert.throws(
        () => loadExecutionPlan(JSON.stringify({ ...plan, ...dates, newAccountPolicy: 'standard168h' })),
        /lifecycle/
    )
})

test('search72h runtime saves verified search before checkpoint, never visits services and does not checkpoint an uncertain query', async t => {
    const { runNewAccountSession } = require('../../dist/functions/NewAccount.js')
    const { Login } = require('../../dist/browser/auth/Login.js')
    const { Search } = require('../../dist/functions/activities/search/BrowserSearch.js')
    const { SearchQueryQueue } = require('../../dist/functions/SearchQueryQueue.js')
    const { closeSessionStore } = require('../../dist/util/SessionStore.js')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msrw-search72-runtime-'))
    const calls = [],
        checkpoints = [],
        destinations = []
    t.mock.method(Login.prototype, 'login', async (_page, _account, options) => {
        assert.equal(options.rewards, false)
    })
    t.mock.method(SearchQueryQueue.prototype, 'prepare', async () => 1)
    t.mock.method(SearchQueryQueue.prototype, 'next', async () => 'fixture')
    t.mock.method(Search.prototype, 'doUncountedQuery', async () => {
        calls.push('verified')
    })
    const context = {
        route: async () => {},
        storageState: async () => {
            calls.push('saved')
            return { cookies: [], origins: [] }
        }
    }
    const page = {
        goto: async url => destinations.push(url),
        locator: () => ({ first: () => ({ isVisible: async () => false }) })
    }
    const bot = {
        executionPlan: {
            type: 'warmup',
            jobId: 'fixture',
            newAccountPolicy: 'search72h',
            services: [],
            searchBudget: 1
        },
        isMobile: false,
        config: { sessionPath: root },
        logger: {
            info: (_mobile, _title, message) => {
                calls.push('checkpoint')
                checkpoints.push(JSON.parse(message))
            }
        }
    }
    try {
        await runNewAccountSession(bot, { email: 'fixture@gmail.com', newAccountPolicy: 'search72h' }, context, page)
        assert.deepEqual(calls, ['verified', 'saved', 'checkpoint'])
        assert.deepEqual(destinations, ['https://www.bing.com/'])
        assert.equal(checkpoints[0].policy, 'search72h')
        assert.equal(Date.parse(checkpoints[0].readyAt) - Date.parse(checkpoints[0].startedAt), 72 * 3600000)
        assert.deepEqual(checkpoints[0].services, [])
        t.mock.method(Search.prototype, 'doUncountedQuery', async () => {
            throw new Error('uncertain')
        })
        await assert.rejects(runNewAccountSession(bot, { email: 'fixture@gmail.com' }, context, page), /uncertain/)
        assert.equal(checkpoints.length, 1)
        bot.executionPlan.services = ['outlook']
        await assert.rejects(runNewAccountSession(bot, { email: 'fixture@gmail.com' }, context, page), /Search-only/)
    } finally {
        closeSessionStore()
        fs.rmSync(root, { recursive: true, force: true })
    }
})
