import assert from 'node:assert/strict'
import test from 'node:test'

import { captureBrowserSessionState } from './browserSessionState.js'

test('session capture reads existing pages without creating a temporary page', async () => {
    let storageStateCalled = false
    let newPageCalled = false
    const context = {
        cookies: async () => [{ name: 'session', value: 'new' }],
        pages: () => [
            {
                isClosed: () => false,
                url: () => 'https://rewards.bing.com/dashboard',
                evaluate: async () => [{ name: 'theme', value: 'dark' }]
            }
        ],
        storageState: async () => {
            storageStateCalled = true
        },
        newPage: async () => {
            newPageCalled = true
        }
    }
    const previous = {
        cookies: [{ name: 'session', value: 'old' }],
        origins: [{ origin: 'https://login.live.com', localStorage: [{ name: 'old', value: 'kept' }] }]
    }

    const result = await captureBrowserSessionState(context, previous)

    assert.deepEqual(result.cookies, [{ name: 'session', value: 'new' }])
    assert.deepEqual(result.origins, [
        { origin: 'https://login.live.com', localStorage: [{ name: 'old', value: 'kept' }] },
        { origin: 'https://rewards.bing.com', localStorage: [{ name: 'theme', value: 'dark' }] }
    ])
    assert.equal(storageStateCalled, false)
    assert.equal(newPageCalled, false)
})

test('session capture tolerates a page navigating during local storage collection', async () => {
    const previous = {
        cookies: [],
        origins: [{ origin: 'https://rewards.bing.com', localStorage: [{ name: 'old', value: 'kept' }] }]
    }
    const context = {
        cookies: async () => [],
        pages: () => [
            {
                isClosed: () => false,
                url: () => 'https://rewards.bing.com/',
                evaluate: async () => {
                    throw new Error('Execution context was destroyed')
                }
            }
        ]
    }

    assert.deepEqual(await captureBrowserSessionState(context, previous), previous)
})
