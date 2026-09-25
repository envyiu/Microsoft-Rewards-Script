import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import { ProcessManager } from './processManager.js'
import { buildSingleAccountEnv, loadAccounts } from './accounts.js'

export const SMART_WORKERS = [
    'dailySet',
    'morePromotions',
    'claimBonusPoints',
    'punchCards',
    'appPromotions',
    'dailyCheckIn',
    'readToEarn',
    'activateSearchPerk',
    'visualSearch',
    'bonusSearches',
    'streakProtection'
]

export const DEFAULT_SMART_CONFIG = {
    enabled: false,
    maxParallel: 2,
    cooldownMinutes: { min: 45, max: 120 },
    searchTarget: { min: 5, max: 10 },
    searchNoise: 3,
    searchSafetyCap: 20,
    retry: { maxAttempts: 3, backoffMinutes: 15 },
    sessionTimeoutMinutes: 45,
    catchUpThresholdMinutes: 120,
    networkGroupOverride: {},
    profiles: []
}

const DEFAULT_ALLOWED_WORKERS = SMART_WORKERS.filter(worker => worker !== 'bonusSearches')

function defaultTimezone() {
    const candidate = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    try {
        new Intl.DateTimeFormat('en', { timeZone: candidate }).format()
        return candidate
    } catch {
        return 'UTC'
    }
}

function fail(message) {
    const error = new Error(message)
    error.code = 'BAD_REQUEST'
    throw error
}

function integer(value, name, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max)
        fail(`${name} must be an integer from ${min} to ${max}.`)
    return value
}

function time(value, name) {
    if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) fail(`${name} must use HH:MM.`)
    return value
}

function normalizeProfile(raw, knownIndexes) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Each smart profile must be an object.')
    const accountIndex = integer(Number(raw.accountIndex), 'profiles[].accountIndex', 1, Number.MAX_SAFE_INTEGER)
    if (!knownIndexes.has(accountIndex)) fail(`ACCOUNT_${accountIndex} is not configured.`)
    const windows = raw.windows ?? [{ start: '07:00', end: '23:00' }]
    const quietHours = raw.quietHours ?? []
    if (!Array.isArray(windows) || windows.length < 1) fail('profiles[].windows must contain at least one window.')
    if (!Array.isArray(quietHours)) fail('profiles[].quietHours must be an array.')
    const allowedWorkers = raw.allowedWorkers ?? DEFAULT_ALLOWED_WORKERS
    if (!Array.isArray(allowedWorkers) || allowedWorkers.some(worker => !SMART_WORKERS.includes(worker))) {
        fail('profiles[].allowedWorkers contains an unknown worker.')
    }
    try {
        new Intl.DateTimeFormat('en', { timeZone: raw.timezone ?? 'UTC' }).format()
    } catch {
        fail('profiles[].timezone must be a valid IANA timezone.')
    }
    return {
        accountIndex,
        timezone: typeof raw.timezone === 'string' && raw.timezone ? raw.timezone : defaultTimezone(),
        windows: windows.map((window, index) => ({
            start: time(window?.start, `profiles[].windows[${index}].start`),
            end: time(window?.end, `profiles[].windows[${index}].end`)
        })),
        quietHours: quietHours.map((window, index) => ({
            start: time(window?.start, `profiles[].quietHours[${index}].start`),
            end: time(window?.end, `profiles[].quietHours[${index}].end`)
        })),
        deadline: time(raw.deadline ?? '23:00', 'profiles[].deadline'),
        allowedWorkers: [...new Set(allowedWorkers)]
    }
}

export function validateSmartConfig(raw, accounts = loadAccounts()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Smart schedule must be a JSON object.')
    const merged = structuredClone(DEFAULT_SMART_CONFIG)
    Object.assign(merged, raw)
    merged.cooldownMinutes = { ...DEFAULT_SMART_CONFIG.cooldownMinutes, ...(raw.cooldownMinutes || {}) }
    merged.searchTarget = { ...DEFAULT_SMART_CONFIG.searchTarget, ...(raw.searchTarget || {}) }
    merged.retry = { ...DEFAULT_SMART_CONFIG.retry, ...(raw.retry || {}) }
    if (typeof merged.enabled !== 'boolean') fail('enabled must be a boolean.')
    integer(merged.maxParallel, 'maxParallel', 1, 32)
    integer(merged.cooldownMinutes.min, 'cooldownMinutes.min', 1, 1440)
    integer(merged.cooldownMinutes.max, 'cooldownMinutes.max', merged.cooldownMinutes.min, 1440)
    integer(merged.searchTarget.min, 'searchTarget.min', 1, 100)
    integer(merged.searchTarget.max, 'searchTarget.max', merged.searchTarget.min, 100)
    integer(merged.searchNoise, 'searchNoise', 0, 20)
    integer(merged.searchSafetyCap, 'searchSafetyCap', 1, 100)
    integer(merged.retry.maxAttempts, 'retry.maxAttempts', 0, 10)
    integer(merged.retry.backoffMinutes, 'retry.backoffMinutes', 1, 1440)
    integer(merged.sessionTimeoutMinutes, 'sessionTimeoutMinutes', 5, 360)
    integer(merged.catchUpThresholdMinutes, 'catchUpThresholdMinutes', 1, 1440)
    if (
        !merged.networkGroupOverride ||
        typeof merged.networkGroupOverride !== 'object' ||
        Array.isArray(merged.networkGroupOverride)
    ) {
        fail('networkGroupOverride must be an object keyed by account index.')
    }
    const knownIndexes = new Set(accounts.map(account => account.index))
    const profiles = raw.profiles?.length
        ? raw.profiles.map(profile => normalizeProfile(profile, knownIndexes))
        : accounts.map(account => normalizeProfile({ accountIndex: account.index }, knownIndexes))
    if (new Set(profiles.map(profile => profile.accountIndex)).size !== profiles.length)
        fail('profiles accountIndex values must be unique.')
    merged.profiles = profiles
    return merged
}

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
    if (platformState.quotaKnown === false && probeUsed) return false
    return true
}

export function dailySetDependencySatisfied(profile, configuredWorkers, state) {
    const dailySetEnabled = profile.allowedWorkers.includes('dailySet') && configuredWorkers.doDailySet === true
    return !dailySetEnabled || state.workersCompleted.includes('dailySet')
}

const APP_WORKERS = ['dailyCheckIn', 'readToEarn', 'appPromotions']
const LIGHT_BROWSER_WORKERS = ['morePromotions', 'streakProtection', 'punchCards']

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

export function deriveNetworkGroup(account, overrides = {}) {
    const override = overrides[String(account.index)]
    if (typeof override === 'string' && override.trim()) return override.trim()
    if (!account.proxy) return 'DIRECT'
    let host = account.proxy.url
    try {
        host = new URL(account.proxy.url).hostname
    } catch {}
    return `PROXY:${String(host).toLowerCase()}:${account.proxy.port ?? ''}`
}

export function selectRunnableJobs(jobs, { now = Date.now(), limit = 1, busyGroups = new Set(), force = false } = {}) {
    const selected = []
    const groups = new Set(busyGroups)
    for (const job of jobs) {
        if (selected.length >= limit) break
        if (!job.dueAt || (!force && new Date(job.dueAt).getTime() > now) || groups.has(job.networkGroup)) continue
        selected.push(job)
        groups.add(job.networkGroup)
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
    constructor({ projectRoot, command, args, stopTimeoutMs, configFile, onLog = () => {} }) {
        super()
        this.setMaxListeners(0)
        this.projectRoot = projectRoot
        this.command = command
        this.args = args
        this.stopTimeoutMs = stopTimeoutMs
        this.configFile = configFile
        this.onLog = onLog
        this.running = new Map()
        this.queue = []
        this.timer = null
        this.suspended = false
        this.document = this._load()
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
            running: [...this.running.values()].map(item => ({
                ...item.job,
                pid: item.manager.pid,
                startedAt: item.startedAt
            })),
            accounts: structuredClone(this.document.state.accounts),
            sessions: structuredClone(this.document.state.sessions.slice(-100).reverse()),
            updatedAt: this.document.state.updatedAt,
            cronExcluded: this.document.config.enabled
        }
    }

    update(config) {
        this.document.config = validateSmartConfig(config)
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
            state = {
                day,
                email: account.email,
                workersCompleted: [],
                workersFailed: [],
                workerFailures: {},
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

    replan({ accountIndexes = null } = {}) {
        const now = new Date()
        const accounts = loadAccounts()
        const selected = accountIndexes ? new Set(accountIndexes.map(Number)) : null
        let botConfig = {}
        try {
            botConfig = JSON.parse(fs.readFileSync(path.join(this.projectRoot, 'config.json'), 'utf8'))
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
            const state = this._accountState(account, profile, now)
            const { minute } = localParts(now, profile.timezone)
            const allowedNow =
                profile.windows.some(window => inRange(minute, window)) &&
                !profile.quietHours.some(window => inRange(minute, window))
            const deadline = minuteOf(profile.deadline)
            const minutesLeft = Math.max(1, deadline >= minute ? deadline - minute : deadline + 1440 - minute)
            const deadlineRisk = minutesLeft <= this.document.config.catchUpThresholdMinutes
            const group = deriveNetworkGroup(account, this.document.config.networkGroupOverride)
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
                const workers = selectWorkerSession(schedulableWorkers, {
                    dailySetCompleted: dailySetDependencySatisfied(profile, configuredWorkers, state)
                })
                if (workers.length) {
                    const workerDue = state.nextWorkerAt ? new Date(state.nextWorkerAt).getTime() : Date.now()
                    const attempts = Math.max(...workers.map(worker => state.workerFailures[worker] ?? 0))
                    jobs.push({
                        id: `${state.day}-${account.index}-workers-${workers.join('-')}`,
                        accountIndex: account.index,
                        email: account.email,
                        networkGroup: group,
                        type: 'workers',
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
            for (const platform of ['mobile', 'desktop']) {
                if (searchDependenciesPending) continue
                if (configuredWorkers[platform === 'mobile' ? 'doMobileSearch' : 'doDesktopSearch'] !== true) continue
                const platformState = state.platforms[platform]
                if (!shouldPlanSearch(platformState, state.probeUsed[platform])) continue
                const last = platformState.lastRunAt ? new Date(platformState.lastRunAt).getTime() : 0
                const randomDue = platformState.cooldownUntil
                    ? new Date(platformState.cooldownUntil).getTime()
                    : last + this.document.config.cooldownMinutes.min * 60_000
                const minimumDue = last + this.document.config.cooldownMinutes.min * 60_000
                const dueMs = deadlineRisk ? minimumDue : randomDue
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
                    accountIndex: account.index,
                    email: account.email,
                    networkGroup: group,
                    type: 'search',
                    platform,
                    baseBudget: budget.baseBudget,
                    searchBudget: budget.actualBudget,
                    noise: budget.noise,
                    dueAt: allowedNow ? new Date(Math.max(Date.now(), dueMs)).toISOString() : null,
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
            .filter(job => !activeIds.has(job.id))
            .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)))
        this._save()
        this._drain()
        return this.get()
    }

    trigger(accountIndexes = null, { force = false } = {}) {
        this.replan({ accountIndexes })
        if (force && this.document.config.enabled) this._drain(true)
        return this.get()
    }

    enrollAccounts(accountIndexes = []) {
        const indexes = [...new Set(accountIndexes.map(Number))].filter(index => Number.isSafeInteger(index) && index > 0)
        if (!indexes.length) return this.get()
        const accounts = loadAccounts()
        const known = new Set(this.document.config.profiles.map(profile => profile.accountIndex))
        const template = this.document.config.profiles[0] ?? {
            timezone: defaultTimezone(),
            windows: [{ start: '07:00', end: '23:00' }],
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
        if (!this.document.config.enabled) return
        this.timer = setInterval(() => {
            this.replan()
        }, 30_000)
        this.timer.unref?.()
        this._drain()
    }

    _drain(force = false) {
        if (this.suspended) return
        if (!this.document.config.enabled && !force) return
        const busyGroups = new Set([...this.running.values()].map(item => item.job.networkGroup))
        const jobs = selectRunnableJobs(this.queue, {
            limit: this.document.config.maxParallel - this.running.size,
            busyGroups,
            force
        })
        for (const job of jobs) {
            this.queue = this.queue.filter(item => item !== job)
            this._start(job)
        }
        this.emit('change', this.get())
    }

    _start(job) {
        const selection = buildSingleAccountEnv(job.accountIndex)
        const plan =
            job.type === 'search'
                ? { version: 1, jobId: job.id, type: 'search', platform: job.platform, searchBudget: job.searchBudget }
                : { version: 1, jobId: job.id, type: 'workers', workers: job.workers }
        const manager = new ProcessManager({
            command: this.command,
            args: this.args,
            cwd: this.projectRoot,
            stopTimeoutMs: this.stopTimeoutMs,
            name: `smart-${job.accountIndex}`
        })
        const record = {
            job,
            manager,
            startedAt: new Date().toISOString(),
            searchResult: null,
            workerResults: new Set(),
            timedOut: false,
            timeout: null
        }
        this.running.set(job.id, record)
        manager.on('log', entry => {
            this.onLog({ ...entry, smartJobId: job.id })
            if (entry.title === 'SMART-SEARCH-END') {
                const fields = Object.fromEntries(entry.message.split(' | ').map(part => part.split('=')))
                record.searchResult = {
                    queries: Number(fields.queries),
                    points: Number(fields.points),
                    remaining: Number(fields.remaining),
                    quotaAvailable: fields.quotaAvailable === 'true'
                }
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
        const runAccounts = record.manager.getStatus().run.accounts ?? []
        const accountSucceeded = runAccounts.length > 0 && runAccounts.every(account => account.success === true)
        const completedWorkers =
            job.type === 'workers' && accountSucceeded && exit.code === 0
                ? job.workers.filter(worker => record.workerResults.has(worker))
                : []
        const missingWorkers = job.type === 'workers' ? job.workers.filter(worker => !completedWorkers.includes(worker)) : []
        const succeeded =
            exit.code === 0 &&
            accountSucceeded &&
            (job.type === 'search' ? record.searchResult != null : job.type === 'workers' ? missingWorkers.length === 0 : true)
        this.document.state.sessions.push({
            ...job,
            startedAt: record.startedAt,
            endedAt: new Date().toISOString(),
            success: succeeded,
            timedOut: record.timedOut,
            exit
        })
        if (this.document.state.sessions.length > 500)
            this.document.state.sessions.splice(0, this.document.state.sessions.length - 500)
        if (this.suspended && exit.code !== 0) {
            const cooldownUntil = new Date(Date.now() + this.document.config.cooldownMinutes.min * 60_000).toISOString()
            if (job.type === 'workers') state.nextWorkerAt = cooldownUntil
            else {
                state.platforms[job.platform].lastRunAt = new Date().toISOString()
                state.platforms[job.platform].cooldownUntil = cooldownUntil
            }
            this._save()
            this.replan()
            this.emit('change', this.get())
            return
        }
        if (job.type === 'workers') {
            if (completedWorkers.length) {
                state.workersCompleted = [...new Set([...state.workersCompleted, ...completedWorkers])]
                for (const worker of completedWorkers) state.workerFailures[worker] = 0
            }
            if (!missingWorkers.length) {
                state.nextWorkerAt = new Date(
                    Date.now() + randomMinutes(this.document.config.cooldownMinutes) * 60_000
                ).toISOString()
            } else {
                const retryAt = new Date(
                    Date.now() + this.document.config.retry.backoffMinutes * 60_000 * (job.attempts + 1)
                ).toISOString()
                state.nextWorkerAt = retryAt
                for (const worker of missingWorkers) {
                    state.workerFailures[worker] = (state.workerFailures[worker] ?? 0) + 1
                    if (state.workerFailures[worker] > this.document.config.retry.maxAttempts)
                        state.workersFailed.push(worker)
                }
                state.workersFailed = [...new Set(state.workersFailed)]
            }
        } else if (succeeded) {
            if (job.type === 'search') {
                const platform = state.platforms[job.platform]
                const result = record.searchResult
                platform.failures = 0
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
                    if (result.queries > 0 && result.points > 0)
                        platform.ewmaPointsPerQuery =
                            platform.ewmaPointsPerQuery * 0.7 + (result.points / result.queries) * 0.3
                }
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
        this._save()
        this.replan()
        this.emit('change', this.get())
    }

    async stop({ resume = true } = {}) {
        this.suspended = true
        clearInterval(this.timer)
        this.timer = null
        await Promise.allSettled([...this.running.values()].map(item => item.manager.stop()))
        this.suspended = !resume
        if (resume) this._arm()
    }
}
