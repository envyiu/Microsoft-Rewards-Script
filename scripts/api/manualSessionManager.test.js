import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ManualSessionManager, resolveManualBrowserEnvironment } from './manualSessionManager.js'

test('manual browser discovers the current user Wayland socket without inherited display variables', async () => {
    const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-wayland-'))
    const socketPath = path.join(runtimeDirectory, 'wayland-test')
    const server = net.createServer()
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject)
            server.listen(socketPath, resolve)
        })
        assert.deepEqual(
            resolveManualBrowserEnvironment({
                platform: 'linux',
                environment: {},
                uid: 1000,
                runtimeDirectories: [runtimeDirectory]
            }),
            { XDG_RUNTIME_DIR: runtimeDirectory, WAYLAND_DISPLAY: 'wayland-test' }
        )
    } finally {
        await new Promise(resolve => server.close(resolve))
        fs.rmSync(runtimeDirectory, { recursive: true, force: true })
    }
})

test('manual sessions validate input, open duplicate windows, and release the account after exit', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-manual-session-'))
    const scriptDir = path.join(projectRoot, 'scripts', 'main')
    fs.mkdirSync(scriptDir, { recursive: true })
    fs.writeFileSync(
        path.join(scriptDir, 'browserSession.js'),
        "process.on('SIGUSR2', () => { console.log('Manual browser checkpoint complete'); process.exit(0) })\nconsole.log('[SUCCESS] Manual browser ready')\nsetInterval(() => {}, 1000)\n"
    )

    const accountStates = []
    const manager = new ManualSessionManager({
        projectRoot,
        stopTimeoutMs: 500,
        startupTimeoutMs: 1000,
        onAccountChange: (accountIndex, active) => accountStates.push([accountIndex, active])
    })

    try {
        assert.throws(
            () => manager.open({ accountIndex: 0, email: 'test@example.test', platform: 'desktop' }),
            /positive integer/
        )
        assert.throws(
            () => manager.open({ accountIndex: 1, email: 'test@example.test', platform: 'tablet' }),
            /desktop or mobile/
        )

        await manager.open({ accountIndex: 1, email: 'test@example.test', platform: 'desktop' })
        await manager.open({ accountIndex: 1, email: 'test@example.test', platform: 'mobile' })
        await Promise.all([
            manager.open({ accountIndex: 1, email: 'test@example.test', platform: 'desktop' }),
            manager.open({ accountIndex: 1, email: 'test@example.test', platform: 'desktop' })
        ])
        assert.equal(manager.list().length, 4)
        assert.equal(manager.hasAccount(1), true)

        assert.equal(await manager.closeForAccount({ accountIndex: 1, platform: 'desktop' }), 3)
        assert.equal(manager.list().length, 1)
        assert.equal(manager.list()[0].platform, 'mobile')
        assert.equal(manager.hasAccount(1), true)

        await manager.stopAll({ force: true })
        assert.equal(manager.list().length, 0)
        assert.deepEqual(accountStates.at(-1), [1, false])
    } finally {
        await manager.stopAll({ force: true })
        fs.rmSync(projectRoot, { recursive: true, force: true })
    }
})

test('manual session reports a startup failure instead of returning an optimistic success', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-manual-session-failure-'))
    const scriptDir = path.join(projectRoot, 'scripts', 'main')
    fs.mkdirSync(scriptDir, { recursive: true })
    fs.writeFileSync(
        path.join(scriptDir, 'browserSession.js'),
        "console.error('DISPLAY is not set')\nprocess.exit(1)\n"
    )

    const logs = []
    const manager = new ManualSessionManager({
        projectRoot,
        startupTimeoutMs: 1000,
        stopTimeoutMs: 500,
        onLog: entry => logs.push(entry)
    })
    try {
        await assert.rejects(
            manager.open({ accountIndex: 1, email: 'test@example.test', platform: 'desktop' }),
            error => error.code === 'START_FAILED' && /exited before it was ready/.test(error.message)
        )
        assert.equal(manager.list().length, 0)
        assert.ok(logs.some(entry => entry.raw === 'DISPLAY is not set'))
    } finally {
        await manager.stopAll({ force: true })
        fs.rmSync(projectRoot, { recursive: true, force: true })
    }
})
