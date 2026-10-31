import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import test from 'node:test'

const require = createRequire(import.meta.url)
const entry = process.env.MRS_TEST_DIST
    ? new URL(`file://${path.join(process.env.MRS_TEST_DIST, 'index.js')}`)
    : new URL('../../dist/index.js', import.meta.url)
// Never import a stale build that executes the bot on import.
const ready = fs.existsSync(entry) && /require\.main === module/.test(fs.readFileSync(entry, 'utf8'))
test('bot handoff checkpoints every active platform before closing browsers', { skip: !ready }, async t => {
    const { MicrosoftRewardsBot } = require(entry.pathname)
    const { loadSession, closeSessionStore } = require(
        path.join(path.dirname(entry.pathname), 'util', 'SessionStore.js')
    )
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-checkpoint-'))
    t.after(() => {
        closeSessionStore()
        fs.rmSync(dir, { recursive: true, force: true })
    })
    const bot = Object.create(MicrosoftRewardsBot.prototype)
    const calls = []
    bot.liveContexts = new Map()
    bot.config = { sessionPath: dir }
    bot.logger = { info: () => calls.push('marker') }
    for (const isMobile of [false, true]) {
        const context = new EventEmitter()
        context.storageState = async () => {
            calls.push('capture')
            return { cookies: [], origins: [] }
        }
        context.close = async () => {
            calls.push('close')
            context.emit('close')
        }
        context.browser = () => ({ close: async () => calls.push('browser-close') })
        bot.trackBrowserContext(context, 'fixture@example.test', isMobile)
    }
    await bot.checkpointAndCloseBrowsers()
    assert.deepEqual(calls.slice(0, 3), ['capture', 'capture', 'marker'])
    assert.equal(bot.shuttingDown, true)
    assert.equal(bot.liveContexts.size, 0)
    assert.ok(loadSession(dir, 'fixture@example.test', false))
    assert.ok(loadSession(dir, 'fixture@example.test', true))
})

test('a failed browser capture cannot acknowledge a successful handoff', { skip: !ready }, async () => {
    const { MicrosoftRewardsBot } = require(entry.pathname)
    const bot = Object.create(MicrosoftRewardsBot.prototype)
    let acknowledged = false,
        closed = false
    bot.liveContexts = new Map()
    bot.config = { sessionPath: 'unused' }
    bot.logger = {
        info: () => {
            acknowledged = true
        }
    }
    const context = new EventEmitter()
    context.storageState = async () => {
        throw Error('mock browser disconnected')
    }
    context.close = async () => {
        closed = true
    }
    bot.trackBrowserContext(context, 'fixture@example.test', false)
    await assert.rejects(bot.checkpointAndCloseBrowsers(), /mock browser disconnected/)
    assert.equal(acknowledged, false)
    assert.equal(closed, false)
})

test(
    'dashboard Bing recovery preserves account/platform and refreshes cookies and Rewards actions',
    { skip: !ready },
    async () => {
        const { MicrosoftRewardsBot, executionContext } = require(entry.pathname)
        const bot = Object.create(MicrosoftRewardsBot.prototype)
        const calls = []
        const account = { email: 'fixture@example.test' }
        const page = { isClosed: () => false }
        bot.mainMobilePage = page
        bot.shuttingDown = false
        bot.logger = { warn: () => calls.push('warn') }
        bot.login = {
            verifyBingSession: async (actualPage, actualAccount) => {
                assert.equal(actualPage, page)
                assert.equal(actualAccount, account)
                calls.push('verify')
                return true
            }
        }
        bot.browser = {
            func: {
                checkpointActiveSession: async () => calls.push('cookies'),
                bootstrap: async actualPage => {
                    assert.equal(actualPage, page)
                    calls.push('actions')
                }
            }
        }
        assert.equal(
            await executionContext.run({ account, isMobile: true }, () => bot.recoverCurrentBingSession()),
            true
        )
        assert.deepEqual(calls, ['verify', 'cookies', 'actions', 'cookies'])
        bot.shuttingDown = true
        assert.equal(
            await executionContext.run({ account, isMobile: true }, () => bot.recoverCurrentBingSession()),
            false
        )
        assert.equal(calls.length, 4)
    }
)
