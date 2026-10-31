import crypto from 'node:crypto'
import { isIP } from 'node:net'
import { Impit } from 'impit'

import { createBrowserProxyConfig } from '../../common/proxyRelay.cjs'
import { loadAccounts } from './accounts.js'

const IP_ENDPOINT = 'https://api64.ipify.org?format=json'
const FAILURE = 'Could not check the public IP. Check the proxy connection and credentials, then retry.'

function proxyFor(index, env) {
    const prefix = `ACCOUNT_${index}_PROXY_`
    return {
        url: String(env[`${prefix}URL`] ?? '').trim(),
        port: Number(env[`${prefix}PORT`] ?? 0),
        username: String(env[`${prefix}USERNAME`] ?? '').trim(),
        password: String(env[`${prefix}PASSWORD`] ?? '').trim()
    }
}

function signature(index, proxy, env) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify([env[`ACCOUNT_${index}_EMAIL`], proxy]))
        .digest('hex')
}

export async function probeAccountIp(proxy, { endpoint = IP_ENDPOINT, timeout = 8000 } = {}) {
    let lease
    try {
        // Match the browser's proxy route, even when HTTP query proxying is disabled.
        lease = await createBrowserProxyConfig(proxy)
        let proxyUrl
        if (lease.proxy) {
            const url = new URL(lease.proxy.server)
            if (lease.proxy.username) url.username = encodeURIComponent(lease.proxy.username)
            if (lease.proxy.password) url.password = encodeURIComponent(lease.proxy.password)
            proxyUrl = url.toString()
        }
        const client = new Impit({ browser: 'chrome', proxyUrl, timeout })
        const response = await client.fetch(endpoint, { timeout })
        if (response.status !== 200) throw new Error('IP service unavailable')
        const text = await response.text()
        if (text.length > 2048) throw new Error('Invalid IP response')
        const ip = JSON.parse(text)?.ip
        if (typeof ip !== 'string' || !isIP(ip)) throw new Error('Invalid IP response')
        return { ip, family: isIP(ip) === 4 ? 'IPv4' : 'IPv6', error: null }
    } catch {
        // Transport errors may contain an authenticated proxy URL. Never return them.
        return { ip: null, family: null, error: FAILURE }
    } finally {
        await lease?.close().catch(() => {})
    }
}

export class AccountIpChecker {
    constructor({ probe = probeAccountIp, concurrency = 4 } = {}) {
        this.probe = probe
        this.concurrency = concurrency
        this.active = 0
        this.waiters = []
        this.inFlight = new Map()
        this.results = new Map()
    }

    get(index, env = process.env) {
        const record = this.results.get(index)
        return record?.signature === signature(index, proxyFor(index, env), env) ? structuredClone(record.result) : null
    }

    async check(accountIndexes = null, env = process.env) {
        const known = new Set(loadAccounts(env).map(account => account.index))
        if (
            accountIndexes !== null &&
            (!Array.isArray(accountIndexes) ||
                !accountIndexes.length ||
                accountIndexes.some(index => !Number.isSafeInteger(index) || !known.has(index)))
        ) {
            const error = new Error('accountIndexes must be a non-empty array of configured account indexes.')
            error.code = 'BAD_REQUEST'
            throw error
        }
        const indexes = [...new Set(accountIndexes ?? known)]
        return Promise.all(indexes.map(index => this._checkOne(index, env)))
    }

    _checkOne(index, env) {
        const proxy = proxyFor(index, env)
        const hash = signature(index, proxy, env)
        const key = `${index}:${hash}`
        if (this.inFlight.has(key)) return this.inFlight.get(key)
        const promise = this._probe(index, proxy, hash).finally(() => this.inFlight.delete(key))
        this.inFlight.set(key, promise)
        return promise
    }

    async _probe(index, proxy, hash) {
        if (this.active >= this.concurrency) await new Promise(resolve => this.waiters.push(resolve))
        else this.active++
        const started = Date.now()
        try {
            let checked
            try {
                checked = await this.probe(proxy)
            } catch {
                checked = { ip: null, family: null, error: FAILURE }
            }
            const result = {
                accountIndex: index,
                ...checked,
                route: proxy.url ? 'proxy' : 'direct',
                checkedAt: new Date().toISOString(),
                durationMs: Date.now() - started
            }
            this.results.set(index, { signature: hash, result })
            return structuredClone(result)
        } finally {
            const next = this.waiters.shift()
            if (next) next()
            else this.active--
        }
    }
}
