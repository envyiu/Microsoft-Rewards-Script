import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSearchQuotaSnapshot, reconcileSearchQuota } from './searchQuotaSnapshot.js'

const at = Date.parse('2026-10-25T07:30:00Z')
const snapshot = (desktop = { max: 90, progress: 0 }, mobile = { max: 60, progress: 0 }, time = at) =>
    parseSearchQuotaSnapshot(JSON.stringify({ readAt: new Date(time).toISOString(), desktop, mobile }), at)
function state() {
    return {
        day: '2026-10-25',
        workersCompleted: ['dailySet', 'readToEarn'],
        probeUsed: { mobile: true, desktop: false },
        platforms: {
            desktop: { complete: true, failed: false, failures: 0, remaining: 0, quotaKnown: true, queries: 7 },
            mobile: { complete: false, failed: true, failures: 4, remaining: null, quotaKnown: false, queries: 18 }
        }
    }
}
test('fresh changed quotas reopen the acc 14/15 terminal states without losing activity or query progress', () => {
    const s = state()
    assert.deepEqual(reconcileSearchQuota(s, snapshot()), ['desktop', 'mobile'])
    assert.deepEqual(s.workersCompleted, ['dailySet', 'readToEarn'])
    assert.equal(s.platforms.desktop.remaining, 90)
    assert.equal(s.platforms.mobile.remaining, 60)
    assert.equal(s.platforms.mobile.failures, 0)
    assert.equal(s.platforms.mobile.failed, false)
    assert.equal(s.platforms.desktop.complete, false)
    assert.equal(s.platforms.desktop.queries, 7)
    assert.equal(s.platforms.mobile.queries, 18)
    assert.equal(s.probeUsed.mobile, false)
})
test('an unchanged positive snapshot cannot grant endless new retry budgets', () => {
    const s = state()
    reconcileSearchQuota(s, snapshot())
    Object.assign(s.platforms.mobile, { failed: true, failures: 4 })
    assert.deepEqual(reconcileSearchQuota(s, snapshot(undefined, undefined, at + 1000)), [])
    assert.equal(s.platforms.mobile.failed, true)
    assert.equal(s.platforms.mobile.failures, 4)
    assert.deepEqual(reconcileSearchQuota(s, snapshot(undefined, { max: 60, progress: 3 }, at + 2000)), ['mobile'])
})
test('missing, zero-cap and malformed counters do not fabricate completion or reset failures', () => {
    const s = state(),
        before = structuredClone(s.platforms)
    reconcileSearchQuota(s, snapshot({ max: 0, progress: 0 }, { max: 60, progress: '0' }))
    assert.deepEqual(s.platforms, before)
    reconcileSearchQuota(s, snapshot(null, null, at + 1000))
    assert.deepEqual(s.platforms, before)
})
test('verified full quotas complete only their own platform', () => {
    const s = state()
    reconcileSearchQuota(s, snapshot(null, { max: 60, progress: 60 }))
    assert.equal(s.platforms.mobile.complete, true)
    assert.equal(s.platforms.mobile.failed, false)
    assert.equal(s.platforms.desktop.quotaReadAt, undefined)
})
test('older observations and active-search reconciliation cannot overwrite newer platform results', () => {
    const s = state()
    reconcileSearchQuota(s, snapshot())
    reconcileSearchQuota(s, snapshot({ max: 90, progress: 90 }, null, at - 1000))
    assert.equal(s.platforms.desktop.remaining, 90)
    reconcileSearchQuota(s, snapshot({ max: 90, progress: 90 }, null, at + 1000), { skipPlatform: 'desktop' })
    assert.equal(s.platforms.desktop.remaining, 90)
})
test('snapshot parsing rejects stale/future timestamps and invalid payloads', () => {
    for (const msg of ['bad json', 'null', '{}', JSON.stringify({ readAt: at })])
        assert.equal(parseSearchQuotaSnapshot(msg, at), null)
    assert.equal(snapshot(null, null, at - 11 * 60_000), null)
    assert.equal(snapshot(null, null, at + 61_000), null)
})
