import assert from 'node:assert/strict'
import test from 'node:test'

import { accountRefForEmail, proxyForAccount } from './androidSessions.js'

test('account refs are stable SHA-256 values of normalized email', () => {
    assert.equal(
        accountRefForEmail(' User@Example.COM '),
        'b4c9a289323b21a01c3e940f150eb9b8c542587f1abfd8f0e1cc1ffc5e475514'
    )
})

test('proxy URI URL-encodes credentials and rejects partial credentials', () => {
    const prior = {
        url: process.env.ACCOUNT_1_PROXY_URL,
        port: process.env.ACCOUNT_1_PROXY_PORT,
        username: process.env.ACCOUNT_1_PROXY_USERNAME,
        password: process.env.ACCOUNT_1_PROXY_PASSWORD
    }
    process.env.ACCOUNT_1_PROXY_URL = 'http://proxy.example'
    process.env.ACCOUNT_1_PROXY_PORT = '8080'
    process.env.ACCOUNT_1_PROXY_USERNAME = 'u@x'
    process.env.ACCOUNT_1_PROXY_PASSWORD = 'p:a'
    try {
        assert.equal(proxyForAccount(1), 'http://u%40x:p%3Aa@proxy.example:8080/')
        delete process.env.ACCOUNT_1_PROXY_PASSWORD
        assert.equal(proxyForAccount(1), null)
    } finally {
        for (const [key, value] of Object.entries({
            ACCOUNT_1_PROXY_URL: prior.url,
            ACCOUNT_1_PROXY_PORT: prior.port,
            ACCOUNT_1_PROXY_USERNAME: prior.username,
            ACCOUNT_1_PROXY_PASSWORD: prior.password
        })) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
})
