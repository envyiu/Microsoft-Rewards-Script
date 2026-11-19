import type { Page } from 'patchright'
import type { Account } from '../../interface/Account'
import type { Login } from './Login'
import {
    classifySignInMethod,
    getSignInMethodOptions,
    sanitizeSignInLabel,
    type SignInMethodOption
} from './LoginSelectors'
import { matchesMaskedEmailHint, pollFviaInboxesCode } from './methods/FviaInboxesMail'
import { canPromptForInput, getSubtitleMessage } from './methods/LoginUtils'

export async function clickSignInMethodOption(host: Login, page: Page, option: SignInMethodOption): Promise<boolean> {
    const ghostClicked = await host.bot.browser.utils.ghostClick(page, option.selector)
    if (ghostClicked) return true

    return page
        .locator(host.selectors.signInTile)
        .nth(option.index)
        .click()
        .then(() => true)
        .catch(() => false)
}

export async function handleTotp2Fa(host: Login, page: Page, account: Account): Promise<boolean> {
    host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'TOTP 2FA authentication required')
    await host.totp2FALogin.handle(page, account.totpSecret)
    host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'TOTP 2FA handler completed successfully')
    return true
}

interface PasswordSwitchCandidate {
    selector: string
    locator: ReturnType<Page['locator']>
    priority: 1 | 2
}

const PASSWORD_SWITCH_IGNORE_REGEX = /forgot|reset|quên\s*mật\s*khẩu|đặt\s*lại/i
const PASSWORD_SWITCH_DIRECT_CODE_REGEX = /email.*code|send.*code|use.*code|gửi\s*mã|nhận\s*mã|@|fviainboxes/i
const PASSWORD_SWITCH_OTHER_WAYS_REGEX =
    /other\s*ways|sign\s*in\s*another\s*way|another\s*way|cách\s*khác|tùy\s*chọn\s*đăng\s*nhập/i

async function isSelectorQuickVisible(page: Page, selector: string): Promise<boolean> {
    if (typeof page.locator === 'function') {
        const visible = await page
            .locator(selector)
            .first()
            .isVisible()
            .catch(() => null)
        if (typeof visible === 'boolean') return visible
    }
    return page
        .waitForSelector(selector, { state: 'visible', timeout: 250 })
        .then(() => true)
        .catch(() => false)
}

function recordVerificationOutcomeIfActive(host: Login): void {
    if (host.bot.normalSession?.active) {
        host.bot.normalSession.recordScopedOutcome('account', 'verification')
        host.bot.logger.warn(host.bot.isMobile, 'LOGIN', 'verification required: Microsoft sign-in challenge')
    }
}

export async function trySwitchPasswordToEmailCode(host: Login, page: Page, account: Account): Promise<boolean> {
    if (typeof page.locator !== 'function') return false

    const candidates: PasswordSwitchCandidate[] = []

    const footerActions = page.locator(host.selectors.footerAction)
    const footerCount = await footerActions.count().catch(() => 0)
    for (let index = 0; index < footerCount; index++) {
        const locator = footerActions.nth(index)
        if (!(await locator.isVisible().catch(() => false))) continue
        const text = (await locator.innerText({ timeout: 200 }).catch(() => '')).trim()
        if (!text || PASSWORD_SWITCH_IGNORE_REGEX.test(text)) continue
        if (PASSWORD_SWITCH_DIRECT_CODE_REGEX.test(text)) {
            candidates.push({ selector: `${host.selectors.footerAction} >> nth=${index}`, locator, priority: 1 })
        } else if (PASSWORD_SWITCH_OTHER_WAYS_REGEX.test(text)) {
            candidates.push({ selector: `${host.selectors.footerAction} >> nth=${index}`, locator, priority: 2 })
        }
    }

    for (const legacySelector of ['#otcLoginLink', '#idA_PWD_SwitchToOTC', '#idA_PWD_SwitchToCredPicker']) {
        const locator = page.locator(legacySelector).first()
        if (!(await locator.isVisible().catch(() => false))) continue
        const text = (await locator.innerText({ timeout: 200 }).catch(() => '')).trim()
        if (text && PASSWORD_SWITCH_IGNORE_REGEX.test(text)) continue
        const priority: 1 | 2 = legacySelector === '#idA_PWD_SwitchToCredPicker' ? 2 : 1
        candidates.push({ selector: legacySelector, locator, priority })
    }

    candidates.sort((a, b) => a.priority - b.priority)
    const chosen = candidates[0]
    if (!chosen) return false

    host.bot.logger.info(
        host.bot.isMobile,
        'LOGIN',
        chosen.priority === 1
            ? 'Switching from password prompt directly to email-code sign-in'
            : 'Opening alternative sign-in methods to prefer email-code over password'
    )

    if (chosen.priority === 1) {
        await host.prepareEmailCodeRequest(account)
    }

    const clicked = host.bot.browser?.utils?.ghostClick
        ? await host.bot.browser.utils.ghostClick(page, chosen.selector)
        : false
    const finalClicked =
        clicked ||
        (await chosen.locator
            .click()
            .then(() => true)
            .catch(() => false))
    if (!finalClicked) return false

    await host.waitForIdle(page, 'after password-to-code switch')
    return !(await isSelectorQuickVisible(page, host.selectors.passwordEntry))
}

function selectPreferredEmailOption(
    emailOptions: SignInMethodOption[],
    recoveryEmail: string
): SignInMethodOption | null {
    const withHintMatch = emailOptions.find(
        option => option.label.includes('@') && matchesMaskedEmailHint(recoveryEmail, option.label)
    )
    if (withHintMatch) return withHintMatch

    const genericOption = emailOptions.find(option => !option.label.includes('@'))
    if (genericOption) return genericOption

    return null
}

export async function handleSignInMethodPicker(host: Login, page: Page, account: Account): Promise<boolean> {
    const options = await getSignInMethodOptions(page, host.selectors.signInTile)
    if (!host.signInMethodsLogged) {
        host.signInMethodsLogged = true
        if (options.length > 0) {
            const labels = options.map(option => sanitizeSignInLabel(option.label))
            host.bot.logger.info(host.bot.isMobile, 'LOGIN', `Available sign-in methods: ${labels.join(' | ')}`)
        }
    }

    const methods = options.map(option => ({ option, type: classifySignInMethod(option) }))
    const passwordOption = methods.find(method => method.type === 'PASSWORD')?.option
    const authenticatorOption = methods.find(method => method.type === 'AUTHENTICATOR')?.option
    const emailOptions = methods.filter(method => method.type === 'EMAIL').map(method => method.option)
    const emailOption = emailOptions[0]

    if (host.preferEmailCodeOverPassword && host.canAutoHandleEmailCode()) {
        const preferredEmailOption = selectPreferredEmailOption(emailOptions, account.recoveryEmail)
        const emailIconOldFound =
            preferredEmailOption || emailOptions.length > 0
                ? false
                : await host.checkSelector(page, host.selectors.emailIconOld)

        if (preferredEmailOption || emailIconOldFound) {
            host.bot.logger.info(
                host.bot.isMobile,
                'LOGIN',
                'Preferring email-code sign-in over password for fviainboxes recovery email'
            )
            host.passwordlessMethodSelected = false
            await host.prepareEmailCodeRequest(account)

            const clicked = preferredEmailOption
                ? await clickSignInMethodOption(host, page, preferredEmailOption)
                : await host.bot.browser.utils.ghostClick(page, host.selectors.emailIconOld)

            if (!clicked) {
                host.bot.logger.warn(host.bot.isMobile, 'LOGIN', 'Could not select email-code sign-in method')
                return false
            }

            await host.waitForIdle(page, 'after email method selection')
            return true
        }

        host.bot.logger.info(
            host.bot.isMobile,
            'LOGIN',
            'No matching fviainboxes email sign-in method available; falling back to standard methods'
        )
        host.preferEmailCodeOverPassword = false
    }

    if (account.password && passwordOption) {
        host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Password sign-in is available; selecting it')
        host.passwordlessMethodSelected = false

        if (!(await clickSignInMethodOption(host, page, passwordOption))) {
            host.bot.logger.warn(host.bot.isMobile, 'LOGIN', 'Could not select password sign-in method')
            return false
        }

        await host.waitForIdle(page, 'after password method selection')
        return true
    }

    const passwordlessOptionOldFound = await host.checkSelector(page, host.selectors.passwordlessOptionOld)
    if (authenticatorOption || passwordlessOptionOldFound) {
        host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Selecting Microsoft Authenticator sign-in')
        host.passwordlessMethodSelected = true

        const clicked = authenticatorOption
            ? await clickSignInMethodOption(host, page, authenticatorOption)
            : await host.bot.browser.utils.ghostClick(page, host.selectors.passwordlessOptionOld)

        if (!clicked) {
            host.passwordlessMethodSelected = false
            host.bot.logger.warn(host.bot.isMobile, 'LOGIN', 'Could not select Microsoft Authenticator')
            return false
        }

        await host.waitForIdle(page, 'after Microsoft Authenticator selection')

        const passwordlessChallengeVisible =
            (await host.checkSelector(page, host.selectors.passwordlessCheck)) ||
            (await host.checkSelector(page, host.selectors.passwordlessNumber))

        if (!passwordlessChallengeVisible && (await host.checkSelector(page, host.selectors.primaryButton))) {
            host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Sending Microsoft Authenticator request')
            const confirmed = await host.bot.browser.utils.ghostClick(page, host.selectors.primaryButton)
            if (!confirmed) {
                host.passwordlessMethodSelected = false
                host.bot.logger.warn(host.bot.isMobile, 'LOGIN', 'Could not send Microsoft Authenticator request')
                return false
            }
            await host.waitForIdle(page, 'after Microsoft Authenticator request')
        }

        return true
    }

    const emailIconOldFound = await host.checkSelector(page, host.selectors.emailIconOld)
    if (emailOption || emailIconOldFound) {
        if (!canPromptForInput()) {
            host.bot.logger.error(
                host.bot.isMobile,
                'LOGIN',
                'No supported non-interactive sign-in method is available; email-code fallback requires interactive stdin'
            )
            return false
        }

        host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Selecting email-code sign-in')
        host.passwordlessMethodSelected = false

        const clicked = emailOption
            ? await clickSignInMethodOption(host, page, emailOption)
            : await host.bot.browser.utils.ghostClick(page, host.selectors.emailIconOld)

        if (!clicked) {
            host.bot.logger.warn(host.bot.isMobile, 'LOGIN', 'Could not select email-code sign-in method')
            return false
        }

        await host.waitForIdle(page, 'after email method selection')
        await host.codeLogin.handle(page)
        return true
    }

    const ignoredMethods = methods
        .map(method => method.type)
        .filter(type => type === 'PASSKEY' || type === 'TOTP' || type === 'UNKNOWN')

    host.bot.logger.error(
        host.bot.isMobile,
        'LOGIN',
        `No supported sign-in method available${ignoredMethods.length ? `; ignored=${ignoredMethods.join(',')}` : ''}`
    )
    return false
}

async function tryEmailVerificationAlternativesFallback(host: Login, page: Page, account: Account): Promise<boolean> {
    if (!account.password) {
        if (!canPromptForInput()) {
            host.bot.logger.error(
                host.bot.isMobile,
                'LOGIN',
                'Email verification requires a configured password or interactive stdin'
            )
            return false
        }

        host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Email verification input detected')
        await host.codeLogin.handle(page)
        return true
    }

    host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Email verification input detected; checking alternatives')
    await host.waitForIdle(page, 'on email verification page')

    const footerActions = page.locator(host.selectors.footerAction)
    const footerCount = await footerActions.count().catch(() => 0)

    for (let index = 0; index < footerCount; index++) {
        const selector = `${host.selectors.footerAction} >> nth=${index}`
        if (
            !(await footerActions
                .nth(index)
                .isVisible()
                .catch(() => false))
        )
            continue
        if (!(await host.bot.browser.utils.ghostClick(page, selector))) continue

        await host.waitForIdle(page, 'after email verification alternative')

        if (await host.checkSelector(page, host.selectors.passwordEntry)) {
            host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Password sign-in option selected')
            return true
        }

        if (await host.checkSelector(page, host.selectors.signInTile)) {
            host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Sign-in method picker opened')
            return true
        }

        if (!(await host.tryClick(page, host.selectors.backButton, 'Back button'))) break
        if (!(await host.checkSelector(page, host.selectors.emailVerificationInput))) break
    }

    if (canPromptForInput()) {
        host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Falling back to interactive email verification')
        await host.codeLogin.handle(page)
        return true
    }

    host.bot.logger.warn(host.bot.isMobile, 'LOGIN', 'No usable email verification alternative found')
    return false
}

export async function handleAutoRecoveryEmail(host: Login, page: Page, account: Account): Promise<boolean> {
    await host.waitForIdle(page, 'on recovery page')

    const subtitle = await getSubtitleMessage(page).catch(() => null)
    if (!matchesMaskedEmailHint(account.recoveryEmail, subtitle)) {
        host.bot.logger.warn(
            host.bot.isMobile,
            'LOGIN',
            'Verification destination hint does not match fviainboxes recovery email; falling back'
        )
        host.fviaAutoCodeFailed = true
        host.preferEmailCodeOverPassword = false
        if (!host.passwordAttempted && account.password) {
            if (await tryEmailVerificationAlternativesFallback(host, page, account)) return true
        }
        recordVerificationOutcomeIfActive(host)
        return false
    }

    await host.prepareEmailCodeRequest(account)
    const submitted = await host.recoveryLogin.fillAndSubmitEmail(page, account.recoveryEmail)
    if (submitted.ok) {
        host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Submitted fviainboxes recovery email for verification code')
        return true
    }

    host.bot.logger.warn(
        host.bot.isMobile,
        'LOGIN',
        `Failed to submit recovery email${submitted.error ? `: ${sanitizeSignInLabel(submitted.error)}` : ''}`
    )
    host.fviaAutoCodeFailed = true
    host.preferEmailCodeOverPassword = false
    if (!host.passwordAttempted && account.password) {
        if (await tryEmailVerificationAlternativesFallback(host, page, account)) return true
    }
    recordVerificationOutcomeIfActive(host)
    return false
}

export async function handleEmailVerificationAlternatives(host: Login, page: Page, account: Account): Promise<boolean> {
    if (host.canAutoHandleEmailCode()) {
        return handleAutoRecoveryEmail(host, page, account)
    }
    return tryEmailVerificationAlternativesFallback(host, page, account)
}

async function escapeOtpCodeEntry(host: Login, page: Page): Promise<boolean> {
    host.bot.logger.info(
        host.bot.isMobile,
        'LOGIN',
        'OTP code entry page detected; trying an available alternative sign-in method'
    )

    if (await host.checkSelector(page, host.selectors.footerAction)) {
        const clicked = await host.bot.browser.utils.ghostClick(page, host.selectors.footerAction)
        if (clicked) {
            await host.waitForIdle(page, 'after OTP alternative sign-in action')

            const stillOnOtp = await isSelectorQuickVisible(page, host.selectors.otpCodeEntry)
            if (!stillOnOtp) {
                const methodPickerVisible =
                    (await host.checkSelector(page, host.selectors.signInTile)) ||
                    (await host.checkSelector(page, host.selectors.passwordlessOptionOld)) ||
                    (await host.checkSelector(page, host.selectors.emailIconOld))
                const passwordEntryVisible = await host.checkSelector(page, host.selectors.passwordEntry)
                const passwordlessLandingVisible =
                    (await host.checkSelector(page, host.selectors.passwordlessCheck)) ||
                    (await host.checkSelector(page, host.selectors.passwordlessNumber)) ||
                    (!passwordEntryVisible &&
                        (await host.checkSelector(page, host.selectors.identityBanner)) &&
                        (await host.checkSelector(page, host.selectors.primaryButton)))

                host.passwordlessMethodSelected = passwordlessLandingVisible
                host.bot.logger.info(
                    host.bot.isMobile,
                    'LOGIN',
                    methodPickerVisible
                        ? 'Returned to sign-in method selection'
                        : passwordEntryVisible
                          ? 'Switched to password sign-in'
                          : passwordlessLandingVisible
                            ? 'Switched to Microsoft Authenticator sign-in'
                            : 'Switched away from email-code authentication'
                )
                return true
            }

            host.bot.logger.debug(
                host.bot.isMobile,
                'LOGIN',
                'OTP footer action did not leave the code-entry page; falling back to Back'
            )
        }
    }

    host.passwordlessMethodSelected = false
    if (!(await host.tryClick(page, host.selectors.backButton, 'Back button'))) {
        host.bot.logger.warn(host.bot.isMobile, 'LOGIN', 'No usable alternative action found on OTP page')
        return false
    }

    return true
}

async function failOverOtpToPasswordOrHold(host: Login, page: Page, account: Account): Promise<boolean> {
    host.fviaAutoCodeFailed = true
    host.preferEmailCodeOverPassword = false
    if (!host.passwordAttempted && account.password) {
        host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Falling back from fviainboxes OTP to password/alternative')
        if (await escapeOtpCodeEntry(host, page)) return true
    }
    recordVerificationOutcomeIfActive(host)
    return false
}

export async function handleOtpCodeEntry(host: Login, page: Page, account?: Account): Promise<boolean> {
    if (!account || !host.canAutoHandleEmailCode()) {
        return escapeOtpCodeEntry(host, page)
    }

    const subtitle = await getSubtitleMessage(page).catch(() => null)
    if (!matchesMaskedEmailHint(account.recoveryEmail, subtitle)) {
        host.bot.logger.warn(
            host.bot.isMobile,
            'LOGIN',
            'OTP destination hint does not match fviainboxes recovery email; falling back'
        )
        return failOverOtpToPasswordOrHold(host, page, account)
    }

    host.emailCodeAttempts++
    if (host.emailCodeAttempts > 2) {
        host.bot.logger.warn(host.bot.isMobile, 'LOGIN', 'Exceeded maximum fviainboxes OTP attempts; falling back')
        return failOverOtpToPasswordOrHold(host, page, account)
    }

    host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'OTP code entry detected; polling fviainboxes for code')
    const pollResult = await pollFviaInboxesCode({
        address: account.recoveryEmail,
        sinceMs: host.emailCodeRequestedAtMs ?? host.loginStartedAtMs,
        knownMessageIds: host.emailCodeKnownMessageIds,
        shouldAbort: () => Boolean(host.bot.shuttingDown) || page.isClosed(),
        onWaitLog: remainingSeconds => {
            host.bot.logger.debug(
                host.bot.isMobile,
                'LOGIN-CODE',
                `Waiting for fviainboxes OTP code (${remainingSeconds}s remaining)`
            )
        },
        fetchImpl: host.fviaFetchImpl,
        ...host.fviaPollOptions
    })

    if (host.bot.shuttingDown) throw new Error('Login interrupted by session checkpoint')
    if (page.isClosed()) throw new Error('Page closed unexpectedly')

    if (!pollResult) {
        host.bot.logger.warn(host.bot.isMobile, 'LOGIN', 'Timed out waiting for verification code from fviainboxes')
        return failOverOtpToPasswordOrHold(host, page, account)
    }

    if (pollResult.messageId) {
        host.emailCodeKnownMessageIds.add(pollResult.messageId)
    }
    host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Received verification code from fviainboxes; submitting')

    const submitted = await host.codeLogin.submitCode(page, pollResult.code)
    if (submitted.ok) {
        host.bot.logger.info(host.bot.isMobile, 'LOGIN', 'Verification code submitted successfully')
        return true
    }

    host.bot.logger.warn(
        host.bot.isMobile,
        'LOGIN',
        `Verification code rejected${submitted.error ? `: ${sanitizeSignInLabel(submitted.error)}` : ''}`
    )
    await host.codeLogin.clearCodeInputs(page)

    if (host.emailCodeAttempts < 2) {
        return true
    }

    return failOverOtpToPasswordOrHold(host, page, account)
}
