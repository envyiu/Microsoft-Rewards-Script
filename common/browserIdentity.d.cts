import type { Browser, BrowserContext, Page } from 'patchright'
import type { BrowserIdentitySnapshot } from '../src/interface/BrowserIdentity'

export interface MobileProfile {
    id: string
    model: string
    androidVersion: number
    userAgentTemplate: string
    screen: { width: number; height: number }
    viewport: { width: number; height: number }
    deviceScaleFactor: number
    source: string
    sourceVersion: string
}

export interface LocaleOptions {
    locale: string
    acceptedLocales: string[]
    acceptLanguage: string
}

export const IDENTITY_SCHEMA_VERSION: number
export const MOBILE_CATALOG_REVISION: number
export const MOBILE_PROFILES: readonly MobileProfile[]
export function normalizeBrowserVersion(rawVersion: string): string
export function selectMobileProfile(accountKey: string): MobileProfile
export function getMobileProfile(id: string | null | undefined): MobileProfile | undefined
export function acceptedLanguageHeader(acceptedLocales: string[]): string
export interface CapturedPageIdentity {
    captured: BrowserIdentitySnapshot['fingerprint'] & {
        iframe: { userAgent: string; mobile: boolean | null; model: string | null }
    }
    requestHeaders: Record<string, string>
    recovered: boolean
}
export function capturePageIdentity(
    page: Page,
    acceptLanguage?: string,
    onRecovery?: () => void
): Promise<CapturedPageIdentity>
export function resolveIdentityProbe(
    raw: string,
    fallbackCapture: () => Promise<CapturedPageIdentity['captured']>,
    requestHeaders: Record<string, string>,
    acceptLanguage?: string
): Promise<CapturedPageIdentity>
export function captureNativeBrowserIdentity(
    browser: Browser,
    options: Pick<LocaleOptions, 'locale' | 'acceptLanguage'> & { onProbeFallback?: () => void }
): Promise<BrowserIdentitySnapshot>
export function inspectMobileIdentity(
    identity: BrowserIdentitySnapshot | null | undefined,
    options: { browserVersion: string; locale: string }
): { action: 'reuse' | 'upgrade' | 'regenerate'; reason: string; profileId?: string }
export function prepareMobileIdentity(
    options: LocaleOptions & {
        storedIdentity?: BrowserIdentitySnapshot | null
        nativeIdentity: BrowserIdentitySnapshot
        browserVersion: string
        accountKey: string
    }
): {
    identity: BrowserIdentitySnapshot
    action: 'reuse' | 'upgrade' | 'regenerate'
    reason: string
    profileId: string
}
export function contextOptions(
    identity: BrowserIdentitySnapshot,
    locale: string
): {
    locale: string
    userAgent?: string
    isMobile?: boolean
    hasTouch?: boolean
    deviceScaleFactor?: number
    viewport?: { width: number; height: number }
    screen?: { width: number; height: number }
}
export function registerContextIdentity(
    context: BrowserContext,
    identity: BrowserIdentitySnapshot,
    onError?: (error: unknown) => void
): void
export function applyIdentityToPage(
    context: BrowserContext,
    page: Page,
    identity: BrowserIdentitySnapshot
): Promise<void>
export function newIdentityPage(context: BrowserContext): Promise<Page>
