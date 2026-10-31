import { chromium } from 'patchright'
import { manualDisplayArgs } from './browserDisplay.js'
import browserIdentity from '../../common/browserIdentity.cjs'
import preRewardsGuard from '../../common/preRewardsGuard.cjs'
import {
    getDirname,
    getProjectRoot,
    findUnknownOptions,
    log,
    parseArgs,
    resolveEmailArgument,
    loadConfig,
    loadAccountsFromEnv,
    findAccountByEmail,
    buildProxyConfig,
    getSessionDbPath,
    openSessionDb,
    loadSessionRow,
    loadResolvedRegionRow,
    closeSessionDb
} from '../utils.js'
import { persistBrowserSession } from './browserSessionPersistence.js'
import { captureBrowserSessionState } from './browserSessionState.js'
import {
    createSessionCheckpointer,
    MANUAL_SESSION_SAVED,
    MANUAL_SESSION_SAVE_FAILED
} from './browserSessionCheckpoint.js'

const REWARDS_URL = 'https://rewards.bing.com'

const BROWSER_ARGS = [
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-web-authentication-ui',
    '--disable-external-intent-requests',
    '--disable-features=WebAuthentication,PasswordManagerOnboarding,PasswordManager,EnablePasswordsAccountStorage,Passkeys,WebAuthenticationProxy,U2F',
    '--disable-save-password-bubble',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'
]

const __dirname = getDirname(import.meta.url)
const projectRoot = getProjectRoot(__dirname)

function printHelp() {
    console.log(`
Microsoft Rewards saved-session browser

Usage:
  npm run open-session -- <account-email> [--platform desktop|mobile]
  npm run open-session -- --email <account-email> [--platform desktop|mobile]

Options:
  --email       Optional named form of the account email.
  --platform    Open a specific session. Defaults to desktop, then mobile.
  --help        Show this help.

Examples:
  npm run open-session -- user@example.com
  npm run open-session -- user@example.com --platform mobile
  npm run open-session -- --email user@example.com --platform desktop

If no stored session exists, a fresh browser opens for manual sign-in. Cookies
and the configured fingerprint are checkpointed while the window is open and
again when it closes.
`)
}

function failUsage(message) {
    log('ERROR', message)
    printHelp()
    process.exit(1)
}

const args = parseArgs(process.argv.slice(2), { boolean: ['help', 'h'] })
if (args.help || args.h) {
    printHelp()
    process.exit(0)
}

const unknownOptions = findUnknownOptions(args, ['email', 'platform', 'help', 'h'])
if (unknownOptions.length) {
    failUsage(
        `Unknown option${unknownOptions.length === 1 ? '' : 's'}: ${unknownOptions.map(v => `--${v}`).join(', ')}`
    )
}

let accountEmail
try {
    accountEmail = resolveEmailArgument(args)
} catch (error) {
    failUsage(error?.message ?? String(error))
}

const { data: config } = loadConfig(projectRoot)

const accounts = loadAccountsFromEnv(projectRoot)
const account = findAccountByEmail(accounts, accountEmail)
if (!account) {
    log('WARN', `No ACCOUNT_N_* block found in .env for ${accountEmail} - opening without a proxy`)
}

function platformsToTry() {
    if (args.platform === undefined) return ['desktop', 'mobile']
    if (args.platform === true) failUsage('--platform requires either desktop or mobile after it.')

    const p = String(args.platform).trim().toLowerCase()
    if (p === 'mobile' || p === 'desktop') return [p]
    failUsage(`Invalid --platform value "${args.platform}"; expected desktop or mobile.`)
}

function resolveLocale(account, resolvedCountry) {
    const language = account?.langCode || 'en'
    const configuredCountry =
        account?.geoLocale && account.geoLocale.toLowerCase() !== 'auto' ? account.geoLocale : null
    const country = configuredCountry ?? resolvedCountry ?? null
    const locale = country
        ? new Intl.Locale(language, { region: country.toUpperCase() }).toString()
        : new Intl.Locale(language).toString()
    const baseLanguage = new Intl.Locale(locale).language.toLowerCase()
    const acceptedLocales = locale.toLowerCase() === baseLanguage ? [baseLanguage] : [locale, baseLanguage]
    const acceptLanguage = acceptedLocales
        .map((acceptedLocale, index) => (index === 0 ? acceptedLocale : `${acceptedLocale};q=${1 - index * 0.1}`))
        .join(',')
    return { locale, acceptedLocales, acceptLanguage }
}

function isSignedInRewardsPage(rawUrl) {
    try {
        const url = new URL(rawUrl)
        return (
            url.protocol === 'https:' &&
            url.hostname.toLowerCase() === 'rewards.bing.com' &&
            !url.pathname.toLowerCase().startsWith('/auth')
        )
    } catch {
        return false
    }
}

function assertVisibleBrowserAvailable() {
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
        throw new Error(
            'Cannot open a visible browser: DISPLAY or WAYLAND_DISPLAY is not set. Run the Control API from a graphical desktop session.'
        )
    }
}

async function configureMediaBlocking(context) {
    if (!config.experimental?.blockMedia) return

    await context.route('**/*', async route => {
        const resourceType = route.request().resourceType()
        if (resourceType === 'image' || resourceType === 'media') {
            await route.abort()
            return
        }

        await route.fallback()
    })

    log('INFO', 'Media loading disabled (image/media requests blocked; HTTP cache disabled by routing)')
}

async function main() {
    assertVisibleBrowserAvailable()

    const { dbPath, exists } = getSessionDbPath(projectRoot, config.sessionPath)
    const candidates = platformsToTry()
    let session = null
    let platform = null
    let resolvedCountry
    if (exists) {
        const db = openSessionDb(dbPath, { readonly: true })
        try {
            resolvedCountry = loadResolvedRegionRow(db, accountEmail)
            for (const p of candidates) {
                try {
                    const row = loadSessionRow(db, accountEmail, p)
                    if (row && (row.storageState || row.fingerprint)) {
                        session = row
                        platform = p
                        break
                    }
                } catch (error) {
                    if (!String(error?.message ?? error).includes('no such table: sessions')) {
                        log('WARN', `Could not read ${p} session: ${error.message}`)
                    }
                }
            }
        } finally {
            closeSessionDb(db)
        }
    }

    if (!session) {
        platform = candidates[0]
        session = { storageState: null, fingerprint: null, updatedAt: null }
        log('INFO', `No stored ${platform} session for ${accountEmail}; opening a fresh browser for manual sign-in`)
    }

    const isMobile = platform === 'mobile'
    if (account?.newAccountMode && process.env.MRS_PRE_REWARDS_GUARD !== '0') process.env.MRS_PRE_REWARDS_GUARD = '1'
    const savesFingerprint = account ? account.saveFingerprint[platform] : Boolean(session.fingerprint)
    const storageState = session.storageState
    const proxyLease = account ? await buildProxyConfig(account) : null
    const proxy = proxyLease?.proxy ?? null
    if (account?.proxy?.url && (!proxy || !proxy.server)) {
        log('ERROR', 'Account proxy is configured but invalid (needs proxy url + port)')
        process.exit(1)
    }

    const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0
    const sandboxArgs =
        process.platform === 'linux' && runningAsRoot ? ['--no-sandbox', '--disable-setuid-sandbox'] : []
    const ignoreCertificateErrors = Boolean(proxy && config.proxy?.ignoreCertificateErrors)
    const certArgs = ignoreCertificateErrors
        ? ['--ignore-certificate-errors', '--ignore-certificate-errors-spki-list', '--ignore-ssl-errors']
        : []
    const proxyPrivacyArgs = proxy ? ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] : []

    let browser
    try {
        browser = await chromium.launch({
            headless: false,
            ...(proxy ? { proxy } : {}),
            args: [...BROWSER_ARGS, ...sandboxArgs, ...certArgs, ...proxyPrivacyArgs, ...manualDisplayArgs()]
        })
    } catch (error) {
        await proxyLease?.close()
        throw error
    }
    browser.once('disconnected', () => void proxyLease?.close())
    log('SUCCESS', 'Browser process launched')
    const disconnected = new Promise(resolve => browser.once('disconnected', resolve))
    const locale = resolveLocale(account, resolvedCountry)
    const nativeIdentity = await browserIdentity.captureNativeBrowserIdentity(browser, locale)
    const prepared = isMobile
        ? browserIdentity.prepareMobileIdentity({
              storedIdentity: savesFingerprint ? session.fingerprint : null,
              nativeIdentity,
              browserVersion: browser.version(),
              accountKey: accountEmail,
              locale: locale.locale,
              acceptedLocales: locale.acceptedLocales,
              acceptLanguage: locale.acceptLanguage
          })
        : { identity: nativeIdentity, action: 'native', reason: 'runtime-probe', profileId: null }
    const fingerprint = prepared.identity
    const cookieCount = storageState?.cookies?.length ?? 0
    const userAgent = fingerprint.fingerprint.navigator.userAgent

    log('INFO', `Session: ${accountEmail} (${platform})`)
    log('INFO', `  Engine: bundled patched Chromium ${browser.version()}`)
    log('INFO', `  Cookies: ${cookieCount}`)
    log('INFO', `  Identity: ${fingerprint.browserIdentity.mode} | ${prepared.action}:${prepared.reason}`)
    if (prepared.profileId) log('INFO', `  Mobile profile: ${prepared.profileId}`)
    log('INFO', `  User-Agent: ${userAgent || 'Default'}`)
    log('INFO', `  Proxy: ${proxy ? 'Yes' : 'No'}`)
    log('INFO', `  Updated: ${session.updatedAt ? new Date(session.updatedAt).toISOString() : 'unknown'}`)
    log('INFO', `  Save on close: Yes${savesFingerprint ? ' (cookies + fingerprint)' : ' (cookies)'}`)

    const context = await browser.newContext({
        permissions: [],
        ...(process.env.MRS_PRE_REWARDS_GUARD === '1' ? { serviceWorkers: 'block' } : {}),
        ignoreHTTPSErrors: ignoreCertificateErrors,
        ...(storageState ? { storageState } : {}),
        ...browserIdentity.contextOptions(fingerprint, locale.locale)
    })
    if (process.env.MRS_PRE_REWARDS_GUARD === '1') await preRewardsGuard.installPreRewardsGuard(context)
    browserIdentity.registerContextIdentity(context, fingerprint, error => {
        log('WARN', `Could not apply browser identity to a new page: ${error?.message ?? error}`)
    })

    await configureMediaBlocking(context)

    const page = await browserIdentity.newIdentityPage(context)
    await page
        .goto(process.env.MRS_PRE_REWARDS_GUARD === '1' ? 'https://www.bing.com/' : storageState ? REWARDS_URL : `${REWARDS_URL}/auth/login`, { waitUntil: 'domcontentloaded' })
        .catch(error => log('WARN', `Initial Rewards navigation did not finish cleanly: ${error.message}`))

    log('SUCCESS', storageState ? 'Browser opened with session loaded' : 'Browser opened for manual sign-in')
    log('INFO', 'Use the browser normally. Closing the window saves the latest session.')

    let latestState = storageState ?? { cookies: [], origins: [] }
    let lastSavedState =
        storageState && (!prepared || prepared.action === 'reuse') ? JSON.stringify(storageState) : null
    let loginConfirmed = isSignedInRewardsPage(page.url())
    let loginConfirmationLogged = loginConfirmed
    const checkpoint = createSessionCheckpointer(async (reason, { allowUnconfirmed = false } = {}) => {
        try {
            if (!loginConfirmed && process.env.MRS_PRE_REWARDS_GUARD === '1')
                loginConfirmed = (await context.cookies('https://www.bing.com/')).some(cookie => cookie.name === '_U' && cookie.value)
            if (!loginConfirmed && !allowUnconfirmed) return false
            const current = await captureBrowserSessionState(context, latestState)
            if (!current.cookies.length) {
                if (allowUnconfirmed) throw new Error('No cookies are available to save')
                return false
            }
            latestState = current
            const serialized = JSON.stringify(current)
            if (serialized === lastSavedState && !allowUnconfirmed) return false
            persistBrowserSession(dbPath, accountEmail, platform, current, fingerprint, savesFingerprint)
            lastSavedState = serialized
            log(
                'SUCCESS',
                `Saved ${platform} session (${reason}) | cookies=${current.cookies.length} | origins=${current.origins.length}`
            )
            return true
        } catch (error) {
            if (allowUnconfirmed) throw error
            if (browser.isConnected()) log('WARN', `Could not checkpoint session: ${error.message}`)
            return false
        }
    })

    const checkpointTimer = setInterval(() => void checkpoint('periodic checkpoint'), 5000)
    checkpointTimer.unref?.()
    let navigationTimer = null
    page.on('framenavigated', frame => {
        if (frame !== page.mainFrame()) return
        if (!loginConfirmed && isSignedInRewardsPage(frame.url())) {
            loginConfirmed = true
            if (!loginConfirmationLogged) {
                loginConfirmationLogged = true
                log('SUCCESS', 'Microsoft Rewards sign-in detected; session persistence is now active')
            }
        }
        clearTimeout(navigationTimer)
        navigationTimer = setTimeout(() => void checkpoint('navigation'), 1000)
        navigationTimer.unref?.()
    })
    page.once('close', () => {
        void checkpoint('window close').finally(() => {
            if (browser.isConnected()) void browser.close()
        })
    })

    let stopping = false
    const stop = async (signal, { saveUnconfirmed = false } = {}) => {
        if (stopping) return
        stopping = true
        log('INFO', `${signal} received; saving and closing the manual session`)
        try {
            await checkpoint(signal === 'GUI close' ? 'GUI close' : 'shutdown', {
                allowUnconfirmed: saveUnconfirmed
            })
            if (saveUnconfirmed) log('SUCCESS', MANUAL_SESSION_SAVED)
            await browser.close().catch(() => {})
        } catch {
            stopping = false
            log('ERROR', MANUAL_SESSION_SAVE_FAILED)
        }
    }
    const onSigInt = () => void stop('SIGINT')
    const onSigTerm = () => void stop('SIGTERM')
    const onGuiClose = () => void stop('GUI close', { saveUnconfirmed: true })
    process.once('SIGINT', onSigInt)
    process.once('SIGTERM', onSigTerm)
    process.on('SIGUSR2', onGuiClose)
    log('SUCCESS', 'Manual browser ready')

    try {
        await disconnected
    } finally {
        clearInterval(checkpointTimer)
        clearTimeout(navigationTimer)
        process.removeListener('SIGINT', onSigInt)
        process.removeListener('SIGTERM', onSigTerm)
        process.removeListener('SIGUSR2', onGuiClose)
        if (browser.isConnected()) {
            await checkpoint('final checkpoint')
            await browser.close().catch(() => {})
        }
        await proxyLease?.close()
    }
}

main().catch(error => {
    log('ERROR', 'browserSession failed:', error?.message ?? error)
    process.exit(1)
})
