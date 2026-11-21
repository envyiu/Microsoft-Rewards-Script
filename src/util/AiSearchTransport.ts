import type { Request } from 'patchright'

// Tab-local permissions from AiConversation. Empty landing loads are not searches;
// initial answer transport must consume the ticket reserved before pressing Enter.
export type AiPermit = 'landing' | 'setup' | 'initial' | 'continuation'
const permits = new WeakMap<Request, AiPermit>()
export function grantAiTurn(request: Request, kind: AiPermit = 'continuation'): void {
    permits.set(request, kind)
}
export function consumeAiTurn(request: Request): AiPermit | undefined {
    const kind = permits.get(request)
    permits.delete(request)
    return kind
}
