import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { markContextClosing, observeContextClosure } = require('../../dist/browser/BrowserLifecycle.js')
const { default: BrowserFunc } = require('../../dist/browser/BrowserFunc.js')
const { chromium } = require('patchright')

function loggingFixture() {
    const logs = []
    const logger = Object.fromEntries(
        ['debug', 'warn', 'info', 'error'].map(level => [
            level,
            (platform, title, message) => logs.push({ level, platform, title, message })
        ])
    )
    return { logs, logger }
}

test('planned cleanup is debug-only and preserves the context platform', () => {
    const context = new EventEmitter()
    const { logger, logs } = loggingFixture()
    observeContextClosure(context, logger, true)
    markContextClosing(context)
    context.emit('close')
    context.emit('close')
    assert.deepEqual(logs, [
        { level: 'debug', platform: true, title: 'BROWSER', message: 'Browser context closed during cleanup' }
    ])
})

test('unexpected closure warns and subsequent cleanup cannot hide the original event', () => {
    const context = new EventEmitter()
    const { logger, logs } = loggingFixture()
    observeContextClosure(context, logger, false)
    context.emit('close')
    markContextClosing(context)
    assert.deepEqual(logs, [
        { level: 'warn', platform: false, title: 'BROWSER', message: 'Browser context closed unexpectedly' }
    ])
})

test('real browser cleanup emits no misleading warning while direct context closure still warns', async t => {
    const { logger, logs } = loggingFixture()
    const browser = await chromium.launch({ headless: true })
    t.after(() => browser.close())
    const context = await browser.newContext()
    await context.newPage()
    observeContextClosure(context, logger, true)
    await new BrowserFunc({ logger, isMobile: true }).closeBrowser(context, 'fixture@example.test', false)
    assert.equal(logs.filter(log => log.level === 'warn').length, 0)
    assert.ok(logs.some(log => log.message === 'All browser resources closed.'))
    const otherBrowser = await chromium.launch({ headless: true })
    t.after(() => otherBrowser.close())
    const other = await otherBrowser.newContext()
    observeContextClosure(other, logger, false)
    await other.close()
    assert.equal(logs.filter(log => log.message === 'Browser context closed unexpectedly').length, 1)
})
