import type { Page } from 'patchright'
import { URLs } from '../../constants/urls'
import type { MicrosoftRewardsBot } from '../../index'
import { emitRuntimeEvent } from '../../util/RuntimeEvents'
import type BrowserFunc from '../BrowserFunc'
import type { PageSnapshot, ParsedOffer } from '../ReactFunc'
import { readEarnPage } from '../parsers/EarnPageParser'
import { mergeRenderedEarn } from '../parsers/RenderedEarn'
import type { CookieJarSync } from './CookieJarSync'

export class RenderedEarnVerifier {
    constructor(
        private readonly bot: MicrosoftRewardsBot,
        private readonly cookies: CookieJarSync,
        private readonly host: BrowserFunc
    ) {}

    public async getRewardsPageHtml(url: string, route: string): Promise<string | null> {
        const direct = await this.fetchRewardsHtml(url, route)
        if (direct !== null) return direct

        const page = this.host.getActivePage()
        if (!page) return null

        try {
            const response = await page.request.get(url, { timeout: 20000 })
            if (response.ok()) {
                await this.host.syncActiveCookies(page, 'REWARDS-PAGE')
                return await response.text()
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'REWARDS-PAGE',
                `Failed to fetch ${route} | status=${response.status()}`
            )
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'REWARDS-PAGE',
                `Browser fetch failed for ${route} | ${error instanceof Error ? error.message : String(error)}`
            )
        }

        return null
    }

    public async withRewardsPage<T>(url: string, read: (page: Page) => Promise<T>): Promise<T | null> {
        const active = this.host.getActivePage()
        if (!active || active.isClosed()) return null
        let tab: Page | undefined
        try {
            tab = await this.bot.newBrowserPage(active.context())
            await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
            if (new URL(tab.url()).origin !== URLs.rewards.origin) return null
            await tab.locator('main').waitFor({ state: 'visible', timeout: 5000 })
            await tab
                .locator('#dailyset, #moreactivities, #quests, main h3')
                .first()
                .waitFor({ state: 'visible', timeout: 5000 })
                .catch(() => {})
            return await read(tab)
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'RENDERED-REWARDS',
                `Rendered verification unavailable | ${error instanceof Error ? error.message : String(error)}`
            )
            return null
        } finally {
            await tab?.close().catch(() => {})
        }
    }

    public async refreshEarnSnapshot(options?: { rendered?: boolean }): Promise<PageSnapshot | null> {
        const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
        const usePage = !!page && !page.isClosed()

        const fetchSnapshotPage = async (url: string, route: string): Promise<string | null> => {
            if (!usePage) return await this.fetchRewardsHtml(url, route)
            return await this.getRewardsPageHtml(url, route)
        }

        const pages = await Promise.all([
            fetchSnapshotPage(URLs.rewards.earn, '/earn'),
            fetchSnapshotPage(URLs.rewards.dashboard, '/dashboard')
        ])
        const availablePages = pages.filter((html): html is string => html !== null)

        let snapshot = availablePages.length ? this.bot.browser.react.snapshotPage(availablePages) : null
        if (options?.rendered) {
            const rendered = await this.host.withRewardsPage(URLs.rewards.earn, async tab => {
                const { cards, balance } = await readEarnPage(tab)
                const fresh = this.bot.browser.react.snapshotPage(await tab.content())
                fresh.account.availablePoints ??= balance
                fresh.renderedEarnAvailable = true
                fresh.unmatchedEarnCards = mergeRenderedEarn(fresh, cards, tab.url())
                fresh.morePromotionsAvailable ||= (await tab.locator('#moreactivities, #exploreonbing').count()) > 0
                this.bot.logger.info(
                    this.bot.isMobile,
                    'RENDERED-REWARDS',
                    `Earn verified | cards=${cards.length} | offers=${fresh.offers.length} | unmatched=${fresh.unmatchedEarnCards}`
                )
                return fresh
            })
            if (rendered) snapshot = rendered
            else if (snapshot) snapshot.renderedEarnAvailable = false
        }
        if (snapshot?.streakObservation) {
            emitRuntimeEvent('streakSnapshot', { ...snapshot.streakObservation })
            this.bot.logger.info(this.bot.isMobile, 'REWARDS-STREAK', JSON.stringify(snapshot.streakObservation))
        }
        return snapshot
    }

    public async fetchRewardsHtml(url: string, route: string): Promise<string | null> {
        try {
            const headers = { ...(this.bot.fingerprint?.headers ?? {}) }
            delete headers['Cookie']
            delete headers['cookie']

            const response = await this.bot.http.request<string>({
                url,
                method: 'GET',
                headers: {
                    ...headers,
                    Cookie: this.cookies.buildCookieHeader(this.cookies.getCachedCookies(undefined, url)),
                    Referer: URLs.rewards.referer,
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                },
                responseType: 'text'
            })

            await this.cookies.applyResponseCookies(url, response.headers['set-cookie'])
            return typeof response.data === 'string' ? response.data : null
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'EARN-SNAPSHOT',
                `Failed to fetch ${route} over http | ${error instanceof Error ? error.message : String(error)}`
            )
            return null
        }
    }

    public async ensureOffer(offerId: string): Promise<ParsedOffer | null> {
        const cached = this.bot.reactSnapshot?.offers.find(o => o.offerId === offerId)
        if (cached) return cached

        this.bot.logger.debug(
            this.bot.isMobile,
            'EARN-SNAPSHOT',
            `${offerId} absent from the cached snapshot (offers=${this.bot.reactSnapshot?.offers.length ?? 0}) - refetching /earn and /dashboard`
        )

        const refreshed = await this.host.refreshEarnSnapshot()
        if (!refreshed) return null

        if (!this.bot.reactSnapshot || refreshed.offers.length >= this.bot.reactSnapshot.offers.length) {
            this.bot.reactSnapshot = refreshed
        }

        const live = refreshed.offers.find(o => o.offerId === offerId) ?? null

        this.bot.logger.debug(
            this.bot.isMobile,
            'EARN-SNAPSHOT',
            `Refetched /earn and /dashboard | offers=${refreshed.offers.length} | ${offerId} found=${!!live}`
        )

        return live
    }
}
