import { BaseActivity } from '../BaseActivity'
import type { PromotionalItem, DashboardData } from '../../../interface/DashboardData'
import { PromotionActivityRunner } from './PromotionActivityRunner'

export class DailySet extends BaseActivity {
    public async run(data: DashboardData): Promise<void> {
        this.bot.dailySetVerified = false
        const snapshot = await this.bot.browser.func.refreshEarnSnapshot()
        if (snapshot) this.bot.reactSnapshot = snapshot
        const offers = snapshot?.dailySet
        if (!offers) {
            this.bot.logger.warn(this.bot.isMobile, 'DAILY-SET', 'Daily Set data unavailable; leaving task pending')
            return
        }
        const promotions = offers.map(
            offer =>
                ({
                    offerId: offer.offerId,
                    title: offer.title,
                    promotionType: offer.promotionType || 'urlreward',
                    pointProgressMax: offer.points,
                    complete: offer.isCompleted,
                    hash: offer.hash ?? '',
                    activityType: String(offer.activityType ?? ''),
                    destinationUrl: offer.destination,
                    exclusiveLockedFeatureStatus: offer.isLocked ? 'locked' : 'unlocked'
                }) as PromotionalItem
        )
        // Keep More Promotions from retrying Daily Set cards as unrelated tasks.
        data.dashboard.dailySetPromotions ??= {}
        data.dashboard.dailySetPromotions[this.bot.utils.getFormattedDate()] = promotions
        const pending = promotions.filter(item => !item.complete && item.pointProgressMax > 0)
        if (!pending.length) {
            this.bot.dailySetVerified = true
            this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'All "Daily Set" items have already been completed')
            return
        }
        this.bot.logger.info(
            this.bot.isMobile,
            'DAILY-SET',
            `Started solving "Daily Set" items | remaining=${pending.length}`
        )
        await new PromotionActivityRunner(this.bot).run(pending)
        const verified = await this.bot.browser.func.refreshEarnSnapshot()
        if (verified) this.bot.reactSnapshot = verified
        const remaining = pending.filter(
            p => !verified?.dailySet?.some(offer => offer.offerId === p.offerId && offer.isCompleted)
        )
        this.bot.dailySetVerified = verified?.dailySet != null && remaining.length === 0
        if (this.bot.dailySetVerified)
            this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'Finished processing "Daily Set" items')
        else
            this.bot.logger.warn(
                this.bot.isMobile,
                'DAILY-SET',
                `Completion not verified | remaining=${remaining.length}`
            )
    }
}
