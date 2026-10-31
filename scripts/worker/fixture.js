import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export async function workerFixture(t, { kind = 'remote', android = false } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'msrw-worker-test-'))
    const data = path.join(directory, 'state')
    for (const file of ['scripts/api', 'scripts/worker', 'scripts/main/browserSessionCheckpoint.js', 'scripts/package.json', 'scripts/env.js', 'scripts/utils.js', 'packages/contracts', 'common', 'config.example.json']) {
        fs.cpSync(path.join(root, file), path.join(directory, file), { recursive: true, filter: source => !['fleet.js', 'nodeProvisioner.js'].includes(path.basename(source)) })
    }
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'))
    fs.writeFileSync(path.join(directory, 'package.json'), '{"name":"worker-fixture","version":"1.0.0"}')
    fs.writeFileSync(path.join(directory, 'fake.cjs'), `console.log('['+new Date().toISOString()+'] [main] [INFO] MAIN [RUN-START] Starting');setInterval(()=>{},1000);process.on('SIGUSR1',()=>{console.log('['+new Date().toISOString()+'] [main] [INFO] MAIN [SESSION-CHECKPOINT] All active browser sessions saved');setTimeout(()=>process.exit(0),20)})`)
    fs.writeFileSync(path.join(directory, 'scripts/main/browserSession.js'), `console.log('manual browser ready');setInterval(()=>{},1000);process.on('SIGUSR2',()=>{console.log('Manual browser checkpoint complete');setTimeout(()=>process.exit(0),20)})`)
    const socket = net.createServer()
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
    const port = socket.address().port
    await new Promise(resolve => socket.close(resolve))
    const token = 'synthetic-worker-token-only'
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ACCOUNT_|API_|MRS_|SMART_|SCHEDULE_)/.test(key)))
    let child
    const start = async () => {
        child = spawn(process.execPath, ['scripts/worker/server.js'], { cwd: directory, env: { ...clean,
            API_HOST: '127.0.0.1', API_PORT: String(port), API_TOKEN: token, MRS_WORKER_KIND: kind, MRS_WORKER_DATA: data,
            MRS_ANDROID_ENABLED: String(android),
            API_RUN_COMMAND: process.execPath, API_RUN_ARGS: JSON.stringify([path.join(directory, 'fake.cjs')]), API_STOP_TIMEOUT_MS: '1500'
        }, stdio: ['ignore', 'pipe', 'pipe'] })
        await new Promise((resolve, reject) => {
            let errors = ''
            const timeout = setTimeout(() => reject(new Error('Worker did not become ready: ' + errors)), 10000)
            child.stderr.on('data', chunk => { errors += String(chunk).slice(0, 2000) })
            child.stdout.on('data', chunk => { if (String(chunk).includes('__API_READY__')) { clearTimeout(timeout); resolve() } })
            child.once('exit', () => { clearTimeout(timeout); reject(new Error('Worker exited: ' + errors)) })
        })
    }
    const stop = async () => {
        if (child?.exitCode === null) {
            const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await done
        }
    }
    t.after(async () => { await stop(); fs.rmSync(directory, { recursive: true, force: true }) })
    await start()
    const url = `http://127.0.0.1:${port}`
    const request = async (route, method = 'GET', body, authenticated = true) => {
        const response = await fetch(url + route, { method, headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
        return { status: response.status, data: await response.json() }
    }
    return { directory, data, token, url, request, stop, restart: async () => { await stop(); await start() } }
}
