// Installed outside the release. A separate systemd unit / Windows supervisor
// owns this helper, so stopping the Worker cannot kill rollback.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import release from '../../common/workerRelease.cjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export async function executeUpdate(config, id, { command = run, health, prepare } = {}) {
    const file = path.join(config.data, 'updater', 'state.json')
    let state = JSON.parse(fs.readFileSync(file))
    if (state.id !== id || !['installing', 'verifying', 'rolling_back'].includes(state.phase))
        throw Error('UPDATE_CONFLICT')
    const write = patch => {
        state = { ...state, ...patch, updatedAt: new Date().toISOString() }
        release.atomicJson(file, state)
    }
    const env = {
        ...process.env,
        ...readEnvironment(config),
        PATH: path.dirname(config.node) + path.delimiter + process.env.PATH
    }
    const inspect =
        health ||
        (async () => {
            const r = await fetch(`http://127.0.0.1:${env.API_PORT || 3010}/internal/hybrid/status`, {
                headers: { Authorization: 'Bearer ' + env.API_TOKEN },
                signal: AbortSignal.timeout(3000)
            })
            if (!r.ok) throw Error('HEALTH_CHECK_FAILED')
            return r.json()
        })
    const waitHealth = async expected => {
        for (let i = 0; i < 45; i++) {
            try {
                const s = await inspect()
                if (s.nodeId !== state.nodeId) throw Error('WORKER_IDENTITY_CHANGED')
                if (
                    expected &&
                    (s.release?.sha256 !== state.sha256 ||
                        s.release?.releaseId !== state.releaseId ||
                        s.release?.version !== state.version)
                )
                    throw Error('RUNNING_RELEASE_MISMATCH')
                return s
            } catch {
                await sleep(config.testDelay ?? 1000)
            }
        }
        throw Error('UPDATE_HEALTH_CHECK_FAILED')
    }
    const service = async action => {
        if (config.platform === 'win32') {
            // Supervisor keeps transport running and services this durable control.
            const commandId = crypto.randomUUID()
            release.atomicJson(path.join(config.root, 'updater', 'worker-control.json'), { id, action, commandId })
            for (let i = 0; i < 60; i++) {
                try {
                    const a = JSON.parse(fs.readFileSync(path.join(config.root, 'updater', 'worker-control-ack.json')))
                    if (a.id === id && a.action === action && a.commandId === commandId) return
                } catch {}
                await sleep(config.testDelay ?? 500)
            }
            throw Error('SUPERVISOR_TIMEOUT')
        }
        await command(
            config.kind === 'local' ? 'systemctl' : 'sudo',
            config.kind === 'local'
                ? ['--user', action, 'msrw-worker.service']
                : ['-n', 'systemctl', action, 'msrw-worker.service'],
            { env }
        )
    }
    const switchTo = target => {
        if (config.platform === 'win32')
            release.atomicJson(path.join(config.root, 'current-release.json'), { directory: target })
        else {
            const temporary = path.join(config.root, 'current.update-' + id)
            fs.rmSync(temporary, { force: true })
            fs.symlinkSync(target, temporary)
            fs.renameSync(temporary, path.join(config.root, 'current'))
        }
    }
    let previous = state.previousDirectory
    try {
        if (!previous) {
            const s = await inspect()
            if (
                s.nodeId !== state.nodeId ||
                s.smart?.running?.length ||
                s.manualSessions?.length ||
                s.holds?.length ||
                s.syncPending ||
                !s.updater?.maintenance
            )
                throw Error('WORKER_NOT_DRAINED')
            previous =
                config.platform === 'win32'
                    ? currentWindows(config.root)
                    : fs.realpathSync(path.join(config.root, 'current'))
            write({ previousDirectory: previous })
        }
        if (state.phase === 'rolling_back') throw Error(state.error || 'UPDATE_INTERRUPTED')
        const target = path.join(config.root, 'releases', state.version + '-' + state.releaseId.slice(0, 12))
        if (state.phase === 'installing') {
            const temporary = target + '.staging-' + id
            fs.rmSync(temporary, { recursive: true, force: true })
            const manifest = release.extractArchive(
                path.join(config.data, 'updater', id + '.tgz'),
                temporary,
                state.sha256
            )
            if (manifest.releaseId !== state.releaseId || manifest.version !== state.version)
                throw Error('RELEASE_TARGET_MISMATCH')
            if (
                manifest.node &&
                Number(process.versions.node.split('.')[0]) < Number(manifest.node.match(/\d+/)?.[0] || 24)
            )
                throw Error('NODE_UPGRADE_REQUIRED')
            if (prepare) await prepare(temporary, env)
            else {
                await command(
                    config.platform === 'win32' ? 'npm.cmd' : 'npm',
                    ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
                    { cwd: temporary, env }
                )
                const browsers = JSON.parse(
                    fs.readFileSync(path.join(temporary, 'node_modules', 'patchright-core', 'browsers.json'))
                ).browsers
                for (const browser of manifest.browser || [])
                    if (!browsers.some(b => b.name === browser.name && b.revision === browser.revision))
                        throw Error('BROWSER_REVISION_MISMATCH')
                const cli = path.join(temporary, 'node_modules', 'patchright', 'cli.js')
                await command(
                    config.node,
                    [cli, 'install', ...(config.kind === 'local' ? [] : ['--only-shell']), 'chromium'],
                    { cwd: temporary, env }
                )
                await command(
                    config.node,
                    [
                        '-e',
                        "const {chromium}=require('patchright');require('impit');(async()=>{const b=await chromium.launch({headless:true});const p=await b.newPage();await p.setContent('<title>worker-ready</title>');if(await p.title()!=='worker-ready')throw Error();await b.close()})().catch(()=>process.exit(1))"
                    ],
                    { cwd: temporary, env }
                )
                if (config.kind === 'local')
                    await command(
                        config.node,
                        [
                            '-e',
                            "const fs=require('fs'),{chromium}=require('patchright');if(!fs.existsSync(chromium.executablePath()))process.exit(1)"
                        ],
                        { cwd: temporary, env }
                    )
            }
            release.verifyDirectory(temporary, manifest)
            if (fs.existsSync(target)) {
                release.verifyDirectory(target, manifest)
                fs.rmSync(temporary, { recursive: true, force: true })
            } else fs.renameSync(temporary, target)
            await service('stop')
            switchTo(target)
            write({ phase: 'verifying', targetDirectory: target })
            await service('start')
        }
        await waitHealth(true)
        write({ phase: 'ready', error: null })
    } catch (error) {
        const safe = /^[A-Z_]+$/.test(error.message) ? error.message : 'UPDATE_INSTALL_FAILED'
        write({ phase: 'rolling_back', error: safe })
        try {
            if (previous) {
                await service('stop')
                switchTo(previous)
                await service('start')
                await waitHealth(false)
            }
            write({ phase: 'failed', rollback: previous ? 'applied' : 'not_needed' })
        } catch {
            write({ phase: 'rollback_failed', rollback: 'failed', error: 'ROLLBACK_FAILED' })
        }
    }
    return state
}
export function currentWindows(root) {
    try {
        const p = JSON.parse(fs.readFileSync(path.join(root, 'current-release.json'))).directory
        if (path.dirname(p) !== path.join(root, 'releases')) throw Error()
        return p
    } catch (error) {
        if (error.code !== 'ENOENT') throw error
        return path.join(root, 'worker')
    }
}
export function readEnvironment(config) {
    if (config.platform === 'win32') return JSON.parse(fs.readFileSync(path.join(config.root, 'worker.json')))
    const env = {}
    for (const line of fs.readFileSync(path.join(config.data, 'worker.env'), 'utf8').split(/\r?\n/)) {
        const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
        if (m) {
            try {
                env[m[1]] = JSON.parse(m[2])
            } catch {
                env[m[1]] = m[2]
            }
        }
    }
    return env
}
function run(binary, args, { cwd, env } = {}) {
    return new Promise((resolve, reject) => {
        // npm.cmd requires cmd.exe on Windows; all arguments here are fixed literals.
        const c = spawn(binary, args, {
            cwd,
            env,
            stdio: 'ignore',
            windowsHide: true,
            shell: process.platform === 'win32' && binary === 'npm.cmd'
        })
        const timer = setTimeout(() => {
            c.kill()
            reject(Error('UPDATE_COMMAND_TIMEOUT'))
        }, 600000)
        c.once('error', e => {
            clearTimeout(timer)
            reject(e)
        })
        c.once('exit', code => {
            clearTimeout(timer)
            if (code === 0) resolve()
            else reject(Error('UPDATE_COMMAND_FAILED'))
        })
    })
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const config = JSON.parse(fs.readFileSync(process.argv[2]))
    const lock = path.join(config.root, 'updater', 'runner.lock')
    let fd
    try {
        try {
            const p = JSON.parse(fs.readFileSync(lock))
            try {
                process.kill(p.pid, 0)
                throw Error('UPDATER_ALREADY_RUNNING')
            } catch (e) {
                if (e.code !== 'ESRCH') throw e
            }
            fs.unlinkSync(lock)
        } catch (e) {
            if (e.code !== 'ENOENT') throw e
        }
        fd = fs.openSync(lock, 'wx', 0o600)
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname() }))
        await executeUpdate(config, process.argv[3])
    } finally {
        if (fd !== undefined) {
            fs.closeSync(fd)
            fs.rmSync(lock, { force: true })
        }
    }
}
