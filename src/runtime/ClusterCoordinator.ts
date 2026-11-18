import cluster, { Worker } from 'cluster'
import type { MicrosoftRewardsBot } from '../index'
import type { Account } from '../interface/Account'
import { flushDiscordQueue, sendDiscord } from '../logging/Discord'
import type { IpcLog } from '../logging/Logger'
import { flushNtfyQueue, sendNtfy } from '../logging/Ntfy'
import { flushTelegramQueue, sendTelegram } from '../logging/Telegram'
import { closeLearningDb } from '../util/Learning'
import { closeSessionStore } from '../util/SessionStore'
import type { AccountStats } from './SessionContext'

export async function flushAllWebhooks(timeoutMs = 5000): Promise<void> {
    await Promise.allSettled([flushDiscordQueue(timeoutMs), flushNtfyQueue(timeoutMs), flushTelegramQueue(timeoutMs)])
    closeSessionStore()
    closeLearningDb()
}

export function sumKnown(values: Array<number | null>): number | null {
    return values.every((value): value is number => value !== null)
        ? values.reduce((sum, value) => sum + value, 0)
        : null
}

export function formatMetric(value: number | null): string {
    return value === null ? 'unknown' : String(value)
}

export class ClusterCoordinator {
    private activeWorkers: number
    private exitedWorkers: number[] = []

    constructor(private readonly bot: MicrosoftRewardsBot) {
        this.activeWorkers = bot.config.clusters
    }

    public async runMaster(
        accounts: Account[],
        runStartTime: number,
        waitBeforeNextAccount: (email?: string) => Promise<void>
    ): Promise<void> {
        void this.bot.logger.info('main', 'CLUSTER-PRIMARY', `Primary process started | PID: ${process.pid}`)

        const rawChunks = this.bot.utils.chunkArray(accounts, this.bot.config.clusters)
        const accountChunks = rawChunks.filter(c => c && c.length > 0)
        this.activeWorkers = accountChunks.length

        const allAccountStats: AccountStats[] = []
        let hadWorkerFailure = false

        for (const [chunkIndex, chunk] of accountChunks.entries()) {
            if (chunkIndex > 0) {
                await waitBeforeNextAccount(chunk[0]?.email)
            }

            const worker = cluster.fork()
            worker.send?.({ chunk, runStartTime })

            worker.on('message', (msg: { __ipcLog?: IpcLog; __stats?: AccountStats[] }) => {
                if (msg.__stats) {
                    allAccountStats.push(...msg.__stats)
                }

                const log = msg.__ipcLog
                if (log && typeof log.content === 'string') {
                    const { webhook } = this.bot.config
                    const { content, level } = log

                    if (webhook.discord?.enabled && webhook.discord.url) {
                        sendDiscord(webhook.discord.url, content, level)
                    }
                    if (webhook.ntfy?.enabled && webhook.ntfy.url) {
                        sendNtfy(webhook.ntfy, content, level)
                    }
                    if (webhook.telegram?.enabled && webhook.telegram.botToken && webhook.telegram.chatId) {
                        sendTelegram(webhook.telegram, content, level)
                    }
                }
            })
        }

        const onWorkerExit = async (worker: Worker, code?: number, signal?: string): Promise<void> => {
            const { pid } = worker.process

            if (!pid || this.exitedWorkers.includes(pid)) {
                return
            }

            this.exitedWorkers.push(pid)
            this.activeWorkers -= 1

            const failed = (code ?? 0) !== 0 || Boolean(signal)
            if (failed) {
                hadWorkerFailure = true
            }

            this.bot.logger.warn(
                'main',
                'CLUSTER-WORKER-EXIT',
                `Worker ${pid} exit | Code: ${code ?? 'n/a'} | Signal: ${signal ?? 'n/a'} | Active workers: ${this.activeWorkers}`
            )

            if (this.activeWorkers <= 0) {
                const totalCollectedPoints = sumKnown(allAccountStats.map(s => s.collectedPoints))
                const totalInitialPoints = sumKnown(allAccountStats.map(s => s.initialPoints))
                const totalFinalPoints = sumKnown(allAccountStats.map(s => s.finalPoints))
                const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

                this.bot.logger.info(
                    'main',
                    'RUN-END',
                    `Completed all accounts | accountsProcessed=${allAccountStats.length} | pointsGained=${formatMetric(totalCollectedPoints)} | previousBalance=${formatMetric(totalInitialPoints)} | currentBalance=${formatMetric(totalFinalPoints)} | runtimeMinutes=${totalDurationMinutes}`,
                    'green'
                )

                await flushAllWebhooks()

                process.exit(hadWorkerFailure ? 1 : 0)
            }
        }

        cluster.on('exit', (worker, code, signal) => {
            void onWorkerExit(worker, code ?? undefined, signal ?? undefined)
        })

        cluster.on('disconnect', worker => {
            const pid = worker.process?.pid
            this.bot.logger.warn('main', 'CLUSTER-WORKER-DISCONNECT', `Worker ${pid ?? '?'} disconnected`)
        })
    }

    public runWorker(
        runTasks: (accounts: Account[], runStartTime: number) => Promise<AccountStats[]>,
        runStartTimeFromMaster?: number
    ): void {
        void this.bot.logger.info('main', 'CLUSTER-WORKER-START', `Worker spawned | PID: ${process.pid}`)

        process.on('message', async ({ chunk, runStartTime }: { chunk: Account[]; runStartTime: number }) => {
            void this.bot.logger.info(
                'main',
                'CLUSTER-WORKER-TASK',
                `Worker ${process.pid} received ${chunk.length} accounts.`
            )

            try {
                const stats = await runTasks(chunk, runStartTime ?? runStartTimeFromMaster ?? Date.now())

                if (process.send) {
                    process.send({ __stats: stats })
                }

                await flushAllWebhooks()
                process.exit(0)
            } catch (error) {
                this.bot.logger.error(
                    'main',
                    'CLUSTER-WORKER-ERROR',
                    `Worker task crash: ${error instanceof Error ? error.message : String(error)}`
                )

                await flushAllWebhooks()
                process.exit(1)
            }
        })
    }
}
