import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const { ConfigSchema, defaultConfig } = require('../../dist/contracts/BotConfig.js')
const { validateConfig } = require('../../dist/util/Validator.js')
const { SMART_WORKERS, loadExecutionPlan } = require('../../dist/interface/ExecutionPlan.js')
const { NormalSession } = require('../../dist/util/NormalSession.js')
const {
    filterCookiesForUrl,
    parseSetCookie,
    splitCombinedSetCookieHeader,
    buildCookieHeader,
    defaultCookiePath
} = require('../../dist/browser/clients/CookieJarSync.js')
const {
    findDashboardPromotion,
    dashboardPromotionActivityType,
    dashboardPromotionIsPromotional
} = require('../../dist/functions/activities/shared/StreakActivation.js')

test('BotConfig and Validator normalize continueOnBotWarning alias into contintueOnBotWarning', () => {
    const raw = structuredClone(defaultConfig)
    delete raw.contintueOnBotWarning
    raw.continueOnBotWarning = true

    const parsed = ConfigSchema.parse(raw)
    assert.equal(parsed.contintueOnBotWarning, true)

    const validated = validateConfig(raw)
    assert.equal(validated.contintueOnBotWarning, true)
})

test('CookieJarSync splits RFC Expires Set-Cookie headers, parses attributes, and filters by domain/path/secure', () => {
    const rawCombined =
        'MUID=abc123; Domain=.bing.com; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Secure, ' +
        'SRCHHPGUSR=SRCHLANG=en; Domain=www.bing.com; Path=/search; HttpOnly'
    const parts = splitCombinedSetCookieHeader(rawCombined)
    assert.equal(parts.length, 2)

    const c1 = parseSetCookie(parts[0], 'https://www.bing.com/rewards')
    const c2 = parseSetCookie(parts[1], 'https://www.bing.com/search?q=test')
    assert.equal(c1.remove, false)
    assert.equal(c1.cookie.name, 'MUID')
    assert.equal(c1.cookie.domain, '.bing.com')
    assert.equal(c1.cookie.secure, true)
    assert.equal(c2.cookie.name, 'SRCHHPGUSR')
    assert.equal(c2.cookie.path, '/search')
    assert.equal(c2.cookie.httpOnly, true)

    const matchedSearch = filterCookiesForUrl([c1.cookie, c2.cookie], 'https://www.bing.com/search?q=news')
    assert.equal(matchedSearch.length, 2)
    assert.equal(buildCookieHeader(matchedSearch), 'SRCHHPGUSR=SRCHLANG=en; MUID=abc123')

    const matchedHttp = filterCookiesForUrl([c1.cookie, c2.cookie], 'http://www.bing.com/search?q=news')
    assert.equal(matchedHttp.length, 1)
    assert.equal(matchedHttp[0].name, 'SRCHHPGUSR')

    assert.equal(defaultCookiePath('/rewards/panelflyout'), '/rewards')
    assert.equal(defaultCookiePath('/'), '/')
})

test('loadExecutionPlan parses valid smart execution plan and rejects unknown workers', () => {
    assert.ok(SMART_WORKERS.includes('dailySet'))
    const plan = loadExecutionPlan(
        JSON.stringify({
            version: 1,
            jobId: 'job-1',
            type: 'workers',
            workers: ['dailySet', 'readToEarn']
        })
    )
    assert.equal(plan.jobId, 'job-1')
    assert.deepEqual(plan.workers, ['dailySet', 'readToEarn'])

    assert.throws(
        () =>
            loadExecutionPlan(
                JSON.stringify({
                    version: 1,
                    jobId: 'job-bad',
                    type: 'workers',
                    workers: ['notARealWorker']
                })
            ),
        /worker/i
    )
})

test('NormalSession classifies task and app-oauth scopes without blocking session, and blocks on account scope', t => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msrw-norm-p5-'))
    const journalPath = path.join(tmpDir, 'queries.ndjson')
    fs.writeFileSync(journalPath, '', 'utf8')
    const prevJournal = process.env.MRS_NORMAL_QUERY_JOURNAL
    process.env.MRS_NORMAL_QUERY_JOURNAL = journalPath
    t.after(() => {
        if (prevJournal === undefined) delete process.env.MRS_NORMAL_QUERY_JOURNAL
        else process.env.MRS_NORMAL_QUERY_JOURNAL = prevJournal
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    const session = new NormalSession({
        version: 1,
        jobId: 'norm-1',
        type: 'accountSession',
        platform: 'desktop',
        environment: 'desktop',
        searchBudget: 3,
        workers: ['dailySet']
    })

    session.setFailureScope('task')
    session.observe('error', 'MORE-PROMOTIONS', 'Status 503 on optional promotion')
    assert.equal(session.blocked, false)

    session.recordScopedOutcome('app-oauth', 'app-transient')
    assert.equal(session.blocked, false)

    session.recordScopedOutcome('account', 'locked')
    assert.equal(session.blocked, true)
})

test('StreakActivation shared helpers locate promotions and extract numeric activityType and promotional state', () => {
    const dashboard = {
        dailySetPromotions: {
            '01/01/2026': [{ offerId: 'offer-ds', name: 'offer-ds', attributes: { activityType: '10' } }]
        },
        morePromotions: [
            {
                offerId: 'offer-vs',
                name: 'visual-search-offer',
                activityType: 51,
                isPromotional: 'True'
            }
        ],
        promotionalItems: []
    }
    const found = findDashboardPromotion(dashboard, 'offer-vs')
    assert.equal(found?.name, 'visual-search-offer')
    assert.equal(dashboardPromotionActivityType(found), 51)
    assert.equal(dashboardPromotionIsPromotional(found), true)
})
