import { buildExcludedAccountsEnv, buildSingleAccountEnv, loadAccounts } from '../../../packages/contracts/accounts.js'
import { readSchedule, writeSchedule } from '../scheduleStore.js'
import { dispatchSchedulerCommand } from '../scheduler/SchedulerCommands.js'
import { readForce } from './createRouter.js'

export async function handleSmartScheduleAndControlRoutes(ctx) {
    const {
        req,
        res,
        method,
        pathname,
        sendJson,
        readJsonObject,
        projectRoot,
        allowScheduleWrite,
        allowEnvOverrides,
        smartScheduler,
        pm,
        manualSessionManager,
        getSmartState,
        refreshManualLocks
    } = ctx

    const releaseProtection = pathname.match(/^\/smart-schedule\/accounts\/([1-9]\d*)\/release-protection$/)
    if (method === 'POST' && releaseProtection) {
        if (!allowScheduleWrite) {
            sendJson(res, 403, { error: 'Schedule writes disabled.' })
            return true
        }
        const body = await readJsonObject(req)
        sendJson(res, 200, smartScheduler.releaseProtection(Number(releaseProtection[1]), body))
        return true
    }

    const pauseSmartAccount = pathname.match(/^\/smart-schedule\/accounts\/([1-9]\d*)\/pause$/)
    if (method === 'POST' && pauseSmartAccount) {
        if (!allowScheduleWrite) {
            sendJson(res, 403, { error: 'Schedule writes disabled.' })
            return true
        }
        const body = await readJsonObject(req)
        sendJson(res, 200, smartScheduler.pauseAccount(Number(pauseSmartAccount[1]), body.paused))
        return true
    }

    const stopSmartAccount = pathname.match(/^\/smart-schedule\/accounts\/([1-9]\d*)\/stop$/)
    if (method === 'POST' && stopSmartAccount) {
        if (!allowScheduleWrite) {
            sendJson(res, 403, { error: 'Schedule writes disabled.' })
            return true
        }
        const body = await readJsonObject(req)
        try {
            sendJson(res, 200, await smartScheduler.stopAccount(Number(stopSmartAccount[1]), body.jobId))
        } catch (error) {
            sendJson(res, error.status || 500, { error: error.message, code: error.code })
        }
        return true
    }

    if (method === 'GET' && pathname === '/smart-schedule') {
        sendJson(res, 200, { ...getSmartState(), writable: allowScheduleWrite })
        return true
    }

    if (method === 'PUT' && pathname === '/smart-schedule') {
        if (!allowScheduleWrite) {
            sendJson(res, 403, {
                error: 'Schedule writes are disabled. Set API_ALLOW_SCHEDULE_WRITE=true to enable.'
            })
            return true
        }
        const body = await readJsonObject(req)
        try {
            if (body.enabled === true && pm.getStatus().state !== 'idle') {
                sendJson(res, 409, {
                    error: 'Stop the active legacy run before enabling Smart Scheduler.',
                    code: 'RUN_ACTIVE'
                })
                return true
            }
            const updated = smartScheduler.update(body)
            refreshManualLocks()
            if (updated.config.enabled) {
                const current = readSchedule(projectRoot)
                if (current.enabled) writeSchedule(projectRoot, { enabled: false })
            }
            pm.note('info', `Smart schedule ${updated.config.enabled ? 'enabled' : 'disabled'} via API.`)
            sendJson(res, 200, { ...getSmartState(), writable: true })
        } catch (err) {
            sendJson(res, err.code === 'BAD_REQUEST' ? 400 : 500, { error: err.message, code: err.code })
        }
        return true
    }

    if (method === 'POST' && pathname === '/smart-schedule/urgent') {
        if (!allowScheduleWrite) {
            sendJson(res, 403, { error: 'Schedule writes are disabled.' })
            return true
        }
        const body = await readJsonObject(req)
        if (typeof body.enabled !== 'boolean') {
            sendJson(res, 400, { error: 'enabled must be a boolean.', code: 'BAD_REQUEST' })
            return true
        }
        if (body.enabled && pm.getStatus().state !== 'idle') {
            sendJson(res, 409, { error: 'Stop the active legacy run first.', code: 'RUN_ACTIVE' })
            return true
        }
        refreshManualLocks()
        const updated = smartScheduler.setUrgent(body.enabled)
        if (updated.effectiveEnabled) {
            const current = readSchedule(projectRoot)
            if (current.enabled) writeSchedule(projectRoot, { enabled: false })
        }
        refreshManualLocks()
        pm.note('info', `Urgent scheduling ${body.enabled ? 'requested' : 'cancelled'} via API.`)
        sendJson(res, 200, { ...getSmartState(), writable: true })
        return true
    }

    if (method === 'POST' && pathname === '/smart-schedule/replan') {
        const body = await readJsonObject(req)
        try {
            await dispatchSchedulerCommand({ scheduler: smartScheduler, command: pathname, body })
            sendJson(res, 200, getSmartState())
        } catch (err) {
            sendJson(res, err.code === 'BAD_REQUEST' ? 400 : err.status || 500, { error: err.message, code: err.code })
        }
        return true
    }

    if (method === 'POST' && pathname === '/smart-schedule/retry') {
        if (!allowScheduleWrite) {
            sendJson(res, 403, { error: 'Schedule writes are disabled.' })
            return true
        }
        const body = await readJsonObject(req)
        try {
            const dispatched = await dispatchSchedulerCommand({
                scheduler: smartScheduler,
                command: pathname,
                body
            })
            sendJson(res, dispatched.status, {
                ...dispatched.payload,
                smart: { ...getSmartState(), writable: true }
            })
        } catch (err) {
            sendJson(res, err.status || (err.code === 'BAD_REQUEST' ? 400 : 500), {
                error: err.message,
                code: err.code,
                ...(err.nextEligibleAt !== undefined ? { nextEligibleAt: err.nextEligibleAt } : {})
            })
        }
        return true
    }

    if (method === 'POST' && (pathname === '/start' || pathname === '/restart')) {
        const isRestart = pathname === '/restart'
        const body = await readJsonObject(req)
        if (smartScheduler.get().effectiveEnabled || smartScheduler.document.config.normalPolicy?.enabled) {
            if (body.args != null || body.env != null || body.excludedAccountIndexes != null) {
                sendJson(res, 400, {
                    error: 'Smart mode does not accept args, env, or excludedAccountIndexes.',
                    code: 'BAD_REQUEST'
                })
                return true
            }
            const dispatched = await dispatchSchedulerCommand({
                scheduler: smartScheduler,
                command: pathname,
                body,
                isWorkerMode: false
            })
            const execResult = dispatched.payload
            sendJson(res, 202, {
                ...(isRestart ? { restarted: true } : { started: true }),
                smart: true,
                command: execResult.command,
                startedAccounts: execResult.started,
                queued: execResult.queued,
                skipped: execResult.skipped,
                outcomes: execResult.outcomes,
                blockers: execResult.blockers,
                earliestStartAt: execResult.earliestStartAt,
                queue: execResult.smart.queue,
                running: execResult.smart.running
            })
            return true
        }
        if (smartScheduler.get().running.length) {
            sendJson(res, 409, {
                error: isRestart
                    ? 'Wait for active Smart Scheduler sessions to stop before restarting in legacy mode.'
                    : 'Wait for active Smart Scheduler sessions to stop before starting a legacy run.',
                code: 'SMART_RUN_ACTIVE'
            })
            return true
        }
        if (manualSessionManager.list().length) {
            sendJson(res, 409, {
                error: isRestart
                    ? 'Close all manual browser sessions before restarting in legacy mode.'
                    : 'Close all manual browser sessions before starting a legacy run.',
                code: 'MANUAL_SESSION_ACTIVE'
            })
            return true
        }
        const overrides = isRestart ? { force: readForce(body) } : {}
        let selectedAccount = null
        let excludedAccounts = []
        if (body.args != null) overrides.args = body.args
        if (body.env != null) {
            if (!allowEnvOverrides) {
                sendJson(res, 403, {
                    error: 'Per-request env overrides are disabled. Set API_ALLOW_ENV_OVERRIDES=true to enable.'
                })
                return true
            }
            overrides.env = body.env
        }
        try {
            if (body.accountIndex != null && body.excludedAccountIndexes != null) {
                sendJson(res, 400, {
                    error: '`accountIndex` and `excludedAccountIndexes` cannot be used together.',
                    code: 'BAD_REQUEST'
                })
                return true
            }
            if (body.accountIndexes != null) {
                if (
                    !Array.isArray(body.accountIndexes) ||
                    !body.accountIndexes.length ||
                    body.accountIndexes.some(idx => !Number.isSafeInteger(Number(idx)) || Number(idx) < 1)
                ) {
                    sendJson(res, 400, {
                        error: '`accountIndexes` must be a non-empty array of positive integers.',
                        code: 'BAD_REQUEST'
                    })
                    return true
                }
                const wanted = new Set(body.accountIndexes.map(Number))
                if (wanted.size === 1) {
                    const selection = buildSingleAccountEnv([...wanted][0])
                    overrides.env = { ...(overrides.env || {}), ...selection.env }
                    selectedAccount = selection.account
                } else {
                    const excluded = loadAccounts()
                        .filter(a => !wanted.has(a.index))
                        .map(a => a.index)
                    const selection = buildExcludedAccountsEnv(excluded)
                    overrides.env = { ...(overrides.env || {}), ...selection.env }
                    excludedAccounts = selection.excludedAccounts
                }
            } else if (body.accountIndex != null) {
                const selection = buildSingleAccountEnv(body.accountIndex)
                overrides.env = { ...(overrides.env || {}), ...selection.env }
                selectedAccount = selection.account
            } else if (body.excludedAccountIndexes != null) {
                const selection = buildExcludedAccountsEnv(body.excludedAccountIndexes)
                overrides.env = { ...(overrides.env || {}), ...selection.env }
                excludedAccounts = selection.excludedAccounts
            }
            const info = isRestart ? await pm.restart(overrides) : pm.start(overrides)
            sendJson(res, 202, {
                ...(isRestart ? { restarted: true } : { started: true }),
                selectedAccount,
                excludedAccounts,
                ...info
            })
        } catch (err) {
            if (err.code === 'ALREADY_RUNNING') sendJson(res, 409, { error: err.message, code: err.code })
            else if (err.code === 'BAD_REQUEST') sendJson(res, 400, { error: err.message, code: err.code })
            else sendJson(res, 500, { error: err.message })
        }
        return true
    }

    if (method === 'POST' && pathname === '/stop') {
        const body = await readJsonObject(req)
        const force = readForce(body)
        try {
            if (smartScheduler.get().running.length) {
                void smartScheduler.stop({ force })
                if (pm.getStatus().state === 'idle') {
                    sendJson(res, 202, { stopping: true, force, smart: true })
                    return true
                }
            }
            const stopping = pm.stop({ force })
            stopping.catch(() => {})
            sendJson(res, 202, { stopping: true, force })
        } catch (err) {
            if (err.code === 'NOT_RUNNING') sendJson(res, 409, { error: err.message, code: err.code })
            else sendJson(res, 500, { error: err.message })
        }
        return true
    }

    return false
}
