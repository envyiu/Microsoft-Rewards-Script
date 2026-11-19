export const FVIA_INBOXES_DOMAIN = 'fviainboxes.com'

const EMAIL_FORMAT_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MASKED_EMAIL_HINT_REGEX = /[A-Za-z0-9._*+-]+@[A-Za-z0-9.*-]+\.[A-Za-z*]{2,}/g
const FVIA_BASE_URL = 'https://fviainboxes.com'
const FVIA_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0'
const MAX_RESPONSE_BYTES = 1024 * 1024
const CLOCK_SKEW_GRACE_MS = 30_000

const VERIFICATION_KEYWORDS = [
    'security code',
    'verification code',
    'single-use code',
    'single use code',
    'one-time code',
    'one time code',
    'ma bao mat',
    'ma xac minh',
    'ma xac nhan',
    'ma dung mot lan',
    'ma mot lan'
] as const

class FviaHttpError extends Error {
    constructor(public readonly status: number) {
        super(`fviainboxes HTTP ${status}`)
        this.name = 'FviaHttpError'
    }
}

export interface FviaMailOptions {
    timeoutMs?: number
    fetchImpl?: typeof fetch
}

export interface FviaFetchOptions extends FviaMailOptions {
    sinceMs?: number
    knownMessageIds?: ReadonlySet<string>
}

export interface FviaExtractOptions {
    address: string
    sinceMs: number
    knownMessageIds?: ReadonlySet<string>
}

export interface FviaExtractedCode {
    code: string
    messageId?: string
}

export interface FviaPollOptions {
    address: string
    sinceMs: number
    knownMessageIds?: ReadonlySet<string>
    timeoutMs?: number
    pollIntervalMs?: number
    requestTimeoutMs?: number
    shouldAbort?: () => boolean
    onWaitLog?: (remainingSeconds: number) => void
    fetchImpl?: typeof fetch
    sleep?: (ms: number) => Promise<void>
}

function normalizeMailText(value: string): string {
    return value
        .toLowerCase()
        .replace(/đ/g, 'd')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
}

function escapeRegexLiteral(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function maskSegmentToRegex(segment: string): RegExp {
    const pattern = segment
        .split(/\*+/)
        .map(part => escapeRegexLiteral(part))
        .join('.*')
    return new RegExp(`^${pattern}$`, 'i')
}

export function isFviaInboxesEmail(email?: string | null): boolean {
    if (typeof email !== 'string') return false
    const trimmed = email.trim().toLowerCase()
    if (!trimmed || !EMAIL_FORMAT_REGEX.test(trimmed)) return false
    const atIndex = trimmed.lastIndexOf('@')
    if (atIndex <= 0) return false
    return trimmed.slice(atIndex + 1) === FVIA_INBOXES_DOMAIN
}

export function matchesMaskedEmailHint(email: string, subtitle?: string | null): boolean {
    if (!email || typeof subtitle !== 'string' || !subtitle.trim()) return true
    const hints = subtitle.match(MASKED_EMAIL_HINT_REGEX)
    if (!hints || hints.length === 0) return true

    const normalizedEmail = email.trim().toLowerCase()
    const atIndex = normalizedEmail.lastIndexOf('@')
    if (atIndex <= 0) return false
    const actualLocal = normalizedEmail.slice(0, atIndex)
    const actualDomain = normalizedEmail.slice(atIndex + 1)

    return hints.some(hint => {
        const hintAt = hint.lastIndexOf('@')
        if (hintAt <= 0) return false
        const hintLocal = hint.slice(0, hintAt)
        const hintDomain = hint.slice(hintAt + 1)
        return maskSegmentToRegex(hintLocal).test(actualLocal) && maskSegmentToRegex(hintDomain).test(actualDomain)
    })
}

function splitAddress(address: string): { user: string; domain: string; normalized: string } {
    if (!isFviaInboxesEmail(address)) {
        throw new Error('Recovery email must belong to fviainboxes.com')
    }
    const normalized = address.trim().toLowerCase()
    const atIndex = normalized.lastIndexOf('@')
    return {
        user: normalized.slice(0, atIndex),
        domain: normalized.slice(atIndex + 1),
        normalized
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractSenderDomain(sender: unknown): string | null {
    if (typeof sender !== 'string') return null
    const match = /[\w.+-]+@([\w.-]+)/.exec(sender)
    return match?.[1]?.toLowerCase() ?? null
}

function isMicrosoftSenderDomain(domain: string | null): boolean {
    if (!domain) return false
    if (domain === 'example' || domain.endsWith('.example')) return false
    return domain === 'microsoft.com' || domain.endsWith('.microsoft.com')
}

function parseTimestampMs(stamp: unknown): number | null {
    if (typeof stamp === 'number') {
        if (!Number.isFinite(stamp) || stamp <= 0) return null
        return stamp < 1e12 ? stamp * 1000 : stamp
    }
    if (typeof stamp === 'string') {
        const trimmed = stamp.trim()
        if (!trimmed || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) return null
        const parsed = Date.parse(trimmed)
        return Number.isFinite(parsed) ? parsed : null
    }
    return null
}

function rawTimestamp(item: Record<string, unknown>): unknown {
    return item.received_at ?? item.date ?? item.created_at ?? item.createdAt
}

function rawMessageId(item: Record<string, unknown>): string | undefined {
    const id = item.id
    if (typeof id === 'string' && id.trim()) return id
    if (typeof id === 'number' && Number.isFinite(id)) return String(id)
    return undefined
}

function cleanMailBody(body: string): string {
    let cleaned = body
    if (cleaned.includes('<') && cleaned.includes('>')) {
        cleaned = cleaned
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&#?[a-zA-Z0-9]+;/g, ' ')
    }
    return cleaned
        .replace(/https?:\/\/[^\s<>"']+/gi, ' ')
        .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, ' ')
        .replace(/#[0-9a-fA-F]{6}\b/g, ' ')
}

export function extractMicrosoftVerificationCode(
    payload: unknown,
    { address, sinceMs, knownMessageIds }: FviaExtractOptions
): FviaExtractedCode | null {
    if (!isRecord(payload) || !Array.isArray(payload.result)) return null

    const normalizedAddress = address.trim().toLowerCase()
    const minTimestampMs = sinceMs - CLOCK_SKEW_GRACE_MS

    interface Candidate {
        item: Record<string, unknown>
        tsMs: number
        idx: number
        messageId?: string
    }

    const candidates: Candidate[] = []

    for (let idx = 0; idx < payload.result.length; idx++) {
        const item = payload.result[idx]
        if (!isRecord(item)) continue

        const messageId = rawMessageId(item)
        if (messageId && knownMessageIds?.has(messageId)) continue

        const sender = item.from ?? item.sender ?? ''
        const stamp = rawTimestamp(item)
        if (typeof sender !== 'string') continue
        if (!isMicrosoftSenderDomain(extractSenderDomain(sender))) continue

        const recipient = item.to ?? item.recipient
        if (recipient !== undefined && recipient !== null) {
            if (typeof recipient !== 'string') continue
            if (recipient.trim()) {
                const recipients: string[] = recipient.toLowerCase().match(/[\w.+-]+@[\w.-]+/g) ?? []
                if (!recipients.includes(normalizedAddress)) continue
            }
        }

        const tsMs = parseTimestampMs(stamp)
        if (tsMs === null || tsMs < minTimestampMs) continue

        candidates.push({ item, tsMs, idx, messageId })
    }

    candidates.sort((a, b) => b.tsMs - a.tsMs || b.idx - a.idx)

    for (const candidate of candidates) {
        const { item, messageId } = candidate
        const subject = item.subject ?? ''
        const body = item.text ?? item.body ?? ''
        if (typeof subject !== 'string' || typeof body !== 'string') continue

        const normalizedCombined = normalizeMailText(`${subject} ${body}`)
        if (!VERIFICATION_KEYWORDS.some(keyword => normalizedCombined.includes(keyword))) continue

        const cleanBody = cleanMailBody(body)
        const textContent = `${subject} ${cleanBody}`
        const codes = new Set(textContent.match(/(?<!\d)\d{6,8}(?!\d)/g) ?? [])
        if (codes.size === 1) {
            const [code] = [...codes]
            if (code) return { code, messageId }
        }
    }

    return null
}

async function readJsonWithLimit(response: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
    if (!response.ok) {
        throw new FviaHttpError(response.status)
    }
    const contentLengthHeader = response.headers?.get?.('content-length')
    if (contentLengthHeader) {
        const contentLength = Number(contentLengthHeader)
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            throw new Error('fviainboxes response exceeded size limit')
        }
    }

    if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let totalBytes = 0
        try {
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                if (!value) continue
                totalBytes += value.byteLength
                if (totalBytes > maxBytes) {
                    await reader.cancel().catch(() => {})
                    throw new Error('fviainboxes response exceeded size limit')
                }
                chunks.push(value)
            }
        } finally {
            reader.releaseLock?.()
        }
        const combined = new Uint8Array(totalBytes)
        let offset = 0
        for (const chunk of chunks) {
            combined.set(chunk, offset)
            offset += chunk.byteLength
        }
        const text = new TextDecoder('utf-8').decode(combined)
        return JSON.parse(text)
    }

    if (typeof response.text === 'function') {
        const text = await response.text()
        if (Buffer.byteLength(text, 'utf8') > maxBytes) {
            throw new Error('fviainboxes response exceeded size limit')
        }
        return JSON.parse(text)
    }

    return response.json()
}

async function fetchJson(url: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<unknown> {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
    const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
            'User-Agent': FVIA_USER_AGENT,
            Accept: 'application/json'
        },
        ...(signal ? { signal } : {})
    })
    return readJsonWithLimit(response)
}

function buildQueryUrl(endpoint: string, params: Record<string, string>): string {
    const search = new URLSearchParams(params)
    return `${FVIA_BASE_URL}${endpoint}?${search.toString()}`
}

function passesMessageDetailPreFilter(item: Record<string, unknown>, options: FviaFetchOptions): boolean {
    const messageId = rawMessageId(item)
    if (!messageId) return false
    if (options.knownMessageIds?.has(messageId)) return false

    const sender = item.from ?? item.sender ?? ''
    if (!isMicrosoftSenderDomain(extractSenderDomain(sender))) return false

    if (typeof options.sinceMs === 'number' && Number.isFinite(options.sinceMs)) {
        const tsMs = parseTimestampMs(rawTimestamp(item))
        if (tsMs !== null && tsMs < options.sinceMs - CLOCK_SKEW_GRACE_MS) return false
    }

    return true
}

function extractBodyString(fetched: unknown): string {
    if (typeof fetched === 'string') return fetched
    if (isRecord(fetched)) {
        for (const key of ['text', 'body', 'html']) {
            if (typeof fetched[key] === 'string' && fetched[key]) return fetched[key] as string
        }
        if (isRecord(fetched.result)) {
            for (const key of ['text', 'body', 'html']) {
                if (typeof fetched.result[key] === 'string' && fetched.result[key]) {
                    return fetched.result[key] as string
                }
            }
        }
    }
    return ''
}

export async function snapshotFviaMessageIds(address: string, options: FviaMailOptions = {}): Promise<Set<string>> {
    const ids = new Set<string>()
    if (!isFviaInboxesEmail(address)) return ids

    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') return ids

    try {
        const { user, domain } = splitAddress(address)
        const listUrl = buildQueryUrl('/messages', { username: user, domain })
        const payload = await fetchJson(listUrl, options.timeoutMs ?? 4000, fetchImpl)
        if (!isRecord(payload) || !Array.isArray(payload.result)) return ids
        for (const item of payload.result) {
            if (!isRecord(item)) continue
            const id = rawMessageId(item)
            if (id) ids.add(id)
        }
    } catch {
        // Best-effort snapshot only; polling still relies on sinceMs timestamp window.
    }

    return ids
}

export async function fetchFviaInboxesMessages(
    address: string,
    options: FviaFetchOptions = {}
): Promise<{ result: Record<string, unknown>[] } | unknown> {
    const { user, domain, normalized } = splitAddress(address)
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
        throw new Error('Fetch implementation is unavailable')
    }

    const timeoutMs = options.timeoutMs ?? 10_000
    const listUrl = buildQueryUrl('/messages', { username: user, domain })
    const payload = await fetchJson(listUrl, timeoutMs, fetchImpl)
    if (!isRecord(payload) || !Array.isArray(payload.result)) return payload

    const results: Record<string, unknown>[] = []
    for (const item of payload.result) {
        if (!isRecord(item)) continue
        const msgId = rawMessageId(item)
        let body =
            typeof item.text === 'string' && item.text ? item.text : typeof item.body === 'string' ? item.body : ''

        if (!body && msgId && passesMessageDetailPreFilter(item, options)) {
            try {
                const msgUrl = buildQueryUrl('/message', { username: user, domain, id: msgId })
                const fetched = await fetchJson(msgUrl, Math.min(5000, timeoutMs), fetchImpl)
                const extracted = extractBodyString(fetched)
                if (extracted) body = extracted
            } catch {
                // Keep list metadata; transient detail errors are retried on the next poll tick.
            }
        }

        const entry: Record<string, unknown> = { ...item }
        if (body || typeof entry.body !== 'string') entry.body = body
        if (body || typeof entry.text !== 'string') entry.text = body
        if (entry.to === undefined && entry.recipient === undefined) {
            entry.to = normalized
            entry.recipient = normalized
        }
        results.push(entry)
    }

    return { result: results }
}

function isTransientFviaError(error: unknown): boolean {
    if (error instanceof FviaHttpError) {
        return error.status === 429 || error.status >= 500
    }
    if (error instanceof SyntaxError) {
        return true
    }
    if (error instanceof Error) {
        if (['AbortError', 'TimeoutError', 'TypeError'].includes(error.name)) return true
        const code = (error as NodeJS.ErrnoException).code
        if (typeof code === 'string' && /^(?:ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR)/i.test(code)) {
            return true
        }
        if (/network|timeout|aborted|fetch failed/i.test(error.message)) return true
    }
    return false
}

async function interruptibleSleep(
    totalMs: number,
    shouldAbort: (() => boolean) | undefined,
    customSleep: ((ms: number) => Promise<void>) | undefined
): Promise<void> {
    if (totalMs <= 0) return
    if (customSleep) {
        await customSleep(totalMs)
        return
    }
    const deadline = Date.now() + totalMs
    while (Date.now() < deadline) {
        if (shouldAbort?.()) return
        const slice = Math.min(500, deadline - Date.now())
        if (slice <= 0) return
        await new Promise<void>(resolve => setTimeout(resolve, slice))
    }
}

export async function pollFviaInboxesCode({
    address,
    sinceMs,
    knownMessageIds,
    timeoutMs = 120_000,
    pollIntervalMs = 3_000,
    requestTimeoutMs = 8_000,
    shouldAbort,
    onWaitLog,
    fetchImpl,
    sleep
}: FviaPollOptions): Promise<FviaExtractedCode | null> {
    if (!isFviaInboxesEmail(address)) return null

    const deadline = Date.now() + timeoutMs
    let lastNotifyAt = 0

    while (true) {
        if (shouldAbort?.()) return null
        const now = Date.now()
        const remainingMs = deadline - now
        if (remainingMs <= 0) break

        try {
            const payload = await fetchFviaInboxesMessages(address, {
                sinceMs,
                knownMessageIds,
                timeoutMs: Math.min(requestTimeoutMs, Math.max(1000, remainingMs)),
                fetchImpl
            })
            if (shouldAbort?.()) return null

            const extracted = extractMicrosoftVerificationCode(payload, { address, sinceMs, knownMessageIds })
            if (extracted) return extracted
        } catch (error) {
            if (!isTransientFviaError(error)) {
                break
            }
        }

        if (shouldAbort?.()) return null

        const afterFetchNow = Date.now()
        const remainingAfterMs = deadline - afterFetchNow
        if (remainingAfterMs <= 0) break

        if (onWaitLog && afterFetchNow - lastNotifyAt >= 15_000) {
            onWaitLog(Math.ceil(remainingAfterMs / 1000))
            lastNotifyAt = afterFetchNow
        }

        await interruptibleSleep(Math.min(pollIntervalMs, remainingAfterMs), shouldAbort, sleep)
    }

    return null
}
