import assert from 'node:assert/strict'
import test from 'node:test'

import { SmartScheduler, deriveNetworkGroup } from './smartScheduler.js'

function fixture(t) {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-21T00:00:00Z') })
    const accounts = [
        { index: 1, proxy: { url: 'socks5://proxy.test', port: 1000 } },
        { index: 2, proxy: { url: 'socks5://proxy.test', port: 1000 } },
        { index: 3, proxy: null }
    ]
    const scheduler = Object.create(SmartScheduler.prototype)
    scheduler.document = {
        config: { enabled: true, maxParallel: 3, networkGroupOverride: {} },
        state: { accounts: { 1: {}, 2: {}, 3: {} }, onceAccounts: [2] }
    }
    scheduler._cachedAccounts = () => accounts
    scheduler._save = () => {}
    scheduler.running = new Map()
    scheduler.manualLocks = new Map()
    scheduler.emit = () => {}
    scheduler.get = () => ({})
    const group = deriveNetworkGroup(accounts[0], {})
    return { scheduler, group }
}

test('proxy rest is sampled once in 5–20 minutes, survives persistence and expires at its exact deadline', t => {
    const { scheduler, group } = fixture(t)
    scheduler._recordProxyCooldown({ accountIndex: 1, networkGroup: group })
    const rest = scheduler.document.state.accounts[1].proxyCooldown
    const until = Date.parse(rest.until)
    assert.ok(until - Date.now() >= 5 * 60_000)
    assert.ok(until - Date.now() <= 20 * 60_000)
    scheduler.document = JSON.parse(JSON.stringify(scheduler.document))
    assert.equal(scheduler._proxyCooldownUntil(group, 2), until)
    assert.equal(scheduler._proxyCooldownUntil(group, 1), 0)
    assert.equal(scheduler._proxyCooldownUntil('PROXY:other:1000', 2), 0)
    scheduler._recordProxyCooldown({ accountIndex: 3, networkGroup: 'DIRECT' })
    assert.equal(scheduler.document.state.accounts[3].proxyCooldown, undefined)
    t.mock.timers.tick(until - Date.now() - 1)
    assert.equal(scheduler._proxyCooldownUntil(group, 2), until)
    t.mock.timers.tick(1)
    assert.equal(scheduler._proxyCooldownUntil(group, 2), 0)
})

test('forced Request run, Urgent and warmup cannot bypass proxy rest; unrelated groups retain their slots', t => {
    const { scheduler, group } = fixture(t)
    scheduler._recordProxyCooldown({ accountIndex: 1, networkGroup: group })
    const started = []
    scheduler._start = job => started.push(job.accountIndex)
    for (const type of ['warmup', 'search', 'accountSession']) {
        scheduler.queue = [
            {
                id: 'blocked',
                accountIndex: 2,
                networkGroup: group,
                type,
                urgent: true,
                dueAt: new Date().toISOString()
            },
            { id: 'free', accountIndex: 3, networkGroup: 'DIRECT', type: 'warmup', dueAt: new Date().toISOString() }
        ]
        scheduler._drain(true)
    }
    assert.deepEqual(started, [3, 3, 3])
})

test('process exit records rest before completion can dispatch the next account, even after PID was cleared', t => {
    const { scheduler, group } = fixture(t)
    const job = { id: 'session', type: 'accountSession', accountIndex: 1, networkGroup: group }
    scheduler.running.set(job.id, { job })
    let completed = false
    scheduler._finishAccountSession = () => {
        completed = true
        assert.ok(scheduler._proxyCooldownUntil(group, 2) > Date.now())
    }
    scheduler._finish({ job, manager: { pid: null }, spawned: true }, { code: 0 })
    assert.equal(completed, true)
    delete scheduler.document.state.accounts[1].proxyCooldown
    scheduler._finishAccountSession = () => {}
    scheduler._finish({ job, manager: { pid: null } }, { code: null, error: 'spawn failed' })
    assert.equal(scheduler._proxyCooldownUntil(group, 2), 0)
})
