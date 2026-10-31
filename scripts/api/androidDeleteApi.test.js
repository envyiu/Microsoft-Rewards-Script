import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-android-delete-api-'))
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
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'android-api-fixture', version: '0.0.0' }))
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
    const calls = []
    const bridgeState = { result: { deleted: true, worker: 0 } }
    const bridgePath = path.join(dir, 'bridge.sock')
    const bridge = net.createServer(connection => {
        let raw = ''
        connection.on('data', chunk => {
            raw += chunk
            if (!raw.includes('\n')) return
            calls.push(JSON.parse(raw.split('\n')[0]))
            connection.end(
                JSON.stringify(
                    bridgeState.error ? { ok: false, ...bridgeState.error } : { ok: true, result: bridgeState.result }
                ) + '\n'
            )
        })
    })
    await new Promise(resolve => bridge.listen(bridgePath, resolve))
    t.after(() => bridge.close())
    const child = spawn(process.execPath, ['scripts/api/server.js'], {
        cwd: dir,
        env: {
            ...fixtureEnv,
            API_HOST: '127.0.0.1',
            API_PORT: String(port),
            API_TOKEN: 'android-test-only',
            API_ALLOW_SCHEDULE_WRITE: 'false',
            SMART_SCHEDULE_FILE: path.join(dir, 'smart.json'),
            SCHEDULE_FILE: path.join(dir, 'schedule.json'),
            API_DIAGNOSTICS_DIR: dir,
            API_RUN_COMMAND: process.execPath,
            API_RUN_ARGS: JSON.stringify([path.join(dir, 'child.cjs')]),
            API_STOP_TIMEOUT_MS: '1000',
            DAMRU_BRIDGE_SOCKET: bridgePath,
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
    const request = async (endpoint, body, authorized = true, method = body === undefined ? 'GET' : 'DELETE') => {
        const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
            method,
            headers: {
                'content-type': 'application/json',
                ...(authorized ? { authorization: 'Bearer android-test-only' } : {})
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(5000)
        })
        return { status: response.status, data: await response.json() }
    }
    return { request, calls, bridgeState }
}

test('Android deletion authenticates, validates and sends only the expected account worker to the bridge', async t => {
    const { request, calls, bridgeState } = await fixture(t)
    const endpoint = '/android-sessions/900001'
    const body = { worker: 0, confirmation: 'DELETE 0' }
    assert.equal((await request(endpoint, body, false)).status, 401)
    assert.equal((await request(endpoint, { worker: 0 })).status, 400)
    assert.equal((await request(endpoint, { worker: -1, confirmation: 'DELETE -1' })).status, 400)
    assert.equal((await request('/android-sessions/999999', body)).status, 404)
    assert.equal(calls.length, 0)
    const result = await request(endpoint, body)
    assert.equal(result.status, 200)
    assert.deepEqual(result.data, { deleted: true, accountIndex: 900001, worker: 0 })
    assert.equal(calls[0].action, 'delete')
    assert.deepEqual(calls[0].data, {
        accountRef: crypto.createHash('sha256').update('fixture@example.test').digest('hex'),
        accountIndex: 900001,
        ...body
    })
    bridgeState.error = { code: 'WORKER_CHANGED', error: 'Device changed' }
    assert.equal((await request(endpoint, body)).status, 409)
    bridgeState.error = { code: 'WORKER_BUSY', error: 'Device busy' }
    assert.equal((await request(endpoint, body)).status, 409)
    bridgeState.error = null
    bridgeState.result = { deleted: false, worker: null, accountRef: 'hidden', proxy: 'hidden' }
    const missing = await request(endpoint, body)
    assert.deepEqual(missing.data, { deleted: false, accountIndex: 900001, worker: null })
    const before = calls.length
    assert.equal((await request('/start', { accountIndex: 900001 }, true, 'POST')).status, 202)
    assert.equal((await request(endpoint, body)).status, 409)
    assert.equal(calls.length, before)
})
