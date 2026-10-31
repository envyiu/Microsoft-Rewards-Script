export const MANUAL_SESSION_SAVED = 'Manual browser checkpoint complete'
export const MANUAL_SESSION_SAVE_FAILED = 'Manual browser checkpoint failed; browser remains open'

export function createSessionCheckpointer(captureAndSave) {
    let inFlight = null
    return function checkpoint(reason, options = {}) {
        if (inFlight) {
            if (!options.allowUnconfirmed) return inFlight
            return inFlight.then(() => checkpoint(reason, options))
        }

        // Defer execution so even a synchronous skip or error clears the assigned promise.
        inFlight = Promise.resolve()
            .then(() => captureAndSave(reason, options))
            .finally(() => {
                inFlight = null
            })
        return inFlight
    }
}
