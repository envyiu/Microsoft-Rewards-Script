// Native Windows user deployment: restart the independent worker and its SSH
// transport separately. run.ps1 holds the installation's global singleton mutex.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { verifyWindowsBrowserBundle } from './verifyBrowserBundle.mjs'

const base = process.env.MSRW_WORKER_HOME || path.join(process.env.LOCALAPPDATA, 'MSRWWorker')
const settings = JSON.parse(fs.readFileSync(path.join(base, 'worker.json'), 'utf8'))
const logs = path.join(base, 'logs')
fs.mkdirSync(logs, { recursive: true })
let stopping = false
let workerPaused = false
let workerChild = null
let updateChild = null
const children = new Set()
const timers = new Set()

function log(name, chunk) {
    const file = path.join(logs, `${name}.log`)
    if (fs.existsSync(file) && fs.statSync(file).size > 10 * 1024 * 1024) {
        fs.rmSync(file + '.3', { force: true })
        for (let n = 2; n >= 1; n--)
            if (fs.existsSync(file + '.' + n)) fs.renameSync(file + '.' + n, file + '.' + (n + 1))
        fs.renameSync(file, file + '.1')
    }
    fs.appendFileSync(file, chunk)
}

function supervise(name, command, args, options) {
    if (stopping || (name === 'worker' && (workerPaused || workerChild))) return
    if (name === 'worker') {
        let directory = path.join(base, 'worker')
        const pointer = path.join(base, 'current-release.json')
        if (fs.existsSync(pointer)) {
            directory = JSON.parse(fs.readFileSync(pointer)).directory
            if (path.dirname(directory) !== path.join(base, 'releases')) throw Error('Invalid worker release pointer')
        }
        options = { ...options, cwd: directory, env: { ...options.env, MSRW_RELEASE_DIR: directory } }
    }
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options })
    children.add(child)
    if (name === 'worker') workerChild = child
    log(name, `${new Date().toISOString()} starting ${name}\n`)
    child.stdout.on('data', chunk => log(name, chunk))
    child.stderr.on('data', chunk => log(name, chunk))
    child.on('error', error => log(name, `${new Date().toISOString()} spawn error: ${error.code}\n`))
    child.once('close', (code, signal) => {
        children.delete(child)
        if (workerChild === child) workerChild = null
        log(name, `${new Date().toISOString()} exited code=${code} signal=${signal}; retry in 5s\n`)
        if (!stopping && !(name === 'worker' && workerPaused)) {
            const timer = setTimeout(() => {
                timers.delete(timer)
                supervise(name, command, args, options)
            }, 5000)
            timers.add(timer)
        }
    })
}

const nodeDir = path.dirname(process.execPath)
const environment = {
    ...process.env,
    ...settings,
    MRS_WORKER_ROOT: base,
    MRS_WORKER_DATA: settings.MRS_WORKER_DATA || path.join(base, 'data'),
    PATH: nodeDir + path.delimiter + process.env.PATH
}
if (environment.PLAYWRIGHT_BROWSERS_PATH) {
    verifyWindowsBrowserBundle(environment.PLAYWRIGHT_BROWSERS_PATH)
}
// Windows workers require explicit transport.json configuration before spawning any child process.
// Machines already reachable through inbound SSH can set {"enabled":false}.
const transportFile = path.join(base, 'transport.json')
if (!fs.existsSync(transportFile)) {
    const message = `${new Date().toISOString()} FATAL: Missing ${transportFile}. Create transport.json with {"enabled":false} or explicit SSH reverse-tunnel {"enabled":true,"args":[...]}.\n`
    log('supervisor', message)
    throw new Error(`Missing required Windows worker transport configuration: ${transportFile}`)
}
const transport = JSON.parse(fs.readFileSync(transportFile, 'utf8'))
if (transport.enabled !== false && (!Array.isArray(transport.args) || !transport.args.length)) {
    const message = `${new Date().toISOString()} FATAL: ${transportFile} must specify non-empty "args" when transport.enabled is not false.\n`
    log('supervisor', message)
    throw new Error(`Invalid Windows worker transport configuration in ${transportFile}: missing args`)
}
const startWorker = () =>
    supervise(
        'worker',
        path.join(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            path.join(base, 'job-process.ps1'),
            '-Worker'
        ],
        {
            cwd: path.join(base, 'worker'),
            env: environment
        }
    )
startWorker()
if (transport.enabled !== false) {
    supervise(
        'tunnel',
        transport.command || path.join(process.env.WINDIR, 'System32', 'OpenSSH', 'ssh.exe'),
        transport.args,
        { cwd: base }
    )
}

let polling = false
const updateTimer = setInterval(async () => {
    if (polling || stopping) return
    polling = true
    try {
        const directory = path.join(base, 'updater')
        const control = path.join(directory, 'worker-control.json')
        if (fs.existsSync(control)) {
            const request = JSON.parse(fs.readFileSync(control))
            if (!/^[a-f0-9-]{36}$/.test(request.id) || !['start', 'stop'].includes(request.action))
                throw Error('Invalid worker control')
            if (request.action === 'stop') {
                workerPaused = true
                if (workerChild) {
                    const child = workerChild
                    await new Promise((resolve, reject) => {
                        const timer = setTimeout(() => reject(Error('Worker stop timeout')), 30000)
                        child.once('close', () => {
                            clearTimeout(timer)
                            resolve()
                        })
                        child.kill()
                    })
                }
            } else {
                workerPaused = false
                if (!workerChild) startWorker()
            }
            fs.renameSync(control, path.join(directory, 'worker-control-ack.json'))
        }
        // Durable state also recovers updates interrupted by a supervisor reboot.
        if (!updateChild && fs.existsSync(path.join(directory, 'config.json'))) {
            const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json')))
            let state
            try {
                state = JSON.parse(fs.readFileSync(path.join(config.data, 'updater', 'state.json')))
            } catch {}
            if (state && ['installing', 'verifying', 'rolling_back'].includes(state.phase)) {
                updateChild = spawn(
                    process.execPath,
                    [path.join(directory, 'runner.js'), path.join(directory, 'config.json'), state.id],
                    { cwd: base, env: environment, windowsHide: true, stdio: 'ignore' }
                )
                updateChild.once('error', () => {
                    updateChild = null
                })
                updateChild.once('exit', () => {
                    updateChild = null
                })
            }
        }
    } catch (error) {
        log('supervisor', `Updater control failed: ${error.code || 'CONTROL_FAILED'}\n`)
    } finally {
        polling = false
    }
}, 1000)

function shutdown() {
    clearInterval(updateTimer)
    stopping = true
    for (const timer of timers) clearTimeout(timer)
    for (const child of children) child.kill()
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
