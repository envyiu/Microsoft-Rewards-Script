import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import release from '../../common/workerRelease.cjs'
import { setupUpdater } from './setupUpdater.js'

const terminal = new Set(['done', 'failed', 'rollback_failed'])
export function updateFailure(code, status = 409) {
    return Object.assign(new Error(code), { code, status })
}
export class WorkerUpdater {
    constructor({ data, code, environment = process.env, launch, installHelper = setupUpdater } = {}) {
        this.data = data
        this.code = code
        this.environment = environment
        this.launch = launch
        this.installHelper = installHelper
        this.directory = path.join(data, 'updater')
        this.stateFile = path.join(this.directory, 'state.json')
        this.release = release.readRunningRelease(code) // Immutable process-start observation.
        try {
            this.config = JSON.parse(
                fs.readFileSync(
                    path.join(
                        environment.MRS_WORKER_ROOT || environment.MSRW_WORKER_HOME || code,
                        'updater',
                        'config.json'
                    )
                )
            )
        } catch {
            this.config = null
        }
    }
    read() {
        try {
            return JSON.parse(fs.readFileSync(this.stateFile))
        } catch (error) {
            if (error.code === 'ENOENT') return null
            throw updateFailure('UPDATE_STATE_INVALID')
        }
    }
    write(state) {
        release.atomicJson(this.stateFile, { ...state, updatedAt: new Date().toISOString() })
    }
    get maintenance() {
        const s = this.read()
        return Boolean(s && !['done'].includes(s.phase))
    }
    get supported() {
        return Boolean(
            this.config?.schema === 1 &&
            path.resolve(this.config.data) === path.resolve(this.data) &&
            fs.existsSync(path.join(this.config.root, 'updater', 'runner.js'))
        )
    }
    status() {
        const s = this.read()
        return {
            supported: this.supported,
            maintenance: this.maintenance,
            operation: s
                ? {
                      id: s.id,
                      phase: s.phase,
                      error: s.error || null,
                      version: s.version,
                      sha256: s.sha256,
                      received: s.received || 0,
                      rollback: s.rollback || null
                  }
                : null
        }
    }
    begin(body) {
        if (!this.supported) throw updateFailure('UPDATER_SETUP_REQUIRED')
        if (
            !/^[a-f0-9-]{36}$/.test(body.id) ||
            !release.versionPattern.test(body.version) ||
            !/^[a-f0-9]{64}$/.test(body.sha256) ||
            !/^[a-f0-9]{64}$/.test(body.releaseId) ||
            !Number.isSafeInteger(body.size) ||
            body.size < 1 ||
            body.size > 256 * 1024 * 1024
        )
            throw updateFailure('INVALID_UPDATE', 400)
        const previous = this.read()
        if (previous?.id === body.id) {
            if (previous.sha256 !== body.sha256 || previous.releaseId !== body.releaseId)
                throw updateFailure('UPDATE_CONFLICT')
            return previous
        }
        if (previous && !terminal.has(previous.phase)) throw updateFailure('UPDATE_IN_PROGRESS')
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
        const state = {
            id: body.id,
            version: body.version,
            sha256: body.sha256,
            releaseId: body.releaseId,
            size: body.size,
            nodeId: body.nodeId,
            received: 0,
            phase: 'draining',
            previousRelease: this.release
        }
        fs.writeFileSync(path.join(this.directory, body.id + '.tgz'), '', { mode: 0o600 })
        this.write(state)
        return state
    }
    chunk(body) {
        const state = this.read()
        if (state?.id !== body.id || !['draining', 'staging'].includes(state.phase))
            throw updateFailure('UPDATE_CONFLICT')
        if (
            !Number.isSafeInteger(body.offset) ||
            body.offset < 0 ||
            typeof body.data !== 'string' ||
            body.data.length > 720000 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)
        )
            throw updateFailure('INVALID_UPDATE_CHUNK', 400)
        const bytes = Buffer.from(body.data, 'base64'),
            file = path.join(this.directory, state.id + '.tgz')
        const actual = fs.statSync(file).size
        // Recover an acknowledged-by-disk chunk after a crash before state save.
        state.received = actual
        if (body.offset < actual) {
            const fd = fs.openSync(file, 'r')
            const old = Buffer.alloc(bytes.length)
            try {
                fs.readSync(fd, old, 0, old.length, body.offset)
            } finally {
                fs.closeSync(fd)
            }
            if (body.offset + bytes.length > actual || !old.equals(bytes)) throw updateFailure('UPDATE_CHUNK_CONFLICT')
            return { received: actual }
        }
        if (body.offset !== actual || actual + bytes.length > state.size) throw updateFailure('UPDATE_CHUNK_OFFSET')
        const fd = fs.openSync(file, 'a')
        try {
            fs.writeSync(fd, bytes)
            fs.fsyncSync(fd)
        } finally {
            fs.closeSync(fd)
        }
        state.received += bytes.length
        state.phase = 'staging'
        this.write(state)
        return { received: state.received }
    }
    async commit(id) {
        const state = this.read()
        if (state?.id !== id) throw updateFailure('UPDATE_CONFLICT')
        if (['ready', 'done'].includes(state.phase)) return state
        const restarting = ['installing', 'verifying'].includes(state.phase)
        if (!restarting && !['draining', 'staging'].includes(state.phase)) throw updateFailure('UPDATE_CONFLICT')
        const file = path.join(this.directory, id + '.tgz')
        if (fs.statSync(file).size !== state.size || release.hash(fs.readFileSync(file)) !== state.sha256)
            throw updateFailure('ARCHIVE_CHECKSUM_MISMATCH')
        if (!restarting) {
            state.phase = 'installing'
            this.write(state)
        }
        try {
            if (this.launch) await this.launch(state)
            else if (this.config.platform === 'win32')
                release.atomicJson(path.join(this.config.root, 'updater', 'request.json'), { id })
            else
                await new Promise((resolve, reject) => {
                    const check = spawn(
                        this.config.kind === 'local' ? 'systemctl' : 'sudo',
                        this.config.kind === 'local'
                            ? ['--user', 'is-active', '--quiet', 'msrw-update-' + id + '.service']
                            : ['-n', 'systemctl', 'is-active', '--quiet', 'msrw-update-' + id + '.service'],
                        { stdio: 'ignore' }
                    )
                    check.once('error', reject)
                    check.once('exit', code => {
                        if (code === 0) {
                            resolve()
                            return
                        }
                        const args = [
                            '--collect',
                            '--unit=msrw-update-' + id,
                            process.execPath,
                            path.join(this.config.root, 'updater', 'runner.js'),
                            path.join(this.config.root, 'updater', 'config.json'),
                            id
                        ]
                        const command = this.config.kind === 'local' ? 'systemd-run' : 'sudo'
                        const c = spawn(
                            command,
                            this.config.kind === 'local'
                                ? ['--user', ...args]
                                : ['-n', 'systemd-run', '--uid=' + this.config.user, ...args],
                            { stdio: 'ignore' }
                        )
                        c.once('error', reject)
                        c.once('exit', code =>
                            code === 0 ? resolve() : reject(updateFailure('UPDATER_LAUNCH_FAILED'))
                        )
                    })
                })
        } catch {
            state.phase = 'failed'
            state.error = 'UPDATER_LAUNCH_FAILED'
            this.write(state)
            throw updateFailure(state.error)
        }
        return state
    }
    finish(id) {
        const state = this.read()
        if (state?.id !== id) throw updateFailure('UPDATE_CONFLICT')
        if (
            !['ready', 'done'].includes(state.phase) ||
            this.release.sha256 !== state.sha256 ||
            this.release.releaseId !== state.releaseId
        )
            throw updateFailure('UPDATE_NOT_VERIFIED')
        this.installHelper({ root: this.config.root, data: this.data, kind: this.config.kind, source: this.code })
        state.phase = 'done'
        this.write(state)
    }
}
