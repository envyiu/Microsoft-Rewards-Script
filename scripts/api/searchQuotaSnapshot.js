const MAX_SNAPSHOT_AGE_MS = 10 * 60_000

export function parseSearchQuotaSnapshot(message, now = Date.now()) {
    let value
    try {
        value = JSON.parse(message)
    } catch {
        return null
    }
    if (!value || typeof value !== 'object' || typeof value.readAt !== 'string') return null
    const readAt = Date.parse(value.readAt)
    if (!Number.isFinite(readAt) || readAt > now + 60_000 || now - readAt > MAX_SNAPSHOT_AGE_MS) return null
    const snapshot = { readAt: new Date(readAt).toISOString() }
    for (const platform of ['desktop', 'mobile']) {
        const counter = value[platform]
        snapshot[platform] =
            counter &&
            typeof counter === 'object' &&
            Number.isFinite(counter.max) &&
            counter.max > 0 &&
            Number.isFinite(counter.progress) &&
            counter.progress >= 0 &&
            counter.progress <= counter.max
                ? { max: counter.max, progress: counter.progress }
                : null
    }
    return snapshot
}

export function reconcileSearchQuota(state, snapshot, { skipPlatform = null } = {}) {
    const reopened = []
    const readAt = Date.parse(snapshot.readAt)
    for (const platform of ['desktop', 'mobile']) {
        const counter = snapshot[platform],
            target = state.platforms[platform]
        if (!counter || !target || platform === skipPlatform || readAt <= (Date.parse(target.quotaReadAt || '') || 0))
            continue
        const remaining = counter.max - counter.progress
        const recoveryKey = `${state.day}:${counter.max}:${counter.progress}`
        // A fresh positive quota may recover a terminal state once per observed
        // counter value. Repeating the same snapshot cannot renew retries forever.
        const recover = remaining > 0 && (target.complete || target.failed) && target.quotaRecoveryKey !== recoveryKey
        target.quotaReadAt = snapshot.readAt
        target.quotaMax = counter.max
        target.quotaProgress = counter.progress
        target.quotaKnown = true
        target.remaining = remaining
        if (remaining === 0 || recover) {
            target.complete = remaining === 0
            target.failed = false
            target.failures = 0
            if (recover) {
                target.quotaRecoveryKey = recoveryKey
                target.cooldownUntil = snapshot.readAt
                state.probeUsed[platform] = false
                reopened.push(platform)
            }
        }
    }
    if (readAt > (Date.parse(state.quotaCheckedAt || '') || 0)) state.quotaCheckedAt = snapshot.readAt
    return reopened
}
