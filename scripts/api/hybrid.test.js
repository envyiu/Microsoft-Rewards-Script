import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { Hybrid } from './hybrid.js'
import { HybridStore } from './hybridStore.js'
import { exportAccountSession, importAccountSession } from './sessionStore.js'
import { SmartScheduler } from './smartScheduler.js'

function directory(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-hybrid-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ sessionPath: 'sessions', workers: {} }))
    return dir
}
function node(t, role = 'vps') {
    const root = directory(t)
    const env = {
        MRS_NODE_ROLE: role,
        API_TOKEN: 'test-token',
        MRS_REMOTE_URL: 'http://127.0.0.1:1',
        MRS_REMOTE_TOKEN: 'test-remote',
        ACCOUNT_1_EMAIL: 'one@example.test',
        ACCOUNT_1_PROXY_URL: 'socks5://one.test',
        ACCOUNT_1_PROXY_PORT: '1080'
    }
    const hybrid = new Hybrid({ projectRoot: root, environment: env })
    t.after(() => hybrid.close())
    return { hybrid, root, env }
}
const request = async (hybrid, route, method = 'GET', body = {}) => {
    let result
    await hybrid.handle({ method }, new EventEmitter(), new URL(route, 'http://localhost'), {
        read: async () => body,
        send: (_, status, data) => {
            result = { status, data }
        }
    })
    return result
}

test('hybrid nodes own disjoint account sets and enforce separate caps', t => {
    const { hybrid: remote } = node(t)
    const { hybrid: local } = node(t, 'local')
    const proxied = { index: 1, proxy: { url: 'socks5://one.test' } }
    const direct = { index: 2, proxy: null }
    assert.equal(remote.owns(proxied), true)
    assert.equal(local.owns(proxied), false)
    assert.equal(remote.owns(direct), false)
    assert.equal(local.owns(direct), true)
    assert.equal(remote.hardParallel, 2)
    assert.equal(local.hardParallel, 1)
    local.blocked.add(2)
    assert.equal(local.owns(direct), false)
})

test('session transport is account scoped, transactional, and preserves both platforms and region', t => {
    const root = directory(t)
    const bundle = {
        sessions: ['desktop', 'mobile'].map(platform => ({
            email: 'one@example.test',
            platform,
            storage_state: JSON.stringify({ cookies: [], origins: [] }),
            fingerprint: null,
            updated_at: 123
        })),
        metadata: { email: 'one@example.test', resolved_region: 'US', updated_at: 122 }
    }
    importAccountSession(root, path.join(root, 'sessions'), 'one@example.test', bundle)
    assert.deepEqual(
        JSON.parse(JSON.stringify(exportAccountSession(root, path.join(root, 'sessions'), 'one@example.test'))),
        bundle
    )
    assert.throws(() => importAccountSession(root, path.join(root, 'sessions'), 'other@example.test', bundle))
    assert.equal(exportAccountSession(root, path.join(root, 'sessions'), 'one@example.test').sessions.length, 2)
    importAccountSession(root, path.join(root, 'sessions'), 'one@example.test', { sessions: [], metadata: null })
    assert.equal(exportAccountSession(root, path.join(root, 'sessions'), 'one@example.test').sessions.length, 0)
})

test('VPS materialization pins the session database across API and worker working directories', t => {
    const { hybrid, root } = node(t)
    const sessionPath = path.join(root, 'api-data', 'sessions')
    const relativePath = path.relative(process.cwd(), sessionPath)
    hybrid.materialize({ accountEnv: {}, botConfig: { sessionPath: relativePath } })
    const materialized = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'))
    assert.equal(materialized.sessionPath, sessionPath)
    assert.equal(path.resolve(root, materialized.sessionPath), path.resolve(process.cwd(), relativePath))
    assert.equal(hybrid.sessionPath(), sessionPath)
    hybrid.materialize({ accountEnv: {}, botConfig: materialized })
    assert.equal(hybrid.sessionPath(), sessionPath)
})

test('node journal survives restart, keeps source identities, and deduplicates received events', t => {
    const root = directory(t)
    let store = new HybridStore(root)
    store.append({ title: 'ACCOUNT-END', message: 'done' })
    const first = store.events()[0]
    store.receive([first, first], { node: first.sourceNode, id: 1 })
    assert.equal(store.pending().length, 1)
    store.close()
    store = new HybridStore(root)
    assert.equal(store.nodeId, first.sourceNode)
    assert.equal(store.events()[0].sourceEventId, first.sourceEventId)
    assert.deepEqual(store.get('cursor'), { node: first.sourceNode, id: 1 })
    store.emitted(`${first.sourceNode}:${first.sourceEventId}`)
    assert.equal(store.pending().length, 0)
    store.close()
})

test('manual handoff persists a group hold before stopping and survives node restart', async t => {
    const { hybrid, root, env } = node(t)
    const scheduler = new EventEmitter()
    const manager = new EventEmitter()
    manager.stop = async options => {
        assert.equal(options.signalTree, false)
        assert.equal(hybrid.store.get('holds')['1'].token, '00000000-0000-0000-0000-000000000001')
        manager.emit('log', { title: 'SESSION-CHECKPOINT', message: 'All active browser sessions saved' })
        manager.lastExit = { code: 0 }
    }
    Object.assign(scheduler, {
        document: { config: { networkGroupOverride: {} }, state: { accounts: {} } },
        running: new Map([['job', { job: { networkGroup: 'PROXY:one.test:1080' }, manager }]]),
        setManualLock: () => {}
    })
    hybrid.scheduler = scheduler
    const held = await hybrid.hold(1, '00000000-0000-0000-0000-000000000001')
    assert.equal(held.email, 'one@example.test')
    const again = new Hybrid({ projectRoot: root, environment: env })
    assert.equal(again.schedulerOptions().manualLocks.get(1), 'PROXY:one.test:1080')
    again.close()
    await assert.rejects(hybrid.hold(1, '00000000-0000-0000-0000-000000000002'), { code: 'ACCOUNT_HELD' })
})

test('failed checkpoint does not release a remote hold or allow session return with a wrong token', async t => {
    const { hybrid } = node(t)
    const manager = new EventEmitter()
    manager.stop = async () => {
        manager.lastExit = { code: 1 }
    }
    hybrid.scheduler = {
        document: { config: { networkGroupOverride: {} }, state: { accounts: {} } },
        setManualLock: () => {},
        running: new Map([['job', { job: { networkGroup: 'PROXY:one.test:1080' }, manager }]])
    }
    await assert.rejects(hybrid.hold(1, '00000000-0000-0000-0000-000000000001'), { code: 'CHECKPOINT_FAILED' })
    assert.ok(hybrid.holds[1])
    const result = await request(hybrid, '/internal/hybrid/accounts/1/release', 'POST', {
        token: '00000000-0000-0000-0000-000000000002'
    })
    assert.equal(result.status, 409)
    assert.ok(hybrid.holds[1])
})

test('urgent drain respects a hard node cap instead of its normal 32 job allowance', t => {
    const saved = process.env.ACCOUNT_900001_EMAIL
    process.env.ACCOUNT_900001_EMAIL = 'limit@example.test'
    t.after(() => {
        if (saved === undefined) delete process.env.ACCOUNT_900001_EMAIL
        else process.env.ACCOUNT_900001_EMAIL = saved
    })
    const scheduler = Object.create(SmartScheduler.prototype)
    scheduler.document = { config: { enabled: true, maxParallel: 32 }, state: { accounts: {}, urgentRun: { active: true } } }
    scheduler.running = new Map()
    scheduler.manualLocks = new Map()
    scheduler.accountFilter = () => true
    scheduler.hardParallel = 1
    scheduler.queue = [1, 2, 3].map(id => ({
        id,
        accountIndex: 900001,
        networkGroup: String(id),
        dueAt: new Date().toISOString(),
        urgent: true
    }))
    scheduler._start = job => scheduler.running.set(job.id, { job })
    scheduler.emit = () => {}
    scheduler.get = () => ({})
    scheduler._drain()
    assert.equal(scheduler.running.size, 1)
})

test('VPS refuses direct-account snapshots before modifying ownership or configuration', async t => {
    const { hybrid, root } = node(t)
    hybrid.scheduler = {}
    const before = fs.readFileSync(path.join(root, 'config.json'), 'utf8')
    const response = await request(hybrid, '/internal/hybrid/snapshot', 'PUT', {
        revision: 'a'.repeat(64),
        accountEnv: { ACCOUNT_2_EMAIL: 'direct@example.test' },
        botConfig: {},
        schedule: {}
    })
    assert.equal(response.status, 400)
    assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), before)
})

test('a handoff across midnight cannot mark yesterday workers complete on the new day', () => {
    const scheduler = Object.create(SmartScheduler.prototype)
    scheduler.running = new Map()
    scheduler.document = { state: { accounts: { 1: { day: '2026-10-25', workersCompleted: [] } }, sessions: [] } }
    scheduler._save = () => {}
    scheduler.replan = () => {}
    scheduler.emit = () => {}
    scheduler.get = () => ({})
    scheduler._finish(
        {
            handoff: true,
            job: { id: 'old-job', accountIndex: 1, day: '2026-10-24', type: 'workers' },
            workerResults: new Set(['dailySet'])
        },
        { code: 0 }
    )
    assert.deepEqual(scheduler.document.state.accounts[1].workersCompleted, [])
    assert.equal(scheduler.document.state.sessions[0].interrupted, true)
})
