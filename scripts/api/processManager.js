import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { parseLogLine, createRunState, applyLogToRunState, summarizeRunState, severityRank } from './logParser.js'

const IS_WIN = process.platform === 'win32'

const BLOCKED_ENV = new Set([
    'NODE_OPTIONS',
    'NODE_PATH',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'ELECTRON_RUN_AS_NODE'
])
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESERVED_ENV_KEYS = new Set(['__PROTO__', 'PROTOTYPE', 'CONSTRUCTOR'])
const INTERNAL_ENV_KEYS = new Set([
    'MRS_EXECUTION_PLAN',
    'MRS_NORMAL_QUERY_JOURNAL',
    'MRS_CHECKPOINT_CONTROL_FILE',
    'MRS_RUNTIME_EVENT_JOURNAL',
    'MRS_LEARNING_OUTBOX',
    'MRS_LEARNING_ATTEMPT',
    'MRS_LEARNING_LEDGER',
    'MRS_LEARNING_ACCOUNT',
    'MRS_LEARNING_CAPS',
    'MRS_LEARNING_TIMEZONE'
])

export class ProcessManager extends EventEmitter {
    constructor({
        command,
        args = [],
        cwd,
        stopTimeoutMs = 15000,
        logBufferSize = 2000,
        historySize = 20,
        checkpointIPC = false,
        name = 'microsoft-rewards-script',
        version = '0.0.0'
    }) {
        super()
        this.setMaxListeners(0)

        this.command = command
        this.defaultArgs = args
        this.cwd = cwd
        this.stopTimeoutMs = stopTimeoutMs
        this.logBufferSize = logBufferSize
        this.historySize = historySize
        this.checkpointIPC = checkpointIPC
        this.name = name
        this.version = version

        this.state = 'idle' // idle | starting | running | stopping
        this.child = null
        this.pid = null
        this.startedAt = null
        this.lastExit = null
        this.currentArgs = args

        this.runState = createRunState()
        this.logBuffer = []
        this.logSeq = 0
        this.history = []

        this._stdoutBuf = ''
        this._stderrBuf = ''
        this._killTimer = null
        this._finalized = false
    }

    start(overrides = {}) {
        if (this.state !== 'idle') {
            const err = new Error(`Cannot start: a run is already ${this.state}.`)
            err.code = 'ALREADY_RUNNING'
            throw err
        }

        const args = this._resolveArgs(overrides.args)
        const env = this._resolveEnv(overrides.env, Boolean(overrides.trustedEnv))

        this.state = 'starting'
        this.runState = createRunState()
        this.startedAt = new Date().toISOString()
        this.lastExit = null
        this.currentArgs = args
        this._stdoutBuf = ''
        this._stderrBuf = ''
        this._finalized = false

        this._controllerLog('info', `Starting run: ${this.command} ${args.join(' ')}`.trim())

        let child
        try {
            child = spawn(this.command, args, {
                cwd: this.cwd,
                env,
                stdio: ['ignore', 'pipe', 'pipe', ...(this.checkpointIPC ? ['ipc'] : [])],
                detached: !IS_WIN, // own process group on POSIX so we can signal the whole tree
                windowsHide: true
            })
        } catch (error) {
            this.state = 'idle'
            const msg = error instanceof Error ? error.message : String(error)
            this._controllerLog('error', `Failed to spawn: ${msg}`)
            this.lastExit = { code: null, signal: null, at: new Date().toISOString(), error: msg }
            this._emitStatus('spawn-error')
            throw error
        }

        this.child = child
        this.pid = child.pid ?? null
        this._controlFile = env.MRS_CHECKPOINT_CONTROL_FILE || null

        child.stdout?.on('data', d => this._ingest('stdout', d))
        child.stderr?.on('data', d => this._ingest('stderr', d))

        if (this.checkpointIPC)
            child.on('message', message => {
                if (message?.type === 'MSRW_EVENT') {
                    this.emit('event', message)
                    return
                }
                if (
                    !this._checkpoint ||
                    message?.type !== 'MSRW_CHECKPOINT_ACK' ||
                    message.requestId !== this._checkpoint.requestId
                )
                    return
                this._checkpoint.status = message.saved === true ? 'saved' : 'failed'
            })
        child.once('spawn', () => {
            this.state = 'running'
            this._controllerLog('info', `Run started (pid ${this.pid}).`)
            this._emitStatus('running')
        })

        child.once('error', error => {
            const msg = error instanceof Error ? error.message : String(error)
            this._controllerLog('error', `Process error: ${msg}`)
            this._finalize(null, null, msg)
        })

        child.once('exit', (code, signal) => this._finalize(code, signal))

        return { pid: this.pid, startedAt: this.startedAt, command: this.command, args }
    }

    stop({ force = false, signalTree = true, signal = 'SIGTERM', reason = null } = {}) {
        if (this.state === 'idle') {
            const err = new Error('Cannot stop: no run is in progress.')
            err.code = 'NOT_RUNNING'
            throw err
        }

        const wasStopping = this.state === 'stopping'
        this.state = 'stopping'
        if (!wasStopping) {
            this._stopReason = reason || (force ? 'forced' : 'user-stop')
            this._controllerLog('warn', force ? 'Force-stopping run (SIGKILL)…' : `Stopping run (${signal})…`)
            this._emitStatus('stopping')
            const canHandshake =
                !force &&
                !signalTree &&
                signal === 'SIGUSR1' &&
                ((this.checkpointIPC && this.child?.connected) || this._controlFile)
            if (canHandshake) {
                this._checkpoint = { requestId: crypto.randomUUID(), status: 'unknown', reason: this._stopReason }
                if (this._controlFile) {
                    try {
                        const tmp = `${this._controlFile}.tmp`
                        fs.writeFileSync(
                            tmp,
                            JSON.stringify({
                                type: 'MSRW_CHECKPOINT_STOP',
                                requestId: this._checkpoint.requestId,
                                reason: this._stopReason
                            }),
                            { mode: 0o600 }
                        )
                        fs.renameSync(tmp, this._controlFile)
                    } catch {}
                }
                if (this.checkpointIPC && this.child?.connected) {
                    try {
                        this.child.send(
                            {
                                type: 'MSRW_CHECKPOINT_STOP',
                                requestId: this._checkpoint.requestId,
                                reason: this._stopReason
                            },
                            () => {}
                        )
                    } catch {}
                }
                // Old POSIX children may not support IPC; their existing signal
                // handler remains a compatible fallback. Windows waits for ACK.
                if (!IS_WIN)
                    this._checkpointFallback = setTimeout(
                        () => {
                            if (this.state === 'stopping' && this._checkpoint?.status === 'unknown') {
                                try {
                                    this.child?.kill('SIGUSR1')
                                } catch {}
                            }
                        },
                        Math.min(1000, Math.max(25, Math.floor(this.stopTimeoutMs / 4)))
                    )
            } else if (force || signalTree || IS_WIN) {
                this._killTree(force ? 'SIGKILL' : signal)
            } else {
                try {
                    this.child?.kill(signal)
                } catch (error) {
                    this._controllerLog(
                        'warn',
                        `Stop signal failed (${error.code || error.name}); terminating process tree.`
                    )
                    this._killTree('SIGKILL')
                }
            }

            this._killTimer = setTimeout(() => {
                if (this.state !== 'idle') {
                    this._controllerLog('warn', `Did not exit within ${this.stopTimeoutMs}ms - sending SIGKILL.`)
                    if (this._checkpoint) this._checkpoint.status = 'forced'
                    this._killTree('SIGKILL')
                }
            }, this.stopTimeoutMs)
            if (typeof this._killTimer.unref === 'function') this._killTimer.unref()
        }

        return new Promise(resolve => {
            let settled = false
            const done = () => {
                if (settled) return
                settled = true
                resolve(this.lastExit)
            }
            this.once('exit', done)
            const safety = setTimeout(done, this.stopTimeoutMs + 5000)
            if (typeof safety.unref === 'function') safety.unref()
        })
    }

    async restart(overrides = {}) {
        if (this.state !== 'idle') {
            await this.stop({ force: Boolean(overrides.force) }).catch(() => {})
        }
        await new Promise(r => setTimeout(r, 300))
        return this.start(overrides)
    }

    isAlive() {
        if (!this.pid || !this.child || this.child.exitCode !== null || this.child.signalCode !== null) return false
        try {
            process.kill(this.pid, 0)
            return true
        } catch (error) {
            return error.code === 'EPERM'
        }
    }

    getStatus() {
        return {
            name: this.name,
            version: this.version,
            alive: this.isAlive(),
            state: this.state,
            pid: this.pid,
            startedAt: this.state === 'idle' ? null : this.startedAt,
            command: `${this.command} ${this.currentArgs.join(' ')}`.trim(),
            lastExit: this.lastExit,
            logCount: this.logBuffer.length,
            logBufferSize: this.logBufferSize,
            latestLogId: this.logSeq,
            run: summarizeRunState(this.runState)
        }
    }

    getPoints() {
        const run = summarizeRunState(this.runState)
        const accounts = run.accounts.map(a => ({
            email: a.email,
            collected: a.success != null ? a.collectedPoints : a.live.gained,
            balance: a.live.balance ?? a.finalPoints ?? null,
            reliability: a.reliability,
            initialPoints: a.initialPoints,
            bySource: a.live.bySource,
            earnable: a.earnable,
            streakProtection: a.streakProtection,
            rewardsStreak: a.rewardsStreak,
            edgeBrowsing: a.edgeBrowsing,
            done: a.success != null,
            success: a.success,
            error: a.error
        }))

        return {
            state: this.state,
            running: this.state !== 'idle',
            live: this.state === 'running' || this.state === 'starting',
            startedAt: this.state === 'idle' ? null : this.startedAt,
            currentAccount: run.live.currentAccount,
            balance: run.live.currentBalance,
            reliability: run.accounts.find(a => a.email === run.live.currentAccount)?.reliability ?? null,
            collected: run.collected,
            updatedAt: run.live.updatedAt,
            finished: run.finished,
            totals: run.totals,
            accountsTotal: run.accountsTotal,
            accountsSeen: run.accountsSeen,
            accounts,
            lastExit: this.lastExit
        }
    }

    getLogs({ limit = 200, afterId = null, minLevel = null } = {}) {
        let logs = this.logBuffer
        if (afterId != null) logs = logs.filter(e => e.id > afterId)
        if (minLevel) {
            const floor = severityRank(minLevel)
            logs = logs.filter(e => severityRank(e.level) >= floor)
        }
        if (afterId == null && limit != null && logs.length > limit) {
            logs = logs.slice(logs.length - limit)
        }
        return { logs, latestLogId: this.logSeq, count: logs.length }
    }

    getErrors({ limit = 100, includeWarnings = true } = {}) {
        const floor = severityRank(includeWarnings ? 'warn' : 'error')
        let errors = this.logBuffer.filter(e => severityRank(e.level) >= floor)
        if (limit != null && errors.length > limit) errors = errors.slice(errors.length - limit)
        const accountErrors = this.runState.order
            .map(email => this.runState.accounts[email])
            .filter(a => a.error)
            .map(a => ({ email: a.email, error: a.error }))
        return { errors, accountErrors, count: errors.length }
    }

    getHistory() {
        return this.history
    }

    note(level, message) {
        this._controllerLog(level, message)
    }

    ingestEntry(entry) {
        const copy = { ...entry }
        delete copy.id
        delete copy.receivedAt
        this._appendLog(copy)
        const milestone = applyLogToRunState(this.runState, copy)
        if (milestone) this._emitStatus(milestone)
    }

    _resolveArgs(argsOverride) {
        if (argsOverride == null) return this.defaultArgs
        if (!Array.isArray(argsOverride) || !argsOverride.every(a => typeof a === 'string')) {
            const err = new Error('`args` must be an array of strings.')
            err.code = 'BAD_REQUEST'
            throw err
        }
        return argsOverride
    }

    _resolveEnv(envOverride, trusted = false) {
        const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
        if (envOverride != null) {
            if (typeof envOverride !== 'object' || Array.isArray(envOverride)) {
                const err = new Error('`env` must be a JSON object.')
                err.code = 'BAD_REQUEST'
                throw err
            }

            for (const [key, value] of Object.entries(envOverride)) {
                if (INTERNAL_ENV_KEYS.has(key) && !trusted) continue
                if (!ENV_KEY_RE.test(key) || RESERVED_ENV_KEYS.has(key.toUpperCase())) {
                    const err = new Error(`Invalid environment variable name: ${JSON.stringify(key)}.`)
                    err.code = 'BAD_REQUEST'
                    throw err
                }
                if (BLOCKED_ENV.has(key.toUpperCase())) continue
                if (value == null) continue
                if (!['string', 'number', 'boolean'].includes(typeof value)) {
                    const err = new Error(`Environment override ${key} must be a string, number, boolean, or null.`)
                    err.code = 'BAD_REQUEST'
                    throw err
                }
                env[key] = String(value)
            }
        }
        return env
    }

    _ingest(source, chunk) {
        const bufKey = source === 'stderr' ? '_stderrBuf' : '_stdoutBuf'
        this[bufKey] += chunk.toString('utf8')

        let idx
        while ((idx = this[bufKey].indexOf('\n')) !== -1) {
            const line = this[bufKey].slice(0, idx).replace(/\r$/, '')
            this[bufKey] = this[bufKey].slice(idx + 1)
            this._handleLine(source, line)
        }
    }

    _flushPartial() {
        for (const key of ['_stdoutBuf', '_stderrBuf']) {
            const rest = this[key]
            if (rest && rest.trim()) {
                const source = key === '_stderrBuf' ? 'stderr' : 'stdout'
                this._handleLine(source, rest.replace(/\r$/, ''))
            }
            this[key] = ''
        }
    }

    _handleLine(source, rawLine) {
        if (rawLine === '') return
        const entry = parseLogLine(rawLine, source)
        this._appendLog(entry)
        const milestone = applyLogToRunState(this.runState, entry)
        if (milestone) this._emitStatus(milestone)
    }

    _appendLog(entry) {
        entry.id = ++this.logSeq
        entry.receivedAt = new Date().toISOString()
        this.logBuffer.push(entry)
        if (this.logBuffer.length > this.logBufferSize) this.logBuffer.shift()
        this.emit('log', entry)
    }

    _controllerLog(level, message) {
        this._appendLog({
            ts: null,
            level,
            user: 'API',
            platform: null,
            title: 'CONTROLLER',
            message,
            source: 'controller',
            parsed: false,
            raw: message
        })
    }

    _emitStatus(reason) {
        this.emit('status', { reason, ...this.getStatus() })
    }

    _killTree(signal) {
        if (!this.child || this.pid == null) return
        try {
            if (IS_WIN) {
                const taskkill = path.join(
                    process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
                    'System32',
                    'taskkill.exe'
                )
                const killer = spawn(taskkill, ['/pid', String(this.pid), '/T', '/F'], { windowsHide: true })
                killer.once('error', error => {
                    this._controllerLog('warn', `Windows process-tree stop failed (${error.code || error.name}).`)
                    try {
                        this.child?.kill('SIGKILL')
                    } catch {}
                })
            } else {
                try {
                    process.kill(-this.pid, signal)
                } catch {
                    this.child.kill(signal)
                }
            }
        } catch {}
    }

    _finalize(code, signal, errorMessage = null) {
        if (this._finalized) return
        this._finalized = true

        if (this._killTimer) {
            clearTimeout(this._killTimer)
            this._killTimer = null
        }

        if (this._checkpointFallback) {
            clearTimeout(this._checkpointFallback)
            this._checkpointFallback = null
        }
        this._flushPartial()

        if (this._checkpoint && this._checkpoint.status === 'unknown' && this._controlFile) {
            try {
                const ackFile = `${this._controlFile}.ack`
                if (fs.existsSync(ackFile)) {
                    const ack = JSON.parse(fs.readFileSync(ackFile, 'utf8'))
                    if (ack?.type === 'MSRW_CHECKPOINT_ACK' && ack.requestId === this._checkpoint.requestId) {
                        this._checkpoint.status = ack.saved === true ? 'saved' : 'failed'
                    }
                }
            } catch {}
        }
        if (this._controlFile) {
            try {
                fs.rmSync(this._controlFile, { force: true })
                fs.rmSync(`${this._controlFile}.ack`, { force: true })
            } catch {}
            this._controlFile = null
        }

        const endedAt = new Date().toISOString()
        this.lastExit = { code: code ?? null, signal: signal ?? null, at: endedAt }
        if (errorMessage) this.lastExit.error = errorMessage
        if (this._stopReason) this.lastExit.stopReason = this._stopReason
        if (this._checkpoint) {
            this.lastExit.checkpoint = this._checkpoint.status
            this.lastExit.stopOutcome =
                this._checkpoint.status === 'saved'
                    ? 'saved'
                    : this._checkpoint.status === 'forced'
                      ? 'forced'
                      : 'unknown'
        }
        this._stopReason = null

        const label =
            errorMessage != null
                ? `error: ${errorMessage}`
                : `code ${code ?? 'n/a'}${signal ? ` / signal ${signal}` : ''}`
        this._controllerLog(code === 0 && errorMessage == null ? 'info' : 'error', `Run finished (${label}).`)

        this.history.unshift({
            startedAt: this.startedAt,
            endedAt,
            exit: this.lastExit,
            run: summarizeRunState(this.runState)
        })
        if (this.history.length > this.historySize) this.history.pop()

        this.child = null
        this.pid = null
        this.state = 'idle'

        this._emitStatus('exit')
        this.emit('exit', { ...this.lastExit })
    }
}

export default ProcessManager
