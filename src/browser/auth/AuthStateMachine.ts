import type { Page } from 'patchright'
import { REWARDS_BASE_URL, URLs } from '../../constants/urls'
import type { Account } from '../../interface/Account'
import { unknownPageDiagnostic } from '../../util/ErrorDiagnostic'
import { advanceMicrosoftWelcome } from '../MicrosoftWelcome'
import type { Login } from './Login'
import { emitRuntimeEvent } from '../../util/RuntimeEvents'
import { normalizeSignInText, type LoginState } from './LoginSelectors'
import { matchesMaskedEmailHint } from './methods/FviaInboxesMail'
import { getSubtitleMessage } from './methods/LoginUtils'
import {
    handleAutoRecoveryEmail,
    handleEmailVerificationAlternatives,
    handleOtpCodeEntry,
    handleSignInMethodPicker,
    handleTotp2Fa,
    trySwitchPasswordToEmailCode
} from './Totp2FaHandler'

export async function detectCurrentState(host: Login, page: Page): Promise<LoginState> {
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {})

    const url = new URL(page.url())
    const hostname = url.hostname.toLowerCase()
    if (!host.rewardsLogin && host.serviceHosts.includes(hostname)) {
        const guest = page
            .getByRole('button', { name: /^sign in$/i })
            .or(page.getByRole('link', { name: /^sign in$/i }))
            .first()
        const credentials = page.locator('input[type="password"], input#usernameEntry').first()
        const text = await page
            .locator('body')
            .innerText({ timeout: 1000 })
            .catch(() => '')
        if (
            text.trim().length > 20 &&
            !/^loading[.\s…]*$/i.test(text.trim()) &&
            !(await guest.isVisible().catch(() => false)) &&
            !(await credentials.isVisible().catch(() => false)) &&
            (await page.context().cookies(URLs.bing.origin)).some(c => c.name === '_U' && c.value)
        ) {
            return 'LOGGED_IN'
        }
    }
    if (!host.rewardsLogin && (hostname === 'bing.com' || hostname === 'www.bing.com')) {
        const cookies = await page.context().cookies(URLs.bing.origin)
        if (cookies.some(c => c.name === '_U' && c.value)) return 'LOGGED_IN'
    }
    host.bot.logger.debug(host.bot.isMobile, 'DETECT-STATE', `Current URL: ${hostname}${url.pathname}`)

    if (hostname === 'chromewebdata') {
        host.bot.logger.warn(host.bot.isMobile, 'DETECT-STATE', 'Detected chromewebdata error page')
        return 'CHROMEWEBDATA_ERROR'
    }

    const isLocked = await host.checkSelector(page, host.selectors.accountLocked)
    if (isLocked) {
        host.bot.logger.debug(host.bot.isMobile, 'DETECT-STATE', 'Account locked selector found')
        return 'ACCOUNT_LOCKED'
    }

    const isRewardsAuthRoute = hostname === 'rewards.bing.com' && /^\/auth(?:\/|$)/i.test(url.pathname)
    if (
        !isRewardsAuthRoute &&
        (hostname === 'bing.com' || hostname.endsWith('.bing.com') || hostname === 'account.microsoft.com')
    ) {
        const [profileVisible, accountProfileVisible, sessionCookies] = await Promise.all([
            host.checkSelector(page, host.selectors.bingProfile),
            host.checkSelector(page, host.selectors.microsoftAccountProfile),
            page
                .context()
                .cookies([page.url()])
                .then(cookies => cookies.some(cookie => ['_U', 'RPSSecAuth'].includes(cookie.name) && cookie.value))
                .catch(() => false)
        ])
        const rewardsEvidence =
            hostname === 'rewards.bing.com' &&
            (await page
                .locator('body')
                .innerText({ timeout: 1000 })
                .then(text => /microsoft rewards|rewards points/i.test(text))
                .catch(() => false))
        if (profileVisible || accountProfileVisible || (sessionCookies && rewardsEvidence)) {
            host.bot.logger.debug(host.bot.isMobile, 'DETECT-STATE', 'Authenticated session evidence found')
            return 'LOGGED_IN'
        }
        if (hostname === 'rewards.bing.com' && (await host.hasAuthenticatedRewardsPayload(page))) {
            return 'LOGGED_IN'
        }
        host.bot.logger.debug(
            host.bot.isMobile,
            'DETECT-STATE',
            'Microsoft/Bing route found without authenticated session evidence'
        )
    }

    const stateChecks: Array<[string, LoginState]> = [
        [host.selectors.errorAlert, 'ERROR_ALERT'],
        [host.selectors.passwordEntry, 'PASSWORD_INPUT'],
        [host.selectors.emailEntry, 'EMAIL_INPUT'],
        [host.selectors.recoveryEmail, 'RECOVERY_EMAIL_INPUT'],
        [host.selectors.emailVerificationInput, 'EMAIL_VERIFICATION_INPUT'],
        [host.selectors.kmsiVideo, 'KMSI_PROMPT'],
        [host.selectors.passKeyVideo, 'PASSKEY_VIDEO'],
        [host.selectors.passKeyError, 'PASSKEY_ERROR'],
        [host.selectors.signInTile, 'SIGN_IN_METHOD_PICKER'],
        [host.selectors.passwordlessOptionOld, 'SIGN_IN_METHOD_PICKER'],
        [host.selectors.emailIconOld, 'SIGN_IN_METHOD_PICKER'],
        [host.selectors.passwordlessCheck, 'LOGIN_PASSWORDLESS'],
        [host.selectors.passwordlessNumber, 'LOGIN_PASSWORDLESS'],
        [host.selectors.totpInput, '2FA_TOTP'],
        [host.selectors.totpInputOld, '2FA_TOTP'],
        [host.selectors.otpCodeEntry, 'OTP_CODE_ENTRY'],
        [host.selectors.otpInput, 'OTP_CODE_ENTRY']
    ]

    const [results, identityBanner, primaryButton, passwordEntry, footerAction, footerActionText] = await Promise.all([
        Promise.all(
            stateChecks.map(async ([sel, state]) => {
                const visible = await host.checkSelector(page, sel)
                return visible ? state : null
            })
        ),
        host.checkSelector(page, host.selectors.identityBanner),
        host.checkSelector(page, host.selectors.primaryButton),
        host.checkSelector(page, host.selectors.passwordEntry),
        host.checkSelector(page, host.selectors.footerAction),
        page
            .locator(host.selectors.footerAction)
            .first()
            .innerText({ timeout: 200 })
            .catch(() => '')
    ])

    const visibleStates = results.filter((s): s is LoginState => s !== null)
    if (visibleStates.length > 0) {
        host.bot.logger.debug(host.bot.isMobile, 'DETECT-STATE', `Visible states: [${visibleStates.join(', ')}]`)
    }

    if (
        identityBanner &&
        primaryButton &&
        !passwordEntry &&
        !results.includes('2FA_TOTP') &&
        !results.includes('RECOVERY_EMAIL_INPUT') &&
        !results.includes('EMAIL_VERIFICATION_INPUT')
    ) {
        const normalizedFooterAction = normalizeSignInText(footerActionText)
        const footerTargetsSpecificProof =
            /[\w.+*-]+@[\w.*-]+\.[a-z]{2,}/i.test(normalizedFooterAction) ||
            /(?:\+?\d|[*xX])(?:[\d\s().*xX-]{4,})(?:\d|[*xX])/.test(normalizedFooterAction)

        let preferPrimarySendCode = false
        if (host.preferEmailCodeOverPassword && host.canAutoHandleEmailCode()) {
            const [primaryButtonText, subtitle] = await Promise.all([
                page
                    .locator(host.selectors.primaryButton)
                    .first()
                    .innerText({ timeout: 200 })
                    .catch(() => ''),
                getSubtitleMessage(page).catch(() => null)
            ])
            const normalizedPrimary = normalizeSignInText(primaryButtonText)
            if (
                /(?:send\s*(?:a\s*)?code|get\s*(?:a\s*)?code|gửi\s*mã|nhận\s*mã)/i.test(normalizedPrimary) &&
                matchesMaskedEmailHint(host.currentRecoveryEmail, subtitle)
            ) {
                preferPrimarySendCode = true
            }
        }

        if (preferPrimarySendCode) {
            host.bot.logger.debug(
                host.bot.isMobile,
                'DETECT-STATE',
                'Preferring primary send-code action over footer alternative for fviainboxes recovery email'
            )
            results.push('PASSWORDLESS_SEND_CODE')
        } else if (footerAction && !footerTargetsSpecificProof && !host.passwordlessMethodSelected) {
            host.bot.logger.debug(host.bot.isMobile, 'DETECT-STATE', 'Alternative sign-in methods are available')
            results.push('FOOTER_ACTION')
        } else {
            if (footerAction && footerTargetsSpecificProof) {
                host.bot.logger.debug(
                    host.bot.isMobile,
                    'DETECT-STATE',
                    'Footer targets a specific verification proof; keeping the primary sign-in method'
                )
            }
            host.bot.logger.debug(host.bot.isMobile, 'DETECT-STATE', 'Primary passwordless action detected')
            results.push('PASSWORDLESS_SEND_CODE')
        }
    }

    let foundStates = results.filter((s): s is LoginState => s !== null)

    if (foundStates.length === 0) {
        host.bot.logger.debug(host.bot.isMobile, 'DETECT-STATE', 'No matching states found')
        return 'UNKNOWN'
    }

    if (foundStates.includes('ERROR_ALERT')) {
        const errorIsReal = hostname === 'login.live.com' && !foundStates.includes('2FA_TOTP')
        host.bot.logger.debug(
            host.bot.isMobile,
            'DETECT-STATE',
            `ERROR_ALERT found - hostname: ${hostname}, has 2FA: ${foundStates.includes('2FA_TOTP')}, treating as real: ${errorIsReal}`
        )
        if (errorIsReal) return 'ERROR_ALERT'
        foundStates = foundStates.filter(s => s !== 'ERROR_ALERT')
    }

    const priorities: LoginState[] = [
        'ACCOUNT_LOCKED',
        'PASSKEY_VIDEO',
        'PASSKEY_ERROR',
        'KMSI_PROMPT',
        'LOGIN_PASSWORDLESS',
        'PASSWORD_INPUT',
        'EMAIL_INPUT',
        'EMAIL_VERIFICATION_INPUT',
        'RECOVERY_EMAIL_INPUT',
        'SIGN_IN_METHOD_PICKER',
        'OTP_CODE_ENTRY',
        'FOOTER_ACTION',
        'PASSWORDLESS_SEND_CODE',
        '2FA_TOTP'
    ]

    for (const priority of priorities) {
        if (foundStates.includes(priority)) {
            host.bot.logger.debug(host.bot.isMobile, 'DETECT-STATE', `Selected state by priority: ${priority}`)
            return priority
        }
    }

    const fallbackState = foundStates[0] ?? 'UNKNOWN'
    host.bot.logger.debug(host.bot.isMobile, 'DETECT-STATE', `Returning fallback state: ${fallbackState}`)
    return fallbackState
}

export function isEmptyLoginPostbackAlert(page: Page, errorMsg: string): boolean {
    const url = new URL(page.url())
    const isPostback = url.hostname.toLowerCase() === 'login.live.com' && /^\/ppsecure\/post\.srf$/i.test(url.pathname)
    const normalized = errorMsg.trim()
    return isPostback && (!normalized || /^unknown error$/i.test(normalized))
}

export async function recoverFromLoginPostback(host: Login, page: Page): Promise<void> {
    await page
        .goto(host.rewardsLogin ? URLs.rewards.earn : URLs.bing.origin, {
            waitUntil: 'domcontentloaded',
            timeout: 15000
        })
        .catch(error => {
            host.bot.logger.debug(
                host.bot.isMobile,
                'LOGIN',
                `Rewards navigation after login postback did not finish cleanly: ${error instanceof Error ? error.message : String(error)}`
            )
        })
    await host.bot.utils?.wait?.(1000)
}

export async function handleLoginState(host: Login, state: LoginState, page: Page, account: Account): Promise<boolean> {
    host.bot.logger.debug(host.bot.isMobile, 'HANDLE-STATE', `Processing state: ${state}`)
    if (
        [
            'RECOVERY_EMAIL_INPUT',
            'EMAIL_VERIFICATION_INPUT',
            '2FA_TOTP',
            'LOGIN_PASSWORDLESS',
            'OTP_CODE_ENTRY'
        ].includes(state)
    ) {
        emitRuntimeEvent('authPhase', { phase: 'verification', state })
    }

    switch (state) {
        case 'ACCOUNT_LOCKED': {
            const msg = 'This account has been locked! Remove from config and restart!'
            host.bot.logger.error(host.bot.isMobile, 'LOGIN', msg)
            throw new Error(msg)
        }

        case 'ERROR_ALERT': {
            const alertEl = page.locator(host.selectors.errorAlert)
            const errorMsg = await alertEl.innerText().catch(() => 'Unknown Error')

            if (isEmptyLoginPostbackAlert(page, errorMsg)) {
                host.bot.logger.warn(
                    host.bot.isMobile,
                    'LOGIN',
                    'Empty Microsoft login postback alert; verifying the Rewards session before failing'
                )
                await recoverFromLoginPostback(host, page)
                return true
            }

            host.bot.logger.error(host.bot.isMobile, 'LOGIN', `Account error: ${errorMsg}`)
            throw new Error(`Microsoft login error: ${errorMsg}`)
        }

        case 'LOGGED_IN':
            return true

        case 'EMAIL_INPUT': {
            host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Entering email')
            if (host.canAutoHandleEmailCode()) {
                await host.prepareEmailCodeRequest(account)
            }
            const result = await host.emailLogin.enterEmail(page, account.email)
            if (result !== 'ok') return false
            if (host.canAutoHandleEmailCode()) {
                host.emailCodeRequestedAtMs = Date.now()
            }
            await host.waitForIdle(page, 'after email entry')
            host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Email entered successfully')
            return true
        }

        case 'PASSWORD_INPUT': {
            if (
                host.preferEmailCodeOverPassword &&
                host.canAutoHandleEmailCode() &&
                !host.emailCodeSwitchedFromPassword
            ) {
                const switched = await trySwitchPasswordToEmailCode(host, page, account)
                if (switched) {
                    host.emailCodeSwitchedFromPassword = true
                    return true
                }
                host.preferEmailCodeOverPassword = false
            }

            if (!account.password) {
                host.bot.logger.info(
                    host.bot.isMobile,
                    'LOGIN',
                    'Password input detected but no password is configured; returning to sign-in methods'
                )
                if (await host.tryClick(page, host.selectors.backButton, 'Back button')) return true

                host.bot.logger.warn(
                    host.bot.isMobile,
                    'LOGIN',
                    'No configured password and no way to return to sign-in methods'
                )
                return false
            }

            host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Entering password')
            const result = await host.emailLogin.enterPassword(page, account.password)
            if (result === 'error') return false
            host.passwordAttempted = true
            await host.waitForIdle(page, 'after password entry')
            host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Password entered successfully')
            return true
        }

        case 'FOOTER_ACTION': {
            host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Opening alternative sign-in methods')
            const clicked = await host.bot.browser.utils.ghostClick(page, host.selectors.footerAction)
            if (!clicked) {
                host.bot.logger.warn(host.bot.isMobile, 'LOGIN', 'Could not open alternative sign-in methods')
                return false
            }
            host.passwordlessMethodSelected = false
            await host.waitForIdle(page, 'after sign-in footer action')
            return true
        }

        case 'PASSWORDLESS_SEND_CODE': {
            host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Continuing with primary sign-in method')
            if (host.canAutoHandleEmailCode()) {
                await host.prepareEmailCodeRequest(account)
            }
            const clicked = await host.bot.browser.utils.ghostClick(page, host.selectors.primaryButton)
            if (!clicked) {
                host.bot.logger.warn(host.bot.isMobile, 'LOGIN', 'Could not continue with primary sign-in method')
                return false
            }
            await host.waitForIdle(page, 'after primary sign-in action')
            return true
        }

        case 'SIGN_IN_METHOD_PICKER':
            return handleSignInMethodPicker(host, page, account)

        case 'RECOVERY_EMAIL_INPUT': {
            if (host.canAutoHandleEmailCode()) {
                return handleAutoRecoveryEmail(host, page, account)
            }
            host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Recovery email input detected')
            await host.waitForIdle(page, 'on recovery page')
            host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Initiating recovery email handler')
            await host.recoveryLogin.handle(page, account?.recoveryEmail)
            host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Recovery email handler completed successfully')
            return true
        }

        case 'EMAIL_VERIFICATION_INPUT':
            return handleEmailVerificationAlternatives(host, page, account)

        case 'CHROMEWEBDATA_ERROR': {
            host.bot.logger.warn(host.bot.isMobile, 'LOGIN', 'chromewebdata error detected, attempting recovery')
            try {
                const destination = host.rewardsLogin ? REWARDS_BASE_URL : URLs.bing.origin
                host.bot.logger.info(host.bot.isMobile, 'LOGIN', `Navigating to ${destination}`)
                await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {})
                await host.bot.utils.wait(3000)
                host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Recovery navigation successful')
                return true
            } catch {
                host.bot.logger.warn(host.bot.isMobile, 'LOGIN', 'Fallback to login.live.com')
                await page.goto(URLs.auth.loginLive, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {})
                await host.bot.utils.wait(3000)
                host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Fallback navigation successful')
                return true
            }
        }

        case '2FA_TOTP':
            return handleTotp2Fa(host, page, account)

        case 'KMSI_PROMPT': {
            host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Accepting KMSI prompt')
            const clicked = await host.bot.browser.utils.ghostClick(page, host.selectors.primaryButton)
            if (!clicked) {
                host.bot.logger.warn(host.bot.isMobile, 'LOGIN', 'Could not accept KMSI prompt')
                return false
            }
            await host.waitForIdle(page, 'after KMSI acceptance')
            host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'KMSI prompt accepted')
            return true
        }

        case 'PASSKEY_VIDEO':
        case 'PASSKEY_ERROR': {
            host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Skipping Passkey prompt')
            const clicked = await host.bot.browser.utils.ghostClick(page, host.selectors.secondaryButton)
            if (!clicked) {
                host.bot.logger.warn(host.bot.isMobile, 'LOGIN', 'Could not skip Passkey prompt')
                return false
            }
            await host.waitForIdle(page, 'after Passkey skip')
            host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Passkey prompt skipped')
            return true
        }

        case 'LOGIN_PASSWORDLESS': {
            host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Handling passwordless authentication')
            await host.passwordlessLogin.handle(page)
            host.passwordlessMethodSelected = false
            await host.waitForIdle(page, 'after passwordless auth')
            host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Passwordless authentication completed successfully')
            return true
        }

        case 'OTP_CODE_ENTRY':
            return handleOtpCodeEntry(host, page, account)

        case 'UNKNOWN': {
            const rawUrl = page.url()
            const url = new URL(rawUrl)
            if (
                !host.rewardsLogin &&
                host.serviceHost === 'onedrive.live.com' &&
                url.hostname === 'www.microsoft.com' &&
                /\/onedrive\//i.test(url.pathname) &&
                host.firstPartyWelcomeActions < 2
            ) {
                const links = page.getByRole('link', { name: /^sign in$/i })
                const count = await links.count()
                for (let index = count - 1; index >= 0; index--) {
                    const link = links.nth(index)
                    if (!(await link.isVisible().catch(() => false))) continue
                    const href = await link.getAttribute('href')
                    if (!href) continue
                    const destination = new URL(href, rawUrl)
                    if (
                        !['go.microsoft.com', 'onedrive.live.com', 'login.live.com'].includes(destination.hostname) ||
                        destination.protocol !== 'https:'
                    ) {
                        continue
                    }
                    host.firstPartyWelcomeActions++
                    await page.goto(destination.href, { waitUntil: 'domcontentloaded', timeout: 20000 })
                    return true
                }
            }
            if (host.firstPartyWelcomeActions < 3) {
                const handled = await advanceMicrosoftWelcome(page, true)
                if (handled) {
                    host.firstPartyWelcomeActions += handled
                    host.bot.logger.info(
                        host.bot.isMobile,
                        'LOGIN',
                        `Advanced Microsoft welcome steps | count=${handled}`
                    )
                    return true
                }
            }
            if (!host.rewardsLogin && host.serviceHost && ++host.unknownServiceChecks >= 8) {
                throw new Error('Microsoft service initialization requires manual action')
            }
            if (url.hostname === 'rewards.bing.com' && /^\/(?:earn|dashboard)\/?$/i.test(url.pathname)) {
                host.unknownRewardsEarnChecks++
                if (host.unknownRewardsEarnChecks >= 3 && !host.recoveredRewardsEarn) {
                    host.recoveredRewardsEarn = true
                    host.bot.logger.warn(
                        host.bot.isMobile,
                        'LOGIN',
                        'Rewards page did not render a recognizable state; reloading once with the existing session'
                    )
                    await recoverFromLoginPostback(host, page)
                    return true
                }
            } else {
                host.unknownRewardsEarnChecks = 0
            }
            if (
                url.hostname === 'rewards.bing.com' &&
                /^\/auth\/login\/?$/i.test(url.pathname) &&
                !host.recoveredRewardsLogin
            ) {
                host.recoveredRewardsLogin = true
                host.bot.logger.warn(
                    host.bot.isMobile,
                    'LOGIN',
                    'Rewards login route did not advance; checking the earn page once before continuing sign-in'
                )
                await recoverFromLoginPostback(host, page)
                return true
            }
            host.bot.logger.warn(host.bot.isMobile, 'LOGIN', `Unknown state at ${url.hostname}${url.pathname}, waiting`)

            if (host.bot.config?.errorDiagnostics && !host.capturedUnknownUrls.has(rawUrl)) {
                host.capturedUnknownUrls.add(rawUrl)
                await unknownPageDiagnostic(page, {
                    platform: host.bot.isMobile ? 'mobile' : 'desktop'
                })
            }
            return true
        }

        default:
            host.bot.logger.debug(host.bot.isMobile, 'HANDLE-STATE', `Unhandled state: ${state}, continuing`)
            return true
    }
}
