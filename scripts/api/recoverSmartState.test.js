import test from 'node:test'
import assert from 'node:assert/strict'
import { recoverSmartState } from './recoverSmartState.js'
test('recovery retains verified work, quota, search reservations and ignores old days', () => {
    const input = {
        config: { enabled: true },
        state: {
            accounts: {
                1: {
                    day: '2026-11-11',
                    workersCompleted: [],
                    platforms: { desktop: { queries: 0 }, mobile: { queries: 4 } }
                }
            },
            sessions: []
        }
    }
    const e = (id, title, message) => ({ smartJobId: id, title, message })
    const events = [
        e('2026-11-10-1-workers-dailySet', 'SMART-WORKER-END', 'worker=dailySet'),
        e('2026-11-11-1-workers-morePromotions', 'SMART-WORKER-END', 'worker=morePromotions'),
        e('2026-11-11-1-desktop-1', 'SMART-SEARCH-END', 'queries=3 | points=9 | remaining=81 | quotaAvailable=true'),
        e('2026-11-11-1-desktop-2', 'SMART-SEARCH-START', 'budget=5'),
        e(
            '2026-11-11-1-quota-1',
            'SMART-QUOTA',
            JSON.stringify({
                readAt: '2026-11-11T05:00:00Z',
                desktop: { max: 90, progress: 90 },
                mobile: { max: 60, progress: 30 }
            })
        )
    ]
    const r = recoverSmartState(input, events, new Date('2026-11-11T07:00:00Z'))
    assert.deepEqual(r.document.state.accounts[1].workersCompleted, ['morePromotions'])
    assert.equal(r.document.state.accounts[1].platforms.desktop.queries, 8)
    assert.equal(r.document.state.accounts[1].platforms.desktop.remaining, 0)
    assert.equal(r.document.state.accounts[1].platforms.mobile.queries, 4)
    assert.equal(r.document.config.enabled, false)
    assert.equal(input.config.enabled, true)
    assert.equal(r.summary.uncertainSearches, 1)
    assert.equal(
        recoverSmartState(r.document, events, new Date('2026-11-11T07:00:00Z')).document.state.accounts[1].platforms
            .desktop.queries,
        8
    )
})

test('a retained warmup query cannot restart an already elapsed lifecycle', () => {
    const input = {
        config: { enabled: true },
        state: {
            accounts: { 1: { day: '2026-11-11', platforms: { desktop: { queries: 0 }, mobile: { queries: 0 } } } },
            sessions: []
        }
    }
    const event = {
        smartJobId: '2026-11-11-1-warmup-desktop',
        title: 'NEW-ACCOUNT-CHECKPOINT',
        message: JSON.stringify({
            jobId: '2026-11-11-1-warmup-desktop',
            queries: 1,
            at: '2026-11-11T01:00:00Z',
            services: []
        })
    }
    const result = recoverSmartState(input, [event], new Date('2026-11-11T07:00:00Z'))
    assert.equal(result.document.state.accounts[1].newAccount.startedAt, undefined)
    assert.equal(result.document.state.accounts[1].newAccount.readyAt, undefined)
    assert.equal(result.document.state.accounts[1].newAccount.recoveryNeedsReview, true)
    assert.equal(result.summary.lifecycleReviews, 1)
    assert.equal(result.document.config.enabled, false)
})

test('recovery accepts explicit 72-hour and legacy 168-hour evidence without restarting either timer', () => {
    for (const [policy, hours] of [
        ['search72h', 72],
        ['standard168h', 168]
    ]) {
        const startedAt = '2026-11-01T01:00:00Z',
            readyAt = new Date(Date.parse(startedAt) + hours * 3600000).toISOString()
        const input = {
            config: { enabled: true },
            state: {
                accounts: { 1: { day: '2026-11-11', newAccount: { policy }, platforms: { desktop: { queries: 0 } } } },
                sessions: []
            }
        }
        const jobId = '2026-11-11-1-warmup-desktop'
        const event = {
            smartJobId: jobId,
            title: 'NEW-ACCOUNT-CHECKPOINT',
            message: JSON.stringify({
                jobId,
                policy,
                startedAt,
                readyAt,
                queries: 1,
                at: '2026-11-11T01:00:00Z',
                services: []
            })
        }
        const result = recoverSmartState(input, [event], new Date('2026-11-11T07:00:00Z'))
        assert.equal(result.document.state.accounts[1].newAccount.readyAt, readyAt)
        assert.equal(result.document.state.accounts[1].newAccount.policy, policy)
        assert.equal(result.summary.lifecycleReviews, 0)
        assert.equal(
            recoverSmartState(result.document, [event]).document.state.accounts[1].newAccount.startedAt,
            startedAt
        )
        const invalid = { ...event, message: JSON.stringify({ ...JSON.parse(event.message), readyAt: startedAt }) }
        assert.equal(recoverSmartState(input, [invalid]).summary.lifecycleReviews, 1)
    }
})
