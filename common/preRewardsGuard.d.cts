import type { BrowserContext } from 'patchright'
export function isRewardsUrl(url: string): boolean
export function installPreRewardsGuard(context: BrowserContext, options?: { onBlocked?: (location: string) => void }): Promise<void>
