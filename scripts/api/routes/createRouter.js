export function createRouter(handlers) {
    return async function dispatch(ctx) {
        for (const handler of handlers) {
            if (await handler(ctx)) return true
        }
        return false
    }
}

export function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10)
    if (!Number.isFinite(n)) return fallback
    return Math.max(min, Math.min(max, n))
}

export function readForce(body) {
    if ('force' in body && typeof body.force !== 'boolean') {
        const err = new Error('`force` must be a boolean.')
        err.code = 'BAD_REQUEST'
        throw err
    }
    return Boolean(body.force)
}
