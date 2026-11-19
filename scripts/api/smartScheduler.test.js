import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    calculateSearchDue,
    calculateSearchBudget,
    dailySetDependencySatisfied,
    deriveNetworkGroup,
    normalizeSearchResult,
    selectWorkerSession,
    selectUrgentWorkerSession,
    selectRunnableJobs,
    shouldPlanSearch,
    migrateRewardsVerification,
    earnRecheckDue,
    applyEarnScan,
    SmartScheduler,
    validateSmartConfig
} from './smartScheduler.js'
import { ProcessManager } from './processManager.js'

const accounts = [
    { index: 1, email: 'one@example.test', proxy: null },
    { index: 2, email: 'two@example.test', proxy: { url: 'http://proxy.local', port: '8080' } },
    { index: 3, email: 'three@example.test', proxy: { url: 'http://proxy.local', port: '8080' } }
]

test('targeted Run now takes the next free slot ahead of recurring work without bypassing proxy locks', () => {
    const scheduler = Object.create(SmartScheduler.prototype)
    scheduler.document = { config: { enabled: true, maxParallel: 1 }, state: { onceAccounts: [2], accounts: {} } }
    scheduler.running = new Map()
    scheduler.manualLocks = new Map()
    scheduler.emit = () => {}
    scheduler.get = () => ({})
    const started = []
    scheduler._start = job => started.push(job.accountIndex)
    const job = (index, group) => ({
        id: String(index),
        accountIndex: index,
        networkGroup: group,
        dueAt: new Date(Date.now() - 10000).toISOString(),
        urgent: false
    })
    const queue = [job(1, 'old'), job(2, 'new')]
    scheduler.queue = [...queue]
    scheduler._drain()
    assert.deepEqual(started, [2])
    started.length = 0
    scheduler.queue = [...queue]
    scheduler.manualLocks.set(3, 'new')
    scheduler._drain()
    assert.deepEqual(started, [1])
})

test('new account planning never emits Rewards work, caps daily queries and preserves its 168-hour timer at midnight', t => {
    const { scheduler, account } = planningFixture(t)
    scheduler._drain = () => {}
    const flag = `ACCOUNT_${account.index}_NEW_ACCOUNT_MODE`
    process.env[flag] = 'true'
    t.after(() => {
        delete process.env[flag]
    })
    account.newAccountMode = true
    scheduler.replan()
    assert.equal(scheduler.queue.length, 2)
    assert.ok(scheduler.queue.every(j => j.type === 'warmup' && j.searchBudget <= 5))
    const state = scheduler.document.state.accounts[account.index]
    state.platforms.mobile.queries = 20
    state.platforms.desktop.queries = 30
    state.newAccount.services = ['onedrive', 'todo', 'outlook', 'calendar']
    state.newAccount.serviceActions = [...state.newAccount.services]
    state.newAccount.artifacts = ['onedrive', 'todo']
    state.newAccount.startedAt = new Date().toISOString()
    state.newAccount.readyAt = new Date(Date.now() + 168 * 3600000).toISOString()
    scheduler.replan()
    assert.equal(scheduler.queue.length, 0)
    const readyAt = state.newAccount.readyAt
    t.mock.timers.tick(24 * 3600000)
    scheduler.replan()
    const tomorrow = scheduler.document.state.accounts[account.index]
    assert.equal(tomorrow.newAccount.readyAt, readyAt)
    assert.equal(tomorrow.platforms.desktop.queries, 0)
    assert.deepEqual(tomorrow.newAccount.services, [])
    assert.deepEqual(tomorrow.newAccount.serviceActions, [])
    assert.deepEqual(tomorrow.newAccount.artifacts, ['onedrive', 'todo'])
    assert.ok(scheduler.queue.every(j => j.type === 'warmup'))
    t.mock.timers.tick(144 * 3600000)
    scheduler.replan()
    assert.ok(scheduler.queue.some(j => j.type === 'workers'))
    assert.ok(scheduler.queue.every(j => j.type !== 'warmup'))
})

test('new account checkpoint counts a query once and starts the timer only after saved search evidence', () => {
    const scheduler = Object.create(SmartScheduler.prototype)
    scheduler._save = () => {}
    scheduler.document = { state: { accounts: { 1: { day: '2026-10-30', platforms: { desktop: { queries: 0 } } } } } }
    const record = {
        job: {
            id: 'job',
            accountIndex: 1,
            day: '2026-10-30',
            type: 'warmup',
            platform: 'desktop',
            services: ['onedrive'],
            searchBudget: 5
        }
    }
    const log = (queries, services = []) => ({
        message: JSON.stringify({ jobId: 'job', queries, services, at: '2026-10-30T00:00:00Z' })
    })
    scheduler._newAccountCheckpoint(record, log(0, ['onedrive']))
    const state = scheduler.document.state.accounts[1]
    assert.equal(state.newAccount.startedAt, undefined)
    scheduler._newAccountCheckpoint(record, {
        message: JSON.stringify({
            jobId: 'job',
            queries: 0,
            services: ['onedrive'],
            serviceActions: ['onedrive', 'calendar'],
            artifacts: ['onedrive', 'todo'],
            at: '2026-10-30T00:00:00Z'
        })
    })
    assert.deepEqual(state.newAccount.serviceActions, ['onedrive'])
    assert.deepEqual(state.newAccount.artifacts, ['onedrive'])
    scheduler._newAccountCheckpoint(record, log(1))
    scheduler._newAccountCheckpoint(record, log(1))
    assert.equal(state.platforms.desktop.queries, 1)
    assert.equal(state.newAccount.readyAt, '2026-11-06T00:00:00.000Z')
    scheduler._newAccountCheckpoint(record, log(100))
    assert.equal(state.platforms.desktop.queries, 1)
    assert.deepEqual(state.newAccount.services, ['onedrive'])
})

test('Rewards verification upgrade reopens only the two affected workers once and preserves session/search progress', () => {
    const state = {
        accounts: {
            1: {
                workersCompleted: ['dailySet', 'morePromotions', 'punchCards'],
                workersFailed: ['readToEarn', 'punchCards'],
                workerFailures: { punchCards: 3, readToEarn: 2 },
                workerRetryAt: { punchCards: 'old', readToEarn: 'keep' },
                platforms: { desktop: { remaining: 7 } }
            }
        },
        sessions: [{ id: 'keep-session' }]
    }
    assert.equal(migrateRewardsVerification(state), true)
    assert.deepEqual(state.accounts[1].workersCompleted, ['dailySet'])
    assert.deepEqual(state.accounts[1].workersFailed, ['readToEarn'])
    assert.deepEqual(state.accounts[1].workerFailures, { readToEarn: 2 })
    assert.deepEqual(state.accounts[1].workerRetryAt, { readToEarn: 'keep' })
    assert.equal(state.accounts[1].platforms.desktop.remaining, 7)
    assert.deepEqual(state.sessions, [{ id: 'keep-session' }])
    state.accounts[1].workersCompleted.push('punchCards')
    assert.equal(migrateRewardsVerification(state), false)
    assert.ok(state.accounts[1].workersCompleted.includes('punchCards'))
})

function planningFixture(t, profile = {}, now = '2026-10-13T18:00:00Z') {
    const account = { index: 900001, email: 'rollover@example.test', proxy: null }
    const envKey = `ACCOUNT_${account.index}_EMAIL`
    const previousEmail = process.env[envKey]
    process.env[envKey] = account.email
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-midnight-'))
    fs.writeFileSync(
        path.join(projectRoot, 'config.json'),
        JSON.stringify({ workers: { doDailySet: true, doMobileSearch: true, doDesktopSearch: true } })
    )
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: new Date(now) })
    t.after(() => {
        if (previousEmail === undefined) delete process.env[envKey]
        else process.env[envKey] = previousEmail
        fs.rmSync(projectRoot, { recursive: true, force: true })
    })

    const scheduler = Object.create(SmartScheduler.prototype)
    scheduler.projectRoot = projectRoot
    scheduler.document = {
        config: validateSmartConfig(
            {
                enabled: true,
                normalPolicy: { enabled: false }, // Compatibility coverage; conservative tests below opt in.
                profiles: [
                    {
                        accountIndex: account.index,
                        timezone: 'Asia/Ho_Chi_Minh',
                        allowedWorkers: ['dailySet'],
                        ...profile
                    }
                ]
            },
            [account]
        ),
        state: { accounts: {}, sessions: [], updatedAt: null }
    }
    scheduler.running = new Map()
    scheduler.manualLocks = new Map()
    scheduler.queue = []
    scheduler.suspended = false
    scheduler._save = () => {}
    scheduler.emit = () => {}
    const started = []
    scheduler._start = job => {
        started.push(job)
        scheduler.running.set(job.id, { job, manager: {} })
    }
    return { scheduler, account, started }
}

test('default profiles restart daily work at local midnight without carrying yesterday cooldowns', t => {
    const { scheduler, account, started } = planningFixture(t, {}, '2026-10-13T16:59:59Z')
    const profile = scheduler.document.config.profiles[0]
    assert.deepEqual(profile.windows, [])
    const yesterday = scheduler._accountState(account, profile, new Date())
    yesterday.workersCompleted = ['dailySet']
    yesterday.workersFailed = ['morePromotions']
    yesterday.nextWorkerAt = '2026-10-14T18:00:00Z'
    for (const platform of Object.values(yesterday.platforms)) {
        platform.complete = true
        platform.cooldownUntil = '2026-10-14T18:00:00Z'
    }
    scheduler.replan()
    assert.equal(started.length, 0)

    t.mock.timers.tick(1000)
    scheduler.replan()
    assert.equal(started.length, 1)
    assert.equal(started[0].day, '2026-10-14')
    assert.equal(started[0].reason, 'ready')
    assert.equal(started[0].dueAt, '2026-10-13T17:00:00.000Z')
    const today = scheduler.document.state.accounts[account.index]
    assert.deepEqual(today.workersCompleted, [])
    assert.deepEqual(today.workersFailed, [])
    assert.equal(today.nextWorkerAt, null)
    assert.equal(today.platforms.mobile.cooldownUntil, null)
    assert.equal(today.platforms.desktop.complete, false)

    scheduler.running.clear()
    started.length = 0
    t.mock.timers.tick(60 * 60 * 1000)
    scheduler.replan()
    assert.equal(started.length, 1)
    assert.equal(started[0].reason, 'ready')
})

test('enabled scheduler starts the new day automatically on its next planning tick', t => {
    const { scheduler, account, started } = planningFixture(t, {}, '2026-10-13T16:59:59Z')
    const state = scheduler._accountState(account, scheduler.document.config.profiles[0], new Date())
    state.workersCompleted = ['dailySet']
    state.platforms.mobile.complete = true
    state.platforms.desktop.complete = true
    scheduler.replan()
    scheduler._arm()
    assert.equal(started.length, 0)

    t.mock.timers.tick(30_000)
    assert.equal(started.length, 1)
    assert.equal(started[0].day, '2026-10-14')
    assert.equal(started[0].reason, 'ready')
    assert.equal(started[0].dueAt, '2026-10-13T17:00:29.000Z')
})

for (const [label, profile] of [
    ['explicit run window', { windows: [{ start: '07:00', end: '23:00' }] }],
    ['quiet hours', { quietHours: [{ start: '00:00', end: '02:00' }] }]
]) {
    test(`${label} still blocks sessions at 01:00 local time`, t => {
        const { scheduler, started } = planningFixture(t, profile)
        scheduler.replan()
        assert.equal(started.length, 0)
        assert.equal(scheduler.queue[0].dueAt, null)
        assert.equal(scheduler.queue[0].reason, 'outside-run-window')
    })
}

test('new account enrollment without a template has no default run window', t => {
    const { scheduler, account } = planningFixture(t)
    scheduler.document.config.profiles = []
    scheduler._arm = () => {}
    scheduler.enrollAccounts([account.index])
    assert.deepEqual(scheduler.document.config.profiles[0].windows, [])
})

test('budget noise spans base minus/plus three and remains bounded', () => {
    const low = calculateSearchBudget({
        remainingPoints: 15,
        pointsPerQuery: 3,
        slots: 1,
        targetMin: 5,
        targetMax: 10,
        noise: 3,
        safetyCap: 20,
        rng: () => 0
    })
    const high = calculateSearchBudget({
        remainingPoints: 15,
        pointsPerQuery: 3,
        slots: 1,
        targetMin: 5,
        targetMax: 10,
        noise: 3,
        safetyCap: 20,
        rng: () => 0.999999
    })
    assert.deepEqual([low.baseBudget, low.actualBudget], [5, 2])
    assert.deepEqual([high.baseBudget, high.actualBudget], [5, 8])
    assert.equal(
        calculateSearchBudget({ remainingPoints: 1, targetMin: 1, targetMax: 1, noise: 3, safetyCap: 2, rng: () => 0 })
            .actualBudget,
        1
    )
    assert.equal(
        calculateSearchBudget({
            remainingPoints: 999,
            targetMin: 10,
            targetMax: 10,
            noise: 3,
            safetyCap: 11,
            rng: () => 1
        }).actualBudget,
        11
    )
})

test('confirmed zero quota completes the platform and is never planned again', () => {
    const result = normalizeSearchResult({ remaining: 0, quotaAvailable: true })
    assert.deepEqual(result, { quotaKnown: true, remaining: 0, complete: true, probeUsed: false })
    assert.equal(shouldPlanSearch({ ...result, failed: false }, result.probeUsed), false)
})

test('unavailable quota remains pending for bounded scheduler retries', () => {
    const result = normalizeSearchResult({ remaining: 0, quotaAvailable: false })
    assert.deepEqual(result, { quotaKnown: false, remaining: null, complete: false, probeUsed: true })
    assert.equal(shouldPlanSearch({ ...result, failed: false }, result.probeUsed), true)
    assert.equal(shouldPlanSearch({ quotaKnown: false, remaining: null, complete: false, failed: false }, false), true)
})

test('known positive quota remains eligible for another bounded search slice', () => {
    const result = normalizeSearchResult({ remaining: 21, quotaAvailable: true })
    assert.deepEqual(result, { quotaKnown: true, remaining: 21, complete: false, probeUsed: false })
    assert.equal(shouldPlanSearch({ ...result, failed: false }, result.probeUsed), true)
})

test('short compatible workers are grouped while dependencies and visual search stay safe', () => {
    assert.deepEqual(selectWorkerSession(['dailySet', 'activateSearchPerk', 'morePromotions', 'dailyCheckIn']), [
        'dailySet',
        'morePromotions'
    ])
    assert.deepEqual(
        selectWorkerSession(['activateSearchPerk', 'streakProtection', 'dailyCheckIn'], {
            dailySetCompleted: true
        }),
        ['activateSearchPerk', 'streakProtection']
    )
    assert.deepEqual(selectWorkerSession(['dailyCheckIn', 'readToEarn', 'appPromotions']), [
        'readToEarn',
        'dailyCheckIn'
    ])
    assert.deepEqual(
        selectWorkerSession(['activateSearchPerk', 'punchCards', 'readToEarn'], { dailySetCompleted: true }),
        ['readToEarn']
    )
    assert.deepEqual(selectWorkerSession(['appPromotions', 'punchCards']), ['appPromotions', 'punchCards'])
    assert.deepEqual(selectWorkerSession(['visualSearch', 'claimBonusPoints']), ['visualSearch'])
    assert.deepEqual(selectWorkerSession(['activateSearchPerk', 'dailyCheckIn']), ['dailyCheckIn'])
    assert.ok(
        [
            ['dailyCheckIn', 'readToEarn'],
            ['activateSearchPerk', 'streakProtection'],
            ['dailySet', 'morePromotions']
        ].every(workers => workers.length <= 2)
    )
})

test('Search Perk can run when Daily Set is not configured for the profile', () => {
    const profile = { allowedWorkers: ['activateSearchPerk'] }
    assert.equal(dailySetDependencySatisfied(profile, { doDailySet: false }, { workersCompleted: [] }), true)
    assert.deepEqual(selectWorkerSession(['activateSearchPerk'], { dailySetCompleted: true }), ['activateSearchPerk'])
})

test('network groups collapse direct and equal proxy egress, with override winning', () => {
    assert.equal(deriveNetworkGroup(accounts[0]), 'DIRECT')
    assert.equal(deriveNetworkGroup(accounts[1]), deriveNetworkGroup(accounts[2]))
    assert.equal(deriveNetworkGroup(accounts[1], { 2: 'office-nat' }), 'office-nat')
})

test('deadline catch-up never shortens a retry backoff', () => {
    const now = Date.parse('2026-09-25T22:00:00Z')
    const retryAt = '2026-09-25T23:29:00Z'
    assert.equal(
        calculateSearchDue({
            lastRunAt: '2026-09-25T21:59:00Z',
            cooldownUntil: retryAt,
            failures: 1,
            deadlineRisk: true,
            minCooldownMinutes: 45,
            now
        }),
        Date.parse(retryAt)
    )
})

test('wave selection never overlaps a network group and respects maxParallel', () => {
    const dueAt = new Date(0).toISOString()
    const jobs = [
        { id: 'a', networkGroup: 'DIRECT', dueAt },
        { id: 'b', networkGroup: 'DIRECT', dueAt },
        { id: 'c', networkGroup: 'proxy-1', dueAt },
        { id: 'd', networkGroup: 'proxy-2', dueAt }
    ]
    assert.deepEqual(
        selectRunnableJobs(jobs, { now: Date.now(), limit: 3 }).map(job => job.id),
        ['a', 'c', 'd']
    )
    assert.deepEqual(
        selectRunnableJobs(jobs, { now: Date.now(), limit: 3, busyGroups: new Set(['DIRECT']) }).map(job => job.id),
        ['c', 'd']
    )
})

test('wave selection never overlaps the same account after its network group changes', () => {
    const dueAt = new Date(0).toISOString()
    const jobs = [
        { id: 'mobile', accountIndex: 1, networkGroup: 'old-group', dueAt },
        { id: 'desktop', accountIndex: 1, networkGroup: 'new-group', dueAt },
        { id: 'other', accountIndex: 2, networkGroup: 'new-group', dueAt }
    ]
    assert.deepEqual(
        selectRunnableJobs(jobs, {
            now: Date.now(),
            limit: 2,
            busyGroups: new Set(['old-group']),
            busyAccounts: new Set([1])
        }).map(job => job.id),
        ['other']
    )
})

test('manual browser locks block both its account and network group', () => {
    const scheduler = Object.create(SmartScheduler.prototype)
    scheduler.suspended = false
    scheduler.document = {
        config: { enabled: true, maxParallel: 3 },
        state: { accounts: {}, sessions: [], updatedAt: null }
    }
    scheduler.running = new Map()
    scheduler.manualLocks = new Map([[1, 'DIRECT']])
    scheduler.queue = [
        { id: 'same-account', accountIndex: 1, networkGroup: 'proxy-new', dueAt: new Date(0).toISOString() },
        { id: 'same-network', accountIndex: 2, networkGroup: 'DIRECT', dueAt: new Date(0).toISOString() },
        { id: 'safe', accountIndex: 3, networkGroup: 'proxy-safe', dueAt: new Date(0).toISOString() }
    ]
    const started = []
    scheduler._start = job => started.push(job.id)
    scheduler.emit = () => {}

    scheduler._drain()
    assert.deepEqual(started, ['safe'])
})

test('smart config rejects more than two runtime workers only at plan level and validates profiles', () => {
    const config = validateSmartConfig(
        {
            enabled: true,
            profiles: [
                {
                    accountIndex: 1,
                    timezone: 'Asia/Ho_Chi_Minh',
                    windows: [{ start: '08:00', end: '22:00' }],
                    allowedWorkers: ['dailySet', 'visualSearch']
                }
            ]
        },
        accounts
    )
    assert.equal(config.enabled, true)
    assert.equal(config.profiles[0].deadline, '23:00')
    assert.throws(() => validateSmartConfig({ profiles: [{ accountIndex: 99 }] }, accounts), /not configured/)
    assert.throws(
        () => validateSmartConfig({ profiles: 'invalid' }, accounts),
        error => {
            assert.equal(error.code, 'BAD_REQUEST')
            return /profiles must be an array/.test(error.message)
        }
    )
})

test('client environment overrides cannot inject an execution plan', () => {
    const manager = new ProcessManager({ command: process.execPath, cwd: process.cwd() })
    assert.equal(manager._resolveEnv({ MRS_EXECUTION_PLAN: '{"type":"workers"}' }).MRS_EXECUTION_PLAN, undefined)
    assert.equal(manager._resolveEnv({ MRS_EXECUTION_PLAN: 'trusted' }, true).MRS_EXECUTION_PLAN, 'trusted')
})

test('a worker session only completes workers that emitted their completion event', () => {
    const scheduler = Object.create(SmartScheduler.prototype)
    scheduler.running = new Map()
    scheduler.document = {
        config: { cooldownMinutes: { min: 45 }, retry: { maxAttempts: 3, backoffMinutes: 15 } },
        state: {
            accounts: {
                1: {
                    workersCompleted: [],
                    workersFailed: [],
                    workerFailures: {},
                    platforms: {}
                }
            },
            sessions: []
        }
    }
    scheduler.suspended = false
    scheduler._save = () => {}
    scheduler.replan = () => {}
    scheduler.emit = () => {}
    const record = {
        job: { id: 'worker-1', accountIndex: 1, type: 'workers', workers: ['dailyCheckIn'], attempts: 0 },
        manager: { getStatus: () => ({ run: { accounts: [{ success: true }] } }) },
        startedAt: new Date().toISOString(),
        timeout: null,
        timedOut: false,
        workerResults: new Set()
    }
    scheduler._finish(record, { code: 0 })
    const state = scheduler.document.state.accounts[1]
    assert.deepEqual(state.workersCompleted, [])
    assert.equal(state.workerFailures.dailyCheckIn, 1)
})

test('unknown search quota stays pending and stops after the configured retry limit', () => {
    const scheduler = Object.create(SmartScheduler.prototype)
    scheduler.running = new Map()
    scheduler.document = {
        config: { cooldownMinutes: { min: 45, max: 45 }, retry: { maxAttempts: 1, backoffMinutes: 15 } },
        state: {
            accounts: {
                1: {
                    probeUsed: { mobile: false, desktop: false },
                    platforms: {
                        mobile: {
                            failures: 0,
                            failed: false,
                            complete: false,
                            quotaKnown: false,
                            remaining: null,
                            queries: 0,
                            ewmaPointsPerQuery: 3
                        }
                    }
                }
            },
            sessions: []
        }
    }
    scheduler.suspended = false
    scheduler._save = () => {}
    scheduler.replan = () => {}
    scheduler.emit = () => {}
    const finishUnknown = id =>
        scheduler._finish(
            {
                job: { id, accountIndex: 1, type: 'search', platform: 'mobile', attempts: 0 },
                manager: { getStatus: () => ({ run: { accounts: [{ success: true }] } }) },
                startedAt: new Date().toISOString(),
                timeout: null,
                timedOut: false,
                searchResult: { queries: 1, points: 0, remaining: 0, quotaAvailable: false }
            },
            { code: 0 }
        )

    finishUnknown('search-1')
    assert.equal(scheduler.document.state.accounts[1].platforms.mobile.failed, false)
    assert.equal(scheduler.document.state.accounts[1].platforms.mobile.complete, false)
    assert.equal(scheduler.document.state.sessions.at(-1).pending, true)
    assert.equal(scheduler.document.state.sessions.at(-1).success, null)
    finishUnknown('search-2')
    assert.equal(scheduler.document.state.accounts[1].platforms.mobile.failed, true)
    assert.equal(scheduler.document.state.accounts[1].platforms.mobile.complete, false)
})

test('known positive quota with no progress uses bounded retries', () => {
    const scheduler = Object.create(SmartScheduler.prototype)
    scheduler.running = new Map()
    scheduler.document = {
        config: { cooldownMinutes: { min: 45, max: 45 }, retry: { maxAttempts: 1, backoffMinutes: 15 } },
        state: {
            accounts: {
                1: {
                    day: '2026-09-25',
                    probeUsed: { mobile: false, desktop: false },
                    platforms: {
                        mobile: {
                            failures: 0,
                            failed: false,
                            complete: false,
                            quotaKnown: true,
                            remaining: 90,
                            queries: 0,
                            ewmaPointsPerQuery: 3
                        }
                    }
                }
            },
            sessions: []
        }
    }
    scheduler.suspended = false
    scheduler._save = () => {}
    scheduler.replan = () => {}
    scheduler.emit = () => {}
    const finish = id =>
        scheduler._finish(
            {
                job: { id, day: '2026-09-25', accountIndex: 1, type: 'search', platform: 'mobile', attempts: 0 },
                manager: { getStatus: () => ({ run: { accounts: [{ success: true }] } }) },
                startedAt: new Date().toISOString(),
                timeout: null,
                timedOut: false,
                searchResult: { queries: 3, points: 0, remaining: 90, quotaAvailable: true }
            },
            { code: 0 }
        )

    finish('stagnant-1')
    assert.equal(scheduler.document.state.accounts[1].platforms.mobile.failures, 1)
    assert.equal(scheduler.document.state.accounts[1].platforms.mobile.failed, false)
    finish('stagnant-2')
    assert.equal(scheduler.document.state.accounts[1].platforms.mobile.failed, true)
})

test('a session crossing local midnight cannot complete the new day', () => {
    const scheduler = Object.create(SmartScheduler.prototype)
    scheduler.running = new Map()
    scheduler.document = {
        config: { cooldownMinutes: { min: 45, max: 45 }, retry: { maxAttempts: 1, backoffMinutes: 15 } },
        state: {
            accounts: {
                1: {
                    day: '2026-09-26',
                    probeUsed: { mobile: false, desktop: false },
                    platforms: {
                        mobile: {
                            failures: 0,
                            failed: false,
                            complete: false,
                            quotaKnown: false,
                            remaining: null,
                            queries: 0,
                            ewmaPointsPerQuery: 3
                        }
                    }
                }
            },
            sessions: []
        }
    }
    scheduler.suspended = false
    scheduler._save = () => {}
    scheduler.replan = () => {}
    scheduler.emit = () => {}
    scheduler._finish(
        {
            job: {
                id: 'old-day',
                day: '2026-09-25',
                accountIndex: 1,
                type: 'search',
                platform: 'mobile',
                attempts: 0
            },
            manager: { getStatus: () => ({ run: { accounts: [{ success: true }] } }) },
            startedAt: '2026-09-25T23:59:00Z',
            timeout: null,
            timedOut: false,
            searchResult: { queries: 3, points: 9, remaining: 0, quotaAvailable: true }
        },
        { code: 0 }
    )
    const platform = scheduler.document.state.accounts[1].platforms.mobile
    assert.equal(platform.complete, false)
    assert.equal(platform.queries, 0)
    assert.equal(scheduler.document.state.sessions[0].staleDay, true)
})

test('fake child process reports a bounded smart search session through ProcessManager', async () => {
    const manager = new ProcessManager({ command: process.execPath, cwd: process.cwd(), stopTimeoutMs: 1000 })
    const lines = [
        '[9/23/2026, 8:00:00 AM] [main] [INFO] MAIN [RUN-START] Starting Microsoft Rewards Script | v4.3.2 | Accounts: 1 | Clusters: 1',
        '[9/23/2026, 8:00:00 AM] [main] [INFO] MAIN [SMART-SESSION] Session start | jobId=fake-1 | type=search | platform=mobile | budget=7',
        '[9/23/2026, 8:00:01 AM] [alpha] [INFO] MAIN [ACCOUNT-START] Starting account: alpha@example.test | geoLocale: US | locale: en-US',
        '[9/23/2026, 8:01:00 AM] [alpha] [INFO] MOBILE [SMART-SEARCH-END] platform=mobile | budget=7 | queries=5 | points=15 | remaining=0 | quotaAvailable=true',
        '[9/23/2026, 8:01:01 AM] [main] [INFO] MAIN [ACCOUNT-END] Completed account: alpha@example.test | pointsGained=15 | previousBalance=1000 | currentBalance=1015 | durationSeconds=61',
        '[9/23/2026, 8:01:01 AM] [main] [INFO] MAIN [SMART-SESSION] Session end | jobId=fake-1 | success=true | durationSeconds=61',
        '[9/23/2026, 8:01:01 AM] [main] [INFO] MAIN [RUN-END] Completed all accounts | accountsProcessed=1 | pointsGained=15 | previousBalance=1000 | currentBalance=1015 | runtimeMinutes=1.0'
    ]
    const exited = new Promise(resolve => manager.once('exit', resolve))
    manager.start({ args: ['-e', `process.stdout.write(${JSON.stringify(`${lines.join('\n')}\n`)})`] })
    const exit = await exited
    assert.equal(exit.code, 0)
    const status = manager.getStatus()
    assert.equal(status.run.smartSession.status, 'complete')
    assert.equal(status.run.accounts[0].smartSearch.queries, 5)
    assert.equal(status.run.accounts[0].smartSearch.remaining, 0)
})

test('urgent activation bypasses timing gates, restores retries and survives reload without changing regular config', t => {
    const { scheduler, account } = planningFixture(t, {
        windows: [{ start: '07:00', end: '08:00' }],
        quietHours: [{ start: '00:00', end: '06:00' }]
    })
    scheduler.suspended = true
    scheduler.document.config.enabled = false
    const normal = structuredClone(scheduler.document.config)
    const state = scheduler._accountState(account, normal.profiles[0], new Date())
    state.workersCompleted = ['dailySet']
    state.platforms.mobile.failed = true
    state.platforms.mobile.failures = 4
    state.platforms.mobile.queries = 7
    state.platforms.mobile.remaining = 90
    state.platforms.mobile.cooldownUntil = '2026-10-15T00:00:00Z'
    scheduler.setUrgent(true)
    assert.deepEqual(scheduler.document.config, normal)
    assert.equal(scheduler.get().effectiveEnabled, true)
    assert.equal(scheduler.queue.length, 2)
    assert.ok(scheduler.queue.every(job => job.urgent && job.searchBudget <= 5 && Date.parse(job.dueAt) === Date.now()))
    assert.equal(state.platforms.mobile.queries, 7)
    assert.equal(state.platforms.mobile.failed, false)
    state.platforms.mobile.failures = 2
    scheduler.setUrgent(true)
    assert.equal(state.platforms.mobile.failures, 2, 'repeated activation must not replenish retries')
    scheduler.configFile = path.join(scheduler.projectRoot, 'smart.json')
    fs.writeFileSync(scheduler.configFile, JSON.stringify(scheduler.document))
    scheduler.document = scheduler._load()
    assert.equal(scheduler.get().urgent.active, true)
    scheduler.setUrgent(false)
    assert.equal(scheduler.get().effectiveEnabled, false)
    assert.deepEqual(scheduler.document.config, normal)
})

test('urgent work ends at local midnight and never applies to the next day', t => {
    const { scheduler } = planningFixture(t, {}, '2026-10-13T16:59:59Z')
    scheduler.suspended = true
    scheduler.document.config.enabled = false
    scheduler.setUrgent(true)
    t.mock.timers.tick(2000)
    scheduler.replan()
    assert.equal(scheduler.get().urgent.active, false)
    assert.equal(scheduler.get().urgent.status, 'expired')
    assert.ok(scheduler.queue.every(job => !job.urgent))
})

test('urgent selection respects configured concurrency and keeps manual/account locks', t => {
    const { scheduler, started } = planningFixture(t)
    scheduler.document.state.urgentRun = { active: true, targets: {}, status: 'active' }
    scheduler.queue = Array.from({ length: 40 }, (_, index) => ({
        id: String(index),
        accountIndex: index + 1,
        networkGroup: `group-${index}`,
        urgent: true,
        dueAt: new Date().toISOString()
    }))
    scheduler.manualLocks.set(1, 'group-0')
    scheduler.manualLocks.set(2, 'other-group')
    scheduler._drain()
    assert.equal(started.length, 2)
    assert.ok(started.every(job => ![1, 2].includes(job.accountIndex)))
    assert.equal(new Set(started.map(job => job.networkGroup)).size, 2)
})

test('urgent batching preserves perk dependency, visual isolation and final claim ordering', () => {
    assert.deepEqual(
        selectUrgentWorkerSession(['dailySet', 'activateSearchPerk', 'morePromotions', 'punchCards', 'visualSearch']),
        ['dailySet', 'morePromotions', 'punchCards']
    )
    assert.deepEqual(
        selectUrgentWorkerSession(['activateSearchPerk', 'dailyCheckIn', 'readToEarn'], { dailySetCompleted: true }),
        ['activateSearchPerk', 'dailyCheckIn', 'readToEarn']
    )
    assert.deepEqual(selectUrgentWorkerSession(['claimBonusPoints'], { searchPending: true }), [])
    assert.deepEqual(selectUrgentWorkerSession(['visualSearch', 'claimBonusPoints']), ['visualSearch'])
})

test('urgent terminal errors are shown as incomplete rather than successful completion', t => {
    const { scheduler, account } = planningFixture(t)
    scheduler.suspended = true
    scheduler.setUrgent(true)
    const state = scheduler.document.state.accounts[String(account.index)]
    state.workersCompleted = ['dailySet']
    state.platforms.mobile.complete = true
    state.platforms.desktop.failed = true
    scheduler.replan()
    assert.equal(scheduler.get().urgent.status, 'incomplete')
    assert.deepEqual(scheduler.get().urgent.failed, [{ accountIndex: account.index, task: 'desktopSearch' }])
})

for (const urgent of [false, true]) {
    test(`${urgent ? 'urgent' : 'regular'} worker failures preserve Daily Set completion and unblock search`, t => {
        const { scheduler, account } = planningFixture(t, { allowedWorkers: ['dailySet', 'morePromotions'] })
        fs.writeFileSync(
            path.join(scheduler.projectRoot, 'config.json'),
            JSON.stringify({
                workers: { doDailySet: true, doMorePromotions: true, doMobileSearch: true, doDesktopSearch: true }
            })
        )
        scheduler.suspended = true
        if (urgent) scheduler.setUrgent(true)
        else scheduler.replan()
        const state = scheduler.document.state.accounts[String(account.index)]
        scheduler.suspended = false
        scheduler._drain = () => {}
        const job = {
            id: 'partial',
            day: state.day,
            accountIndex: account.index,
            urgent,
            type: 'workers',
            workers: ['dailySet', 'morePromotions'],
            attempts: 0
        }
        scheduler._finish(
            {
                job,
                manager: { getStatus: () => ({ run: { accounts: [{ success: false }] } }) },
                workerResults: new Set(['dailySet']),
                startedAt: new Date().toISOString(),
                timedOut: false
            },
            { code: 1 }
        )
        assert.ok(state.workersCompleted.includes('dailySet'))
        assert.equal(state.workerFailures.morePromotions, 1)
        assert.ok(!state.workersCompleted.includes('morePromotions'))
        assert.ok(scheduler.queue.some(job => job.type === 'search'))
        assert.ok(scheduler.queue.some(job => job.workers?.includes('morePromotions')))
    })
}

test('urgent unavailable quota retries immediately but still exhausts a finite allowance', t => {
    const { scheduler, account } = planningFixture(t)
    scheduler.suspended = true
    const state = scheduler._accountState(account, scheduler.document.config.profiles[0], new Date())
    state.workersCompleted = ['dailySet']
    scheduler.document.config.retry.maxAttempts = 1
    scheduler.setUrgent(true)
    scheduler.suspended = false
    scheduler._drain = () => {}
    const run = () => {
        const job = scheduler.queue.find(job => job.platform === 'mobile')
        scheduler._finish(
            {
                job,
                manager: { getStatus: () => ({ run: { accounts: [{ success: true }] } }) },
                workerResults: new Set(),
                searchResult: { platform: 'mobile', queries: 3, points: 0, remaining: 0, quotaAvailable: false },
                startedAt: new Date().toISOString()
            },
            { code: 0 }
        )
    }
    run()
    assert.equal(Date.parse(scheduler.queue.find(job => job.platform === 'mobile').dueAt), Date.now())
    assert.equal(state.platforms.mobile.complete, false)
    run()
    assert.equal(state.platforms.mobile.failed, true)
    assert.ok(!scheduler.queue.some(job => job.platform === 'mobile'))
    assert.ok(scheduler.get().urgent.failed.some(item => item.task === 'mobileSearch'))
})

test('promotion retry backoff leaves a fresh Search Perk runnable and preserves its own deadline', t => {
    const { scheduler, account } = planningFixture(t, {
        allowedWorkers: ['dailySet', 'morePromotions', 'activateSearchPerk']
    })
    fs.writeFileSync(
        path.join(scheduler.projectRoot, 'config.json'),
        JSON.stringify({
            workers: { doDailySet: true, doMorePromotions: true, doActivateSearchPerk: true, doDesktopSearch: true }
        })
    )
    scheduler.suspended = true
    scheduler.replan()
    scheduler._drain = () => {}
    const state = scheduler.document.state.accounts[String(account.index)]
    const finish = (workers, completed, attempts = 0) =>
        scheduler._finish(
            {
                job: {
                    id: workers.join('-'),
                    day: state.day,
                    accountIndex: account.index,
                    type: 'workers',
                    workers,
                    attempts
                },
                manager: { getStatus: () => ({ run: { accounts: [{ success: true }] } }) },
                workerResults: new Set(completed),
                startedAt: new Date().toISOString(),
                timedOut: false
            },
            { code: 0 }
        )
    finish(['dailySet', 'morePromotions'], ['dailySet'])
    const retryAt = state.workerRetryAt.morePromotions
    assert.ok(new Date(retryAt).getTime() > Date.now())
    let job = scheduler.queue.find(job => job.type === 'workers')
    assert.deepEqual(job.workers, ['activateSearchPerk'])
    assert.ok(new Date(job.dueAt).getTime() <= Date.now())
    finish(['activateSearchPerk'], ['activateSearchPerk'])
    assert.equal(state.workerRetryAt.morePromotions, retryAt)
    job = scheduler.queue.find(job => job.workers?.includes('morePromotions'))
    assert.ok(new Date(job.dueAt).getTime() >= new Date(retryAt).getTime())
    assert.ok(scheduler.queue.some(job => job.type === 'search'))
})

test('legacy account retry timestamps migrate only to failed workers', t => {
    const { scheduler, account } = planningFixture(t, { allowedWorkers: ['dailySet', 'morePromotions'] })
    const profile = scheduler.document.config.profiles[0]
    const state = scheduler._accountState(account, profile, new Date())
    delete state.workerRetryAt
    state.workerFailures = { morePromotions: 2, dailySet: 0 }
    const deadline = new Date(Date.now() + 30 * 60_000).toISOString()
    state.nextWorkerAt = deadline
    scheduler._accountState(account, profile, new Date())
    assert.deepEqual(state.workerRetryAt, { morePromotions: deadline })
    assert.equal(state.nextWorkerAt, null)
    scheduler._accountState(account, profile, new Date())
    assert.equal(state.workerRetryAt.morePromotions, deadline)
})

test('a fresh perk waiting on Daily Set cannot hide the queued Daily Set retry', t => {
    const { scheduler, account } = planningFixture(t, { allowedWorkers: ['dailySet', 'activateSearchPerk'] })
    fs.writeFileSync(
        path.join(scheduler.projectRoot, 'config.json'),
        JSON.stringify({
            workers: { doDailySet: true, doActivateSearchPerk: true, doDesktopSearch: true }
        })
    )
    scheduler.suspended = true
    const state = scheduler._accountState(account, scheduler.document.config.profiles[0], new Date())
    state.workerFailures.dailySet = 1
    state.workerRetryAt.dailySet = new Date(Date.now() + 10 * 60_000).toISOString()
    scheduler.replan()
    const job = scheduler.queue.find(job => job.type === 'workers')
    assert.deepEqual(job.workers, ['dailySet'])
    assert.equal(job.dueAt, state.workerRetryAt.dailySet)
    assert.ok(!scheduler.queue.some(job => job.type === 'search'))
})

test('completed Daily Set does not impose search cooldown on an unfinished Read to Earn worker', t => {
    const { scheduler, account } = planningFixture(t, { allowedWorkers: ['dailySet', 'readToEarn'] })
    fs.writeFileSync(
        path.join(scheduler.projectRoot, 'config.json'),
        JSON.stringify({ workers: { doDailySet: true, doReadToEarn: true, doDesktopSearch: true } })
    )
    scheduler.suspended = true
    scheduler.replan()
    const state = scheduler.document.state.accounts[String(account.index)]
    scheduler._drain = () => {}
    scheduler._finish(
        {
            job: {
                id: 'daily',
                day: state.day,
                accountIndex: account.index,
                type: 'workers',
                workers: ['dailySet'],
                attempts: 0
            },
            manager: { getStatus: () => ({ run: { accounts: [{ success: true }] } }) },
            workerResults: new Set(['dailySet']),
            startedAt: new Date().toISOString(),
            timedOut: false
        },
        { code: 0 }
    )
    const reading = scheduler.queue.find(job => job.workers?.includes('readToEarn'))
    assert.ok(reading)
    assert.ok(new Date(reading.dueAt).getTime() <= Date.now())
    assert.equal(state.nextWorkerAt, null)
})

test('ready daily work is scheduled ahead of overdue search sessions', t => {
    const { scheduler, account } = planningFixture(t, { allowedWorkers: ['readToEarn'] })
    fs.writeFileSync(
        path.join(scheduler.projectRoot, 'config.json'),
        JSON.stringify({ workers: { doReadToEarn: true, doDesktopSearch: true } })
    )
    scheduler.suspended = true
    const state = scheduler._accountState(account, scheduler.document.config.profiles[0], new Date())
    state.platforms.desktop.lastRunAt = new Date(Date.now() - 4 * 60 * 60_000).toISOString()
    state.platforms.desktop.quotaKnown = true
    state.platforms.desktop.remaining = 30
    scheduler.replan()
    assert.equal(scheduler.queue[0].type, 'workers')
    assert.deepEqual(scheduler.queue[0].workers, ['readToEarn'])
})

test('terminal accounts get bounded quota-only checks that respect run windows and locks', t => {
    const { scheduler, account } = planningFixture(t, { allowedWorkers: [] })
    scheduler.suspended = true
    const state = scheduler._accountState(account, scheduler.document.config.profiles[0], new Date())
    state.platforms.desktop.complete = true
    state.platforms.mobile.failed = true
    state.platforms.mobile.failures = 4
    scheduler.replan()
    assert.deepEqual(
        scheduler.queue.map(j => j.type),
        ['quota']
    )
    assert.equal(selectRunnableJobs(scheduler.queue, { busyAccounts: new Set([account.index]) }).length, 0)
    assert.equal(selectRunnableJobs(scheduler.queue, { busyGroups: new Set(['DIRECT']) }).length, 0)
    state.quotaCheckAttempts = 1
    state.quotaCheckAttemptedAt = new Date().toISOString()
    scheduler.replan()
    assert.equal(selectRunnableJobs(scheduler.queue).length, 0)
    assert.equal(Date.parse(scheduler.queue[0].dueAt), Date.now() + 2 * 60 * 60_000)
    state.quotaCheckAttempts = 3
    scheduler.replan()
    assert.deepEqual(scheduler.queue, [])
})

test('overdue quota checks are selected before another account starts a long search', t => {
    const { scheduler, account } = planningFixture(t, { allowedWorkers: [] })
    scheduler.suspended = true
    const second = account.index + 1,
        key = `ACCOUNT_${second}_EMAIL`,
        previous = process.env[key]
    process.env[key] = 'quota-check@example.test'
    t.after(() => {
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
    })
    scheduler.document.config.profiles.push({ ...scheduler.document.config.profiles[0], accountIndex: second })
    const terminal = scheduler._accountState(
        { index: second, email: process.env[key] },
        scheduler.document.config.profiles[1],
        new Date()
    )
    terminal.platforms.mobile.complete = true
    terminal.platforms.desktop.complete = true
    scheduler.replan()
    assert.equal(scheduler.queue[0].accountIndex, second)
    assert.equal(scheduler.queue[0].type, 'quota')
    assert.ok(scheduler.queue.some(job => job.accountIndex === account.index && job.type === 'search'))
})

for (const mode of ['fresh', 'unknown', 'old-day', 'login-error', 'bot-warning']) {
    test(`quota completion reconciles only trustworthy data: ${mode}`, t => {
        const { scheduler, account } = planningFixture(t, { allowedWorkers: [] }, '2026-10-25T07:30:00Z')
        scheduler.suspended = false
        scheduler.replan = () => {}
        scheduler.onLog = () => {}
        const state = scheduler._accountState(account, scheduler.document.config.profiles[0], new Date())
        state.workersCompleted = ['dailySet', 'readToEarn']
        state.platforms.desktop.complete = true
        Object.assign(state.platforms.mobile, { failed: true, failures: 4 })
        const record = {
            job: {
                id: 'quota',
                day: mode === 'old-day' ? '2026-10-24' : state.day,
                accountIndex: account.index,
                type: 'quota'
            },
            manager: { getStatus: () => ({ run: { accounts: [{ success: mode !== 'login-error' }] } }) },
            workerResults: new Set(),
            quotaBlocked: mode === 'bot-warning',
            quotaSnapshot:
                mode === 'unknown'
                    ? null
                    : {
                          readAt: new Date().toISOString(),
                          desktop: { max: 90, progress: 0 },
                          mobile: { max: 60, progress: 0 }
                      }
        }
        scheduler._finish(record, { code: mode === 'login-error' ? 1 : 0 })
        assert.equal(state.platforms.desktop.complete, mode !== 'fresh')
        assert.equal(state.platforms.mobile.failed, mode !== 'fresh')
        assert.deepEqual(state.workersCompleted, ['dailySet', 'readToEarn'])
    })
}

test('targeted retry clears selected failures and preserves completed work and unrelated jobs', async t => {
    const { scheduler, account } = planningFixture(t)
    const state = scheduler._accountState(account, scheduler.document.config.profiles[0], new Date())
    state.workersCompleted = ['readToEarn']
    state.workersFailed = ['dailySet']
    state.workerFailures = { dailySet: 4 }
    state.workerRetryAt = { dailySet: '2099-01-01T00:00:00Z' }
    state.platforms.desktop.failed = true
    state.platforms.desktop.failures = 4
    let stopped = false
    const unrelated = {
        job: { accountIndex: 42 },
        manager: {
            stop() {
                throw new Error('Unrelated job stopped')
            }
        }
    }
    scheduler.running = new Map([
        [
            'selected',
            {
                job: { accountIndex: account.index },
                manager: {
                    async stop() {
                        stopped = true
                    }
                }
            }
        ],
        ['other', unrelated]
    ])
    scheduler._save = () => {}
    scheduler.replan = ({ accountIndexes }) => assert.deepEqual(accountIndexes, [account.index])
    scheduler._drain = force => assert.equal(force, true)
    await scheduler.retryAccounts([account.index])
    assert.equal(stopped, true)
    assert.deepEqual(state.workersFailed, [])
    assert.deepEqual(state.workerFailures, {})
    assert.deepEqual(state.workersCompleted, ['readToEarn'])
    assert.equal(state.platforms.desktop.failed, false)
    assert.equal(scheduler.running.get('other'), unrelated)
    assert.equal(scheduler.suspended, false)
    let checkpointed = false
    unrelated.manager.stop = async options => {
        assert.equal(options.signal, 'SIGUSR1')
        checkpointed = true
    }
    await scheduler.retryAccounts([account.index], { preempt: true })
    assert.equal(checkpointed, true)
    await assert.rejects(scheduler.retryAccounts([0]), { code: 'BAD_REQUEST' })
})

test('manual Stop cooldown blocks Urgent and force drain, then resumes at the next eligible planning tick', t => {
    const { scheduler, account, started } = planningFixture(t)
    const profile = scheduler.document.config.profiles[0]
    const state = scheduler._accountState(account, profile, new Date())
    state.manualStopUntil = new Date(Date.now() + 60000).toISOString()
    scheduler.setUrgent(true)
    scheduler._drain(true)
    assert.equal(started.length, 0)
    assert.ok(scheduler.queue.every(job => job.reason === 'stopped-cooldown'))
    t.mock.timers.tick(60001)
    scheduler.replan()
    assert.ok(started.length > 0)
})

test('v2 upgrade reopens only Keep earning for an already verified v1 planner', () => {
    const state = {
        rewardsVerificationVersion: 1,
        accounts: {
            8: {
                workersCompleted: ['morePromotions', 'punchCards', 'dailySet'],
                workersFailed: [],
                workerFailures: { morePromotions: 2 },
                workerRetryAt: { morePromotions: 'old' },
                platforms: { desktop: { queries: 7 } }
            }
        }
    }
    assert.equal(migrateRewardsVerification(state), true)
    assert.deepEqual(state.accounts[8].workersCompleted, ['punchCards', 'dailySet'])
    assert.equal(state.accounts[8].platforms.desktop.queries, 7)
    assert.equal(migrateRewardsVerification(state), false)
})
test('Earn rechecks use two-hour cadence and reopen unfinished work without resetting searches', () => {
    const now = Date.parse('2026-11-02T12:00:00Z')
    const state = {
        workersCompleted: ['morePromotions', 'dailySet'],
        workersFailed: [],
        workerFailures: {},
        workerRetryAt: {},
        platforms: { desktop: { queries: 8 } }
    }
    assert.equal(earnRecheckDue(state, now), false)
    state.earnLastScannedAt = new Date(now - 2 * 60 * 60_000).toISOString()
    assert.equal(earnRecheckDue(state, now), true)
    applyEarnScan(state, { verified: false }, now)
    assert.deepEqual(state.workersCompleted, ['dailySet'])
    assert.equal(state.platforms.desktop.queries, 8)
    applyEarnScan(state, { verified: true }, now)
    assert.equal(earnRecheckDue(state, now + 60 * 60_000), false)
    assert.equal(earnRecheckDue(state, now + 2 * 60 * 60_000), true)
})
test('final Earn check is bounded once per day and respects quiet hours and opt-outs', t => {
    const { scheduler, account } = planningFixture(
        t,
        { allowedWorkers: ['morePromotions'], windows: [], quietHours: [], deadline: '23:00' },
        '2026-10-13T15:45:00Z'
    )
    fs.writeFileSync(
        path.join(scheduler.projectRoot, 'config.json'),
        JSON.stringify({ workers: { doMorePromotions: true } })
    )
    const state = scheduler._accountState(account, scheduler.document.config.profiles[0], new Date())
    scheduler.document.config.enabled = false
    state.workersCompleted = ['morePromotions']
    state.earnLastScannedAt = '2026-10-13T12:00:00Z'
    assert.equal(scheduler.replan().queue.filter(j => j.earnFinalCheck).length, 1)
    state.earnFinalCheckAt = new Date().toISOString()
    assert.equal(scheduler.replan().queue.filter(j => j.earnFinalCheck).length, 0)
    delete state.earnFinalCheckAt
    fs.writeFileSync(
        path.join(scheduler.projectRoot, 'config.json'),
        JSON.stringify({ workers: { doMorePromotions: false } })
    )
    assert.equal(scheduler.replan().queue.filter(j => j.earnFinalCheck).length, 0)
    fs.writeFileSync(
        path.join(scheduler.projectRoot, 'config.json'),
        JSON.stringify({ workers: { doMorePromotions: true } })
    )
    scheduler.document.config.profiles[0].quietHours = [{ start: '22:00', end: '23:59' }]
    assert.equal(scheduler.replan().queue.filter(j => j.earnFinalCheck).length, 0)
})

test('search rediscovery reuses its existing job and respects More Promotions profile permission', t => {
    const { scheduler, account } = planningFixture(t, { allowedWorkers: ['morePromotions'] })
    scheduler.document.config.enabled = false
    fs.writeFileSync(
        path.join(scheduler.projectRoot, 'config.json'),
        JSON.stringify({ workers: { doMorePromotions: true, doDesktopSearch: true } })
    )
    const state = scheduler._accountState(account, scheduler.document.config.profiles[0], new Date())
    state.workersCompleted = ['morePromotions']
    state.earnLastScannedAt = new Date(Date.now() - 3 * 60 * 60_000).toISOString()
    let queue = scheduler.replan().queue
    assert.equal(queue.filter(j => j.type === 'search' && j.recheckEarn).length, 1)
    assert.equal(queue.filter(j => j.type === 'workers').length, 0)
    scheduler.document.config.profiles[0].allowedWorkers = []
    queue = scheduler.replan().queue
    assert.equal(queue.filter(j => j.recheckEarn).length, 0)
})
for (const success of [true, false])
    test(`Earn completion requires a successful runtime and Smart worker marker: ${success}`, t => {
        const { scheduler, account } = planningFixture(t, { allowedWorkers: ['morePromotions'] })
        scheduler.suspended = true
        scheduler._drain = () => {}
        fs.writeFileSync(
            path.join(scheduler.projectRoot, 'config.json'),
            JSON.stringify({ workers: { doMorePromotions: true } })
        )
        const state = scheduler._accountState(account, scheduler.document.config.profiles[0], new Date())
        state.workersCompleted = ['morePromotions']
        scheduler._finish(
            {
                job: {
                    id: 'earn',
                    day: state.day,
                    accountIndex: account.index,
                    type: 'workers',
                    workers: ['morePromotions']
                },
                manager: { getStatus: () => ({ run: { accounts: [{ success }] } }) },
                workerResults: new Set(success ? ['morePromotions'] : []),
                earnScan: { verified: true },
                startedAt: new Date().toISOString()
            },
            { code: success ? 0 : 1 }
        )
        assert.equal(state.workersCompleted.includes('morePromotions'), success)
        assert.equal(state.earnScanVerified, success)
    })

test('warmup stops at reserved daily query cap without claiming unconfirmed queries completed', t => {
    const { scheduler, account } = planningFixture(t)
    scheduler._drain = () => {}
    const flag = `ACCOUNT_${account.index}_NEW_ACCOUNT_MODE`
    process.env[flag] = 'true'
    t.after(() => {
        delete process.env[flag]
    })
    account.newAccountMode = true
    scheduler.replan()
    const state = scheduler.document.state.accounts[account.index]
    state.newAccount.services = ['onedrive', 'todo', 'outlook', 'calendar']
    state.newAccount.serviceActions = [...state.newAccount.services]
    state.platforms.mobile.queries = 18
    state.platforms.desktop.queries = 30
    state.warmupReservations = { baseline: { mobile: 20, desktop: 30 }, entries: {} }
    scheduler.replan()
    assert.equal(scheduler.queue.length, 0)
    assert.equal(state.platforms.mobile.queries, 18)
    assert.deepEqual(state.newAccount.queryCapsReached, ['mobile'])
    state.warmupReservations.baseline.mobile = 19
    scheduler.replan()
    assert.equal(scheduler.queue.find(j => j.platform === 'mobile').searchBudget, 1)
    scheduler.learning = { queryUsage: (_index, _day, platform) => (platform === 'mobile' ? 20 : 30) }
    scheduler.replan()
    assert.equal(scheduler.queue.find(j => j.platform === 'mobile').searchBudget, 1)
    scheduler.learning = null
    t.mock.timers.tick(24 * 3600000)
    scheduler.replan()
    assert.ok(scheduler.queue.some(j => j.platform === 'mobile' && j.searchBudget > 0))
})

// Conservative sessions: compatibility fixtures above deliberately disable the new policy.
test('conservative sessions group compatible tasks, never create periodic checks, and keep unknown quota pending', t => {
    const { scheduler, account } = planningFixture(t, {
        allowedWorkers: ['dailySet', 'activateSearchPerk', 'morePromotions', 'punchCards', 'readToEarn']
    })
    scheduler._drain = () => {}
    scheduler.document.config.normalPolicy.enabled = true
    fs.writeFileSync(
        path.join(scheduler.projectRoot, 'config.json'),
        JSON.stringify({
            workers: {
                doDailySet: true,
                doActivateSearchPerk: true,
                doMorePromotions: true,
                doPunchCards: true,
                doReadToEarn: true,
                doMobileSearch: true,
                doDesktopSearch: true
            }
        })
    )
    scheduler.replan()
    assert.equal(scheduler.queue.length, 1)
    assert.equal(scheduler.queue[0].type, 'accountSession')
    assert.deepEqual(scheduler.queue[0].workers, ['dailySet', 'activateSearchPerk', 'morePromotions', 'punchCards'])
    assert.equal(scheduler.queue[0].platform, 'desktop')
    assert.equal(scheduler.queue[0].searchBudget, 5)
    const state = scheduler.document.state.accounts[account.index]
    state.workersCompleted = [...scheduler.document.config.profiles[0].allowedWorkers]
    state.platforms.desktop.complete = true
    state.platforms.mobile.complete = true
    state.earnLastScannedAt = new Date(Date.now() - 3 * 3600000).toISOString()
    scheduler.replan()
    assert.deepEqual(scheduler.queue, [])
    state.platforms.mobile.complete = false
    state.platforms.mobile.quotaKnown = false
    scheduler.replan()
    assert.equal(scheduler.queue[0].platform, 'mobile')
    assert.equal(state.platforms.mobile.remaining, null)
})

test('conservative rolling budget and rest survive midnight, retry, Urgent, reload and handoff', async t => {
    const { scheduler, account } = planningFixture(t, {}, '2026-10-13T16:50:00Z')
    scheduler._drain = () => {}
    scheduler.document.config.normalPolicy.enabled = true
    scheduler.replan()
    const state = scheduler.document.state.accounts[account.index],
        now = Date.now()
    state.protection.sessions = Array.from({ length: 4 }, (_, n) => ({
        id: String(n),
        startedAt: new Date(now - (12 - n * 2) * 3600000).toISOString(),
        endedAt: new Date(now - (11.5 - n * 2) * 3600000).toISOString(),
        queries: []
    }))
    scheduler.replan()
    assert.equal(scheduler.queue[0].reason, 'SESSION_LIMIT')
    const dueAt = scheduler.queue[0].dueAt
    await scheduler.retryAccounts([account.index], { runOnce: true })
    assert.equal(scheduler.queue[0].reason, 'SESSION_LIMIT')
    scheduler.setUrgent(true)
    assert.equal(scheduler.queue[0].dueAt, dueAt)
    assert.equal(state.protection.sessions.length, 4)
    scheduler.configFile = path.join(scheduler.projectRoot, 'smart.json')
    fs.writeFileSync(scheduler.configFile, JSON.stringify(scheduler.document))
    scheduler.document = scheduler._load()
    t.mock.timers.tick(20 * 60000)
    scheduler.replan()
    const tomorrow = scheduler.document.state.accounts[account.index]
    assert.notEqual(tomorrow.day, state.day)
    assert.equal(tomorrow.protection.sessions.length, 4)
    assert.equal(scheduler.queue[0].reason, 'SESSION_LIMIT')
    // The handoff planner is transferred unchanged to the destination.
    const transferred = JSON.parse(JSON.stringify(tomorrow))
    assert.deepEqual(transferred.protection, tomorrow.protection)
})

test('account-wide failures hold after two sessions and a failed recovery cannot cycle tasks', async t => {
    const { scheduler, account } = planningFixture(t)
    scheduler._drain = () => {}
    scheduler.document.config.normalPolicy.enabled = true
    scheduler.replan()
    const { recordSessionOutcome, sessionEligibility } = await import('./normalPolicy.js')
    const state = scheduler.document.state.accounts[account.index],
        policy = scheduler.document.config.normalPolicy
    for (let n = 0; n < 2; n++) {
        state.protection.sessions.push({
            id: String(n),
            startedAt: new Date().toISOString(),
            endedAt: null,
            queries: []
        })
        recordSessionOutcome(state, String(n), 'authentication')
        t.mock.timers.tick(90 * 60000)
    }
    assert.equal(sessionEligibility(state, policy).blockedReason, 'ACCOUNT_HOLD')
    scheduler.setUrgent(true)
    await scheduler.retryAccounts([account.index], { runOnce: true })
    assert.equal(sessionEligibility(state, policy).blockedReason, 'ACCOUNT_HOLD')
    t.mock.timers.tick(24 * 3600000)
    assert.equal(sessionEligibility(state, policy).recovery, 'recovery-session')
    assert.equal(sessionEligibility(state, policy).blockedReason, null)
    state.protection.sessions.push({ id: 'recovery', startedAt: new Date().toISOString(), endedAt: null, queries: [] })
    assert.equal(sessionEligibility(state, policy).blockedReason, 'SESSION_UNCERTAIN')
    recordSessionOutcome(state, 'recovery', 'authentication')
    assert.equal(sessionEligibility(state, policy).blockedReason, 'ACCOUNT_HOLD')
    state.protection.sessions.push({ id: 'challenge', startedAt: new Date().toISOString(), endedAt: null, queries: [] })
    recordSessionOutcome(state, 'challenge', 'verification')
    t.mock.timers.tick(48 * 3600000)
    assert.equal(sessionEligibility(state, policy).blockedReason, 'VERIFICATION_REQUIRED')
    assert.throws(() => scheduler.releaseProtection(account.index, {}), { code: 'ACKNOWLEDGEMENT_REQUIRED' })
    scheduler.releaseProtection(account.index, { acknowledge: true })
    assert.equal(state.protection.hold, null)
})

test('conservative process reservation precedes spawn, uncertain query is retained, and forced drain cannot bypass rest', t => {
    const { scheduler, account } = planningFixture(t)
    scheduler._drain = () => {}
    scheduler.document.config.normalPolicy.enabled = true
    scheduler.replan()
    const state = scheduler.document.state.accounts[account.index]
    scheduler.configFile = path.join(scheduler.projectRoot, 'smart.json')
    scheduler.command = process.execPath
    scheduler.args = []
    scheduler.running = new Map()
    scheduler.onLog = () => {}
    scheduler._save = SmartScheduler.prototype._save
    const original = ProcessManager.prototype.start
    t.after(() => {
        ProcessManager.prototype.start = original
    })
    ProcessManager.prototype.start = function ({ env }) {
        const saved = JSON.parse(fs.readFileSync(scheduler.configFile, 'utf8'))
        assert.equal(saved.state.accounts[account.index].protection.sessions.length, 1)
        const plan = JSON.parse(env.MRS_EXECUTION_PLAN)
        assert.equal(plan.type, 'accountSession')
        assert.ok(plan.searchBudget <= 5)
        fs.appendFileSync(
            env.MRS_NORMAL_QUERY_JOURNAL,
            JSON.stringify({ at: new Date().toISOString(), platform: 'desktop', query: 1 }) + '\n'
        )
        this.pid = 123456789
        return { pid: this.pid }
    }
    SmartScheduler.prototype._start.call(scheduler, scheduler.queue[0])
    const record = [...scheduler.running.values()][0]
    scheduler._finish(record, { code: 1 })
    assert.equal(state.protection.sessions.length, 1)
    assert.equal(state.protection.sessions[0].queries.length, 1)
    assert.equal(state.workersCompleted.length, 0)
    assert.equal(state.platforms.desktop.remaining, null)
    assert.equal(scheduler.queue[0].reason, 'SESSION_REST')
    const started = []
    scheduler._start = job => started.push(job)
    SmartScheduler.prototype._drain.call(scheduler, true)
    assert.deepEqual(started, [])
    assert.equal(Date.parse(scheduler.queue[0].dueAt), Date.now() + 90 * 60000)
})

test('confirmed spawn failure refunds; missing ACK and no pid keep the reservation', t => {
    const { scheduler, account } = planningFixture(t)
    scheduler._drain = () => {}
    scheduler.document.config.normalPolicy.enabled = true
    scheduler.replan()
    scheduler.configFile = path.join(scheduler.projectRoot, 'smart.json')
    scheduler.command = process.execPath
    scheduler.args = []
    scheduler.onLog = () => {}
    const original = ProcessManager.prototype.start
    t.after(() => {
        ProcessManager.prototype.start = original
    })
    ProcessManager.prototype.start = function () {
        throw new Error('synchronous spawn failure')
    }
    SmartScheduler.prototype._start.call(scheduler, scheduler.queue[0])
    const state = scheduler.document.state.accounts[account.index]
    assert.equal(state.protection.sessions[0].refunded, true)
    state.protection.sessions.push({
        id: 'unknown-spawn',
        startedAt: new Date().toISOString(),
        endedAt: null,
        queries: []
    })
    scheduler.replan()
    assert.equal(scheduler.queue[0].reason, 'SESSION_UNCERTAIN')
    scheduler.setUrgent(true)
    assert.equal(scheduler.queue[0].dueAt, null)
    assert.throws(() => scheduler.releaseProtection(account.index, { acknowledge: true }), {
        code: 'SESSION_UNCERTAIN'
    })
    scheduler.releaseProtection(account.index, { acknowledge: true, confirmedStopped: true })
    assert.equal(scheduler.queue[0].reason, 'SESSION_REST')
    assert.equal(state.protection.sessions.length, 2)
})

test('normalPolicy accepts 50 sessions and rejects values above configured bounds', () => {
    assert.equal(validateSmartConfig({ normalPolicy: { maxSessions: 50 } }, accounts).normalPolicy.maxSessions, 50)
    for (const patch of [
        { maxSessions: 51 },
        { restMinutes: 89 },
        { maxQueries: 6 },
        { windowHours: 23 },
        { maxTasks: 5 }
    ])
        assert.throws(() => validateSmartConfig({ normalPolicy: patch }, accounts), { code: 'BAD_REQUEST' })
})

test('corrupt or missing Smart history cannot silently replenish existing normal query journals', t => {
    const { scheduler } = planningFixture(t)
    scheduler.configFile = path.join(scheduler.projectRoot, 'smart.json')
    fs.writeFileSync(scheduler.configFile, '{invalid')
    assert.throws(() => scheduler._load(), { code: 'SMART_STATE_UNREADABLE' })
    fs.unlinkSync(scheduler.configFile)
    fs.mkdirSync(path.join(scheduler.projectRoot, 'normal-query-journal'))
    fs.writeFileSync(path.join(scheduler.projectRoot, 'normal-query-journal', 'known-session.jsonl'), '{}\n')
    assert.throws(() => scheduler._load(), { code: 'SMART_STATE_UNREADABLE' })
})

test('conservative Earn rediscovery shares a useful desktop session and never opens a standalone check', t => {
    const { scheduler, account } = planningFixture(t, { allowedWorkers: ['morePromotions'] })
    scheduler._drain = () => {}
    scheduler.document.config.normalPolicy.enabled = true
    fs.writeFileSync(
        path.join(scheduler.projectRoot, 'config.json'),
        JSON.stringify({ workers: { doMorePromotions: true, doDesktopSearch: true } })
    )
    scheduler.replan()
    const state = scheduler.document.state.accounts[account.index]
    state.workersCompleted = ['morePromotions']
    state.earnLastScannedAt = new Date(Date.now() - 3 * 3600000).toISOString()
    scheduler.replan()
    assert.equal(scheduler.queue.length, 1)
    assert.equal(scheduler.queue[0].type, 'accountSession')
    assert.deepEqual(scheduler.queue[0].workers, ['morePromotions'])
    state.platforms.desktop.complete = true
    scheduler.replan()
    assert.equal(scheduler.queue.length, 0)
})

test('explicit app authorization blocks all shared app tasks while ordinary browser work stays schedulable', t => {
    const { scheduler, account } = planningFixture(t, {
        allowedWorkers: ['dailySet', 'readToEarn', 'dailyCheckIn', 'appPromotions']
    })
    scheduler.suspended = true
    scheduler.replan()
    scheduler._drain = () => {}
    scheduler.suspended = false
    const state = scheduler.document.state.accounts[String(account.index)]
    const day = state.day
    scheduler._finish(
        {
            job: { id: 'app-auth', day, accountIndex: account.index, type: 'workers', workers: ['readToEarn'] },
            manager: { getStatus: () => ({ run: { accounts: [{ success: true }] } }) },
            workerResults: new Set(),
            startedAt: new Date().toISOString(),
            appAuthorization: { required: true, reason: 'email-code-required' }
        },
        { code: 0 }
    )
    assert.equal(state.appAuthorization.reason, 'email-code-required')
    assert.deepEqual(state.workersFailed.sort(), ['appPromotions', 'dailyCheckIn', 'readToEarn'])
    assert.ok(!state.workersCompleted.includes('readToEarn'))
    assert.ok(scheduler.queue.some(job => job.workers?.includes('dailySet')))
    assert.ok(
        !scheduler.queue.some(job =>
            job.workers?.some(w => ['readToEarn', 'dailyCheckIn', 'appPromotions'].includes(w))
        )
    )
})

test('search72h plans only Bing, starts on verified checkpoint and expires exactly after 72 hours across rollover', t => {
    const { scheduler, account } = planningFixture(t)
    scheduler._drain = () => {}
    const prefix = `ACCOUNT_${account.index}_`
    process.env[prefix + 'NEW_ACCOUNT_MODE'] = 'true'
    process.env[prefix + 'NEW_ACCOUNT_POLICY'] = 'search72h'
    t.after(() => {
        delete process.env[prefix + 'NEW_ACCOUNT_MODE']
        delete process.env[prefix + 'NEW_ACCOUNT_POLICY']
    })
    scheduler.replan()
    assert.equal(scheduler.queue.length, 2)
    assert.ok(
        scheduler.queue.every(
            j =>
                j.type === 'warmup' &&
                j.newAccountPolicy === 'search72h' &&
                j.services.length === 0 &&
                j.searchBudget <= 5
        )
    )
    const state = scheduler.document.state.accounts[account.index]
    assert.equal(state.newAccount.startedAt, undefined)
    const job = scheduler.queue.find(j => j.platform === 'desktop')
    const record = { job }
    const checkpoint = queries => ({
        message: JSON.stringify({ jobId: job.id, queries, services: [], at: new Date().toISOString() })
    })
    scheduler._newAccountCheckpoint(record, checkpoint(0))
    assert.equal(state.newAccount.startedAt, undefined)
    scheduler._newAccountCheckpoint(record, checkpoint(1))
    scheduler._newAccountCheckpoint(record, checkpoint(1))
    assert.equal(state.platforms.desktop.queries, 1)
    const readyAt = state.newAccount.readyAt
    assert.equal(Date.parse(readyAt) - Date.parse(state.newAccount.startedAt), 72 * 3600000)
    t.mock.timers.tick(24 * 3600000)
    scheduler.replan()
    const nextDay = scheduler.document.state.accounts[account.index]
    assert.equal(nextDay.newAccount.readyAt, readyAt)
    assert.equal(nextDay.newAccount.policy, 'search72h')
    assert.equal(nextDay.platforms.desktop.queries, 0)
    assert.ok(scheduler.queue.every(j => j.services.length === 0))
    nextDay.platforms.desktop.queries = 30
    nextDay.platforms.mobile.queries = 20
    scheduler.replan()
    assert.equal(scheduler.queue.length, 0)
    t.mock.timers.tick(48 * 3600000 - 1)
    scheduler.replan()
    assert.ok(scheduler.queue.every(j => j.type === 'warmup'))
    t.mock.timers.tick(1)
    scheduler.replan()
    assert.ok(scheduler.queue.length > 0)
    assert.ok(scheduler.queue.every(j => j.type !== 'warmup'))
})

test('search72h exhausted uncertain reservations cannot be replenished by service-only planning', t => {
    const { scheduler, account } = planningFixture(t)
    scheduler._drain = () => {}
    const prefix = `ACCOUNT_${account.index}_`
    process.env[prefix + 'NEW_ACCOUNT_MODE'] = 'true'
    process.env[prefix + 'NEW_ACCOUNT_POLICY'] = 'search72h'
    t.after(() => {
        delete process.env[prefix + 'NEW_ACCOUNT_MODE']
        delete process.env[prefix + 'NEW_ACCOUNT_POLICY']
    })
    scheduler.replan()
    const state = scheduler.document.state.accounts[account.index]
    state.warmupReservations = {
        baseline: { desktop: 0, mobile: 0 },
        entries: {
            uncertainDesktop: { platform: 'desktop', budget: 30 },
            uncertainMobile: { platform: 'mobile', budget: 20 }
        }
    }
    scheduler.replan()
    assert.deepEqual(state.newAccount.queryCapsReached.sort(), ['desktop', 'mobile'])
    assert.equal(state.platforms.desktop.queries, 0)
    assert.equal(state.newAccount.startedAt, undefined)
    assert.equal(scheduler.queue.length, 0)
})

test('daily search limits stop normal searches but leave Daily Set schedulable, including Urgent', t => {
    const { scheduler, account } = planningFixture(t)
    scheduler._drain = () => {}
    scheduler.document.config.normalPolicy.enabled = true
    scheduler.document.config.dailySearchLimits = { mobile: { min: 4, max: 8 }, desktop: { min: 8, max: 10 } }
    scheduler.replan()
    const state = scheduler.document.state.accounts[account.index]
    assert.ok(state.dailySearch.targets.mobile >= 4 && state.dailySearch.targets.mobile <= 8)
    assert.ok(state.dailySearch.targets.desktop >= 8 && state.dailySearch.targets.desktop <= 10)
    const targets = structuredClone(state.dailySearch.targets)
    state.dailySearch.baseline = { ...targets }
    scheduler.replan()
    assert.deepEqual(state.dailySearch.targets, targets)
    assert.equal(scheduler.queue.length, 1)
    assert.ok(scheduler.queue[0].workers.includes('dailySet'))
    assert.equal(scheduler.queue[0].normalSearchBudget, 0)
    scheduler.setUrgent(true)
    assert.equal(scheduler.queue[0].normalSearchBudget, 0)
    state.workersCompleted = ['dailySet']
    scheduler.replan()
    assert.equal(scheduler.queue.length, 0)
})

test('daily limits apply to warmup without changing services or the eligibility clock', t => {
    const { scheduler, account } = planningFixture(t)
    scheduler._drain = () => {}
    const flag = `ACCOUNT_${account.index}_NEW_ACCOUNT_MODE`
    process.env[flag] = 'true'
    t.after(() => {
        delete process.env[flag]
    })
    account.newAccountMode = true
    scheduler.document.config.dailySearchLimits = { mobile: { min: 4, max: 4 }, desktop: { min: 8, max: 8 } }
    scheduler.replan()
    const state = scheduler.document.state.accounts[account.index]
    assert.equal(scheduler.queue.find(j => j.platform === 'mobile').searchBudget, 4)
    assert.equal(scheduler.queue.find(j => j.platform === 'desktop').searchBudget, 5)
    state.newAccount.startedAt = new Date().toISOString()
    state.newAccount.readyAt = new Date(Date.now() + 168 * 3600000).toISOString()
    const readyAt = state.newAccount.readyAt
    state.dailySearch.baseline = { mobile: 4, desktop: 8 }
    state.newAccount.services = ['onedrive', 'todo', 'outlook', 'calendar']
    state.newAccount.serviceActions = [...state.newAccount.services]
    scheduler.replan()
    assert.equal(scheduler.queue.length, 0)
    assert.equal(state.newAccount.readyAt, readyAt)
})

test('persistent desktop quests cannot starve mobile searches; daily caps and task completion stay separate', t => {
    const { scheduler, account } = planningFixture(t, { allowedWorkers: ['dailySet', 'morePromotions'] })
    scheduler._drain = () => {}
    fs.writeFileSync(
        path.join(scheduler.projectRoot, 'config.json'),
        JSON.stringify({
            workers: { doDailySet: true, doMorePromotions: true, doDesktopSearch: true, doMobileSearch: true }
        })
    )
    scheduler.document.config.normalPolicy.enabled = true
    scheduler.document.config.dailySearchLimits = { mobile: { min: 5, max: 15 }, desktop: { min: 10, max: 20 } }
    scheduler.replan()
    const state = scheduler.document.state.accounts[account.index]
    state.workersCompleted = ['dailySet']
    state.platforms.mobile.queries = 1
    Object.assign(state.platforms.mobile, { quotaKnown: true, remaining: 57 })
    Object.assign(state.platforms.desktop, { quotaKnown: true, remaining: 30 })
    state.protection.lastServed = {
        mobile: new Date(Date.now() - 5 * 3600000).toISOString(),
        desktop: new Date(Date.now() - 2 * 3600000).toISOString()
    }
    scheduler.replan()
    assert.equal(scheduler.queue[0].platform, 'mobile')
    assert.equal(scheduler.queue[0].normalSearchBudget, 5)
    assert.deepEqual(scheduler.queue[0].workers, [])
    assert.deepEqual(state.workersCompleted, ['dailySet'])
    assert.ok(state.pendingWorkers.includes('morePromotions'))
    state.protection.lastServed.mobile = new Date().toISOString()
    scheduler.replan()
    assert.equal(scheduler.queue[0].platform, 'desktop')
    assert.ok(scheduler.queue[0].workers.includes('morePromotions'))
    state.protection.lastServed.desktop = new Date(Date.now() + 1000).toISOString()
    state.dailySearch.baseline.mobile = state.dailySearch.targets.mobile
    scheduler.replan()
    assert.equal(scheduler.queue[0].platform, 'desktop')
    assert.ok(scheduler.queue[0].workers.includes('morePromotions'))
})

test('Daily Set remains first and an unserved mobile quota is not permanently outranked by a known desktop quota', t => {
    const { scheduler, account } = planningFixture(t)
    scheduler._drain = () => {}
    scheduler.document.config.normalPolicy.enabled = true
    scheduler.replan()
    const state = scheduler.document.state.accounts[account.index]
    Object.assign(state.platforms.desktop, { quotaKnown: true, remaining: 30 })
    state.protection.lastServed = { desktop: new Date().toISOString() }
    scheduler.replan()
    assert.equal(scheduler.queue[0].platform, 'desktop')
    assert.ok(scheduler.queue[0].workers.includes('dailySet'))
    state.workersCompleted = ['dailySet']
    scheduler.replan()
    assert.equal(scheduler.queue[0].platform, 'mobile')
    assert.equal(scheduler.queue[0].normalSearchBudget, 5)
})

test('Request run skips rest and stop cooldown while paused without enabling recurring work', async t => {
    const { scheduler, account, started } = planningFixture(t)
    scheduler.document.config.normalPolicy.enabled = true
    scheduler.document.config.enabled = false
    scheduler.replan()
    const state = scheduler.document.state.accounts[account.index]
    const endedAt = new Date(Date.now() - 10 * 60000).toISOString()
    state.protection.sessions = [{ id: 'previous', startedAt: endedAt, endedAt, queries: [] }]
    state.manualStopUntil = new Date(Date.now() + 30 * 60000).toISOString()
    await scheduler.retryAccounts([account.index], { runOnce: true })
    assert.equal(started.length, 1)
    assert.equal(scheduler.document.config.enabled, false)
    assert.equal(state.manualStopUntil, undefined)
    assert.equal(state.protection.sessions.length, 1)
    // The real launcher consumes this durable request before spawning the child.
    scheduler.document.state.onceAccounts = []
    assert.equal(scheduler._eligibilityForDispatch(account.index, state).blockedReason, 'SESSION_REST')
})

test('Request run waits for a busy network and keeps its rest bypass through a state round trip', async t => {
    const { scheduler, account, started } = planningFixture(t)
    scheduler.document.config.normalPolicy.enabled = true
    scheduler.replan()
    scheduler.running.clear()
    started.length = 0
    const state = scheduler.document.state.accounts[account.index]
    const endedAt = new Date(Date.now() - 10 * 60000).toISOString()
    state.protection.sessions = [{ id: 'previous', startedAt: endedAt, endedAt, queries: [] }]
    scheduler.manualLocks.set(
        account.index + 1,
        deriveNetworkGroup(account, scheduler.document.config.networkGroupOverride)
    )
    await scheduler.retryAccounts([account.index], { runOnce: true })
    assert.equal(started.length, 0)
    scheduler.document = JSON.parse(JSON.stringify(scheduler.document))
    scheduler.manualLocks.clear()
    scheduler.replan()
    assert.equal(started.length, 1)
    assert.equal(scheduler.document.state.accounts[account.index].protection.sessions.length, 1)
})

test('manual Run next skips rest once without refunding history or leaving a future override', t => {
    const { scheduler, account, started } = planningFixture(t)
    scheduler.document.config.normalPolicy.enabled = true
    scheduler.document.config.maxParallel = 1
    scheduler.replan()
    scheduler.running.clear()
    started.length = 0
    const state = scheduler.document.state.accounts[account.index]
    const endedAt = new Date(Date.now() - 10 * 60000).toISOString()
    state.protection.sessions = [{ id: 'existing', startedAt: endedAt, endedAt, platform: 'desktop', queries: [] }]
    scheduler.replan()
    assert.equal(started.length, 0)
    scheduler.trigger(null, { force: true })
    assert.equal(started.length, 1)
    assert.equal(state.protection.sessions.length, 1)
    assert.equal(state.protection.sessions[0].endedAt, endedAt)
    assert.equal(scheduler.runNextRestOverrides.size, 0)
    scheduler.running.clear()
    started.length = 0
    scheduler.replan()
    assert.equal(started.length, 0)
})

test('manual Run next cannot bypass account holds, session cap, manual locks or unknown exits', t => {
    const { scheduler, account, started } = planningFixture(t)
    scheduler.document.config.normalPolicy.enabled = true
    scheduler.replan()
    scheduler.running.clear()
    started.length = 0
    const state = scheduler.document.state.accounts[account.index]
    const endedAt = new Date(Date.now() - 10 * 60000).toISOString()
    const session = { id: 'existing', startedAt: endedAt, endedAt, platform: 'desktop', queries: [] }
    for (const reason of ['hold', 'cap', 'manual', 'uncertain']) {
        state.protection = { sessions: [{ ...session }] }
        scheduler.manualLocks.clear()
        if (reason === 'hold') state.protection.hold = { reason: 'verification', until: null }
        if (reason === 'cap')
            state.protection.sessions = Array.from({ length: 4 }, (_, i) => ({ ...session, id: String(i) }))
        if (reason === 'manual') scheduler.manualLocks.set(account.index, null)
        if (reason === 'uncertain') state.protection.sessions[0].endedAt = null
        scheduler.trigger(null, { force: true })
        assert.equal(started.length, 0, reason)
        assert.equal(scheduler.runNextRestOverrides.size, 0)
    }
})

test('streak search policy recalculates daily and survives rollover for warmup', t => {
    const { scheduler, account } = planningFixture(t)
    scheduler._drain = () => {}
    const flag = `ACCOUNT_${account.index}_NEW_ACCOUNT_MODE`
    process.env[flag] = 'true'
    t.after(() => {
        delete process.env[flag]
    })
    account.newAccountMode = true
    scheduler.document.config.streakSearchV1 = true
    scheduler.replan()
    let state = scheduler.document.state.accounts[account.index]
    assert.equal(state.platforms.desktop.dailySearchTarget, 9)
    assert.equal(state.platforms.mobile.dailySearchTarget, 6)
    state.searchStreak = { dailyCounter: 10, observedAt: new Date().toISOString() }
    scheduler.replan()
    assert.equal(state.platforms.desktop.dailySearchTarget, 15)
    assert.equal(state.platforms.mobile.dailySearchTarget, 10)
    state.dailySearch.reservations.test = { platform: 'desktop', budget: 5 }
    state.searchStreak.dailyCounter = 0
    scheduler.replan()
    assert.equal(state.platforms.desktop.dailySearchUsed, 5)
    assert.equal(state.platforms.desktop.dailySearchTarget, 9)
    t.mock.timers.tick(24 * 3600000)
    scheduler.replan()
    state = scheduler.document.state.accounts[account.index]
    assert.equal(state.searchStreak.dailyCounter, 0)
    assert.equal(state.platforms.desktop.dailySearchTarget, 9)
})

test('warmup service retry exhaustion does not claim authentication is needed after a successful session', t => {
    const { scheduler, account } = planningFixture(t)
    scheduler._drain = () => {}
    const flag = `ACCOUNT_${account.index}_NEW_ACCOUNT_MODE`
    process.env[flag] = 'true'
    t.after(() => {
        delete process.env[flag]
    })
    account.newAccountMode = true
    scheduler.replan()
    const state = scheduler.document.state.accounts[account.index]
    Object.assign(state.newAccount, {
        policy: 'standard168h',
        needsAction: true,
        serviceAttempts: 3,
        services: ['onedrive', 'todo', 'outlook', 'calendar'],
        serviceActions: ['todo', 'outlook', 'calendar']
    })
    scheduler.document.state.sessions.push({
        accountIndex: account.index,
        type: 'warmup',
        day: state.day,
        success: true
    })
    scheduler.replan()
    assert.equal(state.newAccount.needsAction, false)
    assert.deepEqual(state.newAccount.servicesPending, ['onedrive'])
    assert.equal(state.newAccount.serviceAttempts, 0)
    state.newAccount.needsAction = true
    state.newAccount.serviceAttempts = 3
    scheduler.document.state.sessions.push({
        accountIndex: account.index,
        type: 'warmup',
        day: state.day,
        success: false
    })
    scheduler.replan()
    assert.equal(state.newAccount.needsAction, true)
})
