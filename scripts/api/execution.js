export const RUNTIME_MAX_AGE_MS = 15000

export function runtimeFresh(node, now = Date.now()) {
    const age = now - Date.parse(node?.observedAt)
    return Boolean(node?.online && Number.isFinite(age) && age >= 0 && age <= RUNTIME_MAX_AGE_MS)
}

export function accountExecutions(accounts, smart, legacy, metadata = () => ({}), now = Date.now()) {
    const nodes = smart.hybrid?.nodes || []
    return Object.fromEntries(
        accounts.map(account => {
            const info = metadata(account) || {}
            const nodeId = info.nodeId || (info.node === 'vps' ? 'vps' : 'local')
            const remote = info.node === 'vps' || nodeId !== 'local'
            const node =
                nodes.find(node => node.id === nodeId) ||
                (!nodes.length && smart.hybrid
                    ? {
                          online: smart.hybrid.online,
                          observedAt: smart.hybrid.syncedAt
                      }
                    : null)
            const known = !remote || runtimeFresh(node, now)
            const job =
                known &&
                smart.running.find(
                    job =>
                        job.accountIndex === account.index &&
                        (!job.nodeId || job.nodeId === nodeId) &&
                        (!job.email || job.email.toLowerCase() === account.email.toLowerCase())
                )
            const legacyActive =
                !remote &&
                legacy.alive &&
                legacy.run?.live?.currentAccount?.toLowerCase() === account.email.toLowerCase()
            const live = job || legacyActive
            const state = !known ? 'unknown' : live ? job?.state || legacy.state || 'running' : 'idle'
            return [
                account.index,
                {
                    state: ['starting', 'running', 'stopping', 'idle', 'unknown'].includes(state) ? state : 'running',
                    observedAt: remote ? node?.observedAt || null : new Date(now).toISOString(),
                    nodeId,
                    jobId: job
                        ? job.executionId || job.id
                        : legacyActive
                          ? `legacy:${legacy.pid}:${legacy.startedAt}`
                          : null,
                    phase: job?.phase || (legacyActive ? 'working' : null),
                    pid: job?.pid || (legacyActive ? legacy.pid : null),
                    nextEligibleAt: smart.accounts?.[String(account.index)]?.manualStopUntil || null
                }
            ]
        })
    )
}
