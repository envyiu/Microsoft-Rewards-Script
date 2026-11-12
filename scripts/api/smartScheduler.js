import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'

import { ProcessManager } from './processManager.js'
import { captureAppAuthorization, applyAppAuthorization } from './appAuthorization.js'
import { buildSingleAccountEnv, loadAccounts } from './accounts.js'
import { parseSearchQuotaSnapshot, reconcileSearchQuota } from './searchQuotaSnapshot.js'
import { preRewardsActive, newAccountStatus, NEW_ACCOUNT_DURATION_MS, NEW_ACCOUNT_SERVICES, NEW_ACCOUNT_QUERIES } from '../../packages/contracts/newAccount.js'

const QUOTA_CHECK_INTERVAL_MS = 2 * 60 * 60_000
const MAX_QUOTA_CHECKS_PER_DAY = 3

// Old parsers could complete these workers without seeing every card. Recheck
// them once after upgrading, retaining search quotas, sessions and other work.
export function migrateRewardsVerification(state) {
    if ((state.rewardsVerificationVersion || 0) >= 1) return false
    for (const account of Object.values(state.accounts || {})) {
        for (const key of ['workersCompleted', 'workersFailed'])
            if (Array.isArray(account[key])) account[key] = account[key].filter(worker => !['morePromotions', 'punchCards'].includes(worker))
        for (const key of ['workerFailures', 'workerRetryAt'])
            for (const worker of ['morePromotions', 'punchCards']) if (account[key]) delete account[key][worker]
    }
    state.rewardsVerificationVersion = 1
    return true
}

import { SMART_WORKERS, DEFAULT_SMART_CONFIG, DEFAULT_ALLOWED_WORKERS, defaultTimezone, deriveNetworkGroup, validateSmartConfig as validateContract } from '../../packages/contracts/smartConfig.js'
export { SMART_WORKERS, DEFAULT_SMART_CONFIG, deriveNetworkGroup }
export const validateSmartConfig = (raw, accounts = loadAccounts()) => validateContract(raw, accounts)

function fail(message) { throw Object.assign(new Error(message), { code: 'BAD_REQUEST' }) }

export function calculateSearchBudget({
    remainingPoints,
    pointsPerQuery = 3,
    slots = 1,
    targetMin = 5,
    targetMax = 10,
    noise = 3,
    safetyCap = 20,
    rng = Math.random
}) {
    const estimatedQueries = Math.max(1, Math.ceil(Math.max(0, remainingPoints) / Math.max(0.1, pointsPerQuery)))
    const baseBudget = Math.max(targetMin, Math.min(targetMax, Math.ceil(estimatedQueries / Math.max(1, slots))))
    const delta = Math.floor(rng() * (noise * 2 + 1)) - noise
    return { baseBudget, actualBudget: Math.max(1, Math.min(safetyCap, baseBudget + delta)), noise: delta }
}

export function normalizeSearchResult(result) {
    const remaining = Number(result?.remaining)
    const quotaKnown = result?.quotaAvailable === true && Number.isFinite(remaining)
    return quotaKnown
        ? { quotaKnown: true, remaining: Math.max(0, remaining), complete: remaining <= 0, probeUsed: false }
        : { quotaKnown: false, remaining: null, complete: false, probeUsed: true }
}

export function shouldPlanSearch(platformState, probeUsed) {
    if (platformState.complete || platformState.failed) return false
    void probeUsed
    return true
}

export function calculateSearchDue({
    lastRunAt,
    cooldownUntil,
    failures = 0,
    deadlineRisk = false,
    minCooldownMinutes,
    now = Date.now()
}) {
    const last = lastRunAt ? new Date(lastRunAt).getTime() : 0
    const randomDue = cooldownUntil ? new Date(cooldownUntil).getTime() : last + minCooldownMinutes * 60_000
    const minimumDue = last + minCooldownMinutes * 60_000
    const due = failures > 0 ? randomDue : deadlineRisk ? minimumDue : randomDue
    return Math.max(now, due)
}

export function dailySetDependencySatisfied(profile, configuredWorkers, state) {
    const dailySetEnabled = profile.allowedWorkers.includes('dailySet') && configuredWorkers.doDailySet === true
    return !dailySetEnabled || state.workersCompleted.includes('dailySet')
}

const APP_WORKERS = ['dailyCheckIn', 'readToEarn', 'appPromotions']
const LIGHT_BROWSER_WORKERS = ['morePromotions', 'streakProtection', 'punchCards']

const WORKER_FLAGS = Object.fromEntries(
    SMART_WORKERS.map(worker => [worker, `do${worker[0].toUpperCase()}${worker.slice(1)}`])
)

export function selectUrgentWorkerSession(pendingWorkers, { dailySetCompleted = false, searchPending = false } = {}) {
    const pending = [...new Set(pendingWorkers)]
    if (pending.includes('dailySet'))
        return ['dailySet', ...LIGHT_BROWSER_WORKERS.filter(worker => pending.includes(worker))]
    const batch = pending.filter(
        worker =>
            worker !== 'visualSearch' &&
            worker !== 'claimBonusPoints' &&
            worker !== 'bonusSearches' &&
            (worker !== 'activateSearchPerk' || dailySetCompleted)
    )
    if (batch.length) return batch
    if (pending.includes('visualSearch')) return ['visualSearch']
    if (pending.includes('bonusSearches')) return ['bonusSearches']
    if (!searchPending && pending.includes('claimBonusPoints')) return ['claimBonusPoints']
    return []
}

/**
 * Pick the next non-search session without losing dependency ordering.
 * App workers are grouped together so one mobile login/access token can serve
 * both. Visual Search remains atomic because it owns a separate desktop flow.
 */
export function selectWorkerSession(pendingWorkers, { dailySetCompleted = false } = {}) {
    const pending = [...new Set(pendingWorkers)]
    const has = worker => pending.includes(worker)
    const pair = (first, candidates) => {
        const second = candidates.find(worker => worker !== first && has(worker))
        return second ? [first, second] : [first]
    }

    if (has('dailySet')) return pair('dailySet', LIGHT_BROWSER_WORKERS)
    // Finish the daily reading quota before preparing long search sessions.
    // Otherwise a queued perk can hide Read to Earn from global prioritization.
    if (has('readToEarn')) return pair('readToEarn', APP_WORKERS)

    // Search Perk must never run before Daily Set. If Daily Set exhausted its
    // retries, continue other daily work and let searches run without the perk.
    const available = pending.filter(worker => worker !== 'activateSearchPerk' || dailySetCompleted)
    if (dailySetCompleted && available.includes('activateSearchPerk')) {
        return pair('activateSearchPerk', LIGHT_BROWSER_WORKERS)
    }

    const appWorker = APP_WORKERS.find(worker => available.includes(worker))
    if (appWorker) return pair(appWorker, [...APP_WORKERS, ...LIGHT_BROWSER_WORKERS])

    const lightWorker = LIGHT_BROWSER_WORKERS.find(worker => available.includes(worker))
    if (lightWorker) return pair(lightWorker, LIGHT_BROWSER_WORKERS)

    // Visual Search deliberately stays atomic. Claim runs last, after the
    // activities that may make a bonus claimable.
    if (available.includes('visualSearch')) return ['visualSearch']
    if (available.includes('claimBonusPoints')) return ['claimBonusPoints']
    if (available.includes('bonusSearches')) return ['bonusSearches']
    return []
}

export function selectRunnableJobs(
    jobs,
    { now = Date.now(), limit = 1, busyGroups = new Set(), busyAccounts = new Set(), force = false } = {}
) {
    const selected = []
    const groups = new Set(busyGroups)
    const accounts = new Set(busyAccounts)
    for (const job of jobs) {
        if (selected.length >= limit) break
        if (
            !job.dueAt ||
            (!force && new Date(job.dueAt).getTime() > now) ||
            groups.has(job.networkGroup) ||
            (job.accountIndex != null && accounts.has(job.accountIndex))
        )
            continue
        selected.push(job)
        groups.add(job.networkGroup)
        if (job.accountIndex != null) accounts.add(job.accountIndex)
    }
    return selected
}

function localParts(date, timezone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    })
        .formatToParts(date)
        .reduce((out, part) => ((out[part.type] = part.value), out), {})
    return { day: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) }
}

function minuteOf(value) {
    const [hour, minute] = value.split(':').map(Number)
    return hour * 60 + minute
}
function randomMinutes(range) {
    return range.min + Math.floor(Math.random() * (range.max - range.min + 1))
}
function inRange(minute, range) {
    const start = minuteOf(range.start)
    const end = minuteOf(range.end)
    return start <= end ? minute >= start && minute < end : minute >= start || minute < end
}

function atomicWrite(filename, value) {
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    const temp = `${filename}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temp, filename)
}

export class SmartScheduler extends EventEmitter {
    constructor({
        projectRoot,
        command,
        args,
        stopTimeoutMs,
        configFile,
        onLog = () => {},
        accountFilter = () => true,
        hardParallel = null,
        manualLocks = new Map()
    }) {
        super()
        this.setMaxListeners(0)
        this.projectRoot = projectRoot
        this.command = command
        this.args = args
        this.stopTimeoutMs = stopTimeoutMs
        this.configFile = configFile
        this.onLog = onLog
        this.running = new Map()
        this.manualLocks = manualLocks
        this.accountFilter = accountFilter
        this.hardParallel = hardParallel
        this.queue = []
        this.timer = null
        this.suspended = false
        this.document = this._load()
        migrateRewardsVerification(this.document.state)
        this.replan()
        this._arm()
    }

    _load() {
        let saved = {}
        try {
            saved = JSON.parse(fs.readFileSync(this.configFile, 'utf8'))
        } catch {}
        const accounts = loadAccounts()
        const rawConfig = saved.config ?? saved
        const knownIndexes = new Set(accounts.map(account => account.index))
        const profiles = Array.isArray(rawConfig.profiles)
            ? rawConfig.profiles.filter(profile => knownIndexes.has(Number(profile?.accountIndex)))
            : rawConfig.profiles
        const config = validateSmartConfig({ ...rawConfig, profiles }, accounts)
        const state =
            saved.state && typeof saved.state === 'object'
                ? saved.state
                : { accounts: {}, sessions: [], updatedAt: null }
        state.accounts ??= {}
        state.sessions ??= []
        return { config, state }
    }

    get() {
        return {
            config: structuredClone(this.document.config),
            queue: structuredClone(this.queue),
            running: [...this.running.values()]
                .filter(item => !item.manager.isAlive || item.manager.isAlive())
                .map(item => ({
                    ...item.job,
                    executionId: item.executionId,
                    state: item.manager.state || 'running',
                    phase: item.phase || item.job.type,
                    pid: item.manager.pid,
                    startedAt: item.startedAt
                })),
            accounts: structuredClone(this.document.state.accounts),
            sessions: structuredClone(this.document.state.sessions.slice(-100).reverse()),
            updatedAt: this.document.state.updatedAt,
            manualLocks: [...(this.manualLocks ?? new Map())].map(([accountIndex, networkGroup]) => ({
                accountIndex,
                networkGroup
            })),
            urgent: this.urgentStatus(),
            effectiveEnabled: this.document.config.enabled || Boolean(this.document.state.urgentRun?.active),
            cronExcluded: this.document.config.enabled || Boolean(this.document.state.urgentRun?.active)
        }
    }

    urgentStatus() {
        const run = this.document.state.urgentRun
        if (!run)
            return {
                active: false,
                status: 'idle',
                remaining: 0,
                failed: [],
                effectiveParallel: this.document.config.maxParallel
            }
        let remaining = 0
        const failed = []
        let expired = 0
        for (const [index, target] of Object.entries(run.targets)) {
            const state = this.document.state.accounts[index]
            if (
                !state ||
                state.day !== target.day ||
                !this.document.config.profiles.some(profile => String(profile.accountIndex) === index)
            ) {
                expired++
                continue
            }
            for (const worker of target.workers) {
                if (state.workersCompleted.includes(worker)) continue
                if (state.workersFailed.includes(worker) || state.blockedWorkers?.includes(worker))
                    failed.push({ accountIndex: Number(index), task: worker })
                else if (state.pendingWorkers && !state.pendingWorkers.includes(worker))
                    failed.push({ accountIndex: Number(index), task: worker, reason: 'disabled' })
                else remaining++
            }
            for (const platform of target.platforms) {
                if (state.platforms[platform].complete) continue
                if (state.platforms[platform].failed)
                    failed.push({ accountIndex: Number(index), task: `${platform}Search` })
                else if (state.enabledPlatforms && !state.enabledPlatforms.includes(platform))
                    failed.push({ accountIndex: Number(index), task: `${platform}Search`, reason: 'disabled' })
                else remaining++
            }
        }
        return {
            active: run.active,
            status: run.status,
            startedAt: run.startedAt,
            remaining,
            failed,
            expired,
            effectiveParallel: run.active ? 32 : this.document.config.maxParallel
        }
    }

    _urgentFor(accountIndex, day) {
        const run = this.document.state.urgentRun
        return Boolean(run?.active && run.targets[String(accountIndex)]?.day === day)
    }

    setUrgent(enabled) {
        if (typeof enabled !== 'boolean') fail('enabled must be a boolean.')
        if (enabled && this.document.state.urgentRun?.active) return this.get()
        if (!enabled) {
            if (this.document.state.urgentRun)
                Object.assign(this.document.state.urgentRun, { active: false, status: 'cancelled' })
        } else {
            const now = new Date()
            const accounts = loadAccounts()
            let botConfig = {}
            try {
                botConfig = JSON.parse(fs.readFileSync(process.env.MRS_CONFIG_FILE || path.join(this.projectRoot, 'config.json'), 'utf8'))
            } catch {}
            const targets = {}
            for (const profile of this.document.config.profiles) {
                const account = accounts.find(item => item.index === profile.accountIndex)
                if (!account) continue
                const state = this._accountState(account, profile, now)
                if (preRewardsActive(account, state)) continue
                state.workersFailed = []
                state.workerFailures = {}
                state.workerRetryAt = {}
                state.nextWorkerAt = null
                for (const platform of Object.values(state.platforms)) {
                    platform.failed = false
                    platform.failures = 0
                    platform.cooldownUntil = null
                }
                targets[String(account.index)] = {
                    day: state.day,
                    workers: profile.allowedWorkers.filter(worker =>
                        worker === 'streakProtection'
                            ? botConfig.ensureStreakProtection === true
                            : botConfig.workers?.[WORKER_FLAGS[worker]] === true
                    ),
                    platforms: ['mobile', 'desktop'].filter(
                        platform =>
                            botConfig.workers?.[platform === 'mobile' ? 'doMobileSearch' : 'doDesktopSearch'] === true
                    )
                }
            }
            this.document.state.urgentRun = { active: true, status: 'active', startedAt: now.toISOString(), targets }
        }
        this.replan()
        this._arm()
        return this.get()
    }

    setManualLock(accountIndex, networkGroup) {
        this.manualLocks ??= new Map()
        this.manualLocks.set(Number(accountIndex), networkGroup)
        this.emit('change', this.get())
    }

    clearManualLock(accountIndex) {
        this.manualLocks ??= new Map()
        if (!this.manualLocks.delete(Number(accountIndex))) return
        this.replan()
        this.emit('change', this.get())
    }

    update(config) {
        this.document.config = validateSmartConfig(config)
        if (!this.document.config.enabled && this.document.state.urgentRun?.active)
            Object.assign(this.document.state.urgentRun, { active: false, status: 'cancelled' })
        this.replan()
        this._save()
        this._arm()
        this.emit('change', this.get())
        return this.get()
    }

    _save() {
        this.document.state.updatedAt = new Date().toISOString()
        atomicWrite(this.configFile, this.document)
    }

    _accountState(account, profile, now) {
        const { day } = localParts(now, profile.timezone)
        let state = this.document.state.accounts[String(account.index)]
        if (!state || state.day !== day) {
            const manualStopUntil = state?.manualStopUntil
            const lastStoppedJobId = state?.lastStoppedJobId
            state = {
                newAccount: state?.newAccount ? { ...state.newAccount, services: [], serviceActions: [], serviceAttempts: 0 } : undefined,
                manualStopUntil,
                lastStoppedJobId,
                day,
                email: account.email,
                workersCompleted: [],
                workersFailed: [],
                workerFailures: {},
                workerRetryAt: {},
                nextWorkerAt: null,
                probeUsed: { mobile: false, desktop: false },
                platforms: {
                    mobile: {
                        remaining: null,
                        quotaKnown: false,
                        queries: 0,
                        ewmaPointsPerQuery: 3,
                        lastRunAt: null,
                        cooldownUntil: null,
                        failures: 0,
                        failed: false,
                        complete: false
                    },
                    desktop: {
                        remaining: null,
                        quotaKnown: false,
                        queries: 0,
                        ewmaPointsPerQuery: 3,
                        lastRunAt: null,
                        cooldownUntil: null,
                        failures: 0,
                        failed: false,
                        complete: false
                    }
                }
            }
            this.document.state.accounts[String(account.index)] = state
        }
        state.workersFailed ??= []
        state.workerFailures ??= {}
        if (!state.workerRetryAt) {
            state.workerRetryAt = {}
            // Older schedules kept one retry timer for the entire account.
            // Preserve failed workers' deadlines without delaying untouched work.
            if (state.nextWorkerAt && Object.values(state.workerFailures).some(count => count > 0)) {
                for (const [worker, count] of Object.entries(state.workerFailures))
                    if (count > 0) state.workerRetryAt[worker] = state.nextWorkerAt
                state.nextWorkerAt = null
            }
        }
        state.probeUsed ??= { mobile: false, desktop: false }
        for (const platform of ['mobile', 'desktop']) {
            const platformState = state.platforms[platform]
            platformState.failures ??= 0
            platformState.failed ??= false
            platformState.quotaKnown ??= platformState.complete === true || (platformState.remaining ?? 0) > 0
            if (!platformState.quotaKnown && state.probeUsed[platform]) platformState.remaining = null
        }
        return state
    }

    isPreRewardsAccount(index) {
        const account = loadAccounts().find(a => a.index === Number(index))
        return preRewardsActive(account, this.document.state.accounts[String(index)])
    }

    _newAccountCheckpoint(record, entry) {
        if (record.job.type !== 'warmup') return
        const state = this.document.state.accounts[String(record.job.accountIndex)]
        if (!state) return
        let payload
        try { payload = JSON.parse(entry.message) } catch { return }
        if (payload.jobId !== record.job.id || !Number.isSafeInteger(payload.queries) || payload.queries < 0 || payload.queries > record.job.searchBudget || !Number.isFinite(Date.parse(payload.at))) return
        state.newAccount ??= { services: [] }
        if (!Array.isArray(payload.services)) return
        if (state.day === record.job.day) {
            state.newAccount.services = [...new Set([...(state.newAccount.services || []), ...payload.services.filter(s => record.job.services.includes(s))])]
            if (Array.isArray(payload.serviceActions)) state.newAccount.serviceActions = [...new Set([...(state.newAccount.serviceActions || []), ...payload.serviceActions.filter(s => record.job.services.includes(s) && payload.services.includes(s))])]
            if (Array.isArray(payload.artifacts)) state.newAccount.artifacts = [...new Set([...(state.newAccount.artifacts || []), ...payload.artifacts.filter(s => ['onedrive', 'todo'].includes(s) && record.job.services.includes(s) && payload.serviceActions?.includes(s))])]
            const delta = Math.max(0, payload.queries - (record.warmupQueries || 0))
            state.platforms[record.job.platform].queries += delta
        }
        record.warmupQueries = Math.max(record.warmupQueries || 0, payload.queries)
        if (payload.queries > 0 && !state.newAccount.startedAt) {
            state.newAccount.startedAt = payload.at
            state.newAccount.readyAt = new Date(Date.parse(payload.at) + NEW_ACCOUNT_DURATION_MS).toISOString()
        }
        state.newAccount.needsAction = false
        this._save()
    }

    replan({ accountIndexes = null } = {}) {
        const now = new Date()
        const accounts = loadAccounts()
        const selected = accountIndexes ? new Set(accountIndexes.map(Number)) : null
        let botConfig = {}
        try {
            botConfig = JSON.parse(fs.readFileSync(process.env.MRS_CONFIG_FILE || path.join(this.projectRoot, 'config.json'), 'utf8'))
        } catch {}
        const configuredWorkers = botConfig.workers ?? {}
        const workerFlags = {
            dailySet: 'doDailySet',
            morePromotions: 'doMorePromotions',
            claimBonusPoints: 'doClaimBonusPoints',
            punchCards: 'doPunchCards',
            appPromotions: 'doAppPromotions',
            dailyCheckIn: 'doDailyCheckIn',
            readToEarn: 'doReadToEarn',
            activateSearchPerk: 'doActivateSearchPerk',
            visualSearch: 'doVisualSearch',
            bonusSearches: 'doBonusSearches'
        }
        const jobs = []
        for (const profile of this.document.config.profiles) {
            if (selected && !selected.has(profile.accountIndex)) continue
            const account = accounts.find(item => item.index === profile.accountIndex)
            if (!account) continue
            if (this.accountFilter && !this.accountFilter(account)) continue
            const state = this._accountState(account, profile, now)
            const { minute } = localParts(now, profile.timezone)
            const urgent = this._urgentFor(account.index, state.day)
            const allowedNow =
                urgent ||
                this.document.state.onceAccounts?.includes(account.index) ||
                ((profile.windows.length === 0 || profile.windows.some(window => inRange(minute, window))) &&
                    !profile.quietHours.some(window => inRange(minute, window)))
            const deadline = minuteOf(profile.deadline)
            const minutesLeft = Math.max(1, deadline >= minute ? deadline - minute : deadline + 1440 - minute)
            const deadlineRisk = minutesLeft <= this.document.config.catchUpThresholdMinutes
            const group = deriveNetworkGroup(account, this.document.config.networkGroupOverride)
            if (preRewardsActive(account, state)) {
                state.newAccount ??= { services: [] }
                state.pendingWorkers = []
                state.blockedWorkers = []
                state.newAccountStatus = newAccountStatus(account, state)
                for (const platform of ['desktop', 'mobile']) {
                    const progress = state.platforms[platform]
                    const remaining = NEW_ACCOUNT_QUERIES[platform] - progress.queries
                    const services = platform === 'desktop' && (state.newAccount.serviceAttempts || 0) < 3 ? NEW_ACCOUNT_SERVICES.filter(s => (!state.newAccount.services?.includes(s) || !state.newAccount.serviceActions?.includes(s))) : []
                    if ((remaining <= 0 && !services.length) || progress.failed) continue
                    const due = calculateSearchDue({ ...progress, minCooldownMinutes: this.document.config.cooldownMinutes.min })
                    jobs.push({ id: `${state.day}-${account.index}-warmup-${platform}-${progress.queries}`, day: state.day,
                        accountIndex: account.index, email: account.email, networkGroup: group, type: 'warmup',
                        platform, services, workers: [], searchBudget: Math.max(0, Math.min(5, remaining)), urgent: false,
                        dueAt: allowedNow ? new Date(due).toISOString() : null,
                        reason: allowedNow ? 'new-account' : 'outside-run-window', attempts: progress.failures || 0 })
                }
                continue
            }
            if (account.newAccountMode) {
                if (!state.newAccount.activatedAt) {
                    state.newAccount.activatedAt = new Date().toISOString()
                    for (const progress of Object.values(state.platforms)) Object.assign(progress, { queries: 0, remaining: null, quotaKnown: false, complete: false, failed: false, failures: 0, cooldownUntil: null, lastRunAt: null })
                }
                state.newAccountStatus = newAccountStatus(account, state)
            }
            state.enabledPlatforms = ['mobile', 'desktop'].filter(
                platform => configuredWorkers[platform === 'mobile' ? 'doMobileSearch' : 'doDesktopSearch'] === true
            )
            const pendingWorkers = profile.allowedWorkers.filter(
                worker =>
                    !state.workersCompleted.includes(worker) &&
                    !state.workersFailed.includes(worker) &&
                    (worker === 'streakProtection'
                        ? botConfig.ensureStreakProtection === true
                        : configuredWorkers[workerFlags[worker]] === true)
            )
            const dailySetFailed = state.workersFailed.includes('dailySet')
            const blockedWorkers =
                dailySetFailed && pendingWorkers.includes('activateSearchPerk') ? ['activateSearchPerk'] : []
            const schedulableWorkers = pendingWorkers.filter(worker => !blockedWorkers.includes(worker))
            state.pendingWorkers = [...schedulableWorkers]
            state.blockedWorkers = blockedWorkers
            if (schedulableWorkers.length) {
                const dailySetCompleted = dailySetDependencySatisfied(profile, configuredWorkers, state)
                const workerDueAt = worker =>
                    urgent
                        ? Date.now()
                        : Math.max(
                              state.nextWorkerAt ? new Date(state.nextWorkerAt).getTime() : 0,
                              state.workerRetryAt[worker] ? new Date(state.workerRetryAt[worker]).getTime() : 0
                          )
                const readyWorkers = schedulableWorkers.filter(
                    worker =>
                        workerDueAt(worker) <= Date.now() && (worker !== 'activateSearchPerk' || dailySetCompleted)
                )
                const candidates = readyWorkers.length ? readyWorkers : schedulableWorkers
                const workers = (urgent ? selectUrgentWorkerSession : selectWorkerSession)(candidates, {
                    dailySetCompleted,
                    searchPending: ['mobile', 'desktop'].some(
                        platform =>
                            configuredWorkers[platform === 'mobile' ? 'doMobileSearch' : 'doDesktopSearch'] === true &&
                            shouldPlanSearch(state.platforms[platform])
                    )
                })
                if (workers.length) {
                    const workerDue = Math.max(...workers.map(workerDueAt))
                    const attempts = Math.max(...workers.map(worker => state.workerFailures[worker] ?? 0))
                    jobs.push({
                        id: `${state.day}-${account.index}-workers-${workers.join('-')}`,
                        day: state.day,
                        accountIndex: account.index,
                        email: account.email,
                        networkGroup: group,
                        type: 'workers',
                        urgent,
                        workers,
                        dueAt: allowedNow ? new Date(Math.max(Date.now(), workerDue)).toISOString() : null,
                        reason: allowedNow
                            ? workerDue > Date.now()
                                ? attempts
                                    ? 'retry-backoff'
                                    : 'cooldown'
                                : deadlineRisk
                                  ? 'deadline-catch-up'
                                  : 'ready'
                            : 'outside-run-window',
                        deadlineRisk,
                        attempts
                    })
                }
            }
            const searchDependenciesPending =
                schedulableWorkers.includes('dailySet') || schedulableWorkers.includes('activateSearchPerk')
            if (
                !pendingWorkers.length &&
                minute < 24 * 60 - 5 &&
                state.enabledPlatforms.length &&
                state.enabledPlatforms.every(
                    platform => state.platforms[platform].complete || state.platforms[platform].failed
                ) &&
                (state.quotaCheckAttempts || 0) < MAX_QUOTA_CHECKS_PER_DAY
            ) {
                const lastCheck = Math.max(
                    Date.parse(state.quotaCheckedAt || '') || 0,
                    Date.parse(state.quotaCheckAttemptedAt || '') || 0
                )
                jobs.push({
                    id: `${state.day}-${account.index}-quota-${state.quotaCheckAttempts || 0}`,
                    day: state.day,
                    accountIndex: account.index,
                    email: account.email,
                    networkGroup: group,
                    type: 'quota',
                    workers: [],
                    urgent: false,
                    dueAt: allowedNow
                        ? new Date(Math.max(Date.now(), lastCheck + QUOTA_CHECK_INTERVAL_MS)).toISOString()
                        : null,
                    reason: lastCheck + QUOTA_CHECK_INTERVAL_MS > Date.now() ? 'cooldown' : 'quota-recheck'
                })
            }
            for (const platform of ['mobile', 'desktop']) {
                if (searchDependenciesPending) continue
                if (configuredWorkers[platform === 'mobile' ? 'doMobileSearch' : 'doDesktopSearch'] !== true) continue
                const platformState = state.platforms[platform]
                if (!shouldPlanSearch(platformState, state.probeUsed[platform])) continue
                const dueMs = urgent
                    ? Date.now()
                    : calculateSearchDue({
                          lastRunAt: platformState.lastRunAt,
                          cooldownUntil: platformState.cooldownUntil,
                          failures: platformState.failures,
                          deadlineRisk,
                          minCooldownMinutes: this.document.config.cooldownMinutes.min
                      })
                const slots = Math.max(1, Math.floor(minutesLeft / this.document.config.cooldownMinutes.min))
                const budget = calculateSearchBudget({
                    remainingPoints: platformState.remaining ?? 0,
                    pointsPerQuery: platformState.ewmaPointsPerQuery,
                    slots,
                    targetMin: deadlineRisk
                        ? this.document.config.searchTarget.max
                        : this.document.config.searchTarget.min,
                    targetMax: this.document.config.searchTarget.max,
                    noise: this.document.config.searchNoise,
                    safetyCap: this.document.config.searchSafetyCap
                })
                jobs.push({
                    id: `${state.day}-${account.index}-${platform}-${platformState.queries}`,
                    day: state.day,
                    accountIndex: account.index,
                    email: account.email,
                    networkGroup: group,
                    type: 'search',
                    urgent,
                    platform,
                    baseBudget: urgent ? 100 : budget.baseBudget,
                    searchBudget: urgent ? 100 : budget.actualBudget,
                    noise: urgent ? 0 : budget.noise,
                    dueAt: allowedNow ? new Date(dueMs).toISOString() : null,
                    reason: allowedNow
                        ? dueMs > Date.now()
                            ? platformState.failures
                                ? 'retry-backoff'
                                : 'cooldown'
                            : deadlineRisk
                              ? 'deadline-catch-up'
                              : 'ready'
                        : 'outside-run-window',
                    deadlineRisk,
                    attempts: platformState.failures
                })
            }
        }
        const activeIds = new Set([...this.running.values()].map(item => item.job.id))
        this.queue = jobs
            .map(job => {
                const until = this.document.state.accounts[String(job.accountIndex)]?.manualStopUntil
                return until && Date.parse(until) > Date.now()
                    ? {
                          ...job,
                          dueAt: new Date(Math.max(Date.parse(job.dueAt) || 0, Date.parse(until))).toISOString(),
                          reason: 'stopped-cooldown'
                      }
                    : job
            })
            .filter(job => !activeIds.has(job.id))
            .sort((a, b) => {
                if (a.urgent !== b.urgent) return Number(b.urgent) - Number(a.urgent)
                const criticalDaily = job =>
                    job.type === 'workers' && job.workers.some(worker => ['dailySet', 'readToEarn'].includes(worker))
                if (criticalDaily(a) !== criticalDaily(b)) return Number(criticalDaily(b)) - Number(criticalDaily(a))
                // Bound checks are short and must not wait behind a fresh long
                // search after each preceding account's quota was reopened.
                if ((a.type === 'quota') !== (b.type === 'quota'))
                    return Number(b.type === 'quota') - Number(a.type === 'quota')
                if (a.urgent) {
                    const rank = job =>
                        job.type === 'workers' &&
                        job.workers.some(worker => ['dailySet', 'activateSearchPerk'].includes(worker))
                            ? 0
                            : job.type === 'search'
                              ? 1
                              : job.workers.includes('claimBonusPoints')
                                ? 3
                                : 2
                    const priority = rank(a) - rank(b)
                    if (priority) return priority
                }
                return String(a.dueAt).localeCompare(String(b.dueAt)) || a.accountIndex - b.accountIndex
            })
        if (this.document.state.onceAccounts) this.document.state.onceAccounts = this.document.state.onceAccounts.filter(index => this.queue.some(job => job.accountIndex === index) || [...this.running.values()].some(record => record.job.accountIndex === index))
        const urgentStatus = this.urgentStatus()
        if (urgentStatus.active && urgentStatus.remaining === 0) {
            Object.assign(this.document.state.urgentRun, {
                active: false,
                status: urgentStatus.expired ? 'expired' : urgentStatus.failed.length ? 'incomplete' : 'completed'
            })
        }
        this._save()
        this._drain()
        return this.get()
    }

    async stopAccount(accountIndex, jobId) {
        const account = loadAccounts().find(account => account.index === accountIndex)
        if (!account || (this.accountFilter && !this.accountFilter(account)))
            throw Object.assign(new Error('Account is not owned by this node.'), {
                code: 'ACCOUNT_NOT_FOUND',
                status: 404
            })
        if (typeof jobId !== 'string' || !jobId || jobId.length > 200)
            throw Object.assign(new Error('jobId is required.'), { code: 'BAD_REQUEST', status: 400 })
        const record = [...this.running.values()].find(item => item.job.accountIndex === accountIndex)
        if (!record) return { accountIndex, jobId, stopped: true, alreadyStopped: true }
        if ((record.executionId || record.job.id) !== jobId)
            throw Object.assign(new Error('The active job changed. Refresh before stopping.'), {
                code: 'JOB_CHANGED',
                status: 409
            })
        if (record.stopPromise) return record.stopPromise
        const state = this.document.state.accounts[String(accountIndex)]
        state.manualStopUntil = new Date(Date.now() + this.document.config.cooldownMinutes.min * 60000).toISOString()
        state.lastStoppedJobId = jobId
        record.handoff = true
        record.userStopped = true
        this._save()
        record.stopPromise = (async () => {
            let sessionSaved = false
            const checkpoint = entry => {
                if (entry.title === 'SESSION-CHECKPOINT' && entry.message === 'All active browser sessions saved')
                    sessionSaved = true
            }
            record.manager.on('log', checkpoint)
            try {
                await record.manager.stop({ signalTree: false, signal: 'SIGUSR1' })
                if (record.manager.isAlive?.())
                    throw Object.assign(new Error('Process has not stopped.'), { code: 'STOP_PENDING', status: 409 })
                return { accountIndex, jobId, stopped: true, sessionSaved, nextEligibleAt: state.manualStopUntil }
            } finally {
                record.manager.off('log', checkpoint)
            }
        })()
        return record.stopPromise
    }

    async retryAccounts(accountIndexes, { preempt = false, runOnce = false } = {}) {
        if (typeof preempt !== 'boolean')
            throw Object.assign(new Error('preempt must be boolean.'), { code: 'BAD_REQUEST', status: 400 })
        const accounts = loadAccounts()
        if (
            !Array.isArray(accountIndexes) ||
            !accountIndexes.length ||
            accountIndexes.some(index => !Number.isSafeInteger(index) || !accounts.some(a => a.index === index))
        )
            throw Object.assign(new Error('Select valid account indexes.'), { code: 'BAD_REQUEST', status: 400 })
        const selected = new Set(accountIndexes)
        const suspended = this.suspended
        this.suspended = true
        try {
            await Promise.all(
                [...this.running.values()]
                    .filter(item => preempt || selected.has(item.job.accountIndex))
                    .map(item => {
                        item.handoff = true
                        return item.manager.stop({ signalTree: false, signal: 'SIGUSR1' })
                    })
            )
            for (const profile of this.document.config.profiles) {
                if (!selected.has(profile.accountIndex)) continue
                const account = accounts.find(a => a.index === profile.accountIndex)
                const state = this._accountState(account, profile, new Date())
                delete state.manualStopUntil
                state.workersFailed = []
                state.workerFailures = {}
                state.workerRetryAt = {}
                state.nextWorkerAt = null
                for (const platform of Object.values(state.platforms)) {
                    platform.failed = false
                    platform.failures = 0
                    platform.cooldownUntil = null
                }
            }
            if (runOnce) this.document.state.onceAccounts = [...new Set([...(this.document.state.onceAccounts || []), ...accountIndexes])]
            this._save()
            this.replan({ accountIndexes })
        } finally {
            this.suspended = suspended
        }
        this._drain(true)
        if (runOnce) this._arm()
        return this.get()
    }

    trigger(accountIndexes = null, { force = false } = {}) {
        if (force && accountIndexes)
            for (const index of accountIndexes) {
                const state = this.document.state.accounts[String(index)]
                if (state) delete state.manualStopUntil
            }
        this.replan({ accountIndexes })
        if (force && this.document.config.enabled) this._drain(true)
        return this.get()
    }

    enrollAccounts(accountIndexes = []) {
        const indexes = [...new Set(accountIndexes.map(Number))].filter(
            index => Number.isSafeInteger(index) && index > 0
        )
        if (!indexes.length) return this.get()
        const accounts = loadAccounts()
        const known = new Set(this.document.config.profiles.map(profile => profile.accountIndex))
        const template = this.document.config.profiles[0] ?? {
            timezone: defaultTimezone(),
            windows: [],
            quietHours: [],
            deadline: '23:00',
            allowedWorkers: DEFAULT_ALLOWED_WORKERS
        }
        for (const accountIndex of indexes) {
            if (known.has(accountIndex) || !accounts.some(account => account.index === accountIndex)) continue
            this.document.config.profiles.push({ ...structuredClone(template), accountIndex })
            known.add(accountIndex)
        }
        this.document.config = validateSmartConfig(this.document.config, accounts)
        this.replan()
        this._save()
        this._arm()
        this.emit('change', this.get())
        return this.get()
    }

    removeAccount(accountIndex) {
        const index = Number(accountIndex)
        this.document.config.profiles = this.document.config.profiles.filter(profile => profile.accountIndex !== index)
        delete this.document.state.accounts[String(index)]
        this.queue = this.queue.filter(job => job.accountIndex !== index)
        this.document.config = validateSmartConfig(this.document.config)
        this.replan()
        this._save()
        this._arm()
        this.emit('change', this.get())
        return this.get()
    }

    _arm() {
        clearInterval(this.timer)
        this.timer = null
        if (!this.document.config.enabled && !this.document.state.urgentRun?.active && !this.document.state.onceAccounts?.length) return
        this.timer = setInterval(() => {
            this.replan()
        }, 30_000)
        this.timer.unref?.()
        this._drain()
    }

    _drain(force = false) {
        if (this.suspended) return
        const urgentActive = Boolean(this.document.state.urgentRun?.active)
        if (!this.document.config.enabled && !urgentActive && !force && !this.document.state.onceAccounts?.length) return
        const busyGroups = new Set([...this.running.values()].map(item => item.job.networkGroup))
        const busyAccounts = new Set([...this.running.values()].map(item => item.job.accountIndex))
        for (const [accountIndex, networkGroup] of this.manualLocks ?? []) {
            busyAccounts.add(accountIndex)
            if (networkGroup) busyGroups.add(networkGroup)
        }
        const normalAllowance = Math.max(0, this.document.config.maxParallel - this.running.size)
        let normalSelected = 0
        const once = new Set(this.document.state.onceAccounts || [])
        const candidates = this.queue
            .filter(job => job.urgent || this.document.config.enabled || once.has(job.accountIndex))
            .map(job => once.has(job.accountIndex) ? { ...job, dueAt: new Date().toISOString() } : job)
            // An explicit Run now must reach the next free slot, even while
            // recurring jobs remain ready. Account/proxy locks and caps still apply.
            .sort((a, b) => Number(Boolean(b.urgent)) - Number(Boolean(a.urgent)) || Number(once.has(b.accountIndex)) - Number(once.has(a.accountIndex)))
        const jobs = selectRunnableJobs(
            candidates.filter(job => {
                if (Date.parse(this.document.state.accounts[String(job.accountIndex)]?.manualStopUntil) > Date.now())
                    return false
                if (!this.accountFilter) return true
                const account = loadAccounts().find(item => item.index === job.accountIndex)
                return account && (!this.accountFilter || this.accountFilter(account))
            }),
            {
                limit:
                    Math.min(urgentActive ? 32 : this.document.config.maxParallel, this.hardParallel ?? 32) -
                    this.running.size,
                busyGroups,
                busyAccounts,
                force
            }
        ).filter(job => job.urgent || normalSelected++ < normalAllowance)
        for (const job of jobs) {
            this.queue = this.queue.filter(item => item.id !== job.id)
            this._start(job)
        }
        this.emit('change', this.get())
    }

    _start(job) {
        if (this.document.state.onceAccounts?.includes(job.accountIndex)) {
            this.document.state.onceAccounts = this.document.state.onceAccounts.filter(index => index !== job.accountIndex)
            this._save()
        }
        const selection = buildSingleAccountEnv(job.accountIndex)
        const plan =
            job.type === 'warmup'
                ? { version: 1, jobId: job.id, type: 'warmup', platform: job.platform, services: job.services, artifacts: this.document.state.accounts[String(job.accountIndex)]?.newAccount?.artifacts || [], searchBudget: job.searchBudget }
                : job.type === 'quota'
                ? { version: 1, jobId: job.id, type: 'quota' }
                : job.type === 'search'
                  ? {
                        version: 1,
                        jobId: job.id,
                        type: 'search',
                        platform: job.platform,
                        searchBudget: job.searchBudget
                    }
                  : { version: 1, jobId: job.id, type: 'workers', workers: job.workers }
        if (job.urgent) plan.urgent = true
        if (job.type === 'warmup' && job.services.length) {
            const state = this.document.state.accounts[String(job.accountIndex)]
            state.newAccount.serviceAttempts = (state.newAccount.serviceAttempts || 0) + 1
            this._save()
        }
        const lifecycle = this.document.state.accounts[String(job.accountIndex)]?.newAccount
        if (lifecycle?.readyAt) plan.rewardsEligibleAt = lifecycle.readyAt
        const manager = new ProcessManager({
            command: this.command,
            args: this.args,
            cwd: this.projectRoot,
            stopTimeoutMs: this.stopTimeoutMs,
            name: `smart-${job.accountIndex}`
        })
        if (job.type === 'quota') {
            const state = this.document.state.accounts[String(job.accountIndex)]
            state.quotaCheckAttempts = (state.quotaCheckAttempts || 0) + 1
            state.quotaCheckAttemptedAt = new Date().toISOString()
            this._save()
        }
        const record = {
            executionId: crypto.randomUUID(),
            phase: 'starting',
            job,
            manager,
            startedAt: new Date().toISOString(),
            searchResult: null,
            quotaSnapshot: null,
            quotaBlocked: false,
            workerResults: new Set(),
            timedOut: false,
            timeout: null
        }
        this.running.set(job.id, record)
        manager.on('log', entry => {
            const appAuthorization = captureAppAuthorization(entry)
            if (appAuthorization) record.appAuthorization = appAuthorization
            if (entry.title?.startsWith('LOGIN'))
                record.phase = /verif|approval|code/i.test(entry.message) ? 'verification' : 'login'
            if (entry.title === 'SMART-WORKER-START' || entry.title === 'SMART-SEARCH-START') record.phase = job.type
            this.onLog({ ...entry, smartJobId: job.id })
            if (entry.title === 'NEW-ACCOUNT-CHECKPOINT') { record.phase = 'warmup'; this._newAccountCheckpoint(record, entry) }
            if (entry.title === 'BOT-WARNING') record.quotaBlocked = true
            if (entry.title === 'SMART-QUOTA') {
                const snapshot = parseSearchQuotaSnapshot(entry.message)
                if (snapshot && (!record.quotaSnapshot || snapshot.readAt > record.quotaSnapshot.readAt))
                    record.quotaSnapshot = snapshot
            }
            if (entry.title === 'SMART-SEARCH-END') {
                const fields = Object.fromEntries(entry.message.split(' | ').map(part => part.split('=')))
                const result = {
                    queries: Number(fields.queries),
                    points: Number(fields.points),
                    remaining: Number(fields.remaining),
                    quotaAvailable: fields.quotaAvailable === 'true'
                }
                if (
                    Number.isSafeInteger(result.queries) &&
                    result.queries >= 0 &&
                    Number.isFinite(result.points) &&
                    result.points >= 0 &&
                    Number.isFinite(result.remaining) &&
                    result.remaining >= 0
                )
                    record.searchResult = result
            }
            if (entry.title === 'SMART-WORKER-END') {
                const worker = /^worker=([^|\s]+)$/.exec(entry.message.trim())?.[1]
                if (job.type === 'workers' && job.workers.includes(worker)) record.workerResults.add(worker)
            }
        })
        manager.once('exit', exit => this._finish(record, exit))
        manager.start({ env: { ...selection.env, MRS_EXECUTION_PLAN: JSON.stringify(plan) }, trustedEnv: true })
        record.timeout = setTimeout(() => {
            record.timedOut = true
            manager.stop().catch(() => {})
        }, this.document.config.sessionTimeoutMinutes * 60_000)
        record.timeout.unref?.()
        this.emit('change', this.get())
    }

    _finish(record, exit) {
        clearTimeout(record.timeout)
        const { job } = record
        this.running.delete(job.id)
        const state = this.document.state.accounts[String(job.accountIndex)]
        if (job.type === 'warmup') {
            const succeeded = exit.code === 0 && (record.warmupQueries || 0) === job.searchBudget
            if (state?.day === job.day) {
                const progress = state.platforms[job.platform]
                if (!record.handoff) {
                    progress.failures = succeeded ? 0 : (progress.failures || 0) + 1
                    progress.failed = progress.failures > this.document.config.retry.maxAttempts
                    progress.lastRunAt = new Date().toISOString()
                    progress.cooldownUntil = new Date(Date.now() + (succeeded ? randomMinutes(this.document.config.cooldownMinutes) : this.document.config.retry.backoffMinutes * progress.failures) * 60_000).toISOString()
                    state.newAccount ??= { services: [] }
                    state.newAccount.needsAction = !succeeded || ((state.newAccount.serviceAttempts || 0) >= 3 && NEW_ACCOUNT_SERVICES.some(s => (!state.newAccount.services?.includes(s) || !state.newAccount.serviceActions?.includes(s))))
                }
                state.newAccountStatus = newAccountStatus(loadAccounts().find(a => a.index === job.accountIndex), state)
            }
            this.document.state.sessions.push({ ...job, executionId: record.executionId, startedAt: record.startedAt, endedAt: new Date().toISOString(), success: succeeded, interrupted: Boolean(record.handoff), queries: record.warmupQueries || 0, exit })
            this.document.state.sessions = this.document.state.sessions.slice(-500)
            this._save(); this.replan(); this.emit('change', this.get())
            return
        }
        if (record.handoff) {
            if (state && (job.day == null || job.day === state.day) && job.type === 'workers') {
                state.workersCompleted = [...new Set([...state.workersCompleted, ...record.workerResults])]
                state.nextWorkerAt = new Date().toISOString()
            }
            this.document.state.sessions.push({
                ...job,
                startedAt: record.startedAt,
                endedAt: new Date().toISOString(),
                success: null,
                interrupted: true,
                stopped: Boolean(record.userStopped),
                executionId: record.executionId,
                exit
            })
            this.document.state.sessions = this.document.state.sessions.slice(-500)
            this._save()
            this.replan()
            this.emit('change', this.get())
            return
        }
        const staleDay = !state || (job.day != null && state.day !== job.day)
        const runAccounts = record.manager.getStatus().run.accounts ?? []
        const accountSucceeded = runAccounts.length > 0 && runAccounts.every(account => account.success === true)
        const completedWorkers =
            job.type === 'workers' ? job.workers.filter(worker => record.workerResults.has(worker)) : []
        const missingWorkers =
            job.type === 'workers' ? job.workers.filter(worker => !completedWorkers.includes(worker)) : []
        const previousRemaining = job.type === 'search' ? state?.platforms?.[job.platform]?.remaining : null
        const searchMadeProgress =
            job.type === 'search' &&
            record.searchResult != null &&
            (record.searchResult.points > 0 ||
                (record.searchResult.quotaAvailable === true &&
                    Number.isFinite(previousRemaining) &&
                    record.searchResult.remaining < previousRemaining))
        const searchPending =
            job.type === 'search' &&
            exit.code === 0 &&
            accountSucceeded &&
            record.searchResult != null &&
            (record.searchResult.quotaAvailable !== true || (record.searchResult.remaining > 0 && !searchMadeProgress))
        const succeeded =
            exit.code === 0 &&
            accountSucceeded &&
            (job.type === 'search'
                ? record.searchResult != null && !searchPending
                : job.type === 'workers'
                  ? missingWorkers.length === 0
                  : record.quotaSnapshot != null)
        this.document.state.sessions.push({
            ...job,
            startedAt: record.startedAt,
            endedAt: new Date().toISOString(),
            success: searchPending ? null : succeeded,
            pending: searchPending,
            timedOut: record.timedOut,
            staleDay,
            exit
        })
        if (this.document.state.sessions.length > 500)
            this.document.state.sessions.splice(0, this.document.state.sessions.length - 500)
        // A session that crossed the account's local midnight belongs to the
        // previous day. Keep it in history, but never apply it to fresh state.
        if (staleDay) {
            this._save()
            this.replan()
            this.emit('change', this.get())
            return
        }
        state.workerRetryAt ??= {}
        if (completedWorkers.length) {
            state.workersCompleted = [...new Set([...state.workersCompleted, ...completedWorkers])]
            for (const worker of completedWorkers) {
                state.workerFailures[worker] = 0
                delete state.workerRetryAt[worker]
            }
        }
        if (this.suspended && exit.code !== 0) {
            const cooldownUntil = new Date(Date.now() + this.document.config.cooldownMinutes.min * 60_000).toISOString()
            if (job.type === 'workers') state.nextWorkerAt = cooldownUntil
            else if (job.type === 'search') {
                state.platforms[job.platform].lastRunAt = new Date().toISOString()
                state.platforms[job.platform].cooldownUntil = cooldownUntil
            }
            this._save()
            this.replan()
            this.emit('change', this.get())
            return
        }
        if (job.type === 'quota') {
            // Read-only checks have their own bounded cadence, never consume or
            // clear search/activity retry budgets without a validated snapshot.
        } else if (job.type === 'workers') {
            if (!missingWorkers.length) {
                const dailyWorkPending = (state.pendingWorkers || []).some(
                    worker =>
                        ['dailySet', 'readToEarn'].includes(worker) &&
                        !state.workersCompleted.includes(worker) &&
                        !state.workersFailed.includes(worker)
                )
                // Search pacing must not postpone unfinished daily activities.
                state.nextWorkerAt = dailyWorkPending
                    ? null
                    : new Date(Date.now() + randomMinutes(this.document.config.cooldownMinutes) * 60_000).toISOString()
            } else {
                state.nextWorkerAt = null
                for (const worker of missingWorkers) {
                    state.workerFailures[worker] = (state.workerFailures[worker] ?? 0) + 1
                    state.workerRetryAt[worker] = new Date(
                        Date.now() + this.document.config.retry.backoffMinutes * 60_000 * state.workerFailures[worker]
                    ).toISOString()
                    if (state.workerFailures[worker] > this.document.config.retry.maxAttempts)
                        state.workersFailed.push(worker)
                }
                state.workersFailed = [...new Set(state.workersFailed)]
            }
        } else if (job.type === 'search' && exit.code === 0 && accountSucceeded && record.searchResult) {
            const platform = state.platforms[job.platform]
            const result = record.searchResult
            platform.lastRunAt = new Date().toISOString()
            platform.cooldownUntil = new Date(
                Date.now() + randomMinutes(this.document.config.cooldownMinutes) * 60_000
            ).toISOString()
            if (result) {
                const normalized = normalizeSearchResult(result)
                platform.queries += result.queries
                platform.quotaKnown = normalized.quotaKnown
                platform.remaining = normalized.remaining
                platform.complete = normalized.complete
                state.probeUsed[job.platform] = normalized.probeUsed
                if (normalized.quotaKnown && (normalized.complete || searchMadeProgress)) {
                    platform.failures = 0
                    platform.failed = false
                } else {
                    platform.failures += 1
                    platform.failed = platform.failures > this.document.config.retry.maxAttempts
                    platform.cooldownUntil = new Date(
                        Date.now() + this.document.config.retry.backoffMinutes * 60_000 * platform.failures
                    ).toISOString()
                }
                if (result.queries > 0 && result.points > 0)
                    platform.ewmaPointsPerQuery =
                        platform.ewmaPointsPerQuery * 0.7 + (result.points / result.queries) * 0.3
            }
        } else {
            const platform = state.platforms[job.platform]
            platform.failures += 1
            platform.failed = platform.failures > this.document.config.retry.maxAttempts
            platform.lastRunAt = new Date().toISOString()
            platform.cooldownUntil = new Date(
                Date.now() + this.document.config.retry.backoffMinutes * 60_000 * platform.failures
            ).toISOString()
        }
        if (
            record.quotaSnapshot &&
            exit.code === 0 &&
            accountSucceeded &&
            !record.quotaBlocked &&
            parseSearchQuotaSnapshot(JSON.stringify(record.quotaSnapshot))
        ) {
            const profile = this.document.config.profiles.find(p => p.accountIndex === job.accountIndex)
            const observedDay = profile && localParts(new Date(record.quotaSnapshot.readAt), profile.timezone).day
            if (observedDay === state.day) {
                const reopened = reconcileSearchQuota(state, record.quotaSnapshot, {
                    skipPlatform: job.type === 'search' ? job.platform : null
                })
                if (reopened.length)
                    this.onLog({
                        level: 'info',
                        title: 'SMART-QUOTA-REOPEN',
                        message: `accountIndex=${job.accountIndex} | platforms=${reopened.join(',')} | reason=fresh-positive-quota`,
                        smartJobId: job.id
                    })
            }
        }
        applyAppAuthorization(state, record)
        this._save()
        this.replan()
        this.emit('change', this.get())
    }

    async stop({ resume = true } = {}) {
        this.suspended = true
        clearInterval(this.timer)
        this.timer = null
        await Promise.allSettled(
            [...this.running.values()].map(item => {
                if (this.hardParallel != null) {
                    item.handoff = true
                    return item.manager.stop({ signalTree: false, signal: 'SIGUSR1' })
                }
                return item.manager.stop()
            })
        )
        this.suspended = !resume
        if (resume) this._arm()
    }
}
