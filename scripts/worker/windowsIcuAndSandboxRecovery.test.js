import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { verifyWindowsBrowserBundle } from './windows/verifyBrowserBundle.mjs'
import { recoverSmartState } from '../api/recoverSmartState.js'

test('verifyWindowsBrowserBundle accepts complete headless-shell bundle and rejects missing icudtl.dat/.pak companion files', t => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msrw-win-icu-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

    const shellDir = path.join(tmp, 'chromium_headless_shell-1228', 'chrome-headless-shell-win64')
    fs.mkdirSync(shellDir, { recursive: true })
    fs.writeFileSync(path.join(shellDir, 'chrome-headless-shell.exe'), 'MZ')

    assert.throws(
        () => verifyWindowsBrowserBundle(tmp),
        /missing \[icudtl\.dat, headless_lib_data\.pak, headless_lib_strings\.pak, v8_context_snapshot\.bin\]/
    )

    for (const companion of [
        'icudtl.dat',
        'headless_lib_data.pak',
        'headless_lib_strings.pak',
        'v8_context_snapshot.bin'
    ]) {
        fs.writeFileSync(path.join(shellDir, companion), 'data')
    }

    const verified = verifyWindowsBrowserBundle(tmp)
    assert.equal(verified.ok, true)
    assert.equal(verified.checked, 1)
})

test('Cloud Sandbox 24h container restart recovery preserves unclosed search reservation, completed workers, and new-account lifecycle', () => {
    const now = new Date('2026-11-18T12:00:00.000Z')
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(now)
    const startedAt = '2026-11-17T00:00:00.000Z'
    const readyAt = new Date(Date.parse(startedAt) + 72 * 3600000).toISOString()

    const baseDoc = {
        config: { enabled: true, timezone: 'Asia/Ho_Chi_Minh' },
        state: {
            accounts: {
                1: {
                    day,
                    workersCompleted: [],
                    workersFailed: ['dailySet'],
                    platforms: {
                        desktop: { queries: 0, remaining: 90, quotaKnown: false, complete: false },
                        mobile: { queries: 0, remaining: 60, quotaKnown: false, complete: false }
                    }
                },
                2: {
                    day,
                    newAccount: { policy: 'search72h', services: [] },
                    platforms: {
                        desktop: { queries: 0, remaining: 0, quotaKnown: false, complete: false },
                        mobile: { queries: 0, remaining: 0, quotaKnown: false, complete: false }
                    }
                }
            },
            sessions: []
        }
    }

    // Simulate container restart mid-session: dailySet completed, desktop search started with budget=5
    // before 24h Sandbox container recycle killed the process prior to SMART-SEARCH-END.
    const journalEvents = [
        {
            ts: Date.parse('2026-11-18T11:50:00.000Z'),
            payload: {
                smartJobId: `${day}-1-desktop-5`,
                title: 'SMART-WORKER-END',
                message: 'worker=dailySet | status=done'
            }
        },
        {
            ts: Date.parse('2026-11-18T11:52:00.000Z'),
            payload: {
                smartJobId: `${day}-1-desktop-5`,
                title: 'SMART-SEARCH-START',
                message: 'budget=5 | platform=desktop'
            }
        },
        {
            ts: Date.parse('2026-11-18T11:55:00.000Z'),
            payload: {
                smartJobId: `${day}-2-warmup-desktop-4`,
                title: 'NEW-ACCOUNT-CHECKPOINT',
                message: JSON.stringify({
                    jobId: `${day}-2-warmup-desktop-4`,
                    at: '2026-11-18T11:55:00.000Z',
                    queries: 4,
                    policy: 'search72h',
                    startedAt,
                    readyAt
                })
            }
        }
    ]

    const { document: recovered, summary } = recoverSmartState(baseDoc, journalEvents, now)

    // 1. Scheduler remains paused until Manager reconciles after container restart
    assert.equal(recovered.config.enabled, false)
    // 2. Completed worker preserved and removed from workersFailed
    assert.deepEqual(recovered.state.accounts['1'].workersCompleted, ['dailySet'])
    assert.deepEqual(recovered.state.accounts['1'].workersFailed, [])
    // 3. Interrupted search reserves full budget=5 conservatively (never re-issues uncertain queries)
    assert.equal(recovered.state.accounts['1'].platforms.desktop.queries, 5)
    assert.equal(summary.uncertainSearches, 1)
    // 4. New-account search72h window restored intact across Sandbox container restart
    assert.equal(recovered.state.accounts['2'].newAccount.startedAt, startedAt)
    assert.equal(recovered.state.accounts['2'].newAccount.readyAt, readyAt)
})

test('Windows supervisor fails fast on missing transport.json before spawning worker child', t => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msrw-win-sup-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

    const marker = path.join(tmp, 'worker-spawned.txt')
    const fakeWinDir = path.join(tmp, 'Windows')
    const psDir = path.join(fakeWinDir, 'System32', 'WindowsPowerShell', 'v1.0')
    fs.mkdirSync(psDir, { recursive: true })
    const fakePs = path.join(psDir, 'powershell.exe')
    fs.writeFileSync(fakePs, `#!/bin/sh\necho spawned > "${marker}"\nsleep 10\n`, { mode: 0o755 })
    fs.writeFileSync(path.join(tmp, 'worker.json'), JSON.stringify({ API_PORT: '3010' }))

    const supervisorPath = path.resolve('scripts/worker/windows/supervisor.mjs')
    const { spawnSync } = process.getBuiltinModule('node:child_process')
    const result = spawnSync(process.execPath, [supervisorPath], {
        env: { ...process.env, MSRW_WORKER_HOME: tmp, WINDIR: fakeWinDir },
        encoding: 'utf8',
        timeout: 5000
    })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Missing required Windows worker transport configuration/)
    assert.equal(fs.existsSync(marker), false, 'worker must not be spawned before transport.json validation')
})
