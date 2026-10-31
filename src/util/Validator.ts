import { z } from 'zod'
import semver from 'semver'
import pkg from '../../package.json'
import type { Config } from '../interface/Config'
import type { Account } from '../interface/Account'
import { ConfigSchema, AccountSchema, defaultConfig } from '../contracts/BotConfig'
export { ConfigSchema, AccountSchema } from '../contracts/BotConfig'

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function getByPath(obj: unknown, path: ReadonlyArray<string | number>): unknown {
    return path.reduce<unknown>((acc, key) => {
        if (acc == null) return undefined
        return (acc as Record<string | number, unknown>)[key]
    }, obj)
}

function setByPath<T>(obj: T, path: ReadonlyArray<string | number>, value: unknown): T {
    if (path.length === 0) return value as T
    const head = path[0]
    if (head === undefined) return value as T
    const rest = path.slice(1)
    const base = obj ?? (typeof head === 'number' ? [] : {})
    const cloned = (Array.isArray(base) ? [...base] : { ...(base as object) }) as Record<string | number, unknown>
    cloned[head] = setByPath((base as Record<string | number, unknown>)[head], rest, value)
    return cloned as T
}

function fillMissing(data: unknown, defaults: unknown, path = ''): unknown {
    if (!isPlainObject(defaults)) return data
    if (!isPlainObject(data)) {
        if (data === undefined) {
            console.warn(`[Config] WARN: "${path || '<root>'}" missing, using default`)
            return defaults
        }
        return data
    }
    const result: Record<string, unknown> = { ...data }
    for (const key of Object.keys(defaults)) {
        const p = path ? `${path}.${key}` : key
        if (!(key in result)) {
            console.warn(`[Config] WARN: "${p}" not found, using default: ${JSON.stringify(defaults[key])}`)
            result[key] = defaults[key]
        } else if (isPlainObject(defaults[key])) {
            result[key] = fillMissing(result[key], defaults[key], p)
        }
    }
    return result
}

export function validateConfig(data: unknown): Config {
    const filled = fillMissing(data, defaultConfig)
    let result = ConfigSchema.safeParse(filled)
    if (result.success) return result.data as Config

    let patched: unknown = filled
    for (const issue of result.error.issues) {
        const def = getByPath(defaultConfig, issue.path as (string | number)[])
        console.warn(
            `[Config] WARN: "${issue.path.join('.') || '<root>'}" invalid (${issue.message}), using default: ${JSON.stringify(def)}`
        )
        patched = setByPath(patched, issue.path as (string | number)[], def)
    }
    result = ConfigSchema.safeParse(patched)
    if (!result.success) {
        console.error('[Config] still invalid after applying defaults:', result.error.issues)
        throw new Error('Config validation failed')
    }
    return result.data as Config
}

export function validateAccounts(data: unknown): Account[] {
    const result = z.array(AccountSchema).safeParse(data)
    if (result.success) return result.data

    for (const issue of result.error.issues) {
        const path = issue.path.join('.') || '<root>'
        if (issue.code === 'invalid_type') {
            if (issue.input === undefined) {
                console.error(`[Accounts] "${path}" is missing (expected ${issue.expected})`)
            } else {
                console.error(
                    `[Accounts] "${path}" has wrong type: expected ${issue.expected}, got ${typeof issue.input}`
                )
            }
        } else if (issue.code === 'invalid_union') {
            console.error(`[Accounts] "${path}" does not match any allowed type: ${issue.message}`)
        } else {
            console.error(`[Accounts] "${path}" ${issue.message} (code: ${issue.code})`)
        }
    }
    throw new Error(`Accounts validation failed: ${result.error.issues.length} issue(s) - see logs above`)
}

export function checkNodeVersion(): void {
    try {
        const requiredVersion = pkg.engines?.node

        if (!requiredVersion) {
            console.warn('[Validator] WARN: No Node.js version requirement found in package.json "engines" field.')
            return
        }

        if (!semver.satisfies(process.version, requiredVersion)) {
            console.error(`Current Node.js version ${process.version} does not satisfy requirement: ${requiredVersion}`)
            process.exit(1)
        }
    } catch (error) {
        console.error('Failed to validate Node.js version:', error)
        process.exit(1)
    }
}
