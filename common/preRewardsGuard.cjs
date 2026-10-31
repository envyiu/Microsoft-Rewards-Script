'use strict'
const guardedContexts = new WeakSet()

// Shared by browser execution and the manual-browser helper. Match by host
// and path, never by substring: Bing searches may legitimately mention Rewards.
function isRewardsUrl(raw) {
    let url
    try { url = new URL(raw) } catch { return false }
    if (!['http:', 'https:'].includes(url.protocol)) return false
    const host = url.hostname.toLowerCase()
    if (host === 'rewards.bing.com' || host.endsWith('.rewards.bing.com')) return true
    if (host === 'rewards.microsoft.com' || host.endsWith('.rewards.microsoft.com')) return true
    if (host === 'account.microsoft.com' && /^\/rewards(?:\/|$)/i.test(url.pathname)) return true
    if (host === 'rewardsplatform.microsoft.com' || host.endsWith('.rewardsplatform.microsoft.com')) return true
    if (host === 'bing.com' || host.endsWith('.bing.com'))
        return /^\/(?:rewards(?:\/|$)|rewardsapp(?:\/|$)|api\/rewards(?:\/|$))/i.test(url.pathname)
    return false
}

async function installPreRewardsGuard(context, { onBlocked = () => {} } = {}) {
    if (guardedContexts.has(context)) return
    const reported = new Set()
    await context.route('**/*', async route => {
        if (isRewardsUrl(route.request().url())) {
            const url = new URL(route.request().url())
            const location = url.hostname + url.pathname
            if (!reported.has(location)) { reported.add(location); onBlocked(location) }
            await route.abort('blockedbyclient')
        }
        else await route.fallback()
    })
    guardedContexts.add(context)
}

module.exports = { isRewardsUrl, installPreRewardsGuard }
