'use strict'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { anonymizeProxy, closeAnonymizedProxy } = require('proxy-chain')

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:', 'socks4:', 'socks5:'])
const EXPLICIT_PROTOCOL = /^[a-z][a-z\d+.-]*:\/\//i

function parseProxyUrl(value) {
    const input = String(value ?? '').trim()
    if (!input) throw new Error('Proxy URL is empty')

    let url
    try {
        url = new URL(EXPLICIT_PROTOCOL.test(input) ? input : `http://${input}`)
    } catch {
        throw new Error('Invalid proxy URL')
    }

    if (!SUPPORTED_PROTOCOLS.has(url.protocol.toLowerCase())) {
        throw new Error('Unsupported proxy protocol')
    }
    if (!url.hostname) throw new Error('Invalid proxy URL')
    if (url.username || url.password) {
        throw new Error('Put proxy credentials in the username/password fields, not in the proxy URL')
    }

    return url
}

function upstreamSocks5Url(proxyConfig) {
    const url = parseProxyUrl(proxyConfig.url)
    if (url.protocol.toLowerCase() !== 'socks5:') return null

    const hasUsername = Boolean(proxyConfig.username)
    const hasPassword = Boolean(proxyConfig.password)
    if (hasUsername !== hasPassword) {
        throw new Error('Proxy username and password must be configured together')
    }
    if (!hasUsername) return null

    url.port = String(proxyConfig.port)
    // URL setters encode reserved userinfo characters but preserve literal
    // percent signs, so encode first to keep credentials valid after parsing.
    url.username = encodeURIComponent(proxyConfig.username)
    url.password = encodeURIComponent(proxyConfig.password)
    return url.toString()
}

async function createProxyRelay(proxyConfig) {
    const upstreamUrl = upstreamSocks5Url(proxyConfig)
    if (!upstreamUrl) return null

    let relayUrl
    try {
        relayUrl = await anonymizeProxy(upstreamUrl)
    } catch {
        // Never include the upstream URL in errors; it contains proxy credentials.
        throw new Error('Could not start the local relay for the authenticated SOCKS5 proxy')
    }

    let closed = false
    return {
        url: relayUrl,
        async close() {
            if (closed) return
            closed = true
            await closeAnonymizedProxy(relayUrl, true)
        }
    }
}

async function createBrowserProxyConfig(proxyConfig, bypass = '127.0.0.1,localhost') {
    if (!proxyConfig?.url) return { proxy: undefined, close: async () => {} }

    const url = parseProxyUrl(proxyConfig.url)
    const protocol = url.protocol.toLowerCase()
    const port = Number(proxyConfig.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Proxy port must be an integer from 1 to 65535')
    }

    const hasUsername = Boolean(proxyConfig.username)
    const hasPassword = Boolean(proxyConfig.password)
    if (hasUsername !== hasPassword) {
        throw new Error('Proxy username and password must be configured together')
    }
    if (protocol === 'socks4:' && hasUsername) {
        throw new Error('SOCKS4 proxy authentication is not supported')
    }

    if (protocol === 'socks5:' && hasUsername) {
        const relay = await createProxyRelay(proxyConfig)
        if (!relay) throw new Error('Could not start the local relay for the authenticated SOCKS5 proxy')
        return {
            proxy: { server: relay.url, bypass },
            close: () => relay.close()
        }
    }

    const browserProxy = {
        server: `${protocol}//${url.hostname}:${port}`,
        bypass
    }
    if (hasUsername && hasPassword) {
        browserProxy.username = proxyConfig.username
        browserProxy.password = proxyConfig.password
    }

    return { proxy: browserProxy, close: async () => {} }
}

module.exports = { createBrowserProxyConfig, createProxyRelay }
