import {
    accountWriteAvailable,
    addAccounts,
    deleteAccount,
    listManagedAccounts,
    previewAccounts,
    updateAccount
} from '../../../packages/contracts/accountStore.js'
import { loadAccounts, mergeAccountStats } from '../../../packages/contracts/accounts.js'
import { deleteStoredSessions } from '../sessionStore.js'

export async function handleAccountRoutes(ctx) {
    const {
        req,
        res,
        method,
        pathname,
        sendJson,
        readJsonObject,
        projectRoot,
        allowAccountWrite,
        pm,
        toHistoryRecord,
        getSmartState,
        accountIpChecker,
        hybrid,
        smartScheduler,
        manualSessionManager,
        syncManualLock,
        loadConfigSafe
    } = ctx

    if (method === 'GET' && pathname === '/accounts') {
        const execution = getSmartState().execution
        const accounts = mergeAccountStats(loadAccounts(), pm.getHistory().map(toHistoryRecord))
        const safeAccounts = listManagedAccounts()
        const safeByIndex = new Map(safeAccounts.map(account => [account.index, account]))
        const merged = accounts.map(account => ({
            ...account,
            ...safeByIndex.get(account.index),
            ipCheck: accountIpChecker.get(account.index),
            execution: execution[account.index],
            ...(hybrid.metadata
                ? hybrid.metadata(account)
                : hybrid.enabled
                  ? {
                        node: hybrid.remoteOwned(account) ? 'vps' : 'local',
                        nodeOnline: hybrid.remoteOwned(account) ? hybrid.online : true
                    }
                  : {})
        }))
        sendJson(res, 200, {
            accounts: merged,
            count: merged.length,
            writable: allowAccountWrite && accountWriteAvailable(projectRoot)
        })
        return true
    }

    if (method === 'POST' && pathname === '/accounts/check-ip') {
        const body = await readJsonObject(req)
        try {
            const results = await accountIpChecker.check(body.accountIndexes ?? null)
            sendJson(res, 200, {
                results,
                count: results.length,
                succeeded: results.filter(result => result.ip !== null).length
            })
        } catch (error) {
            sendJson(res, error.code === 'BAD_REQUEST' ? 400 : 500, {
                error: error.code === 'BAD_REQUEST' ? error.message : 'IP check failed.'
            })
        }
        return true
    }

    if (method === 'POST' && pathname === '/accounts/validate') {
        const body = await readJsonObject(req)
        const rawAccounts = Array.isArray(body.accounts) ? body.accounts : [body]
        try {
            sendJson(res, 200, previewAccounts(projectRoot, rawAccounts))
        } catch (err) {
            sendJson(res, err.code === 'DUPLICATE_ACCOUNT' ? 409 : 400, {
                error: err.message,
                code: err.code
            })
        }
        return true
    }

    if (method === 'POST' && pathname === '/accounts') {
        if (!allowAccountWrite) {
            sendJson(res, 403, {
                error: 'Account writes are disabled. Set API_ALLOW_ACCOUNT_WRITE=true to enable.'
            })
            return true
        }
        const body = await readJsonObject(req)
        const rawAccounts = Array.isArray(body.accounts) ? body.accounts : [body]
        try {
            const result = addAccounts(projectRoot, rawAccounts)
            smartScheduler.enrollAccounts(result.accounts.map(account => account.index))
            pm.note('info', `Added ${result.count} account configuration(s) via API.`)
            sendJson(res, 201, { ...result, writable: true })
        } catch (err) {
            const status = ['DUPLICATE_ACCOUNT', 'ACCOUNT_WRITE_UNAVAILABLE', 'ACCOUNT_NOT_FOUND'].includes(err.code)
                ? 409
                : 400
            sendJson(res, status, { error: err.message, code: err.code })
        }
        return true
    }

    const accountMatch = /^\/accounts\/([1-9]\d*)$/.exec(pathname)
    if (!accountMatch) return false

    if (method === 'PATCH') {
        if (!allowAccountWrite) {
            sendJson(res, 403, {
                error: 'Account writes are disabled. Set API_ALLOW_ACCOUNT_WRITE=true to enable.'
            })
            return true
        }
        const body = await readJsonObject(req)
        try {
            const result = updateAccount(projectRoot, Number(accountMatch[1]), body)
            smartScheduler.replan()
            if (manualSessionManager.hasAccount(Number(accountMatch[1]))) {
                syncManualLock(Number(accountMatch[1]), true)
            }
            pm.note('info', `Updated ACCOUNT_${accountMatch[1]} configuration via API.`)
            sendJson(res, 200, { ...result, writable: true })
        } catch (err) {
            const status = err.code === 'ACCOUNT_NOT_FOUND' ? 404 : err.code === 'ACCOUNT_WRITE_UNAVAILABLE' ? 409 : 400
            sendJson(res, status, { error: err.message, code: err.code })
        }
        return true
    }

    if (method === 'DELETE') {
        if (!allowAccountWrite) {
            sendJson(res, 403, {
                error: 'Account writes are disabled. Set API_ALLOW_ACCOUNT_WRITE=true to enable.'
            })
            return true
        }
        const index = Number(accountMatch[1])
        const configured = loadAccounts()
        const target = configured.find(account => account.index === index)
        if (!target) {
            sendJson(res, 404, { error: `ACCOUNT_${index} is not configured.`, code: 'ACCOUNT_NOT_FOUND' })
            return true
        }
        if (configured.length <= 1) {
            sendJson(res, 409, {
                error: 'At least one account must remain configured.',
                code: 'LAST_ACCOUNT'
            })
            return true
        }
        const smartRunning = smartScheduler.get().running.some(job => job.accountIndex === index)
        if (pm.getStatus().state !== 'idle' || smartRunning || manualSessionManager.hasAccount(index)) {
            sendJson(res, 409, {
                error: 'Stop the active run before deleting this account.',
                code: 'RUN_ACTIVE'
            })
            return true
        }
        try {
            const result = deleteAccount(projectRoot, index)
            let sessions = null
            try {
                const loaded = loadConfigSafe(projectRoot)
                const sessionPath = typeof loaded?.data?.sessionPath === 'string' ? loaded.data.sessionPath : 'sessions'
                sessions = deleteStoredSessions(projectRoot, sessionPath, target.email)
            } catch (error) {
                pm.note('warn', `Deleted ACCOUNT_${index} configuration but could not remove stored sessions.`)
                sessions = { error: error instanceof Error ? error.message : String(error) }
            }
            smartScheduler.removeAccount(index)
            pm.note('info', `Deleted ACCOUNT_${index} configuration and stored account sessions.`)
            sendJson(res, 200, { ...result, sessions, writable: true })
        } catch (err) {
            const status = err.code === 'ACCOUNT_NOT_FOUND' ? 404 : err.code === 'ACCOUNT_WRITE_UNAVAILABLE' ? 409 : 400
            sendJson(res, status, { error: err.message, code: err.code })
        }
        return true
    }

    return false
}
