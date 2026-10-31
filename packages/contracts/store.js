import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export function atomicPrivateJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${crypto.randomUUID()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
    fs.renameSync(tmp, file)
}

export class HybridStore {
    constructor(directory) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
        this.directory = directory
        this.db = new DatabaseSync(path.join(directory, 'node.sqlite'))
        fs.chmodSync(path.join(directory, 'node.sqlite'), 0o600)
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
                important INTEGER NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS received (source TEXT PRIMARY KEY, payload TEXT NOT NULL, emitted INTEGER NOT NULL DEFAULT 0);`)
        this.nodeId = this.get('nodeId') ?? crypto.randomUUID()
        this.set('nodeId', this.nodeId)
        this.lastPrune = 0
    }
    get(key) {
        const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)
        return row ? JSON.parse(row.value) : null
    }
    set(key, value) {
        this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, JSON.stringify(value))
    }
    append(entry) {
        const important = [
            'ACCOUNT-END',
            'ACCOUNT-ERROR',
            'ACCOUNT-START',
            'SMART-SEARCH-END',
            'SMART-WORKER-END',
            'REWARDS-STREAK'
        ].includes(entry.title)
        this.db.exec('BEGIN IMMEDIATE')
        try {
            const result = this.db
                .prepare('INSERT INTO events(ts,important,payload) VALUES (?,?,?)')
                .run(Date.now(), Number(important), '{}')
            entry.sourceNode ??= this.nodeId
            entry.sourceEventId ??= Number(result.lastInsertRowid)
            entry.id = Number(result.lastInsertRowid)
            this.db.prepare('UPDATE events SET payload=? WHERE id=?').run(JSON.stringify(entry), result.lastInsertRowid)
            this.db.exec('COMMIT')
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
        if (Date.now() - this.lastPrune > 60_000) {
            this.lastPrune = Date.now()
            this.db
                .prepare('DELETE FROM events WHERE ts < ? AND (important=0 OR ts < ?)')
                .run(Date.now() - 7 * 86400_000, Date.now() - 90 * 86400_000)
            // Bound raw payloads; milestone records retain 90 days independently.
            this.db.exec(`DELETE FROM events WHERE important=0 AND id NOT IN
                (SELECT id FROM events WHERE important=0 ORDER BY id DESC LIMIT 50000)`)
            const bytes = this.db
                .prepare('SELECT COALESCE(SUM(length(payload)),0) AS n FROM events WHERE important=0')
                .get().n
            if (bytes > 128 * 1024 * 1024)
                this.db.exec(`DELETE FROM events WHERE important=0 AND id NOT IN
                (SELECT id FROM events WHERE important=0 ORDER BY id DESC LIMIT 10000)`)
            this.db
                .prepare(
                    'DELETE FROM received WHERE emitted=1 AND rowid NOT IN (SELECT rowid FROM received ORDER BY rowid DESC LIMIT 100000)'
                )
                .run()
        }
        return entry.id
    }
    ingest(entries, cursorKey, cursor) {
        const accepted = []
        this.db.exec('BEGIN IMMEDIATE')
        try {
            for (const entry of entries) {
                if (!entry.sourceNode || !Number.isSafeInteger(entry.sourceEventId)) throw new Error('Invalid event identity')
                const identity = `${entry.sourceNode}:${entry.sourceEventId}`
                const result = this.db.prepare('INSERT OR IGNORE INTO received(source,payload,emitted) VALUES (?,?,1)').run(identity, '{}')
                if (!result.changes) continue
                const important = ['ACCOUNT-END','ACCOUNT-ERROR','ACCOUNT-START','SMART-SEARCH-END','SMART-WORKER-END','REWARDS-STREAK'].includes(entry.title)
                const row = this.db.prepare('INSERT INTO events(ts,important,payload) VALUES (?,?,?)').run(Date.now(), Number(important), '{}')
                const event = { ...entry, id: Number(row.lastInsertRowid) }
                this.db.prepare('UPDATE events SET payload=? WHERE id=?').run(JSON.stringify(event), event.id)
                accepted.push(event)
            }
            this.set(cursorKey, cursor)
            this.db.exec('COMMIT')
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
        return accepted
    }
    prune() {
        const now = Date.now()
        if (now - this.lastPrune < 60000) return
        this.lastPrune = now
        this.db.prepare('DELETE FROM events WHERE ts < ? AND (important=0 OR ts < ?)').run(now - 7*86400000, now - 90*86400000)
        this.db.exec('DELETE FROM events WHERE important=0 AND id NOT IN (SELECT id FROM events WHERE important=0 ORDER BY id DESC LIMIT 50000)')
        const bytes = this.db.prepare('SELECT COALESCE(SUM(length(payload)),0) AS n FROM events WHERE important=0').get().n
        if (bytes > 128*1024*1024) this.db.exec('DELETE FROM events WHERE important=0 AND id NOT IN (SELECT id FROM events WHERE important=0 ORDER BY id DESC LIMIT 10000)')
        // Per-node cursors and the dashboard source markers preserve replay identity.
        // Bound the transport inbox just as the legacy coordinator did.
        this.db.exec('DELETE FROM received WHERE emitted=1 AND rowid NOT IN (SELECT rowid FROM received ORDER BY rowid DESC LIMIT 100000)')
    }
    recent(limit = 3000) {
        return this.db
            .prepare('SELECT id,payload FROM events ORDER BY id DESC LIMIT ?')
            .all(limit)
            .reverse()
            .map(row => ({ ...JSON.parse(row.payload), id: row.id }))
    }
    events(after = 0, limit = 500) {
        return this.db
            .prepare('SELECT id,payload FROM events WHERE id>? ORDER BY id LIMIT ?')
            .all(after, limit)
            .map(row => ({ ...JSON.parse(row.payload), id: row.id, journalNode: this.nodeId, journalId: row.id }))
    }
    receive(events, cursor) {
        this.db.exec('BEGIN IMMEDIATE')
        try {
            const insert = this.db.prepare('INSERT OR IGNORE INTO received(source,payload) VALUES (?,?)')
            for (const entry of events) insert.run(`${entry.sourceNode}:${entry.sourceEventId}`, JSON.stringify(entry))
            this.set('cursor', cursor)
            this.db.exec('COMMIT')
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
    }
    pending() {
        return this.db.prepare('SELECT source,payload FROM received WHERE emitted=0 LIMIT 500').all()
    }
    emitted(source) {
        this.db.prepare('UPDATE received SET emitted=1 WHERE source=?').run(source)
    }
    close() {
        this.db.close()
    }
}
