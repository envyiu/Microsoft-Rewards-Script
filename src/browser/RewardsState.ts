import type { PageSnapshot } from './ReactFunc'

export type RewardsPageState =
    'loading' | 'login-required' | 'verification-required' | 'rewards-ready' | 'rewards-partial' | 'unrecoverable'

export type DataFreshness = 'fresh' | 'stale' | 'unknown'

export interface ReliableValue<T> {
    value: T | null
    source: string | null
    readAt: string
    freshness: DataFreshness
}

export interface RewardsPageEvidence {
    url: string
    html: string
    snapshot: PageSnapshot
    actionCount: number
    rewardsAccountConfirmed: boolean
}

export function finiteNonNegative(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function classifyRewardsPage(evidence: RewardsPageEvidence): RewardsPageState {
    const html = evidence.html.toLowerCase()
    const hostname = (() => {
        try {
            return new URL(evidence.url).hostname.toLowerCase()
        } catch {
            return null
        }
    })()
    if (hostname === null) return 'unrecoverable'

    if (
        /serviceabuselandingtitle|accountlocked|account (?:has been )?locked/.test(html) ||
        hostname === 'chromewebdata'
    ) {
        return 'unrecoverable'
    }
    if (/proof-confirmation|codeentry|name=["']otc["']|identity verification|verify your identity/.test(html)) {
        return 'verification-required'
    }
    if (
        hostname === 'login.live.com' ||
        /usernameentry|passwordentry|name=["']loginfmt["']|type=["']password["']/.test(html)
    ) {
        return 'login-required'
    }

    const rewardsHost = hostname === 'rewards.bing.com' || hostname.endsWith('.rewards.bing.com')
    const accountPoints = finiteNonNegative(evidence.snapshot.account.availablePoints)
    const payloadConfirmed =
        evidence.rewardsAccountConfirmed ||
        accountPoints !== null ||
        evidence.snapshot.offers.length > 0 ||
        evidence.snapshot.streaks.length > 0

    if (rewardsHost && payloadConfirmed) {
        return evidence.actionCount > 0 ? 'rewards-ready' : 'rewards-partial'
    }
    if (rewardsHost && /self\.__next_f|_next\/static|rewards/.test(html)) return 'loading'
    return 'unrecoverable'
}

export function reliableValue<T>(value: T | null, source: string | null, freshness: DataFreshness): ReliableValue<T> {
    return { value, source, freshness, readAt: new Date().toISOString() }
}
