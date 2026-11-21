import fs from 'node:fs'
import { consumeAiTurn } from './AiSearchTransport'
import type { BrowserContext } from 'patchright'
import type { ExecutionPlan } from '../interface/ExecutionPlan'

export type Failure = 'network' | 'data' | 'authentication' | 'verification' | 'locked'
export type OutcomeScope = 'account' | 'browser-session' | 'app' | 'app-oauth' | 'quota-endpoint' | 'task'
type NormalizedScope = 'account' | 'browser-session' | 'app-oauth' | 'quota-endpoint' | 'task'
type Quota = { max: number; progress: number }

function isVisualNavigation(url: URL): boolean {
    return (
        /\/(?:searchbyimage|visualsearch)(?:\/|$)/i.test(url.pathname) ||
        (url.pathname === '/images/search' && Boolean(url.searchParams.get('bcid'))) ||
        (url.pathname === '/search' &&
            Boolean(url.searchParams.get('bcid')) &&
            url.searchParams.get('FORM')?.toUpperCase() === 'SBIVSP')
    )
}

function normalizeScope(scope: OutcomeScope): NormalizedScope {
    return scope === 'app' ? 'app-oauth' : scope
}

/** Per-process guard; its durable query journal is independent of learning telemetry. */
export class NormalSession {
    private quotas: Partial<Record<'mobile' | 'desktop', Quota>> = {}
    private quotaAt = 0
    private used = 0
    private normalUsed = 0
    private failure: Failure | null = null
    private searchStopped = false
    private searchDeferred = false
    private appOAuthOutcome: 'needs-action' | 'transient-error' | null = null
    private journal: string | undefined
    private refresh: (() => Promise<void>) | undefined
    private wait: ((ms: number) => Promise<void>) | undefined
    private pacing: (() => Promise<void>) | undefined
    private noProgressQueries = 0
    private confirmedNormal = 0
    private reconciliations = 0
    private logins = 0
    private stagnant = 0
    private reconciling = false
    private browserTicket: false | 'search' | 'visual' = false
    private visualUsed = 0
    private failureScope: NormalizedScope = 'account'

    setFailureScope(scope: OutcomeScope): void {
        this.failureScope = normalizeScope(scope)
    }

    beginSend(kind = 'normal'): void {
        if (this.active) this.browserTicket = kind === 'visual' ? 'visual' : 'search'
    }

    endSend(): void {
        this.browserTicket = false
    }

    authorizeHttpSearch(rawUrl: string): void {
        if (!this.active) return
        const url = new URL(rawUrl)
        if (
            !/(^|\.)bing\.com$/.test(url.hostname) ||
            (!/\/(?:search|copilotsearch|searchbyimage|visualsearch)(?:\/|$)/i.test(url.pathname) &&
                !(url.pathname === '/images/search' && url.searchParams.has('bcid')))
        )
            return
        this.assertActive()
        const visual = isVisualNavigation(url)
        if (!this.browserTicket || (this.browserTicket === 'visual' ? !visual : this.searchBlocked))
            throw Object.assign(new Error('SESSION_UNRESERVED_QUERY'), { code: 'SESSION_UNRESERVED_QUERY' })
        this.browserTicket = false
    }

    async protectBrowser(context: BrowserContext): Promise<void> {
        if (!this.active) return
        await context.route(/https?:\/\/(?:[^/]+\.)?bing\.com\//, async route => {
            const url = new URL(route.request().url())
            if (
                !/\/(?:search|copilotsearch|searchbyimage|visualsearch)(?:\/|$)/i.test(url.pathname) &&
                !(url.pathname === '/images/search' && url.searchParams.has('bcid'))
            ) {
                await route.fallback()
                return
            }
            const aiPermit = consumeAiTurn(route.request())
            if (aiPermit && !this.blocked) {
                if (aiPermit === 'setup' || aiPermit === 'initial') {
                    if (this.browserTicket !== 'search' || this.searchBlocked) {
                        await route.abort('blockedbyclient')
                        return
                    }
                    if (aiPermit === 'initial') this.browserTicket = false
                }
                await route.fallback()
                return
            }
            const visual = isVisualNavigation(url)
            if (
                this.browserTicket &&
                !this.blocked &&
                (this.browserTicket === 'visual' ? visual : !this.searchBlocked)
            ) {
                this.browserTicket = false
                await route.fallback()
            } else await route.abort('blockedbyclient')
        })
    }

    constructor(private plan: ExecutionPlan | null) {
        if (plan?.type !== 'accountSession') return
        this.journal = process.env.MRS_NORMAL_QUERY_JOURNAL
        if (!this.journal) throw new Error('Account session requires a durable query journal')
        const rows = fs.readFileSync(this.journal, 'utf8').split('\n').filter(Boolean)
        this.used = rows.map(row => JSON.parse(row) as { kind?: string }).filter(row => row.kind !== 'visual').length
        this.visualUsed = rows
            .map(row => JSON.parse(row) as { kind?: string })
            .filter(row => row.kind === 'visual').length
        if (fs.existsSync(this.journal + '.visual')) {
            this.visualUsed += fs
                .readFileSync(this.journal + '.visual', 'utf8')
                .split('\n')
                .filter(Boolean).length
        }
        this.normalUsed = rows
            .map(row => JSON.parse(row) as { kind?: string })
            .filter(row => !row.kind || row.kind === 'normal').length
        if (this.used > plan.searchBudget) throw new Error('Invalid account session query journal')
    }

    configure(refresh: () => Promise<void>, wait: (ms: number) => Promise<void>, pacing?: () => Promise<void>): void {
        this.refresh = refresh
        this.wait = wait
        this.pacing = pacing
    }

    async afterQuery(mobile: boolean, previous: number | undefined, kind = 'normal'): Promise<void> {
        if (!this.active) return
        if (kind === 'visual') return
        const platform = mobile ? 'mobile' : 'desktop'
        await this.pacing?.()
        await this.refresh?.()
        const current = this.quotas[platform]
        const progressed = previous != null && current != null && current.progress > previous
        if (progressed && kind === 'normal') this.confirmedNormal++
        this.stagnant = progressed ? 0 : this.stagnant + 1
        if (!progressed) this.noProgressQueries++
        this.persistOutcome()
        if (!current || this.blocked) {
            this.stopSearch()
            return
        }
        if (this.stagnant < 2) return
        this.reconciling = true
        this.reconciliations++
        this.persistOutcome()
        try {
            await this.wait?.(60000)
            await this.refresh?.()
            const reconciled = this.quotas[platform]
            if (previous != null && reconciled && reconciled.progress > previous && !this.blocked) this.stagnant = 0
            else this.stopSearch()
        } finally {
            this.reconciling = false
        }
    }

    progress(mobile: boolean): number | undefined {
        return this.quotas[mobile ? 'mobile' : 'desktop']?.progress
    }

    get active(): boolean {
        return this.plan?.type === 'accountSession'
    }

    get queries(): number {
        return this.used
    }

    get activityQueries(): number {
        return Math.max(0, this.used - this.normalUsed)
    }

    get normalSearchUsed(): number {
        return this.normalUsed
    }

    get normalSearchRemaining(): number {
        return this.plan?.type === 'accountSession'
            ? Math.max(
                  0,
                  Math.min(
                      this.plan.searchBudget - this.used,
                      (this.plan.normalSearchBudget ?? this.plan.searchBudget) - this.normalUsed
                  )
              )
            : 0
    }

    get isSearchDeferred(): boolean {
        return this.searchDeferred
    }

    get appStatus(): 'needs-action' | 'transient-error' | null {
        return this.appOAuthOutcome
    }

    get blocked(): boolean {
        return this.failure != null
    }

    get searchBlocked(): boolean {
        return this.searchStopped || this.blocked
    }

    assertActive(): void {
        if (this.failure)
            throw Object.assign(new Error(`Account session stopped: ${this.failure}`), {
                code: 'ACCOUNT_SESSION_STOPPED'
            })
    }

    recordLoginAttempt(): void {
        if (!this.active) return
        this.logins++
        this.persistOutcome()
    }

    recordQuotaSnapshot(snapshot: { readAt: string; mobile?: Quota | null; desktop?: Quota | null }): void {
        if (!this.active) return
        const at = Date.parse(snapshot.readAt)
        if (!Number.isFinite(at) || at < this.quotaAt || at > Date.now() + 1000 || Date.now() - at > 600000) return
        this.quotaAt = at
        this.quotas = {}
        this.searchDeferred = false
        for (const platform of ['mobile', 'desktop'] as const) {
            const q = snapshot[platform]
            if (
                q &&
                Number.isFinite(q.max) &&
                q.max > 0 &&
                Number.isFinite(q.progress) &&
                q.progress >= 0 &&
                q.progress <= q.max
            )
                this.quotas[platform] = q
        }
    }

    deferQuota(): void {
        if (!this.active) return
        this.quotas = {}
        this.searchDeferred = true
        this.persistOutcome()
    }

    recordScopedOutcome(
        scope: OutcomeScope,
        kind: Failure | 'search-deferred' | 'app-needs-action' | 'app-transient'
    ): void {
        if (!this.active) return
        const normalized = normalizeScope(scope)
        if (kind === 'locked') {
            this.failure = 'locked'
            this.persistOutcome()
            return
        }
        if (normalized === 'quota-endpoint' || kind === 'search-deferred') {
            this.deferQuota()
            return
        }
        if (normalized === 'app-oauth' || kind === 'app-needs-action' || kind === 'app-transient') {
            this.appOAuthOutcome = kind === 'app-needs-action' ? 'needs-action' : 'transient-error'
            this.persistOutcome()
            return
        }
        if (normalized === 'task') {
            return
        }
        if (
            ['network', 'data', 'authentication', 'verification'].includes(kind) &&
            (!this.failure || kind === 'verification')
        ) {
            this.failure = kind as Failure
            this.persistOutcome()
        }
    }

    observe(title: string, message: string, level: string): void {
        if (!this.active) return
        if (title === 'LOGIN' && message === 'Starting login process') {
            this.recordLoginAttempt()
            return
        }
        if (title === 'SMART-QUOTA') {
            try {
                const snapshot = JSON.parse(message) as {
                    readAt: string
                    mobile: Quota | null
                    desktop: Quota | null
                }
                if (typeof snapshot?.readAt === 'string') {
                    this.recordQuotaSnapshot(snapshot)
                    return
                }
            } catch {
                // Non-JSON SMART-QUOTA warning falls through to quota-deferred check below.
            }
        }
        if (
            /quota remains unavailable|no parseable pointsCounters|Could not read search quota|Failed to enrich search counters/i.test(
                message
            )
        ) {
            this.deferQuota()
            return
        }
        if (level !== 'error' && level !== 'warn') return
        if (
            /unsupported|not supported|SESSION_QUERY_LIMIT|SESSION_SEARCH_STOPPED|SESSION_QUOTA_UNAVAILABLE/.test(
                message
            )
        )
            return

        if (/account (?:has been |is )?(?:locked|suspended|disabled)|accountlocked|account_suspended/i.test(message)) {
            this.recordScopedOutcome('account', 'locked')
            return
        }

        // App OAuth and task/quota scopes never trigger a 24h full-account hold.
        if (title === 'LOGIN-APP' || this.failureScope === 'app-oauth') {
            const needsAction = /needs user action|account-review|waiting for user action/i.test(message)
            this.recordScopedOutcome('app-oauth', needsAction ? 'app-needs-action' : 'app-transient')
            return
        }
        if (this.failureScope === 'quota-endpoint') {
            this.deferQuota()
            return
        }
        if (this.failureScope === 'task') {
            return
        }

        let failure: Failure | null = null
        // Flyout status 9 is unknown Rewards data, never evidence of a ban.
        if (/flyout.*(?:code|status|error)[= :]+9\b/i.test(message)) failure = 'data'
        else if (
            /captcha|challenge required|manual authentication required|requires interactive|verify your identity|verification required|proofs\/|BOT-WARNING/i.test(
                `${title} ${message}`
            )
        )
            failure = 'verification'
        else if (
            /authentication failed|login failed|failed to (?:log|sign) in|invalid password|unauthorized|status(?: code)?[= :]+401/i.test(
                message
            ) ||
            (title === 'LOGIN' && /failed|unavailable|error/i.test(message))
        )
            failure = 'authentication'
        else if (
            level === 'error' &&
            /ECONN|ETIMEDOUT|ERR_PROXY|ERR_TUNNEL|ERR_CONNECTION|ENOTFOUND|timeout.*exceeded|status(?: code)?[= :]+5\d\d|proxy.*fail|network.*(?:error|fail)/i.test(
                message
            )
        )
            failure = 'network'
        else if (
            /dashboard.*(?:unavailable|missing|failed|invalid)|FlyoutAccountData|Rewards (?:account )?data unavailable/i.test(
                message
            )
        )
            failure = 'data'

        if (failure) {
            this.recordScopedOutcome(this.failureScope, failure)
        }
    }

    recordRuntimeError(title: string, error: unknown): void {
        if (!this.active) return
        const message = error instanceof Error ? error.message : String(error)
        this.observe(title, message, 'error')
    }

    private persistOutcome(): void {
        if (!this.journal) return
        const temp = this.journal + '.outcome.tmp'
        const fd = fs.openSync(temp, 'w', 0o600)
        try {
            fs.writeSync(
                fd,
                JSON.stringify({
                    failure: this.failure,
                    searchDeferred: this.searchDeferred,
                    appOAuthOutcome: this.appOAuthOutcome,
                    noProgressQueries: this.noProgressQueries,
                    confirmedNormal: this.confirmedNormal,
                    normalAttempts: this.normalUsed,
                    activityQueries: this.activityQueries,
                    reconciliations: this.reconciliations,
                    logins: this.logins
                })
            )
            fs.fsyncSync(fd)
        } finally {
            fs.closeSync(fd)
        }
        fs.renameSync(temp, this.journal + '.outcome')
    }

    failedQuery(error: unknown): void {
        if (!this.active) return
        this.stopSearch()
        this.observe('QUERY', error instanceof Error ? error.message : String(error), 'error')
    }

    failureReason(): Failure | null {
        return this.failure
    }

    stopSearch(): void {
        this.searchStopped = true
    }

    reserve(platform: 'mobile' | 'desktop', kind = 'normal'): void {
        if (!this.active || this.plan?.type !== 'accountSession') return
        this.assertActive()
        if (kind === 'visual') {
            if (
                platform !== 'desktop' ||
                this.plan.platform !== 'desktop' ||
                !this.plan.workers.includes('visualSearch')
            ) {
                throw Object.assign(new Error('SESSION_VISUAL_NOT_ALLOWED'), { code: 'SESSION_VISUAL_NOT_ALLOWED' })
            }
            if (this.visualUsed >= 4) {
                throw Object.assign(new Error('SESSION_VISUAL_LIMIT'), { code: 'SESSION_VISUAL_LIMIT' })
            }
            const fd = fs.openSync(this.journal! + '.visual', 'a', 0o600)
            try {
                fs.writeSync(
                    fd,
                    JSON.stringify({ at: new Date().toISOString(), kind, attempt: this.visualUsed + 1 }) + '\n'
                )
                fs.fsyncSync(fd)
            } finally {
                fs.closeSync(fd)
            }
            this.visualUsed++
            return
        }
        const quota = this.quotas[platform]
        const reject = (code: string): never => {
            throw Object.assign(new Error(code), { code })
        }
        if (this.searchStopped || this.reconciling) reject('SESSION_SEARCH_STOPPED')
        if (
            platform !== this.plan.platform ||
            !quota ||
            Date.now() - this.quotaAt > 600000 ||
            quota.progress >= quota.max
        )
            reject('SESSION_QUOTA_UNAVAILABLE')
        if (this.used >= this.plan.searchBudget || (kind === 'normal' && this.normalSearchRemaining === 0))
            reject('SESSION_QUERY_LIMIT')
        const fd = fs.openSync(this.journal!, 'a', 0o600)
        try {
            fs.writeSync(
                fd,
                JSON.stringify({ at: new Date().toISOString(), platform, kind, query: this.used + 1 }) + '\n'
            )
            fs.fsyncSync(fd)
        } finally {
            fs.closeSync(fd)
        }
        this.used++
        if (kind === 'normal') this.normalUsed++
    }
}

let current: NormalSession | undefined
export function setNormalSession(session: NormalSession): void {
    current = session
}
export function reserveNormalQuery(mobile: boolean, kind = 'normal'): void {
    current?.reserve(mobile ? 'mobile' : 'desktop', kind)
}

export function normalQueryProgress(mobile: boolean): number | undefined {
    return current?.progress(mobile)
}
export async function afterNormalQuery(mobile: boolean, previous: number | undefined, kind = 'normal'): Promise<void> {
    await current?.afterQuery(mobile, previous, kind)
}

export function beginNormalQuery(kind = 'normal'): void {
    current?.beginSend(kind)
}
export function endNormalQuery(): void {
    current?.endSend()
}

export function assertNormalSessionActive(): void {
    current?.assertActive()
}

export function failNormalQuery(error: unknown): void {
    current?.failedQuery(error)
}

export function authorizeNormalHttpSearch(url: string): void {
    current?.authorizeHttpSearch(url)
}
