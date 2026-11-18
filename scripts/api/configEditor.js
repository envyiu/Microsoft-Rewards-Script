import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { BOT_CONFIG_METADATA } from '../../packages/contracts/configMetadata.js'

function resolveConfigPath(projectRoot) {
    if (process.env.MRS_CONFIG_FILE) return path.resolve(process.env.MRS_CONFIG_FILE)
    const candidates = [
        path.join(projectRoot, 'config.json'),
        path.join(projectRoot, 'dist', 'config.json'),
        path.join(projectRoot, 'src', 'config.json'),
        path.resolve(process.cwd(), 'config.json')
    ]
    return candidates.find(p => fs.existsSync(p)) ?? path.join(projectRoot, 'config.json')
}

async function loadConfigSync(projectRoot, override) {
    const modPath = override || path.join(projectRoot, 'dist', 'util', 'ConfigSync.js')
    if (!override && !fs.existsSync(modPath)) return null
    try {
        return await import(pathToFileURL(path.resolve(modPath)).href)
    } catch (error) {
        throw new Error(
            `Could not load ConfigSync module at ${modPath}: ${error instanceof Error ? error.message : String(error)}`
        )
    }
}

async function loadBotValidator(projectRoot, override) {
    const candidates = override
        ? [override]
        : [
              path.join(projectRoot, 'dist', 'util', 'Validator.js'),
              path.join(projectRoot, 'packages', 'contracts', 'dist', 'contracts', 'BotConfig.js')
          ]
    const modPath = override || candidates.find(candidate => fs.existsSync(candidate))
    if (!modPath) return null
    try {
        const mod = await import(pathToFileURL(path.resolve(modPath)).href)
        const m = mod.default && !mod.validateConfig && !mod.ConfigSchema ? mod.default : mod
        if (m.ConfigSchema && typeof m.ConfigSchema.parse === 'function') {
            return { via: 'bot-ConfigSchema', run: cfg => m.ConfigSchema.parse(cfg) }
        }
        if (typeof m.validateConfig === 'function') {
            return { via: 'bot-validateConfig', run: cfg => m.validateConfig(cfg) }
        }
        throw new Error('module has no validateConfig function or ConfigSchema')
    } catch (error) {
        throw new Error(
            `Could not load bot config validator at ${modPath}: ${error instanceof Error ? error.message : String(error)}`
        )
    }
}

function normalizeAliases(cfg) {
    if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) return cfg
    const out = { ...cfg }
    for (const [alias, canonical] of Object.entries(BOT_CONFIG_METADATA.backwardCompatibleAliases || {})) {
        if (alias in out) {
            if (!(canonical in out)) out[canonical] = out[alias]
            delete out[alias]
        }
    }
    return out
}

export async function validateConfig(cfg, { projectRoot, validatorModule } = {}) {
    const normalized = normalizeAliases(cfg)
    let validator
    try {
        validator = await loadBotValidator(projectRoot, validatorModule)
    } catch (error) {
        return {
            ok: false,
            errors: [error instanceof Error ? error.message : String(error)],
            via: 'bot-validator-load'
        }
    }
    if (!validator) {
        return {
            ok: false,
            errors: ['Bot config schema module not found — run `npm run build` first.'],
            via: 'missing-schema'
        }
    }
    try {
        const value = validator.run(normalized)
        return { ok: true, value: value ?? normalized, via: validator.via }
    } catch (err) {
        const issues = err?.issues
        const errors = Array.isArray(issues)
            ? issues.map(i => `${(i.path || []).join('.') || '(root)'}: ${i.message}`)
            : [err instanceof Error ? err.message : String(err)]
        return { ok: false, errors, via: validator.via }
    }
}

export function deepMerge(base, patch) {
    if (Array.isArray(patch)) return patch // arrays replace wholesale
    if (typeof patch !== 'object' || patch === null) return patch
    const out = { ...(typeof base === 'object' && base !== null ? base : {}) }
    for (const [k, v] of Object.entries(patch)) {
        if (['__proto__', 'prototype', 'constructor'].includes(k)) {
            throw Object.assign(new Error(`Unsafe config key: ${k}`), { code: 'BAD_REQUEST' })
        }
        out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k], v) : v
    }
    return out
}

export async function diffConfig(projectRoot, { validatorModule } = {}) {
    const mod = await loadConfigSync(projectRoot, validatorModule)
    if (!mod) throw new Error('ConfigSync module not found - run `npm run build`.')
    const { data: config } = readConfig(projectRoot)
    const example = mod.readJson(mod.resolveExamplePath(projectRoot))
    return { addedKeys: mod.diffKeyPaths(config, example) }
}

export async function syncMissingDefaults(projectRoot, { validatorModule } = {}) {
    const mod = await loadConfigSync(projectRoot, validatorModule)
    if (!mod) throw new Error('ConfigSync module not found - run `npm run build`.')
    const { data: config } = readConfig(projectRoot)
    const example = mod.readJson(mod.resolveExamplePath(projectRoot))
    const { merged, addedKeys } = mod.mergeMissingDefaults(config, example)
    if (addedKeys.length > 0) {
        writeConfigAtomic(projectRoot, merged)
    }
    return { addedKeys, patched: addedKeys.length > 0 }
}

export function readConfig(projectRoot) {
    const p = resolveConfigPath(projectRoot)
    return { path: p, data: JSON.parse(fs.readFileSync(p, 'utf8')) }
}

export function writeConfigAtomic(projectRoot, cfg) {
    const target = resolveConfigPath(projectRoot)
    if (fs.existsSync(target)) {
        try {
            fs.copyFileSync(target, `${target}.bak`)
        } catch {
            // best-effort backup
        }
    }
    const tmp = `${target}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2))
    fs.renameSync(tmp, target)
    return target
}
