import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const dist = process.env.MRS_TEST_DIST || path.resolve('dist')
const BrowserFunc = require(path.join(dist, 'browser/BrowserFunc.js')).default
const { FlyoutAccountDataError } = require(path.join(dist, 'browser/FlyoutDashboard.js'))

function fixture({ recovered = true, invalidBalance = false } = {}) {
    let recoveries = 0
    const messages = []
    const bot = {
        currentAccountEmail: 'fixture@example.test',
        isMobile: true,
        fingerprint: { headers: {} },
        cookies: { mobile: [], desktop: [] },
        mainMobilePage: { isClosed: () => false },
        logger: Object.fromEntries(
            ['debug', 'info', 'warn', 'error'].map(level => [
                level,
                (_mobile, title, message) => messages.push({ level, title, message })
            ])
        ),
        recoverCurrentBingSession: async () => {
            recoveries++
            return recovered
        },
        browser: { react: { searchCountersFromEarnPage: () => ({ pc: { progress: 0, max: 30 }, mobile: null }) } },
        http: {
            request: async ({ url }) => {
                let data = '<html>legacy endpoint</html>'
                if (url.includes('panelflyout'))
                    data =
                        (recoveries && recovered) || invalidBalance
                            ? {
                                  userInfo: { isRewardsUser: true, profile: { attributes: {} } },
                                  flyoutResult: {
                                      userStatus: { isRewardsUser: true, availablePoints: invalidBalance ? null : 115 }
                                  }
                              }
                            : { userInfo: { isRewardsUser: false } }
                return { status: 200, headers: {}, data }
            }
        }
    }
    return { bot, messages, recoveries: () => recoveries }
}

test('missing Bing data repairs the existing session once and returns only verified balance/quota', async () => {
    const { bot, messages, recoveries } = fixture()
    const func = new BrowserFunc(bot)
    const data = await func.getDashboardData()
    assert.equal(data.dashboard.userStatus.availablePoints, 115)
    assert.equal(func.balanceReliability.value, 115)
    assert.equal(func.quotaReliability.freshness, 'fresh')
    assert.equal(recoveries(), 1)
    assert.ok(messages.some(m => m.message === 'Rewards data recovered after Bing session verification'))
})

test('failed Bing verification stays unavailable and cannot repeat recovery for the same account/platform', async () => {
    const { bot, recoveries } = fixture({ recovered: false })
    const func = new BrowserFunc(bot)
    await assert.rejects(func.getDashboardData(), FlyoutAccountDataError)
    await assert.rejects(func.getDashboardData(), FlyoutAccountDataError)
    assert.equal(recoveries(), 1)
    assert.equal(func.balanceReliability.value, null)
})

test('a malformed balance is not repaired by signing in and never becomes zero', async () => {
    const { bot, recoveries } = fixture({ invalidBalance: true })
    const func = new BrowserFunc(bot)
    await assert.rejects(func.getDashboardData(), /valid available-points balance/)
    assert.equal(recoveries(), 0)
    assert.equal(func.balanceReliability.value, null)
})

test('an explicitly supplied cookie jar cannot be silently replaced by another browser session', async () => {
    const { bot, recoveries } = fixture()
    await assert.rejects(new BrowserFunc(bot).getDashboardData([]), FlyoutAccountDataError)
    assert.equal(recoveries(), 0)
})
