import type { MicrosoftRewardsBot } from '../index'

/** Discretionary activity pacing only; browser readiness and HTTP timeouts remain real waits. */
export async function waitForActivity(bot: MicrosoftRewardsBot, time: number | string): Promise<void> {
    await bot.utils.wait(time)
}

/** Conservative query guards already wait before reconciling; legacy paths wait here. */
export async function waitForSearch(bot: MicrosoftRewardsBot, normalDelay: number): Promise<void> {
    if (!bot.normalSession?.active) await bot.utils.wait(normalDelay)
}
