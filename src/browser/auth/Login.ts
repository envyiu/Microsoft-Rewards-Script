import { URLs, REWARDS_BASE_URL } from '../../constants/urls'
import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../index'
import { saveStorageState } from '../../util/SessionStore'
import { unknownPageDiagnostic } from '../../util/ErrorDiagnostic'
import { configureMediaBlocking, suspendMediaBlocking } from '../MediaBlocker'
import { mapFlyoutToDashboard, type RewardsFlyoutData } from '../FlyoutDashboard'

import { MobileAccessLogin } from './methods/MobileAccessLogin'
import { EmailLogin } from './methods/EmailLogin'
import { PasswordlessLogin } from './methods/PasswordlessLogin'
import { TotpLogin } from './methods/Totp2FALogin'
import { CodeLogin } from './methods/GetACodeLogin'
import { RecoveryLogin } from './methods/RecoveryEmailLogin'
import { canPromptForInput } from './methods/LoginUtils'

import type { Account } from '../../interface/Account'
import { isAccountReviewUrl } from './AuthorizationRoute'
import { runRewardsOnboarding } from '../../functions/RewardsOnboarding'

type LoginState =
    | 'EMAIL_INPUT'
    | 'PASSWORD_INPUT'
    | 'FOOTER_ACTION'
    | 'SIGN_IN_METHOD_PICKER'
    | 'PASSKEY_ERROR'
    | 'PASSKEY_VIDEO'
    | 'KMSI_PROMPT'
    | 'LOGGED_IN'
    | 'EMAIL_VERIFICATION_INPUT'
    | 'RECOVERY_EMAIL_INPUT'
    | 'ACCOUNT_LOCKED'
    | 'ERROR_ALERT'
    | '2FA_TOTP'
    | 'LOGIN_PASSWORDLESS'
    | 'PASSWORDLESS_SEND_CODE'
    | 'OTP_CODE_ENTRY'
    | 'UNKNOWN'
    | 'CHROMEWEBDATA_ERROR'

type SignInMethodOption = {
    index: number
    selector: string
    label: string
    signature: string
}

type SignInMethodType = 'PASSWORD' | 'AUTHENTICATOR' | 'EMAIL' | 'PASSKEY' | 'TOTP' | 'UNKNOWN'

export class Login {
    emailLogin: EmailLogin
    passwordlessLogin: PasswordlessLogin
    totp2FALogin: TotpLogin
    codeLogin: CodeLogin
    recoveryLogin: RecoveryLogin

    private readonly capturedUnknownUrls = new Set<string>()
    private signInMethodsLogged = false
    private passwordlessMethodSelected = false
    private recoveredRewardsLogin = false
    private unknownRewardsEarnChecks = 0
    private recoveredRewardsEarn = false
    private rewardsLogin = true
    private firstPartyWelcomeActions = 0
    private serviceHost: string | null = null
    private serviceHosts: string[] = []
    private unknownServiceChecks = 0

    private readonly selectors = {
        primaryButton: 'button[data-testid="primaryButton"]',
        secondaryButton: 'button[data-testid="secondaryButton"]',
        footerAction: '[data-testid="viewFooter"] [role="button"]',
        signInTile: '[data-testid="tile"]',
        emailIconOld: 'img[data-testid="accessibleImg"][src*="picker_verify_email"]',
        passwordlessOptionOld: 'img[data-testid="accessibleImg"][src*="picker_remote_ngc"]',
        recoveryEmail: '[data-testid="proof-confirmation"]',
        emailVerificationInput: 'input#proof-confirmation-email-input',
        accountLocked: '#serviceAbuseLandingTitle',
        errorAlert: 'div[role="alert"]',
        passwordEntry: '[data-testid="passwordEntry"]',
        emailEntry: 'input#usernameEntry',
        kmsiVideo: '[data-testid="kmsiVideo"]',
        passKeyVideo: '[data-testid="biometricVideo"]',
        passKeyError: '[data-testid="registrationImg"]',
        passwordlessCheck: '[data-testid="deviceShieldCheckmarkVideo"]',
        passwordlessNumber: '[data-testid="displaySign"]',
        totpInput: 'input[name="otc"]',
        totpInputOld: 'form[name="OneTimeCodeViewForm"]',
        identityBanner: '[data-testid="identityBanner"]',
        otpCodeEntry: '[data-testid="codeEntry"]',
        backButton: '#back-button',
        bingProfile: '#id_n',
        microsoftAccountProfile:
            '#mectrl_currentAccount_primary, [data-testid="account-card"], [data-testid="user-avatar"]',
        otpInput: 'div[data-testid="codeEntry"]'
    } as const

    constructor(private bot: MicrosoftRewardsBot) {
        this.emailLogin = new EmailLogin(this.bot)
        this.passwordlessLogin = new PasswordlessLogin(this.bot)
        this.totp2FALogin = new TotpLogin(this.bot)
        this.codeLogin = new CodeLogin(this.bot)
        this.recoveryLogin = new RecoveryLogin(this.bot)
    }

    async login(page: Page, account: Account, { rewards = true, startUrl = undefined as string | undefined } = {}) {
        this.rewardsLogin = rewards
        this.firstPartyWelcomeActions = 0
        this.serviceHost = startUrl ? new URL(startUrl).hostname : null
        this.serviceHosts = this.serviceHost === 'to-do.live.com' ? ['to-do.live.com', 'to-do.microsoft.com', 'todo.microsoft.com', 'todo.cloud.microsoft', 'to-do.office.com'] : this.serviceHost ? [this.serviceHost] : []
        this.unknownServiceChecks = 0
        if (startUrl && (rewards || !['onedrive.live.com', 'to-do.live.com', 'outlook.live.com'].includes(this.serviceHost || '')))
            throw new Error('Unsupported Microsoft service sign-in destination')
        try {
            suspendMediaBlocking(this.bot, page.context())
            this.capturedUnknownUrls.clear()
            this.signInMethodsLogged = false
            this.passwordlessMethodSelected = false
            this.recoveredRewardsLogin = false
            this.unknownRewardsEarnChecks = 0
            this.recoveredRewardsEarn = false
            this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Starting login process')

            const hasStoredAuth = await this.hasStoredAuthCookies(page)
            if (hasStoredAuth)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', rewards ? 'Checking saved session on Rewards earn page' : 'Checking saved session on Microsoft/Bing')
            await page
                .goto(rewards ? (hasStoredAuth ? URLs.rewards.earn : URLs.rewards.userLogin) : startUrl || URLs.auth.bingSignIn, {
                    waitUntil: 'domcontentloaded'
                })
                .catch(() => {})
            await this.bot.utils.wait(2000)
            await this.bot.browser.utils.reloadBadPage(page)
            await this.bot.browser.utils.disableFido(page)

            const maxIterations = 25
            let iteration = 0
            let previousState: LoginState = 'UNKNOWN'
            let sameStateCount = 0

            while (iteration < maxIterations) {
                if (this.bot.shuttingDown) throw new Error('Login interrupted by session checkpoint')
                if (page.isClosed()) throw new Error('Page closed unexpectedly')

                iteration++
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `State check iteration ${iteration}/${maxIterations}`)

                const state = await this.detectCurrentState(page)
                if (this.bot.shuttingDown) throw new Error('Login interrupted by session checkpoint')
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `Current state: ${state}`)

                if (state !== previousState && previousState !== 'UNKNOWN') {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', `State transition: ${previousState} → ${state}`)
                }

                if (state === previousState && state !== 'LOGGED_IN' && state !== 'UNKNOWN') {
                    sameStateCount++
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'LOGIN',
                        `Same state count: ${sameStateCount}/4 for state "${state}"`
                    )
                    if (sameStateCount >= 4) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'LOGIN',
                            `Stuck in state "${state}" for 4 loops, refreshing page`
                        )
                        await page.reload({ waitUntil: 'domcontentloaded' })
                        await this.bot.utils.wait(3000)
                        sameStateCount = 0
                        previousState = 'UNKNOWN'
                        continue
                    }
                } else {
                    sameStateCount = 0
                }
                previousState = state

                if (state === 'LOGGED_IN') {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Successfully logged in')
                    break
                }

                const shouldContinue = await this.handleState(state, page, account)
                if (this.bot.shuttingDown) throw new Error('Login interrupted by session checkpoint')
                if (!shouldContinue) {
                    throw new Error(`Login failed or aborted at state: ${state}`)
                }

                await this.bot.utils.wait(1000)
            }

            if (iteration >= maxIterations) {
                throw new Error('Login timeout: exceeded maximum iterations')
            }

            if (rewards) await this.finalizeLogin(page, account)
            else {
                const cookies = await page.context().cookies(URLs.bing.origin)
                if (!cookies.some(c => c.name === '_U' && c.value)) throw new Error('Bing sign-in is not confirmed; manual authentication required')
                saveStorageState(this.bot.config.sessionPath, account.email, this.bot.isMobile, await page.context().storageState())
                await configureMediaBlocking(this.bot, page.context())
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Microsoft/Bing login completed without Rewards')
            }
        } catch (error) {
            if (this.bot.shuttingDown) {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Login interrupted by session checkpoint')
                throw error
            }
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN',
                `Fatal error: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    private async detectCurrentState(page: Page): Promise<LoginState> {
        await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {})

        const url = new URL(page.url())
        const hostname = url.hostname.toLowerCase()
        if (!this.rewardsLogin && this.serviceHosts.includes(hostname)) {
            const guest = page.getByRole('button', { name: /^sign in$/i }).or(page.getByRole('link', { name: /^sign in$/i })).first()
            const credentials = page.locator('input[type="password"], input#usernameEntry').first()
            const text = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '')
            if (text.trim().length > 20 && !/^loading[.\s…]*$/i.test(text.trim()) && !await guest.isVisible().catch(() => false) && !await credentials.isVisible().catch(() => false) &&
                (await page.context().cookies(URLs.bing.origin)).some(c => c.name === '_U' && c.value)) return 'LOGGED_IN'
        }
        if (!this.rewardsLogin && (hostname === 'bing.com' || hostname === 'www.bing.com')) {
            const cookies = await page.context().cookies(URLs.bing.origin)
            if (cookies.some(c => c.name === '_U' && c.value)) return 'LOGGED_IN'
        }
        this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `Current URL: ${hostname}${url.pathname}`)

        if (hostname === 'chromewebdata') {
            this.bot.logger.warn(this.bot.isMobile, 'DETECT-STATE', 'Detected chromewebdata error page')
            return 'CHROMEWEBDATA_ERROR'
        }

        const isLocked = await this.checkSelector(page, this.selectors.accountLocked)
        if (isLocked) {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', 'Account locked selector found')
            return 'ACCOUNT_LOCKED'
        }

        const isRewardsAuthRoute = hostname === 'rewards.bing.com' && /^\/auth(?:\/|$)/i.test(url.pathname)
        if (
            !isRewardsAuthRoute &&
            (hostname === 'bing.com' || hostname.endsWith('.bing.com') || hostname === 'account.microsoft.com')
        ) {
            const [profileVisible, accountProfileVisible, sessionCookies] = await Promise.all([
                this.checkSelector(page, this.selectors.bingProfile),
                this.checkSelector(page, this.selectors.microsoftAccountProfile),
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
                this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', 'Authenticated session evidence found')
                return 'LOGGED_IN'
            }
            if (hostname === 'rewards.bing.com' && (await this.hasAuthenticatedRewardsPayload(page))) {
                return 'LOGGED_IN'
            }
            this.bot.logger.debug(
                this.bot.isMobile,
                'DETECT-STATE',
                'Microsoft/Bing route found without authenticated session evidence'
            )
        }

        // Page/state selectors are checked together; page-specific routing is resolved below by priority
        const stateChecks: Array<[string, LoginState]> = [
            [this.selectors.errorAlert, 'ERROR_ALERT'],
            [this.selectors.passwordEntry, 'PASSWORD_INPUT'],
            [this.selectors.emailEntry, 'EMAIL_INPUT'],
            [this.selectors.recoveryEmail, 'RECOVERY_EMAIL_INPUT'],
            [this.selectors.emailVerificationInput, 'EMAIL_VERIFICATION_INPUT'],
            [this.selectors.kmsiVideo, 'KMSI_PROMPT'],
            [this.selectors.passKeyVideo, 'PASSKEY_VIDEO'],
            [this.selectors.passKeyError, 'PASSKEY_ERROR'],
            [this.selectors.signInTile, 'SIGN_IN_METHOD_PICKER'],
            [this.selectors.passwordlessOptionOld, 'SIGN_IN_METHOD_PICKER'],
            [this.selectors.emailIconOld, 'SIGN_IN_METHOD_PICKER'],
            [this.selectors.passwordlessCheck, 'LOGIN_PASSWORDLESS'],
            [this.selectors.passwordlessNumber, 'LOGIN_PASSWORDLESS'],
            [this.selectors.totpInput, '2FA_TOTP'],
            [this.selectors.totpInputOld, '2FA_TOTP'],
            [this.selectors.otpCodeEntry, 'OTP_CODE_ENTRY'],
            [this.selectors.otpInput, 'OTP_CODE_ENTRY']
        ]

        const [results, identityBanner, primaryButton, passwordEntry, footerAction, footerActionText] =
            await Promise.all([
                Promise.all(
                    stateChecks.map(async ([sel, state]) => {
                        const visible = await this.checkSelector(page, sel)
                        return visible ? state : null
                    })
                ),
                this.checkSelector(page, this.selectors.identityBanner),
                this.checkSelector(page, this.selectors.primaryButton),
                this.checkSelector(page, this.selectors.passwordEntry),
                this.checkSelector(page, this.selectors.footerAction),
                page
                    .locator(this.selectors.footerAction)
                    .first()
                    .innerText({ timeout: 200 })
                    .catch(() => '')
            ])

        const visibleStates = results.filter((s): s is LoginState => s !== null)
        if (visibleStates.length > 0) {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `Visible states: [${visibleStates.join(', ')}]`)
        }

        // Get a sign-in request - distinguish a generic methods footer from a direct email/phone fallback
        if (
            identityBanner &&
            primaryButton &&
            !passwordEntry &&
            !results.includes('2FA_TOTP') &&
            !results.includes('RECOVERY_EMAIL_INPUT') &&
            !results.includes('EMAIL_VERIFICATION_INPUT')
        ) {
            const normalizedFooterAction = this.normalizeSignInText(footerActionText)
            // Detect email or masked phone proof destinations without relying on localized footer text
            const footerTargetsSpecificProof =
                /[\w.+*-]+@[\w.*-]+\.[a-z]{2,}/i.test(normalizedFooterAction) ||
                /(?:\+?\d|[*xX])(?:[\d\s().*xX-]{4,})(?:\d|[*xX])/.test(normalizedFooterAction)

            if (footerAction && !footerTargetsSpecificProof && !this.passwordlessMethodSelected) {
                this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', 'Alternative sign-in methods are available')
                results.push('FOOTER_ACTION')
            } else {
                if (footerAction && footerTargetsSpecificProof) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'DETECT-STATE',
                        'Footer targets a specific verification proof; keeping the primary sign-in method'
                    )
                }
                this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', 'Primary passwordless action detected')
                results.push('PASSWORDLESS_SEND_CODE')
            }
        }

        let foundStates = results.filter((s): s is LoginState => s !== null)

        if (foundStates.length === 0) {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', 'No matching states found')
            return 'UNKNOWN'
        }

        if (foundStates.includes('ERROR_ALERT')) {
            const errorIsReal = hostname === 'login.live.com' && !foundStates.includes('2FA_TOTP')
            this.bot.logger.debug(
                this.bot.isMobile,
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
                this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `Selected state by priority: ${priority}`)
                return priority
            }
        }

        const fallbackState = foundStates[0] ?? 'UNKNOWN'
        this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `Returning fallback state: ${fallbackState}`)
        return fallbackState
    }

    private async hasAuthenticatedRewardsPayload(page: Page): Promise<boolean> {
        try {
            // The current mobile Rewards dashboard omits the old Bing/MeControl
            // selectors and may not expose an _U cookie on the Rewards host.
            // Verify the personalized membership payload in the rendered page.
            const { account } = this.bot.browser.react.snapshotPage(await page.content())
            const membership = [account.pointsProgress, account.pointsRemaining, account.lifetimeEarn]
            const membershipConfirmed =
                Number.isSafeInteger(account.level) &&
                Number(account.level) >= 1 &&
                membership.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
            // Brand-new members have no lifetime counter yet. Their personalized
            // membership progress plus the first-visit welcome is still valid.
            const firstVisit = Number.isSafeInteger(account.level) && Number(account.level) >= 1 &&
                [account.pointsProgress, account.pointsRemaining].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0) &&
                await page.getByRole('heading', { name: /welcome to\s*microsoft rewards/i }).first().isVisible().catch(() => false) &&
                await page.getByRole('button', { name: /^get started$/i }).first().isVisible().catch(() => false)
            const confirmed = membershipConfirmed || firstVisit
            if (confirmed)
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN',
                    'Authenticated Rewards membership payload verified on the rendered page'
                )
            return confirmed
        } catch {
            return false
        }
    }

    private async checkSelector(page: Page, selector: string): Promise<boolean> {
        return page
            .waitForSelector(selector, { state: 'visible', timeout: 5000 })
            .then(() => true)
            .catch(() => false)
    }

    private normalizeSignInText(value: string): string {
        return value.replace(/\s+/g, ' ').trim()
    }

    private sanitizeSignInLabel(value: string): string {
        return this.normalizeSignInText(value)
            .replace(/[\w.+*-]+@[\w.-]+\.[a-z]{2,}/gi, '<email>')
            .replace(/\+?\d[\d\s().*-]{5,}\d/g, '<phone>')
    }

    private async getSignInMethodOptions(page: Page): Promise<SignInMethodOption[]> {
        const tiles = page.locator(this.selectors.signInTile)
        const count = await tiles.count().catch(() => 0)
        const options = await Promise.all(
            Array.from({ length: count }, async (_, index): Promise<SignInMethodOption | null> => {
                const tile = tiles.nth(index)
                if (!(await tile.isVisible().catch(() => false))) return null

                const metadata = await tile
                    .evaluate(element => {
                        const elements = [element, ...Array.from(element.querySelectorAll('*'))]
                        const structuralAttributeNames = new Set([
                            'id',
                            'name',
                            'src',
                            'data-testid',
                            'data-value',
                            'data-bind',
                            'd'
                        ])
                        const accessibleText = elements
                            .flatMap(node => ['aria-label', 'title', 'alt'].map(name => node.getAttribute(name) ?? ''))
                            .filter(Boolean)
                            .join(' ')
                        const structuralAttributes = elements
                            .flatMap(node =>
                                Array.from(node.attributes)
                                    .filter(attribute => structuralAttributeNames.has(attribute.name))
                                    .map(attribute => `${attribute.name}=${attribute.value}`)
                            )
                            .join(' ')

                        return {
                            text: element.textContent ?? '',
                            accessibleText,
                            structuralAttributes
                        }
                    })
                    .catch(() => null)

                if (!metadata) return null

                const label = this.normalizeSignInText(`${metadata.text} ${metadata.accessibleText}`)
                const signature = this.normalizeSignInText(metadata.structuralAttributes).toLowerCase()

                return {
                    index,
                    selector: `${this.selectors.signInTile} >> nth=${index}`,
                    label: label || `Sign-in option ${index + 1}`,
                    signature
                }
            })
        )

        return options.filter((option): option is SignInMethodOption => option !== null)
    }

    private classifySignInMethod(option: SignInMethodOption): SignInMethodType {
        const signature = option.signature

        // Sign in another way - classify method tiles from structural signatures, not translated labels
        if (signature.includes('m5.25 4h13.5a3.25') || signature.includes('picker_verify_email')) return 'EMAIL'
        if (signature.includes('m11.78 10.22a.75')) return 'PASSWORD'
        // Known passkey/security-key SVG signature keeps it out of the Authenticator fallback
        if (/picker_fido|passkey|fido|m18 16\.66a3\.51/.test(signature)) return 'PASSKEY'
        if (/phone[\s_-]*app[\s_-]*otp|\btotp\b/.test(signature)) return 'TOTP'
        // Known Remote NGC/mobile-app SVG signature identifies Microsoft Authenticator language-independently
        if (
            /remote[\s_-]*ngc|picker_remote_ngc|phone[\s_-]*app[\s_-]*notification|push[\s_-]*notification|m15\.75 2c16\.99 2 18 3/.test(
                signature
            )
        ) {
            return 'AUTHENTICATOR'
        }

        return 'UNKNOWN'
    }

    private async clickSignInMethodOption(page: Page, option: SignInMethodOption): Promise<boolean> {
        const ghostClicked = await this.bot.browser.utils.ghostClick(page, option.selector)
        if (ghostClicked) return true

        return page
            .locator(this.selectors.signInTile)
            .nth(option.index)
            .click()
            .then(() => true)
            .catch(() => false)
    }

    private logAvailableSignInMethods(options: SignInMethodOption[]): void {
        if (this.signInMethodsLogged) return
        this.signInMethodsLogged = true
        if (options.length === 0) return

        const labels = options.map(option => this.sanitizeSignInLabel(option.label))
        this.bot.logger.info(this.bot.isMobile, 'LOGIN', `Available sign-in methods: ${labels.join(' | ')}`)
    }

    private async waitForIdle(page: Page, note: string, timeout = 5000): Promise<void> {
        await page.waitForLoadState('networkidle', { timeout }).catch(() => {
            this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `Network idle timeout: ${note}`)
        })
    }

    private async tryClick(page: Page, selector: string, label: string, timeout = 2000): Promise<boolean> {
        const found = await page.waitForSelector(selector, { state: 'visible', timeout }).catch(() => null)
        if (!found) return false

        const clicked = await this.bot.browser.utils.ghostClick(page, selector)
        if (!clicked) return false

        await this.waitForIdle(page, `after ${label}`)
        this.bot.logger.info(this.bot.isMobile, 'LOGIN', `${label} clicked`)
        return true
    }

    private async handleState(state: LoginState, page: Page, account: Account): Promise<boolean> {
        this.bot.logger.debug(this.bot.isMobile, 'HANDLE-STATE', `Processing state: ${state}`)

        switch (state) {
            case 'ACCOUNT_LOCKED': {
                const msg = 'This account has been locked! Remove from config and restart!'
                this.bot.logger.error(this.bot.isMobile, 'LOGIN', msg)
                throw new Error(msg)
            }

            case 'ERROR_ALERT': {
                const alertEl = page.locator(this.selectors.errorAlert)
                const errorMsg = await alertEl.innerText().catch(() => 'Unknown Error')

                // Microsoft sometimes answers the KMSI form POST at
                // /ppsecure/post.srf with an empty alert while the auth cookie
                // is already valid and the next Rewards navigation succeeds.
                // Treat that intermediate response as a recoverable redirect,
                // but keep real, non-empty login errors fatal.
                if (this.isEmptyLoginPostbackAlert(page, errorMsg)) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN',
                        'Empty Microsoft login postback alert; verifying the Rewards session before failing'
                    )
                    await this.recoverFromLoginPostback(page)
                    return true
                }

                this.bot.logger.error(this.bot.isMobile, 'LOGIN', `Account error: ${errorMsg}`)
                throw new Error(`Microsoft login error: ${errorMsg}`)
            }

            case 'LOGGED_IN':
                return true

            case 'EMAIL_INPUT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Entering email')
                const result = await this.emailLogin.enterEmail(page, account.email)
                if (result !== 'ok') return false
                await this.waitForIdle(page, 'after email entry')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Email entered successfully')
                return true
            }

            // Enter password - use it only when Microsoft actually presents the password page
            case 'PASSWORD_INPUT': {
                if (!account.password) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'LOGIN',
                        'Password input detected but no password is configured; returning to sign-in methods'
                    )
                    if (await this.tryClick(page, this.selectors.backButton, 'Back button')) return true

                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN',
                        'No configured password and no way to return to sign-in methods'
                    )
                    return false
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Entering password')
                const result = await this.emailLogin.enterPassword(page, account.password)
                if (result === 'error') return false
                await this.waitForIdle(page, 'after password entry')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Password entered successfully')
                return true
            }

            // Generic alternative-method footer - open the method picker before choosing a credential
            case 'FOOTER_ACTION': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Opening alternative sign-in methods')
                const clicked = await this.bot.browser.utils.ghostClick(page, this.selectors.footerAction)
                if (!clicked) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'Could not open alternative sign-in methods')
                    return false
                }
                this.passwordlessMethodSelected = false
                await this.waitForIdle(page, 'after sign-in footer action')
                return true
            }

            // Get a sign-in request - keep the primary Authenticator action when footer is a proof fallback
            case 'PASSWORDLESS_SEND_CODE': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Continuing with primary sign-in method')
                const clicked = await this.bot.browser.utils.ghostClick(page, this.selectors.primaryButton)
                if (!clicked) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'Could not continue with primary sign-in method')
                    return false
                }
                await this.waitForIdle(page, 'after primary sign-in action')
                return true
            }

            // Sign in another way - prefer offered password, then Authenticator, then interactive email code
            case 'SIGN_IN_METHOD_PICKER': {
                const options = await this.getSignInMethodOptions(page)
                this.logAvailableSignInMethods(options)

                const methods = options.map(option => ({ option, type: this.classifySignInMethod(option) }))
                const passwordOption = methods.find(method => method.type === 'PASSWORD')?.option
                const authenticatorOption = methods.find(method => method.type === 'AUTHENTICATOR')?.option
                const emailOption = methods.find(method => method.type === 'EMAIL')?.option

                if (account.password && passwordOption) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Password sign-in is available; selecting it')
                    this.passwordlessMethodSelected = false

                    if (!(await this.clickSignInMethodOption(page, passwordOption))) {
                        this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'Could not select password sign-in method')
                        return false
                    }

                    await this.waitForIdle(page, 'after password method selection')
                    return true
                }

                const passwordlessOptionOldFound = await this.checkSelector(page, this.selectors.passwordlessOptionOld)
                if (authenticatorOption || passwordlessOptionOldFound) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Selecting Microsoft Authenticator sign-in')
                    this.passwordlessMethodSelected = true

                    const clicked = authenticatorOption
                        ? await this.clickSignInMethodOption(page, authenticatorOption)
                        : await this.bot.browser.utils.ghostClick(page, this.selectors.passwordlessOptionOld)

                    if (!clicked) {
                        this.passwordlessMethodSelected = false
                        this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'Could not select Microsoft Authenticator')
                        return false
                    }

                    await this.waitForIdle(page, 'after Microsoft Authenticator selection')

                    const passwordlessChallengeVisible =
                        (await this.checkSelector(page, this.selectors.passwordlessCheck)) ||
                        (await this.checkSelector(page, this.selectors.passwordlessNumber))

                    if (
                        !passwordlessChallengeVisible &&
                        (await this.checkSelector(page, this.selectors.primaryButton))
                    ) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Sending Microsoft Authenticator request')
                        const confirmed = await this.bot.browser.utils.ghostClick(page, this.selectors.primaryButton)
                        if (!confirmed) {
                            this.passwordlessMethodSelected = false
                            this.bot.logger.warn(
                                this.bot.isMobile,
                                'LOGIN',
                                'Could not send Microsoft Authenticator request'
                            )
                            return false
                        }
                        await this.waitForIdle(page, 'after Microsoft Authenticator request')
                    }

                    return true
                }

                const emailIconOldFound = await this.checkSelector(page, this.selectors.emailIconOld)
                if (emailOption || emailIconOldFound) {
                    if (!canPromptForInput()) {
                        this.bot.logger.error(
                            this.bot.isMobile,
                            'LOGIN',
                            'No supported non-interactive sign-in method is available; email-code fallback requires interactive stdin'
                        )
                        return false
                    }

                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Selecting email-code sign-in')
                    this.passwordlessMethodSelected = false

                    const clicked = emailOption
                        ? await this.clickSignInMethodOption(page, emailOption)
                        : await this.bot.browser.utils.ghostClick(page, this.selectors.emailIconOld)

                    if (!clicked) {
                        this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'Could not select email-code sign-in method')
                        return false
                    }

                    await this.waitForIdle(page, 'after email method selection')
                    await this.codeLogin.handle(page)
                    return true
                }

                const ignoredMethods = methods
                    .map(method => method.type)
                    .filter(type => type === 'PASSKEY' || type === 'TOTP' || type === 'UNKNOWN')

                this.bot.logger.error(
                    this.bot.isMobile,
                    'LOGIN',
                    `No supported sign-in method available${ignoredMethods.length ? `; ignored=${ignoredMethods.join(',')}` : ''}`
                )
                return false
            }

            // Recovery email confirmation
            case 'RECOVERY_EMAIL_INPUT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Recovery email input detected')
                await this.waitForIdle(page, 'on recovery page')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Initiating recovery email handler')
                await this.recoveryLogin.handle(page, account?.recoveryEmail)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Recovery email handler completed successfully')
                return true
            }

            // Verify your email - identical footer actions are validated by their resulting state, not position
            case 'EMAIL_VERIFICATION_INPUT': {
                if (!account.password) {
                    if (!canPromptForInput()) {
                        this.bot.logger.error(
                            this.bot.isMobile,
                            'LOGIN',
                            'Email verification requires a configured password or interactive stdin'
                        )
                        return false
                    }

                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Email verification input detected')
                    await this.codeLogin.handle(page)
                    return true
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN',
                    'Email verification input detected; checking alternatives'
                )
                await this.waitForIdle(page, 'on email verification page')

                const footerActions = page.locator(this.selectors.footerAction)
                const footerCount = await footerActions.count().catch(() => 0)

                for (let index = 0; index < footerCount; index++) {
                    const selector = `${this.selectors.footerAction} >> nth=${index}`
                    if (
                        !(await footerActions
                            .nth(index)
                            .isVisible()
                            .catch(() => false))
                    )
                        continue
                    if (!(await this.bot.browser.utils.ghostClick(page, selector))) continue

                    await this.waitForIdle(page, 'after email verification alternative')

                    if (await this.checkSelector(page, this.selectors.passwordEntry)) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Password sign-in option selected')
                        return true
                    }

                    if (await this.checkSelector(page, this.selectors.signInTile)) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Sign-in method picker opened')
                        return true
                    }

                    if (!(await this.tryClick(page, this.selectors.backButton, 'Back button'))) break
                    if (!(await this.checkSelector(page, this.selectors.emailVerificationInput))) break
                }

                if (canPromptForInput()) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Falling back to interactive email verification')
                    await this.codeLogin.handle(page)
                    return true
                }

                this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'No usable email verification alternative found')
                return false
            }

            case 'CHROMEWEBDATA_ERROR': {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'chromewebdata error detected, attempting recovery')
                try {
                    const destination = this.rewardsLogin ? REWARDS_BASE_URL : URLs.bing.origin
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', `Navigating to ${destination}`)
                    await page
                        .goto(destination, {
                            waitUntil: 'domcontentloaded',
                            timeout: 10000
                        })
                        .catch(() => {})
                    await this.bot.utils.wait(3000)
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Recovery navigation successful')
                    return true
                } catch {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'Fallback to login.live.com')
                    await page
                        .goto(URLs.auth.loginLive, {
                            waitUntil: 'domcontentloaded',
                            timeout: 10000
                        })
                        .catch(() => {})
                    await this.bot.utils.wait(3000)
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Fallback navigation successful')
                    return true
                }
            }

            case '2FA_TOTP': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'TOTP 2FA authentication required')
                await this.totp2FALogin.handle(page, account.totpSecret)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'TOTP 2FA handler completed successfully')
                return true
            }

            // Stay signed in / KMSI confirmation
            case 'KMSI_PROMPT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Accepting KMSI prompt')
                const clicked = await this.bot.browser.utils.ghostClick(page, this.selectors.primaryButton)
                if (!clicked) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'Could not accept KMSI prompt')
                    return false
                }
                await this.waitForIdle(page, 'after KMSI acceptance')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'KMSI prompt accepted')
                return true
            }

            // Passkey prompt/error - skip back to a supported sign-in method
            case 'PASSKEY_VIDEO':
            case 'PASSKEY_ERROR': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Skipping Passkey prompt')
                const clicked = await this.bot.browser.utils.ghostClick(page, this.selectors.secondaryButton)
                if (!clicked) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'Could not skip Passkey prompt')
                    return false
                }
                await this.waitForIdle(page, 'after Passkey skip')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Passkey prompt skipped')
                return true
            }

            // Microsoft Authenticator approval/number challenge
            case 'LOGIN_PASSWORDLESS': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Handling passwordless authentication')
                await this.passwordlessLogin.handle(page)
                this.passwordlessMethodSelected = false
                await this.waitForIdle(page, 'after passwordless auth')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Passwordless authentication completed successfully')
                return true
            }

            // Enter your code - prefer its alternate-method footer before Back to avoid an email-code loop
            case 'OTP_CODE_ENTRY': {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN',
                    'OTP code entry page detected; trying an available alternative sign-in method'
                )

                if (await this.checkSelector(page, this.selectors.footerAction)) {
                    const clicked = await this.bot.browser.utils.ghostClick(page, this.selectors.footerAction)
                    if (clicked) {
                        await this.waitForIdle(page, 'after OTP alternative sign-in action')

                        const stillOnOtp = await this.checkSelector(page, this.selectors.otpCodeEntry)
                        if (!stillOnOtp) {
                            const methodPickerVisible =
                                (await this.checkSelector(page, this.selectors.signInTile)) ||
                                (await this.checkSelector(page, this.selectors.passwordlessOptionOld)) ||
                                (await this.checkSelector(page, this.selectors.emailIconOld))
                            const passwordlessLandingVisible =
                                (await this.checkSelector(page, this.selectors.passwordlessCheck)) ||
                                (await this.checkSelector(page, this.selectors.passwordlessNumber)) ||
                                ((await this.checkSelector(page, this.selectors.identityBanner)) &&
                                    (await this.checkSelector(page, this.selectors.primaryButton)))

                            this.passwordlessMethodSelected = passwordlessLandingVisible
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'LOGIN',
                                methodPickerVisible
                                    ? 'Returned to sign-in method selection'
                                    : passwordlessLandingVisible
                                      ? 'Switched to Microsoft Authenticator sign-in'
                                      : 'Switched away from email-code authentication'
                            )
                            return true
                        }

                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'LOGIN',
                            'OTP footer action did not leave the code-entry page; falling back to Back'
                        )
                    }
                }

                this.passwordlessMethodSelected = false
                if (!(await this.tryClick(page, this.selectors.backButton, 'Back button'))) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'No usable alternative action found on OTP page')
                    return false
                }

                return true
            }

            // Unknown page - keep diagnostics useful instead of guessing a sign-in action
            case 'UNKNOWN': {
                const rawUrl = page.url()
                const url = new URL(rawUrl)
                if (!this.rewardsLogin && this.serviceHost === 'onedrive.live.com' && url.hostname === 'www.microsoft.com' &&
                    /\/onedrive\//i.test(url.pathname) && this.firstPartyWelcomeActions < 2) {
                    const links = page.getByRole('link', { name: /^sign in$/i })
                    const count = await links.count()
                    for (let index = count - 1; index >= 0; index--) {
                        const link = links.nth(index)
                        if (!await link.isVisible().catch(() => false)) continue
                        const href = await link.getAttribute('href')
                        if (!href) continue
                        const destination = new URL(href, rawUrl)
                        if (!['go.microsoft.com', 'onedrive.live.com', 'login.live.com'].includes(destination.hostname) || destination.protocol !== 'https:') continue
                        this.firstPartyWelcomeActions++
                        await page.goto(destination.href, { waitUntil: 'domcontentloaded', timeout: 20000 })
                        return true
                    }
                }
                if (!this.rewardsLogin && this.firstPartyWelcomeActions < 3 &&
                    (url.hostname === 'privacynotice.account.microsoft.com' || url.hostname === 'account.microsoft.com')) {
                    const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')
                    if (/privacy notice|terms of (?:use|service)|welcome to microsoft/i.test(text)) {
                        const button = page.getByRole('button', { name: /^(?:next|continue|accept|i agree)$/i }).first()
                        if (await button.isVisible().catch(() => false)) {
                            this.firstPartyWelcomeActions++
                            await button.click({ timeout: 5000 })
                            return true
                        }
                    }
                }
                if (!this.rewardsLogin && this.serviceHost && ++this.unknownServiceChecks >= 8)
                    throw new Error('Microsoft service initialization requires manual action')
                if (url.hostname === 'rewards.bing.com' && /^\/(?:earn|dashboard)\/?$/i.test(url.pathname)) {
                    this.unknownRewardsEarnChecks++
                    if (this.unknownRewardsEarnChecks >= 3 && !this.recoveredRewardsEarn) {
                        this.recoveredRewardsEarn = true
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'LOGIN',
                            'Rewards page did not render a recognizable state; reloading once with the existing session'
                        )
                        await this.recoverFromLoginPostback(page)
                        return true
                    }
                } else {
                    this.unknownRewardsEarnChecks = 0
                }
                if (
                    url.hostname === 'rewards.bing.com' &&
                    /^\/auth\/login\/?$/i.test(url.pathname) &&
                    !this.recoveredRewardsLogin
                ) {
                    this.recoveredRewardsLogin = true
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN',
                        'Rewards login route did not advance; checking the earn page once before continuing sign-in'
                    )
                    await this.recoverFromLoginPostback(page)
                    return true
                }
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LOGIN',
                    `Unknown state at ${url.hostname}${url.pathname}, waiting`
                )

                if (this.bot.config.errorDiagnostics && !this.capturedUnknownUrls.has(rawUrl)) {
                    this.capturedUnknownUrls.add(rawUrl)
                    await unknownPageDiagnostic(page, {
                        platform: this.bot.isMobile ? 'mobile' : 'desktop'
                    })
                }
                return true
            }

            default:
                this.bot.logger.debug(this.bot.isMobile, 'HANDLE-STATE', `Unhandled state: ${state}, continuing`)
                return true
        }
    }

    private isEmptyLoginPostbackAlert(page: Page, errorMsg: string): boolean {
        const url = new URL(page.url())
        const isPostback =
            url.hostname.toLowerCase() === 'login.live.com' && /^\/ppsecure\/post\.srf$/i.test(url.pathname)
        const normalized = errorMsg.trim()
        return isPostback && (!normalized || /^unknown error$/i.test(normalized))
    }

    private async recoverFromLoginPostback(page: Page): Promise<void> {
        await page
            .goto(this.rewardsLogin ? URLs.rewards.earn : URLs.bing.origin, {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            })
            .catch(error => {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN',
                    `Rewards navigation after login postback did not finish cleanly: ${error instanceof Error ? error.message : String(error)}`
                )
            })
        await this.bot.utils.wait(1000)
    }

    private async finalizeLogin(page: Page, account: Account) {
        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Finalizing login')

        await page.goto(REWARDS_BASE_URL, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {})

        const rewardsLanding = new URL(page.url())
        const rewardsHostname = rewardsLanding.hostname.toLowerCase()
        const loginRewardsSuccess = rewardsHostname === 'bing.com' || rewardsHostname.endsWith('.bing.com')
        if (loginRewardsSuccess) {
            if (rewardsHostname === 'rewards.bing.com') {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Logged into Microsoft Rewards successfully')
            } else {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN',
                    `Rewards sign-in redirected to Bing home (${rewardsHostname}); continuing verification`
                )
            }
        } else {
            this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'Could not verify Rewards Dashboard, assuming login valid')
        }

        // Dismiss at rewards dashboard
        await this.bot.browser.utils.tryDismissAllMessages(page).catch(() => {})
        await runRewardsOnboarding(this.bot, page, account.newAccountMode === true)

        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Starting Bing session verification')
        const bingVerified = await this.verifyBingSession(page, account)
        if (!bingVerified)
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-BING',
                'Rewards sign-in is available, but Bing sign-in is unverified; app authorization is checked separately'
            )

        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Acquiring rewards context')
        await this.getRewardsSession(page)

        const context = page.context()
        const storageState = await context.storageState()
        this.bot.logger.debug(
            this.bot.isMobile,
            'LOGIN',
            `Saving session | cookies=${storageState.cookies.length} | origins=${storageState.origins.length}`
        )
        saveStorageState(this.bot.config.sessionPath, account.email, this.bot.isMobile, storageState)

        await configureMediaBlocking(this.bot, context)
        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Login completed, session saved')
    }

    private async hasStoredAuthCookies(page: Page): Promise<boolean> {
        return page
            .context()
            .cookies([URLs.rewards.origin, URLs.bing.origin])
            .then(cookies =>
                cookies.some(cookie => ['_U', 'RPSSecAuth'].includes(cookie.name) && Boolean(cookie.value))
            )
            .catch(() => false)
    }

    private async hasAuthenticatedBingSession(page: Page): Promise<boolean> {
        const cookies = await page
            .context()
            .cookies([URLs.bing.origin])
            .catch(() => [])
        if (!cookies.some(cookie => cookie.name === '_U' && Boolean(cookie.value))) return false
        const profile = await page
            .waitForSelector(this.selectors.bingProfile, { timeout: 1500 })
            .then(() => true)
            .catch(() => false)
        if (profile) return true

        // The mobile Bing homepage omits #id_n. Validate the same cookie jar
        // against the existing flyout endpoint rather than forcing a new login.
        try {
            const response = await page.request.get(URLs.bing.rewardsFlyoutUserInfo, { timeout: 5000 })
            if (response.status() !== 200) return false
            const result: RewardsFlyoutData = await response.json()
            mapFlyoutToDashboard(result)
            return true
        } catch {
            return false
        }
    }

    async verifyBingSession(page: Page, account: Account) {
        const url = URLs.auth.bingSignIn
        const loopMax = 5

        this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', 'Verifying Bing session')

        try {
            // Manual sessions open Rewards directly. Do not force a fresh interactive
            // Bing sign-in when the stored browser session is already authenticated.
            await page.goto(URLs.bing.origin, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {})
            const landing = new URL(page.url())
            const bingLanding =
                (landing.hostname === 'bing.com' || landing.hostname.endsWith('.bing.com')) &&
                landing.hostname !== 'rewards.bing.com'
            if (bingLanding) {
                if (await this.hasAuthenticatedBingSession(page)) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'LOGIN-BING',
                        'Bing session verified from existing browser session'
                    )
                    return true
                }
            }
            if (page.isClosed()) return false
            await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {})

            for (let i = 0; i < loopMax; i++) {
                if (page.isClosed()) break

                this.bot.logger.debug(this.bot.isMobile, 'LOGIN-BING', `Verification loop ${i + 1}/${loopMax}`)

                if (isAccountReviewUrl(page.url())) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-BING',
                        'Bing authorization redirected to account.live.com/Abuse; stopping this sign-in attempt without classifying the Rewards session as locked'
                    )
                    return false
                }
                const u = new URL(page.url())
                const hostname = u.hostname.toLowerCase()
                const atBingPage =
                    (hostname === 'bing.com' || hostname.endsWith('.bing.com')) && hostname !== 'rewards.bing.com'
                if (!atBingPage) {
                    const state = await this.detectCurrentState(page)
                    if (state === 'PASSKEY_ERROR') {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', 'Dismissing Passkey error state')
                        await this.bot.browser.utils.ghostClick(page, this.selectors.secondaryButton)
                    }

                    await this.handleState(state, page, account)
                }

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN-BING',
                    `At Bing page: ${atBingPage} (${hostname}${u.pathname})`
                )

                if (atBingPage) {
                    await this.bot.browser.utils.tryDismissAllMessages(page).catch(() => {})

                    const signedIn = await this.hasAuthenticatedBingSession(page)

                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN-BING', `Profile element found: ${signedIn}`)

                    if (signedIn) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', 'Bing session verified successfully')
                        return true
                    }
                }

                await this.bot.utils.wait(1000)
            }

            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-BING',
                'Could not verify Bing session; Rewards and app authorization remain separate'
            )
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-BING',
                `Verification error: ${error instanceof Error ? error.message : String(error)}`
            )
        }
        return false
    }

    private async getRewardsSession(page: Page) {
        this.bot.logger.info(this.bot.isMobile, 'GET-REWARD-SESSION', 'Bootstrapping rewards context')

        try {
            await this.bot.browser.func.bootstrap(page)

            const actionsCount = Object.keys(this.bot.nextActions).length
            const snapshot = this.bot.reactSnapshot
            const reportableCount = snapshot?.reportable.length ?? 0
            const availablePoints = snapshot?.account.availablePoints ?? null

            if (!actionsCount) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'GET-REWARD-SESSION',
                    'No action ids resolved - server-action calls (report/streak protection) will be skipped this run'
                )
            }

            if (!snapshot || !snapshot.offers.length) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'GET-REWARD-SESSION',
                    'Page snapshot empty - neither /earn nor /dashboard rendered a usable RSC payload'
                )
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'GET-REWARD-SESSION',
                `Context ready | actions=${actionsCount} | reportable=${reportableCount} | available=${availablePoints}`
            )
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)

            this.bot.logger.error(
                this.bot.isMobile,
                'GET-REWARD-SESSION',
                `Failed to acquire rewards context: ${message}`
            )

            throw new Error(`Failed to acquire rewards context: ${message}`)
        }
    }

    async getAppAccessToken(page: Page, email: string) {
        this.bot.logger.info(this.bot.isMobile, 'GET-APP-TOKEN', 'Requesting mobile access token')
        return await new MobileAccessLogin(this.bot, page).get(email)
    }
}
