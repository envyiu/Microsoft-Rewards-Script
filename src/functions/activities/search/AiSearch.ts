import type { Frame, Locator, Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../../index'
import { learningEvent, learningQuery } from '../../../util/Learning'
import { waitForActivity, waitForSearch } from '../../../util/ActivityTiming'
import { AiConversation } from './AiConversation'
import { aiSearchChoice, followupQuestion, thirdTurnChoice, type AiChoice } from './AiSearchPolicy'
export { aiSearchChoice, followupQuestion, thirdTurnChoice }

interface Answer {
    text: string
    key: string
    turn: Locator
    scope: Page | Frame
    index: number
}
export interface AiSearchOptions {
    random?: () => number
    initialWaitMs?: number
    followupWaitMs?: number
    totalMs?: number
    pollMs?: number
}
const TURNS = '#b_copilot_search .ca_turn, #b_copilot_results .b_copilot_turn'
const LIKE = 'button.ca_like, [id^="cps_feedback_like_"]'
const DISLIKE = 'button.ca_dislike, [id^="cps_feedback_dislike_"]'
const SUBMIT = ':is(#b_copilot_search .b_copilot_send, #b_copilot_composer_form .b_csb_submit, .b_csb_submit)'

export class AiSearch {
    private deadline = 0
    private expired = false
    private random: () => number
    constructor(
        private bot: MicrosoftRewardsBot,
        private options: AiSearchOptions = {}
    ) {
        this.random = options.random || Math.random
    }

    private active(): void {
        if (this.bot.shuttingDown) throw new Error('New account session interrupted')
        this.bot.normalSession?.assertActive()
    }

    private checkVerificationUrl(page: Page): void {
        let location: URL
        try {
            location = new URL(page.url())
        } catch {
            return
        }
        if (
            /login\.live\.com|account\.live\.com/.test(location.hostname) ||
            /captcha|challenge|\/sorry/i.test(location.pathname)
        ) {
            this.bot.normalSession?.observe('AI-SEARCH', 'Verification required', 'error')
            throw new Error('AI Search requires interactive verification')
        }
    }

    private event(mobile: boolean, stage: string, reason = ''): void {
        this.bot.logger.info(mobile, 'AI-SEARCH', `stage=${stage}${reason ? ` | reason=${reason}` : ''}`)
        learningEvent('activity', {
            task: 'aiSearch',
            stage,
            platform: mobile ? 'mobile' : 'desktop',
            ...(reason ? { error: reason } : {})
        })
    }

    private async answer(page: Page, previous?: Answer): Promise<Answer | null> {
        const end = Math.min(
            this.deadline,
            Date.now() + (previous ? (this.options.followupWaitMs ?? 30000) : (this.options.initialWaitMs ?? 45000))
        )
        let last = '',
            stable = 0
        while (Date.now() < end && !page.isClosed()) {
            this.active()
            this.checkVerificationUrl(page)
            const count = await page.locator(TURNS).evaluateAll(elements => {
                elements.forEach(e => e.removeAttribute('data-msrw-ai-turn'))
                const lastEl = elements.at(-1)
                lastEl?.setAttribute('data-msrw-ai-turn', String(elements.length))
                return elements.length
            })
            if (count) {
                const turn = page.locator(`[data-msrw-ai-turn="${count}"]`).first()
                const key =
                    (await turn.getAttribute('turnid')) ||
                    (await turn.getAttribute('data-turn-id')) ||
                    (await turn.getAttribute('id')) ||
                    String(count)
                const frameCount = await turn.locator('iframe').count()
                const iframe = frameCount
                    ? await turn
                          .locator('iframe')
                          .nth(frameCount - 1)
                          .elementHandle()
                    : null
                const scope: Page | Frame = (await iframe?.contentFrame()) || page
                const root = scope === page ? turn : scope.locator('body')
                const rootError = await root
                    .locator('.error_text, [data-ai-error]')
                    .first()
                    .isVisible()
                    .catch(() => false)
                const turnError =
                    scope !== page &&
                    (await turn
                        .locator('.error_text, [data-ai-error]')
                        .first()
                        .isVisible()
                        .catch(() => false))
                if (rootError || turnError) return null
                const text = await root
                    .evaluate(element => {
                        const candidate = element.querySelector('[data-ai-answer], .cplt_answer, .b_copilot_response')
                        const response =
                            candidate && (candidate.textContent || '').trim().length >= 20 ? candidate : element
                        const copy = response.cloneNode(true) as HTMLElement
                        copy.querySelectorAll(
                            'script,style,button,textarea,nav,aside,.ca_userquery,.b_copilot_user_query,.cht_loading_state,.ca_answer_footer,.cplt_answer_footer,.cht_ans_footer,.ca_feedback_btns,.cps_feedback,.cplt_citations,.cht_cit_src_footer,.b_copilot_references,.b_algo,[data-ai-sources]'
                        ).forEach(e => e.remove())
                        return (copy.textContent || '').replace(/\u00a0/g, ' ').trim()
                    })
                    .catch(() => '')
                const streamingSel =
                    '[aria-busy="true"], [data-streaming="true"], .is-streaming, .cht_loading_state:not(.b_hide)'
                const completedSel =
                    '[data-streaming="false"], [data-ai-complete="true"], .cplt_answer_footer, .ca_answer_footer, .cht_ans_footer'
                const streaming =
                    (await root.locator(streamingSel).count()) +
                    (scope === page ? 0 : await turn.locator(streamingSel).count())
                const stopped = await page.locator('.b_copilot_stop_streaming:visible, .b_csb_stop:visible').count()
                const completed =
                    (await root.locator(completedSel).count()) +
                    (scope === page ? 0 : await turn.locator(completedSel).count())
                const feedback =
                    (await root
                        .locator(LIKE)
                        .first()
                        .isVisible()
                        .catch(() => false)) ||
                    (scope !== page &&
                        (await turn
                            .locator(LIKE)
                            .first()
                            .isVisible()
                            .catch(() => false)))
                const signature = `${key}:${text}`
                stable = signature === last ? stable + 1 : 0
                if (
                    !streaming &&
                    !stopped &&
                    (completed || feedback) &&
                    text.length >= 20 &&
                    (!previous || (key !== previous.key && text !== previous.text)) &&
                    stable >= 2
                ) {
                    return { text, key, turn, scope, index: Number(await turn.getAttribute('turnid')) || count }
                }
                last = signature
            }
            await waitForActivity(this.bot, this.options.pollMs ?? 1000)
        }
        return null
    }

    private async button(answer: Answer, selector: string): Promise<Locator> {
        // A turn has at most one button of each feedback kind. Avoid negative nth
        // counts in iframe locators (Patchright can report last().count() as zero).
        const inside =
            answer.scope === answer.turn.page()
                ? answer.turn.locator(selector).first()
                : answer.scope.locator(selector).first()
        if (await inside.count()) return inside
        if (answer.scope !== answer.turn.page()) {
            const outer = answer.turn.locator(selector).first()
            if (await outer.count()) return outer
        }
        await inside
            .waitFor({ state: 'attached', timeout: Math.max(1, Math.min(1000, this.deadline - Date.now())) })
            .catch(() => {})
        return (await inside.count()) ? inside : answer.turn.locator(selector).first()
    }

    private async click(page: Page, locator: Locator): Promise<boolean> {
        this.active()
        if (this.expired || Date.now() >= this.deadline || !(await locator.count()) || !(await locator.isEnabled()))
            return false
        const handle = await locator.elementHandle()
        if (!handle) return false
        const cursor = this.bot.browser.utils.cursor(page)
        await cursor.scrollIntoView(handle as unknown as Parameters<typeof cursor.scrollIntoView>[0], {
            scrollSpeed: 100,
            scrollDelay: 50
        })
        // Element handles also work for feedback rendered inside Bing's result iframe.
        await cursor.click(handle as unknown as NonNullable<Parameters<typeof cursor.click>[0]>, {
            paddingPercentage: 25
        })
        return true
    }

    private async pause(min: number, max: number): Promise<void> {
        let remaining = Number(this.bot.utils.randomDelay(min, max))
        while (remaining > 0) {
            this.active()
            if (this.expired || Date.now() >= this.deadline) {
                this.expired = true
                throw new Error('AI interaction deadline reached')
            }
            const part = Math.min(remaining, 200)
            await waitForActivity(this.bot, part)
            remaining -= part
        }
        this.active()
    }

    private async type(page: Page, text: string): Promise<void> {
        for (const character of text) {
            this.active()
            if (this.expired || Date.now() >= this.deadline) {
                this.expired = true
                throw new Error('AI interaction deadline reached')
            }
            await page.keyboard.type(character, { delay: Number(this.bot.utils.randomDelay(35, 65)) })
        }
    }

    private async scrollToBottom(page: Page): Promise<void> {
        const cursor = this.bot.browser.utils.cursor(page) as unknown as {
            moveTo?: (destination: { x: number; y: number }) => Promise<void>
            scroll: (
                delta: Partial<{ x: number; y: number }>,
                options?: { scrollSpeed?: number; scrollDelay?: number }
            ) => Promise<void>
            scrollTo: (destination: 'bottom', options?: { scrollSpeed?: number; scrollDelay?: number }) => Promise<void>
        }
        if (typeof cursor.moveTo !== 'function') {
            await cursor.scrollTo('bottom', { scrollSpeed: 65, scrollDelay: 150 })
            return
        }
        for (let pass = 0; pass < 2; pass++) {
            const target = await page
                .evaluate(turnsSelector => {
                    const isScrollable = (el: HTMLElement | null) => {
                        if (!el) return false
                        const overflowY = getComputedStyle(el).overflowY
                        return (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4
                    }
                    let container: HTMLElement | null = document.querySelector('.b_cpsv2_main') as HTMLElement | null
                    if (!container || container.scrollHeight <= container.clientHeight + 4) {
                        container = null
                        let cur = (document.querySelector(turnsSelector) as HTMLElement | null)?.parentElement || null
                        while (cur && cur !== document.body && cur !== document.documentElement) {
                            if (isScrollable(cur)) {
                                container = cur
                                break
                            }
                            cur = cur.parentElement
                        }
                    }
                    if (container) {
                        const rect = container.getBoundingClientRect()
                        return {
                            x: rect.left + rect.width / 2,
                            y: rect.top + rect.height / 2,
                            delta: Math.max(0, container.scrollHeight - container.clientHeight - container.scrollTop)
                        }
                    }
                    const sh = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
                    return {
                        x: window.innerWidth / 2,
                        y: window.innerHeight / 2,
                        delta: Math.max(0, sh - window.innerHeight - window.scrollY)
                    }
                }, TURNS)
                .catch(() => null)
            if (!target || target.delta <= (pass === 0 ? 4 : 40)) break
            await cursor.moveTo({ x: target.x, y: target.y })
            await cursor.scroll({ y: target.delta }, { scrollSpeed: 65, scrollDelay: 150 })
        }
    }

    private async readAndScroll(page: Page, mobile: boolean): Promise<void> {
        this.event(mobile, 'reading')
        await this.pause(5000, 8000)
        await this.scrollToBottom(page)
        this.event(mobile, 'scrolled-bottom')
        await this.pause(1000, 1500)
    }

    async run(
        source: Page,
        query: string,
        mobile: boolean,
        kind: 'normal' | 'warmup',
        choice: AiChoice
    ): Promise<boolean> {
        this.active()
        this.expired = false
        const page = await this.bot.newBrowserPage(source.context())
        this.deadline = Date.now() + (this.options.totalMs ?? 120000)
        const timer = setTimeout(
            () => {
                this.expired = true
                void page.close().catch(() => {})
            },
            Math.max(1, this.deadline - Date.now())
        )
        const stop = setInterval(() => {
            try {
                this.active()
            } catch {
                void page.close().catch(() => {})
            }
        }, 250)
        timer.unref?.()
        stop.unref?.()
        const conversation = new AiConversation(page, query)
        let confirmed = false
        try {
            await conversation.install()
            await page.goto('https://www.bing.com/copilotsearch?q=', {
                waitUntil: 'domcontentloaded',
                timeout: Math.min(20000, this.options.totalMs ?? 120000)
            })
            this.checkVerificationUrl(page)
            const initialInput = page.locator('textarea[id^="b_copilot_composer_"]:visible').first()
            const inputReady = await initialInput
                .waitFor({
                    state: 'visible',
                    timeout: Math.max(1, Math.min(15000, this.deadline - Date.now()))
                })
                .then(() => true)
                .catch(error => {
                    this.active()
                    if (error instanceof Error && error.name === 'TimeoutError') return false
                    throw error
                })
            if (!inputReady) {
                this.event(mobile, 'skipped', 'initial-composer-unavailable')
                return false
            }
            await page
                .waitForLoadState('load', { timeout: Math.min(5000, Math.max(1, this.deadline - Date.now())) })
                .catch(() => {})
            await this.pause(500, 1000)
            if (!(await this.click(page, initialInput)) || (await initialInput.inputValue()).trim()) return false
            await this.pause(250, 500)
            await this.type(page, query)
            await this.pause(400, 800)
            await learningQuery(kind, mobile, async () => {
                try {
                    if (!conversation.armInitial()) throw new Error('AI initial submission already reserved')
                    this.event(mobile, 'initial-enter')
                    await page.keyboard.press('Enter')
                    this.checkVerificationUrl(page)
                    let answer = await this.answer(page)
                    if (!answer) {
                        this.event(mobile, 'skipped', 'answer-unavailable')
                        return
                    }
                    confirmed = true
                    this.event(mobile, 'initial-completed')
                    await this.readAndScroll(page, mobile)
                    if (choice.feedback === 'none') {
                        this.event(mobile, 'feedback-none')
                        return
                    }
                    const button = await this.button(answer, choice.feedback === 'like' ? LIKE : DISLIKE)
                    if (!(await button.count())) {
                        this.event(mobile, 'skipped', 'feedback-missing')
                        return
                    }
                    if ((await button.getAttribute('aria-pressed')) === 'true') {
                        this.event(mobile, 'skipped', 'already-voted')
                        return
                    }
                    if (!(await this.click(page, button))) return
                    const voted = await button
                        .evaluate(e => e.getAttribute('aria-pressed') === 'true')
                        .catch(() => false)
                    if (!voted) {
                        this.event(mobile, 'skipped', 'feedback-unconfirmed')
                        return
                    }
                    this.event(mobile, `feedback-${choice.feedback}`)
                    const sent: string[] = []
                    let branch = query
                    for (let n = 0; choice.feedback === 'like' && choice.followups > 0 && n < 2; n++) {
                        this.active()
                        if (n === 1 && !thirdTurnChoice(this.random)) break
                        const question = followupQuestion(answer.text, branch, this.random, sent)
                        if (!question) {
                            this.event(mobile, 'skipped', 'no-followup')
                            break
                        }
                        const input = page.locator('textarea[id^="b_copilot_composer_"]:visible').first()
                        const submit = page.locator(SUBMIT).first()
                        if (Date.now() + question.length * 65 + 9000 >= this.deadline) break
                        if (
                            !(await input.isVisible()) ||
                            !(await input.isEnabled()) ||
                            (await input.inputValue()).trim() ||
                            !(await submit.count())
                        ) {
                            this.event(mobile, 'skipped', 'composer-unavailable')
                            break
                        }
                        await this.pause(1000, 2000)
                        if (!(await this.click(page, input))) break
                        await this.pause(250, 500)
                        await this.type(page, question)
                        await this.pause(400, 800)
                        await submit
                            .waitFor({
                                state: 'visible',
                                timeout: Math.max(1, Math.min(1500, this.deadline - Date.now()))
                            })
                            .catch(() => {})
                        if (!(await submit.isVisible())) break
                        if (!(await conversation.arm(question, answer.index + 1))) {
                            this.event(mobile, 'skipped', 'conversation-unbound')
                            break
                        }
                        sent.push(question)
                        const before = answer,
                            requests = conversation.sent
                        if (!(await this.click(page, submit))) break
                        answer = await this.answer(page, before)
                        if (!answer || conversation.sent === requests) {
                            this.event(mobile, 'skipped', 'followup-unconfirmed')
                            break
                        }
                        this.event(mobile, `followup-${n + 2}-completed`)
                        branch = `${query}; ${question}`.slice(0, 240)
                        await this.readAndScroll(page, mobile)
                    }
                } catch (error) {
                    this.active()
                    if (
                        this.expired ||
                        page.isClosed() ||
                        (confirmed && error instanceof Error && /TimeoutError|TargetClosedError/.test(error.name))
                    ) {
                        this.event(mobile, 'skipped', 'interaction-closed-or-timeout')
                        return
                    }
                    throw error
                }
            })
            this.active()
            await waitForSearch(
                this.bot,
                this.bot.utils.randomDelay(
                    this.bot.config.searchSettings.searchDelay.min,
                    this.bot.config.searchSettings.searchDelay.max
                )
            )
            return confirmed
        } catch (error) {
            this.active()
            if (this.expired || page.isClosed()) {
                this.event(mobile, 'skipped', 'closed-or-timeout')
                return confirmed
            }
            throw error
        } finally {
            clearTimeout(timer)
            clearInterval(stop)
            await page.close().catch(() => {})
        }
    }
}
