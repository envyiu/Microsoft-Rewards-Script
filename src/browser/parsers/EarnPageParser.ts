// Adapted from TheNetsky/Microsoft-Rewards-Script v5.0.0 (GPL-3.0-or-later).
import type { Page } from 'patchright'
import { readRewardCards } from './RewardCardParser'

export const EARN_TASK_SECTIONS = '#dailyset, #exploreonbing, #quests, #moreactivities'
export const DAILY_SET_LINKS = '#dailyset a[href], #dailyset [role="link"][href]'
export const MORE_ACTIVITIES_LINKS =
    '#exploreonbing a[href], #exploreonbing [role="link"][href], #moreactivities a[href], #moreactivities [role="link"][href]'
export const EARN_TASK_CONTROLS = `${DAILY_SET_LINKS}, ${MORE_ACTIVITIES_LINKS}`

export async function readEarnPage(page: Page) {
    // Rewards lazily renders sections below the viewport (especially in mobile
    // account contexts). Read each visible section after scrolling it into view.
    const observed = new Map<number, Awaited<ReturnType<typeof readRewardCards>>[number]>()
    const capture = async () => {
        for (const card of await readRewardCards(page, page.locator(EARN_TASK_CONTROLS)))
            if (card.visible) observed.set(card.index, card)
    }
    await capture()
    for (const section of (await page.locator('#dailyset:visible, #exploreonbing:visible, #moreactivities:visible').all()).slice(0, 8)) {
        await section.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {})
        await section.locator('h3, .promo-title').first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {})
        await capture()
    }
    const cards = [...observed.values()]
        .filter(card => card.visible && card.title)
        .map(card => ({ ...card, offerId: card.offerIds.length === 1 ? card.offerIds[0]! : null }))
    const account = await page.locator('header button[aria-expanded] p').evaluateAll(elements => {
        const text = (value: string | null | undefined) =>
            (value ?? '')
                .replace(/[\u200b-\u200d\ufeff]/g, '')
                .replace(/\s+/g, ' ')
                .trim()
        const visible = (element: Element) => {
            const style = getComputedStyle(element)
            return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0
        }
        const balances = elements
            .filter(visible)
            .map(element => text(element.textContent))
            .filter(value => /^\d[\d\s.,]*$/.test(value))
            .map(value => Number(value.replace(/[^0-9]/g, '')))
        const streakResetText =
            [...document.querySelectorAll('#streaks span.text-metadata')]
                .filter(visible)
                .map(element => text(element.textContent))
                .find(value => /reset/i.test(value)) ?? null
        return { balance: balances.length === 1 ? balances[0]! : null, streakResetText }
    })
    return { cards, ...account }
}
