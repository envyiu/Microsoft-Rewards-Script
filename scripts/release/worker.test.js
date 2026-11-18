import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { publishWorker } from './worker.js'
import release from '../../common/workerRelease.cjs'
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-publish-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const files = {
        'dist/index.js': '// fixture',
        'common/fake.cjs': '// fixture',
        'packages/contracts/index.js': '// fixture',
        'scripts/api/server.js': '// fixture',
        'scripts/learning/index.js': '// fixture',
        'scripts/main/index.js': '// fixture',
        'scripts/worker/install.sh': '#!/bin/bash\n',
        'scripts/worker/README.md': 'fixture',
        'scripts/package.json': '{"type":"module"}',
        'scripts/env.js': '',
        'scripts/utils.js': '',
        'config.example.json': '{}',
        'package.json': JSON.stringify({ version: '4.3.2', engines: { node: '>=24.0.0' } }),
        'package-lock.json': JSON.stringify({ version: '4.3.2', packages: { '': { version: '4.3.2' } } }),
        'node_modules/patchright-core/browsers.json': '{"browsers":[{"name":"chromium","revision":"1228"}]}'
    }
    for (const [name, bytes] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
        fs.writeFileSync(path.join(root, name), bytes)
    }
    return root
}
test('publishing increases patch once, preserves immutable artifacts and authenticates extracted contents', t => {
    const directory = fixture(t),
        a = publishWorker({ directory, check: false })
    assert.equal(a.version, '4.3.3')
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json'))).packages[''].version, a.version)
    const digest = release.hash(fs.readFileSync(path.join(a.directory, 'msrw-worker.tgz')))
    const unpacked = path.join(directory, 'unpacked')
    release.extractArchive(path.join(a.directory, 'msrw-worker.tgz'), unpacked, a.sha256)
    const running = release.readRunningRelease(unpacked)
    assert.equal(running.version, a.version)
    assert.equal(running.sha256, a.sha256)
    fs.writeFileSync(path.join(unpacked, 'dist/index.js'), 'changed')
    assert.equal(running.version, a.version)
    assert.equal(release.readRunningRelease(unpacked).verified, false)
    const b = publishWorker({ directory, check: false })
    assert.equal(b.version, '4.3.4')
    assert.equal(release.hash(fs.readFileSync(path.join(a.directory, 'msrw-worker.tgz'))), digest)
    assert.throws(
        () =>
            release.extractArchive(
                path.join(a.directory, 'msrw-worker.tgz'),
                path.join(directory, 'bad'),
                '0'.repeat(64)
            ),
        /CHECKSUM/
    )
})
test('failed publication and collision do not bump package versions', t => {
    const directory = fixture(t)
    fs.mkdirSync(path.join(directory, 'releases/worker/4.3.3'), { recursive: true })
    assert.throws(() => publishWorker({ directory, check: false }), /RELEASE_ALREADY_EXISTS/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'package.json'))).version, '4.3.2')
    assert.equal(fs.existsSync(path.join(directory, 'releases/latest.json')), false)
})
