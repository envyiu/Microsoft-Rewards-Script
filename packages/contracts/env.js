import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const compiled = require('./dist/contracts/Env.js')

export const { envStrFrom, envStr, envBool, envInt, accountIndexesFromEnv, parseEnvValue, parseDotEnv } = compiled

export function normalizeLanguageCode(value = 'en') {
    const trimmed = String(value).trim()
    try {
        return new Intl.Locale(trimmed).toString()
    } catch {
        return trimmed
    }
}

export function normalizeGeoLocale(value = 'auto') {
    const trimmed = String(value).trim()
    return trimmed.toLowerCase() === 'auto' ? 'auto' : trimmed.toUpperCase()
}
