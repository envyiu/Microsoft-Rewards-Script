import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export const LEARNING_VERSION = 1
export const LEARNING_KINDS = [
    'decision',
    'attempt_start',
    'attempt_end',
    'activity',
    'query',
    'resource',
    'day',
    'network',
    'gap',
    'health'
]
const id = value => typeof value === 'string' && /^[a-f0-9-]{16,80}$/.test(value)
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const boolean = value => typeof value === 'boolean'
const text = values => value => values.includes(value)
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value))
const day = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value)
const tasks = [
    'dailySet',
    'morePromotions',
    'punchCards',
    'streakProtection',
    'dailyCheckIn',
    'readToEarn',
    'appPromotions',
    'activateSearchPerk',
    'visualSearch',
    'claimBonusPoints',
    'bonusSearches'
]
const list = validator => value => Array.isArray(value) && value.length <= 512 && value.every(validator)
const descriptor = {
    accountId: id,
    networkId: id,
    type: text(['workers', 'search', 'quota', 'warmup', 'accountSession']),
    platform: text(['desktop', 'mobile']),
    workers: list(text(tasks)),
    searchBudget: number,
    dueAt: date,
    reason: text([
        'ready',
        'cooldown',
        'retry-backoff',
        'deadline-catch-up',
        'outside-run-window',
        'quota-recheck',
        'earn-final-recheck',
        'new-account',
        'stopped-cooldown',
        'SESSION_LIMIT',
        'SESSION_REST',
        'SESSION_UNCERTAIN',
        'SESSION_ACTIVE',
        'ACCOUNT_HOLD',
        'ACCOUNT_LOCKED',
        'VERIFICATION_REQUIRED'
    ]),
    attempts: number,
    waitSeconds: number,
    deadlineMinutes: number,
    newAccount: boolean,
    quotaKnown: boolean,
    remaining: number,
    usedQueries: number,
    manual: boolean,
    allowed: boolean
}
const processSchema = {
    attemptId: id,
    cpuSeconds: number,
    pssBytes: number,
    rssBytes: number,
    readBytes: number,
    writeBytes: number,
    alive: boolean
}
const schemas = {
    decision: {
        decisionId: id,
        accountId: id,
        networkId: id,
        candidates: [descriptor],
        selected: descriptor,
        running: [descriptor],
        maxParallel: number,
        effectiveParallel: number,
        hardParallel: number,
        cooldownMin: number,
        cooldownMax: number,
        searchCap: number,
        policy: text(['baseline-v1', 'collection-explore-v1']),
        arm: text(['control', 'budget-reduced', 'cooldown-shorter', 'cooldown-longer', 'concurrency-reduced']),
        probability: number,
        experimental: boolean,
        blockId: id,
        blockProbability: number,
        configRevision: id,
        runtimeRevision: id,
        candidateCount: number,
        candidatesTruncated: boolean
    },
    attempt_start: { attemptId: id, decisionId: id, ...descriptor },
    attempt_end: {
        failure: text(['network', 'data', 'authentication', 'verification', 'locked']),
        noProgressQueries: number,
        reconciliations: number,
        logins: number,
        attemptId: id,
        decisionId: id,
        accountId: id,
        type: descriptor.type,
        workers: descriptor.workers,
        platform: descriptor.platform,
        durationMs: number,
        success: boolean,
        verified: boolean,
        interrupted: boolean,
        timedOut: boolean,
        staleDay: boolean,
        queries: number,
        points: number,
        remaining: number,
        quotaKnown: boolean,
        completedWorkers: descriptor.workers,
        reason: text([
            'completed',
            'pending',
            'error',
            'timeout',
            'user-stop',
            'handoff',
            'worker-restart',
            'spawn-error'
        ]),
        cooldownMinutes: number,
        exitCode: number
    },
    activity: {
        attemptId: id,
        eventId: id,
        task: text(tasks),
        phase: text(['start', 'end', 'verified', 'pending', 'phase']),
        stage: text(['login', 'browser', 'bootstrap', 'search', 'checkpoint', 'cleanup', 'verification']),
        platform: text(['desktop', 'mobile', 'main']),
        durationMs: number,
        returned: boolean,
        verified: boolean,
        error: boolean
    },
    query: {
        attemptId: id,
        eventId: id,
        queryId: id,
        kind: text(['normal', 'activity', 'warmup', 'bonus', 'visual']),
        platform: text(['desktop', 'mobile']),
        phase: text(['intent', 'sent', 'uncertain']),
        durationMs: number
    },
    resource: {
        cpuCores: number,
        cpuPercent: number,
        load1: number,
        memoryTotal: number,
        memoryAvailable: number,
        swapUsed: number,
        diskAvailable: number,
        active: number,
        manual: number,
        processes: [processSchema],
        sampleIntervalMs: number,
        collectorCpuMs: number,
        collectorWallMs: number,
        pressureCpu: number,
        pressureMemory: number,
        oomKills: number,
        cgroupMemoryMax: number,
        cgroupCpuCores: number
    },
    day: {
        accountId: id,
        day,
        timezone: value => typeof value === 'string' && /^[A-Za-z_+\-/]{1,64}$/.test(value),
        deadlineMinutes: number,
        observedAt: date,
        goalRevision: id,
        requiredWorkers: descriptor.workers,
        completedWorkers: descriptor.workers,
        failedWorkers: descriptor.workers,
        mobileEnabled: boolean,
        desktopEnabled: boolean,
        mobileComplete: boolean,
        desktopComplete: boolean,
        mobileQuotaKnown: boolean,
        desktopQuotaKnown: boolean,
        mobileQueries: number,
        desktopQueries: number,
        newAccount: boolean,
        manual: boolean,
        held: boolean,
        enabled: boolean,
        complete: boolean,
        known: boolean,
        earnVerified: boolean,
        earnObservedAt: date,
        final: boolean
    },
    network: {
        attemptId: id,
        accountId: id,
        networkId: id,
        ipId: id,
        checkedAt: date,
        durationMs: number,
        known: boolean
    },
    gap: {
        attemptId: id,
        reason: text([
            'worker-restart',
            'disk-pressure',
            'sample-error',
            'outbox-invalid',
            'clock-skew',
            'collector-error'
        ]),
        count: number
    },
    health: { schemaVersion: number, enabled: boolean, ready: boolean, active: number }
}
function project(schema, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid learning object')
    const result = {}
    for (const [key, rule] of Object.entries(schema)) {
        const v = value[key]
        if (v === null || v === undefined) continue
        if (Array.isArray(rule)) {
            if (!Array.isArray(v) || v.length > 512) throw new Error('Invalid learning array')
            result[key] = v.map(x => project(rule[0], x))
        } else if (typeof rule === 'function') {
            if (!rule(v)) throw new Error('Invalid learning field: ' + key)
            result[key] = v
        } else result[key] = project(rule, v)
    }
    return result
}
export function learningPayload(kind, value) {
    if (!schemas[kind]) throw new Error('Invalid learning kind')
    return project(schemas[kind], value)
}
export function learningIdentity(secret, kind, value) {
    return crypto
        .createHmac('sha256', secret)
        .update(kind + '\0' + String(value))
        .digest('hex')
}
export function learningConfig(value) {
    if (
        !value ||
        !id(value.collectionId) ||
        !/^([a-f0-9]{64})$/.test(value.identitySecret || '') ||
        typeof value.enabled !== 'boolean'
    )
        throw new Error('Invalid learning configuration')
    return {
        version: 1,
        collectionId: value.collectionId,
        identitySecret: value.identitySecret,
        enabled: value.enabled,
        startedAt: date(value.startedAt) ? value.startedAt : null,
        experimentAllowed: value.experimentAllowed === true,
        experimentRate: Math.min(0.1, number(value.experimentRate) ? value.experimentRate : 0.1),
        dailySearchCaps:
            value.dailySearchCaps && typeof value.dailySearchCaps === 'object'
                ? Object.fromEntries(
                      ['desktop', 'mobile']
                          .filter(k => Number.isSafeInteger(value.dailySearchCaps[k]) && value.dailySearchCaps[k] > 0)
                          .map(k => [k, value.dailySearchCaps[k]])
                  )
                : {}
    }
}
export class LearningStore {
    constructor(directory, { nodeId, central = false } = {}) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
        this.directory = directory
        this.nodeId = nodeId
        this.central = central
        this.db = new DatabaseSync(path.join(directory, 'learning.sqlite'))
        fs.chmodSync(path.join(directory, 'learning.sqlite'), 0o600)
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
          CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS query_budget(account TEXT NOT NULL,day TEXT NOT NULL,platform TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account,day,platform));
          CREATE TABLE IF NOT EXISTS query_reservations(query TEXT PRIMARY KEY,account TEXT NOT NULL,day TEXT NOT NULL,platform TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS records(id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, source TEXT NOT NULL, seq INTEGER, kind TEXT NOT NULL, observed TEXT NOT NULL, received TEXT NOT NULL, payload TEXT NOT NULL, dedup TEXT UNIQUE, UNIQUE(collection,source,seq));
          CREATE INDEX IF NOT EXISTS learning_kind_time ON records(kind,observed);
          CREATE INDEX IF NOT EXISTS learning_source_seq ON records(collection,source,seq);`)
    }
    get(key) {
        const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)
        return row ? JSON.parse(row.value) : null
    }
    set(key, value) {
        this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key, JSON.stringify(value))
    }
    append(collection, kind, data, { at = new Date().toISOString(), dedup = null } = {}) {
        if (!id(collection) || !id(this.nodeId) || !date(at)) throw new Error('Invalid learning identity')
        const safe = learningPayload(kind, data)
        if (['attempt_start', 'attempt_end', 'query', 'activity', 'network'].includes(kind) && !id(safe.attemptId))
            throw new Error('Missing attempt identity')
        if (kind === 'decision' && !id(safe.decisionId)) throw new Error('Missing decision identity')
        this.db.exec('BEGIN IMMEDIATE')
        try {
            const row = this.db
                .prepare(
                    'INSERT OR IGNORE INTO records(collection,source,seq,kind,observed,received,payload,dedup) VALUES(?,?,NULL,?,?,?,?,?)'
                )
                .run(collection, this.nodeId, kind, at, new Date().toISOString(), JSON.stringify(safe), dedup)
            if (row.changes) this.db.prepare('UPDATE records SET seq=id WHERE id=?').run(row.lastInsertRowid)
            this.db.exec('COMMIT')
            return row.changes ? Number(row.lastInsertRowid) : 0
        } catch (e) {
            this.db.exec('ROLLBACK')
            throw e
        }
    }
    page(collection, after = 0, limit = 500) {
        return this.db
            .prepare('SELECT * FROM records WHERE collection=? AND seq>? ORDER BY seq LIMIT ?')
            .all(collection, after, Math.min(500, limit))
            .map(r => ({
                version: 1,
                collectionId: r.collection,
                sourceNode: r.source,
                seq: r.seq,
                kind: r.kind,
                observedAt: r.observed,
                data: JSON.parse(r.payload)
            }))
    }
    ingest(collection, source, records) {
        if (!id(collection) || !id(source) || !Array.isArray(records) || records.length > 500)
            throw new Error('Invalid learning batch')
        const cursorKey = 'cursor:' + collection + ':' + source
        let cursor = this.get(cursorKey) || 0
        this.db.exec('BEGIN IMMEDIATE')
        try {
            for (const row of records) {
                if (
                    row.version !== 1 ||
                    row.collectionId !== collection ||
                    row.sourceNode !== source ||
                    !Number.isSafeInteger(row.seq) ||
                    row.seq < 1 ||
                    !date(row.observedAt)
                )
                    throw new Error('Invalid learning envelope')
                const payload = learningPayload(row.kind, row.data)
                if (
                    ['attempt_start', 'attempt_end', 'query', 'activity', 'network'].includes(row.kind) &&
                    !id(payload.attemptId)
                )
                    throw new Error('Missing attempt identity')
                if (row.kind === 'decision' && !id(payload.decisionId)) throw new Error('Missing decision identity')
                this.db
                    .prepare(
                        'INSERT OR IGNORE INTO records(collection,source,seq,kind,observed,received,payload) VALUES(?,?,?,?,?,?,?)'
                    )
                    .run(
                        collection,
                        source,
                        row.seq,
                        row.kind,
                        row.observedAt,
                        new Date().toISOString(),
                        JSON.stringify(payload)
                    )
                cursor = Math.max(cursor, row.seq)
            }
            this.set(cursorKey, cursor)
            this.db.exec('COMMIT')
            return cursor
        } catch (e) {
            this.db.exec('ROLLBACK')
            throw e
        }
    }
    ack(collection, cursor) {
        const max = this.db.prepare('SELECT COALESCE(MAX(seq),0) n FROM records WHERE collection=?').get(collection).n
        if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > max)
            throw new Error('Invalid learning acknowledgement')
        this.set('ack:' + collection, Math.max(this.get('ack:' + collection) || 0, cursor))
    }
    rows({ kind, from = '1970-01-01T00:00:00.000Z', to = '9999-12-31T00:00:00.000Z', after = 0, limit = 1000 } = {}) {
        const rows = this.db
            .prepare(
                'SELECT * FROM records WHERE observed>=? AND observed<? AND id>? AND (? IS NULL OR kind=?) ORDER BY id LIMIT ?'
            )
            .all(from, to, after, kind || null, kind || null, Math.min(5000, limit))
        return rows.map(r => ({
            id: r.id,
            collectionId: r.collection,
            sourceNode: r.source,
            seq: r.seq,
            kind: r.kind,
            observedAt: r.observed,
            receivedAt: r.received,
            data: JSON.parse(r.payload)
        }))
    }
    stats() {
        return this.db
            .prepare('SELECT kind,COUNT(*) count,MIN(observed) firstAt,MAX(observed) lastAt FROM records GROUP BY kind')
            .all()
    }
    prune(now = Date.now()) {
        const stamp = days => new Date(now - days * 86400000).toISOString()
        this.db.prepare('DELETE FROM query_reservations WHERE day<?').run(stamp(180).slice(0, 10))
        this.db.prepare('DELETE FROM query_budget WHERE day<?').run(stamp(180).slice(0, 10))
        if (this.central)
            this.db
                .prepare("DELETE FROM records WHERE observed<? OR (kind='resource' AND observed<?)")
                .run(stamp(180), stamp(90))
        else
            for (const row of this.db.prepare('SELECT DISTINCT collection FROM records').all())
                this.db
                    .prepare('DELETE FROM records WHERE collection=? AND seq<=? AND observed<?')
                    .run(row.collection, this.get('ack:' + row.collection) || 0, stamp(7))
    }
    close() {
        this.db.close()
    }
}
