import fs from 'node:fs'
import path from 'node:path'

import { closeSessionDb, ensureSessionSchema, openSessionDb, saveSessionRow } from '../utils.js'

export function persistBrowserSession(dbPath, email, platform, storageState, fingerprint, persistFingerprint) {
    const sessionDir = path.dirname(dbPath)
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
    try {
        fs.chmodSync(sessionDir, 0o700)
    } catch {}
    const db = openSessionDb(dbPath)
    try {
        ensureSessionSchema(db)
        saveSessionRow(db, email, platform, storageState, fingerprint, persistFingerprint)
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
        closeSessionDb(db)
    }
    try {
        fs.chmodSync(dbPath, 0o600)
    } catch {}
}
