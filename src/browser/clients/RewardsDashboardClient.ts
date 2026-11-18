import type { Cookie } from 'patchright'
import { URLs } from '../../constants/urls'
import type { MicrosoftRewardsBot } from '../../index'
import type { DashboardData, DashboardImpression } from '../../interface/DashboardData'
import type { BrowserEarnablePoints } from '../../interface/Points'
import { emitRuntimeEvent } from '../../util/RuntimeEvents'
import type BrowserFunc from '../BrowserFunc'
import {
    FlyoutAccountDataError,
    detectFlyoutBotWarning,
    mapFlyoutToDashboard,
    type RewardsFlyoutData
} from '../FlyoutDashboard'
import { finiteNonNegative, reliableValue, type ReliableValue } from '../RewardsState'
import type { CookieJarSync } from './CookieJarSync'

export class RewardsDashboardClient {
    public readonly pointCache = new Map<string, ReliableValue<number>>()
    private readonly bingDashboardRecovery = new Set<string>()
    public balanceReliability: ReliableValue<number> = reliableValue<number>(null, null, 'unknown')
    public quotaReliability: ReliableValue<boolean> = reliableValue<boolean>(null, null, 'unknown')

    constructor(
        private readonly bot: MicrosoftRewardsBot,
        private readonly cookies: CookieJarSync,
        private readonly host: BrowserFunc
    ) {}

    public async getDashboardData(cookies?: Cookie[]): Promise<DashboardData> {
        this.quotaReliability = reliableValue<boolean>(null, null, 'unknown')
        const fingerprintHeaders = { ...(this.bot.fingerprint?.headers ?? {}) }
        delete fingerprintHeaders['Cookie']
        delete fingerprintHeaders['cookie']

        let lastError: unknown
        const delays = [0, 1000, 3000]
        const deadline = Date.now() + 45_000

        for (let attempt = 0; attempt < delays.length && Date.now() < deadline; attempt++) {
            const delayMs = delays[attempt]
            if (delayMs) {
                await (this.bot.utils?.wait
                    ? this.bot.utils.wait(delayMs)
                    : new Promise(resolve => setTimeout(resolve, delayMs)))
            }
            try {
                const response = await this.bot.http.request<DashboardData>({
                    url: URLs.rewards.userInfoApi,
                    method: 'GET',
                    headers: {
                        ...fingerprintHeaders,
                        Cookie: this.cookies.buildCookieHeader(
                            this.cookies.getCachedCookies(cookies, URLs.rewards.userInfoApi)
                        ),
                        Referer: URLs.rewards.referer,
                        Origin: URLs.rewards.origin
                    },
                    retries: 0
                })

                await this.cookies.applyResponseCookies(URLs.rewards.userInfoApi, response.headers['set-cookie'])

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
                    this.host.getActivePage()
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
        this.bot.normalSession?.recordRuntimeError('GET-DASHBOARD-DATA', lastError ?? 'Rewards data unavailable')
        this.bot.logger.error(
            this.bot.isMobile,
            'GET-DASHBOARD-DATA',
            `Rewards data unavailable after recovery attempts | message=${this.errorMessage(lastError)}`
        )
        throw lastError instanceof Error ? lastError : new Error('Rewards data unavailable')
    }

    public async getBrowserEarnablePoints(data?: DashboardData): Promise<BrowserEarnablePoints> {
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

    public async getCurrentPoints(): Promise<number | null> {
        try {
            const data = await this.host.getDashboardData()
            const points = finiteNonNegative(data.dashboard.userStatus.availablePoints)
            if (points !== null) return points
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'GET-CURRENT-POINTS',
                `Dashboard sources unavailable | message=${error instanceof Error ? error.message : String(error)}`
            )
        }

        const refreshed = await this.host.refreshEarnSnapshot()
        const payloadPoints = finiteNonNegative(refreshed?.account.availablePoints)
        if (payloadPoints !== null) {
            this.rememberBalance(payloadPoints, 'rewards-rsc')
            return payloadPoints
        }

        const page = this.host.getActivePage()
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

        const cached = this.host.cachedBalance()
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
                Cookie: this.cookies.buildCookieHeader(
                    this.cookies.getCachedCookies(cookies, URLs.bing.rewardsFlyoutUserInfo)
                ),
                Referer: `${URLs.bing.origin}/`,
                Origin: URLs.bing.origin
            },
            retries: 0
        })

        await this.cookies.applyResponseCookies(URLs.bing.rewardsFlyoutUserInfo, response.headers['set-cookie'])

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

    public async updateSearchCountersFromEarnPage(
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
                    Cookie: this.cookies.buildCookieHeader(this.cookies.getCachedCookies(cookies, URLs.rewards.earn)),
                    Referer: URLs.rewards.referer
                },
                responseType: 'text',
                retries: 0
            })

            await this.cookies.applyResponseCookies(URLs.rewards.earn, response.headers['set-cookie'])
            const search = this.bot.browser.react.searchCountersFromEarnPage(response.data)
            if (!search) {
                this.quotaReliability = reliableValue<boolean>(null, 'rewards-rsc', 'unknown')
                this.bot.normalSession?.deferQuota()
                emitRuntimeEvent('quotaDeferred', {
                    reason: 'missing-points-counters',
                    platform: this.bot.isMobile ? 'mobile' : 'desktop'
                })
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
            const quotaPayload = {
                readAt: new Date().toISOString(),
                desktop: search.pc,
                mobile: search.mobile
            }
            this.bot.normalSession?.recordQuotaSnapshot(quotaPayload)
            emitRuntimeEvent('quotaSnapshot', quotaPayload)
            this.bot.logger.info(this.bot.isMobile, 'SMART-QUOTA', JSON.stringify(quotaPayload))
            this.bot.logger.info(
                this.bot.isMobile,
                'GET-DASHBOARD-DATA',
                `Search quota from Rewards earn page | desktop=${search.pc ? `${search.pc.progress}/${search.pc.max}` : 'not offered'}` +
                    ` | mobile=${search.mobile ? `${search.mobile.progress}/${search.mobile.max}` : 'not offered'}`
            )
        } catch (error) {
            this.quotaReliability = reliableValue<boolean>(null, 'rewards-rsc', 'unknown')
            this.bot.normalSession?.deferQuota()
            emitRuntimeEvent('quotaDeferred', { reason: 'earn-fetch-failed', message: this.errorMessage(error) })
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

    public rememberBalance(value: unknown, source: string): void {
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

    public cachedBalance(): ReliableValue<number> | null {
        const key = this.pointCacheKey()
        const cached = key ? this.pointCache.get(key) : undefined
        return cached ? { ...cached, freshness: 'stale' } : null
    }
}
