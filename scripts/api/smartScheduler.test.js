import assert from 'node:assert/strict'
import test from 'node:test'

import {
    calculateSearchBudget,
    dailySetDependencySatisfied,
    deriveNetworkGroup,
    normalizeSearchResult,
    selectWorkerSession,
    selectRunnableJobs,
    shouldPlanSearch,
    SmartScheduler,
    validateSmartConfig
} from './smartScheduler.js'
import { ProcessManager } from './processManager.js'

const accounts = [
    { index: 1, email: 'one@example.test', proxy: null },
    { index: 2, email: 'two@example.test', proxy: { url: 'http://proxy.local', port: '8080' } },
    { index: 3, email: 'three@example.test', proxy: { url: 'http://proxy.local', port: '8080' } }
]

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

test('unavailable quota is stored as unknown and permits only the first daily probe', () => {
    const result = normalizeSearchResult({ remaining: 0, quotaAvailable: false })
    assert.deepEqual(result, { quotaKnown: false, remaining: null, complete: false, probeUsed: true })
    assert.equal(shouldPlanSearch({ ...result, failed: false }, result.probeUsed), false)
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
        'dailyCheckIn',
        'readToEarn'
    ])
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
