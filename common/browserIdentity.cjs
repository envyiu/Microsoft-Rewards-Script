'use strict'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require('node:http')

const IDENTITY_SCHEMA_VERSION = 2
const MOBILE_CATALOG_REVISION = 2
const PROFILE_SOURCE = 'patchright-core/deviceDescriptorsSource.json'
const PROFILE_SOURCE_VERSION = '1.61.1'
const contexts = new WeakMap()
const pageSessions = new WeakMap()
const pageApplications = new WeakMap()

// These portrait phone descriptors are copied from Patchright 1.61.1. Only
// Android 11+ entries with an explicit screen and viewport are enabled.
const MOBILE_PROFILES = Object.freeze([
    profile('pixel-4a-5g', 'Pixel 4a (5G)', 11, 412, 892, 412, 765, 2.63),
    profile('pixel-5', 'Pixel 5', 11, 393, 851, 393, 727, 2.75),
    profile('pixel-6', 'Pixel 6', 12, 412, 915, 412, 839, 2.625),
    profile('pixel-6-pro', 'Pixel 6 Pro', 12, 412, 892, 412, 816, 3.5),
    profile('pixel-6a', 'Pixel 6a', 12, 412, 915, 412, 839, 2.625),
    profile('pixel-7', 'Pixel 7', 14, 412, 915, 412, 839, 2.625),
    profile('pixel-7-pro', 'Pixel 7 Pro', 13, 412, 892, 412, 816, 3.5),
    profile('pixel-7a', 'Pixel 7a', 13, 412, 915, 412, 839, 2.625),
    profile('pixel-8', 'Pixel 8', 14, 412, 915, 412, 839, 2.625),
    profile('pixel-8-pro', 'Pixel 8 Pro', 14, 448, 997, 448, 921, 3),
    profile('pixel-8a', 'Pixel 8a', 14, 412, 915, 412, 839, 2.625),
    profile('pixel-9', 'Pixel 9', 14, 360, 808, 360, 732, 3),
    profile('pixel-9-pro', 'Pixel 9 Pro', 14, 427, 952, 427, 876, 3),
    profile('pixel-9-pro-xl', 'Pixel 9 Pro XL', 14, 448, 997, 448, 921, 3),
    profile('pixel-10', 'Pixel 10', 16, 360, 808, 360, 732, 3),
    profile('pixel-10-pro', 'Pixel 10 Pro', 16, 427, 952, 427, 876, 3),
    profile('pixel-10-pro-xl', 'Pixel 10 Pro XL', 16, 448, 997, 448, 921, 3)
])

function profile(id, model, androidVersion, screenWidth, screenHeight, viewportWidth, viewportHeight, dpr) {
    return Object.freeze({
        id,
        model,
        androidVersion,
        userAgentTemplate: `Mozilla/5.0 (Linux; Android ${androidVersion}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{version} Mobile Safari/537.36`,
        screen: Object.freeze({ width: screenWidth, height: screenHeight }),
        viewport: Object.freeze({ width: viewportWidth, height: viewportHeight }),
        deviceScaleFactor: dpr,
        source: PROFILE_SOURCE,
        sourceVersion: PROFILE_SOURCE_VERSION
    })
}

function normalizeBrowserVersion(rawVersion) {
    const match = String(rawVersion ?? '').match(/(?:^|\/)(\d+\.\d+\.\d+\.\d+)$/)
    if (!match) throw new Error(`Unsupported Chromium version: ${rawVersion}`)
    return match[1]
}

function stableHash(value) {
    let hash = 2166136261
    for (const character of String(value).trim().toLowerCase()) {
        hash ^= character.codePointAt(0)
        hash = Math.imul(hash, 16777619)
    }
    return hash >>> 0
}

function selectMobileProfile(accountKey) {
    return MOBILE_PROFILES[stableHash(accountKey) % MOBILE_PROFILES.length]
}

function getMobileProfile(id) {
    return MOBILE_PROFILES.find(candidate => candidate.id === id)
}

function acceptedLanguageHeader(acceptedLocales) {
    return acceptedLocales.map((locale, index) => (index === 0 ? locale : `${locale};q=${1 - index * 0.1}`)).join(',')
}

function safeRequestHeaders(headers) {
    const allowed = new Set(['user-agent', 'accept-language', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'])
    return Object.fromEntries(Object.entries(headers).filter(([name]) => allowed.has(name.toLowerCase())))
}

function headersFromIdentity(captured, requestHeaders, acceptLanguage) {
    const navigator = captured?.navigator ?? {}
    const userAgentData = navigator.userAgentData
    const brands = Array.isArray(userAgentData?.brands) ? userAgentData.brands : []
    const derived = {
        'user-agent': navigator.userAgent,
        'accept-language': acceptLanguage,
        ...(brands.length
            ? {
                  'sec-ch-ua': brands
                      .map(({ brand, version }) =>
                          `${JSON.stringify(String(brand))};v=${JSON.stringify(String(version))}`
                      )
                      .join(', ')
              }
            : {}),
        ...(typeof userAgentData?.mobile === 'boolean'
            ? { 'sec-ch-ua-mobile': userAgentData.mobile ? '?1' : '?0' }
            : {}),
        ...(typeof userAgentData?.platform === 'string'
            ? { 'sec-ch-ua-platform': JSON.stringify(userAgentData.platform) }
            : {})
    }
    return { ...derived, ...safeRequestHeaders(requestHeaders ?? {}) }
}

async function resolveIdentityProbe(raw, fallbackCapture, requestHeaders, acceptLanguage) {
    let captured
    let recovered = false
    try {
        captured = JSON.parse(raw)
        if (captured?.error || !captured?.navigator || !captured?.screen) {
            throw new Error('The browser identity probe returned an unexpected payload')
        }
    } catch {
        recovered = true
        captured = await fallbackCapture()
        if (!captured?.navigator || !captured?.screen) {
            throw new Error('The browser identity probe returned invalid content and direct capture was incomplete')
        }
    }

    return {
        captured,
        requestHeaders: headersFromIdentity(captured, requestHeaders, acceptLanguage),
        recovered
    }
}

function probeDocument() {
    return `<!doctype html><meta charset="utf-8"><body>pending<script>
    (async () => {
        const data = navigator.userAgentData;
        const high = data ? await data.getHighEntropyValues([
            'architecture', 'bitness', 'fullVersionList', 'model', 'platformVersion'
        ]) : null;
        const iframe = document.createElement('iframe');
        document.body.appendChild(iframe);
        const iframeData = iframe.contentWindow.navigator.userAgentData;
        const iframeHigh = iframeData ? await iframeData.getHighEntropyValues(['model']) : null;
        document.body.textContent = JSON.stringify({
            navigator: {
                userAgent: navigator.userAgent,
                appVersion: navigator.appVersion,
                platform: navigator.platform,
                language: navigator.language,
                languages: [...navigator.languages],
                userAgentData: data ? {
                    brands: data.brands,
                    fullVersionList: high.fullVersionList || [],
                    mobile: data.mobile,
                    platform: data.platform,
                    platformVersion: high.platformVersion || '',
                    architecture: high.architecture || '',
                    bitness: high.bitness || '',
                    model: high.model || ''
                } : null
            },
            screen: {
                width: screen.width,
                height: screen.height,
                availWidth: screen.availWidth,
                availHeight: screen.availHeight,
                colorDepth: screen.colorDepth,
                pixelDepth: screen.pixelDepth,
                devicePixelRatio: devicePixelRatio
            },
            iframe: {
                userAgent: iframe.contentWindow.navigator.userAgent,
                mobile: iframeData ? iframeData.mobile : null,
                model: iframeHigh ? iframeHigh.model : null
            }
        });
    })().catch(error => { document.body.textContent = JSON.stringify({ error: String(error) }); });
    </script>`
}

async function capturePageIdentity(page, acceptLanguage, onRecovery) {
    let requestHeaders = {}
    const server = http.createServer((request, response) => {
        requestHeaders = request.headers
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(probeDocument())
    })
    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    try {
        const address = server.address()
        await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' })
        const body = page.locator('body')
        let raw = 'pending'
        for (let attempt = 0; attempt < 100 && raw === 'pending'; attempt += 1) {
            raw = (await body.textContent()) ?? 'pending'
            if (raw === 'pending') await new Promise(resolve => setTimeout(resolve, 10))
        }
        const result = await resolveIdentityProbe(
            raw,
            () =>
                page.evaluate(async () => {
                    const { document, navigator, screen } = globalThis
                    const data = navigator.userAgentData
                    const high = data
                        ? await data.getHighEntropyValues([
                              'architecture',
                              'bitness',
                              'fullVersionList',
                              'model',
                              'platformVersion'
                          ])
                        : null
                    const iframe = document.createElement('iframe')
                    document.body.appendChild(iframe)
                    const iframeData = iframe.contentWindow.navigator.userAgentData
                    const iframeHigh = iframeData ? await iframeData.getHighEntropyValues(['model']) : null
                    return {
                        navigator: {
                            userAgent: navigator.userAgent,
                            appVersion: navigator.appVersion,
                            platform: navigator.platform,
                            language: navigator.language,
                            languages: [...navigator.languages],
                            userAgentData: data
                                ? {
                                      brands: data.brands,
                                      fullVersionList: high.fullVersionList || [],
                                      mobile: data.mobile,
                                      platform: data.platform,
                                      platformVersion: high.platformVersion || '',
                                      architecture: high.architecture || '',
                                      bitness: high.bitness || '',
                                      model: high.model || ''
                                  }
                                : null
                        },
                        screen: {
                            width: screen.width,
                            height: screen.height,
                            availWidth: screen.availWidth,
                            availHeight: screen.availHeight,
                            colorDepth: screen.colorDepth,
                            pixelDepth: screen.pixelDepth,
                            devicePixelRatio: globalThis.devicePixelRatio
                        },
                        iframe: {
                            userAgent: iframe.contentWindow.navigator.userAgent,
                            mobile: iframeData ? iframeData.mobile : null,
                            model: iframeHigh ? iframeHigh.model : null
                        }
                    }
                }),
            requestHeaders,
            acceptLanguage
        )
        if (result.recovered) onRecovery?.()
        return result
    } finally {
        await new Promise(resolve => server.close(resolve))
    }
}

async function captureNativeBrowserIdentity(browser, options) {
    const context = await browser.newContext({ locale: options.locale })
    try {
        const page = await context.newPage()
        const { captured, requestHeaders } = await capturePageIdentity(
            page,
            options.acceptLanguage,
            options.onProbeFallback
        )
        const browserVersion = normalizeBrowserVersion(browser.version())
        return {
            headers: {
                ...requestHeaders,
                'accept-language': options.acceptLanguage
            },
            fingerprint: { navigator: captured.navigator, screen: captured.screen },
            browserIdentity: {
                schemaVersion: IDENTITY_SCHEMA_VERSION,
                catalogRevision: MOBILE_CATALOG_REVISION,
                mode: 'native-desktop',
                engine: 'chromium',
                browserVersion,
                profileId: null,
                source: 'runtime-probe',
                sourceVersion: browserVersion
            }
        }
    } finally {
        await context.close()
    }
}

function inspectMobileIdentity(identity, options) {
    if (!identity?.browserIdentity) return { action: 'regenerate', reason: 'missing-or-legacy' }
    const metadata = identity.browserIdentity
    if (
        metadata.schemaVersion !== IDENTITY_SCHEMA_VERSION ||
        metadata.catalogRevision !== MOBILE_CATALOG_REVISION ||
        metadata.mode !== 'emulated-mobile' ||
        metadata.engine !== 'chromium'
    ) {
        return { action: 'regenerate', reason: 'identity-version-changed' }
    }
    const profile = getMobileProfile(metadata.profileId)
    if (!profile) return { action: 'regenerate', reason: 'profile-retired' }
    try {
        if (
            new Intl.Locale(identity.fingerprint.navigator.language).toString() !==
            new Intl.Locale(options.locale).toString()
        ) {
            return { action: 'regenerate', reason: 'locale-changed' }
        }
    } catch {
        return { action: 'regenerate', reason: 'invalid-locale' }
    }
    if (metadata.browserVersion !== normalizeBrowserVersion(options.browserVersion)) {
        return { action: 'upgrade', reason: 'browser-version-changed', profileId: profile.id }
    }
    return { action: 'reuse', reason: 'compatible', profileId: profile.id }
}

function prepareMobileIdentity(options) {
    const inspection = inspectMobileIdentity(options.storedIdentity, options)
    const profile = getMobileProfile(inspection.profileId) ?? selectMobileProfile(options.accountKey)
    const browserVersion = normalizeBrowserVersion(options.browserVersion)
    const userAgent = profile.userAgentTemplate.replace('{version}', browserVersion)
    const nativeData = options.nativeIdentity.fingerprint.navigator.userAgentData
    if (!nativeData) throw new Error('Chromium did not expose User-Agent Client Hints during the native probe')
    const userAgentData = {
        ...nativeData,
        mobile: true,
        platform: 'Android',
        platformVersion: `${profile.androidVersion}.0.0`,
        architecture: '',
        bitness: '',
        model: profile.model
    }
    const headers = {
        ...options.nativeIdentity.headers,
        'user-agent': userAgent,
        'accept-language': options.acceptLanguage,
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"'
    }
    const identity = {
        headers,
        fingerprint: {
            navigator: {
                userAgent,
                appVersion: userAgent.replace('Mozilla/', ''),
                platform: 'Linux armv81',
                language: options.locale,
                languages: [...options.acceptedLocales],
                userAgentData
            },
            screen: {
                width: profile.screen.width,
                height: profile.screen.height,
                availWidth: profile.screen.width,
                availHeight: profile.screen.height,
                colorDepth: 24,
                pixelDepth: 24,
                devicePixelRatio: profile.deviceScaleFactor
            }
        },
        browserIdentity: {
            schemaVersion: IDENTITY_SCHEMA_VERSION,
            catalogRevision: MOBILE_CATALOG_REVISION,
            mode: 'emulated-mobile',
            engine: 'chromium',
            browserVersion,
            profileId: profile.id,
            source: profile.source,
            sourceVersion: profile.sourceVersion
        }
    }
    return { identity, ...inspection, profileId: profile.id }
}

function contextOptions(identity, locale) {
    if (identity.browserIdentity.mode === 'native-desktop') return { locale }
    const profile = getMobileProfile(identity.browserIdentity.profileId)
    if (!profile) throw new Error(`Unknown mobile profile: ${identity.browserIdentity.profileId}`)
    return {
        locale,
        userAgent: identity.fingerprint.navigator.userAgent,
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: profile.deviceScaleFactor,
        viewport: { ...profile.viewport },
        screen: { ...profile.screen }
    }
}

function applyIdentityToPage(context, page, identity) {
    if (identity.browserIdentity.mode !== 'emulated-mobile') return Promise.resolve()
    if (pageSessions.has(page)) return Promise.resolve()
    const existing = pageApplications.get(page)
    if (existing) return existing
    const applying = applyMobileIdentityToPage(context, page, identity).finally(() => pageApplications.delete(page))
    pageApplications.set(page, applying)
    return applying
}

async function applyMobileIdentityToPage(context, page, identity) {
    const metadata = identity.fingerprint.navigator.userAgentData
    const session = await context.newCDPSession(page)
    try {
        await session.send('Emulation.setUserAgentOverride', {
            userAgent: identity.fingerprint.navigator.userAgent,
            acceptLanguage: identity.headers['accept-language'],
            platform: identity.fingerprint.navigator.platform,
            userAgentMetadata: {
                brands: metadata.brands,
                fullVersionList: metadata.fullVersionList,
                platform: metadata.platform,
                platformVersion: metadata.platformVersion,
                architecture: metadata.architecture,
                model: metadata.model,
                mobile: true,
                bitness: metadata.bitness,
                wow64: false
            }
        })
        pageSessions.set(page, session)
        page.once('close', () => {
            pageSessions.delete(page)
            void session.detach().catch(() => {})
        })
    } catch (error) {
        await session.detach().catch(() => {})
        throw error
    }
}

function registerContextIdentity(context, identity, onError = () => {}) {
    contexts.set(context, identity)
    context.on('page', page => {
        void applyIdentityToPage(context, page, identity).catch(onError)
    })
}

async function newIdentityPage(context) {
    const page = await context.newPage()
    const identity = contexts.get(context)
    if (identity) await applyIdentityToPage(context, page, identity)
    return page
}

module.exports = {
    IDENTITY_SCHEMA_VERSION,
    MOBILE_CATALOG_REVISION,
    MOBILE_PROFILES,
    normalizeBrowserVersion,
    selectMobileProfile,
    getMobileProfile,
    acceptedLanguageHeader,
    capturePageIdentity,
    resolveIdentityProbe,
    captureNativeBrowserIdentity,
    inspectMobileIdentity,
    prepareMobileIdentity,
    contextOptions,
    registerContextIdentity,
    applyIdentityToPage,
    newIdentityPage
}
