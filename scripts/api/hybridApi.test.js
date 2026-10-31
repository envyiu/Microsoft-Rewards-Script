import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

const root = fileURLToPath(new URL('../../', import.meta.url))
async function fixture(t, extra = {}) {
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

test('VPS API authenticates snapshots, runs without a coordinator, caps urgent jobs, and restores holds on restart', async t => {
    const { request, restart, config, url } = await fixture(t, { MRS_NODE_ROLE: 'vps' })
    assert.equal((await request('/internal/hybrid/status', 'GET', undefined, false)).status, 401)
    const accountEnv = {}
    for (const i of [1, 2, 3])
        Object.assign(accountEnv, {
            [`ACCOUNT_${i}_EMAIL`]: `account${i}@example.test`,
            [`ACCOUNT_${i}_PROXY_URL`]: `socks5://proxy${i}.example.test`,
            [`ACCOUNT_${i}_PROXY_PORT`]: '1080'
        })
    const snapshot = {
        revision: 'a'.repeat(64),
        generation: 1,
        authority: '00000000-0000-0000-0000-000000000001',
        accountEnv,
        botConfig: config,
        schedule: {
            enabled: false,
            maxParallel: 32,
            profiles: [1, 2, 3].map(accountIndex => ({ accountIndex, allowedWorkers: [] }))
        }
    }
    const stageId = '00000000-0000-0000-0000-000000000003'
    const synthetic = {
        sessions: [
            {
                email: 'account1@example.test',
                platform: 'desktop',
                storage_state: JSON.stringify({
                    cookies: [],
                    origins: [
                        {
                            origin: 'https://fixture.example.test',
                            localStorage: [{ name: 'test', value: 'x'.repeat(2_000_000) }]
                        }
                    ]
                }),
                fingerprint: null,
                updated_at: 1
            }
        ],
        metadata: null
    }
    const staged = await fetch(`${url}/internal/hybrid/stage-session/${stageId}`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer test-only', 'Content-Encoding': 'gzip', 'Content-Type': 'application/json' },
        body: gzipSync(JSON.stringify({ index: 1, email: 'account1@example.test', bundle: synthetic }))
    })
    assert.equal(staged.status, 200)
    snapshot.initialSessions = [{ index: 1, email: 'account1@example.test', stageId }]
    assert.equal((await request('/internal/hybrid/snapshot', 'PUT', snapshot)).status, 200)
    assert.equal(
        (await request('/internal/hybrid/snapshot', 'PUT', { ...snapshot, generation: 2, revision: 'b'.repeat(64) }))
            .status,
        200
    )
    assert.equal(
        (await request('/internal/hybrid/snapshot', 'PUT', { ...snapshot, revision: 'c'.repeat(64) })).status,
        409
    )
    assert.equal((await request('/start', 'POST', {})).status, 403)
    assert.equal(
        (
            await request('/internal/hybrid/control', 'POST', {
                route: '/smart-schedule/urgent',
                body: { enabled: true }
            })
        ).status,
        202
    )
    let state = (await request('/internal/hybrid/status')).data
    assert.equal(state.smart.running.length, 2)
    const acceptedSnapshot = { ...snapshot, generation: 2, revision: 'b'.repeat(64) }
    assert.equal(
        (
            await request('/internal/hybrid/snapshot', 'PUT', {
                ...acceptedSnapshot,
                generation: 3,
                revision: 'd'.repeat(64),
                schedule: { ...snapshot.schedule, enabled: true }
            })
        ).status,
        409
    )
    assert.equal((await request('/internal/hybrid/status')).data.syncPending, true)
    // Cancelling an in-flight configuration change must resume the accepted schedule.
    assert.equal((await request('/internal/hybrid/snapshot', 'PUT', acceptedSnapshot)).status, 200)
    state = (await request('/internal/hybrid/status')).data
    assert.equal(state.syncPending, false)
    assert.equal(state.smart.running.length, 2)
    assert.equal(state.smart.config.enabled, false)
    const index = state.smart.running[0].accountIndex
    // Allow the fixture's signal listener to initialize; this never launches a browser.
    await new Promise(r => setTimeout(r, 100))
    const token = '00000000-0000-0000-0000-000000000001'
    const held = await request(`/internal/hybrid/accounts/${index}/hold`, 'POST', { token })
    assert.equal(held.status, 200)
    assert.equal((await request('/internal/hybrid/status')).data.holds.includes(index), true)
    await restart()
    state = (await request('/internal/hybrid/status')).data
    assert.equal(state.holds.includes(index), true)
    assert.ok(state.smart.running.every(job => job.accountIndex !== index))
    assert.ok(state.smart.running.length <= 2)
    const replay = (await request('/internal/hybrid/events')).data.events
    assert.ok(replay.length > 0)
    assert.ok(replay.every(entry => entry.sourceNode && entry.sourceEventId && entry.journalId))
    assert.equal(
        (await request(`/internal/hybrid/accounts/${index}/release`, 'POST', { token, bundle: held.data.bundle }))
            .status,
        200
    )
    assert.equal(
        (await request(`/internal/hybrid/accounts/${index}/release`, 'POST', { token, bundle: held.data.bundle }))
            .status,
        200
    )
})

test('home coordinator keeps direct execution local and retains stale VPS data during an outage', async t => {
    const remote = await fixture(t, { MRS_NODE_ROLE: 'vps' })
    const local = await fixture(t, {
        MRS_NODE_ROLE: 'local',
        MRS_REMOTE_URL: remote.url,
        MRS_REMOTE_TOKEN: 'test-only',
        ACCOUNT_1_EMAIL: 'proxy@example.test',
        ACCOUNT_1_PROXY_URL: 'socks5://proxy.example.test',
        ACCOUNT_1_PROXY_PORT: '1080',
        ACCOUNT_2_EMAIL: 'direct@example.test'
    })
    for (let i = 0; i < 30; i++) {
        const state = (await local.request('/smart-schedule')).data
        if (state.hybrid?.online && !state.hybrid.syncPending) break
        await new Promise(r => setTimeout(r, 100))
    }
    let state = (await local.request('/smart-schedule')).data
    assert.equal(state.hybrid.online, true)
    assert.equal(state.hybrid.syncPending, false)
    assert.equal(state.hybrid.local.limit, 1)
    assert.equal(state.hybrid.vps.limit, 2)
    const accounts = (await local.request('/accounts')).data.accounts
    assert.deepEqual(
        accounts.map(a => a.node),
        ['vps', 'local']
    )
    assert.equal((await local.request('/start', 'POST', { args: [] })).status, 409)
    assert.equal((await local.request('/hybrid/events')).status, 200)
    assert.equal((await local.request('/smart-schedule/urgent', 'POST', { enabled: true })).status, 202)
    const localProgress = JSON.parse(fs.readFileSync(path.join(local.dir, 'config', 'smart-schedule.json'), 'utf8'))
    assert.deepEqual(Object.keys(localProgress.state.urgentRun.targets), ['2'])
    assert.equal((await local.request('/smart-schedule')).data.urgent.effectiveParallel, 3)
    assert.equal((await local.request('/smart-schedule/urgent', 'POST', { enabled: false })).status, 202)
    const full = state.config
    full.enabled = true
    full.profiles = full.profiles.map(profile => ({ ...profile, allowedWorkers: [] }))
    const updated = await local.request('/smart-schedule', 'PUT', full)
    assert.equal(updated.status, 200)
    await remote.stop()
    await new Promise(r => setTimeout(r, 2200))
    state = (await local.request('/smart-schedule')).data
    assert.equal(state.hybrid.online, false)
    assert.ok(state.hybrid.syncedAt)
    assert.equal(
        state.running.filter(job => job.node === 'local').length,
        1,
        JSON.stringify({ enabled: state.config.enabled, queue: state.queue, accounts: state.accounts })
    )
    assert.ok(state.running.filter(job => job.node === 'local').every(job => job.accountIndex === 2))
})

test('account edits move ownership both ways and deleting the final VPS account leaves no stale owner', async t => {
    const remote = await fixture(t, { MRS_NODE_ROLE: 'vps' })
    const local = await fixture(t, {
        MRS_NODE_ROLE: 'local',
        MRS_REMOTE_URL: remote.url,
        MRS_REMOTE_TOKEN: 'test-only',
        ACCOUNT_1_EMAIL: 'proxy@example.test',
        ACCOUNT_1_PROXY_URL: 'socks5://one.example.test',
        ACCOUNT_1_PROXY_PORT: '1080',
        ACCOUNT_2_EMAIL: 'direct@example.test',
        ACCOUNT_3_EMAIL: 'other@example.test'
    })
    const wait = async expected => {
        for (let i = 0; i < 60; i++) {
            const state = (await local.request('/smart-schedule')).data
            const node = (await remote.request('/internal/hybrid/status')).data
            if (
                !state.hybrid.syncPending &&
                !state.hybrid.manualHolds.length &&
                JSON.stringify(node.smart.config.profiles.map(p => p.accountIndex)) === JSON.stringify(expected)
            )
                return
            await new Promise(r => setTimeout(r, 100))
        }
        assert.fail('ownership synchronization timed out')
    }
    await wait([1])
    assert.equal(
        (await local.request('/accounts/2', 'PATCH', { proxy: { url: 'socks5://two.example.test', port: 1080 } }))
            .status,
        200
    )
    await wait([1, 2])
    assert.equal((await local.request('/accounts/1', 'PATCH', { proxy: null })).status, 200)
    await wait([2])
    assert.equal((await local.request('/sessions/direct%40example.test', 'DELETE')).status, 200)
    assert.equal((await local.request('/accounts/2', 'DELETE')).status, 200)
    await wait([])
    const accounts = (await local.request('/accounts')).data.accounts
    assert.deepEqual(
        accounts.map(a => a.index),
        [1, 3]
    )
    assert.ok(accounts.every(a => a.node === 'local'))
})

test('VPS restart activates a queued snapshot before resuming old urgent work', async t => {
    const { request, restart, config } = await fixture(t, { MRS_NODE_ROLE: 'vps' })
    const snapshot = {
        protocolVersion: 2,
        revision: '1'.repeat(64),
        generation: 1,
        authority: '00000000-0000-0000-0000-000000000001',
        accountEnv: {
            ACCOUNT_1_EMAIL: 'one@example.test',
            ACCOUNT_1_PROXY_URL: 'socks5://proxy.example.test',
            ACCOUNT_1_PROXY_PORT: '1080'
        },
        botConfig: config,
        schedule: { enabled: false, maxParallel: 1, profiles: [{ accountIndex: 1, allowedWorkers: [] }] }
    }
    assert.equal((await request('/internal/hybrid/snapshot', 'PUT', snapshot)).status, 200)
    await request('/internal/hybrid/control', 'POST', {
        route: '/smart-schedule/urgent',
        body: { enabled: true }
    })
    assert.equal((await request('/internal/hybrid/status')).data.smart.running.length, 1)
    const next = {
        ...snapshot,
        revision: '2'.repeat(64),
        generation: 2,
        accountEnv: {
            ...snapshot.accountEnv,
            ACCOUNT_2_EMAIL: 'two@example.test',
            ACCOUNT_2_PROXY_URL: 'socks5://other.example.test',
            ACCOUNT_2_PROXY_PORT: '1080'
        },
        schedule: { ...snapshot.schedule, profiles: [1, 2].map(accountIndex => ({ accountIndex, allowedWorkers: [] })) }
    }
    assert.equal((await request('/internal/hybrid/snapshot', 'PUT', next)).data.code, 'SYNC_PENDING')
    // A cancelled queued change must not reappear after restart.
    assert.equal((await request('/internal/hybrid/snapshot', 'PUT', snapshot)).status, 200)
    await restart()
    assert.equal((await request('/internal/hybrid/status')).data.revision, snapshot.revision)
    assert.equal((await request('/internal/hybrid/status')).data.smart.running.length, 1)
    assert.equal((await request('/internal/hybrid/snapshot', 'PUT', next)).data.code, 'SYNC_PENDING')
    await restart()
    const state = (await request('/internal/hybrid/status')).data
    assert.equal(state.revision, next.revision)
    assert.equal(state.syncPending, false)
    assert.deepEqual(
        state.smart.config.profiles.map(p => p.accountIndex),
        [1, 2]
    )
})
