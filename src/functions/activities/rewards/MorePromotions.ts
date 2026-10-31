import { BaseActivity } from '../BaseActivity'
import type { BasePromotion, DashboardData } from '../../../interface/DashboardData'
import { PromotionActivityRunner } from './PromotionActivityRunner'
import type { ParsedOffer } from '../../../browser/ReactFunc'

export class MorePromotions extends BaseActivity {
    public async run(data: DashboardData): Promise<void> {
        this.bot.morePromotionsVerified = false
        // The legacy dashboard and Bing flyout can omit cards rendered on /earn.
        const snapshot = await this.bot.browser.func.refreshEarnSnapshot({ rendered: true })
        if (snapshot) this.bot.reactSnapshot = snapshot
        const liveOffers = this.bot.reactSnapshot?.offers ?? []
        const excluded = new Set([
            ...(this.bot.reactSnapshot?.dailySet ?? []).map(item => item.offerId),
            ...Object.values(data.dashboard.dailySetPromotions ?? {})
                .flat()
                .map(item => item.offerId),
            ...(data.dashboard.punchCards ?? []).flatMap(card =>
                [card.parentPromotion, ...(card.childPromotions ?? [])].map(item => item.offerId)
            )
        ])
        const promotions = new Map<string, BasePromotion>()
        for (const promotion of [
            ...(data.dashboard.morePromotions ?? []),
            ...(data.dashboard.morePromotionsWithoutPromotionalItems ?? [])
        ]) {
            if (promotion?.offerId && !excluded.has(promotion.offerId) && !promotions.has(promotion.offerId)) {
                promotions.set(promotion.offerId, promotion)
            }
        }
        // Promotional slots also contain weekly progress and onboarding banners.
        // Only import those when /earn exposes a matching signed activity.
        for (const promotion of [
            ...(data.dashboard.promotionalItems ?? []),
            ...(data.dashboard.promotionalItem ? [data.dashboard.promotionalItem] : [])
        ]) {
            if (
                promotion?.offerId &&
                !excluded.has(promotion.offerId) &&
                liveOffers.some(offer => offer.offerId === promotion.offerId && offer.reportable) &&
                !promotions.has(promotion.offerId)
            )
                promotions.set(promotion.offerId, promotion)
        }
        for (const offer of liveOffers) {
            if (!offer.reportable || excluded.has(offer.offerId)) continue
            const existing = promotions.get(offer.offerId)
            // Modern cards may omit promotionType and expose only their report activityType.
            const type = offer.promotionType?.toLowerCase() ?? ''
            if (/pcchild|pcparent/i.test(offer.offerId)) continue
            if (['search', 'claim', 'redeem', 'badge'].includes(type)) continue
            if (!existing && type !== 'urlreward' && offer.points <= 0) continue
            promotions.set(offer.offerId, {
                ...existing,
                offerId: offer.offerId,
                name: offer.name ?? existing?.name ?? null,
                title: offer.title || existing?.title || offer.offerId,
                promotionType: offer.promotionType || existing?.promotionType || 'urlreward',
                hash: offer.hash ?? existing?.hash ?? '',
                destinationUrl: offer.destination || existing?.destinationUrl || '',
                complete: offer.isCompleted,
                pointProgressMax: offer.points,
                activityType: String(offer.activityType ?? existing?.activityType ?? ''),
                exclusiveLockedFeatureStatus: offer.isLocked ? 'locked' : 'unlocked'
            } as BasePromotion)
        }

        for (const promotion of promotions.values()) {
            const type = promotion.promotionType?.toLowerCase() ?? ''
            if (['search', 'claim', 'redeem', 'badge'].includes(type) || /pcchild|pcparent/i.test(promotion.offerId)) {
                promotions.delete(promotion.offerId)
                continue
            }
            if (
                !promotion.promotionType &&
                liveOffers.some(offer => offer.offerId === promotion.offerId && offer.reportable)
            ) {
                promotion.promotionType = 'urlreward'
            }
        }
        const pending = [...promotions.values()].filter(promotion => this.isActionable(promotion))
        const belongsHere = (offer: ParsedOffer) =>
            !excluded.has(offer.offerId) && !/pcchild|pcparent/i.test(offer.offerId)
        const needsWork = (offer: ParsedOffer) =>
            belongsHere(offer) &&
            !offer.isCompleted &&
            !offer.isLocked &&
            !(offer.date && offer.date > new Date().toISOString().slice(0, 10)) &&
            !(this.bot.config.skipNonPointTasks && offer.points <= 0) &&
            !['search', 'claim', 'redeem', 'badge'].includes(offer.promotionType?.toLowerCase() ?? '')
        for (const offer of liveOffers.filter(belongsHere)) {
            const reason = offer.isCompleted
                ? 'completed'
                : offer.isLocked
                  ? 'locked-prerequisite'
                  : !offer.hash
                    ? 'missing-hash'
                    : needsWork(offer)
                      ? 'pending'
                      : 'deferred-or-other-worker'
            this.bot.logger.info(
                this.bot.isMobile,
                'MORE-PROMOTIONS',
                `Card status | offerId=${offer.offerId} | title=${JSON.stringify(offer.title)} | reason=${reason}`
            )
        }
        if (!pending.length) {
            this.bot.morePromotionsVerified =
                snapshot !== null && snapshot.morePromotionsAvailable !== false && !snapshot.unmatchedEarnCards && !liveOffers.some(needsWork)
            this.bot.logger.info(this.bot.isMobile, 'MORE-PROMOTIONS', 'No actionable "More Promotions" items found')
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'MORE-PROMOTIONS',
            `Started solving "More Promotions" items | remaining=${pending.length}`
        )
        await new PromotionActivityRunner(this.bot).run(pending)
        let verified = await this.bot.browser.func.refreshEarnSnapshot({ rendered: true })
        if (verified) this.bot.reactSnapshot = verified
        // Newly unlocked cards were not in the original pending list. Give one
        // extra wave a chance, then leave further progress to the next job.
        const newlyAvailable = (verified?.offers ?? []).filter(
            offer => needsWork(offer) && offer.reportable && !pending.some(p => p.offerId === offer.offerId)
        )
        if (newlyAvailable.length) {
            const extra = newlyAvailable.map(
                offer =>
                    ({
                        offerId: offer.offerId,
                        title: offer.title,
                        promotionType: offer.promotionType || 'urlreward',
                        pointProgressMax: offer.points,
                        activityType: String(offer.activityType ?? ''),
                        destinationUrl: offer.destination
                    }) as BasePromotion
            )
            pending.push(...extra)
            await new PromotionActivityRunner(this.bot).run(extra)
            verified = await this.bot.browser.func.refreshEarnSnapshot({ rendered: true })
            if (verified) this.bot.reactSnapshot = verified
        }
        // A click-through card may require visiting its destination. Only use
        // the current signed offer and existing account browser, once per card.
        const runner = new PromotionActivityRunner(this.bot)
        let visited = false
        for (const promotion of pending) {
            const live = verified?.offers.find(offer => offer.offerId === promotion.offerId)
            if (live?.reportable && (await runner.visitPromotion(promotion))) visited = true
        }
        if (visited) {
            verified = await this.bot.browser.func.refreshEarnSnapshot({ rendered: true })
            if (verified) this.bot.reactSnapshot = verified
        }
        const remaining = pending.filter(
            promotion => !verified?.offers.some(offer => offer.offerId === promotion.offerId && offer.isCompleted)
        )
        for (const offer of verified?.offers ?? snapshot?.offers ?? []) {
            if (excluded.has(offer.offerId) || /pcchild|pcparent/i.test(offer.offerId)) continue
            const reason = offer.isCompleted
                ? 'completed'
                : offer.isLocked
                  ? 'locked-prerequisite'
                  : offer.date && offer.date > new Date().toISOString().slice(0, 10)
                    ? 'future-dated'
                    : !offer.hash
                      ? 'missing-hash'
                      : this.bot.config.skipNonPointTasks && offer.points <= 0
                        ? 'non-point-task'
                        : ['search', 'claim', 'redeem', 'badge'].includes(offer.promotionType?.toLowerCase() ?? '')
                          ? 'handled-by-other-worker'
                          : pending.some(p => p.offerId === offer.offerId)
                            ? 'completion-unverified'
                            : 'newly-actionable'
            this.bot.logger.info(
                this.bot.isMobile,
                'MORE-PROMOTIONS',
                `Card status | offerId=${offer.offerId} | title=${JSON.stringify(offer.title)} | reason=${reason}`
            )
        }
        this.bot.morePromotionsVerified =
            verified !== null &&
            verified.morePromotionsAvailable !== false &&
            !verified.unmatchedEarnCards &&
            remaining.length === 0 &&
            !verified.offers.some(needsWork)
        if (!this.bot.morePromotionsVerified) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'MORE-PROMOTIONS',
                `Completion not verified | remaining=${remaining.length} | offers=${remaining.map(item => item.offerId).join(',')}`
            )
        }
        this.bot.logger.info(this.bot.isMobile, 'MORE-PROMOTIONS', 'Finished processing "More Promotions" items')
    }

    private isActionable(promotion: BasePromotion): boolean {
        if (promotion.complete || (this.bot.config.skipNonPointTasks && promotion.pointProgressMax <= 0)) return false
        if (promotion.exclusiveLockedFeatureStatus === 'locked' || !promotion.promotionType) return false
        return true
    }
}
