import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { requestSaveAndClose } from './manualSessionClose.js'
import { MANUAL_SESSION_SAVED, MANUAL_SESSION_SAVE_FAILED } from '../main/browserSessionCheckpoint.js'

function fakeManager(onSignal) {
    const manager = new EventEmitter()
    manager.child = {
        kill: signal => {
            onSignal(manager, signal)
            return true
        }
    }
    return manager
}

test('close succeeds only after save acknowledgment and a clean process exit', async () => {
    const manager = fakeManager((emitter, signal) => {
        assert.equal(signal, 'SIGUSR2')
        emitter.emit('log', { raw: MANUAL_SESSION_SAVED })
        emitter.emit('exit', { code: 0, signal: null })
    })
    await requestSaveAndClose(manager, 100)
    assert.equal(manager.listenerCount('exit'), 0)
    assert.equal(manager.listenerCount('log'), 0)
})

test('a killed browser or clean exit without a save is reported as failure', async () => {
    for (const exit of [
        { code: null, signal: 'SIGKILL' },
        { code: 0, signal: null }
    ]) {
        const manager = fakeManager(emitter => emitter.emit('exit', exit))
        await assert.rejects(requestSaveAndClose(manager, 100), /without confirming/)
    }
})

test('a write failure is reported and a later close can retry', async () => {
    let attempts = 0
    const manager = fakeManager(emitter => {
        if (++attempts === 1) emitter.emit('log', { raw: MANUAL_SESSION_SAVE_FAILED })
        else {
            emitter.emit('log', { raw: MANUAL_SESSION_SAVED })
            emitter.emit('exit', { code: 0, signal: null })
        }
    })
    await assert.rejects(requestSaveAndClose(manager, 100), /remains open/)
    await requestSaveAndClose(manager, 100)
})

test('a slow save times out without force-killing the browser', async () => {
    const signals = []
    const manager = fakeManager((_emitter, signal) => signals.push(signal))
    await assert.rejects(requestSaveAndClose(manager, 20), /not force-closed/)
    assert.deepEqual(signals, ['SIGUSR2'])
    assert.equal(manager.listenerCount('exit'), 0)
})
