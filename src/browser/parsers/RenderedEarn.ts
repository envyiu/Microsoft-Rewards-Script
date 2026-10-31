import type { PageSnapshot, ParsedOffer } from '../ReactFunc'
import { normalizeCardText, normalizeRewardUrl, type RenderedRewardCard } from './RewardCardParser'

/** Rendered state supplements signed RSC offers; it never manufactures an action hash. */
export function mergeRenderedEarn(snapshot: PageSnapshot, cards: RenderedRewardCard[], base: string): number {
    let unmatched = 0
    for (const card of cards.filter(card => card.visible && card.parentControlIndex === null)) {
        const candidates = snapshot.offers.filter(offer => {
            if (card.offerIds.length) return card.offerIds.includes(offer.offerId)
            const destination = normalizeRewardUrl(offer.destination, base, true)
            return destination !== null && destination === normalizeRewardUrl(card.destination, base, true) &&
                normalizeCardText(offer.title) === normalizeCardText(card.title)
        })
        if (candidates.length !== 1) {
            if (!card.disabled && !card.complete && card.points > 0) unmatched++
            continue
        }
        const offer = candidates[0] as ParsedOffer
        offer.title ||= card.title
        offer.description ||= card.description
        offer.destination ||= card.destination
        offer.isCompleted ||= card.complete
        offer.isLocked ||= card.disabled
        offer.reportable = offer.reportable && !offer.isCompleted && !offer.isLocked
    }
    snapshot.reportable = snapshot.offers.filter(offer => offer.reportable)
    return unmatched
}
