import { newAccountDurationMs, NEW_ACCOUNT_POLICIES } from '../../packages/contracts/newAccount.js'

// Offline recovery: apply only facts already present in the durable worker log.
// No events are emitted and business-event identities/cursors are unchanged.
export function recoverSmartState(document, events, now = new Date()) {
    const result = structuredClone(document),
        day = new Intl.DateTimeFormat('en-CA', { timeZone: result.config.timezone || 'Asia/Ho_Chi_Minh' }).format(now)
    const summaries = [],
        starts = new Map(),
        queries = new Map(),
        quotas = new Map(),
        history = [],
        restored = new Set()
    const fields = message =>
        Object.fromEntries(
            String(message || '')
                .split(' | ')
                .map(s => {
                    const i = s.indexOf('=')
                    return [s.slice(0, i), s.slice(i + 1)]
                })
        )
    for (const event of events) {
        const e = event.payload || event,
            jobId = e.smartJobId,
            match = /^(\d{4}-\d\d-\d\d)-(\d+)-(.*)$/.exec(jobId || '')
        if (!match) continue
        const index = match[2],
            state = result.state.accounts[index]
        if (!state) continue
        if (e.title === 'NEW-ACCOUNT-CHECKPOINT') {
            let p
            try {
                p = JSON.parse(e.message)
            } catch {
                continue
            }
            if (p.jobId !== jobId || !Number.isFinite(Date.parse(p.at)) || !(p.queries > 0)) continue
            state.newAccount ??= { services: [] }
            // The earliest retained query is not necessarily the first lifetime query.
            // Never invent a new seven-day period from a pruned event journal.
            if (!state.newAccount.startedAt) {
                const policy = p.policy || state.newAccount.policy || 'standard168h'
                if (
                    NEW_ACCOUNT_POLICIES.includes(policy) &&
                    (!state.newAccount.policy || state.newAccount.policy === policy) &&
                    Number.isFinite(Date.parse(p.startedAt)) &&
                    Date.parse(p.startedAt) <= Date.parse(p.at) &&
                    Number.isFinite(Date.parse(p.readyAt)) &&
                    Date.parse(p.readyAt) - Date.parse(p.startedAt) === newAccountDurationMs(policy)
                ) {
                    state.newAccount.policy = policy
                    state.newAccount.startedAt = p.startedAt
                    state.newAccount.readyAt = p.readyAt
                } else state.newAccount.recoveryNeedsReview = true
            }
        }
        if (match[1] !== day || state.day !== day) continue
        const f = fields(e.message),
            platform = /-(desktop|mobile)-/.exec(jobId)?.[1],
            key = index + ':' + platform
        const at = typeof event.ts === 'number' ? new Date(event.ts).toISOString() : e.receivedAt
        if (e.title === 'SMART-WORKER-END' && f.worker) {
            state.workersCompleted = [...new Set([...(state.workersCompleted || []), f.worker])]
            state.workersFailed = (state.workersFailed || []).filter(w => w !== f.worker)
            restored.add(index)
        }
        if (e.title === 'SMART-SESSION' && /Session start/.test(e.message) && platform) {
            const budget = /^(?:desktop|mobile)-(\d+)$/.exec(match[3])
            if (budget) starts.set(jobId, { key, budget: Number(budget[1]) })
        }
        if (
            e.title === 'SMART-SEARCH-START' &&
            platform &&
            Number.isSafeInteger(Number(f.budget)) &&
            Number(f.budget) >= 0
        )
            starts.set(jobId, { key, budget: Number(f.budget) })
        if (
            e.title === 'SMART-SEARCH-END' &&
            platform &&
            Number.isSafeInteger(Number(f.queries)) &&
            Number(f.queries) >= 0
        ) {
            summaries.push({ key, queries: Number(f.queries) })
            starts.delete(jobId)
        }
        if (e.title === 'SMART-QUOTA') {
            let p
            try {
                p = JSON.parse(e.message)
            } catch {
                continue
            }
            if (!Number.isFinite(Date.parse(p.readAt)) || !p.readAt.startsWith(day)) continue
            for (const name of ['desktop', 'mobile']) {
                const q = p[name],
                    k = index + ':' + name
                if (
                    q &&
                    Number.isFinite(q.max) &&
                    Number.isFinite(q.progress) &&
                    q.max >= 0 &&
                    q.progress >= 0 &&
                    q.progress <= q.max &&
                    (!quotas.has(k) || quotas.get(k).at < p.readAt)
                )
                    quotas.set(k, { remaining: q.max - q.progress, at: p.readAt })
            }
        }
        if (e.title === 'SMART-SESSION' && /Session end/.test(e.message) && at) {
            history.push({
                id: jobId,
                accountIndex: Number(index),
                day,
                type: match[3].startsWith('workers-') ? 'workers' : platform ? 'search' : 'quota',
                ...(platform ? { platform } : {}),
                endedAt: at,
                success: f.success === 'true',
                recovered: true,
                recoveryEventId: e.sourceEventId || e.id
            })
        }
    }
    for (const s of summaries) queries.set(s.key, (queries.get(s.key) || 0) + s.queries)
    // A started search with no final checkpoint may have issued every reserved query.
    for (const s of starts.values()) queries.set(s.key, (queries.get(s.key) || 0) + s.budget)
    for (const [key, count] of queries) {
        const [index, name] = key.split(':')
        const p = result.state.accounts[index].platforms?.[name]
        if (p) {
            p.queries = Math.max(p.queries || 0, count)
            restored.add(index)
        }
    }
    for (const [key, q] of quotas) {
        const [index, name] = key.split(':')
        const p = result.state.accounts[index].platforms?.[name]
        if (p) {
            p.remaining = q.remaining
            p.quotaKnown = true
            p.complete = q.remaining === 0
            p.quotaCheckedAt = q.at
            restored.add(index)
        }
    }
    const known = new Set((result.state.sessions || []).map(s => s.recoveryEventId).filter(Boolean))
    result.state.sessions = [
        ...(result.state.sessions || []),
        ...history.filter(s => !known.has(s.recoveryEventId))
    ].slice(-500)
    result.config.enabled = false // Manager must explicitly reconcile/resume after recovery.
    result.state.recoveredAt = now.toISOString()
    return {
        document: result,
        summary: {
            accounts: restored.size,
            sessions: history.length,
            uncertainSearches: starts.size,
            lifecycleReviews: Object.values(result.state.accounts).filter(s => s.newAccount?.recoveryNeedsReview).length
        }
    }
}
