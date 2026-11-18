import test from 'node:test'
import assert from 'node:assert/strict'

async function managerForPlatform(platform) {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    try {
        Object.defineProperty(process, 'platform', { value: platform, configurable: true })
        return (await import(`./processManager.js?stop-test=${platform}`)).ProcessManager
    } finally {
        Object.defineProperty(process, 'platform', descriptor)
    }
}

test('Windows checkpoint Stop terminates the owned tree without attempting an unsupported Unix signal', async () => {
    const ProcessManager = await managerForPlatform('win32')
    const manager = new ProcessManager({ command: 'fixture', stopTimeoutMs: 20 })
    manager.state = 'running'
    manager.pid = 123
    manager.child = {
        kill: () => {
            throw new Error('Unix signal sent to Windows')
        }
    }
    const signals = []
    manager._killTree = signal => {
        signals.push(signal)
        queueMicrotask(() => manager._finalize(null, 'SIGKILL'))
    }
    await manager.stop({ signalTree: false, signal: 'SIGUSR1' })
    assert.deepEqual(signals, ['SIGUSR1'])
    assert.equal(manager.state, 'idle')
    assert.equal(manager._killTimer, null)
})

test('a rejected checkpoint signal still installs fallback termination and leaves Stopping', async () => {
    const ProcessManager = await managerForPlatform('linux')
    const manager = new ProcessManager({ command: 'fixture', stopTimeoutMs: 20 })
    manager.state = 'running'
    manager.pid = 123
    manager.child = {
        kill: () => {
            throw Object.assign(new Error('bad signal'), { code: 'EINVAL' })
        }
    }
    manager._killTree = () => queueMicrotask(() => manager._finalize(null, 'SIGKILL'))
    await manager.stop({ signalTree: false, signal: 'SIGUSR1' })
    assert.equal(manager.state, 'idle')
})

test('checkpoint Stop accepts a matching IPC acknowledgement before exit', async () => {
    const { ProcessManager } = await import('./processManager.js')
    const source = `process.on('message',m=>{if(m.type==='MSRW_CHECKPOINT_STOP')process.send({type:'MSRW_CHECKPOINT_ACK',requestId:m.requestId,saved:true},()=>process.exit(0))});console.log('ready');setInterval(()=>{},1000)`
    const manager = new ProcessManager({
        command: process.execPath,
        args: ['-e', source],
        checkpointIPC: true,
        stopTimeoutMs: 2000
    })
    manager.start()
    await new Promise(resolve => manager.child.stdout.once('data', resolve))
    const exit = await manager.stop({ signalTree: false, signal: 'SIGUSR1' })
    assert.equal(exit.checkpoint, 'saved')
    assert.equal(exit.code, 0)
})

test('checkpoint Stop never accepts a mismatched acknowledgement and reports forced termination', async () => {
    const { ProcessManager } = await import('./processManager.js')
    const source = `process.on('SIGUSR1',()=>{});process.on('message',()=>process.send({type:'MSRW_CHECKPOINT_ACK',requestId:'different',saved:true}));console.log('ready');setInterval(()=>{},1000)`
    const manager = new ProcessManager({
        command: process.execPath,
        args: ['-e', source],
        checkpointIPC: true,
        stopTimeoutMs: 300
    })
    manager.start()
    await new Promise(resolve => manager.child.stdout.once('data', resolve))
    const exit = await manager.stop({ signalTree: false, signal: 'SIGUSR1' })
    assert.equal(exit.checkpoint, 'forced')
    assert.equal(exit.signal, 'SIGKILL')
})
