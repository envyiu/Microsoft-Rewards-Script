import { verifyOffer } from './OfferVerification'
import { URLs } from '../../../constants/urls'
import type { BasePromotion } from '../../../interface/DashboardData'
import { BaseActivity } from '../BaseActivity'

export class UrlReward extends BaseActivity {
    public async doUrlReward(promotion: BasePromotion) {
        await this.runUrlReward(promotion, true)
    }

    private async runUrlReward(promotion: BasePromotion, allowSessionRepair: boolean) {
        const offerId = promotion.offerId

        const actionId = this.bot.nextActions.reportActivity
        if (!actionId) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'URL-REWARD',
                `Skipping ${offerId}: "reportActivity" not discovered in bundle`
            )
            return
        }

        const live = await this.bot.browser.func.ensureOffer(offerId)
        if (!live) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'URL-REWARD',
                `Skipping ${offerId}: not present in page snapshot, even after refetching /earn and /dashboard`
            )
            return
        }
        if (!live.reportable) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'URL-REWARD',
                `Skipping ${offerId}: not reportable (completed/locked/no-hash/future-dated)`
            )
            return
        }

        if (this.bot.config.skipNonPointTasks && live.points === 0) {
            this.bot.logger.info(
                this.bot.isMobile,
                'URL-REWARD',
                `Skipping ${offerId}: awards no points (points=${live.points}${live.promotionSubtype ? ` subtype=${live.promotionSubtype}` : ''}) - likely a free trial/non-crediting offer. Set skipNonPointTasks=false to attempt anyway.`
            )
            return
        }

        const oldBalance = this.bot.userData.currentPoints
        const expectedPoints = live.points

        const dashboardActivityType = Number(promotion.activityType)
        const activityType =
            live.activityType ??
            (Number.isInteger(dashboardActivityType) && dashboardActivityType > 0 ? dashboardActivityType : 11)

        this.bot.logger.info(
            this.bot.isMobile,
            'URL-REWARD',
            `Starting UrlReward | offerId=${offerId} | geo=${this.bot.userData.geoLocale} | currentBalance=${oldBalance}`
        )

        try {
            const { status, acknowledged, availablePoints } = await this.bot.browser.func.reportServerAction(
                actionId,
                [
                    live.hash,
                    activityType,
                    {
                        offerid: offerId,
                        // Match the Rewards client's server-action argument type.
                        isPromotional: live.isPromotional ? 'true' : '$undefined',
                        timezoneOffset: this.bot.userData.timezoneOffset
                    }
                ],
                {
                    browserFallback: true,
                    url: URLs.rewards.earn,
                    referer: URLs.rewards.earn,
                    routerStateTree: this.bot.nextRouterStateTree || this.bot.browser.react.routerStateTree('earn')
                }
            )

            if (!acknowledged) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `UrlReward request was not acknowledged | offerId=${offerId} | status=${status}`
                )
                if (await this.retryAfterRequestFailure(promotion, allowSessionRepair)) return
            }

            if (!acknowledged) return
            const verification = await verifyOffer(this.bot, live, oldBalance, availablePoints)
            const { complete, gained, balance } = verification
            if (balance !== null) this.bot.userData.currentPoints = balance
            if (gained !== null && gained > 0)
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gained
            const message = `offerId=${offerId} | acknowledged=true | expected=${expectedPoints}` +
                ` | pointsGained=${gained ?? 'unknown'} | currentBalance=${balance ?? 'unknown'}` +
                ` | completionVerified=${complete} | creditVerified=${gained !== null}`
            if (complete) {
                this.bot.logger.info(this.bot.isMobile, 'URL-REWARD',
                    `Completed UrlReward | ${message}`, gained !== null && gained > 0 ? 'green' : undefined)
            } else {
                this.bot.logger.warn(this.bot.isMobile, 'URL-REWARD', `UrlReward completion unverified | ${message}`)
            }

        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'URL-REWARD',
                `Error in doUrlReward | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
            await this.retryAfterRequestFailure(promotion, allowSessionRepair)
        }
    }

    private async retryAfterRequestFailure(promotion: BasePromotion, allowSessionRepair: boolean): Promise<boolean> {
        if (!allowSessionRepair) return false

        const refreshed = await this.bot.refreshCurrentRewardsContext(`URL-REWARD:${promotion.offerId}`)
        if (!refreshed) return false

        this.bot.logger.info(
            this.bot.isMobile,
            'URL-REWARD',
            `Retrying UrlReward once with refreshed cookies and bootstrap data | offerId=${promotion.offerId}`
        )
        await this.runUrlReward(promotion, false)
        return true
    }
}
