import { creditedPoints, pointDelta } from '../../../util/PointAccounting'
import type { QuestChild } from '../../../browser/ReactFunc'
import { BaseActivity } from '../BaseActivity'
import { URLs } from '../../../constants/urls'

export class ClaimReward extends BaseActivity {
    public async claimReward(child: QuestChild, parentId: string) {
        const offerId = child.offerId

        const actionId = this.bot.nextActions.reportActivity
        if (!actionId) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'CLAIM-REWARD',
                `Skipping ${offerId}: "reportActivity" not discovered in bundle`
            )
            return
        }

        if (!child.hash) {
            this.bot.logger.warn(this.bot.isMobile, 'CLAIM-REWARD', `Skipping ${offerId}: no live hash on quest child`)
            return
        }
        if (!child.reportable) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'CLAIM-REWARD',
                `Skipping ${offerId}: not reportable (completed/locked/disabled)`
            )
            return
        }

        const oldBalance = this.bot.userData.currentPoints

        this.bot.logger.info(
            this.bot.isMobile,
            'CLAIM-REWARD',
            `Claiming reward | offerId=${offerId} | geo=${this.bot.userData.geoLocale}`
        )

        try {
            const questUrl = URLs.rewards.quest(parentId)
            const { status, acknowledged } = await this.bot.browser.func.reportServerAction(
                actionId,
                [
                    child.hash,
                    11,
                    { offerid: offerId, isPromotional: '$undefined', timezoneOffset: this.bot.userData.timezoneOffset }
                ],
                {
                    url: questUrl,
                    referer: questUrl,
                    routerStateTree: this.bot.browser.react.questRouterStateTree(parentId)
                }
            )

            const newBalance = await this.bot.browser.func.getCurrentPoints()
            if (newBalance === null) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'CLAIM-REWARD',
                    `Claim acknowledged but final balance is unknown | offerId=${child.offerId} | status=${status}`
                )
                return
            }
            const freshHtml = await this.bot.browser.func.getRewardsPageHtml(questUrl, `/earn/quest/${parentId}`)
            const fresh = freshHtml ? this.bot.browser.react.snapshotQuestPage(freshHtml).find(item => item.offerId === child.offerId) : undefined
            const progress = fresh && fresh.points === child.points ? pointDelta(child.pointProgress, fresh.pointProgress) : null
            const gained = acknowledged ? creditedPoints(progress, oldBalance, newBalance) : null

            this.bot.logger.debug(
                this.bot.isMobile,
                'CLAIM-REWARD',
                `Claim response | offerId=${offerId} | status=${status} | acknowledged=${acknowledged} | pointsGained=${gained ?? 'unknown'} | currentBalance=${newBalance}`
            )

            if (acknowledged) {
                if (gained !== null && gained > 0) {
                    this.bot.userData.currentPoints = newBalance
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gained
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'CLAIM-REWARD',
                    `${fresh?.isCompleted ? 'Reward claimed' : 'Claim accepted; completion unverified'} | offerId=${offerId} | status=${status} | pointsGained=${gained ?? 'unknown'} | currentBalance=${newBalance}`,
                    gained !== null && gained > 0 ? 'green' : undefined
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'CLAIM-REWARD',
                    `Claim not acknowledged by server | offerId=${offerId} | status=${status}`
                )
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'CLAIM-REWARD',
                `Error in claimReward | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }
}
