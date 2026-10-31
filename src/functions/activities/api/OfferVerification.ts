import type { MicrosoftRewardsBot } from '../../../index'
import type { ParsedOffer } from '../../../browser/ReactFunc'
import { creditedPoints, pointDelta, pointValue } from '../../../util/PointAccounting'

/** v5-style verification: completion and attributable credit are independent signals. */
export async function verifyOffer(
    bot: MicrosoftRewardsBot,
    before: ParsedOffer,
    beforeBalance: number,
    responseBalance: number | null
): Promise<{ complete: boolean; gained: number | null; balance: number | null }> {
    let complete = false
    let gained: number | null = null
    let balance = pointValue(responseBalance)
    for (let check = 1; check <= 3; check++) {
        if (check > 1) await bot.utils.wait(2000)
        const snapshot = await bot.browser.func.refreshEarnSnapshot().catch(() => null)
        const after = snapshot?.offers.find(offer => offer.offerId === before.offerId)
        const freshBalance = pointValue(snapshot?.account?.availablePoints)
        if (freshBalance !== null) balance = freshBalance
        else if (bot.browser.func.getCurrentPoints) {
            const observed = await bot.browser.func.getCurrentPoints().catch(() => null)
            if (observed !== null) balance = observed
        }
        const delta = after && after.points === before.points
            ? pointDelta(before.pointProgress, after.pointProgress) : null
        const credit = creditedPoints(delta, beforeBalance, balance)
        if (credit !== null) gained = credit
        complete ||= after?.isCompleted === true
        bot.logger.debug(bot.isMobile, 'OFFER-VERIFY',
            `Offer verification | offerId=${before.offerId} | check=${check}/3 | complete=${complete}` +
            ` | progressDelta=${delta ?? 'unknown'} | pointsGained=${gained ?? 'unknown'}`)
        if (complete && gained !== null) break
    }
    return { complete, gained, balance }
}
