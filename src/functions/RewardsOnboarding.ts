import type { Page, Locator } from 'patchright'
import type { MicrosoftRewardsBot } from '../index'
import { URLs } from '../constants/urls'
import { errorDiagnostic } from '../util/ErrorDiagnostic'

async function visible(locator: Locator): Promise<boolean> {
    return locator.isVisible().catch(() => false)
}

async function checked(locator: Locator): Promise<boolean> {
    return await locator.getAttribute('aria-checked') === 'true' || await locator.isChecked().catch(() => false)
}

async function clickChoice(locator: Locator): Promise<void> {
    const label = locator.locator('xpath=ancestor::label[1]')
    await (await visible(label) ? label : locator).click({ timeout: 5000 })
}

async function clickNamed(page: Page, name: RegExp): Promise<boolean> {
    for (const role of ['button', 'link'] as const) {
        const locator = page.getByRole(role, { name }).first()
        if (await visible(locator)) {
            await locator.scrollIntoViewIfNeeded()
            await locator.click({ timeout: 5000 })
            return true
        }
    }
    return false
}

async function task(page: Page, name: RegExp): Promise<boolean> {
    if (await clickNamed(page, name)) return true
    const title = page.getByText(name).first()
    if (!await visible(title)) return false
    const card = title.locator('xpath=ancestor::*[self::a or self::button or @role="button"][1]')
    if (!await visible(card)) return false
    await card.click({ timeout: 5000 })
    return true
}

export async function runRewardsOnboarding(bot: MicrosoftRewardsBot, page: Page, force = false): Promise<void> {
    const initial = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')
    if (!force && !/get started with rewards|welcome to\s+microsoft rewards/i.test(initial)) return
    const deadline = Date.now() + 120000
    let step = 'welcome'
    const dashboard = async () => {
        await page.goto(URLs.rewards.dashboard, { waitUntil: 'domcontentloaded', timeout: 15000 })
        await page.locator('body').waitFor({ state: 'visible', timeout: 5000 })
    }
    const progress = async () => {
        for (let attempt = 0; attempt < 20; attempt++) {
            const text = await page.locator('body').innerText({ timeout: 5000 })
            const match = /\b([0-7])\s*\/\s*7\s*tasks\b/i.exec(text)
            if (match) return Number(match[1])
            if (bot.shuttingDown || Date.now() >= deadline) break
            await page.waitForTimeout(250)
        }
        return null
    }
    const report = (step: string, before: number | null, after: number | null) => {
        const verified = before != null && after != null && after > before
        bot.logger.info(bot.isMobile, 'REWARDS-ONBOARDING', `step=${step} | status=${verified ? 'verified' : 'pending'} | progress=${after ?? 'unknown'}/7`)
    }
    const closeTour = async (wait = false) => {
        const tutorial = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: /^close$/i }) }).first()
        if (wait) await tutorial.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {})
        if (await visible(tutorial)) {
            await tutorial.getByRole('button', { name: /^close$/i }).click({ timeout: 5000 })
            await tutorial.waitFor({ state: 'hidden', timeout: 5000 })
        }
    }
    try {
        let dialog = page.getByRole('dialog').filter({ hasText: /welcome to\s*microsoft rewards/i }).first()
        if (!await visible(dialog)) dialog = page.getByRole('heading', { name: /welcome to\s*microsoft rewards/i }).first()
            .locator('xpath=ancestor::div[.//button[normalize-space(.)="Get started"]][1]')
        if (await visible(dialog)) await dialog.getByRole('button', { name: /^get started$/i }).click({ timeout: 5000 })
        step = 'dashboard'
        await dashboard()
        if (await progress() === 7) return
        const beforeTour = await progress()
        for (const label of [/^your progress(?:\s|$)/i, /^daily set(?:\s|$)/i, /^your activity(?:\s|$)/i, /^achievements(?:\s|$)/i]) {
            step = 'tour'
            if (Date.now() >= deadline || bot.shuttingDown) return
            await closeTour()
            const title = page.getByText(label).first()
            if (!await visible(title)) continue
            await title.scrollIntoViewIfNeeded()
            let toggle = title.locator('xpath=ancestor-or-self::*[@aria-expanded][1]')
            if (!await visible(toggle)) toggle = title.locator('xpath=..').getByRole('button').first()
            if (await visible(toggle) && await toggle.getAttribute('aria-expanded') !== 'true') {
                await toggle.click({ timeout: 5000 })
                await closeTour(true)
            }
        }
        await dashboard()
        report('tour', beforeTour, await progress())
        if (Date.now() >= deadline || bot.shuttingDown) return
        const beforeGoal = await progress()
        step = 'goal'
        const hasGoal = await visible(page.getByText(/^your (?:rewards )?goal$/i).first())
        if (hasGoal) bot.logger.info(bot.isMobile, 'REWARDS-ONBOARDING', `step=goal | status=already-applied | progress=${beforeGoal ?? 'unknown'}/7`)
        if (!hasGoal && await task(page, /^set a rewards goal$/i)) {
            await page.getByText(/^roblox digital card$/i).first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
            // Never alter an existing goal, and never operate a redemption CTA.
            const existingGoal = page.getByRole('switch', { name: /set as your rewards goal/i }).first()
            if (!(await visible(existingGoal) && await checked(existingGoal))) {
                if (await task(page, /^roblox digital card$/i)) {
                    await page.getByText(/^set as your rewards goal$/i).first().waitFor({ state: 'visible', timeout: 10000 })
                    const options = page.getByRole('button', { name: /^\d[\d,]* robux$/i })
                    const values = await options.allTextContents()
                    const selected = values.map((value, index) => ({ index, amount: Number(value.replace(/\D/g, '')) })).filter(v => v.amount > 0).sort((a,b) => a.amount - b.amount)[0]
                    if (selected) await options.nth(selected.index).click({ timeout: 5000 })
                    let goalSwitch = page.getByRole('switch', { name: /set as your rewards goal/i }).first()
                    if (!await visible(goalSwitch)) goalSwitch = page.getByText(/^set as your rewards goal$/i).first().locator('xpath=..').getByRole('switch').first()
                    if (await visible(goalSwitch)) {
                        if (!await checked(goalSwitch)) await clickChoice(goalSwitch)
                    } else await task(page, /^set as your rewards goal$/i)
                    let goalDialog = page.getByRole('dialog').filter({ hasText: /set a rewards goal/i }).first()
                    await page.getByText(/track and manually redeem your reward/i).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
                    if (!await visible(goalDialog)) goalDialog = page.getByRole('heading', { name: /^set a rewards goal$/i }).first()
                        .locator('xpath=ancestor::div[.//button[normalize-space(.)="Next"]][1]')
                    if (!await visible(goalDialog)) throw new Error('Manual goal dialog is unavailable after opening the goal control')
                    if (await visible(goalDialog)) {
                        const manual = goalDialog.getByRole('radio', { name: /track and manually redeem your reward/i })
                        if (await visible(manual)) {
                            if (!await checked(manual)) await clickChoice(manual)
                        }
                        else {
                            const label = goalDialog.getByText(/track and manually redeem your reward/i).first()
                            if (!await visible(label)) throw new Error('Manual redemption option is unavailable')
                            await label.click({ timeout: 5000 })
                        }
                        await goalDialog.getByRole('button', { name: /^next$/i }).click({ timeout: 5000 })
                        await page.getByRole('button', { name: /^(?:okay|ok)$/i }).first().click({ timeout: 10000 })
                    }
                }
            }
            await dashboard()
            report('goal', beforeGoal, await progress())
        }
        for (const [taskStep, label] of [['browse-earn', /^browse the earn page$/i], ['learn-level', /^learn your level$/i]] as const) {
            step = taskStep
            if (Date.now() >= deadline || bot.shuttingDown) return
            const before = await progress()
            if (await task(page, label)) {
                await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {})
                await dashboard()
                report(taskStep, before, await progress())
            }
        }
        bot.logger.info(bot.isMobile, 'REWARDS-ONBOARDING', `step=summary | progress=${await progress() ?? 'unknown'}/7`)
        if (bot.browser?.react) {
            const snapshot = bot.browser.react.snapshotPage(await page.content())
            const tasks = snapshot.offers.filter(offer => /^WW_pcchild\d+_redesign_newuser_onboarding_offer_punchcard$/i.test(offer.offerId))
                .map(offer => ({ title: offer.title, completed: offer.isCompleted }))
            bot.logger.info(bot.isMobile, 'REWARDS-ONBOARDING', `step=tasks | ${JSON.stringify(tasks)}`)
        }
    } catch (error) {
        bot.logger.warn(bot.isMobile, 'REWARDS-ONBOARDING', `step=${step} | status=pending | reason=unrecognized-or-unconfirmed-step`)
        if (bot.config?.errorDiagnostics) await errorDiagnostic(page, error instanceof Error ? error : new Error(`Rewards onboarding unconfirmed at ${step}`))
    }
}
