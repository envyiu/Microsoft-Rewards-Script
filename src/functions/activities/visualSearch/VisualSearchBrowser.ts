import type { BrowserContext, Page } from 'patchright'

import { URLs } from '../../../constants/urls'
import type { MicrosoftRewardsBot } from '../../../index'

const STATIC_SEED_URL = 'https://th.bing.com/th?id=OMR.VisualSearch.VNext.BackgroundImage.png&pid=Rewards'
const ARCHIVE_SIZE = 8

export interface VisualSearchCandidate {
    bcid: string
    query: string
    serpUrl: string
}

export interface VisualSearchReport {
    acknowledged: boolean
    ig: string | null
    balance: number | null
    previousBalance: number | null
    gained: number | null
    searchPointsEarned: number | null
    searchPointsLimit: number | null
}

interface ParsedReport {
    balance: number | null
    previousBalance: number | null
    searchPointsEarned: number | null
    searchPointsLimit: number | null
}

export class VisualSearchBrowser {
    private acquisitionContext: BrowserContext | null = null

    constructor(private readonly bot: MicrosoftRewardsBot) {}

    public async report(candidate: VisualSearchCandidate): Promise<VisualSearchReport> {
        const sourcePage = this.bot.mainDesktopPage
        if (!sourcePage || sourcePage.isClosed()) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'VISUAL-SEARCH-REPORT',
                'Desktop page is unavailable - cannot run the visual-search browser flow'
            )
            return this.emptyReport()
        }

        let visualPage: Page | null = null
        try {
            visualPage = await this.bot.newBrowserPage(sourcePage.context())
            const responsePromise = visualPage
                .waitForResponse(
                    response => {
                        if (response.request().method() !== 'POST') return false
                        try {
                            const url = new URL(response.url())
                            return (
                                url.origin === URLs.bing.origin &&
                                url.pathname.toLowerCase() === '/rewardsapp/reportactivity' &&
                                url.searchParams.get('bcid') === candidate.bcid
                            )
                        } catch {
                            return false
                        }
                    },
                    { timeout: 20000 }
                )
                .catch(() => null)

            await visualPage.goto(candidate.serpUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
            const response = await responsePromise
            if (!response) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'VISUAL-SEARCH-REPORT',
                    `Bing did not issue reportActivity for "${candidate.query}" | bcid=${candidate.bcid.slice(0, 12)}`
                )
                return this.emptyReport()
            }

            const ig = new URL(response.url()).searchParams.get('IG')
            const acknowledged = response.ok()
            const parsed = this.parseReport(await response.text())
            const gained =
                parsed.balance !== null && parsed.previousBalance !== null
                    ? parsed.balance - parsed.previousBalance
                    : null

            this.bot.logger.debug(
                this.bot.isMobile,
                'VISUAL-SEARCH-REPORT',
                `Browser reported "${candidate.query}" | status=${response.status()}` +
                    ` | acknowledged=${acknowledged} | ig=${ig ?? 'n/a'} | bcid=${candidate.bcid.slice(0, 12)}` +
                    ` | pointsGained=${gained ?? 'n/a'} | currentBalance=${parsed.balance ?? 'n/a'}` +
                    ` | searchPts=${parsed.searchPointsEarned ?? 'n/a'}/${parsed.searchPointsLimit ?? 'n/a'}`
            )

            return { acknowledged, ig, ...parsed, gained }
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'VISUAL-SEARCH-REPORT',
                `Browser flow failed for "${candidate.query}" | ${
                    error instanceof Error ? error.message : String(error)
                }`
            )
            return this.emptyReport()
        } finally {
            await visualPage?.close().catch(() => {})
        }
    }

    public async acquire(imageUrl?: string): Promise<VisualSearchCandidate | null> {
        try {
            const page = this.bot.mainDesktopPage
            if (!page || page.isClosed()) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'VISUAL-SEARCH-BCID',
                    'Desktop page is unavailable - cannot acquire a visual search'
                )
                return null
            }

            const seed = imageUrl ?? (await this.getSeedUrls())[0] ?? STATIC_SEED_URL
            const headers = { ...(this.bot.fingerprint?.headers ?? {}) }
            delete headers['Cookie']
            delete headers['cookie']

            const acquisitionContext = await this.getAcquisitionContext(page)
            if (!acquisitionContext) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'VISUAL-SEARCH-BCID',
                    'Browser is unavailable - cannot create an isolated visual-search context'
                )
                return null
            }

            // Match Bing's current public "paste image URL" flow. The former
            // /images/kblob transport now rejects this request shape with 400.
            const url = new URL('/images/search', URLs.bing.origin)
            url.search = new URLSearchParams({
                view: 'detailv2',
                iss: 'sbi',
                form: 'SBIVSP',
                sbisrc: 'UrlPaste',
                q: `imgurl:${seed}`,
                idpbck: '1',
                vsimg: seed
            }).toString()

            const response = await acquisitionContext.request.get(url.toString(), {
                headers: {
                    ...headers,
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    Referer: `${URLs.bing.origin}/visualsearch`,
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'same-origin'
                },
                timeout: 20000
            })

            const resultUrl = new URL(response.url())
            const bcid = resultUrl.searchParams.get('bcid')
            if (!bcid) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'VISUAL-SEARCH-BCID',
                    `Bing visual search returned no bcid | status=${response.status()} | path=${resultUrl.pathname}`
                )
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'VISUAL-SEARCH-BCID',
                    `Visual-search result URL: ${resultUrl.toString().slice(0, 500)}`
                )
                return null
            }

            const query = resultUrl.searchParams.get('q') ?? ''
            this.bot.logger.info(
                this.bot.isMobile,
                'VISUAL-SEARCH-BCID',
                `Acquired bcid=${bcid.slice(0, 14)} | q="${query}" | status=${response.status()}` +
                    ` | seed=${seed.slice(0, 80)}`,
                'green'
            )
            return { bcid, query, serpUrl: resultUrl.toString() }
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'VISUAL-SEARCH-BCID',
                `Failed to acquire visual search | ${error instanceof Error ? error.message : String(error)}`
            )
            return null
        }
    }

    private async getAcquisitionContext(sourcePage: Page): Promise<BrowserContext | null> {
        if (this.acquisitionContext) return this.acquisitionContext

        const browser = sourcePage.context().browser()
        if (!browser) return null

        // An authenticated Bing cookie jar redirects this URL to /images and
        // strips bcid. Keep acquisition anonymous, then report the resulting
        // bcid from the authenticated browser context in report().
        const context = await browser.newContext({
            userAgent: this.bot.fingerprint.fingerprint.navigator.userAgent,
            locale: this.bot.accountLocale.locale,
            extraHTTPHeaders: {
                'Accept-Language': this.bot.accountLocale.acceptLanguage
            },
            ignoreHTTPSErrors: this.bot.config.proxy.ignoreCertificateErrors
        })
        this.acquisitionContext = context
        context.once('close', () => {
            if (this.acquisitionContext === context) this.acquisitionContext = null
        })

        this.bot.logger.debug(
            this.bot.isMobile,
            'VISUAL-SEARCH-BCID',
            'Created an isolated cookie-free context for visual-search acquisition'
        )
        return context
    }

    public async getSeedUrls(): Promise<string[]> {
        const page = this.bot.mainDesktopPage
        if (!page || page.isClosed()) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'VISUAL-SEARCH-BCID',
                'Desktop page is unavailable - using the static visual-search seed'
            )
            return [STATIC_SEED_URL]
        }

        try {
            const response = await page.request.get(
                `${URLs.bing.origin}/HPImageArchive.aspx?format=js&idx=0&n=${ARCHIVE_SIZE}` +
                    `&mkt=${encodeURIComponent(this.bot.accountLocale.locale)}`,
                { timeout: 10000 }
            )
            if (response.ok()) {
                const payload = (await response.json()) as { images?: { url?: unknown }[] }
                const seeds = (payload.images ?? []).flatMap(image => {
                    if (typeof image.url !== 'string' || !image.url) return []
                    try {
                        return [new URL(image.url, URLs.bing.origin).toString()]
                    } catch {
                        return []
                    }
                })
                const uniqueSeeds = [...new Set(seeds)]
                if (uniqueSeeds.length) {
                    this.bot.utils.shuffleArray(uniqueSeeds)
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'VISUAL-SEARCH-BCID',
                        `Prepared ${uniqueSeeds.length} randomized Bing wallpaper seed(s)`
                    )
                    return uniqueSeeds
                }
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'VISUAL-SEARCH-BCID',
                `HPImageArchive returned no usable urls | status=${response.status()} - using the static seed`
            )
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'VISUAL-SEARCH-BCID',
                `HPImageArchive lookup failed | ${error instanceof Error ? error.message : String(error)}` +
                    ' - using the static seed'
            )
        }

        return [STATIC_SEED_URL]
    }

    private parseReport(data: unknown): ParsedReport {
        if (typeof data !== 'string') return this.emptyParsedReport()
        const match = data.match(/ModernRewards\.ReportActivity\((\{[\s\S]*?\})\)\s*;/)
        if (!match) return this.emptyParsedReport()

        try {
            const session = JSON.parse(match[1] ?? '{}').RewardsSessionData ?? {}
            const numberOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null)
            return {
                balance: numberOrNull(session.Balance),
                previousBalance: numberOrNull(session.PreviousBalance),
                searchPointsEarned: numberOrNull(session.DailySearchPointsEarned),
                searchPointsLimit: numberOrNull(session.DailySearchPointsLimit)
            }
        } catch {
            return this.emptyParsedReport()
        }
    }

    private emptyReport(): VisualSearchReport {
        return {
            acknowledged: false,
            ig: null,
            ...this.emptyParsedReport(),
            gained: null
        }
    }

    private emptyParsedReport(): ParsedReport {
        return {
            balance: null,
            previousBalance: null,
            searchPointsEarned: null,
            searchPointsLimit: null
        }
    }
}
