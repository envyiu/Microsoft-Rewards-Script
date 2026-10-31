export const NEW_ACCOUNT_DURATION_MS = 168 * 60 * 60_000
export const NEW_ACCOUNT_SERVICES = ['onedrive', 'todo', 'outlook', 'calendar']
export const NEW_ACCOUNT_QUERIES = { mobile: 20, desktop: 30 }

export function preRewardsActive(account, state, now = Date.now()) {
    if (!account?.newAccountMode) return false
    const readyAt = Date.parse(state?.newAccount?.readyAt || '')
    return !Number.isFinite(readyAt) || now < readyAt
}

export function newAccountStatus(account, state, now = Date.now()) {
    if (!account?.newAccountMode) return null
    const lifecycle = state?.newAccount || {}
    return {
        mode: preRewardsActive(account, state, now) ? 'preRewards' : 'rewards',
        startedAt: lifecycle.startedAt || null,
        readyAt: lifecycle.readyAt || null,
        needsAction: lifecycle.needsAction || false,
        services: lifecycle.services || [],
        queries: Object.fromEntries(['mobile', 'desktop'].map(p => [p, state?.platforms?.[p]?.queries || 0])),
        targets: NEW_ACCOUNT_QUERIES
    }
}
