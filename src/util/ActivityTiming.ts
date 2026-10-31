import type { MicrosoftRewardsBot } from '../index'

/** Discretionary activity pacing only; browser readiness and HTTP timeouts remain real waits. */
export async function waitForActivity(bot: MicrosoftRewardsBot, time: number | string): Promise<void> {
    if (!bot.executionPlan?.urgent) await bot.utils.wait(time)
}

/** Search credit needs time to settle even when other activity pacing is skipped. */
export async function waitForSearch(bot: MicrosoftRewardsBot, normalDelay: number): Promise<void> {
    await bot.utils.wait(bot.executionPlan?.urgent ? bot.utils.randomDelay(5000, 8000) : normalDelay)
}
