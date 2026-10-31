import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { isRewardsUrl, installPreRewardsGuard } = require('../../common/preRewardsGuard.cjs')

test('Rewards endpoints are blocked without blocking normal Bing search or Microsoft services', () => {
    for (const url of [
        'https://rewards.bing.com/earn',
        'https://prod.rewardsplatform.microsoft.com/dapi/me',
        'https://rewards.microsoft.com/',
        'https://account.microsoft.com/rewards/',
        'https://www.bing.com/rewards/panelflyout/getuserinfo?channel=BingFlyout',
        'https://www.bing.com/rewardsapp/flyout'
    ]) assert.equal(isRewardsUrl(url), true, url)
    for (const url of [
        'https://www.bing.com/search?q=microsoft+rewards',
        'https://login.live.com/',
        'https://outlook.live.com/calendar/',
        'https://rewards.bing.com.example.test/',
        'about:blank'
    ]) assert.equal(isRewardsUrl(url), false, url)
})

test('context guard handles redirects, popup and background requests through the same route', async () => {
    let handler
    await installPreRewardsGuard({ route: async (_pattern, fn) => { handler = fn } })
    let aborts = 0, passes = 0
    for (const url of ['https://rewards.bing.com/dashboard', 'https://www.bing.com/search?q=test']) {
        await handler({ request: () => ({ url: () => url }), abort: async () => { aborts++ }, fallback: async () => { passes++ } })
    }
    assert.equal(aborts, 1)
    assert.equal(passes, 1)
})
