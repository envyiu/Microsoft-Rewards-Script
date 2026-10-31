import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
export async function fixture(t, extra = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-hybrid-api-'))
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    fs.cpSync(path.join(root, 'packages'), path.join(dir, 'packages'), { recursive: true })
    fs.cpSync(path.join(root, 'scripts', 'api'), path.join(dir, 'scripts', 'api'), { recursive: true })
    fs.cpSync(path.join(root, 'scripts', 'main'), path.join(dir, 'scripts', 'main'), { recursive: true })
    for (const file of ['package.json', 'utils.js', 'env.js'])
        fs.copyFileSync(path.join(root, 'scripts', file), path.join(dir, 'scripts', file))
    fs.cpSync(path.join(root, 'common'), path.join(dir, 'common'), { recursive: true })
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'))
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"hybrid-api-fixture"}')
    const config = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'))
    for (const key of Object.keys(config.workers)) config.workers[key] = false
    config.workers.doDesktopSearch = true
    config.ensureStreakProtection = false
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config))
    fs.writeFileSync(
        path.join(dir, 'fake.cjs'),
        `setInterval(()=>{},1000); process.on('SIGUSR1',()=>{console.log('['+new Date().toISOString()+'] [main] [INFO] MAIN [SESSION-CHECKPOINT] All active browser sessions saved');setTimeout(()=>process.exit(0),20)})`
    )
    const socket = net.createServer()
    await new Promise(r => socket.listen(0, '127.0.0.1', r))
    const port = socket.address().port
    await new Promise(r => socket.close(r))
    const clean = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^(ACCOUNT_|API_|MRS_|SMART_|SCHEDULE_)/.test(key))
    )
    const env = {
        ...clean,
        API_HOST: '127.0.0.1',
        API_PORT: String(port),
        API_TOKEN: 'test-only',
        API_ALLOW_SCHEDULE_WRITE: 'true',
        API_ALLOW_ACCOUNT_WRITE: 'true',
        API_ALLOW_CONFIG_WRITE: 'true',
        API_RUN_COMMAND: process.execPath,
        API_RUN_ARGS: JSON.stringify([path.join(dir, 'fake.cjs')]),
        API_STOP_TIMEOUT_MS: '1000',
        ...extra
    }
    fs.writeFileSync(
        path.join(dir, '.env'),
        Object.entries(env)
            .filter(([key]) => /^ACCOUNT_\d+_/.test(key))
            .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
            .join('\n') + '\n'
    )
    const start = async () => {
        const child = spawn(process.execPath, ['scripts/api/server.js'], {
            cwd: dir,
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        })
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('fixture startup timed out')), 10000)
            child.stdout.on('data', chunk => {
                if (String(chunk).includes('__API_READY__')) {
                    clearTimeout(timer)
                    resolve()
                }
            })
            child.once('exit', code => {
                clearTimeout(timer)
                reject(new Error(`fixture exited ${code}`))
            })
        })
        return child
    }
    let child = await start()
    const stop = async () => {
        if (child.exitCode === null) {
            child.kill('SIGTERM')
            await new Promise(r => child.once('exit', r))
        }
    }
    t.after(async () => {
        await stop()
        fs.rmSync(dir, { recursive: true, force: true })
    })
    const request = async (route, method = 'GET', body, auth = true) => {
        const response = await fetch(`http://127.0.0.1:${port}${route}`, {
            method,
            headers: { ...(auth ? { Authorization: 'Bearer test-only' } : {}), 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        })
        return { status: response.status, data: await response.json() }
    }
    const restart = async () => {
        child.kill('SIGTERM')
        await new Promise(r => child.once('exit', r))
        child = await start()
    }
    return { request, restart, stop, config, url: `http://127.0.0.1:${port}`, dir }
}
