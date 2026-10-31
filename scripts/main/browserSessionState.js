/* global window */

function validOrigins(storageState) {
    if (!storageState || !Array.isArray(storageState.origins)) return []
    return storageState.origins.filter(entry => entry && typeof entry.origin === 'string')
}

function pageOrigin(page) {
    try {
        const url = new URL(page.url())
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
    } catch {
        return null
    }
}

export async function captureBrowserSessionState(context, previousState = null) {
    const cookies = await context.cookies()
    const origins = new Map(validOrigins(previousState).map(entry => [entry.origin, structuredClone(entry)]))

    for (const page of context.pages()) {
        if (page.isClosed()) continue
        const origin = pageOrigin(page)
        if (!origin) continue

        try {
            const localStorage = await page.evaluate(() => {
                const entries = []
                for (let index = 0; index < window.localStorage.length; index += 1) {
                    const name = window.localStorage.key(index)
                    if (name == null) continue
                    entries.push({ name, value: window.localStorage.getItem(name) ?? '' })
                }
                return entries
            })
            const previous = origins.get(origin)
            if (localStorage.length || previous?.indexedDB?.length) {
                origins.set(origin, {
                    origin,
                    localStorage,
                    ...(previous?.indexedDB?.length ? { indexedDB: previous.indexedDB } : {})
                })
            } else {
                origins.delete(origin)
            }
        } catch {
            // Navigation can replace the execution context while it is being read.
            // Keep the last known data for this origin and retry at the next checkpoint.
        }
    }

    return { cookies, origins: [...origins.values()] }
}
