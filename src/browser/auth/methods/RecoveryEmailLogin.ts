import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../../index'
import { canPromptForInput, getErrorMessage, promptInput } from './LoginUtils'

export class RecoveryLogin {
    private readonly emailInputSelectors = [
        'input#proof-confirmation-email-input',
        '[data-testid="proof-confirmation"]',
        'input#iProofEmail',
        'input[name="iProofEmail"]'
    ] as const
    private readonly submitButtonSelector =
        'button[data-testid="primaryButton"], button[type="submit"], input[type="submit"], #iSelectProofAction, #iNext'
    private readonly textInputSelector = '[data-testid="proof-confirmation"]'
    private readonly maxManualSeconds = 60
    private readonly maxManualAttempts = 5

    constructor(private bot: MicrosoftRewardsBot) {}

    private async findEmailInput(page: Page) {
        for (const selector of this.emailInputSelectors) {
            const visibleElement = await page
                .waitForSelector(selector, { state: 'visible', timeout: 500 })
                .catch(() => null)
            if (!visibleElement) continue

            if (selector !== 'input#proof-confirmation-email-input' && typeof page.locator === 'function') {
                const nestedInput = page.locator(`${selector} input`).first()
                if (await nestedInput.isVisible().catch(() => false)) {
                    return { element: nestedInput, selector: `${selector} input` }
                }
            }

            return { element: visibleElement, selector }
        }
        return null
    }

    private async submitEmailForm(page: Page): Promise<void> {
        const submitVisible = await page
            .waitForSelector(this.submitButtonSelector, { state: 'visible', timeout: 500 })
            .catch(() => null)
        if (submitVisible) {
            const ghostClicked = this.bot.browser?.utils?.ghostClick
                ? await this.bot.browser.utils.ghostClick(page, this.submitButtonSelector)
                : false
            if (ghostClicked) return
            if (typeof submitVisible.click === 'function') {
                await submitVisible.click({ timeout: 1000 }).catch(() => {})
                return
            }
        }
        await page.keyboard?.press?.('Enter')
    }

    private async fillEmail(page: Page, email: string): Promise<boolean> {
        try {
            this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Filling recovery email')

            const found = await this.findEmailInput(page)
            if (found) {
                const target = found.element as {
                    click?: () => Promise<void>
                    fill?: (value: string) => Promise<void>
                }
                await target.click?.().catch(() => {})
                await target.fill?.('').catch(() => {})
                if (typeof page.keyboard?.type === 'function') {
                    await page.keyboard.type(email, { delay: 50 })
                } else if (typeof target.fill === 'function') {
                    await target.fill(email)
                } else {
                    return false
                }
                await this.submitEmailForm(page)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Successfully filled email input field')
                return true
            }

            this.bot.logger.warn(this.bot.isMobile, 'LOGIN-RECOVERY', 'Recovery email input field not found')
            return false
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-RECOVERY',
                `Failed to fill email input: ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    async fillAndSubmitEmail(page: Page, email: string): Promise<{ ok: boolean; error?: string }> {
        const filled = await this.fillEmail(page, email)
        if (!filled) {
            return { ok: false, error: 'Email input field not found' }
        }

        this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Waiting for page response')
        await this.bot.utils.wait(500)
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
            this.bot.logger.debug(this.bot.isMobile, 'LOGIN-RECOVERY', 'Network idle timeout reached')
        })

        const errorMessage = await getErrorMessage(page)
        if (errorMessage) {
            return { ok: false, error: errorMessage }
        }

        return { ok: true }
    }

    async handle(page: Page, recoveryEmail: string): Promise<void> {
        try {
            this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Email recovery authentication flow initiated')

            if (recoveryEmail) {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Using configured recovery email')

                const result = await this.fillAndSubmitEmail(page, recoveryEmail)
                if (!result.ok) {
                    throw new Error(
                        result.error === 'Email input field not found'
                            ? 'Email input field not found'
                            : `Email verification failed: ${result.error}`
                    )
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Email authentication completed successfully')
                return
            }

            if (!canPromptForInput()) {
                throw new Error('Recovery email is required because interactive stdin is unavailable')
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'LOGIN-RECOVERY',
                'No recovery email provided, will prompt user for input'
            )

            for (let attempt = 1; attempt <= this.maxManualAttempts; attempt++) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN-RECOVERY',
                    `Starting attempt ${attempt}/${this.maxManualAttempts}`
                )

                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN-RECOVERY',
                    `Prompting user for email input (timeout: ${this.maxManualSeconds}s)`
                )

                const email = await promptInput({
                    question: `Recovery email (waiting ${this.maxManualSeconds}s): `,
                    timeoutSeconds: this.maxManualSeconds,
                    validate: email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
                })

                if (!email) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-RECOVERY',
                        `No or invalid email input received (attempt ${attempt}/${this.maxManualAttempts})`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('Manual email input failed: no input received')
                    }
                    continue
                }

                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-RECOVERY',
                        `Invalid email format received (attempt ${attempt}/${this.maxManualAttempts}) | length=${email.length}`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('Manual email input failed: invalid format')
                    }
                    continue
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Valid recovery email received from user')

                const filled = await this.fillEmail(page, email)
                if (!filled) {
                    this.bot.logger.error(
                        this.bot.isMobile,
                        'LOGIN-RECOVERY',
                        `Failed to fill email input field (attempt ${attempt}/${this.maxManualAttempts})`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('Email input field not found after maximum attempts')
                    }

                    await this.bot.utils.wait(1000)
                    continue
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Waiting for page response')
                await this.bot.utils.wait(500)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN-RECOVERY', 'Network idle timeout reached')
                })

                const errorMessage = await getErrorMessage(page)
                if (errorMessage) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-RECOVERY',
                        `Error from page: "${errorMessage}" (attempt ${attempt}/${this.maxManualAttempts})`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error(`Maximum attempts reached. Last error: ${errorMessage}`)
                    }

                    this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Clearing input field for retry')
                    const inputToClear = await page.$(this.textInputSelector).catch(() => null)
                    if (inputToClear) {
                        await inputToClear.click()
                        await page.keyboard.press('Control+A')
                        await page.keyboard.press('Backspace')
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Input field cleared')
                    } else {
                        this.bot.logger.warn(this.bot.isMobile, 'LOGIN-RECOVERY', 'Could not find input field to clear')
                    }

                    await this.bot.utils.wait(1000)
                    continue
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Email authentication completed successfully')
                return
            }

            throw new Error(`Email input failed after ${this.maxManualAttempts} attempts`)
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            this.bot.logger.error(this.bot.isMobile, 'LOGIN-RECOVERY', `Fatal error: ${errorMsg}`)
            throw error
        }
    }
}
