import type { BrowserContext, Cookie, Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../index'
import type { AppDashboardData } from '../interface/AppDashBoardData'
import type { DashboardData } from '../interface/DashboardData'
import type { AppEarnablePoints, BrowserEarnablePoints } from '../interface/Points'
import { saveStorageState } from '../util/SessionStore'
import { isBrowserClosedError } from '../util/Utils'
import { markContextClosing } from './BrowserLifecycle'
import type { PageSnapshot, ParsedOffer } from './ReactFunc'
import type { ReliableValue } from './RewardsState'
import { AppEarnableClient } from './clients/AppEarnableClient'
import { CookieJarSync } from './clients/CookieJarSync'
import { RenderedEarnVerifier } from './clients/RenderedEarnVerifier'
import { RewardsDashboardClient } from './clients/RewardsDashboardClient'
import { RscBootstrapClient } from './clients/RscBootstrapClient'
import { ServerActionClient } from './clients/ServerActionClient'

export default class BrowserFunc {
    private bot: MicrosoftRewardsBot
    private cookieSync?: CookieJarSync
    private appClient?: AppEarnableClient
    private bootstrapClient?: RscBootstrapClient
    private serverActions?: ServerActionClient
    private earnVerifier?: RenderedEarnVerifier
    private dashboardClient?: RewardsDashboardClient

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
        this.ensureClients()
    }

    private ensureClients() {
        const cookieSync = (this.cookieSync ??= new CookieJarSync(this.bot))
        const appClient = (this.appClient ??= new AppEarnableClient(this.bot))
        const bootstrapClient = (this.bootstrapClient ??= new RscBootstrapClient(this.bot))
        const serverActions = (this.serverActions ??= new ServerActionClient(
            this.bot,
            cookieSync,
            bootstrapClient,
            this
        ))
        const earnVerifier = (this.earnVerifier ??= new RenderedEarnVerifier(this.bot, cookieSync, this))
        const dashboardClient = (this.dashboardClient ??= new RewardsDashboardClient(this.bot, cookieSync, this))
        return { cookieSync, appClient, bootstrapClient, serverActions, earnVerifier, dashboardClient }
    }

    get balanceReliability(): ReliableValue<number> {
        return this.ensureClients().dashboardClient.balanceReliability
    }

    set balanceReliability(value: ReliableValue<number>) {
        this.ensureClients().dashboardClient.balanceReliability = value
    }

    get quotaReliability(): ReliableValue<boolean> {
        return this.ensureClients().dashboardClient.quotaReliability
    }

    set quotaReliability(value: ReliableValue<boolean>) {
        this.ensureClients().dashboardClient.quotaReliability = value
    }

    public getActivePage(): Page | null {
        return this.ensureClients().cookieSync.getActivePage()
    }

    public async syncActiveCookies(page: Page, source: string, forcePersist = false): Promise<void> {
        return this.ensureClients().cookieSync.syncActiveCookies(page, source, forcePersist)
    }

    public cachedBalance(): ReliableValue<number> | null {
        return this.ensureClients().dashboardClient.cachedBalance()
    }

    public rememberBalance(value: unknown, source: string): void {
        return this.ensureClients().dashboardClient.rememberBalance(value, source)
    }

    get pointCache(): Map<string, ReliableValue<number>> {
        return this.ensureClients().dashboardClient.pointCache
    }

    public async dismissRewardsWelcomeDialog(page: Page, deadline = Date.now() + 10_000): Promise<void> {
        return this.ensureClients().bootstrapClient.dismissRewardsWelcomeDialog(page, deadline)
    }

    public async updateSearchCountersFromEarnPage(
        dashboard: DashboardData,
        cookies: Cookie[] | undefined,
        fingerprintHeaders: Record<string, string>
    ): Promise<void> {
        return this.ensureClients().dashboardClient.updateSearchCountersFromEarnPage(
            dashboard,
            cookies,
            fingerprintHeaders
        )
    }

    async getDashboardData(cookies?: Cookie[]): Promise<DashboardData> {
        return this.ensureClients().dashboardClient.getDashboardData(cookies)
    }

    async getAppDashboardData(channel: 'SAIOS' | 'SAAndroid' = 'SAIOS'): Promise<AppDashboardData> {
        return this.ensureClients().appClient.getAppDashboardData(channel)
    }

    async getBrowserEarnablePoints(data?: DashboardData): Promise<BrowserEarnablePoints> {
        return this.ensureClients().dashboardClient.getBrowserEarnablePoints(data)
    }

    async getAppEarnablePoints(): Promise<AppEarnablePoints> {
        return this.ensureClients().appClient.getAppEarnablePoints()
    }

    async getCurrentPoints(): Promise<number | null> {
        return this.ensureClients().dashboardClient.getCurrentPoints()
    }

    async bootstrap(page: Page): Promise<void> {
        return this.ensureClients().bootstrapClient.bootstrap(page)
    }

    async closeBrowser(browser: BrowserContext, email: string, persistSession = true): Promise<void> {
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

    async getRewardsPageHtml(url: string, route: string): Promise<string | null> {
        return this.ensureClients().earnVerifier.getRewardsPageHtml(url, route)
    }

    async checkpointActiveSession(source = 'SESSION-CHECKPOINT'): Promise<boolean> {
        return this.ensureClients().cookieSync.checkpointActiveSession(source)
    }

    async synchronizeActiveBrowserCookies(source: string, applyCached = false): Promise<boolean> {
        return this.ensureClients().cookieSync.synchronizeActiveBrowserCookies(source, applyCached)
    }

    buildCookieHeader(cookies: Cookie[], allowedDomains?: string[]): string {
        return this.ensureClients().cookieSync.buildCookieHeader(cookies, allowedDomains)
    }

    async reportServerAction(
        actionId: string,
        body: unknown[],
        opts?: { url?: string; referer?: string; routerStateTree?: string; browserFallback?: boolean }
    ): Promise<{ status: number; acknowledged: boolean; availablePoints: number | null }> {
        return this.ensureClients().serverActions.reportServerAction(actionId, body, opts)
    }

    async withRewardsPage<T>(url: string, read: (page: Page) => Promise<T>): Promise<T | null> {
        return this.ensureClients().earnVerifier.withRewardsPage(url, read)
    }

    async refreshEarnSnapshot(options?: { rendered?: boolean }): Promise<PageSnapshot | null> {
        return this.ensureClients().earnVerifier.refreshEarnSnapshot(options)
    }

    async ensureOffer(offerId: string): Promise<ParsedOffer | null> {
        return this.ensureClients().earnVerifier.ensureOffer(offerId)
    }
}
