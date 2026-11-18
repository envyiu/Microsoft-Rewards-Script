import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createGunzip, gzip } from 'node:zlib'
import { fileURLToPath } from 'node:url'

import { ProcessManager } from './processManager.js'
import { accountExecutions } from './execution.js'
import { AccountIpChecker } from './accountIpChecker.js'
import { loadAccounts } from '../../packages/contracts/accounts.js'
import { resolveRunCommand } from './runCommand.js'
import { SmartScheduler, deriveNetworkGroup } from './smartScheduler.js'
import { ManualSessionManager } from './manualSessionManager.js'
import { Hybrid } from './hybrid.js'
import { accountRefForEmail } from './androidSessions.js'
import {
    log,
    parseArgs,
    findUnknownOptions,
    getProjectRoot,
    loadEnvFile,
    loadConfigSafe,
    envStr,
    envBool
} from './lib.js'
import { createRouter } from './routes/createRouter.js'
import { handleSessionAndObservabilityRoutes } from './routes/sessions.js'
import { handleAccountRoutes } from './routes/accounts.js'
import { handleConfigAndLegacyScheduleRoutes } from './routes/config.js'
import { handleSmartScheduleAndControlRoutes } from './routes/smartSchedule.js'
import { handleManualSessionRoutes } from './routes/manualSessions.js'
import { handleAndroidSessionRoutes } from './routes/androidSessions.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = getProjectRoot(__dirname)

if (process.env.MRS_SKIP_ENV_FILE !== '1') loadEnvFile(projectRoot)
const Controller =
    process.env.MRS_WORKER_MODE === '1'
        ? (await import('../worker/agent.js')).WorkerAgent
        : process.env.MRS_FLEET_ENABLED === '1' && process.env.MRS_NODE_ROLE === 'local'
          ? (await import('./fleet.js')).Fleet
          : Hybrid
const hybrid = new Controller({
    projectRoot,
    environment: process.env
})

const cliArgs = parseArgs(process.argv.slice(2), { boolean: ['help', 'h'] })

function printHelp() {
    console.log(`
Microsoft Rewards control API

Usage:
  npm run api
  npm run api -- [--host <address>] [--port <number>] [--token <token>]

Options:
  --host        Listen address. Defaults to API_HOST or 127.0.0.1.
  --port        Listen port from 1 to 65535. Defaults to API_PORT or 3010.
  --token       One-time API token. API_TOKEN from .env takes precedence.
  --help        Show this help.

Examples:
  npm run api
  npm run api -- --port 3010
  npm run api -- --host 0.0.0.0 --port 3010 --token "YOUR_API_TOKEN"
`)
}

function failUsage(message) {
    log('ERROR', message)
    printHelp()
    process.exit(1)
}

if (cliArgs.help || cliArgs.h) {
    printHelp()
    process.exit(0)
}

const unknownOptions = findUnknownOptions(cliArgs, ['host', 'port', 'token', 'help', 'h'])
if (unknownOptions.length) {
    failUsage(
        `Unknown option${unknownOptions.length === 1 ? '' : 's'}: ${unknownOptions.map(v => `--${v}`).join(', ')}`
    )
}
if (cliArgs._.length) {
    failUsage(`Unexpected positional argument${cliArgs._.length === 1 ? '' : 's'}: ${cliArgs._.join(' ')}`)
}
for (const option of ['host', 'port', 'token']) {
    if (cliArgs[option] === true || cliArgs[option] === '') {
        failUsage(`--${option} requires a value after it.`)
    }
}

function integerSetting(name, value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (value === undefined) return fallback
    const parsed = Number(value)
    if (typeof value === 'boolean' || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        log('ERROR', `${name} must be an integer between ${min} and ${max}.`)
        process.exit(1)
    }
    return parsed
}

let pkgVersion = '0.0.0'
let pkgName = 'microsoft-rewards-script'
try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
    pkgVersion = pkg.version ?? pkgVersion
    pkgName = pkg.name ?? pkgName
} catch {}

const HOST = envStr('API_HOST') ?? (typeof cliArgs.host === 'string' ? cliArgs.host : '127.0.0.1')
const PORT =
    cliArgs.port !== undefined
        ? integerSetting('--port', cliArgs.port, 3010, { max: 65535 })
        : integerSetting('API_PORT', envStr('API_PORT'), 3010, { max: 65535 })
const TOKEN = envStr('API_TOKEN') ?? (typeof cliArgs.token === 'string' ? cliArgs.token : undefined)
const CORS_ORIGIN = envStr('API_CORS_ORIGIN') ?? '*'
const LOG_BUFFER = integerSetting('API_LOG_BUFFER', envStr('API_LOG_BUFFER'), 2000)
const STOP_TIMEOUT_MS = integerSetting('API_STOP_TIMEOUT_MS', envStr('API_STOP_TIMEOUT_MS'), 15000)
const ALLOW_ENV_OVERRIDES = envBool('API_ALLOW_ENV_OVERRIDES', false)
const REVEAL_ENABLED = envBool('API_ALLOW_CONFIG_REVEAL', false)
const ALLOW_CONFIG_WRITE = envBool('API_ALLOW_CONFIG_WRITE', false)
const ALLOW_SCHEDULE_WRITE = envBool('API_ALLOW_SCHEDULE_WRITE', false)
const ALLOW_ACCOUNT_WRITE = envBool('API_ALLOW_ACCOUNT_WRITE', false)

const RUN_HISTORY = integerSetting('API_RUN_HISTORY', envStr('API_RUN_HISTORY'), 20)
const DIAG_DIR = envStr('API_DIAGNOSTICS_DIR') ?? path.join(projectRoot, 'diagnostics')
const SMART_SCHEDULE_FILE = envStr('SMART_SCHEDULE_FILE') ?? path.join(projectRoot, 'config', 'smart-schedule.json')
const accountIpChecker = new AccountIpChecker()

const { command, args } = resolveRunCommand({ projectRoot })

const pm = new ProcessManager({
    command,
    args,
    cwd: projectRoot,
    stopTimeoutMs: STOP_TIMEOUT_MS,
    logBufferSize: LOG_BUFFER,
    historySize: RUN_HISTORY,
    name: pkgName,
    version: pkgVersion
})

const smartScheduler = new SmartScheduler({
    projectRoot,
    command,
    args,
    stopTimeoutMs: STOP_TIMEOUT_MS,
    configFile: SMART_SCHEDULE_FILE,
    onLog: entry => pm.ingestEntry(entry),
    ...hybrid.schedulerOptions()
})

function syncManualLock(accountIndex, active) {
    if (hybrid.holds?.[accountIndex]) {
        const hold = hybrid.holds[accountIndex]
        smartScheduler.setManualLock(accountIndex, hold.scope === 'account' ? null : hold.group)
        return
    }
    if (!active) {
        smartScheduler.clearManualLock(accountIndex)
        return
    }
    const account = loadAccounts().find(item => item.index === Number(accountIndex))
    if (!account) return
    smartScheduler.setManualLock(
        account.index,
        process.env.MRS_WORKER_MODE === '1'
            ? null
            : deriveNetworkGroup(account, smartScheduler.get().config.networkGroupOverride)
    )
}

const manualSessionManager = new ManualSessionManager({
    projectRoot,
    stopTimeoutMs: STOP_TIMEOUT_MS,
    onAccountChange: syncManualLock,
    onLog: entry => {
        const prefix = `manual ACCOUNT_${entry.manualSession.accountIndex} ${entry.manualSession.platform}`
        pm.note(entry.level ?? 'info', `${prefix}: ${entry.raw ?? entry.message ?? ''}`)
    }
})

function refreshManualLocks() {
    for (const accountIndex of new Set(manualSessionManager.list().map(session => session.accountIndex))) {
        syncManualLock(accountIndex, true)
    }
}

function getSmartState() {
    const smart = hybrid.decorateSmart({
        ...smartScheduler.get(),
        configuredAccounts: loadAccounts().map(({ index, email }) => ({ index, email })),
        manualSessions: manualSessionManager.list()
    })
    smart.execution = accountExecutions(loadAccounts(), smart, pm.getStatus(), account =>
        hybrid.metadata
            ? hybrid.metadata(account)
            : hybrid.role === 'local' && hybrid.remoteOwned(account)
              ? { node: 'vps' }
              : {}
    )
    return smart
}

hybrid.attach({
    scheduler: smartScheduler,
    pm,
    manual: manualSessionManager,
    status: getStatus,
    permissions: { schedule: ALLOW_SCHEDULE_WRITE, accounts: ALLOW_ACCOUNT_WRITE, config: ALLOW_CONFIG_WRITE }
})

function getStatus() {
    const status = pm.getStatus()
    const smart = getSmartState()
    if (!status.alive) status.state = 'idle'
    if (status.state === 'idle' && smart.running.length) status.state = 'running'
    if (status.state === 'idle' && Object.values(smart.execution).some(execution => execution.state === 'unknown'))
        status.state = 'unknown'
    return { ...status, smart, manualSessions: smart.manualSessions }
}

function publicAndroidSessions(rows) {
    const accounts = new Map(loadAccounts().map(account => [accountRefForEmail(account.email), account]))
    return (Array.isArray(rows) ? rows : []).map(row => {
        const account = accounts.get(row.accountRef)
        return {
            accountIndex: account?.index ?? null,
            email: account?.email ?? null,
            worker: row.worker ?? null,
            state: row.state ?? 'unknown',
            viewer: row.viewer ?? 'closed',
            provisioned: row.provisioned === true,
            manualAccount: row.manualAccount === true,
            profile: row.profile ?? null
        }
    })
}

function publicAndroidSession(session, account) {
    const safe = publicAndroidSessions([session]).at(0) ?? {
        accountIndex: account.index,
        email: account.email,
        worker: null,
        state: 'unknown',
        viewer: 'closed',
        provisioned: false,
        manualAccount: true,
        profile: null
    }
    return { ...safe, accountIndex: account.index, email: account.email }
}

const startedAt = Date.now()

function containsControlCharacters(value) {
    return [...value].some(character => {
        const code = character.charCodeAt(0)
        return code < 32 || code === 127
    })
}

if (containsControlCharacters(HOST) || containsControlCharacters(CORS_ORIGIN)) {
    log('ERROR', 'API_HOST and API_CORS_ORIGIN must not contain control characters.')
    process.exit(1)
}

pm.on('log', entry => {
    const line = (entry.raw ?? entry.message ?? '') + '\n'
    if (entry.source === 'stderr') process.stderr.write(line)
    else process.stdout.write(line)
})

function toHistoryRecord(entry) {
    return {
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        exit: entry.exit,
        version: entry.run?.version ?? null,
        collected: entry.run?.collected ?? 0,
        accounts: (entry.run?.accounts ?? []).map(a => ({
            email: a.email,
            collected: a.collectedPoints ?? a.live?.gained ?? 0,
            success: a.success,
            error: a.error,
            streakProtection: a.streakProtection ?? null,
            rewardsStreak: a.rewardsStreak ?? null,
            edgeBrowsing: a.edgeBrowsing ?? null
        }))
    }
}

function applyCors(res) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key')
    res.setHeader('Access-Control-Max-Age', '86400')
}

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(body)
}

function tokenFromReq(req, url) {
    const auth = req.headers['authorization']
    if (typeof auth === 'string') {
        const bearer = /^Bearer\s+(.+)$/i.exec(auth)
        if (bearer) return bearer[1].trim()
    }
    const apiKey = req.headers['x-api-key']
    if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim()
    const q = url.searchParams.get('token')
    if (q && url.pathname.replace(/\/+$/, '') === '/events') return q
    return null
}

function safeEqual(a, b) {
    const bufA = Buffer.from(String(a))
    const bufB = Buffer.from(String(b))
    if (bufA.length !== bufB.length) return false
    return crypto.timingSafeEqual(bufA, bufB)
}

function isAuthorized(req, url) {
    if (!TOKEN) return true
    const provided = tokenFromReq(req, url)
    if (!provided) return false
    return safeEqual(provided, TOKEN)
}

async function readJsonBody(req, limitBytes = 1_000_000) {
    return new Promise((resolve, reject) => {
        let size = 0
        const chunks = []
        const input = req.headers['content-encoding'] === 'gzip' ? req.pipe(createGunzip()) : req
        input.on('data', chunk => {
            size += chunk.length
            if (size > limitBytes) {
                reject(Object.assign(new Error('Request body too large.'), { code: 'BODY_TOO_LARGE' }))
                req.destroy()
                return
            }
            chunks.push(chunk)
        })
        input.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8').trim()
            if (!raw) return resolve({})
            try {
                resolve(JSON.parse(raw))
            } catch {
                reject(Object.assign(new Error('Invalid JSON body.'), { code: 'BAD_JSON' }))
            }
        })
        input.on('error', reject)
        if (input !== req) req.on('error', reject)
    })
}

async function readJsonObject(req, limitBytes) {
    const body = await readJsonBody(req, limitBytes)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw Object.assign(new Error('Body must be a JSON object.'), { code: 'BAD_REQUEST' })
    }
    return body
}

function handleEventStream(req, res, url) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    })
    if (typeof res.flushHeaders === 'function') res.flushHeaders()

    const write = frame => {
        if (!res.writableEnded) res.write(frame)
    }
    const sendEvent = (event, data, id) => {
        let frame = ''
        if (id != null) frame += `id: ${id}\n`
        frame += `event: ${event}\n`
        frame += `data: ${JSON.stringify(data)}\n\n`
        write(frame)
    }

    sendEvent('hello', getStatus())

    const lastEventId = Number(req.headers['last-event-id'])
    if (Number.isFinite(lastEventId) && lastEventId > 0) {
        for (const entry of pm.getLogs({ afterId: lastEventId }).logs) {
            sendEvent('log', entry, entry.id)
        }
    } else {
        const replay = Math.max(0, Math.min(Number(url.searchParams.get('replay') ?? 100) || 0, LOG_BUFFER))
        if (replay > 0) {
            for (const entry of pm.getLogs({ limit: replay }).logs) {
                sendEvent('log', entry, entry.id)
            }
        }
    }

    const onLog = entry => sendEvent('log', entry, entry.id)
    const onStatus = status => sendEvent('status', { reason: status.reason, ...getStatus() })
    const onSmart = () => sendEvent('status', { reason: 'smart-schedule', ...getStatus() })
    const onManual = () => sendEvent('status', { reason: 'manual-session', ...getStatus() })
    pm.on('log', onLog)
    pm.on('status', onStatus)
    smartScheduler.on('change', onSmart)
    manualSessionManager.on('change', onManual)

    const keepAlive = setInterval(() => write(': ping\n\n'), 15000)
    if (typeof keepAlive.unref === 'function') keepAlive.unref()

    const cleanup = () => {
        clearInterval(keepAlive)
        pm.off('log', onLog)
        pm.off('status', onStatus)
        smartScheduler.off('change', onSmart)
        manualSessionManager.off('change', onManual)
        if (!res.writableEnded) res.end()
    }
    req.on('close', cleanup)
    req.on('error', cleanup)
}

const dispatchApiRoutes = createRouter([
    handleSessionAndObservabilityRoutes,
    handleAccountRoutes,
    handleConfigAndLegacyScheduleRoutes,
    handleSmartScheduleAndControlRoutes,
    handleManualSessionRoutes,
    handleAndroidSessionRoutes
])

const requestHandler = async (req, res) => {
    let url
    try {
        url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    } catch {
        applyCors(res)
        return sendJson(res, 400, { error: 'Invalid request URL.', code: 'BAD_REQUEST' })
    }
    const pathname = url.pathname.replace(/\/+$/, '') || '/'
    const method = req.method ?? 'GET'

    applyCors(res)

    if (method === 'OPTIONS') {
        res.writeHead(204)
        return res.end()
    }

    if (TOKEN && !isAuthorized(req, url)) {
        return sendJson(res, 401, {
            error: 'Unauthorized',
            hint: 'Provide the API token via Authorization: Bearer or X-API-Key. Browser EventSource may use ?token= only on /events. All endpoints require authentication while API_TOKEN is set.'
        })
    }

    try {
        if (
            await hybrid.handle(req, res, url, {
                read: request =>
                    readJsonObject(request, pathname.startsWith('/internal/hybrid/') ? 128 * 1024 * 1024 : 1_000_000),
                send: (response, status, data) => {
                    if (
                        !pathname.startsWith('/internal/hybrid/') ||
                        !String(req.headers['accept-encoding']).includes('gzip')
                    ) {
                        return sendJson(response, status, data)
                    }
                    gzip(JSON.stringify(data), (error, buffer) => {
                        if (error) return sendJson(response, 500, { error: 'Could not encode node response' })
                        response.writeHead(status, {
                            'Content-Type': 'application/json; charset=utf-8',
                            'Content-Encoding': 'gzip'
                        })
                        response.end(buffer)
                    })
                }
            })
        ) {
            return
        }

        const handled = await dispatchApiRoutes({
            req,
            res,
            url,
            method,
            pathname,
            sendJson,
            readJsonBody,
            readJsonObject,
            projectRoot,
            pkgName,
            pkgVersion,
            tokenSet: Boolean(TOKEN),
            revealEnabled: REVEAL_ENABLED,
            allowConfigWrite: ALLOW_CONFIG_WRITE,
            allowScheduleWrite: ALLOW_SCHEDULE_WRITE,
            allowAccountWrite: ALLOW_ACCOUNT_WRITE,
            allowEnvOverrides: ALLOW_ENV_OVERRIDES,
            startedAt,
            getStatus,
            getSmartState,
            pm,
            logBuffer: LOG_BUFFER,
            runHistory: RUN_HISTORY,
            toHistoryRecord,
            loadConfigSafe,
            containsControlCharacters,
            diagDir: DIAG_DIR,
            handleEventStream,
            shutdown,
            accountIpChecker,
            hybrid,
            smartScheduler,
            manualSessionManager,
            syncManualLock,
            refreshManualLocks,
            publicAndroidSession,
            publicAndroidSessions
        })
        if (handled) return

        return sendJson(res, 404, { error: 'Not found', path: pathname })
    } catch (err) {
        if (err?.code && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
            return sendJson(res, err.status, {
                error: err.message,
                code: err.code,
                ...(err.nextEligibleAt !== undefined ? { nextEligibleAt: err.nextEligibleAt } : {})
            })
        }
        if (err && (err.code === 'BAD_JSON' || err.code === 'BODY_TOO_LARGE' || err.code === 'BAD_REQUEST')) {
            return sendJson(res, 400, { error: err.message, code: err.code })
        }
        log('ERROR', 'Unhandled request error:', err instanceof Error ? err.stack : err)
        if (!res.headersSent) return sendJson(res, 500, { error: 'Internal server error' })
    }
}

// startup
const server = http.createServer(requestHandler)

server.on('error', err => {
    if (err && err.code === 'EADDRINUSE') {
        log('ERROR', `Port ${PORT} is already in use on ${HOST}. Set API_PORT to a free port.`)
        process.exit(1)
    }
    log('ERROR', 'Server error:', err instanceof Error ? err.message : err)
    process.exit(1)
})

server.listen(PORT, HOST, () => {
    log('INFO', `${pkgName} control API listening on http://${HOST}:${PORT} (headless - no UI)`)
    log('INFO', `Launch command: ${command} ${args.join(' ')}`.trim())
    log(
        'INFO',
        `Auth: ${TOKEN ? 'shared token required (API_TOKEN)' : 'DISABLED (no API_TOKEN set)'} | CORS origin: ${CORS_ORIGIN}`
    )
    log(
        'INFO',
        `Runtime state: memory-only | config writes: ${ALLOW_CONFIG_WRITE ? 'on' : 'off'} | schedule writes: ${ALLOW_SCHEDULE_WRITE ? 'on' : 'off'} | account writes: ${ALLOW_ACCOUNT_WRITE ? 'on' : 'off'} | session deletion: account-scoped`
    )
    if (!TOKEN) {
        const loopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1'
        log(
            loopback ? 'WARN' : 'ERROR',
            loopback
                ? 'No API_TOKEN set - the API is open to anything on this machine. Set API_TOKEN and give the dashboard the same value as CONTROL_API_TOKEN.'
                : 'API is bound to a non-loopback address WITHOUT a token - anyone who can reach this port can start/stop the bot and read your logs. Set API_TOKEN.'
        )
    }

    const ready = {
        host: HOST,
        port: PORT,
        pid: process.pid,
        name: pkgName,
        version: pkgVersion,
        auth: Boolean(TOKEN)
    }
    process.stdout.write(`__API_READY__ ${JSON.stringify(ready)}\n`)
})

let shuttingDown = false
async function shutdown(signal, { force = false } = {}) {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(hybrid.timer)
    log('INFO', `${signal} received - shutting down.`)
    server.close()
    try {
        if (smartScheduler.get().running.length) {
            log('INFO', 'Stopping active Smart Scheduler sessions…')
            await smartScheduler.stop({ resume: false })
        }
        if (pm.getStatus().state !== 'idle') {
            log('INFO', `Stopping active bot run${force ? ' (force)' : ''}…`)
            await pm.stop({ force })
        }
        if (manualSessionManager.list().length) {
            log('INFO', 'Stopping manual browser sessions…')
            await manualSessionManager.stopAll({ force })
        }
    } catch {
        // ignore
    }
    process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
