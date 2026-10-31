import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fixture } from './apiFixture.js'
import { HybridStore } from './hybridStore.js'

async function eventually(read, check) {
    for (let i = 0; i < 100; i++) {
        const value = await read()
        if (check(value)) return value
        await new Promise(r => setTimeout(r, 100))
    }
    throw new Error('Condition not reached')
}

test('fleet migrates a legacy node, inherits settings, routes whole groups through Local and two VPS nodes without real browsers', async t => {
    const remote = await fixture(t, { MRS_NODE_ROLE: 'vps' })
    const other = await fixture(t, { MRS_NODE_ROLE: 'vps' })
    const local = await fixture(t, {
        MRS_NODE_ROLE: 'local',
        MRS_FLEET_ENABLED: '1',
        MRS_REMOTE_URL: remote.url,
        MRS_REMOTE_TOKEN: 'test-only',
        ACCOUNT_1_EMAIL: 'one@example.test',
        ACCOUNT_1_PROXY_URL: 'socks5://proxy.example.test',
        ACCOUNT_1_PROXY_PORT: '1080',
        ACCOUNT_2_EMAIL: 'two@example.test',
        ACCOUNT_2_PROXY_URL: 'socks5://proxy.example.test',
        ACCOUNT_2_PROXY_PORT: '1080',
        ACCOUNT_3_EMAIL: 'direct@example.test'
    })
    let nodes = await eventually(
        () => local.request('/nodes'),
        r => r.data.nodes?.length === 2 && r.data.nodes.every(n => n.online && n.status === 'applied')
    )
    const first = nodes.data.nodes.find(n => n.kind === 'vps').id
    const defaults = (await local.request('/execution-config/defaults')).data.config
    assert.equal(defaults.schedule.maxParallel, 1)
    assert.equal((await local.request(`/nodes/${first}/config`)).data.effective.schedule.maxParallel, 2)
    assert.equal((await local.request(`/nodes/${first}/config`, 'PUT', { schedule: { maxParallel: 3 } })).status, 202)
    await eventually(
        () => remote.request('/internal/hybrid/status'),
        r => r.data.limit === 3
    )
    assert.equal(
        (await local.request('/account-assignments/preview', 'POST', { accountIndexes: [3], targetNodeId: first }))
            .status,
        400
    )
    const preview = await local.request('/account-assignments/preview', 'POST', {
        accountIndexes: [1],
        targetNodeId: 'local'
    })
    assert.deepEqual(
        preview.data.accounts.map(a => a.index),
        [1, 2]
    )
    assert.equal(
        (await local.request('/account-assignments', 'POST', { accountIndexes: [1], targetNodeId: 'local' })).status,
        202
    )
    await eventually(
        () => local.request('/account-assignments'),
        r => r.data.operations.at(-1)?.phase === 'done'
    )
    assert.equal((await local.request('/account-assignments')).data.assignments['2'], 'local')
    assert.equal((await remote.request('/internal/hybrid/status')).data.smart.config.profiles.length, 0)
    const second = (await other.request('/internal/hybrid/status')).data.nodeId
    // Add an already authenticated synthetic node directly to the fixture's private registry.
    // Production enrollment is SSH-only and never offers a public arbitrary-URL endpoint.
    const store = new HybridStore(path.join(local.dir, 'config', 'hybrid'))
    const registry = store.get('fleet')
    registry.nodes.push({
        id: second,
        name: 'VPS 2',
        kind: 'vps',
        url: other.url,
        token: 'test-only',
        overrides: { schedule: { maxParallel: 1 } }
    })
    store.set('fleet', registry)
    store.close()
    await local.restart()
    await eventually(
        () => local.request('/nodes'),
        r => r.data.nodes?.length === 3 && r.data.nodes.every(n => n.online)
    )
    await local.request('/account-assignments', 'POST', { accountIndexes: [1], targetNodeId: second })
    await eventually(
        () => local.request('/account-assignments'),
        r => r.data.operations.at(-1)?.phase === 'done'
    )
    assert.equal((await other.request('/internal/hybrid/status')).data.smart.config.profiles.length, 2)
    await local.request('/account-assignments', 'POST', { accountIndexes: [2], targetNodeId: first })
    await eventually(
        () => local.request('/account-assignments'),
        r => r.data.operations.at(-1)?.phase === 'done'
    )
    assert.equal((await other.request('/internal/hybrid/status')).data.smart.config.profiles.length, 0)
    assert.equal((await remote.request('/internal/hybrid/status')).data.smart.config.profiles.length, 2)
    assert.equal((await local.request(`/nodes/${first}`, 'DELETE')).status, 409)
    const redacted = JSON.stringify((await local.request('/nodes')).data)
    assert.ok(!redacted.includes('test-only'))
})

test('fleet public configuration redacts nested webhook credentials and validates overrides and managed paths', async t => {
    const local = await fixture(t, { MRS_NODE_ROLE: 'local', MRS_FLEET_ENABLED: '1' })
    let d = (await local.request('/execution-config/defaults')).data.config
    d.bot.webhook = {
        ...d.bot.webhook,
        discord: { ...d.bot.webhook?.discord, url: 'https://example.test/private-hook' }
    }
    assert.equal((await local.request('/execution-config/defaults', 'PUT', d)).status, 202)
    d = (await local.request('/execution-config/defaults')).data.config
    assert.equal(d.bot.webhook.discord.url, '***REDACTED***')
    assert.equal((await local.request('/execution-config/defaults', 'PUT', d)).status, 202)
    assert.equal(
        (await local.request('/nodes/local/config', 'PUT', { bot: { sessionPath: '/tmp/other' } })).status,
        400
    )
    assert.equal((await local.request('/nodes/local/config', 'PUT', { schedule: { maxParallel: 0 } })).status, 400)
    assert.equal((await local.request('/nodes/local/config', 'PUT', { schedule: { maxParallel: 4 } })).status, 202)
    assert.equal((await local.request('/nodes/local/config')).data.effective.schedule.maxParallel, 4)
    assert.equal((await local.request('/nodes/local/config', 'PUT', {})).status, 202)
    assert.equal((await local.request('/nodes/local/config')).data.effective.schedule.maxParallel, 1)
    assert.equal(
        (await local.request('/nodes', 'POST', { name: 'bad', host: '-oProxyCommand=x', user: 'root' })).status,
        400
    )
})

test('a running group waits without interruption, survives coordinator restart, and Move now checkpoints before transfer', async t => {
    const remote = await fixture(t, { MRS_NODE_ROLE: 'vps' })
    const local = await fixture(t, {
        MRS_NODE_ROLE: 'local',
        MRS_FLEET_ENABLED: '1',
        MRS_REMOTE_URL: remote.url,
        MRS_REMOTE_TOKEN: 'test-only',
        ACCOUNT_1_EMAIL: 'one@example.test',
        ACCOUNT_1_PROXY_URL: 'socks5://proxy.example.test',
        ACCOUNT_1_PROXY_PORT: '1080'
    })
    await eventually(
        () => local.request('/nodes'),
        r => r.data.nodes?.some(n => n.kind === 'vps' && n.status === 'applied')
    )
    await remote.request('/internal/hybrid/control', 'POST', {
        route: '/smart-schedule/urgent',
        body: { enabled: true }
    })
    const running = await eventually(
        () => remote.request('/internal/hybrid/status'),
        r => r.data.smart.running.length === 1
    )
    await new Promise(r => setTimeout(r, 150))
    const move = (await local.request('/account-assignments', 'POST', { accountIndexes: [1], targetNodeId: 'local' }))
        .data.operation
    await eventually(
        () => local.request(`/node-operations/${move.id}`),
        r => r.data.operation.status === 'waiting'
    )
    assert.equal(
        (await remote.request('/internal/hybrid/status')).data.smart.running[0].id,
        running.data.smart.running[0].id
    )
    await local.restart()
    await eventually(
        () => local.request(`/node-operations/${move.id}`),
        r => r.data.operation.status === 'waiting'
    )
    assert.equal(
        (await local.request('/account-assignments', 'POST', { accountIndexes: [1], targetNodeId: 'local' })).status,
        409
    )
    assert.equal((await local.request(`/node-operations/${move.id}/retry`, 'POST', { now: true })).status, 202)
    await eventually(
        () => local.request(`/node-operations/${move.id}`),
        r => r.data.operation.phase === 'done'
    )
    assert.equal((await remote.request('/internal/hybrid/status')).data.smart.running.length, 0)
    const events = (await remote.request('/internal/hybrid/events')).data.events
    assert.ok(events.some(e => e.title === 'SESSION-CHECKPOINT'))
})

test('an unavailable source retains ownership and cannot be replaced by cached sessions', async t => {
    const remote = await fixture(t, { MRS_NODE_ROLE: 'vps' })
    const local = await fixture(t, {
        MRS_NODE_ROLE: 'local',
        MRS_FLEET_ENABLED: '1',
        MRS_REMOTE_URL: remote.url,
        MRS_REMOTE_TOKEN: 'test-only',
        ACCOUNT_1_EMAIL: 'one@example.test',
        ACCOUNT_1_PROXY_URL: 'socks5://proxy.example.test',
        ACCOUNT_1_PROXY_PORT: '1080'
    })
    const nodes = await eventually(
        () => local.request('/nodes'),
        r => r.data.nodes?.some(n => n.kind === 'vps' && n.status === 'applied')
    )
    const id = nodes.data.nodes.find(n => n.kind === 'vps').id
    await remote.stop()
    const move = (await local.request('/account-assignments', 'POST', { accountIndexes: [1], targetNodeId: 'local' }))
        .data.operation
    await eventually(
        () => local.request(`/node-operations/${move.id}`),
        r => r.data.operation.error === 'NODE_OFFLINE'
    )
    assert.equal((await local.request('/account-assignments')).data.assignments['1'], id)
    assert.equal((await local.request('/smart-schedule')).data.running.length, 0)
    assert.ok((await local.request('/nodes')).data.nodes.find(n => n.id === 'local').online)
})

test('account edits and enrollment update the live fleet environment and survive coordinator restart', async t => {
    const remote = await fixture(t, { MRS_NODE_ROLE: 'vps' })
    const local = await fixture(t, {
        MRS_NODE_ROLE: 'local',
        MRS_FLEET_ENABLED: '1',
        MRS_REMOTE_URL: remote.url,
        MRS_REMOTE_TOKEN: 'test-only',
        ACCOUNT_1_EMAIL: 'one@example.test',
        ACCOUNT_1_PROXY_URL: 'socks5://proxy.example.test',
        ACCOUNT_1_PROXY_PORT: '1080'
    })
    await eventually(
        () => local.request('/nodes'),
        r => r.data.nodes?.some(n => n.kind === 'vps' && n.status === 'applied')
    )
    assert.equal((await local.request('/accounts/1', 'PATCH', { proxy: null })).status, 200)
    await eventually(
        () => local.request('/account-assignments'),
        r => r.data.assignments['1'] === 'local'
    )
    await eventually(
        () => remote.request('/internal/hybrid/status'),
        r => r.data.smart.config.profiles.length === 0
    )
    const added = await local.request('/accounts', 'POST', {
        accounts: [{ email: 'new@example.test', password: 'synthetic-password' }]
    })
    assert.equal(added.status, 201)
    await eventually(
        () => local.request('/nodes/local/config'),
        r => r.data.effective.schedule.profiles.length === 2
    )
    await local.restart()
    assert.equal((await local.request('/nodes/local/config')).data.effective.schedule.profiles.length, 2)
    assert.equal((await local.request('/nodes')).data.nodes.find(n => n.id === 'local').accountCount, 2)
})

test('targeted retry routes only selected accounts to their owner and validates before dispatch', async t => {
    const remote = await fixture(t, { MRS_NODE_ROLE: 'vps' })
    const local = await fixture(t, {
        MRS_NODE_ROLE: 'local',
        MRS_FLEET_ENABLED: '1',
        MRS_REMOTE_URL: remote.url,
        MRS_REMOTE_TOKEN: 'test-only',
        ACCOUNT_1_EMAIL: 'one@example.test',
        ACCOUNT_1_PROXY_URL: 'socks5://proxy.example.test',
        ACCOUNT_1_PROXY_PORT: '1080',
        ACCOUNT_2_EMAIL: 'direct@example.test'
    })
    await eventually(
        () => local.request('/nodes'),
        r => r.data.nodes?.every(n => n.status === 'applied')
    )
    assert.equal((await local.request('/smart-schedule/retry', 'POST', { accountIndexes: [1, 99] })).status, 404)
    assert.equal((await remote.request('/internal/hybrid/status')).data.smart.running.length, 0)
    await remote.request('/internal/hybrid/control', 'POST', {
        route: '/smart-schedule/urgent',
        body: { enabled: true }
    })
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal((await local.request('/smart-schedule/retry', 'POST', { accountIndexes: [1] })).status, 202)
    const state = await eventually(
        () => remote.request('/internal/hybrid/status'),
        r => r.data.smart.running.length === 1
    )
    assert.equal(state.data.smart.running[0].accountIndex, 1)
    assert.equal((await local.request('/status')).data.smart.running.filter(j => j.node === 'local').length, 0)
})

test('per-account Stop checkpoints only the selected VPS job, survives restart and rejects an obsolete execution', async t => {
    const remote = await fixture(t, { MRS_NODE_ROLE: 'vps' })
    const local = await fixture(t, {
        MRS_NODE_ROLE: 'local',
        MRS_FLEET_ENABLED: '1',
        MRS_REMOTE_URL: remote.url,
        MRS_REMOTE_TOKEN: 'test-only',
        ACCOUNT_1_EMAIL: 'one@example.test',
        ACCOUNT_1_PROXY_URL: 'socks5://one.example.test',
        ACCOUNT_1_PROXY_PORT: '1080',
        ACCOUNT_2_EMAIL: 'two@example.test',
        ACCOUNT_2_PROXY_URL: 'socks5://two.example.test',
        ACCOUNT_2_PROXY_PORT: '1080'
    })
    await eventually(
        () => local.request('/nodes'),
        r => r.data.nodes?.every(n => n.status === 'applied')
    )
    await remote.request('/internal/hybrid/control', 'POST', {
        route: '/smart-schedule/urgent',
        body: { enabled: true }
    })
    const initial = await eventually(
        () => local.request('/status'),
        r => r.data.smart.running.length === 2
    )
    const first = initial.data.smart.running.find(j => j.accountIndex === 1)
    const other = initial.data.smart.running.find(j => j.accountIndex === 2)
    const route = '/smart-schedule/accounts/1/stop'
    assert.equal((await local.request(route, 'POST', { jobId: first.executionId }, false)).status, 401)
    assert.equal((await local.request(route, 'POST', { jobId: 'obsolete-job' })).status, 409)
    await new Promise(r => setTimeout(r, 150))
    const stopped = await local.request(route, 'POST', { jobId: first.executionId })
    assert.equal(stopped.status, 200)
    assert.equal(stopped.data.stopped, true)
    assert.equal(stopped.data.sessionSaved, true)
    assert.ok(Date.parse(stopped.data.nextEligibleAt) > Date.now())
    const after = (await remote.request('/internal/hybrid/status')).data.smart
    assert.deepEqual(
        after.running.map(j => j.accountIndex),
        [2]
    )
    assert.equal(after.running[0].executionId, other.executionId)
    assert.ok(after.sessions.some(j => j.accountIndex === 1 && j.stopped && j.interrupted))
    assert.equal(after.accounts['1'].platforms.desktop.failures, 0)
    assert.equal((await local.request(route, 'POST', { jobId: first.executionId })).data.alreadyStopped, true)
    await remote.restart()
    const restored = (await remote.request('/internal/hybrid/status')).data.smart
    assert.ok(restored.running.every(j => j.accountIndex !== 1))
    assert.ok(Date.parse(restored.accounts['1'].manualStopUntil) > Date.now())
    await remote.request('/internal/hybrid/control', 'POST', { route: '/start', body: { accountIndex: 1 } })
    const restarted = await eventually(
        () => remote.request('/internal/hybrid/status'),
        r => r.data.smart.running.some(j => j.accountIndex === 1)
    )
    assert.notEqual(restarted.data.smart.running.find(j => j.accountIndex === 1).executionId, first.executionId)
    assert.equal((await local.request(route, 'POST', { jobId: first.executionId })).status, 409)
})

test('unreachable VPS loses Running evidence instead of replaying its cached roster', async t => {
    const remote = await fixture(t, { MRS_NODE_ROLE: 'vps' })
    const local = await fixture(t, {
        MRS_NODE_ROLE: 'local',
        MRS_FLEET_ENABLED: '1',
        MRS_REMOTE_URL: remote.url,
        MRS_REMOTE_TOKEN: 'test-only',
        ACCOUNT_1_EMAIL: 'one@example.test',
        ACCOUNT_1_PROXY_URL: 'socks5://proxy.example.test',
        ACCOUNT_1_PROXY_PORT: '1080'
    })
    await eventually(
        () => local.request('/nodes'),
        r => r.data.nodes?.every(n => n.status === 'applied')
    )
    await remote.request('/internal/hybrid/control', 'POST', {
        route: '/smart-schedule/urgent',
        body: { enabled: true }
    })
    await eventually(
        () => local.request('/accounts'),
        r => r.data.accounts[0].execution.state === 'running'
    )
    await remote.stop()
    await eventually(
        () => local.request('/accounts'),
        r => r.data.accounts[0].execution.state === 'unknown'
    )
    assert.equal((await local.request('/status')).data.smart.running.length, 0)
})
