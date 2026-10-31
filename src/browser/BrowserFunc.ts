import { readEarnPage } from './parsers/EarnPageParser'
import { mergeRenderedEarn } from './parsers/RenderedEarn'
import { URLs } from '../constants/urls'
import { BING_APP_USER_AGENT } from '../constants/userAgents'
import type { BrowserContext, Cookie, Page } from 'patchright'
import type { HttpRequestConfig } from '../util/Http'

import type { MicrosoftRewardsBot } from '../index'
import type { PageSnapshot, ParsedOffer } from './ReactFunc'
import { loadSession, saveStorageState } from '../util/SessionStore'
import { isBrowserClosedError } from '../util/Utils'
import { markContextClosing } from './BrowserLifecycle'

import type { DashboardData, DashboardImpression } from './../interface/DashboardData'
import type { AppUserData } from '../interface/AppUserData'
import type { AppEarnablePoints, BrowserEarnablePoints } from '../interface/Points'
import type { AppDashboardData } from '../interface/AppDashBoardData'
import {
    detectFlyoutBotWarning,
    FlyoutAccountDataError,
    mapFlyoutToDashboard,
    type RewardsFlyoutData
} from './FlyoutDashboard'
import {
    classifyRewardsPage,
    finiteNonNegative,
    reliableValue,
    type ReliableValue,
    type RewardsPageState
} from './RewardsState'

export default class BrowserFunc {
    private bot: MicrosoftRewardsBot

    private rewardsDeploymentId = ''

    private bootstrapRecoveryInProgress = false
    private readonly pointCache = new Map<string, ReliableValue<number>>()
    private readonly bingDashboardRecovery = new Set<string>()
    public balanceReliability: ReliableValue<number> = reliableValue<number>(null, null, 'unknown')
    public quotaReliability: ReliableValue<boolean> = reliableValue<boolean>(null, null, 'unknown')

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    async getDashboardData(cookies?: Cookie[]): Promise<DashboardData> {
        this.quotaReliability = reliableValue<boolean>(null, null, 'unknown')
        const fingerprintHeaders = { ...(this.bot.fingerprint?.headers ?? {}) }
        delete fingerprintHeaders['Cookie']
        delete fingerprintHeaders['cookie']

        let lastError: unknown
        const delays = [0, 1000, 3000]
        const deadline = Date.now() + 45_000

        for (let attempt = 0; attempt < delays.length && Date.now() < deadline; attempt++) {
            if (delays[attempt]) await new Promise(resolve => setTimeout(resolve, delays[attempt]))
            try {
                const response = await this.bot.http.request<DashboardData>({
                    url: URLs.rewards.userInfoApi,
                    method: 'GET',
                    headers: {
                        ...fingerprintHeaders,
                        Cookie: this.buildCookieHeader(this.getCachedCookies(cookies, URLs.rewards.userInfoApi)),
                        Referer: URLs.rewards.referer,
                        Origin: URLs.rewards.origin
                    },
                    retries: 0
                })

                await this.applyResponseCookies(URLs.rewards.userInfoApi, response.headers['set-cookie'])

                const hasDashboard = Boolean(response.data?.dashboard)
                const hasUserStatus = Boolean(response.data?.dashboard?.userStatus)
                if (this.validDashboard(response.data)) {
                    await this.updateSearchCountersFromEarnPage(response.data, cookies, fingerprintHeaders)
                    this.rememberBalance(response.data.dashboard.userStatus.availablePoints, 'rewards-api')
                    return response.data
                }
                if (attempt === 0) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'GET-DASHBOARD-DATA',
                        `Dashboard response rejected | status=${response.status} | type=${typeof response.data}` +
                            ` | dashboard=${hasDashboard} | userStatus=${hasUserStatus}`
                    )
                }
                throw new Error('Dashboard API response is missing verified Rewards account data')
            } catch (error) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'GET-DASHBOARD-DATA',
                    `Primary dashboard attempt ${attempt + 1}/3 failed | message=${this.errorMessage(error)}`
                )
            }

            try {
                const dashboard = await this.getFlyoutDashboardData(cookies, fingerprintHeaders)
                this.rememberBalance(dashboard.dashboard.userStatus.availablePoints, 'bing-flyout')
                return dashboard
            } catch (error) {
                lastError = error
                const recoveryKey = this.pointCacheKey()
                if (
                    error instanceof FlyoutAccountDataError &&
                    !cookies &&
                    recoveryKey &&
                    !this.bingDashboardRecovery.has(recoveryKey) &&
                    !this.bot.shuttingDown &&
                    this.getActivePage()
                ) {
                    this.bingDashboardRecovery.add(recoveryKey)
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'GET-DASHBOARD-DATA',
                        'Rewards is signed in but Bing account data is unavailable; verifying the existing Bing session once'
                    )
                    if (await this.bot.recoverCurrentBingSession()) {
                        try {
                            const dashboard = await this.getFlyoutDashboardData(undefined, fingerprintHeaders)
                            this.rememberBalance(dashboard.dashboard.userStatus.availablePoints, 'bing-flyout')
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'GET-DASHBOARD-DATA',
                                'Rewards data recovered after Bing session verification'
                            )
                            return dashboard
                        } catch (recoveryError) {
                            lastError = recoveryError
                        }
                    }
                }
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'GET-DASHBOARD-DATA',
                    `Bing flyout attempt ${attempt + 1}/3 failed | message=${this.errorMessage(error)}`
                )
            }
        }

        const cached = this.cachedBalance()
        this.balanceReliability = cached ?? reliableValue<number>(null, null, 'unknown')
        this.bot.logger.error(
            this.bot.isMobile,
            'GET-DASHBOARD-DATA',
            `Rewards data unavailable after recovery attempts | message=${this.errorMessage(lastError)}`
        )
        throw lastError instanceof Error ? lastError : new Error('Rewards data unavailable')
    }

    private async getFlyoutDashboardData(
        cookies: Cookie[] | undefined,
        fingerprintHeaders: Record<string, string>
    ): Promise<DashboardData> {
        const response = await this.bot.http.request<RewardsFlyoutData>({
            url: URLs.bing.rewardsFlyoutUserInfo,
            method: 'GET',
            headers: {
                ...fingerprintHeaders,
                Accept: 'application/json',
                Cookie: this.buildCookieHeader(this.getCachedCookies(cookies, URLs.bing.rewardsFlyoutUserInfo)),
                Referer: `${URLs.bing.origin}/`,
                Origin: URLs.bing.origin
            },
            retries: 0
        })

        await this.applyResponseCookies(URLs.bing.rewardsFlyoutUserInfo, response.headers['set-cookie'])

        if (!response.data?.userInfo?.isRewardsUser || !response.data?.flyoutResult?.userStatus?.isRewardsUser) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'GET-DASHBOARD-DATA',
                `Flyout response rejected | status=${response.status} | type=${typeof response.data}` +
                    ` | userInfo=${Boolean(response.data?.userInfo)} | profile=${Boolean(response.data?.userInfo?.profile)}` +
                    ` | rewardsUser=${response.data?.userInfo?.isRewardsUser === true}` +
                    ` | flyout=${Boolean(response.data?.flyoutResult)} | flyoutRewardsUser=${response.data?.flyoutResult?.userStatus?.isRewardsUser === true}`
            )
        }

        const detection = detectFlyoutBotWarning(response.data)
        this.bot.logger.debug(
            this.bot.isMobile,
            'GET-DASHBOARD-DATA',
            `Using partial Bing flyout dashboard | suspectedLimited=${detection.likelyLimited} | botMarkers=${detection.hasBotProfileMarkers} | activitiesCollapsed=${detection.hasCollapsedActivities}`
        )
        const dashboard = mapFlyoutToDashboard(response.data)
        await this.updateSearchCountersFromEarnPage(dashboard, cookies, fingerprintHeaders)
        return dashboard
    }

    private async updateSearchCountersFromEarnPage(
        dashboard: DashboardData,
        cookies: Cookie[] | undefined,
        fingerprintHeaders: Record<string, string>
    ): Promise<void> {
        try {
            const response = await this.bot.http.request<string>({
                url: URLs.rewards.earn,
                method: 'GET',
                headers: {
                    ...fingerprintHeaders,
                    Accept: 'text/html,application/xhtml+xml',
                    Cookie: this.buildCookieHeader(this.getCachedCookies(cookies, URLs.rewards.earn)),
                    Referer: URLs.rewards.referer
                },
                responseType: 'text',
                retries: 0
            })

            await this.applyResponseCookies(URLs.rewards.earn, response.headers['set-cookie'])
            const search = this.bot.browser.react.searchCountersFromEarnPage(response.data)
            if (!search) {
                this.quotaReliability = reliableValue<boolean>(null, 'rewards-rsc', 'unknown')
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'GET-DASHBOARD-DATA',
                    'Rewards earn page has no parseable pointsCounters; search quota remains unavailable'
                )
                return
            }

            const impression = (offerId: string, counter: { max: number; progress: number }): DashboardImpression =>
                ({ offerId, pointProgress: counter.progress, pointProgressMax: counter.max }) as DashboardImpression
            const counters = dashboard.dashboard.userStatus.counters
            counters.pcSearch = search.pc ? [impression('PCSearch', search.pc)] : []
            counters.mobileSearch = search.mobile ? [impression('MobileSearch', search.mobile)] : []
            this.quotaReliability = reliableValue(true, 'rewards-rsc', 'fresh')
            this.bot.logger.info(
                this.bot.isMobile,
                'SMART-QUOTA',
                JSON.stringify({
                    readAt: new Date().toISOString(),
                    desktop: search.pc,
                    mobile: search.mobile
                })
            )
            this.bot.logger.info(
                this.bot.isMobile,
                'GET-DASHBOARD-DATA',
                `Search quota from Rewards earn page | desktop=${search.pc ? `${search.pc.progress}/${search.pc.max}` : 'not offered'}` +
                    ` | mobile=${search.mobile ? `${search.mobile.progress}/${search.mobile.max}` : 'not offered'}`
            )
        } catch (error) {
            this.quotaReliability = reliableValue<boolean>(null, 'rewards-rsc', 'unknown')
            this.bot.logger.warn(
                this.bot.isMobile,
                'GET-DASHBOARD-DATA',
                `Could not read search quota from Rewards earn page | message=${this.errorMessage(error)}`
            )
        }
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error)
    }

    async getAppDashboardData(channel: 'SAIOS' | 'SAAndroid' = 'SAIOS'): Promise<AppDashboardData> {
        try {
            const request: HttpRequestConfig = {
                url: URLs.platform.me(channel),
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${this.bot.accessToken}`,
                    'User-Agent': BING_APP_USER_AGENT,
                    'X-Rewards-Country': this.bot.userData.geoLocale,
                    'X-Rewards-Language': this.bot.userData.langCode,
                    'X-Rewards-IsMobile': 'true'
                }
            }

            const response = await this.bot.http.request(request)
            return response.data as AppDashboardData
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-APP-DASHBOARD-DATA',
                `Error fetching dashboard data: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    async getBrowserEarnablePoints(data?: DashboardData): Promise<BrowserEarnablePoints> {
        try {
            data ??= await this.getDashboardData()

            const desktopSearchPoints =
                data.dashboard.userStatus.counters.pcSearch?.reduce(
                    (sum: number, x: { pointProgressMax: number; pointProgress: number }) =>
                        sum + (x.pointProgressMax - x.pointProgress),
                    0
                ) ?? 0

            const mobileSearchPoints =
                data.dashboard.userStatus.counters.mobileSearch?.reduce(
                    (sum: number, x: { pointProgressMax: number; pointProgress: number }) =>
                        sum + (x.pointProgressMax - x.pointProgress),
                    0
                ) ?? 0

            const todayDate = this.bot.utils.getFormattedDate()
            const dailySetPoints =
                data.dashboard.dailySetPromotions[todayDate]?.reduce(
                    (sum: number, x: { pointProgressMax: number; pointProgress: number }) =>
                        sum + (x.pointProgressMax - x.pointProgress),
                    0
                ) ?? 0

            const morePromotionsPoints =
                data.dashboard.morePromotions?.reduce((sum, x) => {
                    if (x.promotionType === 'urlreward' && x.exclusiveLockedFeatureStatus !== 'locked') {
                        return sum + (x.pointProgressMax - x.pointProgress)
                    }
                    return sum
                }, 0) ?? 0

            const totalEarnablePoints = desktopSearchPoints + mobileSearchPoints + dailySetPoints + morePromotionsPoints

            return {
                dailySetPoints,
                morePromotionsPoints,
                desktopSearchPoints,
                mobileSearchPoints,
                totalEarnablePoints
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-BROWSER-EARNABLE-POINTS',
                `An error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    async getAppEarnablePoints(): Promise<AppEarnablePoints> {
        try {
            const eligibleOffers = ['ENUS_readarticle3_30points', 'Gamification_Sapphire_DailyCheckIn']

            const request: HttpRequestConfig = {
                url: URLs.platform.me('SAAndroid'),
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${this.bot.accessToken}`,
                    'X-Rewards-Country': this.bot.userData.geoLocale,
                    'X-Rewards-Language': this.bot.userData.langCode,
                    'X-Rewards-ismobile': 'true'
                }
            }

            const response = await this.bot.http.request<AppUserData>(request)
            const userData: AppUserData = response.data
            const eligibleActivities = userData.response.promotions.filter(x =>
                eligibleOffers.includes(x.attributes.offerid ?? '')
            )

            let readToEarn = 0
            let checkIn = 0

            for (const item of eligibleActivities) {
                const attrs = item.attributes

                if (attrs.type === 'msnreadearn') {
                    const pointMax = parseInt(attrs.pointmax ?? '0')
                    const pointProgress = parseInt(attrs.pointprogress ?? '0')
                    readToEarn = Math.max(0, pointMax - pointProgress)
                } else if (attrs.type === 'checkin') {
                    const progress = parseInt(attrs.progress ?? '0')
                    const checkInDay = progress % 7
                    const lastUpdated = new Date(attrs.last_updated ?? '')
                    const today = new Date()

                    if (checkInDay < 6 && today.getDate() !== lastUpdated.getDate()) {
                        checkIn = parseInt(attrs[`day_${checkInDay + 1}_points`] ?? '0')
                    }
                }
            }

            const totalEarnablePoints = readToEarn + checkIn

            return {
                readToEarn,
                checkIn,
                totalEarnablePoints
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-APP-EARNABLE-POINTS',
                `An error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    async getCurrentPoints(): Promise<number | null> {
        try {
            const data = await this.getDashboardData()
            const points = finiteNonNegative(data.dashboard.userStatus.availablePoints)
            if (points !== null) return points
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'GET-CURRENT-POINTS',
                `Dashboard sources unavailable | message=${error instanceof Error ? error.message : String(error)}`
            )
        }

        // A cached bootstrap snapshot is display data, not a new balance observation.
        const refreshed = await this.refreshEarnSnapshot()
        const payloadPoints = finiteNonNegative(refreshed?.account.availablePoints)
        if (payloadPoints !== null) {
            this.rememberBalance(payloadPoints, 'rewards-rsc')
            return payloadPoints
        }

        const page = this.getActivePage()
        if (page) {
            const selectors = [
                '[data-testid="available-points"]',
                '[aria-label*="Available points"]',
                '[aria-label*="Rewards points"]'
            ]
            for (const selector of selectors) {
                const text = await page
                    .locator(selector)
                    .first()
                    .textContent({ timeout: 750 })
                    .catch(() => null)
                const normalized = text?.replace(/[^\d]/g, '') ?? ''
                const points = normalized ? Number(normalized) : Number.NaN
                if (Number.isFinite(points) && points >= 0) {
                    this.rememberBalance(points, 'rewards-dom')
                    return points
                }
            }
        }

        const cached = this.cachedBalance()
        this.balanceReliability = cached ?? reliableValue<number>(null, null, 'unknown')
        this.bot.logger.warn(
            this.bot.isMobile,
            'GET-CURRENT-POINTS',
            cached
                ? 'Current balance unavailable; retaining previous balance as stale display data'
                : 'Current balance unavailable'
        )
        return null
    }

    private validDashboard(data: DashboardData | null | undefined): data is DashboardData {
        if (!data?.dashboard?.userStatus || !data.dashboard.userProfile) return false
        return Boolean(
            data.dashboard.userStatus.isRewardsUser !== false &&
            finiteNonNegative(data.dashboard.userStatus.availablePoints) !== null
        )
    }

    private pointCacheKey(): string | null {
        const email = this.bot.currentAccountEmail?.trim().toLowerCase()
        if (!email) return null
        const platform = this.bot.isMobile ? 'mobile' : 'desktop'
        return `${email}|${platform}|${new Date().toISOString().slice(0, 10)}`
    }

    private rememberBalance(value: unknown, source: string): void {
        const points = finiteNonNegative(value)
        if (points === null) return
        const result = reliableValue(points, source, 'fresh')
        this.balanceReliability = result
        const key = this.pointCacheKey()
        if (key) this.pointCache.set(key, result)
        this.bot.logger.info(
            this.bot.isMobile,
            'REWARDS-STATE',
            `balance=${points} | balanceStatus=fresh | balanceSource=${source} | quotaStatus=${this.quotaReliability.freshness} | readAt=${result.readAt} | account=${this.bot.currentAccountEmail ?? 'unknown'}`
        )
    }

    private cachedBalance(): ReliableValue<number> | null {
        const key = this.pointCacheKey()
        const cached = key ? this.pointCache.get(key) : undefined
        return cached ? { ...cached, freshness: 'stale' } : null
    }

    async bootstrap(page: Page): Promise<void> {
        const deadline = Date.now() + 45_000
        const delays = [0, 1000, 3000]
        let lastState: RewardsPageState = 'loading'
        let lastError: unknown

        for (let attempt = 0; attempt < delays.length && Date.now() < deadline; attempt++) {
            if (delays[attempt]) await new Promise(resolve => setTimeout(resolve, delays[attempt]))
            try {
                const navigationTimeout = Math.max(250, Math.min(15_000, deadline - Date.now()))
                if (attempt === 0)
                    await page.goto(URLs.rewards.earn, { waitUntil: 'domcontentloaded', timeout: navigationTimeout })
                else
                    await page
                        .reload({ waitUntil: 'domcontentloaded', timeout: navigationTimeout })
                        .catch(() => undefined)
                await this.dismissRewardsWelcomeDialog(page, deadline)

                const earnDom = await page.content()
                const earnRaw = await this.fetchBootstrapHtml(page, URLs.rewards.earn, '/earn', deadline)
                const dashboardHtml = await this.fetchBootstrapHtml(
                    page,
                    URLs.rewards.dashboard,
                    '/dashboard',
                    deadline
                )
                const sources = [earnRaw, earnDom, dashboardHtml].filter(Boolean)
                const combined = sources.join('\n')
                const snapshot = this.bot.browser.react.snapshotPage(sources)
                const actions = await this.resolveActionIds(page, sources, deadline)

                lastState = classifyRewardsPage({
                    url: page.url(),
                    html: combined,
                    snapshot,
                    actionCount: Object.keys(actions).length,
                    rewardsAccountConfirmed: /["']isRewardsUser["']\s*:\s*true/i.test(combined)
                })

                if (lastState === 'rewards-ready' || lastState === 'rewards-partial') {
                    this.rewardsDeploymentId = this.bot.browser.react.buildId(earnRaw || earnDom) ?? ''
                    this.bot.nextRouterStateTree = this.bot.browser.react.routerStateTree('earn')
                    this.bot.reactSnapshot = snapshot
                    if (this.bot.isMobile) this.bot.reactSnapshots.mobile = snapshot
                    else this.bot.reactSnapshots.desktop = snapshot
                    this.bot.nextActions = actions

                    if (!snapshot.offers.length) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'BOOTSTRAP',
                            'Rewards account confirmed with no offers; offer-dependent tasks will be skipped'
                        )
                    }
                    if (!Object.keys(actions).length) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'BOOTSTRAP',
                            'Rewards data is partial; server-action-dependent tasks will be deferred'
                        )
                    }
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'BOOTSTRAP',
                        `Context ready | state=${lastState} | actions=${Object.keys(actions).length} | reportable=${snapshot.reportable.length} | available=${snapshot.account.availablePoints}`
                    )
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'BUILD',
                        `Rewards build | id=${this.rewardsDeploymentId || 'unknown'}`,
                        'cyan'
                    )
                    return
                }
            } catch (error) {
                lastError = error
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'BOOTSTRAP',
                `Context attempt ${attempt + 1}/3 incomplete | state=${lastState} | error=${lastError ? this.errorMessage(lastError) : 'none'}`
            )
        }

        if (!this.bootstrapRecoveryInProgress) {
            this.bootstrapRecoveryInProgress = true
            try {
                if (await this.bot.refreshCurrentRewardsContext(`bootstrap-${lastState}`)) return
            } finally {
                this.bootstrapRecoveryInProgress = false
            }
        }

        const message = `Rewards context unavailable after recovery | state=${lastState} | error=${lastError ? this.errorMessage(lastError) : 'none'}`
        this.bot.logger.error(this.bot.isMobile, 'BOOTSTRAP', message)
        throw new Error(message)
    }

    /**
     * Dismisses the first-time welcome modal on /earn, which otherwise
     * prevents section#dailyset from rendering.
     */
    private async dismissRewardsWelcomeDialog(page: Page, deadline = Date.now() + 10_000): Promise<void> {
        try {
            // New accounts see a welcome dialog with a Get started button,
            // whereas older Rewards layouts expose a close-slot button.
            // Limit the text match to the welcome dialog so unrelated actions
            // (including consent or redemption) cannot be activated here.
            const welcomeDialog = typeof page.getByRole === 'function'
                ? page.getByRole('dialog').filter({ hasText: /welcome to\s+microsoft rewards/i }).first()
                : null
            if (welcomeDialog && await welcomeDialog.isVisible().catch(() => false)) {
                const getStarted = welcomeDialog.getByRole('button', { name: /^get started$/i }).first()
                if (await getStarted.isVisible().catch(() => false)) {
                    await getStarted.click({ timeout: Math.max(250, Math.min(5000, deadline - Date.now())) })
                    this.bot.logger.info(this.bot.isMobile, 'BOOTSTRAP', 'Dismissed welcome dialog with Get started')
                    return
                }
            }
            const welcomeButton = await page
                .waitForSelector('section[role="dialog"] button[slot="close"]', {
                    timeout: Math.max(250, Math.min(5000, deadline - Date.now()))
                })
                .catch(() => null)
            if (!welcomeButton) return

            await welcomeButton.click({ timeout: Math.max(250, Math.min(5000, deadline - Date.now())) })
            this.bot.logger.info(this.bot.isMobile, 'BOOTSTRAP', 'Dismissed welcome dialog')

            await page
                .waitForLoadState('domcontentloaded', {
                    timeout: Math.max(250, Math.min(5000, deadline - Date.now()))
                })
                .catch(() => undefined)
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'BOOTSTRAP',
                `Failed to dismiss welcome dialog: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async fetchBootstrapHtml(
        page: Page,
        url: string,
        route: string,
        deadline = Date.now() + 20_000
    ): Promise<string> {
        try {
            const res = await page.request.get(url, { timeout: Math.max(250, Math.min(20_000, deadline - Date.now())) })
            if (res.ok()) return await res.text()

            this.bot.logger.warn(
                this.bot.isMobile,
                'BOOTSTRAP',
                `Failed to fetch ${route} HTML | status=${res.status()} - snapshot and action discovery may be incomplete`
            )
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'BOOTSTRAP',
                `Failed to fetch ${route} HTML | error=${error instanceof Error ? error.message : String(error)} - snapshot and action discovery may be incomplete`
            )
        }

        return ''
    }

    private async resolveActionIds(
        page: Page,
        htmls: string[],
        deadline = Date.now() + 20_000
    ): Promise<Record<string, string>> {
        const result: Record<string, string> = {}

        try {
            const initialChunks = new Set<string>()
            const chunkRegex = /(?:\/_next\/)?(static\/(?:chunks|immutable|media)\/[\w\-./()]+?\.js)/g
            for (const html of htmls) {
                if (!html) continue
                for (const match of html.matchAll(chunkRegex)) {
                    initialChunks.add('/_next/' + match[1]!)
                }
            }

            if (initialChunks.size === 0) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'BOOTSTRAP',
                    'No initial chunks discovered in HTML - chunk reference shape may have changed'
                )
            }

            this.bot.logger.debug(this.bot.isMobile, 'BOOTSTRAP', `Fetching ${initialChunks.size} initial JS chunks`)
            const jsByPath = await this.fetchJsChunks(page, [...initialChunks], deadline)

            const dynamicPaths = new Set<string>()
            for (const js of jsByPath.values()) {
                for (const path of this.extractDynamicChunkPaths(js)) {
                    if (!jsByPath.has(path)) dynamicPaths.add(path)
                }
            }

            if (dynamicPaths.size) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'BOOTSTRAP',
                    `Fetching ${dynamicPaths.size} dynamic chunks discovered via webpack manifest`
                )
                const moreJs = await this.fetchJsChunks(page, [...dynamicPaths], deadline)
                for (const [path, js] of moreJs) jsByPath.set(path, js)
            }

            for (const [path, js] of jsByPath) {
                const filename = path.split('/').pop() ?? path
                const ids = this.bot.browser.react.extractActionIds(js)
                const names = Object.keys(ids.byName)

                if (names.length) {
                    Object.assign(result, ids.byName)
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'BOOTSTRAP',
                        `Found ${names.length} action id(s) in ${filename}: [${names.join(', ')}]`
                    )
                } else {
                    this.bot.logger.debug(this.bot.isMobile, 'BOOTSTRAP', `No server-action ids found in ${filename}`)
                }

                const namedSet = new Set(Object.values(ids.byName))
                const unnamed = ids.all.filter(id => !namedSet.has(id))
                if (unnamed.length) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'BOOTSTRAP',
                        `Found ${unnamed.length} unnamed action id(s) in ${filename}: [${unnamed.join(', ')}]`
                    )
                }
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'BOOTSTRAP',
                `Discovered ${Object.keys(result).length} action ids: [${Object.keys(result).join(', ')}]`
            )
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'BOOTSTRAP',
                `Failed resolving action ids | error=${error instanceof Error ? error.message : String(error)}`
            )
        }

        return result
    }

    private async fetchJsChunks(page: Page, paths: string[], deadline: number): Promise<Map<string, string>> {
        const result = new Map<string, string>()

        await Promise.all(
            paths.map(async path => {
                try {
                    const res = await page.request.get(URLs.rewards.path(path), {
                        timeout: Math.max(250, Math.min(10_000, deadline - Date.now()))
                    })
                    if (res.ok()) {
                        result.set(path, await res.text())
                    }
                } catch (error) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'BOOTSTRAP',
                        `Chunk fetch failed | path=${path} | ${error instanceof Error ? error.message : String(error)}`
                    )
                }
            })
        )

        return result
    }

    private extractDynamicChunkPaths(js: string): string[] {
        const seen = new Set<string>()

        // Webpack builder
        const builder = /static\/chunks\/"\s*\+\s*\w+\s*\+\s*"([-.])"\s*\+\s*\{([\s\S]*?)\}\s*\[/g
        for (const match of js.matchAll(builder)) {
            const sep = match[1]!
            for (const [, id, hash] of match[2]!.matchAll(/(\d+)\s*:\s*"([a-f0-9]+)"/g)) {
                seen.add(`/_next/static/chunks/${id}${sep}${hash}.js`)
            }
        }

        // Webpack fallback
        for (const [, id, hash] of js.matchAll(/\b(\d{2,6}):"([a-f0-9]{12,})"/g)) {
            seen.add(`/_next/static/chunks/${id}-${hash}.js`)
            seen.add(`/_next/static/chunks/${id}.${hash}.js`)
        }

        // Turbopack
        const turbopackRegex = /"(static\/(?:immutable|chunks|media)\/[\w\-./()]+?\.js)"/g
        for (const match of js.matchAll(turbopackRegex)) {
            seen.add(`/_next/${match[1]}`)
        }

        return [...seen]
    }

    async closeBrowser(browser: BrowserContext, email: string, persistSession = true) {
        const rootBrowser = browser.browser?.() || null

        try {
            if (persistSession) {
                const storageState = await browser.storageState()
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'CLOSE-BROWSER',
                    `Saving session | cookies=${storageState.cookies.length} | origins=${storageState.origins.length}`
                )
                saveStorageState(this.bot.config.sessionPath, email, this.bot.isMobile, storageState)
            }
        } catch (error) {
            if (isBrowserClosedError(error)) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'CLOSE-BROWSER',
                    `Session not saved (browser already closing): ${error instanceof Error ? error.message : String(error)}`
                )
            } else {
                this.bot.logger.error(this.bot.isMobile, 'CLOSE-BROWSER', `Failed to save session: ${error}`)
            }
        } finally {
            try {
                markContextClosing(browser)
                await browser.close()

                if (rootBrowser) {
                    await rootBrowser.close().catch(() => {})
                }

                this.bot.logger.info(this.bot.isMobile, 'CLOSE-BROWSER', 'All browser resources closed.')
            } catch (error) {
                if (isBrowserClosedError(error)) {
                    this.bot.logger.debug(this.bot.isMobile, 'CLOSE-BROWSER', 'Browser was already closed.')
                } else {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'CLOSE-BROWSER',
                        'Shutdown encountered an error, but process exiting.'
                    )
                }
            }
        }
    }

    private getActivePage(): Page | null {
        const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
        return page && !page.isClosed() ? page : null
    }

    async getRewardsPageHtml(url: string, route: string): Promise<string | null> {
        const direct = await this.fetchRewardsHtml(url, route)
        if (direct !== null) return direct

        const page = this.getActivePage()
        if (!page) return null

        try {
            const response = await page.request.get(url, { timeout: 20000 })
            if (response.ok()) {
                await this.syncActiveCookies(page, 'REWARDS-PAGE')
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

    private getCachedCookies(explicitCookies?: Cookie[], targetUrl?: string): Cookie[] {
        const cookies = explicitCookies ?? (this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop)
        return targetUrl ? this.filterCookiesForUrl(cookies, targetUrl) : cookies
    }

    async checkpointActiveSession(source = 'SESSION-CHECKPOINT'): Promise<boolean> {
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

    async synchronizeActiveBrowserCookies(source: string, applyCached = false): Promise<boolean> {
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

    private updateCookieCache(liveCookies: Cookie[], source: string): boolean {
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

    private async syncActiveCookies(page: Page, source: string, forcePersist = false): Promise<void> {
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

    private filterCookiesForUrl(cookies: Cookie[], targetUrl: string): Cookie[] {
        const url = new URL(targetUrl)
        const host = url.hostname.toLowerCase()
        const requestPath = url.pathname || '/'
        const now = Date.now() / 1000

        return cookies
            .filter(cookie => {
                if (cookie.expires !== -1 && cookie.expires <= now) return false
                if (cookie.secure && url.protocol !== 'https:') return false

                const domain = cookie.domain.replace(/^\./, '').toLowerCase()
                if (host !== domain && !host.endsWith(`.${domain}`)) return false

                const cookiePath = cookie.path || '/'
                if (!requestPath.startsWith(cookiePath)) return false
                if (
                    requestPath.length > cookiePath.length &&
                    !cookiePath.endsWith('/') &&
                    requestPath.charAt(cookiePath.length) !== '/'
                )
                    return false

                return true
            })
            .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))
    }

    private async applyResponseCookies(requestUrl: string, setCookieHeader?: string[] | string): Promise<void> {
        if (!setCookieHeader) return

        const rawCookies = Array.isArray(setCookieHeader)
            ? setCookieHeader
            : this.splitCombinedSetCookieHeader(setCookieHeader)
        if (!rawCookies.length) return

        const current = this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop
        const updated = [...current]
        let changed = false

        for (const raw of rawCookies) {
            const parsed = this.parseSetCookie(raw, requestUrl)
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

    private parseSetCookie(raw: string, requestUrl: string): { cookie: Cookie; remove: boolean } | null {
        const parts = raw.split(';').map(part => part.trim())
        const first = parts.shift()
        if (!first) return null

        const equals = first.indexOf('=')
        if (equals <= 0) return null

        const request = new URL(requestUrl)
        const name = first.slice(0, equals).trim()
        const value = first.slice(equals + 1)
        let domain = request.hostname
        let cookiePath = this.defaultCookiePath(request.pathname)
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
                    else expires = Date.now() / 1000 + seconds
                }
            } else if (attributeName === 'samesite') {
                const normalized = attributeValue.toLowerCase()
                if (normalized === 'strict') sameSite = 'Strict'
                else if (normalized === 'none') sameSite = 'None'
                else sameSite = 'Lax'
            }
        }

        if (expires !== -1 && expires <= Date.now() / 1000) remove = true

        return {
            cookie: { name, value, domain, path: cookiePath, expires, httpOnly, secure, sameSite },
            remove
        }
    }

    private defaultCookiePath(pathname: string): string {
        if (!pathname || !pathname.startsWith('/') || pathname === '/') return '/'
        const lastSlash = pathname.lastIndexOf('/')
        return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash)
    }

    private splitCombinedSetCookieHeader(header: string): string[] {
        return header
            .split(/,(?=\s*[^;,=\s]+=[^;,]*)/g)
            .map(value => value.trim())
            .filter(Boolean)
    }

    buildCookieHeader(cookies: Cookie[], allowedDomains?: string[]): string {
        return cookies
            .filter(cookie => {
                if (!allowedDomains?.length) return true
                return allowedDomains.some(domain => cookie.domain.toLowerCase().endsWith(domain.toLowerCase()))
            })
            .map(cookie => `${cookie.name}=${cookie.value}`)
            .join('; ')
    }

    // Fire a nextjs RSC server action shared by UrlReward / ClaimReward / ClaimBonusPoints
    async reportServerAction(
        actionId: string,
        body: unknown[],
        opts?: { url?: string; referer?: string; routerStateTree?: string; browserFallback?: boolean }
    ): Promise<{ status: number; acknowledged: boolean; availablePoints: number | null }> {
        const url = opts?.url ?? URLs.rewards.earn
        const referer = opts?.referer ?? url
        const routerStateTree = opts?.routerStateTree ?? this.bot.nextRouterStateTree

        const fingerprintHeaders = { ...this.bot.fingerprint.headers }
        delete fingerprintHeaders['Cookie']
        delete fingerprintHeaders['cookie']

        const headers = {
            ...fingerprintHeaders,
            Referer: referer,
            Origin: URLs.rewards.origin,
            Accept: 'text/x-component',
            'Content-Type': 'text/plain;charset=UTF-8',
            'Next-Action': actionId,
            'Next-Router-State-Tree': routerStateTree,
            ...(this.rewardsDeploymentId ? { 'X-Deployment-Id': this.rewardsDeploymentId } : {})
        }

        let response
        try {
            response = await this.bot.http.request({
                url,
                method: 'POST',
                headers: {
                    ...headers,
                    Cookie: this.buildCookieHeader(this.getCachedCookies(undefined, url))
                },
                data: JSON.stringify(body)
            })
        } catch (error) {
            const status = (error as { status?: number }).status
            const page = this.getActivePage()
            if (!opts?.browserFallback || status !== 503 || !page) throw error
            this.bot.logger.warn(
                this.bot.isMobile,
                'SERVER-ACTION',
                'HTTP transport returned 503; retrying once through the active browser context'
            )
            // Reuse this account's browser proxy and cookie jar; never fall back to a direct connection.
            const browserResponse = await page.request.post(url, {
                headers,
                data: JSON.stringify(body),
                timeout: 20000
            })
            if (!browserResponse.ok()) {
                throw new Error(`Browser server action failed with status code ${browserResponse.status()}`)
            }
            await this.syncActiveCookies(page, 'SERVER-ACTION')
            const payload = await browserResponse.text()
            return {
                status: browserResponse.status(),
                acknowledged: this.bot.utils.serverActionAcknowledged(payload),
                availablePoints: this.bot.browser.react.availablePointsFromPayload(payload)
            }
        }
        await this.applyResponseCookies(url, response.headers['set-cookie'])

        return {
            status: response.status,
            acknowledged: this.bot.utils.serverActionAcknowledged(response.data),
            availablePoints: this.bot.browser.react.availablePointsFromPayload(response.data)
        }
    }

    /** Read through an isolated tab in the existing account context and always close it. */
    async withRewardsPage<T>(url: string, read: (page: Page) => Promise<T>): Promise<T | null> {
        const active = this.getActivePage()
        if (!active || active.isClosed()) return null
        let tab: Page | undefined
        try {
            tab = await this.bot.newBrowserPage(active.context())
            await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
            if (new URL(tab.url()).origin !== URLs.rewards.origin) return null
            await tab.locator('main').waitFor({ state: 'visible', timeout: 5000 })
            await tab.locator('#dailyset, #moreactivities, #quests, main h3').first()
                .waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
            return await read(tab)
        } catch (error) {
            this.bot.logger.debug(this.bot.isMobile, 'RENDERED-REWARDS',
                `Rendered verification unavailable | ${error instanceof Error ? error.message : String(error)}`)
            return null
        } finally {
            await tab?.close().catch(() => {})
        }
    }

    async refreshEarnSnapshot(options?: { rendered?: boolean }): Promise<PageSnapshot | null> {
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
            const rendered = await this.withRewardsPage(URLs.rewards.earn, async page => {
                const { cards, balance } = await readEarnPage(page)
                // Scrolling can deliver more Flight chunks; parse after the DOM read.
                const fresh = this.bot.browser.react.snapshotPage(await page.content())
                fresh.account.availablePoints ??= balance
                fresh.unmatchedEarnCards = mergeRenderedEarn(fresh, cards, page.url())
                fresh.morePromotionsAvailable ||= await page.locator('#moreactivities, #exploreonbing').count() > 0
                this.bot.logger.info(this.bot.isMobile, 'RENDERED-REWARDS',
                    `Earn verified | cards=${cards.length} | offers=${fresh.offers.length} | unmatched=${fresh.unmatchedEarnCards}`)
                return fresh
            })
            if (rendered) snapshot = rendered
        }
        return snapshot
    }

    private async fetchRewardsHtml(url: string, route: string): Promise<string | null> {
        try {
            const headers = { ...(this.bot.fingerprint?.headers ?? {}) }
            delete headers['Cookie']
            delete headers['cookie']

            const response = await this.bot.http.request<string>({
                url,
                method: 'GET',
                headers: {
                    ...headers,
                    Cookie: this.buildCookieHeader(this.getCachedCookies(undefined, url)),
                    Referer: URLs.rewards.referer,
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                },
                responseType: 'text'
            })

            await this.applyResponseCookies(url, response.headers['set-cookie'])
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

    async ensureOffer(offerId: string): Promise<ParsedOffer | null> {
        const cached = this.bot.reactSnapshot?.offers.find(o => o.offerId === offerId)
        if (cached) return cached

        this.bot.logger.debug(
            this.bot.isMobile,
            'EARN-SNAPSHOT',
            `${offerId} absent from the cached snapshot (offers=${this.bot.reactSnapshot?.offers.length ?? 0}) - refetching /earn and /dashboard`
        )

        const refreshed = await this.refreshEarnSnapshot()
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
