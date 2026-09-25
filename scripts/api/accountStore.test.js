import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    accountWriteAvailable,
    addAccounts,
    deleteAccount,
    listManagedAccounts,
    previewAccounts,
    updateAccount
} from './accountStore.js'

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-account-store-'))
    const envFile = path.join(root, '.env')
    fs.writeFileSync(
        envFile,
        [
            '# keep this comment',
            'API_TOKEN=not-an-account-secret',
            'ACCOUNT_2_EMAIL=old@example.test',
            'ACCOUNT_2_PASSWORD=old password',
            'ACCOUNT_2_GEO_LOCALE=US',
            'ACCOUNT_2_LANG_CODE=en',
            'ACCOUNT_2_SAVE_FINGERPRINT_MOBILE=false',
            'ACCOUNT_2_SAVE_FINGERPRINT_DESKTOP=false',
            ''
        ].join('\n'),
        { mode: 0o600 }
    )
    const env = {}
    for (const [key, value] of Object.entries({
        ACCOUNT_2_EMAIL: 'old@example.test',
        ACCOUNT_2_PASSWORD: 'old password',
        ACCOUNT_2_GEO_LOCALE: 'US',
        ACCOUNT_2_LANG_CODE: 'en',
        ACCOUNT_2_SAVE_FINGERPRINT_MOBILE: 'false',
        ACCOUNT_2_SAVE_FINGERPRINT_DESKTOP: 'false'
    })) env[key] = value
    return { root, env, envFile }
}

test('account import assigns the first free slot and keeps unrelated env content', () => {
    const { root, env, envFile } = fixture()
    try {
        assert.equal(accountWriteAvailable(root, env), true)
        const preview = previewAccounts(root, [{ email: 'new@example.test', password: 'p"quoted' }], env)
        assert.equal(preview.accounts[0].index, 1)
        assert.equal(preview.accounts[0].hasPassword, true)

        const result = addAccounts(root, [{ email: 'new@example.test', password: 'p"quoted' }], env)
        assert.equal(result.accounts[0].index, 1)
        const raw = fs.readFileSync(envFile, 'utf8')
        assert.match(raw, /# keep this comment/)
        assert.match(raw, /API_TOKEN=not-an-account-secret/)
        assert.match(raw, /ACCOUNT_1_EMAIL=new@example\.test/)
        assert.equal(env.ACCOUNT_1_PASSWORD, 'p"quoted')
        assert.equal(listManagedAccounts(env)[0].hasPassword, true)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('bulk duplicates and invalid proxies fail without writing', () => {
    const { root, env, envFile } = fixture()
    try {
        const before = fs.readFileSync(envFile, 'utf8')
        assert.throws(
            () => addAccounts(root, [{ email: 'old@example.test' }], env),
            error => error.code === 'DUPLICATE_ACCOUNT'
        )
        assert.throws(
            () => addAccounts(root, [{ email: 'another@example.test', proxy: { url: 'socks5://proxy', port: 1, username: 'u', password: 'p' } }], env),
            /SOCKS proxy authentication/
        )
        assert.throws(
            () => addAccounts(root, [{ email: 'another@example.test', langCode: 'en\nACCOUNT_9_EMAIL=injected@example.test' }], env),
            /control characters/
        )
        assert.throws(
            () => addAccounts(root, [{ email: 'another@example.test', geoLocale: 'NOT_A_COUNTRY' }], env),
            /geoLocale or langCode is invalid/
        )
        assert.equal(fs.readFileSync(envFile, 'utf8'), before)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('patch keeps omitted secrets and supports explicit clearing', () => {
    const { root, env, envFile } = fixture()
    try {
        updateAccount(root, 2, { geoLocale: 'CA' }, env)
        assert.match(fs.readFileSync(envFile, 'utf8'), /ACCOUNT_2_PASSWORD=old password/)
        assert.match(fs.readFileSync(envFile, 'utf8'), /ACCOUNT_2_GEO_LOCALE=CA/)
        updateAccount(root, 2, { password: null }, env)
        assert.doesNotMatch(fs.readFileSync(envFile, 'utf8'), /ACCOUNT_2_PASSWORD=/)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('delete removes only the selected account block and keeps the remaining accounts', () => {
    const { root, env, envFile } = fixture()
    try {
        addAccounts(root, [{ email: 'new@example.test', password: 'new-password' }], env)
        const result = deleteAccount(root, 1, env)
        assert.equal(result.account.email, 'new@example.test')
        const raw = fs.readFileSync(envFile, 'utf8')
        assert.doesNotMatch(raw, /ACCOUNT_1_EMAIL=/)
        assert.match(raw, /ACCOUNT_2_EMAIL=old@example\.test/)
        assert.equal(env.ACCOUNT_1_EMAIL, undefined)
        assert.equal(env.ACCOUNT_2_EMAIL, 'old@example.test')
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})
