import type { Page } from 'patchright'
import { URLs } from '../../constants/urls'
import type { MicrosoftRewardsBot } from '../../index'
import type { Account } from '../../interface/Account'
import { saveStorageState } from '../../util/SessionStore'
import { emitRuntimeEvent } from '../../util/RuntimeEvents'
import { configureMediaBlocking, suspendMediaBlocking } from '../MediaBlocker'
import { detectCurrentState, handleLoginState } from './AuthStateMachine'
import { LOGIN_SELECTORS, type LoginSelectors, type LoginState } from './LoginSelectors'
import {
    finalizeLogin,
    hasAuthenticatedBingSession,
    hasAuthenticatedRewardsPayload,
    hasStoredAuthCookies,
    verifyBingSession
} from './SessionVerifier'
import { EmailLogin } from './methods/EmailLogin'
import { isFviaInboxesEmail, snapshotFviaMessageIds } from './methods/FviaInboxesMail'
import { CodeLogin } from './methods/GetACodeLogin'
import { MobileAccessLogin } from './methods/MobileAccessLogin'
import { PasswordlessLogin } from './methods/PasswordlessLogin'
import { RecoveryLogin } from './methods/RecoveryEmailLogin'
import { TotpLogin } from './methods/Totp2FALogin'

export class Login {
    public emailLogin: EmailLogin
    public passwordlessLogin: PasswordlessLogin
    public totp2FALogin: TotpLogin
    public codeLogin: CodeLogin
    public recoveryLogin: RecoveryLogin

    public readonly capturedUnknownUrls = new Set<string>()
    public signInMethodsLogged = false
    public passwordlessMethodSelected = false
    public recoveredRewardsLogin = false
    public unknownRewardsEarnChecks = 0
    public recoveredRewardsEarn = false
    public rewardsLogin = true
    public firstPartyWelcomeActions = 0
    public serviceHost: string | null = null
    public serviceHosts: string[] = []
    public unknownServiceChecks = 0

    public fviaAutoCodeEnabled = false
    public preferEmailCodeOverPassword = false
    public fviaAutoCodeFailed = false
    public emailCodeSwitchedFromPassword = false
    public passwordAttempted = false
    public currentRecoveryEmail = ''
    public loginStartedAtMs = 0
    public emailCodeRequestedAtMs: number | null = null
    public emailCodeKnownMessageIds = new Set<string>()
    public emailCodeSnapshotLoaded = false
    public emailCodeAttempts = 0
    public fviaFetchImpl?: typeof fetch
    public fviaPollOptions?: {
        timeoutMs?: number
        pollIntervalMs?: number
        requestTimeoutMs?: number
        sleep?: (ms: number) => Promise<void>
    }

    public readonly selectors: LoginSelectors = LOGIN_SELECTORS

    constructor(public readonly bot: MicrosoftRewardsBot) {
        this.emailLogin = new EmailLogin(this.bot)
        this.passwordlessLogin = new PasswordlessLogin(this.bot)
        this.totp2FALogin = new TotpLogin(this.bot)
        this.codeLogin = new CodeLogin(this.bot)
        this.recoveryLogin = new RecoveryLogin(this.bot)
    }

    public initAuthFlowState(account?: Partial<Account>): void {
        this.currentRecoveryEmail = account?.recoveryEmail?.trim() ?? ''
        this.fviaAutoCodeEnabled = isFviaInboxesEmail(this.currentRecoveryEmail)
        this.preferEmailCodeOverPassword = this.fviaAutoCodeEnabled
        this.fviaAutoCodeFailed = false
        this.emailCodeSwitchedFromPassword = false
        this.passwordAttempted = false
        this.loginStartedAtMs = Date.now()
        this.emailCodeRequestedAtMs = null
        this.emailCodeKnownMessageIds = new Set<string>()
        this.emailCodeSnapshotLoaded = false
        this.emailCodeAttempts = 0
    }

    public canAutoHandleEmailCode(): boolean {
        return this.fviaAutoCodeEnabled && !this.fviaAutoCodeFailed
    }

    public async prepareEmailCodeRequest(account?: Partial<Account>): Promise<void> {
        const recovery = account?.recoveryEmail?.trim() || this.currentRecoveryEmail
        if (!isFviaInboxesEmail(recovery)) return
        if (!this.emailCodeSnapshotLoaded) {
            const existingIds = await snapshotFviaMessageIds(recovery, { fetchImpl: this.fviaFetchImpl })
            for (const id of existingIds) this.emailCodeKnownMessageIds.add(id)
            this.emailCodeSnapshotLoaded = true
        }
        this.emailCodeRequestedAtMs = Date.now()
    }

    async login(page: Page, account: Account, { rewards = true, startUrl = undefined as string | undefined } = {}) {
        this.rewardsLogin = rewards
        this.firstPartyWelcomeActions = 0
        this.initAuthFlowState(account)
        this.serviceHost = startUrl ? new URL(startUrl).hostname : null
        this.serviceHosts =
            this.serviceHost === 'to-do.live.com'
                ? [
                      'to-do.live.com',
                      'to-do.microsoft.com',
                      'todo.microsoft.com',
                      'todo.cloud.microsoft',
                      'to-do.office.com'
                  ]
                : this.serviceHost
                  ? [this.serviceHost]
                  : []
        this.unknownServiceChecks = 0
        if (
            startUrl &&
            (rewards || !['onedrive.live.com', 'to-do.live.com', 'outlook.live.com'].includes(this.serviceHost || ''))
        ) {
            throw new Error('Unsupported Microsoft service sign-in destination')
        }
        try {
            suspendMediaBlocking(this.bot, page.context())
            this.capturedUnknownUrls.clear()
            this.signInMethodsLogged = false
            this.passwordlessMethodSelected = false
            this.recoveredRewardsLogin = false
            this.unknownRewardsEarnChecks = 0
            this.recoveredRewardsEarn = false
            this.bot.normalSession?.recordLoginAttempt()
            emitRuntimeEvent('authPhase', { phase: 'login' })
            this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Starting login process')

            const hasStoredAuth = await hasStoredAuthCookies(page)
            if (hasStoredAuth) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN',
                    rewards ? 'Checking saved session on Rewards earn page' : 'Checking saved session on Microsoft/Bing'
                )
            }
            const initialUrl = rewards
                ? hasStoredAuth
                    ? URLs.rewards.earn
                    : URLs.rewards.userLogin
                : startUrl || URLs.auth.bingSignIn
            await page.goto(initialUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
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

                this.bot.normalSession?.assertActive()
                const state = await this.detectCurrentState(page)
                if (
                    this.bot.normalSession?.active &&
                    !this.canAutoHandleEmailCode() &&
                    ['EMAIL_VERIFICATION_INPUT', 'RECOVERY_EMAIL_INPUT', 'OTP_CODE_ENTRY'].includes(state)
                ) {
                    this.bot.normalSession.recordScopedOutcome('account', 'verification')
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN',
                        'verification required: Microsoft sign-in challenge'
                    )
                    this.bot.normalSession.assertActive()
                }
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
                this.bot.normalSession?.assertActive()
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
                if (!cookies.some(c => c.name === '_U' && c.value)) {
                    throw new Error('Bing sign-in is not confirmed; manual authentication required')
                }
                saveStorageState(
                    this.bot.config.sessionPath,
                    account.email,
                    this.bot.isMobile,
                    await page.context().storageState()
                )
                await configureMediaBlocking(this.bot, page.context())
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Microsoft/Bing login completed without Rewards')
            }
        } catch (error) {
            if (this.bot.shuttingDown) {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Login interrupted by session checkpoint')
                throw error
            }
            this.bot.normalSession?.observe('LOGIN', error instanceof Error ? error.message : String(error), 'error')
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN',
                `Fatal error: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    public async detectCurrentState(page: Page): Promise<LoginState> {
        return detectCurrentState(this, page)
    }

    public async handleState(state: LoginState, page: Page, account: Account): Promise<boolean> {
        return handleLoginState(this, state, page, account)
    }

    public async finalizeLogin(page: Page, account: Account): Promise<void> {
        return finalizeLogin(this, page, account)
    }

    public async hasAuthenticatedRewardsPayload(page: Page): Promise<boolean> {
        return hasAuthenticatedRewardsPayload(this, page)
    }

    public async hasAuthenticatedBingSession(page: Page): Promise<boolean> {
        return hasAuthenticatedBingSession(this, page)
    }

    public async verifyBingSession(page: Page, account: Account): Promise<boolean> {
        return verifyBingSession(this, page, account)
    }

    public async checkSelector(page: Page, selector: string): Promise<boolean> {
        return page
            .waitForSelector(selector, { state: 'visible', timeout: 5000 })
            .then(() => true)
            .catch(() => false)
    }

    public async waitForIdle(page: Page, note: string, timeout = 5000): Promise<void> {
        await page.waitForLoadState('networkidle', { timeout }).catch(() => {
            this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `Network idle timeout: ${note}`)
        })
    }

    public async tryClick(page: Page, selector: string, label: string, timeout = 2000): Promise<boolean> {
        const found = await page.waitForSelector(selector, { state: 'visible', timeout }).catch(() => null)
        if (!found) return false

        const clicked = await this.bot.browser.utils.ghostClick(page, selector)
        if (!clicked) return false

        await this.waitForIdle(page, `after ${label}`)
        this.bot.logger.info(this.bot.isMobile, 'LOGIN', `${label} clicked`)
        return true
    }

    async getAppAccessToken(page: Page, email: string): Promise<string> {
        this.bot.logger.info(this.bot.isMobile, 'GET-APP-TOKEN', 'Requesting mobile access token')
        return await new MobileAccessLogin(this.bot, page).get(email)
    }
}
