export interface BrowserUserAgentData {
    brands: Array<{ brand: string; version: string }>
    fullVersionList: Array<{ brand: string; version: string }>
    mobile: boolean
    platform: string
    platformVersion: string
    architecture: string
    bitness: string
    model: string
}

export interface BrowserIdentitySnapshot {
    headers: Record<string, string>
    fingerprint: {
        navigator: {
            userAgent: string
            appVersion: string
            platform: string
            language: string
            languages: string[]
            userAgentData: BrowserUserAgentData | null
        }
        screen: {
            width: number
            height: number
            availWidth: number
            availHeight: number
            colorDepth: number
            pixelDepth: number
            devicePixelRatio: number
        }
    }
    browserIdentity: {
        schemaVersion: number
        catalogRevision: number
        mode: 'native-desktop' | 'emulated-mobile'
        engine: 'chromium'
        browserVersion: string
        profileId: string | null
        source: string
        sourceVersion: string
    }
}
