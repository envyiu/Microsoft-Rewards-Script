import { newAccountStatus, preRewardsActive } from '../../../packages/contracts/newAccount.js'
import { deriveNetworkGroup } from '../../../packages/contracts/smartConfig.js'
import { dailySearchRemaining } from '../dailySearch.js'
import { planNormalAccountJob } from './NormalSessionPlanner.js'
import {
    MAX_QUOTA_CHECKS_PER_DAY,
    QUOTA_CHECK_INTERVAL_MS,
    WORKER_FLAGS,
    earnRecheckDue,
    inRange,
    localParts,
    minuteOf
} from './ScheduleStore.js'
import { planWarmupAccountJobs } from './WarmupPlanner.js'

const APP_WORKERS = ['dailyCheckIn', 'readToEarn', 'appPromotions']
const LIGHT_BROWSER_WORKERS = ['morePromotions', 'streakProtection', 'punchCards']

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
    if (platformState.complete || platformState.dailySearchComplete || platformState.failed) return false
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

export function selectUrgentWorkerSession(pendingWorkers, { dailySetCompleted = false, searchPending = false } = {}) {
    const pending = [...new Set(pendingWorkers)]
    if (pending.includes('dailySet')) {
        return ['dailySet', ...LIGHT_BROWSER_WORKERS.filter(worker => pending.includes(worker))]
    }
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

export function selectWorkerSession(pendingWorkers, { dailySetCompleted = false } = {}) {
    const pending = [...new Set(pendingWorkers)]
    const has = worker => pending.includes(worker)
    const pair = (first, candidates) => {
        const second = candidates.find(worker => worker !== first && has(worker))
        return second ? [first, second] : [first]
    }

    if (has('dailySet')) return pair('dailySet', LIGHT_BROWSER_WORKERS)
    if (has('readToEarn')) return pair('readToEarn', APP_WORKERS)

    const available = pending.filter(worker => worker !== 'activateSearchPerk' || dailySetCompleted)
    if (dailySetCompleted && available.includes('activateSearchPerk')) {
        return pair('activateSearchPerk', LIGHT_BROWSER_WORKERS)
    }

    const appWorker = APP_WORKERS.find(worker => available.includes(worker))
    if (appWorker) return pair(appWorker, [...APP_WORKERS, ...LIGHT_BROWSER_WORKERS])

    const lightWorker = LIGHT_BROWSER_WORKERS.find(worker => available.includes(worker))
    if (lightWorker) return pair(lightWorker, LIGHT_BROWSER_WORKERS)

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
        ) {
            continue
        }
        selected.push(job)
        groups.add(job.networkGroup)
        if (job.accountIndex != null) accounts.add(job.accountIndex)
    }
    return selected
}

export const legacyPlannerMethods = {
    replan({ accountIndexes = null } = {}) {
        const now = new Date()
        const accounts = this._cachedAccounts()
        const selected = accountIndexes ? new Set(accountIndexes.map(Number)) : null
        const botConfig = this._cachedBotConfig()
        const configuredWorkers = botConfig.workers ?? {}
        const jobs = []

        for (const profile of this.document.config.profiles) {
            if (selected && !selected.has(profile.accountIndex)) continue
            const account = accounts.find(item => item.index === profile.accountIndex)
            if (!account) continue
            if (this.accountFilter && !this.accountFilter(account)) continue
            const state = this._accountState(account, profile, now)
            for (const platform of ['mobile', 'desktop']) {
                dailySearchRemaining(
                    state,
                    this.document.config.dailySearchLimits,
                    platform,
                    this.document.config.streakSearchV1
                )
            }
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
                planWarmupAccountJobs(this, account, state, group, allowedNow, jobs)
                continue
            }

            if (account.newAccountMode) {
                if (!state.newAccount.activatedAt) {
                    state.newAccount.activatedAt = new Date().toISOString()
                    for (const progress of Object.values(state.platforms)) {
                        Object.assign(progress, {
                            queries: 0,
                            remaining: null,
                            quotaKnown: false,
                            complete: false,
                            failed: false,
                            failures: 0,
                            cooldownUntil: null,
                            lastRunAt: null
                        })
                    }
                }
                state.newAccountStatus = newAccountStatus(account, state)
            }

            state.enabledPlatforms = ['mobile', 'desktop'].filter(
                platform => configuredWorkers[platform === 'mobile' ? 'doMobileSearch' : 'doDesktopSearch'] === true
            )
            const pendingWorkers = profile.allowedWorkers.filter(
                worker =>
                    !(this.document.config.normalPolicy?.enabled && worker === 'bonusSearches') &&
                    !state.workersCompleted.includes(worker) &&
                    !state.workersFailed.includes(worker) &&
                    (worker === 'streakProtection'
                        ? botConfig.ensureStreakProtection === true
                        : configuredWorkers[WORKER_FLAGS[worker]] === true)
            )
            const dailySetFailed = state.workersFailed.includes('dailySet')
            const blockedWorkers =
                dailySetFailed && pendingWorkers.includes('activateSearchPerk') ? ['activateSearchPerk'] : []
            const schedulableWorkers = pendingWorkers.filter(worker => !blockedWorkers.includes(worker))
            state.pendingWorkers = [...schedulableWorkers]
            state.blockedWorkers = blockedWorkers

            if (this.document.config.normalPolicy?.enabled) {
                planNormalAccountJob(
                    this,
                    {
                        account,
                        profile,
                        state,
                        configuredWorkers,
                        schedulableWorkers,
                        group,
                        allowedNow,
                        urgent,
                        deadlineRisk
                    },
                    jobs
                )
                continue
            }

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

            const earnAllowed =
                configuredWorkers.doMorePromotions === true && profile.allowedWorkers.includes('morePromotions')
            if (
                earnAllowed &&
                allowedNow &&
                minute <= deadline &&
                deadline - minute <= 45 &&
                !state.earnFinalCheckAt &&
                earnRecheckDue(state) &&
                !pendingWorkers.includes('morePromotions')
            ) {
                jobs.push({
                    id: `${state.day}-${account.index}-earn-final`,
                    day: state.day,
                    accountIndex: account.index,
                    email: account.email,
                    networkGroup: group,
                    type: 'workers',
                    workers: ['morePromotions'],
                    urgent: false,
                    earnFinalCheck: true,
                    dueAt: new Date().toISOString(),
                    reason: 'earn-final-recheck',
                    attempts: 0
                })
            }

            for (const platform of ['mobile', 'desktop']) {
                if (searchDependenciesPending) continue
                if (configuredWorkers[platform === 'mobile' ? 'doMobileSearch' : 'doDesktopSearch'] !== true) continue
                const platformState = state.platforms[platform]
                if (!shouldPlanSearch(platformState, state.probeUsed[platform])) continue
                const dailyRemaining = dailySearchRemaining(
                    state,
                    this.document.config.dailySearchLimits,
                    platform,
                    this.document.config.streakSearchV1
                )
                if (dailyRemaining === 0) continue
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
                    recheckEarn: earnAllowed && earnRecheckDue(state),
                    urgent,
                    platform,
                    baseBudget: budget.baseBudget,
                    searchBudget: Math.min(
                        5,
                        this.document.config.streakSearchV1 ? 5 : budget.actualBudget,
                        dailyRemaining ?? Infinity
                    ),
                    noise: budget.noise,
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
                const aged = job =>
                    job.type === 'accountSession' &&
                    job.readySince &&
                    Date.now() - Date.parse(job.readySince) >= 2 * 3600000
                if (Boolean(aged(a)) !== Boolean(aged(b))) return Number(Boolean(aged(b))) - Number(Boolean(aged(a)))
                const criticalDaily = job => {
                    if (job.type !== 'workers' && job.type !== 'accountSession') return false
                    const failures = this.document.state.accounts[String(job.accountIndex)]?.workerFailures || {}
                    return job.workers.some(
                        worker => ['dailySet', 'readToEarn'].includes(worker) && !(failures[worker] > 0)
                    )
                }
                if (criticalDaily(a) !== criticalDaily(b)) return Number(criticalDaily(b)) - Number(criticalDaily(a))
                if (Boolean(a.deadlineRisk) !== Boolean(b.deadlineRisk)) {
                    return Number(Boolean(b.deadlineRisk)) - Number(Boolean(a.deadlineRisk))
                }
                if (a.type === 'accountSession' && b.type === 'accountSession') {
                    const fair =
                        a.sessionsUsed - b.sessionsUsed ||
                        String(a.lastEndedAt || '').localeCompare(String(b.lastEndedAt || ''))
                    if (fair) return fair
                }
                if ((a.type === 'quota') !== (b.type === 'quota')) {
                    return Number(b.type === 'quota') - Number(a.type === 'quota')
                }
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

        if (this.document.state.onceAccounts) {
            this.document.state.onceAccounts = this.document.state.onceAccounts.filter(index => {
                const state = this.document.state.accounts[String(index)]
                return (
                    this.queue.some(job => job.accountIndex === index) ||
                    [...this.running.values()].some(record => record.job.accountIndex === index) ||
                    Boolean(state?.pendingWorkers?.length) ||
                    Boolean(
                        state?.enabledPlatforms?.some(
                            p =>
                                !state.platforms[p].complete &&
                                !state.platforms[p].dailySearchComplete &&
                                !state.platforms[p].failed
                        )
                    )
                )
            })
        }

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
}
