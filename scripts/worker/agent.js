import path from 'node:path'
import { WorkerUpdater, updateFailure } from './update.js'
import { LearningCollector } from '../learning/collector.js'
import { Hybrid } from '../api/hybrid.js'
import { workerCapabilities } from '../../packages/contracts/protocol.js'

// The runtime controller is reused, while coordinator-only entry points remain unavailable.
export class WorkerAgent extends Hybrid {
    constructor(options) {
        super(options)
        this.updater = new WorkerUpdater({
            data: this.env.MRS_WORKER_DATA || this.store.directory,
            code: options.projectRoot || path.resolve(import.meta.dirname, '../..'),
            environment: this.env
        })
        this.learning = new LearningCollector({
            directory: path.join(this.env.MRS_WORKER_DATA || this.store.directory, 'learning'),
            nodeId: this.store.nodeId,
            config: this.store.get('snapshot')?.learning,
            environment: this.env
        })
    }
    schedulerOptions() {
        return { ...super.schedulerOptions(), learning: this.learning }
    }
    activateSnapshot(body) {
        super.activateSnapshot(body)
        this.learning?.configure(body.learning)
    }
    close() {
        this.learning?.close()
        super.close()
    }
    attach(context) {
        super.attach(context)
        context.scheduler.maintenance = this.updater.maintenance
        this.learning.attach(context.scheduler, context.manual)
        context.manual.on('change', event => {
            if (event.type !== 'exit') return
            const exits = this.store.get('manualExits') || {}
            exits[event.session.accountIndex] = {
                ok: event.checkpointSaved === true || (event.exit?.code === 0 && !event.exit?.signal),
                at: new Date().toISOString()
            }
            this.store.set('manualExits', exits)
        })
    }
    runtimeStatus() {
        return { release: this.updater.release, updater: this.updater.status() }
    }
    get capabilities() {
        return workerCapabilities(this.env.MRS_WORKER_KIND, this.env)
    }

    async handle(req, res, url, io) {
        const route = url.pathname.replace(/\/+$/, '')
        if (route.startsWith('/internal/update/')) {
            if (req.method === 'GET' && route === '/internal/update/status') {
                io.send(res, 200, this.updater.status())
                return true
            }
            const body = await io.read(req)
            let result
            if (req.method === 'POST' && route === '/internal/update/begin') {
                if (body.nodeId !== this.store.nodeId) throw updateFailure('WORKER_IDENTITY_CHANGED')
                result = this.updater.begin(body)
                this.scheduler.maintenance = true
            } else if (req.method === 'PUT' && route === '/internal/update/chunk') result = this.updater.chunk(body)
            else if (req.method === 'POST' && route === '/internal/update/commit') {
                if (
                    this.scheduler.running.size ||
                    this.manual.list().length ||
                    Object.keys(this.holds).length ||
                    this.scheduler.suspended ||
                    this.android?.list?.().length
                )
                    throw updateFailure('WORKER_NOT_DRAINED')
                result = await this.updater.commit(body.id)
            } else if (req.method === 'POST' && route === '/internal/update/finish') {
                this.updater.finish(body.id)
                this.scheduler.maintenance = false
                this.scheduler.replan()
                result = { finished: true }
            } else throw updateFailure('NOT_FOUND', 404)
            io.send(res, 200, result || this.updater.status())
            return true
        }
        if (this.updater.maintenance && req.method !== 'GET') {
            const closing = /^\/(manual-sessions\/[1-9]\d*\/close|android-sessions\/[1-9]\d*\/stop)$/.test(route)
            if (
                !closing &&
                (route === '/manual-sessions' ||
                    route === '/android-sessions' ||
                    ['/start', '/restart', '/smart-schedule/urgent', '/smart-schedule/retry'].includes(route))
            )
                throw updateFailure('UPDATE_IN_PROGRESS')
            if (route === '/internal/hybrid/control') {
                const body = await io.read(req)
                if (
                    !['/stop', '/smart-schedule/replan', '/capacity'].includes(body.route) &&
                    !/^\/smart-schedule\/accounts\/[1-9]\d*\/stop$/.test(body.route)
                )
                    throw updateFailure('UPDATE_IN_PROGRESS')
                return super.handle(req, res, url, { ...io, read: async () => body })
            }
        }
        if (route === '/internal/learning/events' && req.method === 'GET') {
            const after = Number(url.searchParams.get('after') || 0)
            if (!Number.isSafeInteger(after) || after < 0) {
                io.send(res, 400, { error: 'Invalid cursor' })
                return true
            }
            io.send(res, 200, {
                version: 1,
                status: this.learning.status(),
                records: this.learning.config ? this.learning.store.page(this.learning.config.collectionId, after) : []
            })
            return true
        }
        if (route === '/internal/learning/ack' && req.method === 'POST') {
            const body = await io.read(req)
            this.learning.store.ack(this.learning.config.collectionId, body.cursor)
            io.send(res, 200, { acknowledged: true })
            return true
        }
        const manual = /^\/manual-sessions(?:\/[1-9]\d*\/close)?$/.test(route)
        const android = /^\/android-sessions(?:\/[1-9]\d*(?:\/(?:stop|viewer))?)?$/.test(route)
        if (manual || android) {
            const available = manual ? this.capabilities.manualBrowser : this.capabilities.android
            if (!available) {
                io.send(res, 409, {
                    error: 'This worker does not support this action.',
                    code: 'CAPABILITY_UNAVAILABLE'
                })
                return true
            }
            return false
        }
        if (req.method === 'POST' && route === '/accounts/check-ip') return false
        // The owning coordinator is the only authority for deletion and scheduling.
        return super.handle(req, res, url, io)
    }
}
