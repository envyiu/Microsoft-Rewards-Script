import assert from 'node:assert/strict'
import test from 'node:test'
import { captureAppAuthorization, applyAppAuthorization, migrateAppAuthorizationSso } from './appAuthorization.js'

test('only explicit app challenges block the shared app credential', () => {
    assert.equal(
        captureAppAuthorization({
            title: 'LOGIN-APP',
            message: 'Could not resolve mobile OAuth code - app activities will be retried by the scheduler'
        }),
        null
    )
    assert.equal(
        captureAppAuthorization({
            title: 'LOGIN',
            message: 'App authorization needs user action | reason=email-code-required'
        }),
        null
    )
    assert.equal(
        captureAppAuthorization({
            title: 'LOGIN-APP',
            message: 'App authorization needs user action | reason=anything'
        }),
        null
    )
    const outcome = captureAppAuthorization({
        title: 'LOGIN-APP',
        message: 'App authorization needs user action | reason=email-code-required'
    })
    const state = {
        day: 'today',
        workersCompleted: ['dailySet'],
        workersFailed: ['morePromotions'],
        platforms: { desktop: { complete: false } }
    }
    applyAppAuthorization(state, { job: { day: state.day }, appAuthorization: outcome }, 'test-time')
    assert.deepEqual(state.workersFailed, ['morePromotions', 'readToEarn', 'dailyCheckIn', 'appPromotions'])
    assert.equal(state.appAuthorization.reason, 'email-code-required')
    assert.deepEqual(state.platforms, { desktop: { complete: false } })
    assert.deepEqual(state.workersCompleted, ['dailySet'])
})
test('late or interrupted jobs cannot change current authorization state', () => {
    for (const record of [{ job: { day: 'yesterday' } }, { job: { day: 'today' }, handoff: true }]) {
        const state = { day: 'today', workersCompleted: [], workersFailed: [] }
        applyAppAuthorization(state, { ...record, appAuthorization: { required: true, reason: 'email-code-required' } })
        assert.equal(state.appAuthorization, undefined)
        assert.deepEqual(state.workersFailed, [])
    }
})
test('a token clears the diagnostic without manufacturing completion or clearing genuine failures', () => {
    const state = {
        day: 'today',
        appAuthorization: { required: true },
        workersCompleted: ['readToEarn'],
        workersFailed: ['dailyCheckIn']
    }
    applyAppAuthorization(state, {
        job: { day: 'today' },
        appAuthorization: captureAppAuthorization({ title: 'LOGIN-APP', message: 'Mobile access token received' })
    })
    assert.equal(state.appAuthorization.required, false)
    assert.deepEqual(state.workersCompleted, ['readToEarn'])
    assert.deepEqual(state.workersFailed, ['dailyCheckIn'])
})

test('silent SSO migration retries only previously blocked app tasks once without resetting protection or searches', () => {
    const state = {
        appAuthorization: { required: true, reason: 'email-code-required' },
        workersCompleted: ['dailySet'],
        workersFailed: ['dailyCheckIn', 'readToEarn', 'appPromotions', 'morePromotions'],
        workerFailures: { dailyCheckIn: 4, morePromotions: 4 },
        workerRetryAt: { dailyCheckIn: 'old', morePromotions: 'keep' },
        protection: { sessions: [{ id: 'keep' }] },
        platforms: { mobile: { queries: 6 } }
    }
    migrateAppAuthorizationSso(state)
    assert.deepEqual(state.workersFailed, ['morePromotions'])
    assert.deepEqual(state.workerFailures, { morePromotions: 4 })
    assert.deepEqual(state.workerRetryAt, { morePromotions: 'keep' })
    assert.deepEqual(state.protection, { sessions: [{ id: 'keep' }] })
    assert.equal(state.platforms.mobile.queries, 6)
    assert.deepEqual(state.workersCompleted, ['dailySet'])
    state.workersFailed.push('dailyCheckIn')
    state.day = 'today'
    applyAppAuthorization(state, {
        job: { day: 'today' },
        appAuthorization: { required: true, reason: 'email-code-required' }
    })
    migrateAppAuthorizationSso(state)
    assert.deepEqual(state.workersFailed, ['morePromotions', 'dailyCheckIn', 'readToEarn', 'appPromotions'])
})
