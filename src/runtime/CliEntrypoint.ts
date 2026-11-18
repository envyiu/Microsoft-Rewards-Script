import fs from 'node:fs'
import type { MicrosoftRewardsBot } from '../index'
import { flushErrorDiagnostics } from '../util/ErrorDiagnostic'
import { isBrowserClosedError } from '../util/Utils'
import { checkNodeVersion } from '../util/Validator'
import { flushAllWebhooks } from './ClusterCoordinator'

export async function runCliEntrypoint(createBot: () => MicrosoftRewardsBot): Promise<void> {
    checkNodeVersion()
    const rewardsBot = createBot()

    process.on('beforeExit', () => {
        void flushAllWebhooks()
    })
    process.on('SIGINT', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGINT received, flushing and exiting...')
        await flushAllWebhooks()
        process.exit(130)
    })
    process.on('SIGTERM', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGTERM received, flushing and exiting...')
        await flushAllWebhooks()
        process.exit(143)
    })

    let checkpointStop: Promise<void> | undefined
    const controlFile = process.env.MRS_CHECKPOINT_CONTROL_FILE
    let controlPollTimer: ReturnType<typeof setInterval> | undefined

    const writeControlAck = (requestId: string | undefined, saved: boolean): void => {
        if (!requestId || !controlFile) return
        try {
            const ackPath = `${controlFile}.ack`
            const tmpPath = `${ackPath}.tmp`
            fs.writeFileSync(
                tmpPath,
                JSON.stringify({ type: 'MSRW_CHECKPOINT_ACK', requestId, saved, at: new Date().toISOString() }),
                { mode: 0o600 }
            )
            fs.renameSync(tmpPath, ackPath)
        } catch {}
    }

    const requestCheckpointStop = (requestId?: string): void => {
        if (checkpointStop) return
        if (controlPollTimer) clearInterval(controlPollTimer)
        checkpointStop = rewardsBot
            .checkpointAndCloseBrowsers()
            .then(async () => {
                await flushErrorDiagnostics()
                await flushAllWebhooks()
                writeControlAck(requestId, true)
                if (requestId && process.send && process.connected) {
                    process.send({ type: 'MSRW_CHECKPOINT_ACK', requestId, saved: true }, () => process.exit(0))
                } else process.exit(0)
            })
            .catch(async error => {
                rewardsBot.logger.error(
                    'main',
                    'SESSION-CHECKPOINT',
                    `Could not save browser sessions: ${error instanceof Error ? error.message : String(error)}`
                )
                await flushErrorDiagnostics()
                writeControlAck(requestId, false)
                if (requestId && process.send && process.connected) {
                    process.send({ type: 'MSRW_CHECKPOINT_ACK', requestId, saved: false }, () => process.exit(1))
                } else process.exit(1)
            })
    }

    process.on('SIGUSR1', () => requestCheckpointStop())
    process.on('message', (message: unknown) => {
        const request = message as { type?: string; requestId?: string }
        if (
            request?.type === 'MSRW_CHECKPOINT_STOP' &&
            typeof request.requestId === 'string' &&
            /^[a-f0-9-]{36}$/.test(request.requestId)
        ) {
            requestCheckpointStop(request.requestId)
        }
    })

    if (controlFile) {
        controlPollTimer = setInterval(() => {
            try {
                if (!fs.existsSync(controlFile)) return
                const request = JSON.parse(fs.readFileSync(controlFile, 'utf8')) as {
                    type?: string
                    requestId?: string
                }
                if (
                    request?.type === 'MSRW_CHECKPOINT_STOP' &&
                    typeof request.requestId === 'string' &&
                    /^[a-f0-9-]{36}$/.test(request.requestId)
                ) {
                    requestCheckpointStop(request.requestId)
                }
            } catch {}
        }, 150)
        controlPollTimer.unref?.()
    }

    process.channel?.unref()

    process.on('uncaughtException', async error => {
        if (isBrowserClosedError(error)) {
            rewardsBot.logger.debug(
                'main',
                'UNCAUGHT-EXCEPTION',
                `Ignoring benign browser-closed error during teardown | ${error instanceof Error ? error.message : String(error)}`
            )
            return
        }
        rewardsBot.logger.error('main', 'UNCAUGHT-EXCEPTION', error)
        await flushAllWebhooks()
        process.exit(1)
    })

    process.on('unhandledRejection', async reason => {
        if (isBrowserClosedError(reason)) {
            rewardsBot.logger.debug(
                'main',
                'UNHANDLED-REJECTION',
                `Ignoring benign browser-closed rejection during teardown | ${reason instanceof Error ? reason.message : String(reason)}`
            )
            return
        }
        rewardsBot.logger.error('main', 'UNHANDLED-REJECTION', reason as Error)
        await flushAllWebhooks()
        process.exit(1)
    })

    try {
        await rewardsBot.initialize()
        await rewardsBot.run()
    } catch (error) {
        rewardsBot.logger.error('main', 'MAIN-ERROR', error as Error)
        await flushErrorDiagnostics()
        await flushAllWebhooks()
        process.exitCode = 1
    } finally {
        await flushErrorDiagnostics()
    }
}

export async function handleFatalBootstrapError(error: unknown): Promise<never> {
    const detail = error instanceof Error ? error.stack || error.message : String(error)
    console.error(`[${new Date().toLocaleString()}] [MAIN] [ERROR] MAIN [MAIN-ERROR] ${detail}`)
    await flushErrorDiagnostics()
    await flushAllWebhooks()
    process.exit(1)
}
