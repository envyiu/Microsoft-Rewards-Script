import fs from 'fs'
import path from 'path'

import { accountIndexesFromEnv, envBool, envInt, envStr, parseDotEnv } from '../contracts/Env'
import type { Account, AccountProxy, ConfigSaveFingerprint } from '../interface/Account'
import type { Config } from '../interface/Config'
import { validateAccounts, validateConfig } from './Validator'

let configCache: Config | undefined
let envLoaded = false

export function resetLoadCache(): void {
    configCache = undefined
    envLoaded = false
}

function getProjectRoot(): string {
    const cwd = process.cwd()
    if (fs.existsSync(path.join(cwd, 'package.json'))) return cwd

    let dir = __dirname
    while (dir !== path.parse(dir).root) {
        if (fs.existsSync(path.join(dir, 'package.json'))) return dir
        dir = path.dirname(dir)
    }

    return cwd
}

// Check root -> dist -> src (not in dist, but root)
function resolveProjectFile(filename: string): string | undefined {
    const root = getProjectRoot()
    const candidates = [
        path.join(process.cwd(), filename),
        path.join(root, filename),
        path.join(root, 'dist', filename),
        path.join(root, 'src', filename)
    ]
    return candidates.find(p => fs.existsSync(p))
}

function ensureEnvLoaded(): void {
    if (envLoaded) return
    envLoaded = true
    if (process.env.MRS_SKIP_ENV_FILE === '1') return

    // Check root -> dist -> src (not in dist, but root)
    const envFile = resolveProjectFile('.env')
    if (!envFile) return

    const raw = fs.readFileSync(envFile, 'utf-8')
    for (const [key, value] of Object.entries(parseDotEnv(raw))) {
        if (process.env[key] === undefined) {
            process.env[key] = value
        }
    }
}

const deprecationWarned = new Set<string>()
function envBoolWithLegacy(primary: string, legacy: string, fallback: boolean): boolean {
    if (envStr(primary) !== undefined) return envBool(primary, fallback)
    if (envStr(legacy) !== undefined) {
        if (!deprecationWarned.has(legacy)) {
            deprecationWarned.add(legacy)
            console.warn(`[Accounts] ${legacy} is deprecated; rename it to ${primary}.`)
        }
        return envBool(legacy, fallback)
    }
    return fallback
}

function buildProxy(index: string): AccountProxy {
    return {
        proxyHttp: envBoolWithLegacy(`ACCOUNT_${index}_PROXY_HTTP`, `ACCOUNT_${index}_PROXY_AXIOS`, false),
        url: envStr(`ACCOUNT_${index}_PROXY_URL`) ?? '',
        port: envInt(`ACCOUNT_${index}_PROXY_PORT`, 0),
        username: envStr(`ACCOUNT_${index}_PROXY_USERNAME`) ?? '',
        password: envStr(`ACCOUNT_${index}_PROXY_PASSWORD`) ?? ''
    }
}

function buildSaveFingerprint(index: string): ConfigSaveFingerprint {
    return {
        mobile: envBool(`ACCOUNT_${index}_SAVE_FINGERPRINT_MOBILE`, false),
        desktop: envBool(`ACCOUNT_${index}_SAVE_FINGERPRINT_DESKTOP`, false)
    }
}

function getAccountIndexes(): string[] {
    return accountIndexesFromEnv(process.env).map(String)
}

export function loadAccounts(): Account[] {
    try {
        ensureEnvLoaded()

        const accounts: Account[] = []

        for (const index of getAccountIndexes()) {
            const email = envStr(`ACCOUNT_${index}_EMAIL`)
            if (!email) continue

            const password = envStr(`ACCOUNT_${index}_PASSWORD`) ?? ''

            accounts.push({
                email,
                password,
                totpSecret: envStr(`ACCOUNT_${index}_TOTP_SECRET`),
                recoveryEmail: envStr(`ACCOUNT_${index}_RECOVERY_EMAIL`) ?? '',
                newAccountMode: envStr(`ACCOUNT_${index}_NEW_ACCOUNT_MODE`) === 'true',
                newAccountPolicy: (envStr(`ACCOUNT_${index}_NEW_ACCOUNT_POLICY`) || 'standard168h') as
                    'standard168h' | 'search72h',
                geoLocale: envStr(`ACCOUNT_${index}_GEO_LOCALE`) ?? 'auto',
                langCode: envStr(`ACCOUNT_${index}_LANG_CODE`) ?? 'en',
                proxy: buildProxy(index),
                saveFingerprint: buildSaveFingerprint(index)
            })
        }

        if (!accounts.length) {
            throw new Error(
                'No accounts found in environment. Configure at least one ACCOUNT_1_EMAIL in .env or via the Rewards Dashboard Accounts view.'
            )
        }

        return validateAccounts(accounts)
    } catch (error) {
        if (error instanceof Error) throw error
        throw new Error(String(error))
    }
}

export function loadConfig(): Config {
    try {
        if (configCache) {
            return configCache
        }

        // Check root -> dist -> src (not in dist, but root)
        const configPath = process.env.MRS_CONFIG_FILE || resolveProjectFile('config.json')
        if (!configPath) {
            throw new Error(
                'config.json not found - place it in the project root (dist/ and src/ are also searched as fallbacks)'
            )
        }
        const config = fs.readFileSync(configPath, 'utf-8')

        const unverifiedConfig = JSON.parse(config)
        const configData = validateConfig(unverifiedConfig)

        configCache = configData

        return configData
    } catch (error) {
        if (error instanceof Error) throw error
        throw new Error(String(error))
    }
}
