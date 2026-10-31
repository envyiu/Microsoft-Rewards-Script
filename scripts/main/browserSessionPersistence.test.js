import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { closeSessionDb, loadSessionRow, openSessionDb } from '../utils.js'
import { persistBrowserSession } from './browserSessionPersistence.js'

test('a fresh manual login creates and saves its platform session', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-browser-session-'))
    const dbPath = path.join(dir, 'nested', 'sessions.db')
    const storageState = {
        cookies: [
            {
                name: 'session',
                value: 'test-value',
                domain: '.bing.com',
                path: '/',
                expires: -1,
                httpOnly: true,
                secure: true,
                sameSite: 'Lax'
            }
        ],
        origins: []
    }
    const fingerprint = { fingerprint: { navigator: { userAgent: 'test-agent' } }, headers: {} }

    try {
        persistBrowserSession(dbPath, 'manual@example.test', 'mobile', storageState, fingerprint, true)
        const db = openSessionDb(dbPath, { readonly: true })
        try {
            const saved = loadSessionRow(db, 'manual@example.test', 'mobile')
            assert.deepEqual(saved.storageState, storageState)
            assert.deepEqual(saved.fingerprint, fingerprint)
            assert.ok(saved.updatedAt > 0)
        } finally {
            closeSessionDb(db)
        }
        assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
