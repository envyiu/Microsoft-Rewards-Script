import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildSingleAccountEnv } from '../../../packages/contracts/accounts.js'
import { applyAppAuthorization } from '../appAuthorization.js'
import { captureSearchStreak, dailySearchRemaining, reserveDailySearch, settleDailySearch } from '../dailySearch.js'
import { protectionFor } from '../normalPolicy.js'
import { processIdentity } from '../processIdentity.js'
import { ProcessManager } from '../processManager.js'
import { parseSearchQuotaSnapshot, reconcileSearchQuota } from '../searchQuotaSnapshot.js'
import { normalizeSearchResult, selectRunnableJobs } from './LegacyPlanner.js'
import { applyEarnScan, localParts, randomMinutes } from './ScheduleStore.js'
import { finishWarmupSession } from './WarmupPlanner.js'

export function parsePipeFields(msg) {
    const fields = {}
    for (const part of String(msg || '').split(' | ')) {
        const eq = part.indexOf('=')
        if (eq > 0) fields[part.slice(0, eq)] = part.slice(eq + 1)
    }
    return fields
}

export const sessionRunnerMethods = {
    _arm() {
        clearInterval(this.timer)
        this.timer = null
        if (
            !this.document.config.enabled &&
            !this.document.state.urgentRun?.active &&
            !this.document.state.onceAccounts?.length
        ) {
            return
        }
        this.timer = setInterval(() => {
            this.replan()
        }, 30_000)
        this.timer.unref?.()
        this._drain()
    },

    _drain(force = false) {
        if (this.suspended || this.maintenance) return
        const urgentActive = Boolean(this.document.state.urgentRun?.active)
        if (!this.document.config.enabled && !urgentActive && !force && !this.document.state.onceAccounts?.length) {
            return
        }
        const busyGroups = new Set([...this.running.values()].map(item => item.job.networkGroup))
        const busyAccounts = new Set([...this.running.values()].map(item => item.job.accountIndex))
        for (const [accountIndex, networkGroup] of this.manualLocks ?? []) {
            busyAccounts.add(accountIndex)
            if (networkGroup) busyGroups.add(networkGroup)
        }
        let effectiveLimit = this.document.config.maxParallel
        try {
            effectiveLimit = this.learning?.capacity(this) ?? effectiveLimit
        } catch {
            if (this.learning) this.learning.errors++
        }
        const normalAllowance = Math.max(0, effectiveLimit - this.running.size)
        let normalSelected = 0
        const once = new Set(this.document.state.onceAccounts || [])
        const candidates = this.queue
            .filter(job => job.urgent || this.document.config.enabled || once.has(job.accountIndex))
            .map(job =>
                once.has(job.accountIndex) && job.type !== 'accountSession'
                    ? { ...job, dueAt: new Date().toISOString() }
                    : job
            )
            .sort(
                (a, b) =>
                    Number(Boolean(b.urgent)) - Number(Boolean(a.urgent)) ||
                    Number(once.has(b.accountIndex)) - Number(once.has(a.accountIndex))
            )
        const jobs = selectRunnableJobs(
            candidates.filter(job => {
                if (this._proxyCooldownUntil(job.networkGroup, job.accountIndex)) return false
                if (this.document.config.normalPolicy?.enabled && job.type !== 'warmup') {
                    if (job.type !== 'accountSession') return false
                    const state = this.document.state.accounts[String(job.accountIndex)]
                    if (this._eligibilityForDispatch(job.accountIndex, state).blockedReason) return false
                    if (Date.parse(job.dueAt || '') > Date.now() || !job.dueAt) return false
                }
                if (this.document.state.accounts[String(job.accountIndex)]?.operatorPaused) return false
                if (Date.parse(this.document.state.accounts[String(job.accountIndex)]?.manualStopUntil) > Date.now()) {
                    return false
                }
                if (!this.accountFilter) return true
                const account = this._cachedAccounts().find(item => item.index === job.accountIndex)
                return account && (!this.accountFilter || this.accountFilter(account))
            }),
            {
                limit: Math.min(effectiveLimit, this.hardParallel ?? 32) - this.running.size,
                busyGroups,
                busyAccounts,
                force
            }
        ).filter(job => job.urgent || normalSelected++ < normalAllowance)

        for (const job of jobs) {
            this.queue = this.queue.filter(item => item.id !== job.id)
            this._start(job, [...this.queue, job])
        }
        this.emit('change', this.get())
    },

    _start(job, learningCandidates) {
        if (this.maintenance) return
        if (this._proxyCooldownUntil(job.networkGroup, job.accountIndex)) return
        const accountState = this.document.state.accounts[String(job.accountIndex)]
        if (this.document.config.normalPolicy?.enabled && job.type !== 'warmup' && job.type !== 'accountSession') return
        if (job.type === 'accountSession') {
            const status = this._eligibilityForDispatch(job.accountIndex, accountState)
            if (
                status.blockedReason ||
                this.manualLocks?.has(job.accountIndex) ||
                [...this.running.values()].some(r => r.job.accountIndex === job.accountIndex)
            ) {
                return
            }
        }
        if (
            this.runNextRestOverrides?.delete(job.accountIndex) ||
            this.document.state.onceAccounts?.includes(job.accountIndex)
        ) {
            job.manualRestOverride = true
        }
        if (job.earnFinalCheck) {
            accountState.earnFinalCheckAt = new Date().toISOString()
            this._save()
        }
        let choice
        let decisionId
        try {
            choice = job.type === 'accountSession' ? null : this.learning?.experiment(this, job)
            if (choice) job = choice.job
            decisionId = this.learning?.decision(this, job, choice, learningCandidates)
        } catch {
            if (this.learning) this.learning.errors++
        }
        const dailyRemaining = dailySearchRemaining(
            accountState,
            this.document.config.dailySearchLimits,
            job.platform || 'desktop',
            this.document.config.streakSearchV1
        )
        if (dailyRemaining != null && ['accountSession', 'warmup', 'search'].includes(job.type)) {
            if (job.type === 'accountSession') {
                job.normalSearchBudget = Math.min(job.normalSearchBudget ?? job.searchBudget, dailyRemaining)
            } else {
                job.searchBudget = Math.min(job.searchBudget, dailyRemaining)
            }
            if (
                (job.type === 'accountSession' ? job.normalSearchBudget : job.searchBudget) === 0 &&
                !job.workers?.length &&
                !job.services?.length
            ) {
                return
            }
            reserveDailySearch(
                accountState,
                job,
                job.type === 'accountSession' ? job.normalSearchBudget : job.searchBudget
            )
            this._save()
        }
        if (this.document.state.onceAccounts?.includes(job.accountIndex)) {
            this.document.state.onceAccounts = this.document.state.onceAccounts.filter(
                index => index !== job.accountIndex
            )
            this._save()
        }
        if (job.type === 'accountSession') accountState.readySince = null
        if (job.type === 'warmup' && job.searchBudget > 0) {
            accountState.warmupReservations ??= {
                baseline: Object.fromEntries(
                    ['desktop', 'mobile'].map(p => [
                        p,
                        Math.max(accountState.platforms[p].queries || 0, accountState.learningQueries?.[p] || 0)
                    ])
                ),
                entries: {}
            }
            job.warmupReservation = crypto.randomUUID()
            accountState.warmupReservations.entries[job.warmupReservation] = {
                platform: job.platform,
                budget: job.searchBudget
            }
            this._save()
        }
        const selection = buildSingleAccountEnv(job.accountIndex)
        const plan =
            job.type === 'accountSession'
                ? {
                      version: 1,
                      jobId: job.id,
                      type: 'accountSession',
                      platform: job.platform,
                      environment: job.environment,
                      workers: job.workers,
                      searchBudget: Math.min(5, job.searchBudget),
                      ...(job.normalSearchBudget != null ? { normalSearchBudget: job.normalSearchBudget } : {})
                  }
                : job.type === 'warmup'
                  ? {
                        version: 1,
                        jobId: job.id,
                        type: 'warmup',
                        platform: job.platform,
                        newAccountPolicy: job.newAccountPolicy || 'standard168h',
                        warmupStartedAt: this.document.state.accounts[String(job.accountIndex)]?.newAccount?.startedAt,
                        warmupReadyAt: this.document.state.accounts[String(job.accountIndex)]?.newAccount?.readyAt,
                        services: job.services,
                        artifacts: this.document.state.accounts[String(job.accountIndex)]?.newAccount?.artifacts || [],
                        searchBudget: job.searchBudget
                    }
                  : job.type === 'quota'
                    ? { version: 1, jobId: job.id, type: 'quota' }
                    : job.type === 'search'
                      ? {
                            version: 1,
                            jobId: job.id,
                            type: 'search',
                            platform: job.platform,
                            searchBudget: job.searchBudget,
                            ...(job.recheckEarn ? { recheckEarn: true } : {})
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
        let normalSession
        let queryJournal
        if (job.type === 'accountSession') {
            const guard = protectionFor(accountState)
            normalSession = {
                id: crypto.randomUUID(),
                startedAt: new Date().toISOString(),
                endedAt: null,
                platform: job.platform,
                queries: [],
                day: job.day,
                dailySearchReservation: job.dailySearchReservation
            }
            queryJournal = path.join(path.dirname(this.configFile), 'normal-query-journal', normalSession.id + '.jsonl')
            fs.mkdirSync(path.dirname(queryJournal), { recursive: true, mode: 0o700 })
            const fd = fs.openSync(queryJournal, 'wx', 0o600)
            try {
                fs.fsyncSync(fd)
            } finally {
                fs.closeSync(fd)
            }
            if (process.platform !== 'win32') {
                const dir = fs.openSync(path.dirname(queryJournal), 'r')
                try {
                    fs.fsyncSync(dir)
                } finally {
                    fs.closeSync(dir)
                }
            }
            guard.sessions.push(normalSession)
            guard.lastServed ??= {}
            guard.lastServed[job.platform] = normalSession.startedAt
            this._save()
        }
        const manager = new ProcessManager({
            command: this.command,
            args: this.args,
            cwd: this.projectRoot,
            stopTimeoutMs: this.stopTimeoutMs,
            checkpointIPC: true,
            name: `smart-${job.accountIndex}`
        })
        if (job.type === 'quota') {
            const state = this.document.state.accounts[String(job.accountIndex)]
            state.quotaCheckAttempts = (state.quotaCheckAttempts || 0) + 1
            state.quotaCheckAttemptedAt = new Date().toISOString()
            this._save()
        }
        const record = {
            normalSessionId: normalSession?.id,
            queryJournal,
            executionId: crypto.randomUUID(),
            phase: 'starting',
            job,
            manager,
            startedAt: new Date().toISOString(),
            searchResult: null,
            quotaSnapshot: null,
            quotaBlocked: false,
            workerResults: new Set(),
            workerStarted: new Set(),
            timedOut: false,
            timeout: null
        }
        let learningEnv = {}
        try {
            learningEnv = this.learning?.startAttempt(record, this, decisionId) || {}
        } catch {
            if (this.learning) this.learning.errors++
        }
        const controlFile = path.join(os.tmpdir(), `msrw-stop-${record.executionId}.json`)
        const eventJournal = path.join(os.tmpdir(), `msrw-events-${record.executionId}.jsonl`)
        record.eventJournal = eventJournal
        this.running.set(job.id, record)

        const applyRuntimeEvent = message => {
            const payload = message?.payload
            if (!payload || typeof payload !== 'object') return
            if (message.event === 'streakSnapshot') {
                const state = this.document.state.accounts[String(job.accountIndex)]
                if (captureSearchStreak(state, job.email, JSON.stringify(payload))) this._save()
            } else if (message.event === 'quotaSnapshot') {
                const snapshot = parseSearchQuotaSnapshot(JSON.stringify(payload))
                if (snapshot && (!record.quotaSnapshot || snapshot.readAt > record.quotaSnapshot.readAt)) {
                    record.quotaSnapshot = snapshot
                }
            } else if (message.event === 'quotaDeferred') {
                record.searchDeferred = true
            } else if (message.event === 'searchStart') {
                record.phase = job.type
            } else if (message.event === 'searchProgress') {
                const result = {
                    queries: Number(payload.queries),
                    points: Number(payload.points),
                    remaining: Number(payload.remaining),
                    quotaAvailable: payload.quotaAvailable === true
                }
                if (
                    Number.isSafeInteger(result.queries) &&
                    result.queries >= 0 &&
                    Number.isFinite(result.points) &&
                    result.points >= 0 &&
                    Number.isFinite(result.remaining) &&
                    result.remaining >= 0
                ) {
                    record.searchResult = result
                }
            } else if (message.event === 'workerStart') {
                record.phase = job.type
                if (typeof payload.worker === 'string' && job.workers?.includes(payload.worker)) {
                    record.workerStarted.add(payload.worker)
                }
            } else if (message.event === 'workerEnd') {
                if (
                    typeof payload.worker === 'string' &&
                    (job.type === 'workers' || job.type === 'accountSession') &&
                    job.workers?.includes(payload.worker)
                ) {
                    record.workerResults.add(payload.worker)
                }
            } else if (message.event === 'earnScan') {
                if (
                    (job.recheckEarn || job.workers?.includes('morePromotions')) &&
                    Number.isFinite(Date.parse(String(payload.observedAt || '')))
                ) {
                    record.earnScan = { verified: payload.verified === true }
                }
            } else if (message.event === 'appAuthorization') {
                if (payload.required === false) {
                    record.appAuthorization = { required: false }
                } else if (
                    payload.required === true &&
                    ['email-code-required', 'password-required', 'account-review', 'access-denied'].includes(
                        payload.reason
                    )
                ) {
                    record.appAuthorization = { required: true, reason: payload.reason }
                }
            } else if (message.event === 'sessionFailure') {
                if (['network', 'data', 'authentication', 'verification', 'locked'].includes(payload.reason)) {
                    record.normalFailure = payload.reason
                }
                if (payload.searchDeferred === true) record.searchDeferred = true
            } else if (message.event === 'warmupCheckpoint') {
                record.phase = 'warmup'
                this._newAccountCheckpoint(record, payload)
            } else if (message.event === 'botWarning') {
                record.quotaBlocked = true
            } else if (message.event === 'authPhase') {
                if (payload.phase === 'login' || payload.phase === 'verification') {
                    record.phase = payload.phase
                }
            }
        }
        record.applyRuntimeEvent = applyRuntimeEvent

        manager.on('event', applyRuntimeEvent)

        manager.on('log', entry => {
            try {
                this.learning?.capture(record, entry)
            } catch {
                if (this.learning) this.learning.errors++
            }
            this.onLog({ ...entry, smartJobId: job.id, jobKind: job.type, warmup: job.type === 'warmup' })
        })

        manager.once('exit', exit => this._finish(record, exit))
        try {
            const started = manager.start({
                env: {
                    ...selection.env,
                    ...learningEnv,
                    MRS_CHECKPOINT_CONTROL_FILE: controlFile,
                    MRS_RUNTIME_EVENT_JOURNAL: eventJournal,
                    ...(this.document.config.dailySearchLimits || this.document.config.streakSearchV1
                        ? {
                              MRS_DAILY_SEARCH_DAY: job.day,
                              MRS_DAILY_SEARCH_TIMEZONE:
                                  this.document.config.profiles.find(p => p.accountIndex === job.accountIndex)
                                      ?.timezone || 'UTC'
                          }
                        : {}),
                    ...(queryJournal ? { MRS_NORMAL_QUERY_JOURNAL: queryJournal } : {}),
                    MRS_EXECUTION_PLAN: JSON.stringify(plan)
                },
                trustedEnv: true
            })
            record.spawned = Boolean(started.pid)
            if (normalSession) {
                normalSession.pid = started.pid
                normalSession.processIdentity = processIdentity(started.pid)
                this._save()
            }
        } catch {
            try {
                fs.rmSync(controlFile, { force: true })
                fs.rmSync(eventJournal, { force: true })
            } catch {}
            if (normalSession && manager.child === null) {
                normalSession.refunded = true
                settleDailySearch(accountState, job, 0)
                normalSession.endedAt = new Date().toISOString()
                this._save()
            }
            this.running.delete(job.id)
            this.onLog({
                level: 'error',
                title: 'SMART-SPAWN',
                message: 'Process creation failed',
                smartJobId: job.id,
                jobKind: job.type,
                warmup: job.type === 'warmup'
            })
            return
        }
        record.timeout = setTimeout(() => {
            record.timedOut = true
            record.stopReason = 'timeout'
            manager.stop({ signalTree: false, signal: 'SIGUSR1', reason: 'timeout' }).catch(() => {})
        }, this.document.config.sessionTimeoutMinutes * 60_000)
        record.timeout.unref?.()
        this.emit('change', this.get())
    },

    _finish(record, exit) {
        clearTimeout(record.timeout)
        if (this.running.has(record.job.id) && (record.spawned || exit.code != null || exit.signal)) {
            this._recordProxyCooldown(record.job)
        }
        if (record.eventJournal && record.applyRuntimeEvent) {
            try {
                if (fs.existsSync(record.eventJournal)) {
                    for (const line of fs.readFileSync(record.eventJournal, 'utf8').split('\n')) {
                        if (!line.trim()) continue
                        try {
                            const parsed = JSON.parse(line)
                            if (parsed?.type === 'MSRW_EVENT') record.applyRuntimeEvent(parsed)
                        } catch {}
                    }
                }
            } catch {}
            try {
                fs.rmSync(record.eventJournal, { force: true })
            } catch {}
        }
        if (record.job.type === 'accountSession') {
            this._finishAccountSession(record, exit)
            return
        }
        try {
            this.learning?.endAttempt(record, exit)
        } catch {
            if (this.learning) this.learning.errors++
        }
        const { job } = record
        this.running.delete(job.id)
        const state = this.document.state.accounts[String(job.accountIndex)]
        if (job.type === 'warmup') {
            finishWarmupSession(this, record, exit, state)
            return
        }
        if (job.type === 'search' && record.searchResult && exit.code === 0) {
            settleDailySearch(state, job, record.searchResult.queries)
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
            executionId: record.executionId,
            startedAt: record.startedAt,
            endedAt: new Date().toISOString(),
            success: searchPending ? null : succeeded,
            pending: searchPending,
            timedOut: record.timedOut,
            staleDay,
            exit
        })
        if (this.document.state.sessions.length > 500) {
            this.document.state.sessions.splice(0, this.document.state.sessions.length - 500)
        }
        if (staleDay) {
            this._save()
            this.replan()
            this.emit('change', this.get())
            return
        }

        state.workerRetryAt ??= {}
        const trustedEarnScan = record.earnScan && {
            verified:
                record.earnScan.verified &&
                exit.code === 0 &&
                accountSucceeded &&
                (job.type === 'search' || completedWorkers.includes('morePromotions'))
        }
        applyEarnScan(state, trustedEarnScan)
        if (trustedEarnScan?.verified === false && job.type === 'search') {
            state.workerFailures.morePromotions = (state.workerFailures.morePromotions || 0) + 1
            state.workerRetryAt.morePromotions = new Date(
                Date.now() + this.document.config.retry.backoffMinutes * 60_000 * state.workerFailures.morePromotions
            ).toISOString()
            if (
                state.workerFailures.morePromotions > this.document.config.retry.maxAttempts &&
                !state.workersFailed.includes('morePromotions')
            ) {
                state.workersFailed.push('morePromotions')
            }
        }
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
            // Bounded read-only check.
        } else if (job.type === 'workers') {
            if (!missingWorkers.length) {
                const dailyWorkPending = (state.pendingWorkers || []).some(
                    worker =>
                        ['dailySet', 'readToEarn'].includes(worker) &&
                        !state.workersCompleted.includes(worker) &&
                        !state.workersFailed.includes(worker)
                )
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
                    if (state.workerFailures[worker] > this.document.config.retry.maxAttempts) {
                        state.workersFailed.push(worker)
                    }
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
                if (result.queries > 0 && result.points > 0) {
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
                if (reopened.length) {
                    this.onLog({
                        level: 'info',
                        title: 'SMART-QUOTA-REOPEN',
                        message: `accountIndex=${job.accountIndex} | platforms=${reopened.join(',')} | reason=fresh-positive-quota`,
                        smartJobId: job.id
                    })
                }
            }
        }
        applyAppAuthorization(state, record)
        this._save()
        this.replan()
        this.emit('change', this.get())
    }
}
