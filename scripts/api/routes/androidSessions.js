import { loadAccounts } from '../../../packages/contracts/accounts.js'
import {
    deleteAndroidSession,
    getAndroidSessions,
    openAndroidSession,
    openAndroidViewer,
    stopAndroidSession
} from '../androidSessions.js'

const BRIDGE_UNAVAILABLE_CODES = ['BRIDGE_UNAVAILABLE', 'BRIDGE_TIMEOUT', 'DAMRU_NOT_READY', 'SCRCPY_UNAVAILABLE']

export async function handleAndroidSessionRoutes(ctx) {
    const {
        req,
        res,
        method,
        pathname,
        sendJson,
        readJsonObject,
        pm,
        smartScheduler,
        publicAndroidSession,
        publicAndroidSessions
    } = ctx

    if (method === 'GET' && pathname === '/android-sessions') {
        try {
            const state = await getAndroidSessions()
            sendJson(res, 200, { sessions: publicAndroidSessions(state.sessions) })
        } catch (error) {
            const status = BRIDGE_UNAVAILABLE_CODES.includes(error.code) ? 503 : 502
            sendJson(res, status, { error: error.message, code: error.code || 'BRIDGE_ERROR' })
        }
        return true
    }

    if (method === 'POST' && pathname === '/android-sessions') {
        const body = await readJsonObject(req)
        const accountIndex = Number(body.accountIndex)
        if (!Number.isSafeInteger(accountIndex) || accountIndex < 1) {
            sendJson(res, 400, { error: 'accountIndex must be a positive integer.', code: 'BAD_REQUEST' })
            return true
        }
        const account = loadAccounts().find(item => item.index === accountIndex)
        if (!account) {
            sendJson(res, 404, {
                error: `ACCOUNT_${accountIndex} is not configured.`,
                code: 'ACCOUNT_NOT_FOUND'
            })
            return true
        }
        try {
            const session = await openAndroidSession({ accountIndex, email: account.email })
            sendJson(res, 202, { opened: true, session: publicAndroidSession(session, account) })
        } catch (error) {
            const status = ['INVALID_PROXY_CONFIG', 'NO_WORKER_AVAILABLE', 'NO_PROFILE_AVAILABLE'].includes(error.code)
                ? 409
                : BRIDGE_UNAVAILABLE_CODES.includes(error.code)
                  ? 503
                  : 502
            sendJson(res, status, { error: error.message, code: error.code || 'BRIDGE_ERROR' })
        }
        return true
    }

    const androidDeleteMatch = /^\/android-sessions\/([1-9]\d*)$/.exec(pathname)
    if (method === 'DELETE' && androidDeleteMatch) {
        const accountIndex = Number(androidDeleteMatch[1])
        const account = loadAccounts().find(item => item.index === accountIndex)
        if (!account) {
            sendJson(res, 404, {
                error: `ACCOUNT_${accountIndex} is not configured.`,
                code: 'ACCOUNT_NOT_FOUND'
            })
            return true
        }
        const body = await readJsonObject(req)
        if (
            !Number.isInteger(body.worker) ||
            body.worker < 0 ||
            body.worker > 49 ||
            body.confirmation !== `DELETE ${body.worker}`
        ) {
            sendJson(res, 400, {
                error: 'An expected worker index (0–49) and matching DELETE confirmation are required.',
                code: 'BAD_REQUEST'
            })
            return true
        }
        if (pm.getStatus().state !== 'idle' || smartScheduler.get().running.length) {
            sendJson(res, 409, {
                error: 'Stop the active bot run before deleting an Android device.',
                code: 'RUN_ACTIVE'
            })
            return true
        }
        try {
            const result = await deleteAndroidSession({
                accountIndex,
                email: account.email,
                worker: body.worker,
                confirmation: body.confirmation
            })
            sendJson(res, 200, {
                deleted: result.deleted === true,
                accountIndex,
                worker: result.worker ?? null
            })
        } catch (error) {
            const status = ['WORKER_CHANGED', 'WORKER_BUSY'].includes(error.code)
                ? 409
                : ['BRIDGE_UNAVAILABLE', 'BRIDGE_TIMEOUT', 'DAMRU_NOT_READY'].includes(error.code)
                  ? 503
                  : 502
            sendJson(res, status, { error: error.message, code: error.code || 'BRIDGE_ERROR' })
        }
        return true
    }

    const androidViewerMatch = /^\/android-sessions\/([1-9]\d*)\/viewer$/.exec(pathname)
    if (method === 'POST' && androidViewerMatch) {
        const accountIndex = Number(androidViewerMatch[1])
        const account = loadAccounts().find(item => item.index === accountIndex)
        if (!account) {
            sendJson(res, 404, {
                error: `ACCOUNT_${accountIndex} is not configured.`,
                code: 'ACCOUNT_NOT_FOUND'
            })
            return true
        }
        try {
            const session = await openAndroidViewer({ accountIndex, email: account.email })
            sendJson(res, 202, { opened: true, session: publicAndroidSession(session, account) })
        } catch (error) {
            const status = BRIDGE_UNAVAILABLE_CODES.includes(error.code) ? 503 : 502
            sendJson(res, status, { error: error.message, code: error.code || 'BRIDGE_ERROR' })
        }
        return true
    }

    const androidStopMatch = /^\/android-sessions\/([1-9]\d*)\/stop$/.exec(pathname)
    if (method === 'POST' && androidStopMatch) {
        const accountIndex = Number(androidStopMatch[1])
        const account = loadAccounts().find(item => item.index === accountIndex)
        if (!account) {
            sendJson(res, 404, {
                error: `ACCOUNT_${accountIndex} is not configured.`,
                code: 'ACCOUNT_NOT_FOUND'
            })
            return true
        }
        try {
            const session = await stopAndroidSession({ accountIndex, email: account.email })
            sendJson(res, 202, { stopping: true, session: publicAndroidSession(session, account) })
        } catch (error) {
            const status = BRIDGE_UNAVAILABLE_CODES.includes(error.code) ? 503 : 502
            sendJson(res, status, { error: error.message, code: error.code || 'BRIDGE_ERROR' })
        }
        return true
    }

    return false
}
