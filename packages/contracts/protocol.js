export const WORKER_PROTOCOL = 3
export const ACCOUNT_KEY = /^ACCOUNT_[1-9]\d*_(EMAIL|PASSWORD|TOTP_SECRET|RECOVERY_EMAIL|NEW_ACCOUNT_MODE|GEO_LOCALE|LANG_CODE|PROXY_(URL|PORT|USERNAME|PASSWORD|HTTP|AXIOS)|SAVE_FINGERPRINT_(MOBILE|DESKTOP))$/

export function workerCapabilities(kind, environment = process.env) {
    const local = kind === 'local'
    return {
        preRewardsV1: true,
        directAccounts: local,
        manualBrowser: local && environment.MRS_MANUAL_BROWSER !== 'false',
        android: local && environment.MRS_ANDROID_ENABLED === 'true'
    }
}

export function requireLoopback(value) {
    const url = new URL(value)
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw Object.assign(new Error('Use a loopback HTTP worker URL; remote workers use SSH.'), { code: 'BAD_REQUEST', status: 400 })
    }
    return url.origin
}

export function assertCompatible(status) {
    if (status?.protocolVersion !== WORKER_PROTOCOL) {
        throw Object.assign(new Error('Worker requires an upgrade.'), { code: 'UPGRADE_REQUIRED', status: 409 })
    }
}

export function safeMerge(base, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return structuredClone(patch)
    const result = structuredClone(base && typeof base === 'object' ? base : {})
    for (const [key, value] of Object.entries(patch)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe configuration key')
        result[key] = value === '***REDACTED***' ? result[key]
            : value && typeof value === 'object' && !Array.isArray(value) ? safeMerge(result[key], value) : structuredClone(value)
    }
    return result
}
