import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../../index'
import { readEarnPage, EARN_TASK_CONTROLS } from '../../../browser/parsers/EarnPageParser'
import {
    normalizeCardText,
    normalizeRewardUrl,
    type RenderedRewardCard
} from '../../../browser/parsers/RewardCardParser'
import { learningQuery } from '../../../util/Learning'
import { URLs } from '../../../constants/urls'
import { waitForActivity } from '../../../util/ActivityTiming'

export interface EarnClickState {
    attemptedKeys: Set<string>
    attemptedOfferIds: Set<string>
    waves: number
    complete: boolean
}

export function earnCardKey(card: RenderedRewardCard): string {
    return JSON.stringify([card.section, [...card.offerIds].sort(), card.title, card.destination])
}

export function earnClickDestination(raw: string, base: string): boolean {
    try {
        const url = new URL(raw, base)
        return (
            url.protocol === 'https:' &&
            !url.username &&
            !url.password &&
            [
                'bing.com',
                'www.bing.com',
                'rewards.bing.com',
                'youtube.com',
                'www.youtube.com',
                'm.youtube.com',
                'youtu.be'
            ].includes(url.hostname) &&
            !/\/apps?\/|\/redeem|\.(?:exe|msi|apk|zip)(?:$|\/)/i.test(url.pathname)
        )
    } catch {
        return false
    }
}

/** Click the Rewards control itself: external navigation alone loses its onClick report. */
export async function clickEarnCards(bot: MicrosoftRewardsBot, previous?: EarnClickState): Promise<EarnClickState> {
    const state = previous ?? { attemptedKeys: new Set(), attemptedOfferIds: new Set(), waves: 0, complete: false }
    if (!bot.config.activities.urlReward && !bot.config.activities.searchOnBing) return { ...state, complete: true }
    const result = await bot.browser.func.withRewardsPage(URLs.rewards.earn, async page => {
        const read = async () => {
            const rendered = await readEarnPage(page)
            const snapshot = bot.browser.react.snapshotPage(await page.content())
            const cards = rendered.cards.filter(
                card => ['moreactivities', 'exploreonbing'].includes(card.section) && card.parentControlIndex === null
            )
            const eligible = (card: RenderedRewardCard) => {
                if (card.disabled || card.complete || card.points <= 0) return false
                if (
                    card.section === 'exploreonbing'
                        ? !bot.config.activities.searchOnBing
                        : !bot.config.activities.urlReward
                )
                    return false
                const signed = snapshot.offers.filter(offer => card.offerIds.includes(offer.offerId))
                if (
                    signed.some(
                        offer =>
                            offer.isCompleted ||
                            offer.isDisabled ||
                            (offer.date && offer.date > new Date().toISOString().slice(0, 10)) ||
                            ['search', 'claim', 'redeem', 'badge'].includes(offer.promotionType?.toLowerCase() ?? '')
                    )
                )
                    return false
                return true
            }
            return {
                cards,
                pending: cards.filter(eligible),
                balance: snapshot.account.availablePoints ?? rendered.balance
            }
        }
        for (; state.waves < 2; state.waves++) {
            const wave = await read()
            const pending = wave.pending.filter(card => !state.attemptedKeys.has(earnCardKey(card)))
            if (!pending.length) break
            // Bound both new unlock waves and card count per run.
            for (const candidate of pending.slice(0, Math.max(0, 32 - state.attemptedKeys.size))) {
                const before = await read()
                const matches = before.pending.filter(item => earnCardKey(item) === earnCardKey(candidate))
                const card = matches.length === 1 ? matches[0] : undefined
                if (!card || !earnClickDestination(card.destination, page.url())) continue
                const key = earnCardKey(card)
                state.attemptedKeys.add(key)
                for (const id of card.offerIds) state.attemptedOfferIds.add(id)
                const signed = bot.browser.react
                    .snapshotPage(await page.content())
                    .offers.filter(
                        offer =>
                            card.offerIds.includes(offer.offerId) ||
                            (normalizeCardText(offer.title) === normalizeCardText(card.title) &&
                                normalizeRewardUrl(offer.destination, page.url(), true) ===
                                    normalizeRewardUrl(card.destination, page.url(), true))
                    )
                if (signed.length === 1) state.attemptedOfferIds.add(signed[0]!.offerId)
                const originalPages = new Set(page.context().pages())
                try {
                    const control = page.locator(EARN_TASK_CONTROLS).nth(card.index)
                    // Revalidate the locator after scrolling/streaming; indexes are never persistent identities.
                    if (
                        normalizeRewardUrl((await control.getAttribute('href')) ?? '', page.url()) !==
                        normalizeRewardUrl(card.destination, page.url())
                    )
                        continue
                    bot.normalSession?.assertActive()
                    const destination = new URL(card.destination, page.url())
                    if (
                        bot.normalSession?.active &&
                        /(^|\.)bing\.com$/.test(destination.hostname) &&
                        /\/search(?:\/|$)/.test(destination.pathname)
                    ) {
                        await learningQuery('activity', bot.isMobile, async () => {
                            const opened = page
                                .context()
                                .waitForEvent('page', { timeout: 10000 })
                                .catch(() => null)
                            await control.click({ timeout: 10_000, noWaitAfter: true })
                            const popup = await opened
                            await (popup || page)
                                .waitForLoadState('domcontentloaded', { timeout: 10000 })
                                .catch(() => {})
                        })
                    } else await control.click({ timeout: 10_000, noWaitAfter: true })
                    await waitForActivity(bot, bot.utils.randomDelay(5000, 15000))
                    let complete = false
                    let balance: number | null = null
                    for (let check = 0; check < 3; check++) {
                        if (check) await bot.utils.wait(2000)
                        await returnToEarn(page)
                        const after = await read()
                        const matches = after.cards.filter(item => earnCardKey(item) === key)
                        const signed = bot.browser.react
                            .snapshotPage(await page.content())
                            .offers.filter(offer => card.offerIds.includes(offer.offerId))
                        complete =
                            (matches.length === 1 && matches[0]!.complete) ||
                            (signed.length === 1 && signed[0]!.isCompleted)
                        balance = after.balance
                        if (complete) break
                    }
                    if (balance !== null) bot.userData.currentPoints = balance
                    const delta =
                        before.balance !== null && balance !== null && balance >= before.balance
                            ? balance - before.balance
                            : null
                    // Aggregate runtime accounting uses fresh before/after balances; never invent per-card credit.
                    bot.logger.info(
                        bot.isMobile,
                        'EARN-CARD-CLICK',
                        `title=${JSON.stringify(card.title)} | lockIcon=${Boolean(card.lockIcon)} | completionVerified=${complete}` +
                            ` | beforeBalance=${before.balance ?? 'unknown'} | afterBalance=${balance ?? 'unknown'} | balanceDelta=${delta ?? 'unknown'}`
                    )
                } catch {
                    bot.logger.warn(
                        bot.isMobile,
                        'EARN-CARD-CLICK',
                        `title=${JSON.stringify(card.title)} | reason=click-or-verification-failed`
                    )
                    await returnToEarn(page).catch(() => {})
                } finally {
                    for (const extra of page.context().pages()) {
                        if (!originalPages.has(extra)) await extra.close().catch(() => {})
                    }
                }
            }
        }
        const final = await read()
        state.complete = final.cards.length > 0 && final.pending.length === 0
        for (const card of final.pending)
            bot.logger.info(
                bot.isMobile,
                'EARN-CARD-CLICK',
                `title=${JSON.stringify(card.title)} | reason=${state.attemptedKeys.has(earnCardKey(card)) ? 'completion-unverified' : 'pending-or-unsupported-link'}`
            )
        return state
    })
    if (!result) state.complete = false
    return state
}

async function returnToEarn(page: Page): Promise<void> {
    await page.goto(URLs.rewards.earn, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.locator('main').waitFor({ state: 'visible', timeout: 5000 })
}
