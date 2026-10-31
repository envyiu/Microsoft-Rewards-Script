export const SMART_WORKERS = [
    'dailySet',
    'morePromotions',
    'claimBonusPoints',
    'punchCards',
    'appPromotions',
    'dailyCheckIn',
    'readToEarn',
    'activateSearchPerk',
    'visualSearch',
    'bonusSearches',
    'streakProtection'
]

export const DEFAULT_SMART_CONFIG = {
    enabled: false,
    maxParallel: 2,
    cooldownMinutes: { min: 45, max: 120 },
    searchTarget: { min: 5, max: 10 },
    searchNoise: 3,
    searchSafetyCap: 20,
    retry: { maxAttempts: 3, backoffMinutes: 15 },
    sessionTimeoutMinutes: 45,
    catchUpThresholdMinutes: 120,
    networkGroupOverride: {},
    profiles: []
}

export const DEFAULT_ALLOWED_WORKERS = SMART_WORKERS.filter(worker => worker !== 'bonusSearches')

export function defaultTimezone() {
    const candidate = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    try {
        new Intl.DateTimeFormat('en', { timeZone: candidate }).format()
        return candidate
    } catch {
        return 'UTC'
    }
}

function fail(message) {
    const error = new Error(message)
    error.code = 'BAD_REQUEST'
    throw error
}

function integer(value, name, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max)
        fail(`${name} must be an integer from ${min} to ${max}.`)
    return value
}

function time(value, name) {
    if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) fail(`${name} must use HH:MM.`)
    return value
}

function normalizeProfile(raw, knownIndexes) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Each smart profile must be an object.')
    const accountIndex = integer(Number(raw.accountIndex), 'profiles[].accountIndex', 1, Number.MAX_SAFE_INTEGER)
    if (!knownIndexes.has(accountIndex)) fail(`ACCOUNT_${accountIndex} is not configured.`)
    const windows = raw.windows ?? []
    const quietHours = raw.quietHours ?? []
    if (!Array.isArray(windows)) fail('profiles[].windows must be an array.')
    if (!Array.isArray(quietHours)) fail('profiles[].quietHours must be an array.')
    const allowedWorkers = raw.allowedWorkers ?? DEFAULT_ALLOWED_WORKERS
    if (!Array.isArray(allowedWorkers) || allowedWorkers.some(worker => !SMART_WORKERS.includes(worker))) {
        fail('profiles[].allowedWorkers contains an unknown worker.')
    }
    try {
        new Intl.DateTimeFormat('en', { timeZone: raw.timezone ?? 'UTC' }).format()
    } catch {
        fail('profiles[].timezone must be a valid IANA timezone.')
    }
    return {
        accountIndex,
        timezone: typeof raw.timezone === 'string' && raw.timezone ? raw.timezone : defaultTimezone(),
        windows: windows.map((window, index) => ({
            start: time(window?.start, `profiles[].windows[${index}].start`),
            end: time(window?.end, `profiles[].windows[${index}].end`)
        })),
        quietHours: quietHours.map((window, index) => ({
            start: time(window?.start, `profiles[].quietHours[${index}].start`),
            end: time(window?.end, `profiles[].quietHours[${index}].end`)
        })),
        deadline: time(raw.deadline ?? '23:00', 'profiles[].deadline'),
        allowedWorkers: [...new Set(allowedWorkers)]
    }
}

export function validateSmartConfig(raw, accounts = []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Smart schedule must be a JSON object.')
    if (raw.profiles != null && !Array.isArray(raw.profiles)) fail('profiles must be an array.')
    const merged = structuredClone(DEFAULT_SMART_CONFIG)
    Object.assign(merged, raw)
    merged.cooldownMinutes = { ...DEFAULT_SMART_CONFIG.cooldownMinutes, ...(raw.cooldownMinutes || {}) }
    merged.searchTarget = { ...DEFAULT_SMART_CONFIG.searchTarget, ...(raw.searchTarget || {}) }
    merged.retry = { ...DEFAULT_SMART_CONFIG.retry, ...(raw.retry || {}) }
    if (typeof merged.enabled !== 'boolean') fail('enabled must be a boolean.')
    integer(merged.maxParallel, 'maxParallel', 1, 32)
    integer(merged.cooldownMinutes.min, 'cooldownMinutes.min', 1, 1440)
    integer(merged.cooldownMinutes.max, 'cooldownMinutes.max', merged.cooldownMinutes.min, 1440)
    integer(merged.searchTarget.min, 'searchTarget.min', 1, 100)
    integer(merged.searchTarget.max, 'searchTarget.max', merged.searchTarget.min, 100)
    integer(merged.searchNoise, 'searchNoise', 0, 20)
    integer(merged.searchSafetyCap, 'searchSafetyCap', 1, 100)
    integer(merged.retry.maxAttempts, 'retry.maxAttempts', 0, 10)
    integer(merged.retry.backoffMinutes, 'retry.backoffMinutes', 1, 1440)
    integer(merged.sessionTimeoutMinutes, 'sessionTimeoutMinutes', 5, 360)
    integer(merged.catchUpThresholdMinutes, 'catchUpThresholdMinutes', 1, 1440)
    if (
        !merged.networkGroupOverride ||
        typeof merged.networkGroupOverride !== 'object' ||
        Array.isArray(merged.networkGroupOverride)
    ) {
        fail('networkGroupOverride must be an object keyed by account index.')
    }
    const knownIndexes = new Set(accounts.map(account => account.index))
    const profiles = raw.profiles?.length
        ? raw.profiles.map(profile => normalizeProfile(profile, knownIndexes))
        : accounts.map(account => normalizeProfile({ accountIndex: account.index }, knownIndexes))
    if (new Set(profiles.map(profile => profile.accountIndex)).size !== profiles.length)
        fail('profiles accountIndex values must be unique.')
    merged.profiles = profiles
    return merged
}

export function deriveNetworkGroup(account, overrides = {}) {
    const override = overrides[String(account.index)]
    if (typeof override === 'string' && override.trim()) return override.trim()
    if (!account.proxy) return 'DIRECT'
    let host = account.proxy.url
    try {
        host = new URL(account.proxy.url).hostname
    } catch {}
    return `PROXY:${String(host).toLowerCase()}:${account.proxy.port ?? ''}`
}
