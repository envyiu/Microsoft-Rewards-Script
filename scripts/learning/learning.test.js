import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { LearningStore, learningConfig, learningPayload, learningIdentity } from '../../packages/contracts/learning.js'
import { LearningCollector } from './collector.js'
import { prepareDataset } from './prepare.js'
const uuid = () => crypto.randomUUID()
function temporary(t) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-test-'))
    t.after(() => fs.rmSync(d, { recursive: true, force: true }))
    return d
}
test('unknown daily limits stay unset and experiments are disabled by default', () => {
    const c = learningConfig({ enabled: true, collectionId: uuid(), identitySecret: 'a'.repeat(64) })
    assert.deepEqual(c.dailySearchCaps, {})
    assert.equal(c.experimentAllowed, false)
    assert.equal(c.experimentRate, 0.1)
})
test('typed projection removes secrets recursively and rejects invalid known data', () => {
    const p = learningPayload('decision', {
        password: 'secret',
        selected: { accountId: 'a'.repeat(64), email: 'private', proxy: 'private' },
        candidates: [{ type: 'search', password: 'x' }]
    })
    assert.equal(JSON.stringify(p).includes('private'), false)
    assert.equal(JSON.stringify(p).includes('password'), false)
    assert.throws(() => learningPayload('query', { phase: 'query text' }))
    assert.notEqual(learningIdentity('secret', 'account', 'x'), learningIdentity('secret', 'ip', 'x'))
})
test('offline replay is idempotent; invalid batches roll back without advancing cursor', t => {
    const root = temporary(t),
        source = uuid(),
        collection = uuid(),
        a = new LearningStore(path.join(root, 'a'), { nodeId: source }),
        b = new LearningStore(path.join(root, 'b'), { central: true })
    t.after(() => {
        a.close()
        b.close()
    })
    a.append(collection, 'health', { enabled: true })
    const batch = a.page(collection)
    assert.equal(b.ingest(collection, source, batch), 1)
    assert.equal(b.ingest(collection, source, batch), 1)
    assert.equal(b.stats()[0].count, 1)
    assert.throws(() =>
        b.ingest(collection, source, [
            { ...batch[0], seq: 2 },
            { ...batch[0], seq: 3, version: 99 }
        ])
    )
    assert.equal(b.get('cursor:' + collection + ':' + source), 1)
    assert.throws(() => a.ack(collection, 2))
    a.ack(collection, 1)
})
test('retention never discards unacknowledged offline events', t => {
    const s = new LearningStore(temporary(t), { nodeId: uuid() }),
        c = uuid()
    t.after(() => s.close())
    s.append(c, 'health', { enabled: true }, { at: '2025-01-01T00:00:00.000Z' })
    s.prune()
    assert.equal(s.stats()[0].count, 1)
    s.ack(c, 1)
    s.prune()
    assert.equal(s.stats().length, 0)
})
test('unknown search caps prevent search budget experimentation after baseline', t => {
    const c = new LearningCollector({
        directory: temporary(t),
        nodeId: uuid(),
        config: {
            enabled: true,
            collectionId: uuid(),
            identitySecret: 'b'.repeat(64),
            startedAt: new Date(Date.now() - 10 * 86400000).toISOString(),
            experimentAllowed: true
        }
    })
    t.after(() => c.close())
    c.descriptor = () => ({ quotaKnown: true, deadlineMinutes: 500, usedQueries: 0 })
    const job = { type: 'search', platform: 'desktop', searchBudget: 10, accountIndex: 1 }
    const scheduler = { document: { state: { accounts: { 1: {} } } } }
    assert.equal(c.experiment(scheduler, job, () => 0).arm, 'control')
})
test('dataset separates time windows, censors interrupted jobs and never imputes unknown points', () => {
    const epoch = '2026-01-01T00:00:00.000Z',
        rows = []
    let id = 0
    for (const day of [1, 22, 29]) {
        const at = new Date(Date.parse(epoch) + (day - 1) * 86400000).toISOString(),
            decisionId = uuid(),
            attemptId = uuid()
        for (const [kind, data] of [
            ['decision', { decisionId, selected: { type: 'search' } }],
            ['attempt_start', { decisionId, attemptId }],
            [
                'attempt_end',
                { attemptId, success: true, interrupted: day === 22, durationMs: 100, points: 0, quotaKnown: false }
            ]
        ])
            rows.push({ id: ++id, kind, observedAt: at, data })
    }
    const result = prepareDataset(rows, epoch, '2026-03-01T00:00:00.000Z')
    assert.deepEqual(
        result.attempts.map(a => a.split),
        ['train', 'validation', 'test']
    )
    assert.equal(result.attempts[1].labels.success, null)
    assert.equal(result.attempts[0].labels.points, null)
    assert.equal(result.attempts[0].features.durationMs, undefined)
})
test('learning records queries without imposing a separate business cap', async t => {
    const { learningQuery } = await import('../../dist/util/Learning.js'),
        dir = temporary(t),
        store = new LearningStore(dir, { nodeId: uuid() })
    t.after(() => store.close())
    const keys = ['MRS_LEARNING_LEDGER', 'MRS_LEARNING_ACCOUNT', 'MRS_LEARNING_CAPS', 'MRS_LEARNING_TIMEZONE'],
        old = Object.fromEntries(keys.map(k => [k, process.env[k]]))
    t.after(() => {
        for (const k of keys)
            if (old[k] === undefined) delete process.env[k]
            else process.env[k] = old[k]
    })
    Object.assign(process.env, {
        MRS_LEARNING_LEDGER: path.join(dir, 'learning.sqlite'),
        MRS_LEARNING_ACCOUNT: 'a'.repeat(64),
        MRS_LEARNING_CAPS: '{"desktop":2}',
        MRS_LEARNING_TIMEZONE: 'UTC'
    })
    let sent = 0
    await learningQuery('normal', false, async () => {
        sent++
    })
    await assert.rejects(() =>
        learningQuery('normal', false, async () => {
            sent++
            throw Error('uncertain send')
        })
    )
    await learningQuery('normal', false, async () => {
        sent++
    })
    assert.equal(sent, 3)
    process.env.MRS_LEARNING_CAPS = '{}'
    await learningQuery('normal', false, async () => {
        sent++
    })
    assert.equal(sent, 4)
    assert.equal(store.db.prepare('SELECT used FROM query_budget').get().used, 4)
})
test('process sampling includes browser descendants and distinguishes inaccessible PSS', async t => {
    const { processResources } = await import('./collector.js'),
        proc = temporary(t)
    const make = (pid, parent, group, pss) => {
        const d = path.join(proc, String(pid))
        fs.mkdirSync(d)
        const stat = Array(30).fill('0')
        stat[0] = 'S'
        stat[1] = String(parent)
        stat[2] = String(group)
        stat[11] = '100'
        stat[12] = '50'
        stat[19] = '1234'
        fs.writeFileSync(path.join(d, 'stat'), `${pid} (test process) ${stat.join(' ')}`)
        fs.writeFileSync(path.join(d, 'status'), 'VmRSS: 20 kB\n')
        if (pss !== null) fs.writeFileSync(path.join(d, 'smaps_rollup'), `Rss: 20 kB\nPss: ${pss} kB\n`)
    }
    make(100, 1, 100, 10)
    make(101, 100, 100, 5)
    make(200, 1, 200, 99)
    const id = uuid()
    let [sample] = processResources([{ attemptId: id, pid: 100 }], proc)
    assert.equal(sample.pssBytes, 15 * 1024)
    assert.equal(sample.rssBytes, 40 * 1024)
    assert.equal(sample.alive, true)
    fs.rmSync(path.join(proc, '101', 'smaps_rollup'))
    ;[sample] = processResources([{ attemptId: id, pid: 100 }], proc)
    assert.equal(sample.pssBytes, null)
})
test('restart produces censored outcome and replays typed outbox only once', t => {
    const directory = temporary(t),
        nodeId = uuid(),
        collectionId = uuid(),
        config = { enabled: true, collectionId, identitySecret: 'c'.repeat(64) },
        attemptId = uuid(),
        eventId = uuid()
    const a = new LearningCollector({ directory, nodeId, config })
    a.store.set('openAttempts', [{ attemptId, accountId: 'a'.repeat(64), type: 'search' }])
    fs.writeFileSync(
        path.join(a.outbox, attemptId + '.jsonl'),
        JSON.stringify({
            eventId,
            kind: 'query',
            observedAt: new Date().toISOString(),
            data: { queryId: uuid(), kind: 'normal', platform: 'desktop', phase: 'intent' }
        }) + '\n'
    )
    a.close()
    const b = new LearningCollector({ directory, nodeId, config })
    const end = b.store.rows({ kind: 'attempt_end' })[0]
    assert.equal(end.data.interrupted, true)
    assert.equal(end.data.success, undefined)
    assert.equal(b.store.rows({ kind: 'query' }).length, 1)
    b.close()
    const c = new LearningCollector({ directory, nodeId, config })
    assert.equal(c.store.rows({ kind: 'attempt_end' }).length, 1)
    c.close()
})
test('resource features use only measurements observed before the decision', () => {
    const decisionId = uuid(),
        attemptId = uuid(),
        at = n => `2026-01-01T00:00:0${n}.000Z`,
        records = [
            { id: 1, kind: 'resource', observedAt: at(0), data: { memoryAvailable: 100 } },
            { id: 2, kind: 'decision', observedAt: at(1), data: { decisionId } },
            { id: 3, kind: 'attempt_start', observedAt: at(2), data: { decisionId, attemptId } },
            { id: 4, kind: 'resource', observedAt: at(3), data: { memoryAvailable: 999 } },
            { id: 5, kind: 'attempt_end', observedAt: at(4), data: { attemptId, durationMs: 2000, success: true } }
        ]
    const result = prepareDataset(records, at(0), '2026-01-02T00:00:00.000Z')
    assert.equal(result.attempts[0].features.machine.data.memoryAvailable, 100)
    assert.deepEqual(result.attempts[0].features.recentOutcomes, [])
})
