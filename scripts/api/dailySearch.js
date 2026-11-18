import crypto from 'node:crypto'
import rewards from '../../packages/contracts/rewards.cjs'

export function captureSearchStreak(state, email, message, now = Date.now()) {
    const observation = rewards.parseRewardsStreak(message)
    if (
        !state ||
        observation?.status !== 'fresh' ||
        observation.email.toLowerCase() !== email.toLowerCase() ||
        Date.parse(observation.observedAt) > now + 60000 ||
        Date.parse(observation.observedAt) <= (Date.parse(state.searchStreak?.observedAt || '') || 0)
    )
        return false
    state.searchStreak = { dailyCounter: observation.dailyCounter, observedAt: observation.observedAt }
    return true
}

// This ledger travels with the account planner. A missing/uncertain outcome
// keeps its full pre-spawn reservation; retries and handoffs cannot refill it.
export function dailySearchRemaining(state, limits, platform, streakPolicy = false) {
    if (!limits && !streakPolicy) {
        for (const key of ['dailySearchTarget', 'dailySearchUsed', 'dailySearchComplete'])
            delete state.platforms[platform][key]
        return null
    }
    state.dailySearch ??= {
        targets: {},
        reservations: {},
        baseline: Object.fromEntries(
            ['mobile', 'desktop'].map(p => [
                p,
                Math.max(state.platforms[p].queries || 0, state.learningQueries?.[p] || 0)
            ])
        )
    }
    const ledger = state.dailySearch
    const range = limits?.[platform]
    if (streakPolicy) {
        const streak =
            Number.isSafeInteger(state.searchStreak?.dailyCounter) && state.searchStreak.dailyCounter >= 0
                ? state.searchStreak.dailyCounter
                : 0
        const percent = 30 + 2 * Math.min(streak, 30)
        ledger.targets[platform] = Math.floor(((platform === 'desktop' ? 30 : 20) * percent) / 100)
        state.searchQuotaPolicy = { streak, observedAt: state.searchStreak?.observedAt || null, percent }
    } else if (
        ledger.targets[platform] == null ||
        ledger.targets[platform] < range.min ||
        ledger.targets[platform] > range.max
    ) {
        const seed = crypto
            .createHash('sha256')
            .update(`${state.email}:${state.day}:${platform}`)
            .digest()
            .readUInt32BE()
        ledger.targets[platform] = range.min + (seed % (range.max - range.min + 1))
    }
    const used =
        (ledger.baseline[platform] || 0) +
        Object.values(ledger.reservations)
            .filter(r => r.platform === platform)
            .reduce((sum, r) => sum + (r.used ?? r.budget), 0)
    Object.assign(state.platforms[platform], {
        dailySearchTarget: ledger.targets[platform],
        dailySearchUsed: used,
        dailySearchComplete: used >= ledger.targets[platform]
    })
    return Math.max(0, ledger.targets[platform] - used)
}

export function reserveDailySearch(state, job, budget) {
    if (!state.dailySearch || budget <= 0) return
    const id = crypto.randomUUID()
    state.dailySearch.reservations[id] = { platform: job.platform, budget }
    job.dailySearchReservation = id
}

export function settleDailySearch(state, job, used) {
    if (state?.day !== job.day || !Number.isSafeInteger(used) || used < 0) return
    const reservation = state.dailySearch?.reservations[job.dailySearchReservation]
    if (reservation) reservation.used = Math.min(reservation.budget, used)
}
