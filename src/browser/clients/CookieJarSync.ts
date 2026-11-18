import type { Cookie, Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../index'
import { loadSession, saveStorageState } from '../../util/SessionStore'

export class CookieJarSync {
    constructor(private readonly bot: MicrosoftRewardsBot) {}

    public getActivePage(): Page | null {
        const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
        return page && !page.isClosed() ? page : null
    }

    public getCachedCookies(explicitCookies?: Cookie[], targetUrl?: string): Cookie[] {
        const cookies = explicitCookies ?? (this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop)
        return targetUrl ? filterCookiesForUrl(cookies, targetUrl) : cookies
    }

    public async checkpointActiveSession(source = 'SESSION-CHECKPOINT'): Promise<boolean> {
        const page = this.getActivePage()
        if (!page) {
            this.bot.logger.debug(
                this.bot.isMobile,
                source,
                'Could not checkpoint session because no active browser page is available'
            )
            return false
        }

        try {
            await this.syncActiveCookies(page, source, true)
            return true
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                source,
                `Could not checkpoint active session | error=${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    public async synchronizeActiveBrowserCookies(source: string, applyCached = false): Promise<boolean> {
        const page = this.getActivePage()
        if (!page) return false

        try {
            const context = page.context()
            let liveCookies = await context.cookies()

            if (applyCached) {
                const now = Date.now() / 1000
                const liveByKey = new Map(
                    liveCookies.map(cookie => [`${cookie.domain}|${cookie.path}|${cookie.name}`, cookie])
                )
                const changed = this.getCachedCookies().filter(cookie => {
                    if (cookie.expires !== -1 && cookie.expires <= now) return false
                    const live = liveByKey.get(`${cookie.domain}|${cookie.path}|${cookie.name}`)
                    return (
                        !live ||
                        live.value !== cookie.value ||
                        live.expires !== cookie.expires ||
                        live.httpOnly !== cookie.httpOnly ||
                        live.secure !== cookie.secure ||
                        live.sameSite !== cookie.sameSite
                    )
                })

                if (changed.length) {
                    await context.addCookies(changed)
                    liveCookies = await context.cookies()
                }
            }

            this.updateCookieCache(liveCookies, source)
            return true
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                source,
                `Could not synchronize active browser cookies | error=${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    public updateCookieCache(liveCookies: Cookie[], source: string): boolean {
        const cachedCookies = this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop
        const cookieState = (cookie: Cookie) =>
            JSON.stringify({
                value: cookie.value,
                expires: cookie.expires,
                httpOnly: cookie.httpOnly,
                secure: cookie.secure,
                sameSite: cookie.sameSite
            })
        const cachedByKey = new Map(
            cachedCookies.map(cookie => [`${cookie.domain}|${cookie.path}|${cookie.name}`, cookieState(cookie)])
        )
        const changed =
            cachedCookies.length !== liveCookies.length ||
            liveCookies.some(
                cookie => cachedByKey.get(`${cookie.domain}|${cookie.path}|${cookie.name}`) !== cookieState(cookie)
            )

        if (this.bot.isMobile) this.bot.cookies.mobile = liveCookies
        else this.bot.cookies.desktop = liveCookies

        if (changed) {
            this.bot.logger.debug(
                this.bot.isMobile,
                source,
                `Refreshed cookie cache | previous=${cachedCookies.length} | current=${liveCookies.length}`
            )
        }

        return changed
    }

    public async syncActiveCookies(page: Page, source: string, forcePersist = false): Promise<void> {
        try {
            const context = page.context()
            const liveCookies = await context.cookies()
            const changed = this.updateCookieCache(liveCookies, source)
            if (!changed && !forcePersist) return

            const email = this.bot.currentAccountEmail
            if (!email) return

            const storageState = await context.storageState()
            saveStorageState(this.bot.config.sessionPath, email, this.bot.isMobile, storageState)
            this.bot.logger.debug(
                this.bot.isMobile,
                source,
                `Persisted live browser session | cookies=${storageState.cookies.length} | origins=${storageState.origins.length}`
            )
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                source,
                `Could not persist refreshed cookies | error=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    public async applyResponseCookies(requestUrl: string, setCookieHeader?: string[] | string): Promise<void> {
        if (!setCookieHeader) return

        const rawCookies = Array.isArray(setCookieHeader)
            ? setCookieHeader
            : splitCombinedSetCookieHeader(setCookieHeader)
        if (!rawCookies.length) return

        const current = this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop
        const updated = [...current]
        let changed = false

        for (const raw of rawCookies) {
            const parsed = parseSetCookie(raw, requestUrl)
            if (!parsed) continue

            const keyMatches = (cookie: Cookie) =>
                cookie.name === parsed.cookie.name &&
                cookie.domain === parsed.cookie.domain &&
                cookie.path === parsed.cookie.path
            const index = updated.findIndex(keyMatches)

            if (parsed.remove) {
                if (index >= 0) {
                    updated.splice(index, 1)
                    changed = true
                }
                continue
            }

            if (index >= 0) {
                if (JSON.stringify(updated[index]) !== JSON.stringify(parsed.cookie)) {
                    updated[index] = parsed.cookie
                    changed = true
                }
            } else {
                updated.push(parsed.cookie)
                changed = true
            }
        }

        if (!changed) return

        this.updateCookieCache(updated, 'COOKIE-SYNC')

        const email = this.bot.currentAccountEmail
        if (!email) return

        const saved = loadSession(this.bot.config.sessionPath, email, this.bot.isMobile)
        saveStorageState(this.bot.config.sessionPath, email, this.bot.isMobile, {
            cookies: updated,
            origins: saved?.storageState?.origins ?? []
        })
        this.bot.logger.debug(
            this.bot.isMobile,
            'COOKIE-SYNC',
            `Applied ${rawCookies.length} response cookie(s) and persisted the updated session`
        )
    }

    public buildCookieHeader(cookies: Cookie[], allowedDomains?: string[]): string {
        return buildCookieHeader(cookies, allowedDomains)
    }
}

export function filterCookiesForUrl(cookies: Cookie[], targetUrl: string, nowSec = Date.now() / 1000): Cookie[] {
    const url = new URL(targetUrl)
    const host = url.hostname.toLowerCase()
    const requestPath = url.pathname || '/'

    return cookies
        .filter(cookie => {
            if (cookie.expires !== -1 && cookie.expires <= nowSec) return false
            if (cookie.secure && url.protocol !== 'https:') return false

            const domain = cookie.domain.replace(/^\./, '').toLowerCase()
            if (host !== domain && !host.endsWith(`.${domain}`)) return false

            const cookiePath = cookie.path || '/'
            if (!requestPath.startsWith(cookiePath)) return false
            if (
                requestPath.length > cookiePath.length &&
                !cookiePath.endsWith('/') &&
                requestPath.charAt(cookiePath.length) !== '/'
            ) {
                return false
            }

            return true
        })
        .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))
}

export function parseSetCookie(
    raw: string,
    requestUrl: string,
    nowMs = Date.now()
): { cookie: Cookie; remove: boolean } | null {
    const parts = raw.split(';').map(part => part.trim())
    const first = parts.shift()
    if (!first) return null

    const equals = first.indexOf('=')
    if (equals <= 0) return null

    const request = new URL(requestUrl)
    const name = first.slice(0, equals).trim()
    const value = first.slice(equals + 1)
    let domain = request.hostname
    let cookiePath = defaultCookiePath(request.pathname)
    let expires = -1
    let secure = false
    let httpOnly = false
    let sameSite: Cookie['sameSite'] = 'Lax'
    let remove = false

    for (const attribute of parts) {
        const separator = attribute.indexOf('=')
        const attributeName = (separator < 0 ? attribute : attribute.slice(0, separator)).trim().toLowerCase()
        const attributeValue = separator < 0 ? '' : attribute.slice(separator + 1).trim()

        if (attributeName === 'domain' && attributeValue) domain = attributeValue.toLowerCase()
        else if (attributeName === 'path' && attributeValue) cookiePath = attributeValue
        else if (attributeName === 'secure') secure = true
        else if (attributeName === 'httponly') httpOnly = true
        else if (attributeName === 'expires' && attributeValue) {
            const parsed = Date.parse(attributeValue)
            if (Number.isFinite(parsed)) expires = parsed / 1000
        } else if (attributeName === 'max-age' && attributeValue) {
            const seconds = Number(attributeValue)
            if (Number.isFinite(seconds)) {
                if (seconds <= 0) remove = true
                else expires = nowMs / 1000 + seconds
            }
        } else if (attributeName === 'samesite') {
            const normalized = attributeValue.toLowerCase()
            if (normalized === 'strict') sameSite = 'Strict'
            else if (normalized === 'none') sameSite = 'None'
            else sameSite = 'Lax'
        }
    }

    if (expires !== -1 && expires <= nowMs / 1000) remove = true

    return {
        cookie: { name, value, domain, path: cookiePath, expires, httpOnly, secure, sameSite },
        remove
    }
}

export function defaultCookiePath(pathname: string): string {
    if (!pathname || !pathname.startsWith('/') || pathname === '/') return '/'
    const lastSlash = pathname.lastIndexOf('/')
    return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash)
}

export function splitCombinedSetCookieHeader(header: string): string[] {
    return header
        .split(/,(?=\s*[^;,=\s]+=[^;,]*)/g)
        .map(value => value.trim())
        .filter(Boolean)
}

export function buildCookieHeader(cookies: Cookie[], allowedDomains?: string[]): string {
    return cookies
        .filter(cookie => {
            if (!allowedDomains?.length) return true
            return allowedDomains.some(domain => cookie.domain.toLowerCase().endsWith(domain.toLowerCase()))
        })
        .map(cookie => `${cookie.name}=${cookie.value}`)
        .join('; ')
}
