import fs from 'node:fs'

export type RuntimeEventType =
    | 'quotaSnapshot'
    | 'quotaDeferred'
    | 'searchStart'
    | 'searchProgress'
    | 'streakSnapshot'
    | 'sessionFailure'
    | 'workerStart'
    | 'workerEnd'
    | 'earnScan'
    | 'appAuthorization'
    | 'warmupCheckpoint'
    | 'botWarning'
    | 'authPhase'

export interface RuntimeEventMessage<T = Record<string, unknown>> {
    type: 'MSRW_EVENT'
    event: RuntimeEventType
    payload: T
    at: string
}

type Listener = (msg: RuntimeEventMessage) => void
const listeners = new Set<Listener>()

export function onRuntimeEvent(listener: Listener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

export function emitRuntimeEvent<T extends Record<string, unknown>>(event: RuntimeEventType, payload: T): void {
    const msg: RuntimeEventMessage<T> = {
        type: 'MSRW_EVENT',
        event,
        payload,
        at: new Date().toISOString()
    }
    for (const listener of listeners) {
        try {
            listener(msg)
        } catch {}
    }
    if (typeof process.send === 'function' && process.connected) {
        try {
            process.send(msg)
        } catch {}
    }
    const journal = process.env.MRS_RUNTIME_EVENT_JOURNAL
    if (journal) {
        try {
            fs.appendFileSync(journal, JSON.stringify(msg) + '\n', { mode: 0o600 })
        } catch {}
    }
}
