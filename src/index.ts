import cluster from 'cluster'
import type { BrowserContext, Cookie, Page } from 'patchright'
import pkg from '../package.json'

import Browser from './browser/Browser'
import BrowserFunc from './browser/BrowserFunc'
import { markContextClosing } from './browser/BrowserLifecycle'
import BrowserUtils from './browser/BrowserUtils'
import ReactFunc, { type PageSnapshot } from './browser/ReactFunc'
import { Login } from './browser/auth/Login'
import Activities from './functions/Activities'
import { SearchManager } from './functions/activities/search/SearchManager'
import type { Account } from './interface/Account'
import type { BrowserIdentitySnapshot } from './interface/BrowserIdentity'
import type { DashboardData } from './interface/DashboardData'
import { loadExecutionPlan, type ExecutionPlan, type SmartWorker } from './interface/ExecutionPlan'
import { Logger } from './logging/Logger'
import { handleFatalBootstrapError, runCliEntrypoint } from './runtime/CliEntrypoint'
import { ClusterCoordinator, flushAllWebhooks, formatMetric, sumKnown } from './runtime/ClusterCoordinator'
import {
    SessionContext,
    executionContext,
    getCurrentContext,
    type AccountRunResult,
    type AccountStats,
    type BrowserSession,
    type ExecutionContext,
    type UserData
} from './runtime/SessionContext'
import { runConservativeAccountSession, runStandardAccountFlow, runWarmupAccountSession } from './runtime/SessionRunner'
import HttpClient from './util/Http'
import { loadAccounts, loadConfig } from './util/Load'
import { resolveAccountLocale, type AccountLocale } from './util/Locale'
import { NormalSession, setNormalSession } from './util/NormalSession'
import { emitRuntimeEvent } from './util/RuntimeEvents'
import { loadResolvedRegion, saveStorageState } from './util/SessionStore'
import Utils from './util/Utils'

export { executionContext, getCurrentContext, type ExecutionContext }

export class MicrosoftRewardsBot {
    public shuttingDown = false
    private readonly liveContexts = new Map<BrowserContext, { email: string; isMobile: boolean }>()
    public sessionContext?: SessionContext

    public logger: Logger
    public config
    public utils: Utils
    public activities: Activities = new Activities(this)
    public browser: { func: BrowserFunc; utils: BrowserUtils; react: ReactFunc }

    public mainMobilePage!: Page
    public mainDesktopPage!: Page

    public accountLocale: AccountLocale

    private browserFactory: Browser = new Browser(this)
    private accounts: Account[] = []
    private searchManager: SearchManager
    private login = new Login(this)
    private clusterCoordinator: ClusterCoordinator
    public readonly executionPlan: ExecutionPlan | null
    public readonly normalSession: NormalSession

    public http!: HttpClient

    constructor() {
        this.sessionContext = new SessionContext()
        this.accountLocale = resolveAccountLocale({ langCode: 'en', geoLocale: 'US' })
        this.logger = new Logger(this)
        this.utils = new Utils()
        this.searchManager = new SearchManager(this)
        this.browser = {
            func: new BrowserFunc(this),
            utils: new BrowserUtils(this),
            react: new ReactFunc(this)
        }
        this.config = loadConfig()
        this.executionPlan = loadExecutionPlan()
        this.normalSession = new NormalSession(this.executionPlan)
        setNormalSession(this.normalSession)
        if (this.executionPlan) this.applyExecutionPlan(this.executionPlan)
        this.clusterCoordinator = new ClusterCoordinator(this)
    }

    private ctx(): SessionContext {
        return (this.sessionContext ??= new SessionContext())
    }

    get userData(): UserData {
        return this.ctx().userData
    }
    set userData(value: UserData) {
        this.ctx().userData = value
    }
    get nextActions(): Record<string, string> {
        return this.ctx().nextActions
    }
    set nextActions(value: Record<string, string>) {
        this.ctx().nextActions = value
    }
    get nextRouterStateTree(): string {
        return this.ctx().nextRouterStateTree
    }
    set nextRouterStateTree(value: string) {
        this.ctx().nextRouterStateTree = value
    }
    get morePromotionsVerified(): boolean {
        return this.ctx().morePromotionsVerified
    }
    set morePromotionsVerified(value: boolean) {
        this.ctx().morePromotionsVerified = value
    }
    get punchCardsVerified(): boolean {
        return this.ctx().punchCardsVerified
    }
    set punchCardsVerified(value: boolean) {
        this.ctx().punchCardsVerified = value
    }
    get dailySetVerified(): boolean {
        return this.ctx().dailySetVerified
    }
    set dailySetVerified(value: boolean) {
        this.ctx().dailySetVerified = value
    }
    get readToEarnVerified(): boolean {
        return this.ctx().readToEarnVerified
    }
    set readToEarnVerified(value: boolean) {
        this.ctx().readToEarnVerified = value
    }
    get reactSnapshot(): PageSnapshot | null {
        return this.ctx().reactSnapshot
    }
    set reactSnapshot(value: PageSnapshot | null) {
        this.ctx().reactSnapshot = value
    }
    get reactSnapshots(): { mobile: PageSnapshot | null; desktop: PageSnapshot | null } {
        return this.ctx().reactSnapshots
    }
    set reactSnapshots(value: { mobile: PageSnapshot | null; desktop: PageSnapshot | null }) {
        this.ctx().reactSnapshots = value
    }
    get searchTopicsCache(): { key: string; topics: Promise<string[]> } | null {
        return this.ctx().searchTopicsCache
    }
    set searchTopicsCache(value: { key: string; topics: Promise<string[]> } | null) {
        this.ctx().searchTopicsCache = value
    }
    get accessToken(): string {
        return this.ctx().accessToken
    }
    set accessToken(value: string) {
        this.ctx().accessToken = value
    }
    get cookies(): { mobile: Cookie[]; desktop: Cookie[] } {
        return this.ctx().cookies
    }
    set cookies(value: { mobile: Cookie[]; desktop: Cookie[] }) {
        this.ctx().cookies = value
    }

    get fingerprint(): BrowserIdentitySnapshot {
        const sc = this.ctx()
        const ctx = this.isMobile ? sc.fingerprintMobile : sc.fingerprintDesktop
        return (ctx ?? sc.fingerprintMobile ?? sc.fingerprintDesktop) as BrowserIdentitySnapshot
    }

    public setFingerprint(isMobile: boolean, fingerprint: BrowserIdentitySnapshot | undefined): void {
        const sc = this.ctx()
        if (isMobile) sc.fingerprintMobile = fingerprint
        else sc.fingerprintDesktop = fingerprint
    }

    public trackBrowserContext(context: BrowserContext, email: string, isMobile: boolean): void {
        this.liveContexts.set(context, { email, isMobile })
        context.once('close', () => this.liveContexts.delete(context))
    }

    public async checkpointAndCloseBrowsers(): Promise<void> {
        this.shuttingDown = true
        for (const [context, identity] of this.liveContexts) {
            const storage = await context.storageState()
            saveStorageState(this.config.sessionPath, identity.email, identity.isMobile, storage)
        }
        this.logger.info('main', 'SESSION-CHECKPOINT', 'All active browser sessions saved')
        await Promise.allSettled(
            [...this.liveContexts.keys()].map(async context => {
                markContextClosing(context)
                await context.close()
                await context.browser()?.close()
            })
        )
    }

    public createBrowserInstance(account: Account): Promise<BrowserSession> {
        return this.browserFactory.createBrowser(account)
    }

    public generateDesktopFingerprint(): Promise<BrowserIdentitySnapshot> {
        return this.browserFactory.generateFingerprint(false)
    }

    public newBrowserPage(context: BrowserContext): Promise<Page> {
        return this.browserFactory.newPage(context)
    }

    public performLogin(page: Page, account: Account): Promise<void> {
        return this.login.login(page, account)
    }

    public fetchAppAccessToken(page: Page, email: string): Promise<string> {
        return this.login.getAppAccessToken(page, email)
    }

    public getSearchPointsPlan(): Promise<{ doMobile: boolean; doDesktop: boolean }> {
        return this.searchManager.getSearchPoints()
    }

    public runMobileSearch(account: Account): Promise<number> {
        return this.searchManager.searchMobile(account)
    }

    public runBonusMobileSearch(account: Account): Promise<number> {
        return this.searchManager.bonusMobile(account)
    }

    public runDesktopSearch(account: Account): Promise<number> {
        return this.searchManager.searchDesktop(account)
    }

    private applyExecutionPlan(plan: ExecutionPlan): void {
        const enabled = new Set<SmartWorker>(
            plan.type === 'workers' || plan.type === 'accountSession' ? plan.workers : []
        )
        if (plan.type === 'search' && plan.recheckEarn) enabled.add('morePromotions')
        const workers = this.config.workers
        workers.doDailySet = workers.doDailySet && enabled.has('dailySet')
        workers.doMorePromotions = workers.doMorePromotions && enabled.has('morePromotions')
        workers.doClaimBonusPoints = workers.doClaimBonusPoints && enabled.has('claimBonusPoints')
        workers.doPunchCards = workers.doPunchCards && enabled.has('punchCards')
        workers.doAppPromotions = workers.doAppPromotions && enabled.has('appPromotions')
        workers.doDailyCheckIn = workers.doDailyCheckIn && enabled.has('dailyCheckIn')
        workers.doReadToEarn = workers.doReadToEarn && enabled.has('readToEarn')
        workers.doActivateSearchPerk = workers.doActivateSearchPerk && enabled.has('activateSearchPerk')
        workers.doVisualSearch = workers.doVisualSearch && enabled.has('visualSearch')
        workers.doBonusSearches = workers.doBonusSearches && enabled.has('bonusSearches')
        workers.doMobileSearch =
            workers.doMobileSearch &&
            (plan.type === 'search' || plan.type === 'accountSession') &&
            plan.platform === 'mobile'
        workers.doDesktopSearch =
            workers.doDesktopSearch &&
            (plan.type === 'search' || plan.type === 'accountSession') &&
            plan.platform === 'desktop'
        this.config.ensureStreakProtection = this.config.ensureStreakProtection && enabled.has('streakProtection')
        this.config.experimental.edgeBrowsing = false
        this.config.searchSettings.parallelSearching = false
        this.config.searchSettings.runOnZeroPoints = false
        this.config.clusters = 1
    }

    public markCompletedSmartWorkers(
        appAvailable: boolean,
        data: DashboardData | undefined,
        errorBaseline: number,
        onlyWorker?: SmartWorker
    ): void {
        const plan = this.executionPlan
        if ((plan?.type !== 'workers' && plan?.type !== 'accountSession') || !onlyWorker) return
        const workers = plan.workers.filter(worker => worker === onlyWorker)
        if (this.logger.workerFailureCount > errorBaseline) {
            for (const worker of workers) {
                this.logger.warn('main', 'SMART-WORKER-PENDING', `worker=${worker} | reason=activity-error`)
            }
            return
        }
        const appWorkers = new Set<SmartWorker>(['dailyCheckIn', 'appPromotions', 'readToEarn'])
        const reportActivityWorkers = new Set<SmartWorker>([
            'punchCards',
            'activateSearchPerk',
            'visualSearch',
            'streakProtection'
        ])
        for (const worker of workers) {
            if (appWorkers.has(worker) && !appAvailable) continue
            if (
                (worker === 'dailySet' && !this.dailySetVerified) ||
                (worker === 'readToEarn' && !this.readToEarnVerified)
            ) {
                this.logger.warn('main', 'SMART-WORKER-PENDING', `worker=${worker} | reason=completion-unverified`)
                continue
            }
            if (worker === 'morePromotions' && !this.morePromotionsVerified) {
                this.logger.warn('main', 'SMART-WORKER-PENDING', 'worker=morePromotions | reason=completion-unverified')
                continue
            }
            if (worker === 'punchCards' && !this.punchCardsVerified) {
                this.logger.warn('main', 'SMART-WORKER-PENDING', 'worker=punchCards | reason=completion-unverified')
                continue
            }
            if (worker === 'claimBonusPoints' && !this.nextActions.reportClaimAllPoints) {
                this.logger.warn(
                    'main',
                    'SMART-WORKER-PENDING',
                    'worker=claimBonusPoints | reason=action-id-unavailable'
                )
                continue
            }
            const today = this.utils.getFormattedDate()
            const hasDependentOffers =
                worker === 'dailySet'
                    ? !data || Boolean(data.dashboard.dailySetPromotions[today]?.length)
                    : worker === 'morePromotions'
                      ? !data || Boolean(data.dashboard.morePromotions?.length)
                      : worker === 'punchCards'
                        ? !data || Boolean(data.dashboard.punchCards?.length || this.reactSnapshot?.reportable.length)
                        : true
            if (reportActivityWorkers.has(worker) && hasDependentOffers && !this.nextActions.reportActivity) {
                this.logger.warn('main', 'SMART-WORKER-PENDING', `worker=${worker} | reason=action-id-unavailable`)
                continue
            }
            emitRuntimeEvent('workerEnd', { worker })
            this.logger.info('main', 'SMART-WORKER-END', `worker=${worker}`)
        }
    }

    get isMobile(): boolean {
        return getCurrentContext().isMobile
    }

    get currentAccountEmail(): string | null {
        return getCurrentContext().account?.email || null
    }

    async recoverCurrentBingSession(): Promise<boolean> {
        if (this.normalSession?.active) return false
        const { account, isMobile } = getCurrentContext()
        const page = isMobile ? this.mainMobilePage : this.mainDesktopPage
        if (this.shuttingDown || !account?.email || !page || page.isClosed()) return false
        try {
            const verified = await this.login.verifyBingSession(page, account)
            if (this.shuttingDown || page.isClosed()) return false
            await this.browser.func.checkpointActiveSession('BING-DATA-RECOVERY')
            await this.browser.func.bootstrap(page)
            await this.browser.func.checkpointActiveSession('BING-DATA-RECOVERY')
            return verified
        } catch {
            this.logger.warn(this.isMobile, 'BING-DATA-RECOVERY', 'Could not restore verified Bing account data')
            return false
        }
    }

    async refreshCurrentRewardsContext(reason: string): Promise<boolean> {
        this.normalSession?.assertActive()
        if (this.normalSession?.active) return false
        const context = getCurrentContext()
        const account = context.account
        let page = context.isMobile ? this.mainMobilePage : this.mainDesktopPage
        let recoverySession: BrowserSession | null = null
        let refreshSucceeded = false

        if (!account?.email) {
            this.logger.debug(
                this.isMobile,
                'CONTEXT-REFRESH',
                `Cannot refresh rewards context | reason=${reason} | account=unavailable`
            )
            return false
        }

        try {
            this.logger.warn(
                this.isMobile,
                'CONTEXT-REFRESH',
                `Refreshing rewards browser context after request failure | reason=${reason}`
            )

            if (!page || page.isClosed()) {
                recoverySession = await this.browserFactory.createBrowser(account)
                page = await this.newBrowserPage(recoverySession.context)
                if (context.isMobile) {
                    this.mainMobilePage = page
                    this.setFingerprint(true, recoverySession.fingerprint)
                } else {
                    this.mainDesktopPage = page
                    this.setFingerprint(false, recoverySession.fingerprint)
                }

                await this.login.login(page, account)
            } else {
                this.nextActions = {}
                this.nextRouterStateTree = ''
                this.reactSnapshot = null
                await this.browser.func.synchronizeActiveBrowserCookies('CONTEXT-REFRESH-COOKIE-SEED', true)
                try {
                    await this.browser.func.bootstrap(page)
                } catch {
                    await this.login.login(page, account)
                }
            }

            await this.browser.func.checkpointActiveSession('CONTEXT-REFRESH')

            const refreshedCookies = await page.context().cookies()
            this.logger.info(
                this.isMobile,
                'CONTEXT-REFRESH',
                `Rewards context refreshed successfully | cookies=${refreshedCookies.length}`,
                'green'
            )
            refreshSucceeded = true
            return true
        } catch (error) {
            const log = reason.startsWith('bootstrap-')
                ? this.logger.debug.bind(this.logger)
                : this.logger.error.bind(this.logger)
            log(
                this.isMobile,
                'CONTEXT-REFRESH',
                `Rewards context refresh failed | reason=${reason} | message=${error instanceof Error ? error.message : String(error)}`
            )
            return false
        } finally {
            if (recoverySession) {
                await this.browser.func.closeBrowser(recoverySession.context, account.email, refreshSucceeded)
            }
        }
    }

    async initialize(): Promise<void> {
        this.accounts = loadAccounts()
        this.warnExperimental()
    }

    private warnExperimental(): void {
        const exp = this.config.experimental
        const searchFeatures = [exp.apiSearch && 'apiSearch', exp.apiSearchOnBing && 'apiSearchOnBing'].filter(
            Boolean
        ) as string[]

        if (searchFeatures.length) {
            this.logger.warn(
                'main',
                'EXPERIMENTAL',
                `${searchFeatures.join(' + ')} enabled - these perform searches over HTTP with no real browser. ` +
                    `This path is EXPERIMENTAL and UNSAFE and may get your account flagged or banned. ` +
                    `Disable it under config.experimental if you are unsure.`,
                'redBright'
            )
        }

        if (exp.edgeBrowsing) {
            this.logger.warn(
                'main',
                'EXPERIMENTAL',
                'edgeBrowsing enabled - the Edge browsing activity will be reported over HTTP in the background. ' +
                    'This integration is experimental; disable it under config.experimental if it behaves unexpectedly.'
            )
        }
    }

    async run(): Promise<void> {
        const totalAccounts = this.accounts.length
        const runStartTime = Date.now()

        this.logger.info(
            'main',
            'RUN-START',
            `Starting Microsoft Rewards Script | v${pkg.version} | Accounts: ${totalAccounts} | Clusters: ${this.config.clusters}`
        )

        if (this.executionPlan) {
            this.logger.info(
                'main',
                'SMART-SESSION',
                `Session start | jobId=${this.executionPlan.jobId} | type=${this.executionPlan.type}` +
                    (this.executionPlan.type === 'search' || this.executionPlan.type === 'accountSession'
                        ? ` | platform=${this.executionPlan.platform} | budget=${this.executionPlan.searchBudget}`
                        : this.executionPlan.type === 'workers'
                          ? ` | workers=${this.executionPlan.workers.join(',')}`
                          : '')
            )
        }

        if (this.config.clusters > 1) {
            if (cluster.isPrimary) {
                await this.clusterCoordinator.runMaster(this.accounts, runStartTime, email =>
                    this.waitBeforeNextAccount(email)
                )
            } else {
                this.clusterCoordinator.runWorker((chunk, start) => this.runTasks(chunk, start), runStartTime)
            }
        } else {
            await this.runTasks(this.accounts, runStartTime)
        }
    }

    private async runTasks(accounts: Account[], runStartTime: number): Promise<AccountStats[]> {
        const accountStats: AccountStats[] = []

        for (const [accountIndex, account] of accounts.entries()) {
            if (accountIndex > 0) {
                await this.waitBeforeNextAccount(account.email)
            }

            const accountStartTime = Date.now()
            const accountEmail = account.email
            this.userData.userName = this.utils.getEmailUsername(accountEmail)
            this.userData.timezoneOffset = String(new Date().getTimezoneOffset())
            let accountHttpClient: HttpClient | undefined

            try {
                const cachedRegion =
                    account.geoLocale === 'auto' ? loadResolvedRegion(this.config.sessionPath, accountEmail) : undefined
                this.accountLocale = resolveAccountLocale(account, cachedRegion)
                this.userData.langCode = this.accountLocale.language
                this.userData.geoLocale = this.accountLocale.country ?? 'US'

                this.logger.info(
                    'main',
                    'ACCOUNT-START',
                    `Starting account: ${accountEmail} | geoLocale: ${account.geoLocale} | locale: ${this.accountLocale.locale}${
                        cachedRegion ? ` | cachedRegion: ${cachedRegion}` : ''
                    }`
                )

                accountHttpClient = new HttpClient(account.proxy, {
                    'Accept-Language': this.accountLocale.acceptLanguage
                })
                this.http = accountHttpClient

                const isDesktopPlan =
                    (this.executionPlan?.type === 'search' && this.executionPlan.platform === 'desktop') ||
                    (this.executionPlan?.type === 'accountSession' && this.executionPlan.environment === 'desktop') ||
                    (this.executionPlan?.type === 'warmup' && this.executionPlan.platform === 'desktop')

                const result: AccountRunResult | undefined = await this.Main(account).catch(error => {
                    if (this.shuttingDown) return undefined
                    const flowLabel = isDesktopPlan ? 'Desktop flow failed' : 'Mobile/Account flow failed'
                    void this.logger.error(
                        !isDesktopPlan,
                        'FLOW',
                        `${flowLabel} for ${accountEmail}: ${error instanceof Error ? error.message : String(error)}`
                    )
                    return undefined
                })

                if (this.shuttingDown) return accountStats

                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)

                if (result) {
                    const collectedPoints = result.collectedPoints
                    const accountInitialPoints = result.initialPoints
                    const accountFinalPoints = result.finalPoints

                    if (result.skippedForBotWarning) {
                        accountStats.push({
                            email: accountEmail,
                            initialPoints: accountInitialPoints,
                            finalPoints: accountInitialPoints,
                            collectedPoints: 0,
                            duration: parseFloat(durationSeconds),
                            success: false,
                            error: 'Microsoft bot-score warning detected'
                        })

                        this.logger.warn(
                            'main',
                            'ACCOUNT-SKIP',
                            `Skipped account: ${accountEmail} | reason=Fraud_UserWarning_BotScore_UX | durationSeconds=${durationSeconds}`
                        )
                    } else {
                        accountStats.push({
                            email: accountEmail,
                            initialPoints: accountInitialPoints,
                            finalPoints: accountFinalPoints,
                            collectedPoints,
                            duration: parseFloat(durationSeconds),
                            success: true
                        })

                        this.logger.info(
                            'main',
                            'ACCOUNT-END',
                            `Completed account: ${accountEmail} | pointsGained=${formatMetric(collectedPoints)} | previousBalance=${formatMetric(accountInitialPoints)} | currentBalance=${formatMetric(accountFinalPoints)} | durationSeconds=${durationSeconds}`,
                            'green'
                        )
                    }
                } else {
                    accountStats.push({
                        email: accountEmail,
                        initialPoints: null,
                        finalPoints: null,
                        collectedPoints: null,
                        duration: parseFloat(durationSeconds),
                        success: false,
                        error: 'Flow failed'
                    })
                }
            } catch (error) {
                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)
                this.logger.error(
                    'main',
                    'ACCOUNT-ERROR',
                    `${accountEmail}: ${error instanceof Error ? error.message : String(error)}`
                )

                accountStats.push({
                    email: accountEmail,
                    initialPoints: null,
                    finalPoints: null,
                    collectedPoints: null,
                    duration: parseFloat(durationSeconds),
                    success: false,
                    error: error instanceof Error ? error.message : String(error)
                })
            } finally {
                await accountHttpClient
                    ?.close()
                    .catch(error =>
                        this.logger.debug(
                            'main',
                            'CLEANUP',
                            `HTTP proxy relay close failed | ${error instanceof Error ? error.message : String(error)}`
                        )
                    )
            }

            if (this.executionPlan) {
                const outcome = accountStats.at(-1)
                this.logger.info(
                    'main',
                    'SMART-SESSION',
                    `Session end | jobId=${this.executionPlan.jobId} | success=${outcome?.success === true} | durationSeconds=${outcome?.duration ?? 0}`
                )
            }
        }

        if (this.config.clusters <= 1 && cluster.isPrimary) {
            const totalCollectedPoints = sumKnown(accountStats.map(s => s.collectedPoints))
            const totalInitialPoints = sumKnown(accountStats.map(s => s.initialPoints))
            const totalFinalPoints = sumKnown(accountStats.map(s => s.finalPoints))
            const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

            this.logger.info(
                'main',
                'RUN-END',
                `Completed all accounts | accountsProcessed=${accountStats.length} | pointsGained=${formatMetric(totalCollectedPoints)} | previousBalance=${formatMetric(totalInitialPoints)} | currentBalance=${formatMetric(totalFinalPoints)} | runtimeMinutes=${totalDurationMinutes}`,
                'green'
            )

            if (!this.shuttingDown) {
                await flushAllWebhooks()
                process.exit(0)
            }
        }

        return accountStats
    }

    private async waitBeforeNextAccount(nextEmail?: string): Promise<void> {
        const { min, max } = this.config.accountDelay
        const minMs = typeof min === 'number' ? min : this.utils.stringToNumber(min)
        const maxMs = typeof max === 'number' ? max : this.utils.stringToNumber(max)

        if (minMs < 0 || maxMs < 0 || maxMs < minMs) {
            throw new Error('accountDelay must use non-negative values with max greater than or equal to min')
        }

        const delayMs = this.utils.randomNumber(Math.ceil(minMs), Math.floor(maxMs))
        this.logger.info(
            'main',
            'ACCOUNT-DELAY',
            `Waiting ${(delayMs / 1000).toFixed(1)} seconds before starting the next account${
                nextEmail ? ` (${nextEmail})` : ''
            }`
        )
        await this.utils.wait(delayMs)
    }

    async createDesktopSession(account: Account): Promise<BrowserSession> {
        this.normalSession?.assertActive()
        const session = await this.browserFactory.createBrowser(account)
        this.mainDesktopPage = await this.newBrowserPage(session.context)
        this.setFingerprint(false, session.fingerprint)

        this.logger.info(this.isMobile, 'BROWSER', `Desktop Browser started | ${account.email}`)

        await this.login.login(this.mainDesktopPage, account)
        await this.browser.func.checkpointActiveSession('LOGIN-CHECKPOINT')
        this.cookies.desktop = await session.context.cookies()

        return session
    }

    public async runAccountSession(account: Account): Promise<AccountRunResult> {
        return runConservativeAccountSession(this, account)
    }

    async Main(account: Account): Promise<AccountRunResult> {
        if (this.executionPlan?.type === 'warmup') {
            return runWarmupAccountSession(this, account)
        }
        if (
            account.newAccountMode &&
            (!this.executionPlan?.rewardsEligibleAt || Date.parse(this.executionPlan.rewardsEligibleAt) > Date.now())
        ) {
            throw new Error('New account has not reached its Rewards eligibility time')
        }

        this.logger.info('main', 'FLOW', `Starting session for ${account.email}`)
        this.ctx().resetForAccount()
        this.activities.resetWorkerTracking()

        if (this.executionPlan?.type === 'accountSession') {
            return runConservativeAccountSession(this, account)
        }
        return runStandardAccountFlow(this, account)
    }
}

if (require.main === module) {
    runCliEntrypoint(() => new MicrosoftRewardsBot()).catch(handleFatalBootstrapError)
}
