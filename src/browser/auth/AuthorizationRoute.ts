/** Only report the host/path: OAuth query parameters contain codes and account identifiers. */
export function safeAuthorizationLocation(rawUrl: string): string {
    try {
        const url = new URL(rawUrl)
        return `${url.hostname}${url.pathname}`
    } catch {
        return '(invalid URL)'
    }
}

// This is evidence about this authorization flow, not proof that the account is globally locked.
export function isAccountReviewUrl(rawUrl: string): boolean {
    try {
        const url = new URL(rawUrl)
        return url.hostname.toLowerCase() === 'account.live.com' && /^\/abuse(?:\/|$)/i.test(url.pathname)
    } catch {
        return false
    }
}
