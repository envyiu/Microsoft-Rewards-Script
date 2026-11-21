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
    private landing = true
    private initialArmed = false
    private initial = true
    private v2ConversationCreated = false
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
        this.page.on('response', response => {
            if (this.binding || response.request().method() !== 'POST') return
            let parsedUrl: URL
            try {
                parsedUrl = new URL(response.url())
            } catch {
                return
            }
            if (
                parsedUrl.origin !== 'https://www.bing.com' ||
                parsedUrl.pathname !== '/copilotsearch/api/v1/conversations' ||
                !response.ok()
            ) {
                return
            }
            void response
                .json()
                .then(body => {
                    const id = (body as { conversation_id?: unknown } | null)?.conversation_id
                    if (typeof id === 'string' && id && id.length <= 1000 && !this.binding) {
                        this.binding = id
                    }
                })
                .catch(() => {})
        })
        await this.page.route(/https?:\/\/(?:[^/]+\.)?bing\.com\//, route => this.route(route))
        // The current Bing UI uses bounded GET/POST conversation turns. Unknown socket transports fail closed.
        await this.page.routeWebSocket('**/*', socket => socket.close())
    }

    armInitial(): boolean {
        if (this.landing || !this.initial || this.initialArmed) return false
        this.initialArmed = true
        return true
    }

    async bind(): Promise<boolean> {
        const id = await conversationId(this.page)
        if (id) {
            if (id.length > 1000 || (this.binding && this.binding !== id)) return false
            this.binding = id
            return true
        }
        return Boolean(this.v2ConversationCreated && this.binding)
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
            url = new URL(request.url()),
            method = request.method().toUpperCase()
        if (!/^\/(?:search|copilotsearch)(?:\/|$)/i.test(url.pathname)) {
            await route.fallback()
            return
        }
        if (url.protocol !== 'https:' || url.hostname !== 'www.bing.com' || (method !== 'GET' && method !== 'POST')) {
            await route.abort()
            return
        }
        if (
            method === 'GET' &&
            this.landing &&
            request.isNavigationRequest() &&
            request.frame() === this.page.mainFrame() &&
            url.pathname === '/copilotsearch' &&
            url.searchParams.get('q') === ''
        ) {
            this.landing = false
            grantAiTurn(request, 'landing')
            await route.fallback()
            return
        }
        if (
            method === 'GET' &&
            this.initial &&
            this.initialArmed &&
            request.isNavigationRequest() &&
            request.frame() === this.page.mainFrame() &&
            url.pathname === '/copilotsearch' &&
            url.searchParams.get('q') === this.expected.question
        ) {
            this.initial = false
            await route.fallback() // NormalSession consumes the one ordinary query ticket.
            return
        }
        const current = new URL(this.page.url())
        if (request.frame() === this.page.mainFrame() && request.isNavigationRequest()) {
            await route.abort()
            return
        }
        if (current.origin !== 'https://www.bing.com' || current.pathname !== '/copilotsearch') {
            await route.abort('blockedbyclient')
            return
        }

        // Bing Copilot Search v2 API: POST /copilotsearch/api/v1/conversations + .../generate + /impression
        if (method === 'POST' && url.pathname === '/copilotsearch/api/v1/conversations') {
            if (!this.initial || !this.initialArmed || this.v2ConversationCreated || this.binding) {
                await route.abort('blockedbyclient')
                return
            }
            this.v2ConversationCreated = true
            grantAiTurn(request, 'setup')
            await route.fallback()
            return
        }

        const v2Generate =
            method === 'POST'
                ? url.pathname.match(/^\/copilotsearch\/api\/v1\/conversations\/([A-Za-z0-9_-]{8,200})\/generate$/i)
                : null
        if (v2Generate) {
            const convId = v2Generate[1]!
            let queryText: unknown
            try {
                queryText = (JSON.parse(request.postData() || '{}') as { query?: unknown })?.query
            } catch {
                queryText = undefined
            }
            const key = `${this.expected.turn}:v2`
            const convMatches = this.binding ? convId === this.binding : this.initial
            if (
                !this.v2ConversationCreated ||
                (this.initial && !this.initialArmed) ||
                typeof queryText !== 'string' ||
                queryText !== this.expected.question ||
                !convMatches ||
                this.requests.has(key)
            ) {
                await route.abort('blockedbyclient')
                return
            }
            if (!this.binding) this.binding = convId
            this.requests.add(key)
            this.sent++
            grantAiTurn(request, this.initial ? 'initial' : 'continuation')
            this.initial = false
            await route.fallback()
            return
        }

        if (method === 'GET' && url.pathname === '/copilotsearch/impression') {
            const key = `${this.expected.turn}:impression`
            if (
                this.initial ||
                !this.v2ConversationCreated ||
                !this.binding ||
                url.searchParams.get('convid') !== this.binding ||
                Number(url.searchParams.get('turnIdx')) !== this.expected.turn ||
                url.searchParams.get('q') !== this.expected.question ||
                this.requests.has(key)
            ) {
                await route.abort('blockedbyclient')
                return
            }
            this.requests.add(key)
            grantAiTurn(request, 'continuation')
            await route.fallback()
            return
        }

        const variant = url.searchParams.get('cpltsrchif')
        if (
            method === 'GET' &&
            url.pathname === '/search' &&
            url.searchParams.get('traffictype') === 'searchharderbfpr'
        ) {
            const mgidx = url.searchParams.get('mgidx') || ''
            const rawTurn = url.searchParams.get('turnindex')
            const turnOk = rawTurn === null || Number(rawTurn) === this.expected.turn
            const key = `${this.expected.turn}:searchharder:${mgidx}`
            if (
                this.initial ||
                !['1', '2'].includes(variant || '') ||
                !/^[0-3]$/.test(mgidx) ||
                !turnOk ||
                url.searchParams.get('q') !== this.expected.question ||
                this.requests.has(key) ||
                !(await this.bind()) ||
                url.searchParams.get('convid') !== this.binding
            ) {
                await route.abort('blockedbyclient')
                return
            }
            this.requests.add(key)
            grantAiTurn(request, 'continuation')
            await route.fallback()
            return
        }

        const turn = Number(url.searchParams.get('turnindex'))
        const key = `${turn}:${variant}`
        if (
            method !== 'GET' ||
            !['1', '2'].includes(variant || '') ||
            url.pathname !== '/search' ||
            (this.initial && !this.initialArmed) ||
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
        grantAiTurn(request, this.initial ? 'initial' : 'continuation')
        this.initial = false
        await route.fallback()
    }
}
