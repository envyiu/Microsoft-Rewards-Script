import { MANUAL_SESSION_SAVED, MANUAL_SESSION_SAVE_FAILED } from '../main/browserSessionCheckpoint.js'

export function requestSaveAndClose(manager, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        let saved = false
        let settled = false
        let timer
        const finish = error => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            manager.off('log', onLog)
            manager.off('exit', onExit)
            if (error) reject(error)
            else resolve()
        }
        const onLog = entry => {
            const message = String(entry.raw ?? entry.message ?? '')
            if (message.includes(MANUAL_SESSION_SAVED)) saved = true
            if (message.includes(MANUAL_SESSION_SAVE_FAILED)) {
                finish(new Error('Session could not be saved. The browser remains open; please retry.'))
            }
        }
        const onExit = exit => {
            finish(
                saved && exit.code === 0 && !exit.signal
                    ? null
                    : new Error('Browser exited without confirming a saved session.')
            )
        }
        manager.on('log', onLog)
        manager.once('exit', onExit)
        timer = setTimeout(() => {
            finish(new Error('Timed out waiting for session save. The browser was not force-closed.'))
        }, timeoutMs)
        try {
            // Signal only Node. It saves state and closes Chromium after the write succeeds.
            if (!manager.child?.kill('SIGUSR2')) finish(new Error('The manual browser is no longer running.'))
        } catch {
            finish(new Error('Could not send the save-and-close request to the manual browser.'))
        }
    })
}
