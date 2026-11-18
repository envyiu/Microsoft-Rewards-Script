import { loadAccounts } from '../../../packages/contracts/accounts.js'

export async function handleManualSessionRoutes(ctx) {
    const { req, res, method, pathname, sendJson, readJsonObject, manualSessionManager, smartScheduler, pm } = ctx

    if (method === 'GET' && pathname === '/manual-sessions') {
        sendJson(res, 200, { sessions: manualSessionManager.list() })
        return true
    }

    if (method === 'POST' && pathname === '/manual-sessions') {
        const body = await readJsonObject(req)
        const accountIndex = Number(body.accountIndex)
        const platform = typeof body.platform === 'string' ? body.platform.toLowerCase() : ''
        if (!Number.isSafeInteger(accountIndex) || accountIndex < 1 || !['desktop', 'mobile'].includes(platform)) {
            sendJson(res, 400, {
                error: 'accountIndex must be a positive integer and platform must be desktop or mobile.',
                code: 'BAD_REQUEST'
            })
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
            const session = await manualSessionManager.open({
                accountIndex,
                email: account.email,
                platform,
                preRewards: smartScheduler.isPreRewardsAccount(accountIndex)
            })
            pm.note('info', `Opened manual ${platform} session for ACCOUNT_${accountIndex}.`)
            sendJson(res, 202, { opened: true, session })
        } catch (error) {
            const status =
                error.code === 'BAD_REQUEST'
                    ? 400
                    : error.code === 'START_TIMEOUT'
                      ? 504
                      : error.code === 'START_FAILED'
                        ? 502
                        : 500
            sendJson(res, status, { error: error.message, code: error.code })
        }
        return true
    }

    const closeManualSessionMatch = pathname.match(/^\/manual-sessions\/(\d+)\/close$/)
    if (method === 'POST' && closeManualSessionMatch) {
        const accountIndex = Number(closeManualSessionMatch[1])
        const body = await readJsonObject(req)
        const platform = typeof body.platform === 'string' ? body.platform.toLowerCase() : ''
        if (!Number.isSafeInteger(accountIndex) || accountIndex < 1 || !['desktop', 'mobile'].includes(platform)) {
            sendJson(res, 400, {
                error: 'A positive account index and platform desktop or mobile are required.',
                code: 'BAD_REQUEST'
            })
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
            const closed = await manualSessionManager.closeForAccount({ accountIndex, platform })
            pm.note('info', `Closed ${closed} manual ${platform} browser session(s) for ACCOUNT_${accountIndex}.`)
            sendJson(res, 200, { closed, accountIndex, platform })
        } catch (error) {
            sendJson(res, 500, { error: error.message, code: error.code ?? 'CLOSE_FAILED' })
        }
        return true
    }

    return false
}
