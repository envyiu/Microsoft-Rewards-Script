import type { MicrosoftRewardsBot } from '../index'

import { DailySet } from './activities/rewards/DailySet'
import { MorePromotions } from './activities/rewards/MorePromotions'
import { PunchCards } from './activities/rewards/PunchCards'

import { DailyCheckIn } from './activities/app/DailyCheckIn'
import { ReadToEarn } from './activities/app/ReadToEarn'
import { AppReward } from './activities/app/AppReward'
import { AppPromotions } from './activities/app/AppPromotions'

import { UrlReward } from './activities/api/UrlReward'
import { ClaimBonusPoints } from './activities/api/ClaimBonusPoints'
import { EnsureStreakProtection } from './activities/api/EnsureStreakProtection'
import { ClaimReward } from './activities/api/ClaimReward'
import { ActivateSearchPerk } from './activities/api/ActivateSearchPerk'
import { VisualSearch } from './activities/visualSearch/VisualSearch'

import { Search as BrowserSearch } from './activities/search/BrowserSearch'
import { SearchOnBing as BrowserSearchOnBing } from './activities/search/BrowserSearchOnBing'

import { ApiSearch } from './activities/experimental/ApiSearch'
import { ApiSearchOnBing } from './activities/experimental/ApiSearchOnBing'
import { EdgeBrowsing } from './activities/experimental/EdgeBrowsing'

import type { SmartWorker } from '../interface/ExecutionPlan'

import type { Page } from 'patchright'
import type { BasePromotion, DashboardData } from '../interface/DashboardData'
import type { AppDashboardData, Promotion } from '../interface/AppDashBoardData'
import type { QuestChild } from '../browser/ReactFunc'

export default class Activities {
    private bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    private workerErrors = new Set<SmartWorker>()
    private workerDashboard: DashboardData | undefined

    resetWorkerTracking(): void {
        this.workerErrors.clear()
        this.workerDashboard = undefined
    }

    private async trackWorker<T>(
        worker: SmartWorker,
        action: () => Promise<T>,
        data?: DashboardData,
        final = true
    ): Promise<T> {
        if (this.bot.executionPlan?.type !== 'workers') return action()
        if (data) this.workerDashboard = data
        const before = this.bot.logger.workerFailureCount
        try {
            const result = await action()
            if (this.bot.logger.workerFailureCount > before) this.workerErrors.add(worker)
            if (final) {
                if (this.workerErrors.has(worker))
                    this.bot.logger.warn('main', 'SMART-WORKER-PENDING', `worker=${worker} | reason=activity-error`)
                else
                    this.bot.markCompletedSmartWorkers(
                        true,
                        this.workerDashboard,
                        this.bot.logger.workerFailureCount,
                        worker
                    )
            }
            return result
        } catch (error) {
            this.workerErrors.add(worker)
            this.bot.logger.warn('main', 'SMART-WORKER-PENDING', `worker=${worker} | reason=activity-error`)
            throw error
        }
    }

    doSearch = async (page: Page, isMobile: boolean, budget?: number): Promise<number> => {
        if (this.bot.config.experimental.apiSearch) {
            return await new ApiSearch(this.bot).doSearch(isMobile, budget)
        }
        return await new BrowserSearch(this.bot).doSearch(page, isMobile, budget)
    }

    doBonusSearches = async (page: Page): Promise<number> => {
        return this.trackWorker(
            'bonusSearches',
            async () => {
                if (this.bot.config.experimental.apiSearch) {
                    return await new ApiSearch(this.bot).doBonusSearches()
                }
                return await new BrowserSearch(this.bot).doBonusSearches(page)
            },
            undefined
        )
    }

    doSearchOnBing = async (promotion: BasePromotion, page: Page): Promise<void> => {
        if (this.bot.config.experimental.apiSearchOnBing) {
            await new ApiSearchOnBing(this.bot).doSearchOnBing(promotion)
            return
        }
        await new BrowserSearchOnBing(this.bot).doSearchOnBing(promotion, page)
    }

    doDailySet = async (data: DashboardData): Promise<void> => {
        return this.trackWorker(
            'dailySet',
            async () => {
                await new DailySet(this.bot).run(data)
            },
            data
        )
    }

    doMorePromotions = async (data: DashboardData): Promise<void> => {
        return this.trackWorker(
            'morePromotions',
            async () => {
                await new MorePromotions(this.bot).run(data)
            },
            data
        )
    }

    doPunchCardsMobile = async (data: DashboardData): Promise<void> => {
        return this.trackWorker(
            'punchCards',
            async () => {
                await new PunchCards(this.bot).runMobile(data)
            },
            data,
            false
        )
    }

    doPunchCardsDesktop = async (): Promise<void> => {
        return this.trackWorker(
            'punchCards',
            async () => {
                await new PunchCards(this.bot).runDesktop()
            },
            undefined
        )
    }

    doUrlReward = async (promotion: BasePromotion): Promise<void> => {
        const urlReward = new UrlReward(this.bot)
        await urlReward.doUrlReward(promotion)
    }

    doClaimBonusPoints = async (): Promise<void> => {
        return this.trackWorker(
            'claimBonusPoints',
            async () => {
                const claimBonusPoints = new ClaimBonusPoints(this.bot)
                await claimBonusPoints.claimBonusPoints()
            },
            undefined
        )
    }

    doEnsureStreakProtection = async (): Promise<void> => {
        return this.trackWorker(
            'streakProtection',
            async () => {
                const ensureStreakProtection = new EnsureStreakProtection(this.bot)
                await ensureStreakProtection.ensureStreakProtection()
            },
            undefined
        )
    }

    doClaimReward = async (child: QuestChild, parentId: string): Promise<void> => {
        const claimReward = new ClaimReward(this.bot)
        await claimReward.claimReward(child, parentId)
    }

    doActivateSearchPerk = async (data: DashboardData): Promise<void> => {
        return this.trackWorker(
            'activateSearchPerk',
            async () => {
                const activateSearchPerk = new ActivateSearchPerk(this.bot)
                await activateSearchPerk.activate(data)
            },
            data
        )
    }

    doVisualSearch = async (data: DashboardData): Promise<number> => {
        return this.trackWorker(
            'visualSearch',
            async () => {
                const visualSearch = new VisualSearch(this.bot)
                return await visualSearch.doVisualSearch(data)
            },
            data
        )
    }

    doAppReward = async (promotion: Promotion): Promise<void> => {
        const urlReward = new AppReward(this.bot)
        await urlReward.doAppReward(promotion)
    }

    doReadToEarn = async (): Promise<void> => {
        return this.trackWorker(
            'readToEarn',
            async () => {
                const readToEarn = new ReadToEarn(this.bot)
                await readToEarn.doReadToEarn()
            },
            undefined
        )
    }

    doDailyCheckIn = async (): Promise<void> => {
        return this.trackWorker(
            'dailyCheckIn',
            async () => {
                const dailyCheckIn = new DailyCheckIn(this.bot)
                await dailyCheckIn.doDailyCheckIn()
            },
            undefined
        )
    }

    doAppPromotions = async (data: AppDashboardData): Promise<void> => {
        return this.trackWorker(
            'appPromotions',
            async () => {
                await new AppPromotions(this.bot).run(data)
            },
            undefined
        )
    }

    doEdgeBrowsing = async (data: DashboardData, signal?: AbortSignal): Promise<void> => {
        const edgeBrowsing = new EdgeBrowsing(this.bot)
        await edgeBrowsing.run(data, signal)
    }
}
