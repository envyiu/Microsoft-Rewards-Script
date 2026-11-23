const MINUTE = 60_000
const HOUR = 60 * MINUTE

// Count projected occupied worker time in the current hour, including starts admitted in this drain.
export function hourlyLoadAdmission(config, jobs, completed, running, requested, now) {
    if (!config.spreadLoadV1) return () => true
    const begins = Math.floor(now / HOUR) * HOUR
    const ends = begins + HOUR
    const overlap = (start, end) =>
        Number.isFinite(start) && Number.isFinite(end)
            ? Math.max(0, Math.min(end, ends) - Math.max(start, begins))
            : 0
    const estimateDuration = job =>
        job.estimatedSessionMs ?? config.spreadDurationMs?.[job.type + ':' + job.platform] ?? 10 * MINUTE
    const pending = new Map()
    for (const job of jobs) {
        if (!job.dueAt || !Number.isFinite(job.remainingWorkMs)) continue
        const work = pending.get(job.accountIndex)
        if (!work || job.remainingWorkMs > work.remainingWorkMs) pending.set(job.accountIndex, job)
    }
    const left = [...pending.values()]
    if (!left.length) return () => true
    const hoursLeft = Math.max(1, Math.max(...left.map(job => job.timeToDeadlineMs)) / HOUR)
    const totalWork = left.reduce((sum, job) => sum + job.remainingWorkMs, 0)
    // A whole session may exceed the average. Allow one such session to start in an empty hour.
    const budget = Math.ceil(totalWork / hoursLeft / MINUTE) * MINUTE
    let occupied = completed.reduce(
        (sum, session) => sum + overlap(Date.parse(session.startedAt), Date.parse(session.endedAt)),
        0
    )
    for (const record of running) {
        const start = Date.parse(record.startedAt) || now
        occupied += overlap(start, Math.max(now, start + estimateDuration(record.job)))
    }
    return job => {
        const duration = estimateDuration(job)
        const projected = overlap(now, now + duration)
        const canWaitUntilNextHour = job.completionSlackMs > ends - now
        if (
            !job.urgent &&
            !requested.has(job.accountIndex) &&
            canWaitUntilNextHour &&
            occupied > 0 &&
            occupied + projected > budget
        )
            return false
        occupied += projected
        return true
    }
}

export const proxyCooldownMethods = {
    _proxyDispatchUntil(job, now = Date.now()) {
        const until = this._proxyCooldownUntil(job.networkGroup, job.accountIndex, now)
        if (!until || !this.document.config.spreadLoadV1) return until
        if (job.urgent || this.document.state.onceAccounts?.includes(job.accountIndex)) return 0
        const eligible = Math.max(now, Date.parse(job.dueAt || '') || now)
        return until - eligible > Math.max(0, job.completionSlackMs ?? Infinity) ? 0 : until
    }
}
