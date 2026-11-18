import { AsyncLocalStorage } from 'node:async_hooks'
import type { BrowserContext, Cookie } from 'patchright'
import type { PageSnapshot } from '../browser/ReactFunc'
import type { Account } from '../interface/Account'
import type { BrowserIdentitySnapshot } from '../interface/BrowserIdentity'

export interface ExecutionContext {
    isMobile: boolean
    account: Account
}

export interface BrowserSession {
    context: BrowserContext
    fingerprint: BrowserIdentitySnapshot
}

export interface AccountStats {
    email: string
    initialPoints: number | null
    finalPoints: number | null
    collectedPoints: number | null
    duration: number
    success: boolean
    error?: string
}

export interface AccountRunResult {
    initialPoints: number | null
    finalPoints: number | null
    collectedPoints: number | null
    skippedForBotWarning?: boolean
}

export interface UserData {
    userName: string
    geoLocale: string
    langCode: string
    timezoneOffset: string
    initialPoints: number
    currentPoints: number
    gainedPoints: number
}

export const executionContext = new AsyncLocalStorage<ExecutionContext>()

export function getCurrentContext(): ExecutionContext {
    const context = executionContext.getStore()
    if (!context) {
        return { isMobile: false, account: {} as Account }
    }
    return context
}

export class SessionContext {
    public userData: UserData = {
        userName: '',
        geoLocale: 'US',
        langCode: 'en',
        timezoneOffset: '60',
        initialPoints: 0,
        currentPoints: 0,
        gainedPoints: 0
    }

    public nextActions: Record<string, string> = {}
    public nextRouterStateTree = ''
    public morePromotionsVerified = false
    public punchCardsVerified = false
    public dailySetVerified = false
    public readToEarnVerified = false
    public reactSnapshot: PageSnapshot | null = null
    public reactSnapshots: { mobile: PageSnapshot | null; desktop: PageSnapshot | null } = {
        mobile: null,
        desktop: null
    }
    public searchTopicsCache: { key: string; topics: Promise<string[]> } | null = null

    public accessToken = ''
    public cookies: { mobile: Cookie[]; desktop: Cookie[] } = { mobile: [], desktop: [] }
    public fingerprintMobile?: BrowserIdentitySnapshot
    public fingerprintDesktop?: BrowserIdentitySnapshot

    public resetForAccount(): void {
        this.accessToken = ''
        this.cookies = { mobile: [], desktop: [] }
        this.fingerprintMobile = undefined
        this.fingerprintDesktop = undefined
        this.reactSnapshot = null
        this.morePromotionsVerified = false
        this.punchCardsVerified = false
        this.dailySetVerified = false
        this.readToEarnVerified = false
        this.reactSnapshots = { mobile: null, desktop: null }
        this.searchTopicsCache = null
    }
}
