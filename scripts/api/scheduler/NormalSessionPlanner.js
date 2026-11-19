import fs from 'node:fs'

import { decorateBlockers } from '../../../packages/contracts/configMetadata.js'
import { deriveNetworkGroup } from '../../../packages/contracts/smartConfig.js'
import { APP_AUTH_WORKERS, applyAppAuthorization } from '../appAuthorization.js'
import { dailySearchRemaining, settleDailySearch } from '../dailySearch.js'
import { protectionFor, recordSessionOutcome, selectAccountTasks, sessionEligibility } from '../normalPolicy.js'
import { reconcileSearchQuota } from '../searchQuotaSnapshot.js'
import { dailySetDependencySatisfied, normalizeSearchResult, selectRunnableJobs } from './LegacyPlanner.js'
import { applyEarnScan, earnRecheckDue } from './ScheduleStore.js'

export function planNormalAccountJob(
    scheduler,
    { account, profile, state, configuredWorkers, schedulableWorkers, group, allowedNow, urgent, deadlineRisk },
    jobs
) {
    const policy = scheduler.document.config.normalPolicy
    const guard = protectionFor(state)
    state.normalPolicyStatus = scheduler._eligibilityForDispatch(account.index, state)
    const dailySetCompleted = dailySetDependencySatisfied(profile, configuredWorkers, state)
    const ready = schedulableWorkers.filter(
        w => Date.parse(state.workerRetryAt[w] || '') <= Date.now() || !state.workerRetryAt[w]
    )
    let batch = selectAccountTasks(ready, dailySetCompleted, policy.maxTasks)
    const candidates = state.enabledPlatforms
        .filter(
            p =>
                !state.platforms[p].failed &&
                !state.platforms[p].complete &&
                (dailySearchRemaining(
                    state,
                    scheduler.document.config.dailySearchLimits,
                    p,
                    scheduler.document.config.streakSearchV1
                ) ?? 1) > 0
        )
        .sort(
            (a, b) =>
                (Date.parse(guard.lastServed?.[a] || '') || 0) - (Date.parse(guard.lastServed?.[b] || '') || 0) ||
                Number(state.platforms[b].quotaKnown && state.platforms[b].remaining > 0) -
                    Number(state.platforms[a].quotaKnown && state.platforms[a].remaining > 0) ||
                (a === 'desktop' ? -1 : 1)
        )

    if (!batch.workers.length && !candidates.length && schedulableWorkers.length) {
        batch = selectAccountTasks(schedulableWorkers, dailySetCompleted, policy.maxTasks)
    }

    const searchPlatform = candidates[0]
    if (
        batch.workers.length &&
        searchPlatform &&
        searchPlatform !== batch.environment &&
        dailySetCompleted &&
        guard.lastServed?.[batch.environment] &&
        (Date.parse(guard.lastServed?.[searchPlatform] || '') || 0) < Date.parse(guard.lastServed[batch.environment])
    ) {
        batch.workers = []
        batch.environment = searchPlatform
    }
    const platform = batch.workers.length ? batch.environment : candidates[0]
    if (
        platform === 'desktop' &&
        (batch.workers.length || candidates.length) &&
        batch.workers.length < policy.maxTasks &&
        configuredWorkers.doMorePromotions === true &&
        profile.allowedWorkers.includes('morePromotions') &&
        earnRecheckDue(state) &&
        !batch.workers.includes('morePromotions')
    ) {
        batch.workers.push('morePromotions')
    }
    if (platform && (batch.workers.length || candidates.length)) {
        const status = state.normalPolicyStatus
        const retryAt = Math.max(
            0,
            ...batch.workers.map(w => Date.parse(state.workerRetryAt[w] || '') || 0),
            Date.parse(state.platforms[platform].cooldownUntil || '') || 0
        )
        const due = Math.max(Date.now(), Date.parse(status.nextEligibleAt || '') || 0, retryAt)
        const attempts = batch.workers.length ? Math.max(0, ...batch.workers.map(w => state.workerFailures[w] || 0)) : 0
        if (allowedNow && !status.blockedReason && retryAt <= Date.now()) state.readySince ||= new Date().toISOString()
        else state.readySince = null
        jobs.push({
            id: `${state.day}-${account.index}-session-${guard.sessions.length}`,
            day: state.day,
            accountIndex: account.index,
            email: account.email,
            networkGroup: group,
            type: 'accountSession',
            workers: batch.workers,
            environment: platform,
            platform,
            searchBudget: policy.maxQueries,
            normalSearchBudget:
                state.enabledPlatforms.includes(platform) &&
                !state.platforms[platform].complete &&
                !state.platforms[platform].failed
                    ? Math.min(
                          policy.maxQueries,
                          dailySearchRemaining(
                              state,
                              scheduler.document.config.dailySearchLimits,
                              platform,
                              scheduler.document.config.streakSearchV1
                          ) ?? policy.maxQueries
                      )
                    : 0,
            urgent,
            sessionsUsed: status.sessionsUsed,
            deadlineRisk,
            readySince: state.readySince,
            lastEndedAt: guard.sessions.filter(s => !s.refunded).at(-1)?.endedAt || null,
            dueAt: allowedNow && status.nextEligibleAt ? new Date(due).toISOString() : null,
            reason:
                status.blockedReason ||
                (allowedNow ? (retryAt > Date.now() ? 'retry-backoff' : 'ready') : 'outside-run-window'),
            recovery: status.recovery,
            attempts
        })
    }
}

export const normalPlannerMethods = {
    evaluateAccountLocks(index, state, now = Date.now()) {
        const numericIndex = Number(index)
        const status = this._eligibilityForDispatch(numericIndex, state, now)
        const runningValues = this.running ? [...this.running.values()] : []
        const running = runningValues.some(r => r.job.accountIndex === numericIndex)
        if (status.blockedReason === 'SESSION_UNCERTAIN' && running) {
            status.blockedReason = 'SESSION_ACTIVE'
            status.recovery = 'running'
            status.blockers = status.blockers.filter(b => b.code !== 'SESSION_UNCERTAIN')
        }
        if (running)
            status.blockers.push({ code: 'SESSION_ACTIVE', scope: 'account', source: 'running', retryAt: null })
        if (this.manualLocks?.has(numericIndex)) {
            status.blockers.push({
                code: 'ACCOUNT_HELD',
                scope: 'account',
                source: 'manual-or-transfer',
                retryAt: null
            })
        }
        if (state.operatorPaused) {
            status.blockers.push({ code: 'ACCOUNT_PAUSED', scope: 'account', source: 'operator', retryAt: null })
        }
        if (this.maintenance) {
            status.blockers.push({ code: 'UPDATE_IN_PROGRESS', scope: 'node', source: 'maintenance', retryAt: null })
        }
        if (Date.parse(state.manualStopUntil || '') > now) {
            status.blockers.push({
                code: 'STOP_COOLDOWN',
                scope: 'account',
                source: 'stop',
                retryAt: state.manualStopUntil
            })
        }
        const account = this._cachedAccounts().find(a => a.index === numericIndex)
        const group = account && deriveNetworkGroup(account, this.document.config.networkGroupOverride)
        if (group && runningValues.some(r => r.job.accountIndex !== numericIndex && r.job.networkGroup === group)) {
            status.blockers.push({ code: 'PROXY_BUSY', scope: 'network', source: 'running', retryAt: null })
        }
        status.blockers = decorateBlockers(status.blockers)
        return status
    },

    _normalStatus(index, state) {
        return this.evaluateAccountLocks(index, state)
    },

    _eligibilityForDispatch(index, state, now = Date.now()) {
        const policy = this.document.config.normalPolicy
        const requested = this.document.state.onceAccounts?.includes(index) || this.runNextRestOverrides?.has(index)
        return sessionEligibility(state, requested ? { ...policy, restMinutes: 0 } : policy, now)
    },

    _grantRunNextRestOverrides() {
        const policy = this.document.config.normalPolicy
        const now = Date.now()
        const busyAccounts = new Set([...this.running.values()].map(r => r.job.accountIndex))
        const busyGroups = new Set([...this.running.values()].map(r => r.job.networkGroup))
        for (const [index, group] of this.manualLocks ?? []) {
            busyAccounts.add(index)
            if (group) busyGroups.add(group)
        }
        const candidates = this.queue.filter(job => {
            if (job.type !== 'accountSession' || !job.dueAt) return false
            const state = this.document.state.accounts[String(job.accountIndex)]
            if (
                sessionEligibility(state, policy).blockedReason !== 'SESSION_REST' ||
                sessionEligibility(state, { ...policy, restMinutes: 0 }).blockedReason
            ) {
                return false
            }
            if (
                state.operatorPaused ||
                Date.parse(state.manualStopUntil || '') > now ||
                Date.parse(state.platforms[job.platform].cooldownUntil || '') > now
            ) {
                return false
            }
            return !job.workers.some(w => Date.parse(state.workerRetryAt?.[w] || '') > now)
        })
        const selected = selectRunnableJobs(candidates, {
            limit: Math.max(0, Math.min(this.document.config.maxParallel, this.hardParallel ?? 32) - this.running.size),
            busyAccounts,
            busyGroups,
            force: true
        })
        this.runNextRestOverrides = new Set(selected.map(job => job.accountIndex))
    },

    _finishAccountSession(record, exit) {
        const { job } = record
        const state = this.document.state.accounts[String(job.accountIndex)]
        this.running.delete(job.id)
        if (!state) return
        const guard = protectionFor(state)
        const session = guard.sessions.find(s => s.id === record.normalSessionId)
        if (!session || session.endedAt) return
        try {
            session.queries = fs
                .readFileSync(record.queryJournal, 'utf8')
                .split('\n')
                .filter(Boolean)
                .map(row => JSON.parse(row))
            settleDailySearch(state, job, session.queries.filter(q => !q.kind || q.kind === 'normal').length)
        } catch {
            record.normalFailure ||= 'data'
        }
        try {
            session.metrics = JSON.parse(fs.readFileSync(record.queryJournal + '.outcome', 'utf8'))
            record.normalFailure ||= session.metrics.failure
            if (session.metrics.searchDeferred) record.searchDeferred = true
        } catch {}
        if (!record.normalFailure && !record.handoff) {
            if (record.timedOut) record.normalFailure = 'timeout'
            else if (exit.code !== 0) record.normalFailure = 'data'
        }
        if (!record.manager.pid && exit.error) {
            session.refunded = true
            record.normalFailure = null
            settleDailySearch(state, job, 0)
        }
        recordSessionOutcome(state, session.id, record.normalFailure || (record.handoff ? 'interrupted' : null))
        record.normalQueries = session.queries.length
        record.normalMetrics = session.metrics
        try {
            this.learning?.endAttempt(record, exit)
        } catch {
            if (this.learning) this.learning.errors++
        }
        const staleDay = state.day !== job.day
        if (!staleDay) {
            state.workersCompleted = [...new Set([...state.workersCompleted, ...record.workerResults])]
            applyAppAuthorization(state, record)
            for (const worker of record.workerResults) {
                state.workerFailures[worker] = 0
                delete state.workerRetryAt[worker]
                state.workersFailed = state.workersFailed.filter(w => w !== worker)
            }
            if (!record.normalFailure && !record.handoff) {
                for (const worker of record.workerStarted || []) {
                    if (
                        record.workerResults.has(worker) ||
                        (record.appAuthorization?.required && APP_AUTH_WORKERS.includes(worker))
                    ) {
                        continue
                    }
                    const attempts = (state.workerFailures[worker] = (state.workerFailures[worker] || 0) + 1)
                    state.workerRetryAt[worker] = new Date(
                        Date.now() + this.document.config.retry.backoffMinutes * 60000 * attempts
                    ).toISOString()
                    if (attempts > this.document.config.retry.maxAttempts && !state.workersFailed.includes(worker)) {
                        state.workersFailed.push(worker)
                    }
                }
            }
            if (job.workers.includes('morePromotions')) {
                if (record.earnScan) {
                    applyEarnScan(state, {
                        verified: record.earnScan.verified && record.workerResults.has('morePromotions')
                    })
                } else if (!record.workerResults.has('morePromotions')) {
                    state.workersCompleted = state.workersCompleted.filter(w => w !== 'morePromotions')
                }
            }
            if (record.quotaSnapshot && !record.quotaBlocked) {
                for (const platform of ['desktop', 'mobile']) {
                    if (!record.quotaSnapshot[platform]) {
                        Object.assign(state.platforms[platform], {
                            quotaKnown: false,
                            remaining: null,
                            complete: false
                        })
                    }
                }
                reconcileSearchQuota(state, record.quotaSnapshot)
            }
            const platform = state.platforms[job.platform]
            platform.queries += session.queries.length
            platform.normalAttempts =
                (platform.normalAttempts || 0) + session.queries.filter(q => !q.kind || q.kind === 'normal').length
            platform.activityAttempts =
                (platform.activityAttempts || 0) + session.queries.filter(q => q.kind && q.kind !== 'normal').length
            platform.normalConfirmed =
                (platform.normalConfirmed || 0) +
                Math.max(
                    0,
                    Math.min(
                        session.queries.filter(q => !q.kind || q.kind === 'normal').length,
                        session.metrics?.confirmedNormal || 0
                    )
                )
            platform.lastRunAt = session.endedAt
            if (record.searchResult) {
                const normalized = normalizeSearchResult(record.searchResult)
                Object.assign(platform, {
                    quotaKnown: normalized.quotaKnown,
                    remaining: normalized.remaining,
                    complete: normalized.complete
                })
            }
        }
        this.document.state.sessions.push({
            ...job,
            executionId: record.executionId,
            startedAt: record.startedAt,
            endedAt: session.endedAt,
            queries: session.queries.length,
            metrics: session.metrics || null,
            failure: record.normalFailure || null,
            interrupted: Boolean(record.handoff),
            stopped: Boolean(record.userStopped),
            success: record.normalFailure ? false : job.workers.every(w => record.workerResults.has(w)),
            exit
        })
        this.document.state.sessions = this.document.state.sessions.slice(-500)
        this._save()
        this.replan()
        this.emit('change', this.get())
    }
}
