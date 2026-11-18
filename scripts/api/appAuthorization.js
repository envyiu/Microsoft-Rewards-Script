export const APP_AUTH_WORKERS = ['readToEarn', 'dailyCheckIn', 'appPromotions']
const REASONS = new Set(['email-code-required', 'password-required', 'account-review', 'access-denied'])

export function captureAppAuthorization(entry) {
    if (entry.title !== 'LOGIN-APP') return null
    if (entry.message === 'Mobile access token received') return { required: false }
    const reason = /^App authorization needs user action \| reason=([a-z-]+)$/.exec(entry.message)?.[1]
    return REASONS.has(reason) ? { required: true, reason } : null
}

export function applyAppAuthorization(state, record, now = new Date().toISOString()) {
    if (!state || state.day !== record.job.day || record.handoff || !record.appAuthorization) return
    const outcome = record.appAuthorization
    state.appAuthorization = {
        ...outcome,
        at: now,
        ...(state.appAuthorization?.retryPolicy ? { retryPolicy: state.appAuthorization.retryPolicy } : {})
    }
    if (outcome.required) {
        // These three tasks share a credential. Retrying each cannot supply an OTP.
        // Browser tasks and search retain their independent completion/retry state.
        state.workersFailed = [
            ...new Set([
                ...(state.workersFailed || []),
                ...APP_AUTH_WORKERS.filter(w => !state.workersCompleted?.includes(w))
            ])
        ]
    }
}

// Reconsider only the app tasks blocked by the old interactive OAuth path.
// The normal session ledger, rest timer and search budgets remain authoritative.
export function migrateAppAuthorizationSso(state) {
    if (!state.appAuthorization?.required) {
        state.appAuthorization ??= {}
        state.appAuthorization.retryPolicy ??= 'silent-sso-v1'
        return
    }
    if (!state.appAuthorization?.required || state.appAuthorization.retryPolicy === 'silent-sso-v1') return
    state.appAuthorization.retryPolicy = 'silent-sso-v1'
    state.workersFailed = (state.workersFailed || []).filter(w => !APP_AUTH_WORKERS.includes(w))
    for (const worker of APP_AUTH_WORKERS) {
        if (state.workerFailures) delete state.workerFailures[worker]
        if (state.workerRetryAt) delete state.workerRetryAt[worker]
    }
}
