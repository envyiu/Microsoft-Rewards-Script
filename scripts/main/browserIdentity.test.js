import assert from 'node:assert/strict'
import test from 'node:test'

import browserIdentity from '../../common/browserIdentity.cjs'

const locale = {
    locale: 'en-US',
    acceptedLocales: ['en-US', 'en'],
    acceptLanguage: 'en-US,en;q=0.9'
}

function nativeIdentity() {
    return {
        headers: {
            'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36',
            'accept-language': locale.acceptLanguage,
            'sec-ch-ua': '"Chromium";v="149"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Linux"'
        },
        fingerprint: {
            navigator: {
                userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36',
                appVersion: '5.0 (X11; Linux x86_64)',
                platform: 'Linux x86_64',
                language: 'en-US',
                languages: ['en-US', 'en'],
                userAgentData: {
                    brands: [
                        { brand: 'Chromium', version: '149' },
                        { brand: 'Not)A;Brand', version: '24' }
                    ],
                    fullVersionList: [
                        { brand: 'Chromium', version: '149.0.7827.55' },
                        { brand: 'Not)A;Brand', version: '24.0.0.0' }
                    ],
                    mobile: false,
                    platform: 'Linux',
                    platformVersion: '6.12.0',
                    architecture: 'x86',
                    bitness: '64',
                    model: ''
                }
            },
            screen: {
                width: 1280,
                height: 720,
                availWidth: 1280,
                availHeight: 720,
                colorDepth: 24,
                pixelDepth: 24,
                devicePixelRatio: 1
            }
        },
        browserIdentity: {
            schemaVersion: 2,
            catalogRevision: 2,
            mode: 'native-desktop',
            engine: 'chromium',
            browserVersion: '149.0.7827.55',
            profileId: null,
            source: 'runtime-probe',
            sourceVersion: '149.0.7827.55'
        }
    }
}

test('catalog only enables sourced Android 11+ phone descriptors with explicit dimensions', () => {
    assert.equal(browserIdentity.MOBILE_PROFILES.length, 17)
    assert.equal(new Set(browserIdentity.MOBILE_PROFILES.map(profile => profile.id)).size, 17)
    for (const profile of browserIdentity.MOBILE_PROFILES) {
        assert.match(profile.source, /deviceDescriptorsSource\.json$/)
        assert.equal(profile.sourceVersion, '1.61.1')
        assert.ok(profile.androidVersion >= 11)
        assert.ok(profile.viewport.width <= profile.screen.width)
        assert.ok(profile.viewport.height < profile.screen.height)
        assert.match(profile.userAgentTemplate, new RegExp(`Android ${profile.androidVersion}`))
        assert.match(profile.userAgentTemplate, new RegExp(profile.model.replace(/[()]/g, '\\$&')))
    }
})

test('profile selection is stable for a normalized account key', () => {
    const first = browserIdentity.selectMobileProfile('stable@example.test')
    assert.equal(browserIdentity.selectMobileProfile(' STABLE@example.test ').id, first.id)
})

test('mobile identity keeps native Chromium brands and applies one sourced device descriptor', () => {
    const prepared = browserIdentity.prepareMobileIdentity({
        storedIdentity: null,
        nativeIdentity: nativeIdentity(),
        browserVersion: '149.0.7827.55',
        accountKey: 'stable@example.test',
        ...locale
    })
    const profile = browserIdentity.getMobileProfile(prepared.profileId)
    const data = prepared.identity.fingerprint.navigator.userAgentData

    assert.equal(prepared.action, 'regenerate')
    assert.deepEqual(data.brands, nativeIdentity().fingerprint.navigator.userAgentData.brands)
    assert.equal(data.model, profile.model)
    assert.equal(data.platform, 'Android')
    assert.equal(data.mobile, true)
    assert.match(prepared.identity.fingerprint.navigator.userAgent, new RegExp(profile.model.replace(/[()]/g, '\\$&')))
    assert.doesNotMatch(prepared.identity.fingerprint.navigator.userAgent, /Edg/)
    assert.deepEqual(browserIdentity.contextOptions(prepared.identity, locale.locale).viewport, profile.viewport)
})

test('saved mobile identity is reused, upgraded on Chromium change, and retired legacy data is replaced', () => {
    const initial = browserIdentity.prepareMobileIdentity({
        storedIdentity: null,
        nativeIdentity: nativeIdentity(),
        browserVersion: '149.0.7827.55',
        accountKey: 'stable@example.test',
        ...locale
    })
    const reused = browserIdentity.prepareMobileIdentity({
        storedIdentity: initial.identity,
        nativeIdentity: nativeIdentity(),
        browserVersion: '149.0.7827.55',
        accountKey: 'stable@example.test',
        ...locale
    })
    const upgraded = browserIdentity.prepareMobileIdentity({
        storedIdentity: initial.identity,
        nativeIdentity: nativeIdentity(),
        browserVersion: '150.0.8000.1',
        accountKey: 'stable@example.test',
        ...locale
    })

    assert.equal(reused.action, 'reuse')
    assert.equal(reused.profileId, initial.profileId)
    assert.equal(upgraded.action, 'upgrade')
    assert.equal(upgraded.profileId, initial.profileId)
    assert.match(upgraded.identity.fingerprint.navigator.userAgent, /Chrome\/150\.0\.8000\.1/)
    assert.equal(
        browserIdentity.inspectMobileIdentity(
            { fingerprint: {}, headers: {} },
            { browserVersion: '149.0.7827.55', locale: 'en-US' }
        ).reason,
        'missing-or-legacy'
    )
})

test('native identity capture recovers when the local probe returns non-JSON text', async () => {
    let fallbackCalled = false
    const captured = nativeIdentity()
    const result = await browserIdentity.resolveIdentityProbe(
        'Target "/" is not valid JSON',
        async () => {
            fallbackCalled = true
            return captured.fingerprint
        },
        {},
        'en-VN,en;q=0.9'
    )

    assert.equal(fallbackCalled, true)
    assert.equal(result.recovered, true)
    assert.deepEqual(result.captured, captured.fingerprint)
    assert.equal(result.requestHeaders['user-agent'], captured.fingerprint.navigator.userAgent)
    assert.equal(result.requestHeaders['accept-language'], 'en-VN,en;q=0.9')
    assert.equal(result.requestHeaders['sec-ch-ua-mobile'], '?0')
    assert.equal(result.requestHeaders['sec-ch-ua-platform'], '"Linux"')
})
