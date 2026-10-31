import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { loadConfig, loadEnvFile } from '../utils.js'
import { workerFixture } from './fixture.js'
import { validateSmartConfig } from '../../packages/contracts/smartConfig.js'

test('manual helpers use the worker data configuration and skip repository account files', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'msrw-manual-config-'))
    const original = { config: process.env.MRS_CONFIG_FILE, skip: process.env.MRS_SKIP_ENV_FILE }
    t.after(() => {
        for (const [key, value] of [['MRS_CONFIG_FILE', original.config], ['MRS_SKIP_ENV_FILE', original.skip]]) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value
        }
        fs.rmSync(directory, { recursive: true, force: true })
    })
    const file = path.join(directory, 'worker-config.json')
    fs.writeFileSync(file, JSON.stringify({ sessionPath: path.join(directory, 'sessions') }))
    fs.writeFileSync(path.join(directory, '.env'), 'MSRW_SYNTHETIC_ENV_SHOULD_NOT_LOAD=true\n')
    process.env.MRS_CONFIG_FILE = file
    process.env.MRS_SKIP_ENV_FILE = '1'
    assert.equal(loadConfig(directory).path, file)
    loadEnvFile(directory)
    assert.equal(process.env.MSRW_SYNTHETIC_ENV_SHOULD_NOT_LOAD, undefined)
})

function snapshot(worker, accountEnv = { ACCOUNT_1_EMAIL: 'direct@example.test' }) {
    const botConfig = JSON.parse(fs.readFileSync(path.join(worker.directory, 'config.example.json'), 'utf8'))
    const schedule = validateSmartConfig({ enabled: false }, [{ index: 1 }])
    const content = { protocolVersion: 3, accountEnv, botConfig, schedule }
    return { ...content, revision: crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex'), generation: 1, authority: '00000000-0000-0000-0000-000000000001' }
}

test('remote worker refuses direct accounts, incompatible protocols and direct management writes', async t => {
    const worker = await workerFixture(t)
    const body = snapshot(worker)
    assert.equal((await worker.request('/internal/hybrid/snapshot', 'PUT', body)).status, 400)
    assert.equal((await worker.request('/internal/hybrid/status')).data.revision, null)
    assert.equal((await worker.request('/internal/hybrid/snapshot', 'PUT', { ...body, protocolVersion: 2 })).data.code, 'UPGRADE_REQUIRED')
    assert.equal((await worker.request('/config', 'PATCH', { headless: false })).status, 403)
    assert.equal((await worker.request('/manual-sessions', 'POST', { accountIndex: 1, platform: 'desktop' })).data.code, 'CAPABILITY_UNAVAILABLE')
})

test('local worker persists only its accepted subset, rejects a stale authority and keeps its data outside the release', async t => {
    const worker = await workerFixture(t, { kind: 'local' })
    const body = snapshot(worker)
    assert.equal((await worker.request('/internal/hybrid/snapshot', 'PUT', body)).status, 200)
    const stored = JSON.parse(fs.readFileSync(path.join(worker.data, 'config.json'), 'utf8'))
    assert.equal(stored.sessionPath, path.join(worker.data, 'sessions'))
    assert.equal(fs.existsSync(path.join(worker.directory, 'config.json')), false)
    assert.equal((await worker.request('/internal/hybrid/snapshot', 'PUT', { ...body, authority: crypto.randomUUID() })).data.code, 'STALE_SNAPSHOT')
    await worker.restart()
    assert.equal((await worker.request('/accounts')).data.accounts[0].email, 'direct@example.test')
    assert.equal((await worker.request('/internal/hybrid/status')).data.generation, 1)
    assert.equal((await worker.request('/internal/hybrid/status')).data.smart.config.enabled, false)
})
