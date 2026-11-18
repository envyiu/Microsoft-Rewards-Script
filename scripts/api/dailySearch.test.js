import assert from 'node:assert/strict'
import test from 'node:test'
import { dailySearchRemaining, reserveDailySearch, settleDailySearch, captureSearchStreak } from './dailySearch.js'
import { validateSmartConfig } from '../../packages/contracts/smartConfig.js'
const limits = { mobile: { min: 4, max: 8 }, desktop: { min: 8, max: 10 } }
const fixture = () => ({
    email: 'fake@example.test',
    day: '2026-11-12',
    platforms: { mobile: { queries: 0 }, desktop: { queries: 0 } }
})
test('daily targets and reservations survive serialization/handoff; uncertain sends stay consumed', () => {
    const s = fixture(),
        initial = dailySearchRemaining(s, limits, 'mobile')
    const job = { day: s.day, platform: 'mobile' }
    reserveDailySearch(s, job, 4)
    const restored = JSON.parse(JSON.stringify(s))
    assert.equal(dailySearchRemaining(restored, limits, 'mobile'), initial - 4)
    assert.equal(dailySearchRemaining(restored, limits, 'desktop'), dailySearchRemaining(s, limits, 'desktop'))
    settleDailySearch(restored, job, 2)
    assert.equal(dailySearchRemaining(restored, limits, 'mobile'), initial - 2)
    settleDailySearch(restored, { ...job, day: 'yesterday' }, 0)
    assert.equal(dailySearchRemaining(restored, limits, 'mobile'), initial - 2)
    assert.equal(dailySearchRemaining(fixture(), limits, 'mobile'), initial)
})
test('first activation counts existing searches and missing limits preserve previous behavior', () => {
    const s = fixture()
    s.platforms.desktop.queries = 19
    assert.equal(dailySearchRemaining(s, limits, 'desktop'), 0)
    assert.equal(dailySearchRemaining(fixture(), undefined, 'mobile'), null)
})
test('configuration rejects malformed daily ranges', () => {
    assert.deepEqual(validateSmartConfig({ dailySearchLimits: limits }).dailySearchLimits, limits)
    for (const value of [[], { mobile: { min: 8, max: 4 } }, { ...limits, desktop: { min: 8.5, max: 10 } }])
        assert.throws(() => validateSmartConfig({ dailySearchLimits: value }))
})

test('streak targets replace old ranges, round down, and retain reservations when streak changes', () => {
    const s = fixture(),
        day = s.day
    for (const [streak, desktop, mobile] of [
        [0, 9, 6],
        [1, 9, 6],
        [10, 15, 10],
        [30, 27, 18],
        [90, 27, 18]
    ]) {
        s.searchStreak = { dailyCounter: streak, observedAt: '2026-11-12T00:00:00Z' }
        assert.equal(dailySearchRemaining(s, limits, 'desktop', true), desktop)
        assert.equal(dailySearchRemaining(s, limits, 'mobile', true), mobile)
    }
    const job = { day, platform: 'desktop' }
    reserveDailySearch(s, job, 5)
    const restored = JSON.parse(JSON.stringify(s))
    restored.searchStreak.dailyCounter = 0
    assert.equal(dailySearchRemaining(restored, limits, 'desktop', true), 4)
    restored.searchStreak.dailyCounter = 30
    assert.equal(dailySearchRemaining(restored, limits, 'desktop', true), 22)
    assert.equal(dailySearchRemaining(fixture(), undefined, 'mobile', true), 6)
})

test('streak observations reject wrong accounts, unknown and old values while retaining the last successful reading', () => {
    const s = fixture(),
        now = Date.parse('2026-11-16T12:00:00Z')
    const reading = (changes = {}) =>
        JSON.stringify({
            version: 1,
            email: s.email,
            source: 'rewards-page',
            status: 'fresh',
            dailyCounter: 12,
            observedAt: '2026-11-16T11:00:00Z',
            partners: [],
            ...changes
        })
    assert.equal(captureSearchStreak(s, s.email, reading(), now), true)
    assert.equal(
        captureSearchStreak(s, s.email, reading({ email: 'other@example.test', dailyCounter: 30 }), now),
        false
    )
    assert.equal(
        captureSearchStreak(
            s,
            s.email,
            reading({ status: 'unknown', dailyCounter: null, observedAt: '2026-11-16T11:30:00Z' }),
            now
        ),
        false
    )
    assert.equal(
        captureSearchStreak(s, s.email, reading({ dailyCounter: 3, observedAt: '2026-11-16T10:00:00Z' }), now),
        false
    )
    assert.equal(s.searchStreak.dailyCounter, 12)
    assert.equal(
        captureSearchStreak(s, s.email, reading({ dailyCounter: 3, observedAt: '2026-11-16T11:30:00Z' }), now),
        true
    )
    assert.equal(s.searchStreak.dailyCounter, 3)
})
