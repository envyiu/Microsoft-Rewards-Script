import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { WorkerUpdater } from './update.js'
import { executeUpdate } from './updateRunner.js'
import { workerFixture } from './fixture.js'
import release from '../../common/workerRelease.cjs'
const id = '11111111-1111-4111-8111-111111111111',
    nodeId = '22222222-2222-4222-8222-222222222222'
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-update-')),
        data = path.join(root, 'data'),
        old = path.join(root, 'releases/old'),
        u = path.join(root, 'updater')
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    for (const p of [data, old, u]) fs.mkdirSync(p, { recursive: true })
    fs.symlinkSync(old, path.join(root, 'current'))
    fs.writeFileSync(path.join(u, 'runner.js'), '')
    fs.writeFileSync(path.join(data, 'worker.env'), 'API_TOKEN="synthetic-token"\n')
    const config = { schema: 1, root, data, kind: 'local', platform: 'linux', node: process.execPath, testDelay: 0 }
    release.atomicJson(path.join(u, 'config.json'), config)
    const updater = new WorkerUpdater({ data, code: old, environment: { MRS_WORKER_ROOT: root } })
    return { root, data, old, config, updater }
}
function archive(f) {
    const src = path.join(f.root, 'source')
    fs.mkdirSync(src)
    const pkg = Buffer.from('{"version":"4.3.3"}')
    fs.writeFileSync(path.join(src, 'package.json'), pkg)
    const m = {
        product: 'msrw-worker',
        version: '4.3.3',
        protocolVersion: 3,
        builtAt: new Date().toISOString(),
        files: { 'package.json': release.hash(pkg) }
    }
    m.releaseId = release.hash(JSON.stringify(m))
    fs.writeFileSync(path.join(src, 'release.json'), JSON.stringify(m))
    const file = path.join(f.root, 'archive.tgz')
    execFileSync('tar', ['--format=gnu', '-czf', file, '-C', src, '.'])
    const bytes = fs.readFileSync(file)
    const body = {
        id,
        nodeId,
        version: m.version,
        sha256: release.hash(bytes),
        releaseId: m.releaseId,
        size: bytes.length
    }
    return { bytes, body }
}
test('durable maintenance, chunk replay, checksum rejection and process-start release identity', async t => {
    const f = fixture(t),
        { body, bytes } = archive(f)
    f.updater.begin(body)
    assert.equal(f.updater.maintenance, true)
    const restart = new WorkerUpdater({ data: f.data, code: f.old, environment: { MRS_WORKER_ROOT: f.root } })
    assert.equal(restart.maintenance, true)
    restart.chunk({ id, offset: 0, data: bytes.toString('base64') })
    restart.chunk({ id, offset: 0, data: bytes.toString('base64') })
    assert.equal(restart.read().received, bytes.length)
    assert.throws(() => restart.begin({ ...body, sha256: '0'.repeat(64) }), /CONFLICT/)
    fs.writeFileSync(path.join(f.data, 'updater', id + '.tgz'), 'corrupt')
    await assert.rejects(() => restart.commit(id), /CHECKSUM/)
    assert.throws(() => restart.finish(id), /NOT_VERIFIED/)
})
for (const failure of [false, 'missing-browser', 'health'])
    test(`installer ${failure || 'success'} preserves data and ${failure ? 'rolls back' : 'verifies the new process'}`, async t => {
        const f = fixture(t),
            { body, bytes } = archive(f)
        f.updater.begin(body)
        f.updater.chunk({ id, offset: 0, data: bytes.toString('base64') })
        f.updater.write({ ...f.updater.read(), phase: 'installing' })
        fs.writeFileSync(path.join(f.data, 'sessions.db'), 'synthetic session')
        const services = []
        const health = async () => {
            const current = fs.realpathSync(path.join(f.root, 'current')),
                isNew = current !== f.old
            return {
                nodeId,
                smart: { running: [] },
                updater: { maintenance: true },
                release: isNew && failure !== 'health' ? { ...body, verified: true } : null
            }
        }
        const result = await executeUpdate(f.config, id, {
            command: async (_cmd, args) => services.push(args),
            health,
            prepare: async () => {
                if (failure === 'missing-browser') throw Error('BROWSER_MISSING')
            }
        })
        assert.equal(result.phase, failure ? 'failed' : 'ready')
        assert.equal(fs.readFileSync(path.join(f.data, 'sessions.db'), 'utf8'), 'synthetic session')
        if (failure) assert.equal(fs.realpathSync(path.join(f.root, 'current')), f.old)
        else {
            assert.notEqual(fs.realpathSync(path.join(f.root, 'current')), f.old)
            const fresh = new WorkerUpdater({
                data: f.data,
                code: fs.realpathSync(path.join(f.root, 'current')),
                installHelper: () => {},
                environment: { MRS_WORKER_ROOT: f.root }
            })
            fresh.finish(id)
            assert.equal(fresh.maintenance, false)
        }
    })
test('authenticated maintenance blocks dispatch and manual opening but permits closing', async t => {
    const w = await workerFixture(t, { kind: 'local' })
    const configDir = path.join(w.directory, 'updater')
    fs.mkdirSync(configDir)
    fs.writeFileSync(path.join(configDir, 'runner.js'), '')
    release.atomicJson(path.join(configDir, 'config.json'), { schema: 1, root: w.directory, data: w.data })
    await w.restart()
    const status = (await w.request('/internal/hybrid/status')).data
    assert.equal(status.release.version, null)
    assert.equal(status.updater.supported, true)
    const body = {
        id,
        nodeId: status.nodeId,
        version: '4.3.3',
        sha256: 'a'.repeat(64),
        releaseId: 'b'.repeat(64),
        size: 10
    }
    assert.equal((await w.request('/internal/update/begin', 'POST', body, false)).status, 401)
    assert.equal((await w.request('/internal/update/begin', 'POST', body)).status, 200)
    assert.equal(
        (await w.request('/manual-sessions', 'POST', { accountIndex: 1, platform: 'desktop' })).data.code,
        'UPDATE_IN_PROGRESS'
    )
    assert.equal(
        (await w.request('/internal/hybrid/control', 'POST', { route: '/start' })).data.code,
        'UPDATE_IN_PROGRESS'
    )
    await w.restart()
    assert.equal((await w.request('/internal/hybrid/status')).data.updater.maintenance, true)
})

test('unsafe archives cannot extract links outside the staged release', t => {
    const f = fixture(t),
        src = path.join(f.root, 'unsafe')
    fs.mkdirSync(src)
    fs.symlinkSync('/tmp', path.join(src, 'escape'))
    const file = path.join(f.root, 'unsafe.tgz')
    execFileSync('tar', ['--format=gnu', '-czf', file, '-C', src, '.'])
    assert.throws(
        () => release.extractArchive(file, path.join(f.root, 'unpacked'), release.hash(fs.readFileSync(file))),
        /UNSAFE_ARCHIVE_ENTRY/
    )
    assert.equal(fs.existsSync(path.join(f.root, 'unpacked')), false)
})
test('rollback failure is explicit and never clears maintenance', async t => {
    const f = fixture(t),
        { body, bytes } = archive(f)
    f.updater.begin(body)
    f.updater.chunk({ id, offset: 0, data: bytes.toString('base64') })
    f.updater.write({ ...f.updater.read(), phase: 'installing' })
    const result = await executeUpdate(f.config, id, {
        health: async () => ({ nodeId, updater: { maintenance: true }, smart: { running: [] } }),
        prepare: async () => {
            throw Error('BROWSER_MISSING')
        },
        command: async () => {
            throw Error('SERVICE_FAILED')
        }
    })
    assert.equal(result.phase, 'rollback_failed')
    assert.equal(result.error, 'ROLLBACK_FAILED')
    assert.equal(f.updater.maintenance, true)
})
