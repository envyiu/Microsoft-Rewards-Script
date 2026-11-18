import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { NEW_ACCOUNT_SERVICES, preRewardsActive } from '../../../packages/contracts/newAccount.js'
import { ACCOUNT_KEY } from '../../../packages/contracts/protocol.js'
import { SMART_WORKERS, validateSmartConfig as validateContract } from '../../../packages/contracts/smartConfig.js'
import { loadAccounts } from '../../../packages/contracts/accounts.js'
import { migrateAppAuthorizationSso } from '../appAuthorization.js'
import { settleDailySearch } from '../dailySearch.js'
import { protectionFor, recordSessionOutcome } from '../normalPolicy.js'
import { processIdentity, processReplaced } from '../processIdentity.js'

export const QUOTA_CHECK_INTERVAL_MS = 2 * 60 * 60_000
export const MAX_QUOTA_CHECKS_PER_DAY = 3

export const WORKER_FLAGS = Object.fromEntries(
    SMART_WORKERS.map(worker => [worker, `do${worker[0].toUpperCase()}${worker.slice(1)}`])
)

export const validateSmartConfig = (raw, accounts = loadAccounts()) => validateContract(raw, accounts)

export function fail(message) {
    throw Object.assign(new Error(message), { code: 'BAD_REQUEST' })
}

export function localParts(date, timezone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    })
        .formatToParts(date)
        .reduce((out, part) => ((out[part.type] = part.value), out), {})
    return { day: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) }
}

export function minuteOf(value) {
    const [hour, minute] = value.split(':').map(Number)
    return hour * 60 + minute
}

export function randomMinutes(range) {
    return range.min + Math.floor(Math.random() * (range.max - range.min + 1))
}

export function inRange(minute, range) {
    const start = minuteOf(range.start)
    const end = minuteOf(range.end)
    return start <= end ? minute >= start && minute < end : minute >= start || minute < end
}

export function atomicWrite(filename, value) {
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    const temp = `${filename}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    const fd = fs.openSync(temp, 'r+')
    try {
        fs.fsyncSync(fd)
    } finally {
        fs.closeSync(fd)
    }
    fs.renameSync(temp, filename)
    if (process.platform !== 'win32') {
        const dir = fs.openSync(path.dirname(filename), 'r')
        try {
            fs.fsyncSync(dir)
        } finally {
            fs.closeSync(dir)
        }
    }
}

export function migrateRewardsVerification(state) {
    const version = state.rewardsVerificationVersion || 0
    if (version >= 2) return false
    const affected = version < 1 ? ['morePromotions', 'punchCards'] : ['morePromotions']
    for (const account of Object.values(state.accounts || {})) {
        for (const key of ['workersCompleted', 'workersFailed']) {
            if (Array.isArray(account[key])) account[key] = account[key].filter(worker => !affected.includes(worker))
        }
        for (const key of ['workerFailures', 'workerRetryAt']) {
            for (const worker of affected) if (account[key]) delete account[key][worker]
        }
    }
    state.rewardsVerificationVersion = 2
    return true
}

export function earnRecheckDue(state, now = Date.now()) {
    return (
        state.workersCompleted.includes('morePromotions') &&
        now - (Date.parse(state.earnLastScannedAt || '') || now) >= QUOTA_CHECK_INTERVAL_MS
    )
}

export function applyEarnScan(state, scan, now = Date.now()) {
    if (!scan || typeof scan.verified !== 'boolean') return
    state.earnLastScannedAt = new Date(now).toISOString()
    state.earnScanVerified = scan.verified
    if (scan.verified) {
        state.workersCompleted = [...new Set([...state.workersCompleted, 'morePromotions'])]
        state.workersFailed = state.workersFailed.filter(w => w !== 'morePromotions')
        delete state.workerRetryAt.morePromotions
        state.workerFailures.morePromotions = 0
    } else {
        state.workersCompleted = state.workersCompleted.filter(w => w !== 'morePromotions')
    }
}

export const scheduleStoreMethods = {
    invalidateCaches() {
        this._accountsCache = { signature: null, accounts: [] }
        this._botConfigCache = { path: null, mtimeMs: -1, size: -1, value: {} }
    },

    _cachedAccounts() {
        this._accountsCache ??= { signature: null, accounts: [] }
        let envFileSig = 'skip'
        if (process.env.MRS_SKIP_ENV_FILE !== '1') {
            const envPath = path.join(this.projectRoot || process.cwd(), '.env')
            try {
                const st = fs.statSync(envPath)
                envFileSig = `${st.mtimeMs}:${st.size}`
            } catch {
                envFileSig = 'missing'
            }
        }
        const envPairs = []
        for (const [k, v] of Object.entries(process.env)) {
            if (ACCOUNT_KEY.test(k)) envPairs.push(`${k}=${v}`)
        }
        envPairs.sort()
        const signature = `${envFileSig}|${envPairs.join('\u0000')}`
        if (this._accountsCache.signature === signature) return this._accountsCache.accounts
        const accounts = loadAccounts()
        this._accountsCache = { signature, accounts }
        return accounts
    },

    _cachedBotConfig() {
        this._botConfigCache ??= { path: null, mtimeMs: -1, size: -1, value: {} }
        const cfgPath = process.env.MRS_CONFIG_FILE || path.join(this.projectRoot || process.cwd(), 'config.json')
        try {
            const st = fs.statSync(cfgPath)
            if (
                this._botConfigCache.path === cfgPath &&
                this._botConfigCache.mtimeMs === st.mtimeMs &&
                this._botConfigCache.size === st.size
            ) {
                return this._botConfigCache.value
            }
            const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
            this._botConfigCache = { path: cfgPath, mtimeMs: st.mtimeMs, size: st.size, value: parsed }
            return parsed
        } catch {
            return {}
        }
    },

    _load() {
        let saved = {}
        try {
            saved = JSON.parse(fs.readFileSync(this.configFile, 'utf8'))
        } catch (error) {
            try {
                saved = JSON.parse(fs.readFileSync(this.configFile + '.last-good', 'utf8'))
                if (!saved.config || !saved.state?.accounts || !Array.isArray(saved.state.sessions)) {
                    throw new Error('Invalid Smart backup')
                }
                if (fs.existsSync(this.configFile)) {
                    fs.copyFileSync(this.configFile, this.configFile + `.corrupt-${Date.now()}`)
                }
                atomicWrite(this.configFile, saved)
            } catch {
                const journal = path.join(path.dirname(this.configFile), 'normal-query-journal')
                if (error.code !== 'ENOENT' || (fs.existsSync(journal) && fs.readdirSync(journal).length)) {
                    throw Object.assign(
                        new Error('Smart state is unreadable; restore its protected history before scheduling.'),
                        { code: 'SMART_STATE_UNREADABLE' }
                    )
                }
            }
        }
        const accounts = this._cachedAccounts()
        const rawConfig = saved.config ?? saved
        const knownIndexes = new Set(accounts.map(account => account.index))
        const profiles = Array.isArray(rawConfig.profiles)
            ? rawConfig.profiles.filter(profile => knownIndexes.has(Number(profile?.accountIndex)))
            : rawConfig.profiles
        const config = validateSmartConfig({ ...rawConfig, profiles }, accounts)
        const state =
            saved.state && typeof saved.state === 'object'
                ? saved.state
                : { accounts: {}, sessions: [], updatedAt: null }
        state.accounts ??= {}
        state.sessions ??= []
        return { config, state }
    },

    _recoverNormalSessions() {
        for (const state of Object.values(this.document.state.accounts)) {
            for (const session of state.protection?.sessions || []) {
                if (session.endedAt || !session.pid) continue
                try {
                    process.kill(session.pid, 0)
                    if (!processReplaced(session.processIdentity, processIdentity(session.pid))) continue
                } catch (error) {
                    if (error.code !== 'ESRCH') continue
                }
                const file = path.join(path.dirname(this.configFile), 'normal-query-journal', session.id + '.jsonl')
                try {
                    session.queries = fs
                        .readFileSync(file, 'utf8')
                        .split('\n')
                        .filter(Boolean)
                        .map(row => JSON.parse(row))
                    settleDailySearch(
                        state,
                        { day: session.day, dailySearchReservation: session.dailySearchReservation },
                        session.queries.filter(q => !q.kind || q.kind === 'normal').length
                    )
                } catch {}
                let failure = 'interrupted'
                try {
                    failure = JSON.parse(fs.readFileSync(file + '.outcome', 'utf8')).failure || failure
                } catch {}
                recordSessionOutcome(state, session.id, failure)
            }
        }
    },

    _save() {
        this.document.state.updatedAt = new Date().toISOString()
        atomicWrite(this.configFile, this.document)
        atomicWrite(this.configFile + '.last-good', this.document)
    },

    _accountState(account, profile, now) {
        const { day } = localParts(now, profile.timezone)
        let state = this.document.state.accounts[String(account.index)]
        if (!state || state.day !== day) {
            const manualStopUntil = state?.manualStopUntil
            const lastStoppedJobId = state?.lastStoppedJobId
            state = {
                protection: state?.protection,
                normalPolicyStatus: state?.normalPolicyStatus,
                newAccount: state?.newAccount
                    ? {
                          ...state.newAccount,
                          services: [],
                          serviceActions: [],
                          serviceAttempts: 0,
                          servicesPending: []
                      }
                    : undefined,
                manualStopUntil,
                lastStoppedJobId,
                operatorPaused: state?.operatorPaused === true,
                searchStreak: state?.searchStreak,
                day,
                email: account.email,
                workersCompleted: [],
                workersFailed: [],
                workerFailures: {},
                workerRetryAt: {},
                nextWorkerAt: null,
                probeUsed: { mobile: false, desktop: false },
                platforms: {
                    mobile: {
                        remaining: null,
                        quotaKnown: false,
                        queries: 0,
                        ewmaPointsPerQuery: 3,
                        lastRunAt: null,
                        cooldownUntil: null,
                        failures: 0,
                        failed: false,
                        complete: false
                    },
                    desktop: {
                        remaining: null,
                        quotaKnown: false,
                        queries: 0,
                        ewmaPointsPerQuery: 3,
                        lastRunAt: null,
                        cooldownUntil: null,
                        failures: 0,
                        failed: false,
                        complete: false
                    }
                }
            }
            this.document.state.accounts[String(account.index)] = state
        }
        state.workersFailed ??= []
        if (state.newAccount?.needsAction && (state.newAccount.serviceAttempts || 0) >= 3) {
            const lastWarmup = [...(this.document.state.sessions || [])]
                .reverse()
                .find(item => item.accountIndex === account.index && item.type === 'warmup' && item.day === state.day)
            const pending = NEW_ACCOUNT_SERVICES.filter(
                service =>
                    !state.newAccount.services?.includes(service) || !state.newAccount.serviceActions?.includes(service)
            )
            if (lastWarmup?.success === true && pending.length) {
                state.newAccount.needsAction = false
                state.newAccount.servicesPending = pending
                if (!state.newAccount.onboardingActionsVersion) {
                    state.newAccount.onboardingActionsVersion = 1
                    state.newAccount.serviceAttempts = 0
                }
            }
        }
        state.workerFailures ??= {}
        if (!state.workerRetryAt) {
            state.workerRetryAt = {}
            if (state.nextWorkerAt && Object.values(state.workerFailures).some(count => count > 0)) {
                for (const [worker, count] of Object.entries(state.workerFailures)) {
                    if (count > 0) state.workerRetryAt[worker] = state.nextWorkerAt
                }
                state.nextWorkerAt = null
            }
        }
        if (!state.protection && this.document.config.normalPolicy?.enabled && !preRewardsActive(account, state)) {
            const guard = protectionFor(state)
            guard.sessions = (this.document.state.sessions || [])
                .filter(
                    s =>
                        s.accountIndex === account.index &&
                        s.email === account.email &&
                        s.type !== 'warmup' &&
                        Date.parse(s.startedAt) > Date.now() - 24 * 3600000
                )
                .map(s => ({
                    id: s.executionId || crypto.randomUUID(),
                    startedAt: s.startedAt,
                    endedAt: s.endedAt || null,
                    platform: s.platform || null,
                    queries: [],
                    migrated: true
                }))
        }
        migrateAppAuthorizationSso(state)
        state.probeUsed ??= { mobile: false, desktop: false }
        for (const platform of ['mobile', 'desktop']) {
            const platformState = state.platforms[platform]
            platformState.failures ??= 0
            platformState.failed ??= false
            platformState.quotaKnown ??= platformState.complete === true || (platformState.remaining ?? 0) > 0
            if (!platformState.quotaKnown && state.probeUsed[platform]) platformState.remaining = null
        }
        return state
    }
}
