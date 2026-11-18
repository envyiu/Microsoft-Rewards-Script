// Account protection is business state, independent of task retries and learning.
export function protectionFor(state) {
    return (state.protection ??= { version: 1, sessions: [], consecutiveFailures: 0, hold: null })
}
export function sessionEligibility(state, policy, now = Date.now()) {
    const guard = protectionFor(state)
    const sessions = guard.sessions
        .filter(s => !s.refunded && Date.parse(s.startedAt) > now - policy.windowHours * 3600000)
        .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    const limits = {
        sessionLimit: policy.maxSessions,
        windowHours: policy.windowHours,
        restMinutes: policy.restMinutes,
        maxQueries: policy.maxQueries
    }
    const blockers = []
    if (sessions.length >= policy.maxSessions) {
        const until =
            Date.parse(sessions[sessions.length - policy.maxSessions].startedAt) + policy.windowHours * 3600000
        blockers.push({
            code: 'SESSION_LIMIT',
            scope: 'account',
            source: 'rolling-limit',
            retryAt: new Date(until).toISOString()
        })
    }
    const unfinished = guard.sessions.some(s => !s.refunded && !s.endedAt)
    if (unfinished) blockers.push({ code: 'SESSION_UNCERTAIN', scope: 'account', source: 'process', retryAt: null })
    const restUntil = Math.max(
        0,
        ...guard.sessions
            .filter(s => !s.refunded && s.endedAt)
            .map(s => Date.parse(s.endedAt) + policy.restMinutes * 60000)
    )
    if (restUntil > now)
        blockers.push({
            code: 'SESSION_REST',
            scope: 'account',
            source: 'rest',
            retryAt: new Date(restUntil).toISOString()
        })
    if (guard.hold && (!guard.hold.until || Date.parse(guard.hold.until) > now))
        blockers.push({
            code: guard.hold.until ? 'ACCOUNT_HOLD' : guard.hold.reason,
            scope: 'account',
            source: 'protection',
            retryAt: guard.hold.until || null
        })
    const indefinite = blockers.find(b => b.code === 'SESSION_UNCERTAIN') || blockers.find(b => b.retryAt === null)
    const latest = blockers
        .filter(b => b.retryAt !== null)
        .sort((a, b) => Date.parse(b.retryAt) - Date.parse(a.retryAt))[0]
    const primary = indefinite || latest
    return {
        ...limits,
        sessionsUsed: sessions.length,
        nextEligibleAt: indefinite
            ? null
            : new Date(latest ? Math.max(now, Date.parse(latest.retryAt)) : now).toISOString(),
        blockedReason: primary?.code || null,
        blockers,
        recovery: indefinite
            ? indefinite.code === 'SESSION_UNCERTAIN'
                ? 'process-check-required'
                : 'user-action-required'
            : guard.hold
              ? Date.parse(guard.hold.until || '') > now
                  ? 'waiting'
                  : 'recovery-session'
              : 'normal'
    }
}
export function recordSessionOutcome(state, sessionId, failure, now = Date.now()) {
    const guard = protectionFor(state),
        session = guard.sessions.find(s => s.id === sessionId)
    if (!session || session.endedAt) return
    session.endedAt = new Date(now).toISOString()
    session.failure = failure === 'interrupted' ? null : failure || null
    if (session.refunded) return
    if (failure === 'interrupted') {
        return
    }
    if (['verification', 'locked'].includes(failure)) {
        guard.hold = { reason: failure === 'locked' ? 'ACCOUNT_LOCKED' : 'VERIFICATION_REQUIRED', until: null }
    } else if (['authentication', 'data'].includes(failure)) {
        guard.consecutiveFailures = guard.lastFailure === failure ? guard.consecutiveFailures + 1 : 1
        guard.lastFailure = failure
        if (guard.consecutiveFailures >= 2 || guard.hold)
            guard.hold = { reason: failure, until: new Date(now + 24 * 3600000).toISOString() }
    } else if (!failure) {
        guard.consecutiveFailures = 0
        guard.lastFailure = null
        if (guard.hold?.until) guard.hold = null
    } else {
        guard.consecutiveFailures = 0
        guard.lastFailure = failure
        // A network failure during recovery does not extend an unrelated hold.
    }
}
export function selectAccountTasks(pending, dailySetCompleted, maxTasks = 4) {
    const available = pending.filter(
        w => w !== 'bonusSearches' && (w !== 'activateSearchPerk' || dailySetCompleted || pending.includes('dailySet'))
    )
    // A batch uses either mobile/app or desktop activities; never both logins.
    const mobile = ['readToEarn', 'dailyCheckIn', 'appPromotions']
    const order = available.includes('dailySet')
        ? [
              'dailySet',
              'activateSearchPerk',
              'morePromotions',
              'streakProtection',
              'punchCards',
              'claimBonusPoints',
              'visualSearch'
          ]
        : available.includes('readToEarn') || available.some(w => mobile.includes(w))
          ? mobile
          : [
                'activateSearchPerk',
                'morePromotions',
                'streakProtection',
                'punchCards',
                'claimBonusPoints',
                'visualSearch'
            ]
    const workers = order.filter(w => available.includes(w)).slice(0, maxTasks)
    return { workers, environment: workers.some(w => mobile.includes(w)) ? 'mobile' : 'desktop' }
}
