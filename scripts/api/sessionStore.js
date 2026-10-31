import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function resolveSessionDb(projectRoot, sessionPath) {
    const candidates = [
        path.resolve(process.cwd(), sessionPath, 'sessions.db'),
        path.join(projectRoot, sessionPath, 'sessions.db'),
        path.join(projectRoot, 'dist', sessionPath, 'sessions.db'),
        path.join(projectRoot, 'src', sessionPath, 'sessions.db')
    ]
    const dbPath = candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0]
    return { dbPath, exists: fs.existsSync(dbPath) }
}

// Internal node-to-node transport only. Never expose these records on /sessions.
export function exportAccountSession(projectRoot, sessionPath, email) {
    const { dbPath, exists } = resolveSessionDb(projectRoot, sessionPath)
    if (!exists) return { sessions: [], metadata: null }
    const db = openDatabase(dbPath, true)
    try {
        const sessions = db.prepare('SELECT * FROM sessions WHERE email = ?').all(email)
        let metadata = null
        try {
            metadata = db.prepare('SELECT * FROM account_metadata WHERE email = ?').get(email) ?? null
        } catch {}
        return { sessions, metadata }
    } finally {
        closeDatabase(db)
    }
}

export function validateAccountSession(email, bundle) {
    if (!Array.isArray(bundle?.sessions) || bundle.sessions.length > 2) throw new Error('Invalid session bundle')
    for (const row of bundle.sessions) {
        if (row.email !== email || !['desktop', 'mobile'].includes(row.platform))
            throw new Error('Invalid session identity')
        for (const field of ['storage_state', 'fingerprint']) {
            if (row[field] != null) JSON.parse(row[field])
        }
    }
    if (bundle.metadata && bundle.metadata.email !== email) throw new Error('Invalid metadata identity')
}

export function importAccountSession(projectRoot, sessionPath, email, bundle) {
    validateAccountSession(email, bundle)
    const { dbPath } = resolveSessionDb(projectRoot, sessionPath)
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 })
    const db = openDatabase(dbPath, false)
    try {
        fs.chmodSync(dbPath, 0o600)
        db.exec(`CREATE TABLE IF NOT EXISTS sessions (email TEXT NOT NULL, platform TEXT NOT NULL,
            storage_state TEXT, fingerprint TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(email,platform));
            CREATE TABLE IF NOT EXISTS account_metadata (email TEXT PRIMARY KEY COLLATE NOCASE,
            resolved_region TEXT, updated_at INTEGER NOT NULL); BEGIN IMMEDIATE`)
        db.prepare('DELETE FROM sessions WHERE email = ?').run(email)
        const insert = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)')
        for (const row of bundle.sessions)
            insert.run(email, row.platform, row.storage_state, row.fingerprint, row.updated_at)
        db.prepare('DELETE FROM account_metadata WHERE email = ?').run(email)
        if (bundle.metadata)
            db.prepare('INSERT INTO account_metadata VALUES (?, ?, ?)').run(
                email,
                bundle.metadata.resolved_region,
                bundle.metadata.updated_at
            )
        db.exec('COMMIT')
    } catch (error) {
        try {
            db.exec('ROLLBACK')
        } catch {}
        throw error
    } finally {
        closeDatabase(db)
    }
}

function openDatabase(dbPath, readOnly) {
    const db = new DatabaseSync(dbPath, { readOnly })
    db.exec('PRAGMA busy_timeout = 5000')
    return db
}

function closeDatabase(db) {
    try {
        db.close()
    } catch {}
}

function cookieCount(storageState) {
    if (!storageState) return 0
    try {
        const parsed = JSON.parse(storageState)
        return Array.isArray(parsed?.cookies) ? parsed.cookies.length : 0
    } catch {
        return null
    }
}

function toSession(row) {
    const updatedAt = Number(row.updated_at)
    const updatedDate = new Date(updatedAt)
    return {
        email: row.email,
        platform: row.platform,
        updatedAt:
            Number.isFinite(updatedAt) && !Number.isNaN(updatedDate.getTime()) ? updatedDate.toISOString() : null,
        hasStorageState: Boolean(row.storage_state),
        hasFingerprint: Boolean(row.fingerprint),
        cookieCount: cookieCount(row.storage_state)
    }
}

export function listStoredSessions(projectRoot, sessionPath) {
    const { dbPath, exists } = resolveSessionDb(projectRoot, sessionPath)
    if (!exists) {
        return { databaseExists: false, sessions: [], count: 0, accounts: 0 }
    }

    const db = openDatabase(dbPath, true)
    try {
        const rows = db
            .prepare(
                `SELECT email, platform, storage_state, fingerprint, updated_at
                 FROM sessions
                 ORDER BY LOWER(email), platform`
            )
            .all()
        return {
            databaseExists: true,
            sessions: rows.map(toSession),
            count: rows.length,
            accounts: new Set(rows.map(row => row.email.toLowerCase())).size
        }
    } finally {
        closeDatabase(db)
    }
}

export function deleteStoredSessions(projectRoot, sessionPath, email) {
    const { dbPath, exists } = resolveSessionDb(projectRoot, sessionPath)
    if (!exists) return { found: false, removed: 0, email, platforms: [] }

    const db = openDatabase(dbPath, false)
    try {
        const matches = db
            .prepare('SELECT email, platform FROM sessions WHERE LOWER(email) = LOWER(?) ORDER BY platform')
            .all(email)

        if (!matches.length) return { found: false, removed: 0, email, platforms: [] }

        const result = db.prepare('DELETE FROM sessions WHERE LOWER(email) = LOWER(?)').run(email)
        try {
            db.prepare('DELETE FROM account_metadata WHERE LOWER(email) = LOWER(?)').run(email)
        } catch {}
        try {
            db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        } catch {}

        return {
            found: true,
            removed: Number(result.changes ?? 0),
            email: matches[0].email,
            platforms: [...new Set(matches.map(row => row.platform))]
        }
    } finally {
        closeDatabase(db)
    }
}
