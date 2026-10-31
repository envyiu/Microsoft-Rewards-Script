'use strict'

// Versioned, browser-free observation contract used by both log consumers.
function parseRewardsStreak(message) {
    try {
        if (typeof message !== 'string' || message.length > 16384) return null
        const value = JSON.parse(message)
        const count = n => Number.isSafeInteger(n) && n >= 0
        if (
            value.version !== 1 ||
            typeof value.email !== 'string' ||
            !/^\S+@\S+$/.test(value.email) ||
            value.source !== 'rewards-page' ||
            !['fresh', 'unknown'].includes(value.status) ||
            !Number.isFinite(Date.parse(value.observedAt)) ||
            (value.status === 'fresh' ? !count(value.dailyCounter) : value.dailyCounter !== null) ||
            !Array.isArray(value.partners) ||
            value.partners.length > 16
        )
            return null
        const partners = value.partners
            .filter(
                p =>
                    p &&
                    typeof p.partner === 'string' &&
                    /^[a-z0-9_-]{1,40}$/i.test(p.partner) &&
                    ['completedDays', 'totalDays', 'activitiesCompleted', 'activitiesTotal'].every(k => count(p[k])) &&
                    typeof p.isEnabled === 'boolean' &&
                    typeof p.isCurrentDayCompleted === 'boolean'
            )
            .map(
                ({
                    partner,
                    completedDays,
                    totalDays,
                    activitiesCompleted,
                    activitiesTotal,
                    isEnabled,
                    isCurrentDayCompleted
                }) => ({
                    partner,
                    completedDays,
                    totalDays,
                    activitiesCompleted,
                    activitiesTotal,
                    isEnabled,
                    isCurrentDayCompleted
                })
            )
        return {
            version: 1,
            email: value.email,
            dailyCounter: value.dailyCounter,
            status: value.status,
            source: value.source,
            observedAt: new Date(value.observedAt).toISOString(),
            partners
        }
    } catch {
        return null
    }
}

module.exports = { parseRewardsStreak }
