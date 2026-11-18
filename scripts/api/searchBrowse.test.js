import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import http from 'node:http'
const require = createRequire(import.meta.url)
const { chromium } = require('patchright')
const { Search } = require('../../dist/functions/activities/search/BrowserSearch.js')
const BrowserUtils = require('../../dist/browser/BrowserUtils.js').default

test('result browsing uses a separate tab and preserves the search page on desktop and mobile', async t => {
    let visits = 0
    const server = http.createServer((req, res) => {
        visits++
        res.end('<html><body style="height:2500px">Fixture</body></html>')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
    t.after(() => browser.close())
    for (const mobile of [false, true]) {
        const context = await browser.newContext({
            viewport: { width: 800, height: 700 },
            isMobile: mobile,
            hasTouch: mobile
        })
        const page = await context.newPage()
        const url = `http://127.0.0.1:${server.address().port}/article`
        await page.setContent(
            `<div id="b_results"><div class="b_algo"><h2><a href="${url}">Result</a></h2></div></div><div style="height:2000px"></div>`
        )
        const bot = {
            isMobile: mobile,
            config: { searchSettings: { scrollRandomResults: true, clickRandomResults: true } },
            utils: { randomDelay: () => 1, wait: async () => {} },
            logger: { warn: () => {}, debug: () => {} }
        }
        bot.browser = { utils: new BrowserUtils(bot) }
        const search = new Search(bot)
        const original = page.url()
        await search.browseResults(page, mobile)
        assert.equal(page.url(), original)
        assert.equal(context.pages().length, 1)
        await context.close()
    }
    assert.equal(visits, 2)
})
