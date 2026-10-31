import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

import { ProcessManager } from './processManager.js'
import { requestSaveAndClose } from './manualSessionClose.js'

const PLATFORMS = new Set(['desktop', 'mobile'])
const READY_LOG_RE = /manual browser ready/i

export function resolveManualBrowserEnvironment({
    platform = process.platform,
    environment = process.env,
    uid = typeof process.getuid === 'function' ? process.getuid() : null,
    runtimeDirectories
} = {}) {
    if (platform !== 'linux') return {}
    if (environment.DISPLAY || environment.WAYLAND_DISPLAY) {
        const result = {}
        if (environment.DISPLAY) result.DISPLAY = environment.DISPLAY
        if (environment.WAYLAND_DISPLAY) result.WAYLAND_DISPLAY = environment.WAYLAND_DISPLAY
        if (environment.XDG_RUNTIME_DIR) result.XDG_RUNTIME_DIR = environment.XDG_RUNTIME_DIR
        if (environment.WAYLAND_DISPLAY && !result.XDG_RUNTIME_DIR && Number.isSafeInteger(uid)) {
            const fallback = `/run/user/${uid}`
            if (fs.existsSync(fallback)) result.XDG_RUNTIME_DIR = fallback
        }
        return result
    }
    if (!Number.isSafeInteger(uid) || uid < 0) return {}

    const directories = runtimeDirectories ?? [`/run/user/${uid}`]
    for (const runtimeDirectory of directories) {
        if (typeof runtimeDirectory !== 'string' || !runtimeDirectory) continue
        try {
            const socket = fs
                .readdirSync(runtimeDirectory, { withFileTypes: true })
                .find(entry => /^wayland-[\w.-]+$/.test(entry.name) && entry.isSocket())
            if (socket) return { XDG_RUNTIME_DIR: runtimeDirectory, WAYLAND_DISPLAY: socket.name }
        } catch {
            // A background service may not have access to the desktop session.
        }
    }
    return {}
}

function fail(message, code = 'BAD_REQUEST') {
    const error = new Error(message)
    error.code = code
    throw error
}

export class ManualSessionManager extends EventEmitter {
    constructor({
        projectRoot,
        stopTimeoutMs = 15000,
        startupTimeoutMs = 30000,
        onLog = () => {},
        onAccountChange = () => {}
    }) {
        super()
        this.projectRoot = projectRoot
        this.stopTimeoutMs = stopTimeoutMs
        this.startupTimeoutMs = startupTimeoutMs
        this.onLog = onLog
        this.onAccountChange = onAccountChange
        this.sessions = new Map()
    }

    open({ accountIndex, email, platform, preRewards = false }) {
        const index = Number(accountIndex)
        const normalizedPlatform = String(platform ?? '').toLowerCase()
        if (!Number.isSafeInteger(index) || index < 1) fail('accountIndex must be a positive integer.')
        if (typeof email !== 'string' || !email.trim()) fail('A configured account email is required.')
        if (!PLATFORMS.has(normalizedPlatform)) fail('platform must be desktop or mobile.')

        // Each click represents a new visible window, including when another
        // window for this account/platform is already starting or open.
        const key = randomUUID()

        const manager = new ProcessManager({
            command: process.execPath,
            args: [
                path.join(this.projectRoot, 'scripts', 'main', 'browserSession.js'),
                '--email',
                email,
                '--platform',
                normalizedPlatform
            ],
            cwd: this.projectRoot,
            stopTimeoutMs: this.stopTimeoutMs,
            name: `manual-${index}-${normalizedPlatform}`
        })
        const record = {
            key,
            accountIndex: index,
            email,
            platform: normalizedPlatform,
            manager,
            ready: false,
            startedAt: new Date().toISOString()
        }
        this.sessions.set(key, record)
        this.onAccountChange(index, true)
        const manualSession = { accountIndex: index, platform: normalizedPlatform }
        let ready = false
        let settled = false
        let failureDetail = null
        let startupTimer = null
        let resolveStartup
        let rejectStartup
        const startup = new Promise((resolve, reject) => {
            resolveStartup = resolve
            rejectStartup = reject
        })
        const clearStartup = () => {
            if (startupTimer) {
                clearTimeout(startupTimer)
                startupTimer = null
            }
        }
        const startupError = (message, code = 'START_FAILED') => {
            const error = new Error(message)
            error.code = code
            return error
        }

        manager.on('log', entry => {
            const enriched = { ...entry, manualSession }
            this.onLog(enriched)
            if (entry.level === 'error' || entry.source === 'stderr') {
                failureDetail = String(entry.message ?? entry.raw ?? '').trim() || null
            }
            if (!ready && READY_LOG_RE.test(String(entry.raw ?? entry.message ?? ''))) {
                ready = true
                record.ready = true
                clearStartup()
                resolveStartup(this._public(record))
            }
        })
        manager.once('exit', exit => {
            clearStartup()
            this.sessions.delete(key)
            this.onAccountChange(index, this.hasAccount(index))
            this.emit('change', { type: 'exit', session: this._public(record), exit })
            if (!ready && !settled) {
                settled = true
                rejectStartup(
                    startupError(
                        `The ${normalizedPlatform} browser session exited before it was ready (code ${exit.code ?? 'n/a'}${exit.signal ? `, signal ${exit.signal}` : ''})${failureDetail ? `: ${failureDetail}` : ''}.`
                    )
                )
            }
        })

        try {
            manager.start({ env: { ...resolveManualBrowserEnvironment(), MRS_PRE_REWARDS_GUARD: preRewards ? '1' : '0' } })
        } catch (error) {
            clearStartup()
            this.sessions.delete(key)
            this.onAccountChange(index, this.hasAccount(index))
            throw error
        }

        startupTimer = setTimeout(() => {
            if (ready || settled) return
            settled = true
            rejectStartup(
                startupError(
                    `Timed out waiting for the ${normalizedPlatform} browser session to open.`,
                    'START_TIMEOUT'
                )
            )
            void manager.stop({ force: true }).catch(() => {})
        }, this.startupTimeoutMs)
        startupTimer.unref?.()

        return startup.then(opened => {
            if (!settled) {
                settled = true
                this.emit('change', { type: 'open', session: opened })
            }
            return opened
        })
    }

    hasAccount(accountIndex) {
        const index = Number(accountIndex)
        return [...this.sessions.values()].some(session => session.accountIndex === index)
    }

    async closeForAccount({ accountIndex, platform }) {
        const index = Number(accountIndex)
        const normalizedPlatform = String(platform ?? '').toLowerCase()
        if (!Number.isSafeInteger(index) || index < 1) fail('accountIndex must be a positive integer.')
        if (!PLATFORMS.has(normalizedPlatform)) fail('platform must be desktop or mobile.')

        const records = [...this.sessions.values()].filter(
            session => session.accountIndex === index && session.platform === normalizedPlatform
        )
        if (!records.length) return 0

        const failures = []
        for (const record of records) {
            try {
                await requestSaveAndClose(record.manager, Math.max(this.stopTimeoutMs, 30000))
            } catch (error) {
                failures.push(error)
            }
        }
        if (failures.length) {
            throw new Error(
                `Could not save and close ${failures.length} ${normalizedPlatform} manual browser session(s): ${failures[0].message}`
            )
        }
        return records.length
    }

    list() {
        return [...this.sessions.values()].filter(record => record.ready).map(record => this._public(record))
    }

    async stopAll({ force = false } = {}) {
        await Promise.allSettled(
            [...this.sessions.values()].map(record =>
                record.manager.stop({ force, signalTree: force }).catch(() => null)
            )
        )
    }

    _public(record) {
        const status = record.manager.getStatus()
        return {
            accountIndex: record.accountIndex,
            email: record.email,
            platform: record.platform,
            pid: status.pid,
            state: status.state,
            startedAt: record.startedAt
        }
    }
}
