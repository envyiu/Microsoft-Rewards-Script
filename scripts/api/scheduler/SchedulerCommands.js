import {
    SMART_CONFIG_MODE_SCOPES,
    SMART_DEADLINE_SEMANTICS,
    computeAccountAxes,
    decorateBlockers
} from '../../../packages/contracts/configMetadata.js'
import { preRewardsActive } from '../../../packages/contracts/newAccount.js'
import {
    DEFAULT_ALLOWED_WORKERS,
    SMART_WORKERS,
    defaultTimezone,
    deriveNetworkGroup
} from '../../../packages/contracts/smartConfig.js'
import { APP_AUTH_WORKERS } from '../appAuthorization.js'
import { protectionFor, sessionEligibility } from '../normalPolicy.js'
import { processIdentity, processReplaced } from '../processIdentity.js'
import { WORKER_FLAGS, fail, validateSmartConfig } from './ScheduleStore.js'

export const schedulerCommandMethods = {
    get() {
        const accounts = this._cachedAccounts()
        const accountByIndex = new Map(accounts.map(a => [String(a.index), a]))
        const runningValues = this.running ? [...this.running.values()] : []
        const runningList = runningValues
            .filter(item => !item.manager.isAlive || item.manager.isAlive())
            .map(item => ({
                ...item.job,
                executionId: item.executionId,
                state: item.manager.state || 'running',
                phase: item.phase || item.job.type,
                pid: item.manager.pid,
                startedAt: item.startedAt
            }))
        const queueList = structuredClone(this.queue || [])
        const now = Date.now()
        const serializedAccounts = Object.fromEntries(
            Object.entries(this.document.state.accounts || {}).map(([index, state]) => {
                const clone = structuredClone(state)
                const account = accountByIndex.get(String(index))
                if (account) {
                    clone.networkGroup = deriveNetworkGroup(account, this.document.config.networkGroupOverride)
                }
                if (clone.platforms) {
                    for (const platform of ['mobile', 'desktop']) {
                        const ps = clone.platforms[platform]
                        if (!ps) continue
                        const reserved = ps.dailySearchUsed ?? ps.normalAttempts ?? 0
                        const confirmed = ps.normalConfirmed || 0
                        ps.quotaCounters = {
                            normalAttempts: ps.normalAttempts || 0,
                            normalConfirmed: confirmed,
                            activityQueries: ps.activityAttempts || 0,
                            reservedUncertain: Math.max(0, reserved - confirmed),
                            microsoftPointsRemaining:
                                ps.quotaKnown !== false && ps.remaining != null && Number.isFinite(Number(ps.remaining))
                                    ? Number(ps.remaining)
                                    : null
                        }
                    }
                }
                if (this.document.config.normalPolicy?.enabled && state.protection) {
                    clone.normalPolicyStatus = this._normalStatus(index, state)
                }
                const runningJob = runningList.find(j => String(j.accountIndex) === String(index)) || null
                const queuedJob = queueList.find(j => String(j.accountIndex) === String(index)) || null
                clone.statusAxes = computeAccountAxes({
                    state: clone,
                    runningJob,
                    queuedJob,
                    manualLocked: Boolean(this.manualLocks?.has(Number(index))),
                    maintenance: Boolean(this.maintenance),
                    nodeOnline: true,
                    isPreRewards: Boolean(account && preRewardsActive(account, state)),
                    now
                })
                return [index, clone]
            })
        )
        return {
            config: structuredClone(this.document.config),
            policyMetadata: {
                activeMode: this.document.config.normalPolicy?.enabled ? 'normalPolicy' : 'legacy',
                scopes: SMART_CONFIG_MODE_SCOPES,
                deadlineSemantics: SMART_DEADLINE_SEMANTICS
            },
            queue: queueList,
            running: runningList,
            accounts: serializedAccounts,
            sessions: structuredClone((this.document.state.sessions || []).slice(-100).reverse()),
            updatedAt: this.document.state.updatedAt,
            manualLocks: [...(this.manualLocks ?? new Map())].map(([accountIndex, networkGroup]) => ({
                accountIndex,
                networkGroup
            })),
            urgent: this.urgentStatus(),
            effectiveEnabled: this.document.config.enabled || Boolean(this.document.state.urgentRun?.active),
            cronExcluded: this.document.config.enabled || Boolean(this.document.state.urgentRun?.active)
        }
    },

    releaseProtection(accountIndex, { acknowledge, confirmedStopped = false } = {}) {
        if (acknowledge !== true) {
            throw Object.assign(new Error('Acknowledge that account verification/recovery was completed.'), {
                code: 'ACKNOWLEDGEMENT_REQUIRED',
                status: 400
            })
        }
        const state = this.document.state.accounts[String(accountIndex)]
        if (!state || [...this.running.values()].some(r => r.job.accountIndex === Number(accountIndex))) {
            throw Object.assign(new Error('Account is absent or running.'), { code: 'ACCOUNT_BUSY', status: 409 })
        }
        const guard = protectionFor(state)
        for (const session of guard.sessions.filter(s => !s.endedAt && !s.refunded)) {
            if (!confirmedStopped) {
                throw Object.assign(new Error('Confirm the old process has stopped.'), {
                    code: 'SESSION_UNCERTAIN',
                    status: 409
                })
            }
            if (session.pid) {
                try {
                    process.kill(session.pid, 0)
                    if (!processReplaced(session.processIdentity, processIdentity(session.pid))) {
                        throw Object.assign(new Error('Old process is still alive.'), {
                            code: 'SESSION_UNCERTAIN',
                            status: 409
                        })
                    }
                } catch (error) {
                    if (error.code !== 'ESRCH') throw error
                }
            }
            session.endedAt = new Date().toISOString()
        }
        guard.hold = null
        guard.consecutiveFailures = 0
        guard.lastFailure = null
        guard.releasedAt = new Date().toISOString()
        this._save()
        return this.replan()
    },

    urgentStatus() {
        const run = this.document.state.urgentRun
        if (!run) {
            return {
                active: false,
                status: 'idle',
                remaining: 0,
                failed: [],
                effectiveParallel: this.document.config.maxParallel
            }
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
                if (state.workersFailed.includes(worker) || state.blockedWorkers?.includes(worker)) {
                    failed.push({ accountIndex: Number(index), task: worker })
                } else if (state.pendingWorkers && !state.pendingWorkers.includes(worker)) {
                    failed.push({ accountIndex: Number(index), task: worker, reason: 'disabled' })
                } else {
                    remaining++
                }
            }
            for (const platform of target.platforms) {
                if (state.platforms[platform].complete || state.platforms[platform].dailySearchComplete) continue
                if (state.platforms[platform].failed) {
                    failed.push({ accountIndex: Number(index), task: `${platform}Search` })
                } else if (state.enabledPlatforms && !state.enabledPlatforms.includes(platform)) {
                    failed.push({ accountIndex: Number(index), task: `${platform}Search`, reason: 'disabled' })
                } else {
                    remaining++
                }
            }
        }
        return {
            active: run.active,
            status: run.status,
            startedAt: run.startedAt,
            remaining,
            failed,
            expired,
            effectiveParallel: this.document.config.maxParallel
        }
    },

    _urgentFor(accountIndex, day) {
        const run = this.document.state.urgentRun
        return Boolean(run?.active && run.targets[String(accountIndex)]?.day === day)
    },

    setUrgent(enabled) {
        if (typeof enabled !== 'boolean') fail('enabled must be a boolean.')
        if (enabled && this.document.state.urgentRun?.active) return this.get()
        if (!enabled) {
            if (this.document.state.urgentRun) {
                Object.assign(this.document.state.urgentRun, { active: false, status: 'cancelled' })
            }
        } else {
            const now = new Date()
            const accounts = this._cachedAccounts()
            const botConfig = this._cachedBotConfig()
            const targets = {}
            for (const profile of this.document.config.profiles) {
                const account = accounts.find(item => item.index === profile.accountIndex)
                if (!account) continue
                const state = this._accountState(account, profile, now)
                if (preRewardsActive(account, state)) continue
                if (!this.document.config.normalPolicy?.enabled) {
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
                targets[String(account.index)] = {
                    day: state.day,
                    workers: profile.allowedWorkers
                        .filter(worker => !(this.document.config.normalPolicy?.enabled && worker === 'bonusSearches'))
                        .filter(worker =>
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
    },

    setManualLock(accountIndex, networkGroup) {
        this.manualLocks ??= new Map()
        this.manualLocks.set(Number(accountIndex), networkGroup)
        this.emit('change', this.get())
    },

    clearManualLock(accountIndex) {
        this.manualLocks ??= new Map()
        if (!this.manualLocks.delete(Number(accountIndex))) return
        this.replan()
        this.emit('change', this.get())
    },

    update(config) {
        this.document.config = validateSmartConfig(config)
        if (!this.document.config.enabled && this.document.state.urgentRun?.active) {
            Object.assign(this.document.state.urgentRun, { active: false, status: 'cancelled' })
        }
        this.replan()
        this._save()
        this._arm()
        this.emit('change', this.get())
        return this.get()
    },

    pauseAccount(accountIndex, paused) {
        const account = this._cachedAccounts().find(item => item.index === Number(accountIndex))
        const profile = this.document.config.profiles.find(item => item.accountIndex === Number(accountIndex))
        if (!account || !profile || (this.accountFilter && !this.accountFilter(account))) {
            throw Object.assign(new Error('Account is not owned by this worker.'), {
                code: 'ACCOUNT_NOT_FOUND',
                status: 404
            })
        }
        if (typeof paused !== 'boolean') {
            throw Object.assign(new Error('paused must be a boolean.'), { code: 'BAD_REQUEST', status: 400 })
        }
        const state = this._accountState(account, profile, new Date())
        state.operatorPaused = paused
        this._save()
        this.replan()
        return { accountIndex: Number(accountIndex), paused }
    },

    async stopAccount(accountIndex, jobId) {
        const account = this._cachedAccounts().find(item => item.index === accountIndex)
        if (!account || (this.accountFilter && !this.accountFilter(account))) {
            throw Object.assign(new Error('Account is not owned by this node.'), {
                code: 'ACCOUNT_NOT_FOUND',
                status: 404
            })
        }
        if (typeof jobId !== 'string' || !jobId || jobId.length > 200) {
            throw Object.assign(new Error('jobId is required.'), { code: 'BAD_REQUEST', status: 400 })
        }
        const record = [...this.running.values()].find(item => item.job.accountIndex === accountIndex)
        if (!record) {
            const previous = [...(this.document.state.sessions || [])]
                .reverse()
                .find(item => item.accountIndex === accountIndex && item.executionId === jobId && item.stopped)
            if (!previous) {
                throw Object.assign(new Error('The requested execution is not the stopped session.'), {
                    code: 'JOB_CHANGED',
                    status: 409
                })
            }
            const checkpoint = previous.exit?.checkpoint || 'unknown'
            return {
                accountIndex,
                jobId,
                stopped: true,
                alreadyStopped: true,
                checkpoint,
                sessionSaved: checkpoint === 'saved'
            }
        }
        if ((record.executionId || record.job.id) !== jobId) {
            throw Object.assign(new Error('The active job changed. Refresh before stopping.'), {
                code: 'JOB_CHANGED',
                status: 409
            })
        }
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
                if (entry.title === 'SESSION-CHECKPOINT' && entry.message === 'All active browser sessions saved') {
                    sessionSaved = true
                }
            }
            record.manager.on('log', checkpoint)
            try {
                const exit = await record.manager.stop({ signalTree: false, signal: 'SIGUSR1', reason: 'user-stop' })
                sessionSaved ||= exit?.checkpoint === 'saved'
                if (record.manager.isAlive?.()) {
                    throw Object.assign(new Error('Process has not stopped.'), { code: 'STOP_PENDING', status: 409 })
                }
                const checkpointState = exit?.checkpoint || (sessionSaved ? 'saved' : 'unknown')
                const stopOutcome =
                    exit?.stopOutcome || (sessionSaved ? 'saved' : checkpointState === 'forced' ? 'forced' : 'unknown')
                return {
                    accountIndex,
                    jobId,
                    stopped: true,
                    sessionSaved,
                    checkpoint: checkpointState,
                    stopOutcome,
                    stopReason: 'user-stop',
                    nextEligibleAt: state.manualStopUntil
                }
            } finally {
                record.manager.off('log', checkpoint)
            }
        })()
        return record.stopPromise
    },

    _assertNormalRequest(index, { allowWaiting = false } = {}) {
        if (this.maintenance) {
            throw Object.assign(new Error('Worker update is in progress.'), {
                code: 'UPDATE_IN_PROGRESS',
                status: 409
            })
        }
        if (this.manualLocks?.has(index)) {
            throw Object.assign(new Error('Account is held by a manual session or transfer.'), {
                code: 'ACCOUNT_HELD',
                status: 409
            })
        }
        const account = this._cachedAccounts().find(a => a.index === index)
        const profile = this.document.config.profiles.find(p => p.accountIndex === index)
        if (!account || !profile || (this.accountFilter && !this.accountFilter(account))) {
            throw Object.assign(new Error('Account is not owned by this worker.'), {
                code: 'ACCOUNT_NOT_FOUND',
                status: 404
            })
        }
        if (!this.document.config.normalPolicy?.enabled || this.isPreRewardsAccount(index)) return
        if ([...this.running.values()].some(r => r.job.accountIndex === index)) {
            throw Object.assign(new Error('Account is running.'), { code: 'ALREADY_RUNNING', status: 409 })
        }
        const state = this._accountState(account, profile, new Date())
        const status = sessionEligibility(state, this.document.config.normalPolicy)
        if (status.blockedReason === 'SESSION_UNCERTAIN') {
            throw Object.assign(new Error(`Account cannot start: ${status.blockedReason}`), {
                code: status.blockedReason,
                status: 409,
                nextEligibleAt: null
            })
        }
        if (status.blockedReason && !allowWaiting) {
            throw Object.assign(new Error(`Account cannot start: ${status.blockedReason}`), {
                code: status.blockedReason,
                status: 409,
                nextEligibleAt: status.nextEligibleAt
            })
        }
    },

    async retryAccounts(accountIndexes, { preempt = false, runOnce = false, workers = null } = {}) {
        if (preempt && this.document.config.normalPolicy?.enabled) {
            throw Object.assign(new Error('Retry cannot stop other sessions.'), { code: 'BAD_REQUEST', status: 400 })
        }
        if (typeof preempt !== 'boolean') {
            throw Object.assign(new Error('preempt must be boolean.'), { code: 'BAD_REQUEST', status: 400 })
        }
        const accounts = this._cachedAccounts()
        if (
            !Array.isArray(accountIndexes) ||
            !accountIndexes.length ||
            accountIndexes.some(index => !Number.isSafeInteger(index) || !accounts.some(a => a.index === index))
        ) {
            throw Object.assign(new Error('Select valid account indexes.'), { code: 'BAD_REQUEST', status: 400 })
        }
        if (
            workers !== null &&
            (!Array.isArray(workers) || !workers.length || workers.some(worker => !SMART_WORKERS.includes(worker)))
        ) {
            throw Object.assign(new Error('Select valid tasks.'), { code: 'BAD_REQUEST', status: 400 })
        }
        for (const index of accountIndexes) this._assertNormalRequest(index, { allowWaiting: true })
        const selected = new Set(accountIndexes)
        const suspended = this.suspended
        this.suspended = true
        try {
            await Promise.all(
                [...this.running.values()]
                    .filter(item => preempt || selected.has(item.job.accountIndex))
                    .map(item => {
                        item.handoff = true
                        return item.manager.stop({ signalTree: false, signal: 'SIGUSR1', reason: 'retry' })
                    })
            )
            for (const profile of this.document.config.profiles) {
                if (!selected.has(profile.accountIndex)) continue
                const account = accounts.find(a => a.index === profile.accountIndex)
                const state = this._accountState(account, profile, new Date())
                if (this.document.config.normalPolicy?.enabled && !this.isPreRewardsAccount(account.index)) {
                    if (!runOnce) {
                        const selectedWorkers = [...(workers || state.workersFailed || [])]
                        for (const worker of selectedWorkers) {
                            if (state.workersCompleted.includes(worker)) continue
                            state.workersFailed = state.workersFailed.filter(w => w !== worker)
                            delete state.workerFailures[worker]
                            delete state.workerRetryAt[worker]
                        }
                        if (
                            selectedWorkers.some(w => APP_AUTH_WORKERS.includes(w)) &&
                            state.appAuthorization?.required
                        ) {
                            state.appAuthorization = {
                                ...state.appAuthorization,
                                required: false,
                                clearedByRetryAt: new Date().toISOString()
                            }
                        }
                    }
                    continue
                }
                if (!this.document.config.normalPolicy?.enabled || runOnce) delete state.manualStopUntil
                if (state.newAccount) {
                    state.newAccount.needsAction = false
                    state.newAccount.serviceAttempts = 0
                }
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
            if (runOnce) {
                this.document.state.onceAccounts = [
                    ...new Set([...(this.document.state.onceAccounts || []), ...accountIndexes])
                ]
            }
            this._save()
            this.replan({ accountIndexes })
        } finally {
            this.suspended = suspended
        }
        this._drain(true)
        if (runOnce) this._arm()
        return this.get()
    },

    requestStatus(accountIndexes) {
        const snapshot = this.get()
        const queuedOnce = new Set(this.document.state.onceAccounts || [])
        return accountIndexes.map(accountIndex => {
            const active = snapshot.running.find(job => job.accountIndex === accountIndex)
            const job = snapshot.queue.find(item => item.accountIndex === accountIndex)
            const state = snapshot.accounts[String(accountIndex)]
            const rawBlockers = [...(state?.statusAxes?.blockers || state?.normalPolicyStatus?.blockers || [])]
            if (!active && this.running.size >= Math.min(this.document.config.maxParallel, this.hardParallel ?? 32)) {
                rawBlockers.push({ code: 'CAPACITY_BUSY', scope: 'node', source: 'capacity', retryAt: null })
            }
            if (job?.reason === 'outside-run-window') {
                rawBlockers.push({ code: 'OUTSIDE_WINDOW', scope: 'account', source: 'schedule', retryAt: null })
            }
            const blockers = decorateBlockers(rawBlockers)
            const isQueued = Boolean(job || queuedOnce.has(accountIndex))
            return {
                accountIndex,
                queued: !active && isQueued,
                state: active ? 'running' : isQueued ? 'queued' : 'no-work',
                blockers,
                earliestStartAt:
                    state?.statusAxes?.earliestStartAt ||
                    job?.dueAt ||
                    state?.normalPolicyStatus?.nextEligibleAt ||
                    null
            }
        })
    },

    runNextSummary(beforeRunning = new Set()) {
        const snapshot = this.get()
        const started = snapshot.running.filter(job => !beforeRunning.has(job.executionId)).map(job => job.accountIndex)
        const startedSet = new Set(started)
        const skipped = []
        for (const profile of this.document.config.profiles) {
            const idx = profile.accountIndex
            if (startedSet.has(idx)) continue
            if (snapshot.running.some(job => job.accountIndex === idx)) continue
            const state = snapshot.accounts[String(idx)]
            if (state?.statusAxes?.progress === 'done') continue
            const status = this.requestStatus([idx])[0]
            skipped.push({
                accountIndex: idx,
                reasons: status.blockers.length ? status.blockers.map(b => b.code) : ['NO_SLOT_OR_WORK'],
                blockers: status.blockers
            })
        }
        return { started, skipped }
    },

    async executeStartCommand({ route = '/start', body = {}, strict = false } = {}) {
        const beforeRunning = new Set(this.get().running.map(job => job.executionId))
        if (route === '/restart' && !this.document.config.normalPolicy?.enabled && this.get().running.length) {
            await this.stop()
        }
        const indexes = Array.isArray(body.accountIndexes)
            ? body.accountIndexes.map(Number)
            : body.accountIndex == null
              ? null
              : [Number(body.accountIndex)]
        const smart =
            !strict && this.document.config.normalPolicy?.enabled && indexes
                ? await this.retryAccounts(indexes, { preempt: Boolean(body.preempt), runOnce: true })
                : this.trigger(indexes, { force: true })
        if (indexes) {
            const outcomes = this.requestStatus([...new Set(indexes)])
            const started = smart.running
                .filter(job => !beforeRunning.has(job.executionId))
                .map(job => job.accountIndex)
            return {
                command: 'request-run',
                smart,
                started,
                queued: outcomes.filter(o => o.queued).map(o => o.accountIndex),
                outcomes,
                blockers: outcomes.length === 1 ? outcomes[0].blockers : undefined,
                earliestStartAt: outcomes.length === 1 ? outcomes[0].earliestStartAt : undefined
            }
        }
        const summary = this.runNextSummary(beforeRunning)
        return {
            command: 'run-next',
            smart,
            started: summary.started,
            skipped: summary.skipped,
            outcomes: this.requestStatus(summary.started)
        }
    },

    trigger(accountIndexes = null, { force = false } = {}) {
        if (force && accountIndexes) for (const index of accountIndexes) this._assertNormalRequest(index)
        if (force && accountIndexes) {
            for (const index of accountIndexes) {
                const state = this.document.state.accounts[String(index)]
                if (state) delete state.manualStopUntil
            }
        }
        this.replan({ accountIndexes })
        if (force && !accountIndexes && this.document.config.normalPolicy?.enabled && this.document.config.enabled) {
            this._grantRunNextRestOverrides()
            try {
                this.replan()
                this._drain(true)
            } finally {
                this.runNextRestOverrides.clear()
                this.replan()
            }
        } else if (force && this.document.config.enabled) this._drain(true)
        return this.get()
    },

    enrollAccounts(accountIndexes = []) {
        const indexes = [...new Set(accountIndexes.map(Number))].filter(
            index => Number.isSafeInteger(index) && index > 0
        )
        if (!indexes.length) return this.get()
        const accounts = this._cachedAccounts()
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
    },

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
    },

    async stop({ resume = true, force = false } = {}) {
        this.suspended = true
        clearInterval(this.timer)
        this.timer = null
        await Promise.allSettled(
            [...this.running.values()].map(item => {
                item.handoff = true
                return force
                    ? item.manager.stop({ force: true, reason: 'scheduler-force-stop' })
                    : item.manager.stop({ signalTree: false, signal: 'SIGUSR1', reason: 'scheduler-stop' })
            })
        )
        this.suspended = !resume
        if (resume) this._arm()
    }
}

export async function dispatchSchedulerCommand({
    scheduler,
    command,
    body = {},
    isWorkerMode = false,
    strict = false,
    onCapacity = null
}) {
    const beforeRunning = new Set(scheduler.get().running.map(job => job.executionId))
    const beforeQueued = scheduler.get().queue.map(job => job.accountIndex)
    const pauseAccount = /^\/smart-schedule\/accounts\/([1-9]\d*)\/pause$/.exec(command)
    if (pauseAccount) {
        return {
            status: 200,
            payload: {
                result: scheduler.pauseAccount(Number(pauseAccount[1]), body.paused),
                smart: scheduler.get()
            }
        }
    }
    const stopAccount = /^\/smart-schedule\/accounts\/([1-9]\d*)\/stop$/.exec(command)
    if (stopAccount) {
        const result = await scheduler.stopAccount(Number(stopAccount[1]), body.jobId)
        return { status: 200, payload: { result, smart: scheduler.get() } }
    }
    const releaseAccount = /^\/smart-schedule\/accounts\/([1-9]\d*)\/release-protection$/.exec(command)
    if (releaseAccount) {
        const smart = scheduler.releaseProtection(Number(releaseAccount[1]), body)
        return { status: 200, payload: smart }
    }
    if (command === '/run-once') {
        const resExec = await scheduler.executeStartCommand({ route: '/start', body, strict: false })
        return {
            status: 202,
            payload: {
                applied: true,
                command: resExec.command,
                smart: resExec.smart,
                outcomes: resExec.outcomes,
                queued: resExec.queued,
                started: resExec.started,
                blockers: resExec.blockers,
                earliestStartAt: resExec.earliestStartAt
            }
        }
    }
    if (command === '/smart-schedule/release-protection') {
        if (!Array.isArray(body.accountIndexes) || body.accountIndexes.length !== 1) {
            throw Object.assign(new Error('Select exactly one account.'), { code: 'BAD_REQUEST', status: 400 })
        }
        scheduler.releaseProtection(body.accountIndexes[0], body)
    } else if (command === '/capacity' && onCapacity) {
        onCapacity(body)
    } else if (command === '/smart-schedule/urgent') {
        if (typeof body.enabled !== 'boolean') {
            throw Object.assign(new Error('enabled must be boolean.'), { code: 'BAD_REQUEST', status: 400 })
        }
        scheduler.setUrgent(body.enabled)
    } else if (command === '/smart-schedule/retry') {
        await scheduler.retryAccounts(body.accountIndexes, {
            preempt: body.preempt ?? false,
            workers: body.workers ?? null
        })
    } else if (command === '/smart-schedule/replan') {
        const accountIndexes = body.accountIndexes == null ? null : body.accountIndexes
        if (
            accountIndexes != null &&
            (!Array.isArray(accountIndexes) ||
                accountIndexes.some(v => !Number.isSafeInteger(Number(v)) || Number(v) < 1))
        ) {
            throw Object.assign(new Error('accountIndexes must contain positive integers.'), {
                code: 'BAD_REQUEST',
                status: 400
            })
        }
        scheduler.replan({ accountIndexes })
    } else if (command === '/stop') {
        const force = body.force === true
        if (isWorkerMode) {
            scheduler.suspended = true
            scheduler.document.state.onceAccounts = []
            if (scheduler.document.state.urgentRun) {
                scheduler.document.state.urgentRun.active = false
            }
            scheduler._save()
        }
        await scheduler.stop({ resume: !isWorkerMode, force })
    } else if (['/start', '/restart'].includes(command)) {
        const resExec = await scheduler.executeStartCommand({ route: command, body, strict })
        return {
            status: 202,
            payload: {
                applied: true,
                command: resExec.command,
                smart: resExec.smart,
                outcomes: resExec.outcomes,
                queued: resExec.queued,
                started: resExec.started,
                skipped: resExec.skipped,
                blockers: resExec.blockers,
                earliestStartAt: resExec.earliestStartAt
            }
        }
    } else {
        throw Object.assign(new Error('Unknown node command.'), { code: 'BAD_REQUEST', status: 400 })
    }

    const smart = scheduler.get()
    const selected = Array.isArray(body.accountIndexes)
        ? body.accountIndexes
        : body.accountIndex == null
          ? beforeQueued
          : [Number(body.accountIndex)]
    const outcomes = ['/run-once', '/start', '/restart', '/smart-schedule/retry'].includes(command)
        ? scheduler.requestStatus([...new Set(selected)])
        : undefined
    return {
        status: 202,
        payload: {
            applied: true,
            smart,
            outcomes,
            started: smart.running.filter(job => !beforeRunning.has(job.executionId)).map(job => job.accountIndex)
        }
    }
}
