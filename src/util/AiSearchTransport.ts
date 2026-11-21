import type { Request } from 'patchright'

// Only AiConversation may grant a transport request after checking page, query, turn and conversation.
// Weak references do not leave reusable permissions after a request/tab/process finishes.
const permits = new WeakSet<Request>()
export function grantAiTurn(request: Request): void {
    permits.add(request)
}
export function consumeAiTurn(request: Request): boolean {
    return permits.delete(request)
}
