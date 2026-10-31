import { Hybrid } from '../api/hybrid.js'
import { workerCapabilities } from '../../packages/contracts/protocol.js'

// The runtime controller is reused, while coordinator-only entry points remain unavailable.
export class WorkerAgent extends Hybrid {
    attach(context) {
        super.attach(context)
        context.manual.on('change', event => {
            if (event.type !== 'exit') return
            const exits = this.store.get('manualExits') || {}
            exits[event.session.accountIndex] = { ok: event.exit?.code === 0 && !event.exit?.signal, at: new Date().toISOString() }
            this.store.set('manualExits', exits)
        })
    }
    get capabilities() {
        return workerCapabilities(this.env.MRS_WORKER_KIND, this.env)
    }

    async handle(req, res, url, io) {
        const route = url.pathname.replace(/\/+$/, '')
        const manual = /^\/manual-sessions(?:\/[1-9]\d*\/close)?$/.test(route)
        const android = /^\/android-sessions(?:\/[1-9]\d*(?:\/(?:stop|viewer))?)?$/.test(route)
        if (manual || android) {
            const available = manual ? this.capabilities.manualBrowser : this.capabilities.android
            if (!available) {
                io.send(res, 409, { error: 'This worker does not support this action.', code: 'CAPABILITY_UNAVAILABLE' })
                return true
            }
            return false
        }
        if (req.method === 'POST' && route === '/accounts/check-ip') return false
        // The owning coordinator is the only authority for deletion and scheduling.
        return super.handle(req, res, url, io)
    }
}
