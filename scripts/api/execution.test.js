import assert from 'node:assert/strict'
import test from 'node:test'
import { accountExecutions, runtimeFresh } from './execution.js'
const now = Date.parse('2026-10-26T01:00:00Z')
const account = { index: 23, email: 'one@example.test' }
const job = {
    id: 'repeatable-plan',
    executionId: 'unique-execution',
    accountIndex: 23,
    email: account.email,
    nodeId: 'vps-1',
    state: 'running',
    phase: 'login',
    pid: 123
}
const metadata = () => ({ nodeId: 'vps-1', node: 'vps' })
function snapshot(online = true, observedAt = new Date(now).toISOString()) {
    return { running: [job], accounts: {}, hybrid: { nodes: [{ id: 'vps-1', online, observedAt }] } }
}
test('login is running only with a fresh confirmed runtime; stale and offline become unknown', () => {
    assert.equal(accountExecutions([account], snapshot(), {}, metadata, now)[23].state, 'running')
    assert.equal(accountExecutions([account], snapshot(), {}, metadata, now)[23].jobId, job.executionId)
    for (const s of [snapshot(false), snapshot(true, new Date(now - 15001).toISOString())])
        assert.equal(accountExecutions([account], s, {}, metadata, now)[23].state, 'unknown')
    assert.equal(runtimeFresh({ online: true, observedAt: 'invalid' }, now), false)
})
test('exit and account identity changes cannot preserve a running badge, even without terminal logs', () => {
    const s = snapshot()
    s.running = []
    assert.equal(accountExecutions([account], s, {}, metadata, now)[23].state, 'idle')
    assert.equal(
        accountExecutions([{ ...account, email: 'replacement@example.test' }], snapshot(), {}, metadata, now)[23].state,
        'idle'
    )
    assert.deepEqual(accountExecutions([], snapshot(), {}, metadata, now), {})
})
test('legacy activity needs a live process and the current account, not historical run records', () => {
    const smart = { running: [], accounts: {} }
    const legacy = {
        alive: true,
        pid: 123,
        state: 'running',
        startedAt: 'start',
        run: { live: { currentAccount: account.email }, accounts: [{ email: 'other@example.test' }] }
    }
    assert.equal(accountExecutions([account], smart, legacy, undefined, now)[23].state, 'running')
    assert.equal(accountExecutions([account], smart, { ...legacy, alive: false }, undefined, now)[23].state, 'idle')
    assert.equal(
        accountExecutions([{ ...account, email: 'other@example.test' }], smart, legacy, undefined, now)[23].state,
        'idle'
    )
})
