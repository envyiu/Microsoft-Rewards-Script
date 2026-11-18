import fs from 'node:fs'
import path from 'node:path'

import { deleteStoredSessions, listStoredSessions } from '../sessionStore.js'
import { clampInt, readForce } from './createRouter.js'

const DIAG_FILES = {
    'screenshot.png': 'image/png',
    'error.txt': 'text/plain; charset=utf-8',
    'dump.html': 'application/octet-stream'
}

export function listDiagnostics(diagDir) {
    let dirents
    try {
        dirents = fs
            .readdirSync(diagDir, { withFileTypes: true })
            .filter(d => d.isDirectory() && d.name.startsWith('error-'))
    } catch {
        return { dir: diagDir, count: 0, entries: [] }
    }
    const entries = dirents
        .map(d => {
            const full = path.join(diagDir, d.name)
            let files = []
            let createdAt = null
            let error = null
            try {
                files = fs.readdirSync(full)
            } catch {}
            try {
                createdAt = fs.statSync(full).mtime.toISOString()
            } catch {}
            if (files.includes('error.txt')) {
                try {
                    error = fs.readFileSync(path.join(full, 'error.txt'), 'utf8').slice(0, 2000)
                } catch {}
            }
            return {
                name: d.name,
                createdAt,
                hasScreenshot: files.includes('screenshot.png'),
                hasHtml: files.includes('dump.html'),
                hasError: files.includes('error.txt'),
                error
            }
        })
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    return { dir: diagDir, count: entries.length, entries }
}

export function serveDiagnosticFile(res, pathname, diagDir, sendJson) {
    let parts
    try {
        parts = pathname.slice('/diagnostics/'.length).split('/').filter(Boolean).map(decodeURIComponent)
    } catch {
        return sendJson(res, 400, { error: 'Invalid diagnostics path encoding' })
    }
    if (parts.length !== 2) return sendJson(res, 404, { error: 'Not found' })
    const [name, file] = parts
    if (!/^error-[A-Za-z0-9._:-]+$/.test(name) || !(file in DIAG_FILES)) {
        return sendJson(res, 400, { error: 'Invalid diagnostics path' })
    }
    const full = path.join(diagDir, name, file)
    if (!path.resolve(full).startsWith(path.resolve(diagDir) + path.sep)) {
        return sendJson(res, 400, { error: 'Invalid diagnostics path' })
    }
    if (!fs.existsSync(full)) return sendJson(res, 404, { error: 'Not found' })
    const headers = { 'Content-Type': DIAG_FILES[file] }
    if (file === 'dump.html') headers['Content-Disposition'] = `attachment; filename="${name}-dump.html"`
    res.writeHead(200, headers)
    fs.createReadStream(full).pipe(res)
}

export async function handleSessionAndObservabilityRoutes(ctx) {
    const {
        req,
        res,
        url,
        method,
        pathname,
        sendJson,
        readJsonObject,
        pkgName,
        pkgVersion,
        tokenSet,
        startedAt,
        getStatus,
        pm,
        logBuffer,
        runHistory,
        toHistoryRecord,
        projectRoot,
        loadConfigSafe,
        containsControlCharacters,
        diagDir,
        handleEventStream,
        shutdown
    } = ctx

    if (method === 'GET' && pathname === '/') {
        sendJson(res, 200, {
            name: pkgName,
            version: pkgVersion,
            message: 'Control API',
            authRequired: Boolean(tokenSet),
            stateless: true,
            endpoints: [
                'GET /health',
                'GET /status',
                'GET /points',
                'GET /logs',
                'GET /errors',
                'GET /history',
                'GET /accounts',
                'POST /accounts/check-ip',
                'POST /accounts/validate',
                'POST /accounts',
                'PATCH /accounts/:index',
                'DELETE /accounts/:index',
                'GET /sessions',
                'GET /diagnostics',
                'GET /events',
                'GET /config',
                'GET /config/diff',
                'POST /config/sync',
                'GET /schedule',
                'GET /smart-schedule',
                'GET /manual-sessions',
                'POST /manual-sessions',
                'GET /android-sessions',
                'POST /android-sessions',
                'POST /android-sessions/:accountIndex/viewer',
                'POST /android-sessions/:accountIndex/stop',
                'DELETE /android-sessions/:accountIndex',
                'POST /start',
                'POST /stop',
                'POST /restart',
                'POST /shutdown',
                'DELETE /sessions/:email',
                'PUT|PATCH /config',
                'PUT|PATCH /schedule',
                'PUT /smart-schedule',
                'POST /smart-schedule/replan',
                'POST /smart-schedule/urgent'
            ]
        })
        return true
    }

    if (method === 'GET' && pathname === '/health') {
        sendJson(res, 200, {
            ok: true,
            name: pkgName,
            version: pkgVersion,
            state: getStatus().state,
            uptimeSec: Math.round((Date.now() - startedAt) / 1000),
            authRequired: Boolean(tokenSet)
        })
        return true
    }

    if (method === 'GET' && pathname === '/status') {
        sendJson(res, 200, getStatus())
        return true
    }

    if (method === 'GET' && pathname === '/points') {
        sendJson(res, 200, pm.getPoints())
        return true
    }

    if (method === 'GET' && pathname === '/logs') {
        const limit = clampInt(url.searchParams.get('limit'), 1, logBuffer, 200)
        const afterId = url.searchParams.has('afterId') ? Number(url.searchParams.get('afterId')) : null
        const minLevel = url.searchParams.get('level') || null
        if (minLevel && !['debug', 'info', 'warn', 'error'].includes(minLevel)) {
            sendJson(res, 400, {
                error: '`level` must be one of: debug, info, warn, error.',
                code: 'BAD_REQUEST'
            })
            return true
        }
        sendJson(res, 200, pm.getLogs({ limit, afterId: Number.isFinite(afterId) ? afterId : null, minLevel }))
        return true
    }

    if (method === 'GET' && pathname === '/errors') {
        const limit = clampInt(url.searchParams.get('limit'), 1, logBuffer, 100)
        const includeWarnings = url.searchParams.get('warnings') !== 'false'
        sendJson(res, 200, pm.getErrors({ limit, includeWarnings }))
        return true
    }

    if (method === 'GET' && pathname === '/history') {
        const limit = clampInt(url.searchParams.get('limit'), 1, runHistory, runHistory)
        const runs = pm.getHistory().slice(0, limit).map(toHistoryRecord)
        sendJson(res, 200, { runs, count: runs.length, inMemoryOnly: true })
        return true
    }

    if (method === 'GET' && pathname === '/sessions') {
        const loaded = loadConfigSafe(projectRoot)
        if (!loaded) {
            sendJson(res, 404, { error: 'config.json not found' })
            return true
        }
        if (loaded.data == null) {
            sendJson(res, 500, { error: 'config.json is invalid', detail: loaded.error })
            return true
        }
        const sessionPath = typeof loaded.data.sessionPath === 'string' ? loaded.data.sessionPath : 'sessions'
        sendJson(res, 200, listStoredSessions(projectRoot, sessionPath))
        return true
    }

    if (method === 'DELETE' && pathname === '/sessions') {
        sendJson(res, 400, {
            error: 'An account email is required. Use DELETE /sessions/:email.',
            code: 'EMAIL_REQUIRED'
        })
        return true
    }

    if (method === 'DELETE' && pathname.startsWith('/sessions/')) {
        if (pm.getStatus().state !== 'idle') {
            sendJson(res, 409, {
                error: 'Cannot delete sessions while a bot run is active. Stop the run first.',
                code: 'RUN_ACTIVE'
            })
            return true
        }
        let email
        try {
            email = decodeURIComponent(pathname.slice('/sessions/'.length)).trim()
        } catch {
            sendJson(res, 400, { error: 'The session email path is not valid URL encoding.' })
            return true
        }
        if (!email || email.length > 320 || !email.includes('@') || containsControlCharacters(email)) {
            sendJson(res, 400, {
                error: 'A valid account email is required in DELETE /sessions/:email.',
                code: 'INVALID_EMAIL'
            })
            return true
        }
        const loaded = loadConfigSafe(projectRoot)
        if (!loaded) {
            sendJson(res, 404, { error: 'config.json not found' })
            return true
        }
        if (loaded.data == null) {
            sendJson(res, 500, { error: 'config.json is invalid', detail: loaded.error })
            return true
        }
        const sessionPath = typeof loaded.data.sessionPath === 'string' ? loaded.data.sessionPath : 'sessions'
        const result = deleteStoredSessions(projectRoot, sessionPath, email)
        if (!result.found) {
            sendJson(res, 404, {
                error: `No stored sessions found for ${email}.`,
                code: 'SESSION_NOT_FOUND'
            })
            return true
        }
        pm.note('info', `Deleted ${result.removed} stored session row(s) for ${result.email} via API.`)
        sendJson(res, 200, { deleted: true, ...result })
        return true
    }

    if (method === 'GET' && pathname === '/diagnostics') {
        sendJson(res, 200, listDiagnostics(diagDir))
        return true
    }

    if (method === 'GET' && pathname.startsWith('/diagnostics/')) {
        serveDiagnosticFile(res, pathname, diagDir, sendJson)
        return true
    }

    if (method === 'GET' && pathname === '/events') {
        handleEventStream(req, res, url)
        return true
    }

    if (method === 'POST' && pathname === '/shutdown') {
        const body = await readJsonObject(req)
        const force = readForce(body)
        sendJson(res, 202, { shuttingDown: true, stoppingBot: pm.getStatus().state !== 'idle' })
        setTimeout(() => void shutdown('API /shutdown', { force }), 50)
        return true
    }

    return false
}
