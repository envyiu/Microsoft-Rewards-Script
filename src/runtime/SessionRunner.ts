import type { BrowserContext } from 'patchright'
import { markContextClosing } from '../browser/BrowserLifecycle'
import { runNewAccountSession } from '../functions/NewAccount'
import type { MicrosoftRewardsBot } from '../index'
import type { Account } from '../interface/Account'
import type { AppDashboardData } from '../interface/AppDashBoardData'
import type { DashboardData } from '../interface/DashboardData'
import type { AppEarnablePoints } from '../interface/Points'
import { flushErrorDiagnostics } from '../util/ErrorDiagnostic'
import { normalizeCountry, resolveAccountLocale } from '../util/Locale'
import { emitRuntimeEvent } from '../util/RuntimeEvents'
import { saveResolvedRegion, saveStorageState } from '../util/SessionStore'
import { executionContext, type AccountRunResult, type BrowserSession } from './SessionContext'

export async function runWarmupAccountSession(bot: MicrosoftRewardsBot, account: Account): Promise<AccountRunResult> {
    const plan = bot.executionPlan
    if (plan?.type !== 'warmup') throw new Error('Warmup plan required')
    return executionContext.run({ account, isMobile: plan.platform === 'mobile' }, async () => {
        const session = await bot.createBrowserInstance(account)
        try {
            const page = await bot.newBrowserPage(session.context)
            if (plan.platform === 'mobile') bot.mainMobilePage = page
            else bot.mainDesktopPage = page
            await runNewAccountSession(bot, account, session.context, page)
            return { initialPoints: null, finalPoints: null, collectedPoints: null }
        } catch (error) {
            if ((error as { code?: string })?.code === 'DAILY_SEARCH_CAP')
                bot.logger.info(
                    bot.isMobile,
                    'NEW-ACCOUNT-QUERY-CAP',
                    'Daily automatic query budget exhausted; resume on the next account day'
                )
            else
                bot.logger.warn(
                    bot.isMobile,
                    'NEW-ACCOUNT-NEEDS-ACTION',
                    'Microsoft session did not complete; inspect authentication or service diagnostics'
                )
            throw error
        } finally {
            try {
                saveStorageState(
                    bot.config.sessionPath,
                    account.email,
                    bot.isMobile,
                    await session.context.storageState()
                )
            } finally {
                markContextClosing(session.context)
                await session.context.close().catch(() => {})
                await session.context
                    .browser()
                    ?.close()
                    .catch(() => {})
            }
        }
    })
}

export async function runConservativeAccountSession(
    bot: MicrosoftRewardsBot,
    account: Account
): Promise<AccountRunResult> {
    const plan = bot.executionPlan
    if (plan?.type !== 'accountSession') throw new Error('Account session plan required')
    return executionContext.run({ account, isMobile: plan.environment === 'mobile' }, async () => {
        const session = await bot.createBrowserInstance(account)
        try {
            await bot.normalSession.protectBrowser(session.context)
            const page = await bot.newBrowserPage(session.context)
            if (bot.isMobile) {
                bot.mainMobilePage = page
                bot.setFingerprint(true, session.fingerprint)
            } else {
                bot.mainDesktopPage = page
                bot.setFingerprint(false, session.fingerprint)
            }
            await bot.performLogin(page, account)
            bot.normalSession.assertActive()
            await bot.browser.func.checkpointActiveSession('LOGIN-CHECKPOINT')
            if (bot.isMobile) bot.cookies.mobile = await session.context.cookies()
            else bot.cookies.desktop = await session.context.cookies()
            const data = await bot.browser.func.getDashboardData()
            if (data.dashboard.userWarnings?.some(w => w?.name === 'Fraud_UserWarning_BotScore_UX')) {
                bot.normalSession.recordScopedOutcome('account', 'verification')
                emitRuntimeEvent('botWarning', { reason: 'Fraud_UserWarning_BotScore_UX', skipped: true })
                bot.logger.warn('main', 'BOT-WARNING', 'verification required: Rewards account warning')
            }
            bot.normalSession.assertActive()
            bot.accountLocale = resolveAccountLocale(
                account,
                normalizeCountry(data.dashboard.userProfile.attributes.country) ?? bot.accountLocale.country
            )
            bot.userData.langCode = bot.accountLocale.language
            bot.userData.geoLocale = bot.accountLocale.country ?? 'US'
            bot.http.setDefaultHeaders({ 'Accept-Language': bot.accountLocale.acceptLanguage })
            const initialPoints = data.dashboard.userStatus.availablePoints
            bot.userData.initialPoints = initialPoints
            bot.userData.currentPoints = initialPoints
            bot.normalSession.configure(
                async () => {
                    await bot.browser.func.getDashboardData()
                },
                async ms => {
                    await bot.utils.wait(ms)
                },
                async () => {
                    await bot.utils.wait(
                        bot.utils.randomDelay(
                            bot.config.searchSettings.searchDelay.min,
                            bot.config.searchSettings.searchDelay.max
                        )
                    )
                }
            )
            const appWorkers = plan.workers.some(w => ['readToEarn', 'dailyCheckIn', 'appPromotions'].includes(w))
            let appData: AppDashboardData | null = null
            if (appWorkers) {
                bot.normalSession.setFailureScope('app-oauth')
                try {
                    bot.accessToken = await bot.fetchAppAccessToken(page, account.email)
                    bot.normalSession.assertActive()
                    if (bot.accessToken) appData = await bot.browser.func.getAppDashboardData()
                } finally {
                    bot.normalSession.setFailureScope('account')
                }
            }
            for (const worker of plan.workers) {
                bot.normalSession.assertActive()
                if (worker === 'activateSearchPerk' && plan.workers.includes('dailySet') && !bot.dailySetVerified)
                    continue
                emitRuntimeEvent('workerStart', { worker })
                bot.logger.info('main', 'SMART-WORKER-START', `worker=${worker}`)
                if (['readToEarn', 'dailyCheckIn', 'appPromotions'].includes(worker)) {
                    bot.normalSession.setFailureScope('app-oauth')
                    try {
                        if (worker === 'readToEarn' && appData) await bot.activities.doReadToEarn()
                        else if (worker === 'dailyCheckIn' && appData) await bot.activities.doDailyCheckIn()
                        else if (worker === 'appPromotions' && appData) await bot.activities.doAppPromotions(appData)
                    } finally {
                        bot.normalSession.setFailureScope('account')
                    }
                } else if (worker === 'dailySet') await bot.activities.doDailySet(data)
                else if (worker === 'morePromotions') await bot.activities.doMorePromotions(data)
                else if (worker === 'activateSearchPerk') await bot.activities.doActivateSearchPerk(data)
                else if (worker === 'streakProtection') await bot.activities.doEnsureStreakProtection()
                else if (worker === 'claimBonusPoints') await bot.activities.doClaimBonusPoints()
                else if (worker === 'punchCards') await bot.activities.doPunchCardsDesktop()
                else if (worker === 'visualSearch') await bot.activities.doVisualSearch(data)
            }
            bot.normalSession.assertActive()
            if (bot.normalSession.normalSearchRemaining > 0 && !bot.normalSession.searchBlocked) {
                if (plan.platform === 'mobile' && bot.config.workers.doMobileSearch) await bot.runMobileSearch(account)
                if (plan.platform === 'desktop' && bot.config.workers.doDesktopSearch)
                    await bot.runDesktopSearch(account)
            }
            bot.normalSession.assertActive()
            const finalPoints = await bot.browser.func.getCurrentPoints()
            return {
                initialPoints,
                finalPoints,
                collectedPoints: finalPoints == null ? null : finalPoints - initialPoints
            }
        } catch (error) {
            if (!bot.shuttingDown)
                bot.normalSession.observe('FLOW', error instanceof Error ? error.message : String(error), 'error')
            throw error
        } finally {
            const failure = bot.normalSession.failureReason()
            if (failure) {
                emitRuntimeEvent('sessionFailure', {
                    reason: failure,
                    searchDeferred: bot.normalSession.isSearchDeferred
                })
                bot.logger.info('main', 'NORMAL-SESSION-FAILURE', `reason=${failure}`)
            } else if (bot.normalSession.isSearchDeferred) {
                emitRuntimeEvent('sessionFailure', { reason: null, searchDeferred: true })
            }
            try {
                await bot.browser.func.checkpointActiveSession('PRE-BROWSER-CLOSE')
            } finally {
                await flushErrorDiagnostics()
                markContextClosing(session.context)
                await session.context.close().catch(() => {})
                await session.context
                    .browser()
                    ?.close()
                    .catch(() => {})
            }
        }
    })
}

export async function runStandardAccountFlow(bot: MicrosoftRewardsBot, account: Account): Promise<AccountRunResult> {
    const accountEmail = account.email
    const apiSearch = bot.config.experimental.apiSearch
    const apiSearchOnBing = bot.config.experimental.apiSearchOnBing
    const fullApi = apiSearch && (apiSearchOnBing || !bot.config.activities.searchOnBing)
    const needsAppActivities =
        bot.config.workers.doDailyCheckIn || bot.config.workers.doAppPromotions || bot.config.workers.doReadToEarn
    const needsAppAccessToken = bot.config.experimental.edgeBrowsing || needsAppActivities

    let mobileSession: BrowserSession | null = null
    let desktopSession: BrowserSession | null = null
    const edgeBrowsingController = new AbortController()
    let edgeBrowsingTask: Promise<void> | null = null
    let edgeBrowsingFinished = false

    const closeMobileSession = async (): Promise<void> => {
        const session = mobileSession
        if (!session) return
        mobileSession = null

        await executionContext.run({ isMobile: true, account }, async () => {
            await bot.browser.func.checkpointActiveSession('PRE-BROWSER-CLOSE')
            await bot.browser.func.closeBrowser(session.context, accountEmail)
        })
    }

    const closeDesktopSession = async (): Promise<void> => {
        const session = desktopSession
        if (!session) return
        desktopSession = null

        await executionContext.run({ isMobile: false, account }, async () => {
            await bot.browser.func.checkpointActiveSession('PRE-BROWSER-CLOSE')
            await bot.browser.func.closeBrowser(session.context, accountEmail)
        })
    }

    try {
        return await executionContext.run({ isMobile: true, account }, async () => {
            mobileSession = await bot.createBrowserInstance(account)
            const initialContext: BrowserContext = mobileSession.context
            bot.mainMobilePage = await bot.newBrowserPage(initialContext)

            bot.logger.info('main', 'BROWSER', `Mobile Browser started | ${accountEmail}`)

            await bot.performLogin(bot.mainMobilePage, account)

            if (needsAppAccessToken) {
                try {
                    bot.accessToken = await bot.fetchAppAccessToken(bot.mainMobilePage, accountEmail)
                } catch (error) {
                    bot.logger.error(
                        'main',
                        'FLOW',
                        `Failed to get mobile access token: ${error instanceof Error ? error.message : String(error)}`
                    )
                    bot.accessToken = ''
                }
            }

            await bot.browser.func.checkpointActiveSession('LOGIN-CHECKPOINT')
            bot.cookies.mobile = await initialContext.cookies()
            bot.setFingerprint(true, mobileSession.fingerprint)

            if (fullApi) {
                await closeMobileSession()
                bot.logger.info(
                    'main',
                    'FLOW',
                    'Mobile login browser closed; continuing with the saved session and HTTP requests'
                )
            }

            const data: DashboardData = await bot.browser.func.getDashboardData()
            const hasBotScoreWarning =
                Array.isArray(data.dashboard.userWarnings) &&
                data.dashboard.userWarnings.some(warning => warning?.name === 'Fraud_UserWarning_BotScore_UX')

            if (hasBotScoreWarning) {
                const availablePoints = data.dashboard.userStatus.availablePoints
                emitRuntimeEvent('botWarning', {
                    reason: 'Fraud_UserWarning_BotScore_UX',
                    skipped: !bot.config.contintueOnBotWarning
                })

                if (!bot.config.contintueOnBotWarning) {
                    bot.logger.warn(
                        'main',
                        'BOT-WARNING',
                        `Microsoft Rewards reported Fraud_UserWarning_BotScore_UX for ${accountEmail}. ` +
                            'This account will be skipped for safety. The preferred action is to stop automation for this account and wait a few days. ' +
                            'To continue anyway (not recommended), set "contintueOnBotWarning": true.'
                    )

                    return {
                        initialPoints: availablePoints,
                        finalPoints: availablePoints,
                        collectedPoints: 0,
                        skippedForBotWarning: true
                    }
                }

                bot.logger.warn(
                    'main',
                    'BOT-WARNING',
                    `Microsoft Rewards reported Fraud_UserWarning_BotScore_UX for ${accountEmail}, but contintueOnBotWarning=true. ` +
                        'Continuing as configured is not recommended; waiting a few days is the preferred action.'
                )
            }

            if (bot.executionPlan?.type === 'quota') {
                const points = data.dashboard.userStatus.availablePoints
                return { initialPoints: points, finalPoints: points, collectedPoints: 0 }
            }

            const profileCountry = normalizeCountry(data.dashboard.userProfile.attributes.country)

            if (account.geoLocale === 'auto') {
                if (profileCountry) {
                    saveResolvedRegion(bot.config.sessionPath, accountEmail, profileCountry)
                } else {
                    bot.logger.warn(
                        'main',
                        'GEO-LOCALE',
                        `Microsoft profile returned an invalid country; retaining ${
                            bot.accountLocale.country ?? 'US fallback'
                        }`
                    )
                }
            }

            bot.accountLocale = resolveAccountLocale(account, profileCountry ?? bot.accountLocale.country)
            bot.userData.langCode = bot.accountLocale.language
            bot.userData.geoLocale = bot.accountLocale.country ?? 'US'
            bot.http.setDefaultHeaders({
                'Accept-Language': bot.accountLocale.acceptLanguage
            })

            let appData: AppDashboardData | null = null

            if (bot.accessToken && needsAppActivities) {
                try {
                    appData = await bot.browser.func.getAppDashboardData()
                } catch (error) {
                    bot.logger.warn(
                        'main',
                        'LOGIN-APP',
                        `App dashboard unavailable - app activities will be skipped this run | message=${error instanceof Error ? error.message : String(error)}`
                    )
                    bot.accessToken = ''
                }
            }

            bot.userData.initialPoints = data.dashboard.userStatus.availablePoints
            bot.userData.currentPoints = data.dashboard.userStatus.availablePoints
            const initialPoints = bot.userData.initialPoints

            const browserEarnable = await bot.browser.func.getBrowserEarnablePoints(data)
            let appEarnable: AppEarnablePoints | null = null

            if (bot.accessToken && needsAppActivities) {
                try {
                    appEarnable = await bot.browser.func.getAppEarnablePoints()
                } catch (error) {
                    bot.logger.warn(
                        'main',
                        'LOGIN-APP',
                        `App earnable-points lookup failed - app activities will be skipped this run | message=${error instanceof Error ? error.message : String(error)}`
                    )
                    bot.accessToken = ''
                    appData = null
                }
            }

            const appAvailable = Boolean(bot.accessToken && appData)

            bot.logger.info(
                'main',
                'POINTS',
                `Earnable today | Mobile: ${browserEarnable.mobileSearchPoints} | Browser: ${
                    browserEarnable.desktopSearchPoints
                } | App: ${appEarnable?.totalEarnablePoints ?? 0} | ${accountEmail} | locale: ${bot.accountLocale.locale}`
            )

            const parallel = bot.config.searchSettings.parallelSearching
            const doBonus = bot.config.workers.doBonusSearches
            const doVisualSearch = bot.config.workers.doVisualSearch

            let mobilePoints = 0
            let desktopPoints = 0
            let bonusPoints = 0

            if (bot.config.experimental.edgeBrowsing) {
                edgeBrowsingTask = bot.activities
                    .doEdgeBrowsing(data, edgeBrowsingController.signal)
                    .catch(error => {
                        bot.logger.error(
                            bot.isMobile,
                            'EDGE-BROWSING',
                            `Unexpected background task failure | message=${
                                error instanceof Error ? error.message : String(error)
                            }`
                        )
                    })
                    .finally(() => {
                        edgeBrowsingFinished = true
                    })
            }

            if (fullApi) {
                if (bot.config.ensureStreakProtection) {
                    await bot.activities.doEnsureStreakProtection()
                }
                if (bot.config.workers.doPunchCards) await bot.activities.doPunchCardsMobile(data)
                if (bot.config.workers.doActivateSearchPerk) await bot.activities.doActivateSearchPerk(data)

                const plan = await bot.getSearchPointsPlan()
                const doMobileSearch = plan.doMobile
                const doDesktopSearch = plan.doDesktop
                const desktopBrowserNeeded = bot.config.workers.doPunchCards || doVisualSearch

                if (doDesktopSearch && !desktopBrowserNeeded) {
                    bot.cookies.desktop = [...bot.cookies.mobile]
                    bot.setFingerprint(false, await bot.generateDesktopFingerprint())
                }

                if (desktopBrowserNeeded) {
                    await executionContext.run({ isMobile: false, account }, async () => {
                        desktopSession = await bot.createDesktopSession(account)
                        if (bot.config.workers.doPunchCards) await bot.activities.doPunchCardsDesktop()
                        if (doVisualSearch) await bot.activities.doVisualSearch(data)
                    })
                    await closeDesktopSession()
                }

                if (bot.config.workers.doDailySet) await bot.activities.doDailySet(data)
                if (bot.config.workers.doMorePromotions) await bot.activities.doMorePromotions(data)
                if (appAvailable && bot.config.workers.doDailyCheckIn) await bot.activities.doDailyCheckIn()
                if (appAvailable && bot.config.workers.doAppPromotions && appData)
                    await bot.activities.doAppPromotions(appData)
                if (appAvailable && bot.config.workers.doReadToEarn) await bot.activities.doReadToEarn()

                if (doMobileSearch) mobilePoints = await bot.runMobileSearch(account)
                if (doBonus) bonusPoints = await bot.runBonusMobileSearch(account)
                if (doDesktopSearch) desktopPoints = await bot.runDesktopSearch(account)
            } else {
                if (bot.config.ensureStreakProtection) {
                    await bot.activities.doEnsureStreakProtection()
                }
                if (bot.config.workers.doDailySet) await bot.activities.doDailySet(data)
                if (bot.config.workers.doActivateSearchPerk) await bot.activities.doActivateSearchPerk(data)
                if (bot.config.workers.doMorePromotions) await bot.activities.doMorePromotions(data)
                if (appAvailable && bot.config.workers.doDailyCheckIn) await bot.activities.doDailyCheckIn()
                if (appAvailable && bot.config.workers.doAppPromotions && appData)
                    await bot.activities.doAppPromotions(appData)
                if (appAvailable && bot.config.workers.doReadToEarn) await bot.activities.doReadToEarn()
                if (bot.config.workers.doPunchCards) await bot.activities.doPunchCardsMobile(data)

                const plan = await bot.getSearchPointsPlan()
                const doMobileSearch = plan.doMobile
                const doDesktopSearch = plan.doDesktop

                const desktopBrowserNeeded =
                    bot.config.workers.doPunchCards || doVisualSearch || (doDesktopSearch && !apiSearch)

                if (apiSearch && doDesktopSearch && !desktopBrowserNeeded) {
                    bot.cookies.desktop = [...bot.cookies.mobile]
                    bot.setFingerprint(false, await bot.generateDesktopFingerprint())
                }

                if (parallel && !apiSearch && doMobileSearch && doDesktopSearch) {
                    await executionContext.run({ isMobile: false, account }, async () => {
                        desktopSession = await bot.createDesktopSession(account)
                        if (bot.config.workers.doPunchCards) await bot.activities.doPunchCardsDesktop()
                        if (doVisualSearch) await bot.activities.doVisualSearch(data)
                    })

                    const mobileWork = async (): Promise<[number, number]> => {
                        try {
                            const searchPoints = await bot.runMobileSearch(account)
                            const extraPoints = doBonus ? await bot.runBonusMobileSearch(account) : 0
                            return [searchPoints, extraPoints]
                        } finally {
                            await closeMobileSession()
                        }
                    }
                    const desktopWork = async (): Promise<number> => {
                        try {
                            return await bot.runDesktopSearch(account)
                        } finally {
                            await closeDesktopSession()
                        }
                    }

                    ;[[mobilePoints, bonusPoints], desktopPoints] = await Promise.all([mobileWork(), desktopWork()])
                } else {
                    if (apiSearch) await closeMobileSession()

                    if (doMobileSearch) mobilePoints = await bot.runMobileSearch(account)
                    if (doBonus) bonusPoints = await bot.runBonusMobileSearch(account)

                    if (!apiSearch) await closeMobileSession()

                    if (desktopBrowserNeeded) {
                        await executionContext.run({ isMobile: false, account }, async () => {
                            desktopSession = await bot.createDesktopSession(account)

                            if (bot.config.workers.doPunchCards) await bot.activities.doPunchCardsDesktop()
                            if (doVisualSearch) await bot.activities.doVisualSearch(data)
                            if (doDesktopSearch && !apiSearch) {
                                desktopPoints = await bot.runDesktopSearch(account)
                            }
                        })
                        await closeDesktopSession()
                    }

                    if (doDesktopSearch && apiSearch) {
                        desktopPoints = await bot.runDesktopSearch(account)
                    }
                }
            }

            bot.logger.info(
                'main',
                'SEARCH-MANAGER',
                `Search summary | mobile=${mobilePoints} | desktop=${desktopPoints} | bonus=${bonusPoints} | total=${
                    mobilePoints + desktopPoints + bonusPoints
                }`
            )

            if (bot.config.workers.doClaimBonusPoints) await bot.activities.doClaimBonusPoints()

            if (edgeBrowsingTask) {
                if (!edgeBrowsingFinished) {
                    bot.logger.info(
                        bot.isMobile,
                        'EDGE-BROWSING',
                        'Foreground activities finished; waiting for the background Edge browsing activity'
                    )
                }
                await edgeBrowsingTask
                edgeBrowsingTask = null
            }

            const finalPoints = await bot.browser.func.getCurrentPoints()
            const collectedPoints = finalPoints === null ? null : finalPoints - initialPoints

            if (finalPoints === null) {
                bot.logger.warn(
                    'main',
                    'FLOW',
                    `Points result unavailable | pointsGained=unknown | currentBalance=unknown | account=${accountEmail}`
                )
            } else {
                bot.logger.info(
                    'main',
                    'FLOW',
                    `Points collected | pointsGained=${collectedPoints} | currentBalance=${finalPoints} | account=${accountEmail}`
                )
            }

            return {
                initialPoints,
                finalPoints,
                collectedPoints
            }
        })
    } finally {
        if (edgeBrowsingTask) {
            edgeBrowsingController.abort()
            await edgeBrowsingTask
            edgeBrowsingTask = null
        }

        if (mobileSession) {
            try {
                await closeMobileSession()
            } catch (error) {
                bot.logger.debug(
                    'main',
                    'CLEANUP',
                    `Mobile context close failed | ${error instanceof Error ? error.message : String(error)}`
                )
            }
        }

        if (desktopSession) {
            try {
                await closeDesktopSession()
            } catch (error) {
                bot.logger.debug(
                    'main',
                    'CLEANUP',
                    `Desktop context close failed | ${error instanceof Error ? error.message : String(error)}`
                )
            }
        }
    }
}
