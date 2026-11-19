import type { Page } from 'patchright'

export type LoginState =
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

export type SignInMethodOption = {
    index: number
    selector: string
    label: string
    signature: string
}

export type SignInMethodType = 'PASSWORD' | 'AUTHENTICATOR' | 'EMAIL' | 'PASSKEY' | 'TOTP' | 'UNKNOWN'

export const LOGIN_SELECTORS = {
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
    otpCodeInput:
        '[data-testid="codeEntry"] input, [data-testid="codeInputWrapper"] input, input[id="otc-confirmation-input"], input[name="otc"]',
    passwordSwitchToCode: '#otcLoginLink, #idA_PWD_SwitchToOTC, #idA_PWD_SwitchToCredPicker',
    backButton: '#back-button',
    bingProfile: '#id_n',
    microsoftAccountProfile:
        '#mectrl_currentAccount_primary, [data-testid="account-card"], [data-testid="user-avatar"]',
    otpInput: 'div[data-testid="codeEntry"]'
} as const

export type LoginSelectors = typeof LOGIN_SELECTORS

export function normalizeSignInText(value: string): string {
    return value.replace(/\s+/g, ' ').trim()
}

export function sanitizeSignInLabel(value: string): string {
    return normalizeSignInText(value)
        .replace(/[\w.+*-]+@[\w.-]+\.[a-z]{2,}/gi, '<email>')
        .replace(/\+?\d[\d\s().*-]{5,}\d/g, '<phone>')
}

export function classifySignInMethod(option: SignInMethodOption): SignInMethodType {
    const signature = option.signature

    if (signature.includes('m5.25 4h13.5a3.25') || signature.includes('picker_verify_email')) return 'EMAIL'
    if (signature.includes('m11.78 10.22a.75')) return 'PASSWORD'
    if (/picker_fido|passkey|fido|m18 16\.66a3\.51/.test(signature)) return 'PASSKEY'
    if (/phone[\s_-]*app[\s_-]*otp|\btotp\b/.test(signature)) return 'TOTP'
    if (
        /remote[\s_-]*ngc|picker_remote_ngc|phone[\s_-]*app[\s_-]*notification|push[\s_-]*notification|m15\.75 2c16\.99 2 18 3/.test(
            signature
        )
    ) {
        return 'AUTHENTICATOR'
    }

    if (
        !/\b(?:sms|text\s+message|phone\s+call|tin\s+nhắn)\b/i.test(option.label) &&
        (/\b(?:email\s+(?:a\s+)?code|send\s+(?:a\s+)?code\s+to)\b/i.test(option.label) ||
            /(?:gửi\s+mã\s+(?:đến|qua)|nhận\s+mã\s+qua\s+email)/i.test(option.label) ||
            (option.label.includes('@') && /(?:code|mã)/i.test(option.label)))
    ) {
        return 'EMAIL'
    }

    return 'UNKNOWN'
}

export async function getSignInMethodOptions(
    page: Page,
    signInTileSelector: string = LOGIN_SELECTORS.signInTile
): Promise<SignInMethodOption[]> {
    const tiles = page.locator(signInTileSelector)
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

            const label = normalizeSignInText(`${metadata.text} ${metadata.accessibleText}`)
            const signature = normalizeSignInText(metadata.structuralAttributes).toLowerCase()

            return {
                index,
                selector: `${signInTileSelector} >> nth=${index}`,
                label: label || `Sign-in option ${index + 1}`,
                signature
            }
        })
    )

    return options.filter((option): option is SignInMethodOption => option !== null)
}
