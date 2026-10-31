import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
require('ts-node').register({ transpileOnly: true })
const { AccountSchema } = require('../../src/util/Validator.ts')

function account(proxy) {
    return {
        email: 'proxy@example.test',
        password: '',
        recoveryEmail: '',
        geoLocale: 'auto',
        langCode: 'en',
        proxy,
        saveFingerprint: { mobile: false, desktop: false }
    }
}

test('runtime account validation accepts authenticated SOCKS5 credentials', () => {
    const result = AccountSchema.safeParse(
        account({
            proxyHttp: true,
            url: 'socks5://proxy.example.test',
            port: 1080,
            username: 'proxy-user',
            password: 'proxy-password'
        })
    )
    assert.equal(result.success, true)
})

test('runtime account validation keeps partial credentials and authenticated SOCKS4 invalid', () => {
    const partial = AccountSchema.safeParse(
        account({ proxyHttp: false, url: 'socks5://proxy.example.test', port: 1080, username: 'proxy-user', password: '' })
    )
    const socks4 = AccountSchema.safeParse(
        account({
            proxyHttp: false,
            url: 'socks4://proxy.example.test',
            port: 1080,
            username: 'proxy-user',
            password: 'proxy-password'
        })
    )

    assert.equal(partial.success, false)
    assert.equal(socks4.success, false)
})
