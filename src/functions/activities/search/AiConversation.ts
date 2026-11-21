import type { Page, Route } from 'patchright'
import { grantAiTurn } from '../../../util/AiSearchTransport'

export async function conversationId(page: Page): Promise<string> {
    return page
        .evaluate(() => {
            const value =
                document.querySelector('#convId')?.getAttribute('value') ||
                document.querySelector('[data-conversation-id]')?.getAttribute('data-conversation-id')
            if (value) return value
            const site = window as unknown as {
                CopilotSearch?: { getConversationId?: () => string; Conversation?: { conversationId?: string } }
            }
            return site.CopilotSearch?.getConversationId?.() || site.CopilotSearch?.Conversation?.conversationId || ''
        })
        .catch(() => '')
}

/** A tab-local transport permit, not another search reservation. No permit survives tab closure/restart. */
export class AiConversation {
    private initial = true
    private binding = ''
    private expected: { question: string; turn: number }
    private requests = new Set<string>()
    private followups = 0
    sent = 0

    constructor(
        private page: Page,
        question: string
    ) {
        this.expected = { question, turn: 1 }
    }

    async install(): Promise<void> {
        await this.page.route(/https?:\/\/(?:[^/]+\.)?bing\.com\//, route => this.route(route))
        // The current Bing UI uses bounded GET/iframe turns. Unknown socket transports fail closed.
        await this.page.routeWebSocket('**/*', socket => socket.close())
    }

    async bind(): Promise<boolean> {
        const id = await conversationId(this.page)
        if (!id || id.length > 1000 || (this.binding && this.binding !== id)) return false
        this.binding = id
        return true
    }

    async arm(question: string, turn: number): Promise<boolean> {
        if (this.followups >= 2 || turn < 2 || turn > 3 || !question || question.length > 600 || !(await this.bind()))
            return false
        this.followups++ // Reserve before clicking; an uncertain submission is never replayed.
        this.expected = { question, turn }
        return true
    }

    private async route(route: Route): Promise<void> {
        const request = route.request(),
            url = new URL(request.url())
        if (!/^\/(?:search|copilotsearch)(?:\/|$)/i.test(url.pathname)) {
            await route.fallback()
            return
        }
        if (url.protocol !== 'https:' || url.hostname !== 'www.bing.com' || request.method() !== 'GET') {
            await route.abort()
            return
        }
        if (
            this.initial &&
            request.isNavigationRequest() &&
            request.frame() === this.page.mainFrame() &&
            url.pathname === '/copilotsearch' &&
            url.searchParams.get('q') === this.expected.question
        ) {
            this.initial = false
            await route.fallback() // NormalSession consumes the one ordinary query ticket.
            return
        }
        const variant = url.searchParams.get('cpltsrchif')
        const turn = Number(url.searchParams.get('turnindex'))
        const key = `${turn}:${variant}`
        const current = new URL(this.page.url())
        if (request.frame() === this.page.mainFrame() && request.isNavigationRequest()) {
            await route.abort()
            return
        }
        if (
            current.origin !== 'https://www.bing.com' ||
            current.pathname !== '/copilotsearch' ||
            !['1', '2'].includes(variant || '') ||
            url.pathname !== '/search' ||
            turn !== this.expected.turn ||
            url.searchParams.get('q') !== this.expected.question ||
            this.requests.has(key) ||
            !(await this.bind()) ||
            url.searchParams.get('convid') !== this.binding
        ) {
            await route.abort('blockedbyclient')
            return
        }
        this.requests.add(key)
        this.sent++
        // Only the exact bound Bing turn bypasses the generic /search navigation guard.
        grantAiTurn(request)
        await route.fallback()
    }
}
