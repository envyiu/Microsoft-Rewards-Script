import fs from 'node:fs'
import {
    reserveNormalQuery,
    normalQueryProgress,
    afterNormalQuery,
    beginNormalQuery,
    endNormalQuery,
    failNormalQuery
} from './NormalSession'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

/** Private typed events only. Never write query text, URLs, credentials or browser payloads. */
export function learningEvent(kind: 'activity' | 'query', data: Record<string, unknown>): void {
    const file = process.env.MRS_LEARNING_OUTBOX
    if (!file || !/^[a-f0-9-]{36}$/.test(process.env.MRS_LEARNING_ATTEMPT || '')) return
    try {
        const allowed = new Set([
            'task',
            'phase',
            'stage',
            'platform',
            'durationMs',
            'returned',
            'verified',
            'error',
            'queryId',
            'kind'
        ])
        const safe = Object.fromEntries(Object.entries(data).filter(([key]) => allowed.has(key)))
        const fd = fs.openSync(file, 'a', 0o600)
        try {
            fs.writeSync(
                fd,
                JSON.stringify({
                    kind,
                    eventId: crypto.randomUUID(),
                    observedAt: new Date().toISOString(),
                    data: safe
                }) + '\n'
            )
            if (kind === 'query') fs.fsyncSync(fd)
        } finally {
            fs.closeSync(fd)
        }
    } catch {
        /* Telemetry failure must not interrupt the account or expose its environment. */
    }
}
export async function learningQuery<T>(
    kind: 'normal' | 'activity' | 'warmup' | 'bonus' | 'visual',
    mobile: boolean,
    send: () => Promise<T>
): Promise<T> {
    if ((kind === 'normal' || kind === 'warmup') && process.env.MRS_DAILY_SEARCH_DAY) {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: process.env.MRS_DAILY_SEARCH_TIMEZONE || 'UTC',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).formatToParts(new Date())
        const get = (key: string) => parts.find(p => p.type === key)?.value
        if (`${get('year')}-${get('month')}-${get('day')}` !== process.env.MRS_DAILY_SEARCH_DAY)
            throw Object.assign(new Error('SESSION_QUERY_LIMIT: daily search window ended'), {
                code: 'SESSION_QUERY_LIMIT'
            })
    }
    const queryId = crypto.randomUUID(),
        start = performance.now()
    const common = { queryId, kind, platform: mobile ? 'mobile' : 'desktop' }
    const previous = normalQueryProgress(mobile)
    reserveNormalQuery(mobile, kind)
    reserveQuery(queryId, mobile ? 'mobile' : 'desktop')
    learningEvent('query', { ...common, phase: 'intent' })
    try {
        beginNormalQuery()
        let result: T
        try {
            result = await send()
        } finally {
            endNormalQuery()
        }
        await afterNormalQuery(mobile, previous, kind)
        learningEvent('query', { ...common, phase: 'sent', durationMs: performance.now() - start })
        return result
    } catch (error) {
        failNormalQuery(error)
        learningEvent('query', { ...common, phase: 'uncertain', durationMs: performance.now() - start })
        throw error
    }
}
let lastStage = ''
export function learningPhase(title: string, platform: string): void {
    const stages: Record<string, string> = {
        LOGIN: 'login',
        'LOGIN-BING': 'login',
        'LOGIN-APP': 'login',
        BROWSER: 'browser',
        BOOTSTRAP: 'bootstrap',
        'SMART-SEARCH-START': 'search',
        'CLOSE-BROWSER': 'cleanup',
        'BOT-CHECKPOINT': 'checkpoint'
    }
    const stage = stages[title]
    if (stage && stage + platform !== lastStage) {
        lastStage = stage + platform
        learningEvent('activity', { phase: 'phase', stage, platform })
    }
}

let cachedDb: { file: string; db: DatabaseSync } | null = null
let exitHookRegistered = false

export function closeLearningDb(): void {
    if (!cachedDb) return
    try {
        cachedDb.db.close()
    } catch {
        // Ignore close errors during shutdown.
    }
    cachedDb = null
}

function getLearningDb(file: string): DatabaseSync {
    if (cachedDb && cachedDb.file === file) return cachedDb.db
    closeLearningDb()
    const db = new DatabaseSync(file)
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;')
    cachedDb = { file, db }
    if (!exitHookRegistered) {
        exitHookRegistered = true
        process.once('exit', closeLearningDb)
    }
    return db
}

function reserveQuery(queryId: string, platform: string): void {
    const file = process.env.MRS_LEARNING_LEDGER,
        account = process.env.MRS_LEARNING_ACCOUNT
    if (!file || !account) return
    let db: DatabaseSync | undefined
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: process.env.MRS_LEARNING_TIMEZONE || 'UTC',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).formatToParts(new Date())
        const get = (key: string) => parts.find(p => p.type === key)?.value
        const day = `${get('year')}-${get('month')}-${get('day')}`
        db = getLearningDb(file)
        db.exec('BEGIN IMMEDIATE')
        db.prepare('INSERT OR IGNORE INTO query_budget(account,day,platform,used) VALUES(?,?,?,0)').run(
            account,
            day,
            platform
        )
        db.prepare('INSERT INTO query_reservations VALUES(?,?,?,?)').run(queryId, account, day, platform)
        db.prepare('UPDATE query_budget SET used=used+1 WHERE account=? AND day=? AND platform=?').run(
            account,
            day,
            platform
        )
        db.exec('COMMIT')
    } catch (error) {
        try {
            db?.exec('ROLLBACK')
        } catch {
            /* Already rolled back. */
        }
        closeLearningDb()
        void error // Learning is observational; a telemetry outage cannot authorize or block a query.
    }
}
