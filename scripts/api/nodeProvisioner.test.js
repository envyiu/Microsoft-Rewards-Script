import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { NodeProvisioner } from './nodeProvisioner.js'

function mock(t, failInstall = false) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-install-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    fs.mkdirSync(path.join(root, '.ssh'))
    fs.writeFileSync(path.join(root, '.ssh/id_ed25519'), 'synthetic-key')
    fs.writeFileSync(path.join(root, '.ssh/id_ed25519.pub'), 'synthetic-public')
    fs.mkdirSync(path.join(root, 'dist'))
    fs.writeFileSync(path.join(root, 'dist/index.js'), '')
    const calls = []
    const fleet = {
        root,
        store: { directory: path.join(root, 'data'), nodeId: 'coordinator' },
        registry: { nodes: [] },
        operations: [],
        saveOperations() {},
        save() {},
        sync: async () => {}
    }
    const provisioner = new NodeProvisioner(fleet, {
        home: root,
        upload: async () => {
            calls.push(['upload'])
        },
        fetcher: async () => ({
            ok: true,
            json: async () => ({ protocolVersion: 2, nodeId: '00000000-0000-0000-0000-000000000099' })
        }),
        runCommand: async (binary, args, options = {}) => {
            calls.push([binary, args, options])
            if (binary === 'ssh-keyscan') return 'synthetic-host-key'
            if (binary === 'ssh-keygen') return '256 SHA256:fixture-host worker (ED25519)'
            if (binary === 'ssh' && args.at(-1) === 'python3 -') return JSON.stringify({ home: '/home/tool' })
            if (binary === 'ssh' && args.at(-1) === 'bash -s' && failInstall)
                throw Object.assign(new Error('private installer stderr'), { code: 'SSH_STEP_FAILED' })
            return ''
        }
    })
    return { fleet, calls, provisioner }
}
async function done(p, op) {
    for (let i = 0; i < 100; i++) {
        if (!p.active.has(op.id)) return
        await new Promise(r => setTimeout(r, 10))
    }
    throw new Error('Installer did not finish')
}

test('SSH enrollment requires exact fingerprint trust, pins the key, installs matching code and registers a paused empty node', async t => {
    const { fleet, calls, provisioner: p } = mock(t)
    const op = await p.add({ name: 'VPS 2', host: '203.0.113.10', user: 'tool' })
    await done(p, op)
    assert.equal(op.phase, 'trust')
    assert.equal(fleet.registry.nodes.length, 0)
    assert.ok(!calls.some(c => c[0] === 'ssh'))
    await assert.rejects(p.resume(op, 'trust', { fingerprint: 'SHA256:wrong' }))
    await p.resume(op, 'trust', { fingerprint: op.hostFingerprint })
    await done(p, op)
    assert.equal(op.phase, 'done')
    assert.equal(fleet.registry.nodes.length, 1)
    assert.equal(fleet.registry.nodes[0].overrides.schedule.enabled, false)
    assert.equal(fleet.registry.nodes[0].overrides.schedule.maxParallel, 1)
    const install = calls.find(c => c[0] === 'ssh' && c[1].at(-1) === 'bash -s')[2].input
    assert.match(install, /sha256sum -c/)
    const encoded = /base64\.b64decode\('([^']+)'\)/.exec(install)[1]
    assert.match(JSON.parse(Buffer.from(encoded, 'base64').toString()).unit, /KillMode=control-group/)
    assert.match(install, /worker-ready/)
    const tar = calls.find(c => c[0] === 'tar')[1]
    assert.ok(tar.includes('--exclude=.env'))
    assert.ok(tar.includes('--exclude=config.json'))
    assert.ok(tar.includes('--exclude=*.db'))
    const ssh = calls.find(c => c[0] === 'ssh')[1]
    assert.ok(ssh.includes('StrictHostKeyChecking=yes'))
    assert.ok(ssh.includes('BatchMode=yes'))
    await assert.rejects(p.add({ name: 'duplicate', host: '203.0.113.10', user: 'tool' }), { code: 'DUPLICATE_NODE' })
})

test('installer failure remains resumable and never exposes raw transport errors in operation status', async t => {
    const { fleet, provisioner: p } = mock(t, true)
    const op = await p.add({ name: 'VPS 2', host: '203.0.113.10', user: 'tool' })
    await done(p, op)
    await p.resume(op, 'trust', { fingerprint: op.hostFingerprint })
    await done(p, op)
    assert.equal(op.status, 'error')
    assert.equal(op.error, 'SSH_STEP_FAILED')
    assert.equal(fleet.registry.nodes.length, 0)
    assert.ok(!JSON.stringify(op.steps).includes('private installer stderr'))
})

test('SSH values cannot inject commands or choose arbitrary local key paths', async t => {
    const { provisioner: p } = mock(t)
    for (const input of [
        { host: '$(touch /tmp/injected)', user: 'tool' },
        { host: 'host', user: 'root;id' },
        { host: 'host', user: 'tool', port: 0 },
        { host: 'host', user: 'tool', key: '../../id_ed25519' }
    ]) {
        await assert.rejects(p.add({ name: 'bad', ...input }), { code: 'BAD_REQUEST' })
    }
})
