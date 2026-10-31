import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))

async function fixture(t, writable = true) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-urgent-api-'))
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    fs.cpSync(path.join(root, 'packages'), path.join(dir, 'packages'), { recursive: true })
    fs.cpSync(path.join(root, 'scripts', 'api'), path.join(dir, 'scripts', 'api'), { recursive: true })
    fs.copyFileSync(path.join(root, 'scripts', 'package.json'), path.join(dir, 'scripts', 'package.json'))
    fs.copyFileSync(path.join(root, 'scripts', 'utils.js'), path.join(dir, 'scripts', 'utils.js'))
    fs.copyFileSync(path.join(root, 'scripts', 'env.js'), path.join(dir, 'scripts', 'env.js'))
    fs.cpSync(path.join(root, 'scripts', 'main'), path.join(dir, 'scripts', 'main'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'common'), { recursive: true })
    fs.copyFileSync(path.join(root, 'common', 'proxyRelay.cjs'), path.join(dir, 'common', 'proxyRelay.cjs'))
    fs.copyFileSync(path.join(root, 'common', 'browserIdentity.cjs'), path.join(dir, 'common', 'browserIdentity.cjs'))
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'urgent-api-fixture', version: '0.0.0' }))
    fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({ workers: { doMobileSearch: true, doDesktopSearch: true } })
    )
    const fixtureEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ACCOUNT_\d+_/.test(key)))
    const socket = net.createServer()
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
    const port = socket.address().port
    await new Promise(resolve => socket.close(resolve))
    fs.writeFileSync(
        path.join(dir, 'smart.json'),
        JSON.stringify({ enabled: false, profiles: [{ accountIndex: 900001, allowedWorkers: [] }] })
    )
    fs.writeFileSync(path.join(dir, 'schedule.json'), JSON.stringify({ enabled: false }))
    fs.writeFileSync(path.join(dir, 'child.cjs'), 'setTimeout(() => {}, 3000)')
    const child = spawn(process.execPath, ['scripts/api/server.js'], {
        cwd: dir,
        env: {
            ...fixtureEnv,
            API_HOST: '127.0.0.1',
            API_PORT: String(port),
            API_TOKEN: 'urgent-test-only',
            API_ALLOW_SCHEDULE_WRITE: String(writable),
            SMART_SCHEDULE_FILE: path.join(dir, 'smart.json'),
            SCHEDULE_FILE: path.join(dir, 'schedule.json'),
            API_DIAGNOSTICS_DIR: dir,
            API_RUN_COMMAND: process.execPath,
            API_RUN_ARGS: JSON.stringify([path.join(dir, 'child.cjs')]),
            API_STOP_TIMEOUT_MS: '1000',
            ACCOUNT_900001_EMAIL: 'fixture@example.test'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    })
    t.after(async () => {
        if (child.exitCode == null) {
            const exited = new Promise(resolve => child.once('exit', resolve))
            child.kill('SIGTERM')
            await exited
        }
        fs.rmSync(dir, { recursive: true, force: true })
    })
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Fixture API did not become ready')), 10000)
        let output = ''
        let errorOutput = ''
        child.stderr.on('data', chunk => {
            errorOutput = (errorOutput + chunk).slice(-2000)
        })
        child.stdout.on('data', chunk => {
            output = (output + chunk).slice(-10000)
            if (output.includes('__API_READY__')) {
                clearTimeout(timeout)
                resolve()
            }
        })
        child.once('exit', () => {
            clearTimeout(timeout)
            reject(new Error(`Fixture API exited before readiness: ${errorOutput}`))
        })
        child.once('error', reject)
    })
    return async (endpoint, body, authorized = true) => {
        const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
                'content-type': 'application/json',
                ...(authorized ? { authorization: 'Bearer urgent-test-only' } : {})
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(5000)
        })
        return { status: response.status, data: await response.json() }
    }
}

test('urgent API authenticates, validates, excludes legacy runs and returns to paused regular scheduling', async t => {
    const request = await fixture(t)
    assert.equal((await request('/smart-schedule/urgent', { enabled: true }, false)).status, 401)
    assert.equal((await request('/smart-schedule/urgent', { enabled: 'yes' })).status, 400)
    assert.equal((await request('/start', { accountIndex: 900001 })).status, 202)
    assert.equal((await request('/smart-schedule/urgent', { enabled: true })).status, 409)
    await request('/stop', {})
    for (let tries = 0; tries < 50; tries++) {
        if ((await request('/status')).data.state === 'idle') break
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    const started = await request('/smart-schedule/urgent', { enabled: true })
    assert.equal(started.status, 200)
    assert.equal(started.data.config.enabled, false)
    assert.equal(started.data.urgent.active, true)
    assert.equal(started.data.effectiveEnabled, true)
    assert.ok([...started.data.queue, ...started.data.running].every(job => job.urgent && job.searchBudget === 100))
    const cancelled = await request('/smart-schedule/urgent', { enabled: false })
    assert.equal(cancelled.data.urgent.status, 'cancelled')
    assert.equal(cancelled.data.effectiveEnabled, false)
    assert.equal(cancelled.data.running.length, started.data.running.length, 'cancel must let existing sessions finish')
})

test('urgent API requires schedule-write permission', async t => {
    const request = await fixture(t, false)
    assert.equal((await request('/smart-schedule/urgent', { enabled: true })).status, 403)
})
