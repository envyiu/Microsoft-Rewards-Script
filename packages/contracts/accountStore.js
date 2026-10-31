import fs from 'node:fs'
import path from 'node:path'

import { normalizeGeoLocale, normalizeLanguageCode } from './env.js'

const ACCOUNT_EMAIL_KEY = /^ACCOUNT_([1-9]\d*)_EMAIL$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks4:', 'socks5:'])
const MANAGED_FIELDS = new Set([
    'NEW_ACCOUNT_MODE',
    'EMAIL',
    'PASSWORD',
    'TOTP_SECRET',
    'RECOVERY_EMAIL',
    'GEO_LOCALE',
    'LANG_CODE',
    'PROXY_HTTP',
    'PROXY_AXIOS',
    'PROXY_URL',
    'PROXY_PORT',
    'PROXY_USERNAME',
    'PROXY_PASSWORD',
    'SAVE_FINGERPRINT_MOBILE',
    'SAVE_FINGERPRINT_DESKTOP'
])

function fail(message, code = 'BAD_REQUEST') {
    const error = new Error(message)
    error.code = code
    throw error
}

function valueFromEnv(sourceEnv, key) {
    const value = sourceEnv[key]
    if (value === undefined || value === null) return undefined
    const text = String(value).trim()
    return text.length ? text : undefined
}

function boolFromEnv(sourceEnv, key, fallback = false) {
    const value = valueFromEnv(sourceEnv, key)
    if (value === undefined) return fallback
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function parseEnvValue(raw) {
    const value = String(raw ?? '').trim()
    if (value.startsWith('"') && value.endsWith('"')) {
        try {
            return JSON.parse(value)
        } catch {}
    }
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
    return value
}

function serializeEnvValue(value) {
    const text = String(value)
    if (!text || (!text.startsWith('"') && !text.endsWith('"') && !text.startsWith("'") && !text.endsWith("'"))) {
        return text
    }
    return JSON.stringify(text)
}

function envFileCandidates(projectRoot) {
    return [path.resolve(process.cwd(), '.env'), path.join(projectRoot, '.env'), path.join(projectRoot, 'dist', '.env')]
}

export function findEnvFile(projectRoot) {
    return [path.join(projectRoot, '.env'), ...envFileCandidates(projectRoot).filter(file => file !== path.join(projectRoot, '.env'))].find(file => fs.existsSync(file)) ?? null
}

function parseAssignments(raw) {
    const assignments = new Map()
    for (const line of String(raw).split(/\r?\n/)) {
        const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line)
        if (!match) continue
        assignments.set(match[1], parseEnvValue(match[2]))
    }
    return assignments
}

function accountKeysInFile(raw) {
    const keys = new Set()
    for (const line of String(raw).split(/\r?\n/)) {
        const match = /^\s*(ACCOUNT_[1-9]\d*_[A-Z0-9_]+)\s*=/.exec(line)
        if (match) keys.add(match[1])
    }
    return keys
}

function fullAccounts(sourceEnv) {
    const indexes = Object.keys(sourceEnv)
        .map(key => ACCOUNT_EMAIL_KEY.exec(key)?.[1])
        .filter(index => index && valueFromEnv(sourceEnv, `ACCOUNT_${index}_EMAIL`))
        .map(Number)
        .sort((a, b) => a - b)

    return [...new Set(indexes)].map(index => {
        const prefix = `ACCOUNT_${index}_`
        return {
            index,
            email: valueFromEnv(sourceEnv, `${prefix}EMAIL`) ?? '',
            password: valueFromEnv(sourceEnv, `${prefix}PASSWORD`) ?? '',
            totpSecret: valueFromEnv(sourceEnv, `${prefix}TOTP_SECRET`) ?? '',
            recoveryEmail: valueFromEnv(sourceEnv, `${prefix}RECOVERY_EMAIL`) ?? '',
            newAccountMode: boolFromEnv(sourceEnv, `${prefix}NEW_ACCOUNT_MODE`),
            geoLocale: normalizeGeoLocale(valueFromEnv(sourceEnv, `${prefix}GEO_LOCALE`) ?? 'auto'),
            langCode: normalizeLanguageCode(valueFromEnv(sourceEnv, `${prefix}LANG_CODE`) ?? 'en'),
            proxy: {
                proxyHttp: boolFromEnv(sourceEnv, `${prefix}PROXY_HTTP`, boolFromEnv(sourceEnv, `${prefix}PROXY_AXIOS`)),
                url: valueFromEnv(sourceEnv, `${prefix}PROXY_URL`) ?? '',
                port: Number(valueFromEnv(sourceEnv, `${prefix}PROXY_PORT`) ?? 0),
                username: valueFromEnv(sourceEnv, `${prefix}PROXY_USERNAME`) ?? '',
                password: valueFromEnv(sourceEnv, `${prefix}PROXY_PASSWORD`) ?? ''
            },
            saveFingerprint: {
                mobile: boolFromEnv(sourceEnv, `${prefix}SAVE_FINGERPRINT_MOBILE`),
                desktop: boolFromEnv(sourceEnv, `${prefix}SAVE_FINGERPRINT_DESKTOP`)
            }
        }
    })
}

function safeAccount(account) {
    return {
        index: account.index,
        email: account.email,
        geoLocale: account.geoLocale,
        langCode: account.langCode,
        hasPassword: Boolean(account.password),
        hasRecoveryEmail: Boolean(account.recoveryEmail),
        newAccountMode: account.newAccountMode === true,
        hasTotp: Boolean(account.totpSecret),
        proxy: account.proxy.url
            ? {
                  proxyHttp: account.proxy.proxyHttp,
                  url: sanitizeProxyUrl(account.proxy.url),
                  port: account.proxy.port || null,
                  hasCredentials: Boolean(account.proxy.username && account.proxy.password)
              }
            : null,
        saveFingerprint: { ...account.saveFingerprint }
    }
}

function sanitizeProxyUrl(value) {
    try {
        const url = new URL(value)
        url.username = ''
        url.password = ''
        return url.toString().replace(/\/$/, '')
    } catch {
        return String(value).replace(/^(?:[^/@\s]+@|([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@)/i, '$1')
    }
}

function assertText(value, field, { optional = true } = {}) {
    if (value == null && optional) return ''
    if (typeof value !== 'string') fail(`${field} must be a string.`)
    if ([...value].some(character => {
        const code = character.charCodeAt(0)
        return code < 32 || code === 127
    })) fail(`${field} contains unsupported control characters.`)
    return value.trim()
}

function normalizeProxy(raw) {
    if (raw == null) return { proxyHttp: false, url: '', port: 0, username: '', password: '' }
    if (typeof raw !== 'object' || Array.isArray(raw)) fail('proxy must be an object or null.')
    const urlText = assertText(raw.url, 'proxy.url')
    const username = assertText(raw.username, 'proxy.username')
    const password = assertText(raw.password, 'proxy.password')
    const proxyHttp = raw.proxyHttp ?? false
    if (typeof proxyHttp !== 'boolean') fail('proxy.proxyHttp must be a boolean.')
    if (!urlText) {
        if (username || password || raw.port) fail('proxy.url is required when proxy settings are configured.')
        return { proxyHttp: false, url: '', port: 0, username: '', password: '' }
    }
    let url
    try {
        url = new URL(urlText.includes('://') ? urlText : `http://${urlText}`)
    } catch {
        fail('proxy.url is invalid.')
    }
    if (!PROXY_PROTOCOLS.has(url.protocol)) fail('proxy.url must use http, https, socks4 or socks5.')
    if (url.username || url.password) fail('Put proxy credentials in the username/password fields.')
    const port = Number(raw.port)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail('proxy.port must be an integer from 1 to 65535.')
    if (Boolean(username) !== Boolean(password)) fail('Proxy username and password must be configured together.')
    if (url.protocol === 'socks4:' && (username || password)) {
        fail('SOCKS4 proxy authentication is not supported.')
    }
    return { proxyHttp, url: urlText, port, username, password }
}

function normalizeAccount(raw, existing = null) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Each account must be an object.')
    const emailValue = raw.email === undefined && existing ? existing.email : assertText(raw.email, 'email', { optional: false })
    const email = String(emailValue).trim()
    if (!EMAIL_PATTERN.test(email)) fail('email must be a valid email address.')
    const password = raw.password === undefined && existing ? existing.password : assertText(raw.password, 'password')
    const totpSecret = raw.totpSecret === undefined && existing ? existing.totpSecret : assertText(raw.totpSecret, 'totpSecret')
    const recoveryEmail = raw.recoveryEmail === undefined && existing ? existing.recoveryEmail : assertText(raw.recoveryEmail, 'recoveryEmail')
    const newAccountMode = raw.newAccountMode === undefined
        ? (existing ? existing.newAccountMode === true : /@(outlook|hotmail)\.com$/i.test(email))
        : raw.newAccountMode
    if (typeof newAccountMode !== 'boolean') fail('newAccountMode must be a boolean.')
    const geoLocale = raw.geoLocale === undefined && existing ? existing.geoLocale : assertText(raw.geoLocale ?? 'auto', 'geoLocale')
    const langCode = raw.langCode === undefined && existing ? existing.langCode : assertText(raw.langCode ?? 'en', 'langCode')
    try {
        if (geoLocale.toLowerCase() !== 'auto' && !/^[A-Za-z]{2}$/.test(geoLocale)) throw new Error('invalid country')
        new Intl.Locale(langCode)
    } catch {
        fail('geoLocale or langCode is invalid.')
    }
    const proxy = raw.proxy === undefined && existing ? existing.proxy : normalizeProxy(raw.proxy)
    const saveFingerprint = raw.saveFingerprint === undefined && existing ? existing.saveFingerprint : raw.saveFingerprint ?? { mobile: false, desktop: false }
    if (!saveFingerprint || typeof saveFingerprint !== 'object' || typeof saveFingerprint.mobile !== 'boolean' || typeof saveFingerprint.desktop !== 'boolean') {
        fail('saveFingerprint.mobile and saveFingerprint.desktop must be booleans.')
    }
    return {
        email,
        password,
        totpSecret,
        recoveryEmail,
        newAccountMode,
        geoLocale: normalizeGeoLocale(geoLocale),
        langCode: normalizeLanguageCode(langCode),
        proxy,
        saveFingerprint: { mobile: saveFingerprint.mobile, desktop: saveFingerprint.desktop }
    }
}

function validateBatch(rawAccounts, existingAccounts) {
    if (!Array.isArray(rawAccounts) || rawAccounts.length < 1 || rawAccounts.length > 100) fail('accounts must contain between 1 and 100 items.')
    const existingEmails = new Set(existingAccounts.map(account => account.email.toLowerCase()))
    const seen = new Set()
    const normalized = rawAccounts.map(raw => normalizeAccount(raw))
    for (const account of normalized) {
        const key = account.email.toLowerCase()
        if (seen.has(key) || existingEmails.has(key)) fail(`Account email already exists: ${account.email}.`, 'DUPLICATE_ACCOUNT')
        seen.add(key)
    }
    return normalized
}

function nextFreeIndex(used) {
    let index = 1
    while (used.has(index)) index += 1
    return index
}

function accountValues(index, account) {
    const prefix = `ACCOUNT_${index}_`
    const values = {
        [`${prefix}EMAIL`]: account.email,
        [`${prefix}NEW_ACCOUNT_MODE`]: String(account.newAccountMode === true),
        [`${prefix}GEO_LOCALE`]: account.geoLocale,
        [`${prefix}LANG_CODE`]: account.langCode,
        [`${prefix}PROXY_HTTP`]: String(account.proxy.proxyHttp),
        [`${prefix}SAVE_FINGERPRINT_MOBILE`]: String(account.saveFingerprint.mobile),
        [`${prefix}SAVE_FINGERPRINT_DESKTOP`]: String(account.saveFingerprint.desktop)
    }
    if (account.password) values[`${prefix}PASSWORD`] = account.password
    if (account.totpSecret) values[`${prefix}TOTP_SECRET`] = account.totpSecret
    if (account.recoveryEmail) values[`${prefix}RECOVERY_EMAIL`] = account.recoveryEmail
    if (account.proxy.url) {
        values[`${prefix}PROXY_URL`] = account.proxy.url
        values[`${prefix}PROXY_PORT`] = String(account.proxy.port)
        if (account.proxy.username) values[`${prefix}PROXY_USERNAME`] = account.proxy.username
        if (account.proxy.password) values[`${prefix}PROXY_PASSWORD`] = account.proxy.password
    }
    return values
}

function rewriteAccountBlock(raw, index, values) {
    const lines = String(raw).split(/\r?\n/)
    const prefix = `ACCOUNT_${index}_`
    const written = new Set()
    const out = []
    for (const line of lines) {
        const match = /^\s*(ACCOUNT_[1-9]\d*_[A-Z0-9_]+)\s*=/.exec(line)
        if (!match || !match[1].startsWith(prefix)) {
            out.push(line)
            continue
        }
        const key = match[1]
        const suffix = key.slice(prefix.length)
        if (values[key] === undefined && MANAGED_FIELDS.has(suffix)) continue
        if (values[key] === undefined) {
            out.push(line)
            continue
        }
        if (written.has(key)) continue
        out.push(`${key}=${serializeEnvValue(values[key])}`)
        written.add(key)
    }
    const missing = Object.entries(values).filter(([key]) => !written.has(key))
    if (missing.length) {
        while (out.length && out[out.length - 1] === '') out.pop()
        if (out.length && out[out.length - 1] !== '') out.push('')
        out.push(`# Managed account ACCOUNT_${index}`)
        for (const [key, value] of missing) out.push(`${key}=${serializeEnvValue(value)}`)
    }
    return `${out.join('\n').replace(/\n+$/, '')}\n`
}

function removeAccountBlock(raw, index) {
    const prefix = `ACCOUNT_${index}_`
    const managedComment = `# Managed account ACCOUNT_${index}`
    const lines = String(raw).split(/\r?\n/)
    const kept = lines.filter(line => {
        if (line.trim() === managedComment) return false
        const match = /^\s*(ACCOUNT_[1-9]\d*_[A-Z0-9_]+)\s*=/.exec(line)
        return !match || !match[1].startsWith(prefix)
    })
    return `${kept.join('\n').replace(/\n+$/, '')}\n`
}

function atomicWrite(filename, content) {
    const temp = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`)
    try {
        fs.writeFileSync(temp, content, { mode: 0o600, flag: 'wx' })
        fs.chmodSync(temp, 0o600)
        fs.renameSync(temp, filename)
    } finally {
        try {
            fs.unlinkSync(temp)
        } catch {}
    }
}

function readWritableDocument(projectRoot, sourceEnv) {
    const filename = findEnvFile(projectRoot)
    if (!filename) fail('No .env file is available for account writes.', 'ACCOUNT_WRITE_UNAVAILABLE')
    const raw = fs.readFileSync(filename, 'utf8')
    const fileKeys = accountKeysInFile(raw)
    for (const key of Object.keys(sourceEnv)) {
        if (!key.startsWith('ACCOUNT_') || !/^ACCOUNT_[1-9]\d*_/.test(key)) continue
        if (!fileKeys.has(key) && valueFromEnv(sourceEnv, key)) {
            fail('Account environment is externally managed; edit the mounted .env file instead.', 'ACCOUNT_WRITE_UNAVAILABLE')
        }
    }
    return { filename, raw }
}

export function accountWriteAvailable(projectRoot, sourceEnv = process.env) {
    try {
        readWritableDocument(projectRoot, sourceEnv)
        return true
    } catch {
        return false
    }
}

export function listManagedAccounts(sourceEnv = process.env) {
    return fullAccounts(sourceEnv).map(safeAccount)
}

export function previewAccounts(projectRoot, rawAccounts, sourceEnv = process.env) {
    const existing = fullAccounts(sourceEnv)
    const normalized = validateBatch(rawAccounts, existing)
    const used = new Set(existing.map(account => account.index))
    const preview = normalized.map(account => {
        const index = nextFreeIndex(used)
        used.add(index)
        return safeAccount({ ...account, index })
    })
    readWritableDocument(projectRoot, sourceEnv)
    return { accounts: preview, count: preview.length, writable: true }
}

export function addAccounts(projectRoot, rawAccounts, sourceEnv = process.env) {
    const document = readWritableDocument(projectRoot, sourceEnv)
    const existing = fullAccounts(sourceEnv)
    const normalized = validateBatch(rawAccounts, existing)
    const used = new Set(existing.map(account => account.index))
    let raw = document.raw
    const created = []
    for (const account of normalized) {
        const index = nextFreeIndex(used)
        used.add(index)
        raw = rewriteAccountBlock(raw, index, accountValues(index, account))
        created.push(safeAccount({ ...account, index }))
    }
    atomicWrite(document.filename, raw)
    syncProcessEnv(document.filename, sourceEnv)
    return { accounts: created, count: created.length, path: document.filename }
}

export function updateAccount(projectRoot, indexValue, patch, sourceEnv = process.env) {
    const index = Number(indexValue)
    if (!Number.isSafeInteger(index) || index < 1) fail('Account index must be a positive integer.')
    const document = readWritableDocument(projectRoot, sourceEnv)
    const existing = fullAccounts(sourceEnv).find(account => account.index === index)
    if (!existing) fail(`ACCOUNT_${index} is not configured.`, 'ACCOUNT_NOT_FOUND')
    if (patch?.email !== undefined && String(patch.email).trim().toLowerCase() !== existing.email.toLowerCase()) {
        fail('Account email cannot be changed; add a new account instead.')
    }
    const mergedPatch = { ...patch, email: existing.email }
    if (patch?.proxy !== undefined && patch.proxy !== null) {
        mergedPatch.proxy = { ...existing.proxy, ...patch.proxy }
    }
    const normalized = normalizeAccount(mergedPatch, existing)
    const raw = rewriteAccountBlock(document.raw, index, accountValues(index, normalized))
    atomicWrite(document.filename, raw)
    syncProcessEnv(document.filename, sourceEnv)
    return { account: safeAccount({ ...normalized, index }), path: document.filename }
}

export function deleteAccount(projectRoot, indexValue, sourceEnv = process.env) {
    const index = Number(indexValue)
    if (!Number.isSafeInteger(index) || index < 1) fail('Account index must be a positive integer.')
    const document = readWritableDocument(projectRoot, sourceEnv)
    const existing = fullAccounts(sourceEnv).find(account => account.index === index)
    if (!existing) fail(`ACCOUNT_${index} is not configured.`, 'ACCOUNT_NOT_FOUND')
    atomicWrite(document.filename, removeAccountBlock(document.raw, index))
    syncProcessEnv(document.filename, sourceEnv)
    return { account: safeAccount({ ...existing, index }), path: document.filename }
}

export function syncProcessEnv(filename, targetEnv = process.env) {
    const parsed = parseAssignments(fs.readFileSync(filename, 'utf8'))
    for (const key of Object.keys(targetEnv)) {
        if (/^ACCOUNT_[1-9]\d*_[A-Z0-9_]+$/.test(key)) delete targetEnv[key]
    }
    for (const [key, value] of parsed) {
        if (/^ACCOUNT_[1-9]\d*_[A-Z0-9_]+$/.test(key)) targetEnv[key] = value
    }
}

export function redactAccountInput(account) {
    return safeAccount(account)
}
