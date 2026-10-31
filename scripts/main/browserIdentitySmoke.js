import { chromium } from 'patchright'

import browserIdentity from '../../common/browserIdentity.cjs'

const headed = process.argv.includes('--headed')
const locale = {
    locale: 'en-US',
    acceptedLocales: ['en-US', 'en'],
    acceptLanguage: 'en-US,en;q=0.9'
}

function accountKeyForProfile(profileId) {
    for (let index = 0; index < 10000; index += 1) {
        const key = `identity-smoke-${index}@example.test`
        if (browserIdentity.selectMobileProfile(key).id === profileId) return key
    }
    throw new Error(`Could not select mobile profile ${profileId}`)
}

function assertMobileCapture(profile, captured, requestHeaders) {
    const data = captured.navigator.userAgentData
    if (!captured.navigator.userAgent.includes(profile.model)) throw new Error(`${profile.id}: UA model mismatch`)
    if (data?.model !== profile.model || data.mobile !== true || data.platform !== 'Android') {
        throw new Error(`${profile.id}: UA-CH mismatch`)
    }
    if (!captured.iframe.userAgent.includes(profile.model) || captured.iframe.model !== profile.model) {
        throw new Error(`${profile.id}: iframe identity mismatch`)
    }
    if (captured.screen.width !== profile.screen.width || captured.screen.height !== profile.screen.height) {
        throw new Error(`${profile.id}: screen mismatch`)
    }
    if (requestHeaders['sec-ch-ua-mobile'] !== '?1' || requestHeaders['sec-ch-ua-platform'] !== '"Android"') {
        throw new Error(`${profile.id}: request client hints mismatch`)
    }
}

const browser = await chromium.launch({ headless: !headed })
try {
    const nativeIdentity = await browserIdentity.captureNativeBrowserIdentity(browser, locale)
    if (nativeIdentity.browserIdentity.mode !== 'native-desktop') throw new Error('Native desktop probe failed')
    const desktopContext = await browser.newContext(browserIdentity.contextOptions(nativeIdentity, locale.locale))
    try {
        browserIdentity.registerContextIdentity(desktopContext, nativeIdentity)
        const page = await browserIdentity.newIdentityPage(desktopContext)
        const desktop = await browserIdentity.capturePageIdentity(page)
        if (desktop.captured.navigator.userAgent !== nativeIdentity.fingerprint.navigator.userAgent) {
            throw new Error('Native desktop context changed the Chromium User-Agent')
        }
        if (
            JSON.stringify(desktop.captured.navigator.userAgentData) !==
            JSON.stringify(nativeIdentity.fingerprint.navigator.userAgentData)
        ) {
            throw new Error('Native desktop context changed Chromium Client Hints')
        }
    } finally {
        await desktopContext.close()
    }

    for (const profile of browserIdentity.MOBILE_PROFILES) {
        const prepared = browserIdentity.prepareMobileIdentity({
            storedIdentity: null,
            nativeIdentity,
            browserVersion: browser.version(),
            accountKey: accountKeyForProfile(profile.id),
            ...locale
        })
        const context = await browser.newContext(browserIdentity.contextOptions(prepared.identity, locale.locale))
        try {
            browserIdentity.registerContextIdentity(context, prepared.identity, error => {
                throw error
            })
            const page = await browserIdentity.newIdentityPage(context)
            const result = await browserIdentity.capturePageIdentity(page)
            assertMobileCapture(profile, result.captured, result.requestHeaders)
        } finally {
            await context.close()
        }
    }

    console.log(
        `Browser identity smoke passed | mode=${headed ? 'headed' : 'headless'} | chromium=${browser.version()} | profiles=${browserIdentity.MOBILE_PROFILES.length}`
    )
} finally {
    await browser.close()
}
