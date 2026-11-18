import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { loadConfig, loadEnvFile } from '../utils.js'
import { workerFixture } from './fixture.js'
import { validateSmartConfig } from '../../packages/contracts/smartConfig.js'

test('manual helpers use the worker data configuration and skip repository account files', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'msrw-manual-config-'))
    const original = { config: process.env.MRS_CONFIG_FILE, skip: process.env.MRS_SKIP_ENV_FILE }
    t.after(() => {
        for (const [key, value] of [
            ['MRS_CONFIG_FILE', original.config],
            ['MRS_SKIP_ENV_FILE', original.skip]
        ]) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        fs.rmSync(directory, { recursive: true, force: true })
    })
    const file = path.join(directory, 'worker-config.json')
    fs.writeFileSync(file, JSON.stringify({ sessionPath: path.join(directory, 'sessions') }))
    fs.writeFileSync(path.join(directory, '.env'), 'MSRW_SYNTHETIC_ENV_SHOULD_NOT_LOAD=true\n')
    process.env.MRS_CONFIG_FILE = file
    process.env.MRS_SKIP_ENV_FILE = '1'
    assert.equal(loadConfig(directory).path, file)
    loadEnvFile(directory)
    assert.equal(process.env.MSRW_SYNTHETIC_ENV_SHOULD_NOT_LOAD, undefined)
})

function snapshot(worker, accountEnv = { ACCOUNT_1_EMAIL: 'direct@example.test' }) {
    const botConfig = JSON.parse(fs.readFileSync(path.join(worker.directory, 'config.example.json'), 'utf8'))
    const schedule = validateSmartConfig({ enabled: false }, [{ index: 1 }])
    const content = { protocolVersion: 3, accountEnv, botConfig, schedule }
    return {
        ...content,
        revision: crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex'),
        generation: 1,
        authority: '00000000-0000-0000-0000-000000000001'
    }
}

test('remote worker refuses direct accounts, incompatible protocols and direct management writes', async t => {
    const worker = await workerFixture(t)
    const body = snapshot(worker)
    assert.equal((await worker.request('/internal/hybrid/snapshot', 'PUT', body)).status, 400)
    assert.equal((await worker.request('/internal/hybrid/status')).data.revision, null)
    assert.equal(
        (await worker.request('/internal/hybrid/snapshot', 'PUT', { ...body, protocolVersion: 2 })).data.code,
        'UPGRADE_REQUIRED'
    )
    assert.equal((await worker.request('/config', 'PATCH', { headless: false })).status, 403)
    assert.equal(
        (await worker.request('/manual-sessions', 'POST', { accountIndex: 1, platform: 'desktop' })).data.code,
        'CAPABILITY_UNAVAILABLE'
    )
})

test('local worker persists only its accepted subset, rejects a stale authority and keeps its data outside the release', async t => {
    const worker = await workerFixture(t, { kind: 'local' })
    const body = snapshot(worker)
    assert.equal((await worker.request('/internal/hybrid/snapshot', 'PUT', body)).status, 200)
    const stored = JSON.parse(fs.readFileSync(path.join(worker.data, 'config.json'), 'utf8'))
    assert.equal(stored.sessionPath, path.join(worker.data, 'sessions'))
    assert.equal(fs.existsSync(path.join(worker.directory, 'config.json')), false)
    assert.equal(
        (await worker.request('/internal/hybrid/snapshot', 'PUT', { ...body, authority: crypto.randomUUID() })).data
            .code,
        'STALE_SNAPSHOT'
    )
    await worker.restart()
    assert.equal((await worker.request('/accounts')).data.accounts[0].email, 'direct@example.test')
    assert.equal((await worker.request('/internal/hybrid/status')).data.generation, 1)
    assert.equal((await worker.request('/internal/hybrid/status')).data.smart.config.enabled, false)
})

test('streak policy imports the latest observation and retains it across a worker restart', async t => {
    const worker = await workerFixture(t, { kind: 'local' }),
        body = snapshot(worker)
    assert.equal((await worker.request('/internal/hybrid/snapshot', 'PUT', body)).status, 200)
    const second = structuredClone(body)
    second.generation = 2
    second.revision = crypto.randomBytes(32).toString('hex')
    second.schedule.streakSearchV1 = true
    second.initialStreaks = [
        { index: 1, email: 'direct@example.test', dailyCounter: 10, observedAt: new Date().toISOString() }
    ]
    assert.equal((await worker.request('/internal/hybrid/snapshot', 'PUT', second)).status, 200)
    await worker.restart()
    const status = (await worker.request('/internal/hybrid/status')).data
    assert.equal(status.capabilities.streakSearchV1, true)
    assert.equal(status.smart.accounts[1].searchStreak.dailyCounter, 10)
    assert.equal(status.smart.accounts[1].platforms.desktop.dailySearchTarget, 15)
    assert.equal(status.smart.accounts[1].platforms.mobile.dailySearchTarget, 10)
})

test('worker preserves a used session after restart and queues targeted Run without bypassing rest', async t => {
    const worker = await workerFixture(t, { kind: 'local' }),
        body = snapshot(worker)
    body.schedule.profiles[0].allowedWorkers = []
    assert.equal((await worker.request('/internal/hybrid/snapshot', 'PUT', body)).status, 200)
    assert.equal((await worker.request('/internal/hybrid/status')).data.capabilities.conservativeSessionsV1, true)
    const started = await worker.request('/internal/hybrid/control', 'POST', {
        route: '/run-once',
        body: { accountIndexes: [1] }
    })
    assert.equal(started.status, 202)
    assert.equal(started.data.smart.running.length, 1)
    assert.equal(started.data.smart.running[0].type, 'accountSession')
    await worker.request('/internal/hybrid/control', 'POST', { route: '/stop', body: {} })
    await worker.restart()
    const before = (await worker.request('/internal/hybrid/status')).data.smart
    assert.equal(before.config.enabled, false)
    assert.equal(before.accounts[1].protection.sessions.length, 1)
    const refused = await worker.request('/internal/hybrid/control', 'POST', {
        route: '/run-once',
        body: { accountIndexes: [1] }
    })
    assert.equal(refused.status, 202)
    assert.equal(refused.data.outcomes[0].state, 'queued')
    assert.ok(refused.data.outcomes[0].blockers.some(item => item.code === 'SESSION_REST'))
    const after = (await worker.request('/internal/hybrid/status')).data.smart
    assert.equal(after.running.length, 0)
    assert.equal(after.accounts[1].protection.sessions.length, 1)
    assert.equal(after.accounts[1].normalPolicyStatus.sessionsUsed, 1)
    assert.equal(after.accounts[1].normalPolicyStatus.blockedReason, 'SESSION_REST')
    const released = await worker.request('/internal/hybrid/control', 'POST', {
        route: '/smart-schedule/release-protection',
        body: { accountIndexes: [1], acknowledge: true }
    })
    assert.equal(released.status, 202)
    assert.equal(released.data.smart.accounts[1].normalPolicyStatus.blockedReason, 'SESSION_REST')
    assert.equal(released.data.smart.config.enabled, false)
})

test('worker restores Smart state from last-good file after primary corruption', async t => {
    const worker = await workerFixture(t)
    await worker.stop()
    const file = path.join(worker.data, 'smart-schedule.json')
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    saved.state.recoveryTestMarker = 'retained-progress'
    fs.writeFileSync(file + '.last-good', JSON.stringify(saved))
    fs.writeFileSync(file, '{broken')
    await worker.restart()
    const restored = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(restored.state.recoveryTestMarker, 'retained-progress')
    assert.ok(fs.readdirSync(worker.data).some(name => name.startsWith('smart-schedule.json.corrupt-')))
})

test('existing worker refuses to invent fresh progress when both Smart files are missing', async t => {
    const worker = await workerFixture(t)
    await worker.stop()
    const file = path.join(worker.data, 'smart-schedule.json')
    fs.rmSync(file, { force: true })
    fs.rmSync(file + '.last-good', { force: true })
    await assert.rejects(worker.restart(), /Existing worker has lost Smart state/)
})
