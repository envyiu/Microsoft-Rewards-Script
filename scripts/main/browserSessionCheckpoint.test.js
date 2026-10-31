import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { chromium } from 'patchright'

import { createSessionCheckpointer } from './browserSessionCheckpoint.js'
import { captureBrowserSessionState } from './browserSessionState.js'
import { persistBrowserSession } from './browserSessionPersistence.js'
import { openSessionDb, loadSessionRow, closeSessionDb } from '../utils.js'

test('a skipped pre-login checkpoint does not block an explicit save', async () => {
    const calls = []
    const checkpoint = createSessionCheckpointer(async (reason, options) => {
        calls.push(reason)
        if (!options.allowUnconfirmed) return false
        return true
    })
    assert.equal(await checkpoint('before login'), false)
    assert.equal(await checkpoint('GUI close', { allowUnconfirmed: true }), true)
    assert.deepEqual(calls, ['before login', 'GUI close'])
})

test('explicit close waits for an active checkpoint and captures again', async () => {
    let release
    const gate = new Promise(resolve => {
        release = resolve
    })
    const calls = []
    const checkpoint = createSessionCheckpointer(async reason => {
        calls.push(reason)
        if (reason === 'periodic') await gate
        return true
    })
    const periodic = checkpoint('periodic')
    const closing = checkpoint('GUI close', { allowUnconfirmed: true })
    release()
    await Promise.all([periodic, closing])
    assert.deepEqual(calls, ['periodic', 'GUI close'])
})

test('a failed write releases the checkpoint so saving can be retried', async () => {
    let attempts = 0
    const checkpoint = createSessionCheckpointer(() => {
        if (++attempts === 1) throw new Error('write failed')
        return true
    })
    await assert.rejects(checkpoint('GUI close', { allowUnconfirmed: true }), /write failed/)
    assert.equal(await checkpoint('retry', { allowUnconfirmed: true }), true)
})

test('browser cookies and local storage survive save, close, and reopen after a pre-login skip', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-session-roundtrip-'))
    const dbPath = path.join(dir, 'sessions.db')
    const server = http.createServer((_req, res) => {
        res.setHeader('Set-Cookie', 'fixture_login=authenticated; Path=/; HttpOnly; SameSite=Lax')
        res.end('<!doctype html><title>Local session fixture</title>')
    })
    let browser
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        const origin = `http://127.0.0.1:${server.address().port}`
        browser = await chromium.launch({ headless: true })
        const context = await browser.newContext()
        let latest = null
        const checkpoint = createSessionCheckpointer(async (_reason, options) => {
            if (!options.allowUnconfirmed) return false
            latest = await captureBrowserSessionState(context, latest)
            persistBrowserSession(dbPath, 'fixture@example.test', 'desktop', latest, null, false)
            return true
        })
        await checkpoint('before login')
        const page = await context.newPage()
        await page.goto(origin)
        await page.evaluate(() => localStorage.setItem('fixture_login', 'authenticated'))
        assert.equal(await checkpoint('GUI close', { allowUnconfirmed: true }), true)
        await context.close()
        const db = openSessionDb(dbPath, { readonly: true })
        let saved
        try {
            saved = loadSessionRow(db, 'fixture@example.test', 'desktop').storageState
        } finally {
            closeSessionDb(db)
        }
        const restored = await browser.newContext({ storageState: saved })
        assert.ok((await restored.cookies(origin)).some(cookie => cookie.name === 'fixture_login'))
        const reopened = await restored.newPage()
        await reopened.goto(origin)
        assert.equal(await reopened.evaluate(() => localStorage.getItem('fixture_login')), 'authenticated')
    } finally {
        await browser?.close()
        await new Promise(resolve => server.close(resolve))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
