import { learningQuery } from '../../../util/Learning'
import { emitRuntimeEvent } from '../../../util/RuntimeEvents'
import { waitForActivity, waitForSearch } from '../../../util/ActivityTiming'
import type { Page } from 'patchright'

import { URLs } from '../../../constants/urls'
import { SearchQueryQueue } from '../../SearchQueryQueue'
import { BaseActivity } from '../BaseActivity'
import { BonusTracker } from './BonusTracker'
import { AiSearch, aiSearchChoice } from './AiSearch'
import { SearchProgress } from './SearchProgress'
import type { SearchTracker } from '../../../interface/Search'
import type { MissingSearchPoints } from '../../../interface/Points'
import type { MicrosoftRewardsBot } from '../../../index'

const REFRESH_EVERY = 10
const MAX_QUERY_ATTEMPTS = 5

const POINTS_MAX_SEARCHES = 100
const POINTS_STAGNANT_LIMIT = 10
const ZERO_POINT_PROBE_SEARCHES = 3

const SEARCH_BOX = '#sb_form_q'

interface SessionStats {
    totalGained: number
    performed: number
    stagnant: number
}

export class Search extends BaseActivity {
    private searchCount = 0
    private aiUnavailable = false

    public async doUncountedQuery(page: Page, query: string, isMobile: boolean): Promise<boolean> {
        const aiConfirmed = await this.bingSearch(page, query, isMobile, 'warmup')
        if (typeof aiConfirmed === 'boolean') return aiConfirmed
        const url = new URL(page.url())
        if (
            !['www.bing.com', 'bing.com'].includes(url.hostname) ||
            !['/search', '/copilotsearch'].includes(url.pathname) ||
            url.searchParams.get('q') !== query
        )
            throw new Error('Bing search result was not confirmed')
        await page
            .locator(url.pathname === '/copilotsearch' ? '#b_copilot_results' : '#b_results')
            .waitFor({ state: 'visible', timeout: 15000 })
        return true
    }

    public async doSearch(page: Page, isMobile: boolean, budget?: number): Promise<number> {
        const startBalance = Number(this.bot.userData.currentPoints ?? 0)
        if (budget != null) emitRuntimeEvent('searchStart', { platform: isMobile ? 'mobile' : 'desktop', budget })
        this.bot.logger.info(isMobile, 'SEARCH-BING', `Starting Bing searches | currentBalance=${startBalance}`)

        const tracker = new PointsTracker(this.bot, isMobile, budget)
        try {
            const stats = await this.runSearchSession(page, isMobile, tracker)

            if (stats.performed >= tracker.maxSearches && !tracker.done()) {
                this.bot.logger.warn(
                    isMobile,
                    tracker.context,
                    `Hit the ${tracker.maxSearches}-search ceiling | ${tracker.progress()}`
                )
            }

            this.bot.logger.info(
                isMobile,
                tracker.context,
                `Completed Bing searches | pointsGained=${stats.totalGained} | currentBalance=${this.bot.userData.currentPoints} | previousBalance=${startBalance} | searches=${stats.performed} | ${tracker.progress()}`
            )
            if (budget != null) {
                const payload = {
                    platform: isMobile ? 'mobile' : 'desktop',
                    budget,
                    queries: stats.performed,
                    points: stats.totalGained,
                    remaining: tracker.remaining,
                    quotaAvailable: tracker.quotaAvailable
                }
                emitRuntimeEvent('searchProgress', payload)
                this.bot.logger.info(
                    isMobile,
                    'SMART-SEARCH-END',
                    `platform=${payload.platform} | budget=${budget} | queries=${stats.performed} | points=${stats.totalGained} | remaining=${tracker.remaining} | quotaAvailable=${tracker.quotaAvailable}`
                )
            }
            return stats.totalGained
        } finally {
            await page.goto(URLs.bing.origin).catch(() => {})
        }
    }

    public async doBonusSearches(page: Page): Promise<number> {
        const isMobile = this.bot.isMobile
        const tracker = new BonusTracker(this.bot, isMobile)

        const stats = await this.runSearchSession(page, isMobile, tracker)

        if (!tracker.started) return 0

        const done = tracker.done() && !tracker.offerLost
        const reason = done
            ? 'offer complete'
            : tracker.offerLost
              ? 'offer no longer present'
              : stats.performed >= tracker.maxSearches
                ? 'reached maxBonusSearches'
                : stats.stagnant >= tracker.stagnantLimit
                  ? `${tracker.stagnantLimit} idle searches`
                  : 'query pool exhausted'

        this.bot.logger.info(
            isMobile,
            tracker.context,
            `Bonus farming ${done ? 'complete' : 'stopped'} (${reason}) | pointsGained=${stats.totalGained} | currentBalance=${this.bot.userData.currentPoints} | ${tracker.progress()} | searches=${stats.performed}`,
            done || stats.totalGained > 0 ? 'green' : undefined
        )
        return stats.totalGained
    }

    private async runSearchSession(page: Page, isMobile: boolean, tracker: SearchTracker): Promise<SessionStats> {
        const stats: SessionStats = { totalGained: 0, performed: 0, stagnant: 0 }

        try {
            const ready = await tracker.prepare()
            if (!ready) return stats

            const queryQueue = new SearchQueryQueue(this.bot)
            const topicCount = await queryQueue.prepare()
            if (!topicCount) {
                this.bot.logger.warn(isMobile, tracker.context, 'No main search topics available, skipping')
                return stats
            }
            this.bot.logger.info(
                isMobile,
                tracker.context,
                `Query queue ready | mainTopics=${topicCount} | clusterSearch=${this.bot.config.searchSettings.clusterSearch}`
            )

            await this.bot.browser.func.synchronizeActiveBrowserCookies('SEARCH-COOKIE-SEED', true)
            await page.goto(URLs.bing.origin)
            await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
            await this.bot.browser.utils.tryDismissAllMessages(page)

            while (
                !this.bot.normalSession?.searchBlocked &&
                !tracker.done() &&
                stats.performed < tracker.maxSearches &&
                stats.stagnant < tracker.stagnantLimit
            ) {
                const query = await queryQueue.next()
                if (!query) {
                    this.bot.logger.warn(isMobile, tracker.context, 'Query queue exhausted, stopping')
                    break
                }

                await this.bot.browser.func.synchronizeActiveBrowserCookies('SEARCH-COOKIE-SEED', true)
                await this.bingSearch(page, query, isMobile, /bonus/i.test(tracker.context) ? 'bonus' : 'normal')
                stats.performed++

                await this.bot.browser.func.synchronizeActiveBrowserCookies('SEARCH-COOKIE-CAPTURE')
                const gained = await tracker.measure()
                if (gained > 0) {
                    stats.stagnant = 0
                    stats.totalGained += gained
                    this.bot.logger.info(
                        isMobile,
                        tracker.context,
                        `pointsGained=${gained} | currentBalance=${this.bot.userData.currentPoints} | query="${query}" | ${tracker.progress()}`,
                        'green'
                    )
                } else {
                    stats.stagnant++
                    this.bot.logger.info(
                        isMobile,
                        tracker.context,
                        `no points ${stats.stagnant}/${tracker.stagnantLimit} | query="${query}" | ${tracker.progress()}`
                    )
                }
            }

            return stats
        } catch (error) {
            this.bot.normalSession?.recordRuntimeError(tracker.context, error)
            this.bot.logger.error(
                isMobile,
                tracker.context,
                `Search session error | ${error instanceof Error ? error.message : String(error)}`
            )
            return stats
        }
    }
    private async bingSearch(
        page: Page,
        query: string,
        isMobile: boolean,
        kind: 'normal' | 'warmup' | 'bonus' = 'normal'
    ): Promise<boolean | void> {
        this.searchCount++
        if (
            this.bot.config.searchSettings.aiSearch === true &&
            !this.aiUnavailable &&
            kind !== 'bonus' &&
            ['accountSession', 'warmup'].includes(this.bot.executionPlan?.type ?? '')
        ) {
            const choice = aiSearchChoice()
            if (choice.ai) {
                const confirmed = await new AiSearch(this.bot).run(page, query, isMobile, kind, choice)
                this.aiUnavailable = !confirmed
                return confirmed
            }
        }
        if (this.bot.config.searchSettings.aiSearch === true && new URL(page.url()).pathname === '/copilotsearch')
            await page.goto(URLs.bing.origin)

        if (this.searchCount % REFRESH_EVERY === 0) {
            await page.goto(URLs.bing.origin)
            await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
            await this.bot.browser.utils.tryDismissAllMessages(page)
        }

        for (let attempt = 1; attempt <= (this.bot.normalSession?.active ? 1 : MAX_QUERY_ATTEMPTS); attempt++) {
            try {
                const searchBox = page.locator(SEARCH_BOX)

                if (typeof this.bot.browser.utils.cursor === 'function') {
                    await this.bot.browser.utils.cursor(page).scrollTo('top', { scrollSpeed: 70, scrollDelay: 100 })
                } else {
                    await page.evaluate(() => window.scrollTo({ left: 0, top: 0, behavior: 'auto' }))
                }
                await page.keyboard.press('Home')
                await searchBox.waitFor({ state: 'visible', timeout: 15000 })

                await waitForActivity(this.bot, 1000)
                await this.bot.browser.utils.ghostClick(page, SEARCH_BOX, { clickCount: 3 })
                await searchBox.fill('')

                if (this.bot.executionPlan?.urgent) await page.locator('#sb_form_q').fill(query)
                else await page.keyboard.type(query, { delay: this.bot.utils.randomDelay(45, 90) })
                if (this.bot.executionPlan?.urgent || this.bot.normalSession?.active) {
                    await learningQuery(kind, isMobile, async () => {
                        const ready = page.waitForURL(url => url.searchParams.get('q') === query, {
                            waitUntil: 'domcontentloaded',
                            timeout: 15000
                        })
                        await Promise.all([ready, page.keyboard.press('Enter')])
                        await page.locator('#b_results').waitFor({ state: 'visible', timeout: 15000 })
                    })
                } else await learningQuery(kind, isMobile, () => page.keyboard.press('Enter'))
                await waitForActivity(this.bot, 3000)

                await this.browseResults(page, isMobile)

                await waitForSearch(
                    this.bot,
                    this.bot.utils.randomDelay(
                        this.bot.config.searchSettings.searchDelay.min,
                        this.bot.config.searchSettings.searchDelay.max
                    )
                )

                return
            } catch (error) {
                if (this.bot.normalSession?.active || (error as { code?: string })?.code === 'DAILY_SEARCH_CAP')
                    throw error
                this.bot.logger.warn(
                    isMobile,
                    'SEARCH-BING',
                    `Search attempt ${attempt}/${MAX_QUERY_ATTEMPTS} failed | query="${query}" | ${error instanceof Error ? error.message : String(error)}`
                )
                if (attempt === MAX_QUERY_ATTEMPTS) throw error
                await waitForActivity(this.bot, 2000)
            }
        }
    }

    public async browseResults(page: Page, isMobile: boolean): Promise<void> {
        const settings = this.bot.config.searchSettings
        if (!settings.scrollRandomResults && !settings.clickRandomResults) return
        let opened: Page | undefined
        let candidate: import('patchright').ElementHandle<Node> | null = null
        let oldTarget: string | null = null
        try {
            const cursor = this.bot.browser.utils.cursor(page)
            if (settings.scrollRandomResults) {
                for (let i = 0; i < 2; i++) {
                    await cursor.scroll(
                        { y: this.bot.utils.randomDelay(180, 360) },
                        { scrollSpeed: 65, scrollDelay: 200 }
                    )
                    await waitForActivity(this.bot, this.bot.utils.randomDelay(500, 1200))
                }
            }
            if (!settings.clickRandomResults || this.bot.shuttingDown) return
            const links = await page.locator('#b_results > .b_algo h2 a[href]').elementHandles()
            const eligible = []
            for (const link of links) {
                const safe = await link
                    .evaluate(el => {
                        const a = el as HTMLAnchorElement
                        const rect = a.getBoundingClientRect()
                        let url: URL
                        try {
                            url = new URL(a.href)
                        } catch {
                            return false
                        }
                        return (
                            rect.width > 0 &&
                            rect.height > 0 &&
                            rect.top >= 0 &&
                            rect.bottom <= innerHeight &&
                            ['http:', 'https:'].includes(url.protocol) &&
                            !/(^|\.)bing\.com$/i.test(url.hostname) &&
                            !/\.(?:exe|msi|apk|zip|rar|7z|pdf|dmg)(?:$|[?#])/i.test(url.pathname) &&
                            !a.hasAttribute('download') &&
                            !a.closest('[data-text-ad], .b_ad, .b_adTop, .b_adBottom')
                        )
                    })
                    .catch(() => false)
                if (safe) eligible.push(link)
            }
            if (!eligible.length) return
            candidate = eligible[Math.floor(Math.random() * eligible.length)]!
            oldTarget = await candidate.getAttribute('target')
            await candidate.evaluate(el => (el as Element).setAttribute('target', '_blank'))
            const popup = page.waitForEvent('popup', { timeout: 7000 }).catch(() => undefined)
            await cursor.click(candidate as any, { moveDelay: 100, waitForClick: 80 }) // eslint-disable-line @typescript-eslint/no-explicit-any
            opened = await popup
            if (!opened) return
            await opened.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {})
            if (opened.isClosed() || this.bot.shuttingDown) return
            const destinationCursor = this.bot.browser.utils.cursor(opened)
            for (let i = 0; i < 2 && !opened.isClosed() && !this.bot.shuttingDown; i++) {
                await destinationCursor.scroll(
                    { y: this.bot.utils.randomDelay(160, 350) },
                    { scrollSpeed: 65, scrollDelay: 200 }
                )
                await waitForActivity(this.bot, this.bot.utils.randomDelay(1000, 2000))
            }
        } catch (error) {
            this.bot.logger.warn(
                isMobile,
                'SEARCH-BROWSE',
                `Result browsing skipped | ${error instanceof Error ? error.message : String(error)}`
            )
        } finally {
            if (candidate)
                await candidate
                    .evaluate(
                        (el, target) =>
                            target === null
                                ? (el as Element).removeAttribute('target')
                                : (el as Element).setAttribute('target', target),
                        oldTarget
                    )
                    .catch(() => {})
            if (opened && !opened.isClosed()) await opened.close().catch(() => {})
        }
    }
}

class PointsTracker implements SearchTracker {
    public readonly context = 'SEARCH-BING'
    public get maxSearches(): number {
        const cap = this.probingZeroPoints ? ZERO_POINT_PROBE_SEARCHES : POINTS_MAX_SEARCHES
        return Math.min(cap, this.budget ?? cap)
    }
    public get stagnantLimit(): number {
        return this.probingZeroPoints ? ZERO_POINT_PROBE_SEARCHES : POINTS_STAGNANT_LIMIT
    }

    private missing: MissingSearchPoints = { mobilePoints: 0, desktopPoints: 0, edgePoints: 0, totalPoints: 0 }
    private probingZeroPoints = false
    private hasObservedPositiveQuota = false
    private readonly runOnZeroPoints: boolean
    private readonly searchProgress: SearchProgress
    public remaining = 0
    public quotaAvailable = false

    constructor(
        private bot: MicrosoftRewardsBot,
        private isMobile: boolean,
        private readonly budget?: number
    ) {
        this.runOnZeroPoints =
            !this.bot.normalSession?.active && (this.bot.config.searchSettings.runOnZeroPoints ?? false)
        this.searchProgress = new SearchProgress(this.bot)
    }

    async prepare(): Promise<boolean> {
        const snapshot = await this.searchProgress.getSnapshot(this.isMobile)
        this.missing = snapshot.missing
        this.remaining = this.missing.totalPoints
        this.quotaAvailable = snapshot.quotaAvailable
        this.probingZeroPoints =
            this.runOnZeroPoints && this.missing.totalPoints <= 0 && (!this.quotaAvailable || this.budget == null)
        this.hasObservedPositiveQuota = this.missing.totalPoints > 0
        this.bot.logger.info(
            this.isMobile,
            this.context,
            `Search points remaining | edge=${this.missing.edgePoints} | desktop=${this.missing.desktopPoints} | mobile=${this.missing.mobilePoints}`
        )

        if (this.bot.normalSession?.active && !this.quotaAvailable) return false
        if (this.missing.totalPoints <= 0) {
            if (this.quotaAvailable && this.budget != null) {
                this.bot.logger.info(
                    this.isMobile,
                    this.context,
                    'Search quota is confirmed complete; skipping smart search session'
                )
                return false
            }
            if (!this.runOnZeroPoints) {
                this.bot.logger.info(
                    this.isMobile,
                    this.context,
                    'No search points to earn, skipping (runOnZeroPoints is disabled)'
                )
                return false
            }
            this.bot.logger.info(
                this.isMobile,
                this.context,
                `No search points reported; probing up to ${ZERO_POINT_PROBE_SEARCHES} searches because runOnZeroPoints is enabled`
            )
        }
        return true
    }

    async measure(): Promise<number> {
        const snapshot = await this.searchProgress.getSnapshot(this.isMobile)
        if (!snapshot.quotaAvailable) {
            this.quotaAvailable = false
            if (this.bot.normalSession?.active) this.bot.normalSession.stopSearch()
            return 0
        }
        const updated = snapshot.missing
        const gained = Math.max(0, this.missing.totalPoints - updated.totalPoints)
        this.missing = updated
        this.remaining = updated.totalPoints
        this.quotaAvailable ||= snapshot.quotaAvailable
        if (updated.totalPoints > 0) {
            this.probingZeroPoints = false
            this.hasObservedPositiveQuota = true
        }

        if (gained > 0) {
            this.bot.userData.currentPoints = Number(this.bot.userData.currentPoints ?? 0) + gained
            this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gained
        }
        return gained
    }

    done(): boolean {
        if (this.budget != null && this.quotaAvailable && this.missing.totalPoints <= 0) return true
        return this.missing.totalPoints <= 0 && (!this.runOnZeroPoints || this.hasObservedPositiveQuota)
    }

    progress(): string {
        return `remaining=${this.missing.totalPoints}`
    }
}
