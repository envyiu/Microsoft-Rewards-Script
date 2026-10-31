import { waitForActivity } from '../../../util/ActivityTiming'
import { BaseActivity } from '../BaseActivity'
import type { BasePromotion } from '../../../interface/DashboardData'

export class PromotionActivityRunner extends BaseActivity {
    public async visitPromotion(promotion: BasePromotion): Promise<boolean> {
        const search = promotion.name?.toLowerCase().includes('exploreonbing')
        if (search ? !this.bot.config.activities.searchOnBing : !this.bot.config.activities.urlReward) return false
        const type = promotion.promotionType?.toLowerCase() ?? ''
        if (
            ['search', 'claim', 'redeem', 'badge'].includes(type) ||
            (!['urlreward', 'quiz', 'poll', 'puzzle'].includes(type) && !(Number(promotion.activityType) > 0))
        )
            return false
        const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
        if (!page || page.isClosed()) return false
        const live = await this.bot.browser.func.ensureOffer(promotion.offerId)
        if (!live?.reportable || live.isCompleted || !live.destination) return false
        let destination: URL
        try {
            destination = new URL(live.destination)
        } catch {
            return false
        }
        // Follow the signed card's ordinary web link in the account's existing
        // context. Never follow app/install/download/redemption links as a fallback.
        if (
            destination.protocol !== 'https:' ||
            destination.username ||
            destination.password ||
            !['bing.com', 'www.bing.com', 'rewards.bing.com'].includes(destination.hostname) ||
            /\/apps?\/|\/redeem|\.(?:exe|msi|apk|zip)$/i.test(destination.pathname)
        )
            return false
        let tab
        try {
            tab = await this.bot.newBrowserPage(page.context())
            await tab.goto(destination.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 })
            await waitForActivity(this.bot, this.bot.utils.randomDelay(5000, 15000))
            this.bot.logger.info(
                this.bot.isMobile,
                'ACTIVITY',
                `Visited pending card | offerId=${promotion.offerId} | verification=pending`
            )
            return true
        } catch {
            this.bot.logger.warn(this.bot.isMobile, 'ACTIVITY', `Card visit failed | offerId=${promotion.offerId}`)
            return false
        } finally {
            await tab?.close().catch(() => {})
        }
    }

    public async run(promotions: BasePromotion[]): Promise<void> {
        for (const [index, promotion] of promotions.entries()) {
            try {
                await this.runPromotion(promotion)
                if (index < promotions.length - 1) {
                    await waitForActivity(this.bot, this.bot.utils.randomDelay(5000, 15000))
                }
            } catch (error) {
                this.bot.logger.error(
                    this.bot.isMobile,
                    'ACTIVITY',
                    `Error while solving activity "${promotion.title}" | message=${
                        error instanceof Error ? error.message : String(error)
                    }`
                )
            }
        }
    }

    private async runPromotion(promotion: BasePromotion): Promise<void> {
        const type = promotion.promotionType?.toLowerCase() ?? ''
        const name = promotion.name?.toLowerCase() ?? ''
        const offerId = promotion.offerId

        this.bot.logger.debug(
            this.bot.isMobile,
            'ACTIVITY',
            `Processing activity | title="${promotion.title}" | offerId=${offerId} | type=${type}`
        )

        const activityType = Number(promotion.activityType)
        const hasReportActivity = Number.isInteger(activityType) && activityType > 0
        const reservedType = ['search', 'claim', 'redeem', 'badge'].includes(type)
        const reportTypes = ['urlreward', 'quiz', 'poll', 'puzzle']
        if (reservedType || (!reportTypes.includes(type) && !hasReportActivity)) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'ACTIVITY',
                `Skipped activity "${promotion.title}" | offerId=${offerId} | reason=unsupported type "${
                    promotion.promotionType
                }"`
            )
            return
        }

        const isSearchOnBing = name.includes('exploreonbing')
        if (isSearchOnBing && !this.bot.config.activities.searchOnBing) {
            this.logDisabled('SearchOnBing', offerId)
            return
        }
        if (!isSearchOnBing && !this.bot.config.activities.urlReward) {
            this.logDisabled('UrlReward', offerId)
            return
        }

        if (isSearchOnBing) {
            this.bot.logger.info(
                this.bot.isMobile,
                'ACTIVITY',
                `Found activity type "SearchOnBing" | title="${promotion.title}" | offerId=${offerId}`
            )
            const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
            await this.bot.activities.doSearchOnBing(promotion, page)
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'ACTIVITY',
            `Found activity type "UrlReward" | title="${promotion.title}" | offerId=${offerId}`
        )
        await this.bot.activities.doUrlReward(promotion)
    }

    private logDisabled(activity: string, offerId: string): void {
        this.bot.logger.info(
            this.bot.isMobile,
            'ACTIVITY',
            `Skipping "${activity}" (disabled in config) | offerId=${offerId}`
        )
    }
}
