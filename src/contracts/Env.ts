export type EnvSource = Record<string, string | undefined>

export function envStrFrom(sourceEnv: EnvSource, key: string): string | undefined {
    const value = sourceEnv[key]
    if (value === undefined) return undefined
    const trimmed = String(value).trim()
    return trimmed.length ? trimmed : undefined
}

export function envStr(key: string, sourceEnv: EnvSource = process.env): string | undefined {
    return envStrFrom(sourceEnv, key)
}

export function envBool(key: string, fallback: boolean, sourceEnv: EnvSource = process.env): boolean {
    const value = envStr(key, sourceEnv)
    if (value === undefined) return fallback
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

export function envInt(key: string, fallback: number, sourceEnv: EnvSource = process.env): number {
    const value = envStr(key, sourceEnv)
    if (value === undefined) return fallback
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : fallback
}

export function accountIndexesFromEnv(sourceEnv: EnvSource = process.env): number[] {
    return Object.keys(sourceEnv)
        .map(key => /^ACCOUNT_([1-9]\d*)_EMAIL$/.exec(key)?.[1])
        .filter((index): index is string => Boolean(index && envStrFrom(sourceEnv, `ACCOUNT_${index}_EMAIL`)))
        .map(Number)
        .sort((a, b) => a - b)
}

export function parseEnvValue(raw: string): string {
    const value = String(raw ?? '').trim()
    if (value.startsWith('"') && value.endsWith('"')) {
        try {
            const parsed = JSON.parse(value)
            if (typeof parsed === 'string') return parsed
        } catch {}
    }
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
    return value
}

export function parseDotEnv(raw: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const line of String(raw ?? '').split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        const key = trimmed.slice(0, eq).trim()
        if (!key) continue
        out[key] = parseEnvValue(trimmed.slice(eq + 1))
    }
    return out
}
