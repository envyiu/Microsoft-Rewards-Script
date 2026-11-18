import {
    NEW_ACCOUNT_QUERIES,
    NEW_ACCOUNT_SERVICES,
    newAccountDurationMs,
    newAccountPolicy,
    newAccountStatus,
    preRewardsActive
} from '../../../packages/contracts/newAccount.js'
import { dailySearchRemaining, settleDailySearch } from '../dailySearch.js'
import { calculateSearchDue } from './LegacyPlanner.js'
import { randomMinutes } from './ScheduleStore.js'

export function planWarmupAccountJobs(scheduler, account, state, group, allowedNow, jobs) {
    state.newAccount ??= { services: [] }
    state.newAccount.policy ??= newAccountPolicy(account, state)
    state.pendingWorkers = []
    state.blockedWorkers = []
    state.newAccountStatus = newAccountStatus(account, state)
    for (const platform of ['desktop', 'mobile']) {
        const progress = state.platforms[platform]
        state.warmupReservations ??= {
            baseline: Object.fromEntries(
                ['desktop', 'mobile'].map(p => [
                    p,
                    Math.max(state.platforms[p].queries || 0, state.learningQueries?.[p] || 0)
                ])
            ),
            entries: {}
        }
        const reserved =
            (state.warmupReservations.baseline[platform] || 0) +
            Object.values(state.warmupReservations.entries)
                .filter(entry => entry.platform === platform)
                .reduce((sum, entry) => sum + (entry.used ?? entry.budget), 0)
        const allowance = Math.max(0, NEW_ACCOUNT_QUERIES[platform] - Math.max(progress.queries, reserved))
        const dailyRemaining = dailySearchRemaining(
            state,
            scheduler.document.config.dailySearchLimits,
            platform,
            scheduler.document.config.streakSearchV1
        )
        const remaining = Math.min(
            NEW_ACCOUNT_QUERIES[platform] - progress.queries,
            allowance,
            dailyRemaining ?? Infinity
        )
        state.newAccount.queryCapsReached ??= []
        state.newAccount.queryCapsReached = state.newAccount.queryCapsReached.filter(p => p !== platform)
        if (allowance === 0 && progress.queries < NEW_ACCOUNT_QUERIES[platform]) {
            state.newAccount.queryCapsReached.push(platform)
        }
        const services =
            state.newAccount.policy !== 'search72h' &&
            platform === 'desktop' &&
            (state.newAccount.serviceAttempts || 0) < 3
                ? NEW_ACCOUNT_SERVICES.filter(
                      s => !state.newAccount.services?.includes(s) || !state.newAccount.serviceActions?.includes(s)
                  )
                : []
        if ((remaining <= 0 && !services.length) || progress.failed) continue
        const due = calculateSearchDue({
            ...progress,
            minCooldownMinutes: scheduler.document.config.cooldownMinutes.min
        })
        jobs.push({
            id: `${state.day}-${account.index}-warmup-${platform}-${progress.queries}`,
            day: state.day,
            accountIndex: account.index,
            email: account.email,
            networkGroup: group,
            type: 'warmup',
            platform,
            services,
            newAccountPolicy: state.newAccount.policy,
            workers: [],
            searchBudget: Math.max(0, Math.min(5, remaining)),
            urgent: false,
            dueAt: allowedNow ? new Date(due).toISOString() : null,
            reason: allowedNow ? 'new-account' : 'outside-run-window',
            attempts: progress.failures || 0
        })
    }
    state.newAccountStatus = newAccountStatus(account, state)
}

export function finishWarmupSession(scheduler, record, exit, state) {
    const { job } = record
    if (!record.manager.pid && exit.error) {
        settleDailySearch(state, job, 0)
        if (state?.warmupReservations?.entries?.[job.warmupReservation]) {
            state.warmupReservations.entries[job.warmupReservation].used = 0
        }
    }
    const succeeded = exit.code === 0 && (record.warmupQueries || 0) === job.searchBudget
    if (state?.day === job.day) {
        const progress = state.platforms[job.platform]
        if (!record.handoff) {
            const reserved = state.warmupReservations
                ? (state.warmupReservations.baseline[job.platform] || 0) +
                  Object.values(state.warmupReservations.entries)
                      .filter(entry => entry.platform === job.platform)
                      .reduce((sum, entry) => sum + (entry.used ?? entry.budget), 0)
                : 0
            const capped = Math.max(progress.queries, reserved) >= NEW_ACCOUNT_QUERIES[job.platform]
            progress.failures = succeeded || capped ? 0 : (progress.failures || 0) + 1
            progress.failed = progress.failures > scheduler.document.config.retry.maxAttempts
            progress.lastRunAt = new Date().toISOString()
            progress.cooldownUntil = new Date(
                Date.now() +
                    (succeeded
                        ? randomMinutes(scheduler.document.config.cooldownMinutes)
                        : scheduler.document.config.retry.backoffMinutes * progress.failures) *
                        60_000
            ).toISOString()
            state.newAccount ??= { services: [] }
            state.newAccount.needsAction = !succeeded && !capped
            state.newAccount.servicesPending =
                state.newAccount.policy === 'search72h'
                    ? []
                    : NEW_ACCOUNT_SERVICES.filter(
                          s => !state.newAccount.services?.includes(s) || !state.newAccount.serviceActions?.includes(s)
                      )
        }
        state.newAccountStatus = newAccountStatus(
            scheduler._cachedAccounts().find(a => a.index === job.accountIndex),
            state
        )
    }
    scheduler.document.state.sessions.push({
        ...job,
        executionId: record.executionId,
        startedAt: record.startedAt,
        endedAt: new Date().toISOString(),
        success: succeeded,
        interrupted: Boolean(record.handoff),
        queries: record.warmupQueries || 0,
        exit
    })
    scheduler.document.state.sessions = scheduler.document.state.sessions.slice(-500)
    scheduler._save()
    scheduler.replan()
    scheduler.emit('change', scheduler.get())
}

export const warmupMethods = {
    isPreRewardsAccount(index) {
        const account = this._cachedAccounts().find(a => a.index === Number(index))
        return preRewardsActive(account, this.document.state.accounts[String(index)])
    },

    _newAccountCheckpoint(record, entryOrPayload) {
        if (record.job.type !== 'warmup') return
        const state = this.document.state.accounts[String(record.job.accountIndex)]
        if (!state) return
        let payload
        if (
            entryOrPayload &&
            typeof entryOrPayload === 'object' &&
            entryOrPayload.jobId !== undefined &&
            typeof entryOrPayload.message !== 'string'
        ) {
            payload = entryOrPayload
        } else {
            try {
                payload = JSON.parse(entryOrPayload?.message)
            } catch {
                return
            }
        }
        if (
            payload.jobId !== record.job.id ||
            !Number.isSafeInteger(payload.queries) ||
            payload.queries < 0 ||
            payload.queries > record.job.searchBudget ||
            !Number.isFinite(Date.parse(payload.at))
        ) {
            return
        }
        state.newAccount ??= { services: [] }
        if (!Array.isArray(payload.services)) return
        if (state.day === record.job.day) {
            state.newAccount.services = [
                ...new Set([
                    ...(state.newAccount.services || []),
                    ...payload.services.filter(s => record.job.services.includes(s))
                ])
            ]
            if (Array.isArray(payload.serviceActions)) {
                state.newAccount.serviceActions = [
                    ...new Set([
                        ...(state.newAccount.serviceActions || []),
                        ...payload.serviceActions.filter(
                            s => record.job.services.includes(s) && payload.services.includes(s)
                        )
                    ])
                ]
            }
            if (Array.isArray(payload.artifacts)) {
                state.newAccount.artifacts = [
                    ...new Set([
                        ...(state.newAccount.artifacts || []),
                        ...payload.artifacts.filter(
                            s =>
                                ['onedrive', 'todo'].includes(s) &&
                                record.job.services.includes(s) &&
                                payload.serviceActions?.includes(s)
                        )
                    ])
                ]
            }
            const delta = Math.max(0, payload.queries - (record.warmupQueries || 0))
            state.platforms[record.job.platform].queries += delta
        }
        record.warmupQueries = Math.max(record.warmupQueries || 0, payload.queries)
        if (payload.queries > 0 && !state.newAccount.startedAt) {
            state.newAccount.policy ??= record.job.newAccountPolicy || 'standard168h'
            const duration = newAccountDurationMs(state.newAccount.policy)
            const hasLifetimeEvidence =
                payload.policy === state.newAccount.policy &&
                Number.isFinite(Date.parse(payload.startedAt)) &&
                Date.parse(payload.startedAt) <= Date.parse(payload.at) &&
                Date.parse(payload.readyAt) - Date.parse(payload.startedAt) === duration
            state.newAccount.startedAt = hasLifetimeEvidence ? payload.startedAt : payload.at
            state.newAccount.readyAt = hasLifetimeEvidence
                ? payload.readyAt
                : new Date(Date.parse(payload.at) + duration).toISOString()
        }
        state.newAccount.needsAction = false
        this._save()
    }
}
