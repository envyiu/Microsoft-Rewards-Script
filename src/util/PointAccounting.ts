// Adapted from upstream v5.0.0 point accounting (GPL-3.0-or-later).
export function pointValue(value: unknown): number | null {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null
    const points = Number(value)
    return Number.isFinite(points) && points >= 0 ? points : null
}

export function pointDelta(before: unknown, after: unknown): number | null {
    const start = pointValue(before)
    const end = pointValue(after)
    return start !== null && end !== null && end >= start ? end - start : null
}

export function creditedPoints(progress: number | null, beforeBalance: unknown, afterBalance: unknown): number | null {
    const credited = pointDelta(beforeBalance, afterBalance)
    if (progress === 0 && credited !== 0) return null
    return progress !== null && credited !== null && credited >= progress ? progress : null
}
