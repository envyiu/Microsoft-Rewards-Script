import rebrowser, { BrowserContext } from 'patchright'
import { existsSync } from 'node:fs'

import { createBrowserProxyConfig } from '../../common/proxyRelay.cjs'
import { installPreRewardsGuard } from '../../common/preRewardsGuard.cjs'
import type { MicrosoftRewardsBot } from '../index'
import type { BrowserIdentitySnapshot } from '../interface/BrowserIdentity'
import { loadSession, saveFingerprint } from '../util/SessionStore'
import { UserAgentManager } from './UserAgent'
import { observeContextClosure } from './BrowserLifecycle'

import type { Account } from '../interface/Account'

/* Test Stuff
https://abrahamjuliot.github.io/creepjs/
https://botcheck.luminati.io/
https://fv.pro/
https://pixelscan.net/
https://www.browserscan.net/
*/

interface BrowserCreationResult {
    context: BrowserContext
    fingerprint: BrowserIdentitySnapshot
}

function isDisplayStartupError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return /missing x server|\$display|platform failed to initialize|ozone platform/i.test(message)
}

interface HeadedLaunchEnvironment {
    args: string[]
    env?: NodeJS.ProcessEnv
    display: string
}

function headedLaunchEnvironment(headless: boolean): HeadedLaunchEnvironment {
    if (headless) return { args: [], display: 'not-required' }

    const display = process.env.DISPLAY
    const waylandDisplay = process.env.WAYLAND_DISPLAY
    if (display || waylandDisplay) {
        return { args: [], display: display ?? `wayland:${waylandDisplay}` }
    }

    // Background jobs often lose the graphical-session environment. On this
    // Linux host, Xwayland exposes the active session at :0; using it lets a
    // headed run still show Chromium instead of silently switching headless.
    if (process.platform === 'linux' && existsSync('/tmp/.X11-unix/X0')) {
        const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: ':0' }
        delete env.WAYLAND_DISPLAY
        return { args: ['--ozone-platform=x11'], env, display: ':0 (auto-detected X11)' }
    }

    return { args: [], display: 'unavailable' }
}

class Browser {
    private readonly bot: MicrosoftRewardsBot
    private readonly userAgentManager: UserAgentManager
    private browserVersion?: string
    private nativeIdentity?: BrowserIdentitySnapshot
    private static readonly BROWSER_ARGS = [
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
        '--disable-renderer-backgrounding',
        // This network resolves login.microsoftonline.com to the same Microsoft
        // front door as login.windows.net; without it Chromium leaves OAuth
        // redirects at about:blank while normal HTTPS requests still work.
        '--host-resolver-rules=MAP login.microsoftonline.com login.windows.net'
    ] as const

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
        this.userAgentManager = new UserAgentManager()
    }

    async createBrowser(account: Account): Promise<BrowserCreationResult> {
        const headless = this.bot.config.headless
        const preRewards = this.bot.executionPlan?.type === 'warmup' || process.env.MRS_PRE_REWARDS_GUARD === '1'

        const hasProxy = Boolean(account.proxy.url)
        const ignoreCertificateErrors = hasProxy && this.bot.config.proxy.ignoreCertificateErrors

        let browser: rebrowser.Browser
        let proxyLease: Awaited<ReturnType<typeof createBrowserProxyConfig>> | undefined
        let proxyLeaseClosed = false
        const closeProxyLease = async (): Promise<void> => {
            if (proxyLeaseClosed || !proxyLease) return
            proxyLeaseClosed = true
            await proxyLease.close().catch(() => {})
        }

        try {
            proxyLease = await createBrowserProxyConfig(account.proxy)
            const proxyConfig = proxyLease.proxy

            const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0
            const sandboxDisabled = process.platform === 'linux' && runningAsRoot
            const sandboxArgs = sandboxDisabled ? ['--no-sandbox', '--disable-setuid-sandbox'] : []

            const certArgs = ignoreCertificateErrors
                ? ['--ignore-certificate-errors', '--ignore-certificate-errors-spki-list', '--ignore-ssl-errors']
                : []
            const proxyPrivacyArgs = hasProxy ? ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] : []
            const headedEnvironment = headedLaunchEnvironment(headless)

            if (ignoreCertificateErrors) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'BROWSER-SECURITY',
                    'TLS certificate verification is disabled by proxy.ignoreCertificateErrors'
                )
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'BROWSER',
                `Launching bundled patched Chromium | headless=${headless} | display=${headedEnvironment.display} | platform=${process.platform} | proxy=${hasProxy ? 'yes' : 'no'} | tls=${ignoreCertificateErrors ? 'verification-disabled' : 'verified'} | sandbox=${sandboxDisabled ? 'disabled-root' : 'enabled'}`
            )

            const launchBrowser = (launchHeadless: boolean) =>
                rebrowser.chromium.launch({
                    headless: launchHeadless,
                    ...(proxyConfig && { proxy: proxyConfig }),
                    ...(headedEnvironment.env && { env: headedEnvironment.env }),
                    args: [
                        ...Browser.BROWSER_ARGS,
                        ...sandboxArgs,
                        ...certArgs,
                        ...proxyPrivacyArgs,
                        ...headedEnvironment.args
                    ]
                })

            try {
                browser = await launchBrowser(headless)
            } catch (error) {
                if (!headless && isDisplayStartupError(error)) {
                    throw new Error(
                        `Headless mode is disabled, but Chromium could not connect to the display server (DISPLAY=${process.env.DISPLAY ?? 'unset'}, WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY ?? 'unset'}). Start the graphical session or run the command with xvfb-run.`,
                        { cause: error }
                    )
                }
                throw error
            }
            this.browserVersion = browser.version()
        } catch (error) {
            await closeProxyLease()
            const errorMessage = error instanceof Error ? error.message : String(error)
            this.bot.logger.error(this.bot.isMobile, 'BROWSER', `Browser launch failed: ${errorMessage}`)
            throw error
        }

        try {
            this.nativeIdentity = await this.userAgentManager.captureNativeIdentity(
                browser as unknown as rebrowser.Browser,
                this.bot.accountLocale,
                () =>
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'BROWSER-IDENTITY',
                        'Local identity probe returned non-JSON content; recovered directly from Chromium'
                    )
            )
            const session = loadSession(this.bot.config.sessionPath, account.email, this.bot.isMobile)

            if (session?.storageState) {
                const ageMinutes = Math.max(0, Math.floor((Date.now() - session.updatedAt) / 60000))
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SESSION',
                    `Restoring saved browser session | cookies=${session.storageState.cookies.length} | origins=${session.storageState.origins.length} | ageMinutes=${ageMinutes}` +
                        (session.expiredCookiesRemoved
                            ? ` | expiredCookiesRemoved=${session.expiredCookiesRemoved}`
                            : '')
                )
            } else {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SESSION',
                    'No saved browser session found; login may be required'
                )
            }

            const shouldUseFingerprint = this.bot.isMobile
                ? account.saveFingerprint.mobile
                : account.saveFingerprint.desktop

            const prepared = this.userAgentManager.prepareIdentity({
                savedIdentity: shouldUseFingerprint ? session?.fingerprint : null,
                nativeIdentity: this.nativeIdentity,
                browserVersion: this.browserVersion,
                isMobile: this.bot.isMobile,
                accountKey: account.email,
                locale: this.bot.accountLocale
            })
            const fingerprint = prepared.identity

            if (prepared.action !== 'reuse' || !this.bot.isMobile) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'BROWSER-FINGERPRINT',
                    `Prepared Chromium identity | mode=${fingerprint.browserIdentity.mode} | action=${prepared.action} | reason=${prepared.reason}` +
                        (prepared.profileId ? ` | profile=${prepared.profileId}` : '')
                )
            }

            const context = await browser.newContext({
                permissions: [],
                ...(preRewards ? { serviceWorkers: 'block' as const } : {}),
                ignoreHTTPSErrors: ignoreCertificateErrors,
                ...(session?.storageState ? { storageState: session.storageState } : {}),
                ...this.userAgentManager.contextOptions(fingerprint, this.bot.accountLocale)
            })
            if (preRewards) await installPreRewardsGuard(context, { onBlocked: location => this.bot.logger.info(this.bot.isMobile, 'PRE-REWARDS-BLOCKED', location) })
            this.bot.trackBrowserContext(context, account.email, this.bot.isMobile)
            context.once('close', () => void closeProxyLease())
            browser.once('disconnected', () => void closeProxyLease())
            this.userAgentManager.registerContext(context, fingerprint, error =>
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'BROWSER-IDENTITY',
                    `Could not apply identity to a new page: ${error instanceof Error ? error.message : String(error)}`
                )
            )

            context.on('page', p => {
                p.on('crash', () =>
                    this.bot.logger.error(this.bot.isMobile, 'BROWSER', `Renderer crashed | ${p.url()}`)
                )
            })
            observeContextClosure(context, this.bot.logger, this.bot.isMobile)

            context.setDefaultTimeout(this.bot.utils.stringToNumber(this.bot.config?.globalTimeout ?? 30000))

            if (shouldUseFingerprint && (prepared.action !== 'reuse' || !this.bot.isMobile)) {
                saveFingerprint(this.bot.config.sessionPath, account.email, this.bot.isMobile, fingerprint)
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'BROWSER',
                `Created context | locale=${this.bot.accountLocale.locale} | Accept-Language="${this.bot.accountLocale.acceptLanguage}" | User-Agent: "${fingerprint.fingerprint.navigator.userAgent}"`
            )
            return { context, fingerprint }
        } catch (error) {
            await browser.close().catch(() => {})
            await closeProxyLease()
            throw error
        }
    }

    async generateFingerprint(isMobile: boolean): Promise<BrowserIdentitySnapshot> {
        if (!this.browserVersion || !this.nativeIdentity) {
            throw new Error(
                'Native Chromium identity is unavailable; create a browser context before requesting identity'
            )
        }
        return this.userAgentManager.prepareIdentity({
            nativeIdentity: this.nativeIdentity,
            browserVersion: this.browserVersion,
            isMobile,
            accountKey: this.bot.currentAccountEmail ?? 'unknown-account',
            locale: this.bot.accountLocale
        }).identity
    }

    newPage(context: BrowserContext) {
        return this.userAgentManager.newPage(context)
    }
}

export default Browser
