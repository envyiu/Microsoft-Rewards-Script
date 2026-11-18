import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ProcessManager } from './processManager.js'
import { processIdentity, processReplaced } from './processIdentity.js'
import { recordSessionOutcome, protectionFor } from './normalPolicy.js'
import { createRunState, applyLogToRunState } from './logParser.js'
import { SmartScheduler } from './smartScheduler.js'

const require = createRequire(import.meta.url)

test('scoped outcomes keep LOGIN-APP, LOGIN-BING, quota-endpoint, and task errors out of 24h account holds', t => {
    const { NormalSession } = require('../../dist/util/NormalSession.js')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msrw-p2-scope-'))
    const journal = path.join(dir, 'queries.jsonl')
    const prev = process.env.MRS_NORMAL_QUERY_JOURNAL
    process.env.MRS_NORMAL_QUERY_JOURNAL = journal
    fs.writeFileSync(journal, '', { mode: 0o600 })
    t.after(() => {
        if (prev === undefined) delete process.env.MRS_NORMAL_QUERY_JOURNAL
        else process.env.MRS_NORMAL_QUERY_JOURNAL = prev
        fs.rmSync(dir, { recursive: true, force: true })
    })

    const plan = {
        version: 1,
        jobId: 'session-1',
        type: 'accountSession',
        workers: ['readToEarn'],
        searchBudget: 5,
        platform: 'mobile',
        environment: 'mobile'
    }
    const guard = new NormalSession(plan)
    guard.observe('LOGIN-APP', 'Mobile token exchange failed | error=temporarily_unavailable', 'warn')
    guard.observe('LOGIN-BING', 'Bing SSO verification error=transient', 'warn')
    guard.recordScopedOutcome('quota-endpoint', 'search-deferred')
    guard.recordScopedOutcome('task', 'data')
    assert.equal(guard.failureReason(), null)
    assert.equal(guard.isSearchDeferred, true)
    assert.equal(guard.appStatus, 'transient-error')

    const outcome = JSON.parse(fs.readFileSync(journal + '.outcome', 'utf8'))
    assert.equal(outcome.failure, null)
    assert.equal(outcome.searchDeferred, true)

    // Even across two consecutive sessions, null failure never creates a 24h hold.
    const state = {}
    const p = protectionFor(state)
    p.sessions.push({ id: 's1', startedAt: new Date().toISOString(), endedAt: null })
    recordSessionOutcome(state, 's1', guard.failureReason())
    p.sessions.push({ id: 's2', startedAt: new Date().toISOString(), endedAt: null })
    recordSessionOutcome(state, 's2', guard.failureReason())
    assert.equal(p.hold, null)
})

test('control-file checkpoint handshake saves before kill without Unix signals and reports stopReason', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msrw-p2-ctrl-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const controlFile = path.join(dir, 'stop.json')
    const childCode = `
        const fs = require('node:fs');
        const ctrl = process.env.MRS_CHECKPOINT_CONTROL_FILE;
        setInterval(() => {
            if (!fs.existsSync(ctrl)) return;
            const req = JSON.parse(fs.readFileSync(ctrl, 'utf8'));
            fs.writeFileSync(ctrl + '.ack', JSON.stringify({ type: 'MSRW_CHECKPOINT_ACK', requestId: req.requestId, saved: true }));
            process.exit(0);
        }, 25);
        console.log('ready');
    `
    const manager = new ProcessManager({
        command: process.execPath,
        args: ['-e', childCode],
        checkpointIPC: false,
        stopTimeoutMs: 2000
    })
    manager.start({ env: { MRS_CHECKPOINT_CONTROL_FILE: controlFile }, trustedEnv: true })
    await new Promise(resolve => manager.child.stdout.once('data', resolve))
    const exit = await manager.stop({ signalTree: false, signal: 'SIGUSR1', reason: 'timeout' })
    assert.equal(exit.checkpoint, 'saved')
    assert.equal(exit.stopOutcome, 'saved')
    assert.equal(exit.stopReason, 'timeout')
})

test('Windows processIdentity detects recycled PIDs when creation timestamp changes', () => {
    const first = processIdentity(4242, {
        platform: 'win32',
        win32Inspector: () => ({ boot: 'win32', started: '2026-11-18T01:00:00.000Z:node.exe' })
    })
    const same = processIdentity(4242, {
        platform: 'win32',
        win32Inspector: () => ({ boot: 'win32', started: '2026-11-18T01:00:00.000Z:node.exe' })
    })
    const replaced = processIdentity(4242, {
        platform: 'win32',
        win32Inspector: () => ({ boot: 'win32', started: '2026-11-18T02:00:00.000Z:notepad.exe' })
    })
    assert.equal(processReplaced(first, same), false)
    assert.equal(processReplaced(first, replaced), true)
})

test('pipe field parsing preserves = characters inside values', () => {
    const state = createRunState()
    state.userToEmail['user@example.test'] = 'user@example.test'
    applyLogToRunState(state, {
        parsed: true,
        ts: '2026-11-18T00:00:00.000Z',
        level: 'info',
        user: 'user@example.test',
        platform: 'DESKTOP',
        title: 'REWARDS-STATE',
        message:
            'balance=150 | balanceStatus=fresh | balanceSource=flyout?a=1=2 | quotaStatus=fresh | readAt=2026-11-18T00:00:00.000Z | account=user@example.test'
    })
    assert.equal(state.accounts['user@example.test'].reliability.balance.source, 'flyout?a=1=2')
    assert.equal(state.accounts['user@example.test'].live.balance, 150)
})

test('retryAccounts reopens app-oauth blocked tasks same-day without clearing protection holds or manual locks', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msrw-p2-retry-'))
    const envBackup = { email: process.env.ACCOUNT_1_EMAIL, skip: process.env.MRS_SKIP_ENV_FILE }
    process.env.MRS_SKIP_ENV_FILE = '1'
    process.env.ACCOUNT_1_EMAIL = 'retry@example.test'
    t.after(() => {
        if (envBackup.email === undefined) delete process.env.ACCOUNT_1_EMAIL
        else process.env.ACCOUNT_1_EMAIL = envBackup.email
        if (envBackup.skip === undefined) delete process.env.MRS_SKIP_ENV_FILE
        else process.env.MRS_SKIP_ENV_FILE = envBackup.skip
        fs.rmSync(dir, { recursive: true, force: true })
    })

    const cfgPath = path.join(dir, 'config.json')
    fs.writeFileSync(cfgPath, fs.readFileSync(path.resolve('config.example.json'), 'utf8'))
    const prevCfg = process.env.MRS_CONFIG_FILE
    process.env.MRS_CONFIG_FILE = cfgPath
    t.after(() => {
        if (prevCfg === undefined) delete process.env.MRS_CONFIG_FILE
        else process.env.MRS_CONFIG_FILE = prevCfg
    })

    const scheduler = new SmartScheduler({
        projectRoot: dir,
        configFile: path.join(dir, 'smart-schedule.json'),
        command: process.execPath,
        args: ['-e', 'process.exit(0)']
    })
    t.after(() => scheduler.stop({ resume: false }))

    scheduler.enrollAccounts([1])
    const profile = scheduler.document.config.profiles[0]
    const state = scheduler._accountState({ index: 1, email: 'retry@example.test' }, profile, new Date())
    state.appAuthorization = { required: true, reason: 'email-code-required', at: new Date().toISOString() }
    state.workersFailed = ['readToEarn', 'dailyCheckIn', 'appPromotions']
    state.operatorPaused = true
    const guard = protectionFor(state)
    const holdUntil = new Date(Date.now() + 3600_000).toISOString()
    guard.hold = { reason: 'authentication', until: holdUntil }

    await scheduler.retryAccounts([1], { workers: ['readToEarn', 'dailyCheckIn', 'appPromotions'] })
    assert.deepEqual(state.workersFailed, [])
    assert.equal(state.appAuthorization.required, false)
    // Protection hold and operator pause remain intact!
    assert.equal(guard.hold.until, holdUntil)
    assert.equal(state.operatorPaused, true)
})

test('errorDiagnostic redacts credentials, avoids folder collisions, and flushes cleanly', async t => {
    const { errorDiagnostic, flushErrorDiagnostics } = require('../../dist/util/ErrorDiagnostic.js')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msrw-p2-diag-'))
    const prev = process.env.API_DIAGNOSTICS_DIR
    process.env.API_DIAGNOSTICS_DIR = dir
    t.after(() => {
        if (prev === undefined) delete process.env.API_DIAGNOSTICS_DIR
        else process.env.API_DIAGNOSTICS_DIR = prev
        fs.rmSync(dir, { recursive: true, force: true })
    })

    const fakePage = {
        isClosed: () => false,
        content: async () => '<html><body><input type="password" value="superSecret123"></body></html>',
        screenshot: async () => Buffer.from('png')
    }
    errorDiagnostic(fakePage, new Error('Failed auth token=mySecretToken999'))
    errorDiagnostic(fakePage, new Error('Second error password=anotherSecret'))
    await flushErrorDiagnostics()

    const entries = fs.readdirSync(dir).filter(n => n.startsWith('error-'))
    assert.equal(entries.length, 2)
    for (const folder of entries) {
        const errTxt = fs.readFileSync(path.join(dir, folder, 'error.txt'), 'utf8')
        const html = fs.readFileSync(path.join(dir, folder, 'dump.html'), 'utf8')
        assert.doesNotMatch(errTxt, /mySecretToken999|anotherSecret/)
        assert.doesNotMatch(html, /superSecret123/)
        assert.match(html, /\[REDACTED\]/)
    }
})

test('BrowserSearch and RewardsDashboardClient record NormalSession failures without Logger scraping, and retryAccounts respects maintenance/manual/uncertain locks', async t => {
    const { NormalSession } = require('../../dist/util/NormalSession.js')
    const { Search } = require('../../dist/functions/activities/search/BrowserSearch.js')
    const { onRuntimeEvent } = require('../../dist/util/RuntimeEvents.js')
    const { MobileAccessLogin } = require('../../dist/browser/auth/methods/MobileAccessLogin.js')

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msrw-p2-hooks-'))
    const journal = path.join(dir, 'queries.jsonl')
    const prevJournal = process.env.MRS_NORMAL_QUERY_JOURNAL
    process.env.MRS_NORMAL_QUERY_JOURNAL = journal
    fs.writeFileSync(journal, '', { mode: 0o600 })
    t.after(() => {
        if (prevJournal === undefined) delete process.env.MRS_NORMAL_QUERY_JOURNAL
        else process.env.MRS_NORMAL_QUERY_JOURNAL = prevJournal
        fs.rmSync(dir, { recursive: true, force: true })
    })

    const guard = new NormalSession({
        version: 1,
        jobId: 'session-hook',
        type: 'accountSession',
        workers: [],
        searchBudget: 5,
        platform: 'desktop',
        environment: 'desktop'
    })
    guard.recordQuotaSnapshot({ readAt: new Date().toISOString(), desktop: { max: 90, progress: 0 }, mobile: null })
    const bot = {
        normalSession: guard,
        executionPlan: {
            version: 1,
            jobId: 'session-hook',
            type: 'accountSession',
            workers: [],
            searchBudget: 5,
            platform: 'desktop',
            environment: 'desktop'
        },
        config: {
            searchSettings: { searchDelay: { min: 1, max: 1 }, queryEngines: ['local'], clusterSearch: false },
            proxy: { queryEngine: false }
        },
        accountLocale: { language: 'en', country: 'US', locale: 'en-US' },
        userData: { currentPoints: 0, geoLocale: 'US', langCode: 'en' },
        utils: { shuffleArray: arr => arr },
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        browser: {
            func: {
                synchronizeActiveBrowserCookies: async () => {},
                getDashboardData: async () => ({
                    dashboard: {
                        userStatus: {
                            counters: {
                                pcSearch: [{ offerId: 'pc', pointProgress: 0, pointProgressMax: 90 }],
                                mobileSearch: []
                            }
                        }
                    }
                })
            },
            utils: { tryDismissAllMessages: async () => {} }
        }
    }
    const search = new Search(bot)
    const brokenPage = {
        goto: async () => {
            throw new Error('net::ERR_PROXY_CONNECTION_FAILED')
        }
    }
    await search.doSearch(brokenPage, false, 3)
    assert.equal(guard.failureReason(), 'network')

    // MobileAccessLogin emits typed appAuthorization event and records app-needs-action without account failure
    const events = []
    const off = onRuntimeEvent(ev => events.push(ev))
    t.after(off)
    const appGuard = new NormalSession({
        version: 1,
        jobId: 'session-app',
        type: 'accountSession',
        workers: ['readToEarn'],
        searchBudget: 5,
        platform: 'mobile',
        environment: 'mobile'
    })
    const oauthPage = {
        url: () => 'https://login.live.com/oauth20_authorize.srf',
        goto: async () => {},
        close: async () => {},
        locator: sel => ({
            first: () => ({
                isVisible: async () => sel.includes('otc')
            })
        }),
        getByRole: () => ({ first: () => ({ isVisible: async () => false }) })
    }
    const mobileBot = {
        isMobile: true,
        normalSession: appGuard,
        newBrowserPage: async () => oauthPage,
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
    }
    const mobileLogin = new MobileAccessLogin(mobileBot, {
        context: () => ({}),
        request: {
            get: async () => ({ url: () => 'https://login.live.com/oauth20_authorize.srf', status: () => 200 })
        }
    })
    const token = await mobileLogin.get('user@example.test')
    assert.equal(token, '')
    assert.equal(appGuard.failureReason(), null)
    assert.equal(appGuard.appStatus, 'needs-action')
    assert.ok(
        events.some(
            e =>
                e.event === 'appAuthorization' &&
                e.payload.required === true &&
                e.payload.reason === 'email-code-required'
        )
    )

    // Scheduler lock enforcement for maintenance, manualLocks on warmup accounts, and SESSION_UNCERTAIN
    const envBackup = {
        email1: process.env.ACCOUNT_1_EMAIL,
        email2: process.env.ACCOUNT_2_EMAIL,
        mode2: process.env.ACCOUNT_2_NEW_ACCOUNT_MODE,
        skip: process.env.MRS_SKIP_ENV_FILE,
        cfg: process.env.MRS_CONFIG_FILE
    }
    process.env.MRS_SKIP_ENV_FILE = '1'
    process.env.ACCOUNT_1_EMAIL = 'lock1@example.test'
    process.env.ACCOUNT_2_EMAIL = 'warmup2@example.test'
    process.env.ACCOUNT_2_NEW_ACCOUNT_MODE = 'true'
    const cfgPath = path.join(dir, 'config.json')
    fs.writeFileSync(cfgPath, fs.readFileSync(path.resolve('config.example.json'), 'utf8'))
    process.env.MRS_CONFIG_FILE = cfgPath
    t.after(() => {
        for (const [k, v] of [
            ['ACCOUNT_1_EMAIL', envBackup.email1],
            ['ACCOUNT_2_EMAIL', envBackup.email2],
            ['ACCOUNT_2_NEW_ACCOUNT_MODE', envBackup.mode2],
            ['MRS_SKIP_ENV_FILE', envBackup.skip],
            ['MRS_CONFIG_FILE', envBackup.cfg]
        ]) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
        }
    })

    const scheduler = new SmartScheduler({
        projectRoot: dir,
        configFile: path.join(dir, 'smart-schedule.json'),
        command: process.execPath,
        args: ['-e', 'process.exit(0)']
    })
    t.after(() => scheduler.stop({ resume: false }))
    scheduler.enrollAccounts([1, 2])

    scheduler.setManualLock(2, 'DIRECT')
    await assert.rejects(() => scheduler.retryAccounts([2]), { code: 'ACCOUNT_HELD' })
    scheduler.clearManualLock(2)

    scheduler.maintenance = true
    await assert.rejects(() => scheduler.retryAccounts([1]), { code: 'UPDATE_IN_PROGRESS' })
    scheduler.maintenance = false

    const state1 = scheduler._accountState(
        { index: 1, email: 'lock1@example.test' },
        scheduler.document.config.profiles[0],
        new Date()
    )
    protectionFor(state1).sessions.push({ id: 'uncertain-1', startedAt: new Date().toISOString(), endedAt: null })
    await assert.rejects(() => scheduler.retryAccounts([1]), { code: 'SESSION_UNCERTAIN' })
})

test('standalone POST /smart-schedule/retry route and SessionRunner MRS_RUNTIME_EVENT_JOURNAL handle typed events without log regexes', async t => {
    const { handleSmartScheduleAndControlRoutes } = await import('./routes/smartSchedule.js')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msrw-p2-journal-'))
    const envBackup = {
        email1: process.env.ACCOUNT_1_EMAIL,
        mode1: process.env.ACCOUNT_1_NEW_ACCOUNT_MODE,
        skip: process.env.MRS_SKIP_ENV_FILE,
        cfg: process.env.MRS_CONFIG_FILE
    }
    process.env.MRS_SKIP_ENV_FILE = '1'
    process.env.ACCOUNT_1_EMAIL = 'journal1@example.test'
    process.env.ACCOUNT_1_NEW_ACCOUNT_MODE = 'true'
    const cfgPath = path.join(dir, 'config.json')
    fs.writeFileSync(cfgPath, fs.readFileSync(path.resolve('config.example.json'), 'utf8'))
    process.env.MRS_CONFIG_FILE = cfgPath
    t.after(() => {
        for (const [k, v] of [
            ['ACCOUNT_1_EMAIL', envBackup.email1],
            ['ACCOUNT_1_NEW_ACCOUNT_MODE', envBackup.mode1],
            ['MRS_SKIP_ENV_FILE', envBackup.skip],
            ['MRS_CONFIG_FILE', envBackup.cfg]
        ]) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
        }
        fs.rmSync(dir, { recursive: true, force: true })
    })

    // Child writes ONLY to MRS_RUNTIME_EVENT_JOURNAL (no IPC, no stdout log regexes)
    const childScript = path.join(dir, 'child-journal.cjs')
    fs.writeFileSync(
        childScript,
        `
        const fs = require('node:fs');
        const plan = JSON.parse(process.env.MRS_EXECUTION_PLAN);
        const journal = process.env.MRS_RUNTIME_EVENT_JOURNAL;
        const at = new Date().toISOString();
        const events = [
            { type: 'MSRW_EVENT', event: 'authPhase', payload: { phase: 'verification' }, at },
            {
                type: 'MSRW_EVENT',
                event: 'warmupCheckpoint',
                payload: {
                    jobId: plan.jobId,
                    policy: 'standard168h',
                    startedAt: at,
                    readyAt: new Date(Date.parse(at) + 168 * 3600000).toISOString(),
                    queries: plan.searchBudget,
                    services: ['onedrive'],
                    serviceActions: ['onedrive'],
                    artifacts: ['onedrive'],
                    at
                },
                at
            }
        ];
        fs.writeFileSync(journal, events.map(e => JSON.stringify(e)).join('\\n') + '\\n', { mode: 0o600 });
        process.exit(0);
    `
    )

    const scheduler = new SmartScheduler({
        projectRoot: dir,
        configFile: path.join(dir, 'smart-schedule.json'),
        command: process.execPath,
        args: [childScript]
    })
    t.after(() => scheduler.stop({ resume: false }))
    scheduler.enrollAccounts([1])
    scheduler.update({ ...scheduler.document.config, enabled: true })

    // Wait for warmup session to finish and replay MRS_RUNTIME_EVENT_JOURNAL
    for (let i = 0; i < 60; i++) {
        if (scheduler.document.state.sessions.length > 0 && scheduler.running.size === 0) break
        await new Promise(r => setTimeout(r, 50))
    }
    await scheduler.stop({ resume: false })

    const accState = scheduler.document.state.accounts['1']
    assert.ok(accState.newAccount?.startedAt, 'warmupCheckpoint from MRS_RUNTIME_EVENT_JOURNAL recorded startedAt')
    assert.deepEqual(accState.newAccount?.artifacts, ['onedrive'])

    // Verify standalone POST /smart-schedule/retry route works and enforces permissions
    accState.platforms.desktop.failed = true
    accState.platforms.desktop.failures = 3
    let responseStatus = null
    let responseBody = null
    const handledForbidden = await handleSmartScheduleAndControlRoutes({
        req: {},
        res: {},
        method: 'POST',
        pathname: '/smart-schedule/retry',
        allowScheduleWrite: false,
        sendJson: (_res, status, obj) => {
            responseStatus = status
            responseBody = obj
        },
        readJsonObject: async () => ({ accountIndexes: [1] }),
        smartScheduler: scheduler,
        getSmartState: () => scheduler.get()
    })
    assert.equal(handledForbidden, true)
    assert.equal(responseStatus, 403)

    const handledOk = await handleSmartScheduleAndControlRoutes({
        req: {},
        res: {},
        method: 'POST',
        pathname: '/smart-schedule/retry',
        allowScheduleWrite: true,
        sendJson: (_res, status, obj) => {
            responseStatus = status
            responseBody = obj
        },
        readJsonObject: async () => ({ accountIndexes: [1] }),
        smartScheduler: scheduler,
        getSmartState: () => scheduler.get()
    })
    assert.equal(handledOk, true)
    assert.equal(responseStatus, 202)
    assert.equal(responseBody.applied, true)
    assert.equal(accState.platforms.desktop.failed, false)
})
