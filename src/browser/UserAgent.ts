import type { Browser, BrowserContext, Page } from 'patchright'

import browserIdentity from '../../common/browserIdentity.cjs'

import type { BrowserIdentitySnapshot } from '../interface/BrowserIdentity'
import type { AccountLocale } from '../util/Locale'

export interface PreparedIdentity {
    identity: BrowserIdentitySnapshot
    action: 'native' | 'reuse' | 'upgrade' | 'regenerate'
    reason: string
    profileId?: string | null
}

export class UserAgentManager {
    async captureNativeIdentity(
        browser: Browser,
        locale: AccountLocale,
        onProbeFallback?: () => void
    ): Promise<BrowserIdentitySnapshot> {
        return browserIdentity.captureNativeBrowserIdentity(browser, {
            locale: locale.locale,
            acceptLanguage: locale.acceptLanguage,
            onProbeFallback
        })
    }

    prepareIdentity(options: {
        savedIdentity?: BrowserIdentitySnapshot | null
        nativeIdentity: BrowserIdentitySnapshot
        browserVersion: string
        isMobile: boolean
        accountKey: string
        locale: AccountLocale
    }): PreparedIdentity {
        if (!options.isMobile) {
            return {
                identity: options.nativeIdentity,
                action: 'native',
                reason: 'runtime-probe',
                profileId: null
            }
        }

        const prepared = browserIdentity.prepareMobileIdentity({
            storedIdentity: options.savedIdentity,
            nativeIdentity: options.nativeIdentity,
            browserVersion: options.browserVersion,
            accountKey: options.accountKey,
            locale: options.locale.locale,
            acceptedLocales: options.locale.acceptedLocales,
            acceptLanguage: options.locale.acceptLanguage
        })
        return {
            identity: prepared.identity,
            action: prepared.action,
            reason: prepared.reason,
            profileId: prepared.profileId
        }
    }

    contextOptions(identity: BrowserIdentitySnapshot, locale: AccountLocale) {
        return browserIdentity.contextOptions(identity, locale.locale)
    }

    registerContext(
        context: BrowserContext,
        identity: BrowserIdentitySnapshot,
        onError: (error: unknown) => void
    ): void {
        browserIdentity.registerContextIdentity(context, identity, onError)
    }

    newPage(context: BrowserContext): Promise<Page> {
        return browserIdentity.newIdentityPage(context)
    }
}
