import { WORKER_PROTOCOL, workerCapabilities, ACCOUNT_KEY as accountKey } from '../../packages/contracts/protocol.js'
import path from 'node:path'
import { runtimeFresh } from './execution.js'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { isDeepStrictEqual } from 'node:util'
import { HybridStore, atomicPrivateJson } from './hybridStore.js'
import { loadAccounts } from './accounts.js'
import { deriveNetworkGroup, validateSmartConfig } from './smartScheduler.js'
import { readConfig, validateConfig } from './configEditor.js'
import {
    exportAccountSession,
    importAccountSession,
    deleteStoredSessions,
    validateAccountSession
} from './sessionStore.js'
import { AccountIpChecker } from './accountIpChecker.js'
import { nodeResources } from './nodeResources.js'

function fail(message, code = 'HYBRID_UNAVAILABLE', status = 503) {
    throw Object.assign(new Error(message), { code, status })
}
const compress = promisify(gzip)

export class Hybrid {
    constructor({ projectRoot, environment = process.env }) {
        this.root = projectRoot
        this.env = environment
        this.role = environment.MRS_NODE_ROLE || (environment.MRS_REMOTE_URL ? 'local' : null)
        if (!this.role) return
        if (!['local', 'vps'].includes(this.role)) throw new Error('Invalid MRS_NODE_ROLE')
        if (this.role === 'local' && (!environment.MRS_REMOTE_URL || !environment.MRS_REMOTE_TOKEN))
            throw new Error('Hybrid remote connection is not configured')
        if (this.role === 'vps' && !environment.API_TOKEN) throw new Error('VPS node requires API_TOKEN')
        this.store = new HybridStore(environment.MRS_NODE_DATA || path.join(projectRoot, 'config', 'hybrid'))
        this.holds = this.store.get('holds') || {}
        this.transfers = this.store.get('transfers') || {}
        for (const transfer of Object.values(this.transfers))
            if (transfer.kind !== 'manual') transfer.requestDone = true
        this.blocked = new Set(Object.keys(this.transfers).map(Number))
        this.remote = this.store.get('remote')
        this.online = false
        this.manualBusy = new Set()
        if (this.role === 'vps') {
            const pending = this.store.get('pendingSnapshot')
            if (pending) this.activateSnapshot(pending)
            const snapshot = this.store.get('snapshot')
            if (snapshot) this.materialize(snapshot)
        }
    }
    get enabled() {
        return Boolean(this.role)
    }
    get hardParallel() {
        return this.role === 'vps' ? this.store?.get('capacity') || 2 : this.role === 'local' ? 1 : null
    }
    owns(account) {
        if (!this.enabled) return true
        if (this.blocked.has(account.index)) return false
        if (this.env.MRS_WORKER_MODE === '1') return true
        if (this.role === 'local' && this.remoteOwned(account)) return false
        return Boolean(account.proxy?.url) === (this.role === 'vps')
    }
    remoteOwned(account) {
        return (
            Boolean(account.proxy?.url) ||
            Boolean(this.remote?.smart?.config?.profiles?.some(profile => profile.accountIndex === account.index))
        )
    }
    schedulerOptions() {
        if (!this.enabled) return {}
        return {
            hardParallel: this.hardParallel,
            accountFilter: account => this.owns(account),
            manualLocks: new Map(Object.entries(this.holds).map(([index, hold]) => [Number(index), hold.scope === 'account' ? null : hold.group]))
        }
    }
    attach({ scheduler, pm, manual, status, permissions }) {
        if (!this.enabled) return
        Object.assign(this, { scheduler, pm, manual, status, permissions })
        const startupLogs = pm.logBuffer || []
        pm.logBuffer = this.store.recent(pm.logBufferSize)
        pm.logSeq = Number(this.store.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events').get().id)
        for (const entry of startupLogs) {
            this.store.append(entry)
            pm.logBuffer.push(entry)
            pm.logSeq = entry.id
        }
        pm.logBuffer = pm.logBuffer.slice(-pm.logBufferSize)
        pm.on('log', entry => {
            this.store.append(entry)
            pm.logSeq = entry.id
        })
        manual.on('change', event => {
            if (this.role === 'local' && event.type === 'exit' && event.exit?.code === 0)
                void this.releaseManual(event.session.accountIndex).catch(() => {})
        })
        if (this.role === 'local') {
            this.timer = setInterval(() => void this.sync(), 2000)
            this.timer.unref()
            void this.sync()
        }
    }
    sessionPath() {
        return readConfig(this.root).data.sessionPath || 'sessions'
    }
    account(index) {
        const account = loadAccounts(this.env).find(item => item.index === Number(index))
        if (!account) fail('Account is not configured.', 'ACCOUNT_NOT_FOUND', 404)
        return account
    }
    materialize(snapshot) {
        for (const key of Object.keys(this.env)) if (/^ACCOUNT_\d+_/.test(key)) delete this.env[key]
        Object.assign(this.env, snapshot.accountEnv)
        // The API service and spawned workers can have different working directories.
        // Pin both to the API's session location, where transferred sessions are stored.
        const botConfig = {
            ...snapshot.botConfig,
            sessionPath: this.env.MRS_WORKER_MODE === '1' ? path.join(this.env.MRS_WORKER_DATA, 'sessions') : path.resolve(process.cwd(), snapshot.botConfig.sessionPath || 'sessions')
        }
        atomicPrivateJson(this.env.MRS_CONFIG_FILE || path.join(this.root, 'config.json'), botConfig)
    }
    activateSnapshot(body) {
        const previous = this.store.get('snapshot')
        const previousAccounts = loadAccounts(previous?.accountEnv || {})
        const accounts = loadAccounts(body.accountEnv)
        const configFile = this.env.SMART_SCHEDULE_FILE || path.join(this.root, 'config', 'smart-schedule.json')
        let document = this.scheduler?.document
        if (!document) {
            try {
                document = JSON.parse(fs.readFileSync(configFile, 'utf8'))
            } catch {
                document = {}
            }
        }
        const state =
            !previous && body.initialState
                ? structuredClone(body.initialState)
                : structuredClone(document.state || { accounts: {}, sessions: [] })
        state.accounts ??= {}
        state.sessions ??= []
        if (body.schedule.enabled === false && state.urgentRun) state.urgentRun.active = false
        if (state.onceAccounts) state.onceAccounts = state.onceAccounts.filter(index => accounts.some(account => account.index === index))
        for (const hold of body.initialHolds || []) {
            if (!accounts.some(a => a.index === hold.index) || !/^[a-f0-9-]{36}$/.test(hold.token || '')) fail('Invalid initial hold.', 'BAD_REQUEST', 400)
            if (hold.scope !== undefined && !['account', 'group'].includes(hold.scope)) fail('Invalid hold scope.', 'BAD_REQUEST', 400)
            this.holds[hold.index] = { token: hold.token, scope: hold.scope || 'group', group: deriveNetworkGroup(accounts.find(a => a.index === hold.index), body.schedule.networkGroupOverride) }
        }
        this.store.set('holds', this.holds)
        if (this.scheduler) this.scheduler.manualLocks = new Map(Object.entries(this.holds).map(([index, hold]) => [Number(index), hold.scope === 'account' ? null : hold.group]))
        this.materialize(body)
        if (body.protocolVersion >= 2) {
            this.store.set('capacity', body.schedule.maxParallel)
            if (this.scheduler) this.scheduler.hardParallel = body.schedule.maxParallel
        }
        for (const account of previousAccounts)
            if (!accounts.some(a => a.index === account.index))
                deleteStoredSessions(this.root, this.sessionPath(), account.email)
        for (const item of body.initialSessions || []) {
            const account = accounts.find(a => a.index === item.index && a.email === item.email)
            if (account && !previousAccounts.some(a => a.index === account.index)) {
                let bundle = item.bundle
                if (item.stageId) {
                    if (!/^[a-f0-9-]{36}$/.test(item.stageId)) fail('Invalid session stage.', 'BAD_REQUEST', 400)
                    const staged = JSON.parse(
                        fs.readFileSync(path.join(this.store.directory, 'staged', `${item.stageId}.json`), 'utf8')
                    )
                    if (staged.index !== account.index || staged.email !== account.email)
                        fail('Invalid staged identity.', 'BAD_REQUEST', 400)
                    bundle = staged.bundle
                }
                importAccountSession(this.root, this.sessionPath(), account.email, bundle)
                if (item.planner) state.accounts[String(item.index)] = item.planner
            }
        }
        state.accounts = Object.fromEntries(
            Object.entries(state.accounts).filter(([index]) => accounts.some(a => a.index === Number(index)))
        )
        state.sessions = state.sessions.filter(job => accounts.some(a => a.index === job.accountIndex))
        if (state.urgentRun?.targets)
            state.urgentRun.targets = Object.fromEntries(
                Object.entries(state.urgentRun.targets).filter(([index]) =>
                    accounts.some(a => a.index === Number(index))
                )
            )
        atomicPrivateJson(configFile, { config: body.schedule, state })
        this.store.set('snapshot', { ...body, initialSessions: undefined, initialState: undefined, initialHolds: undefined })
        this.store.set('revision', body.revision)
        this.store.set('pendingSnapshot', null)
        for (const item of body.initialSessions || [])
            if (/^[a-f0-9-]{36}$/.test(item.stageId || '')) {
                fs.rmSync(path.join(this.store.directory, 'staged', `${item.stageId}.json`), { force: true })
            }
        if (this.scheduler) {
            this.scheduler.document = { config: body.schedule, state }
            this.scheduler.suspended = false
            this.scheduler.replan()
            this.scheduler._arm()
        }
    }
    canApplyMembershipSnapshot(body) {
        // Membership changes do not require unrelated jobs to finish. Each
        // running account keeps its exact environment, profile and node settings.
        if (this.env.MRS_WORKER_MODE !== '1') return false
        const previous = this.store.get('snapshot')
        if (!previous) return false
        const bot = config => ({ ...config, sessionPath: null })
        const settings = schedule => {
            const value = { ...schedule }; delete value.profiles; delete value.networkGroupOverride; return value
        }
        if (!isDeepStrictEqual(bot(previous.botConfig), bot(body.botConfig)) || !isDeepStrictEqual(settings(previous.schedule), settings(body.schedule))) return false
        const oldAccounts = loadAccounts(previous.accountEnv), nextAccounts = loadAccounts(body.accountEnv)
        const next = new Set(nextAccounts.map(account => account.index))
        for (const record of this.scheduler.running.values()) if (!next.has(record.job.accountIndex)) return false
        for (const account of oldAccounts) {
            if (!next.has(account.index)) {
                if (!this.holds[account.index]) return false
                continue
            }
            const prefix = `ACCOUNT_${account.index}_`
            const entries = env => Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith(prefix)))
            if (!isDeepStrictEqual(entries(previous.accountEnv), entries(body.accountEnv))) return false
            if (!isDeepStrictEqual(previous.schedule.profiles.find(profile => profile.accountIndex === account.index), body.schedule.profiles.find(profile => profile.accountIndex === account.index))) return false
            if (previous.schedule.networkGroupOverride?.[account.index] !== body.schedule.networkGroupOverride?.[account.index]) return false
        }
        return true
    }
    async call(route, method = 'GET', body, timeout = 20_000) {
        let response
        try {
            const json = body === undefined ? null : Buffer.from(JSON.stringify(body))
            const compressed = json && json.length > 65536
            const payload = compressed ? await compress(json) : json
            response = await fetch(new URL(route, this.env.MRS_REMOTE_URL), {
                method,
                headers: {
                    Authorization: `Bearer ${this.env.MRS_REMOTE_TOKEN}`,
                    'Content-Type': 'application/json',
                    ...(compressed ? { 'Content-Encoding': 'gzip' } : {})
                },
                ...(payload === null ? {} : { body: payload }),
                signal: AbortSignal.timeout(timeout)
            })
        } catch {
            this.online = false
            fail('VPS is unavailable. Its scheduler continues independently.')
        }
        const data = await response.json()
        this.online = true
        if (!response.ok) fail(data.error || 'VPS request failed.', data.code, response.status)
        return data
    }
    snapshot() {
        const indexes = new Set(
            loadAccounts(this.env)
                .filter(account => account.proxy)
                .map(account => account.index)
        )
        const accountEnv = Object.fromEntries(
            Object.entries(this.env).filter(([key]) => accountKey.test(key) && indexes.has(Number(key.split('_')[1])))
        )
        const botConfig = structuredClone(readConfig(this.root).data)
        botConfig.headless = true
        botConfig.clusters = 1
        botConfig.sessionPath = 'sessions'
        const schedule = structuredClone(this.scheduler.document.config)
        schedule.maxParallel = 2
        schedule.profiles = schedule.profiles.filter(profile => indexes.has(profile.accountIndex))
        const content = { accountEnv, botConfig, schedule }
        const revision = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex')
        let desired = this.store.get('desired')
        if (desired?.revision !== revision) {
            desired = { revision, generation: (desired?.generation || 0) + 1 }
            this.store.set('desired', desired)
        }
        return { ...content, ...desired, authority: this.store.nodeId }
    }
    async prepareTransfer(index, kind) {
        if (this.transfers[index])
            fail('Account has a pending transfer. Close manual sessions or wait for sync.', 'ACCOUNT_HELD', 409)
        if (this.manual.hasAccount(index)) fail('Close manual sessions first.', 'MANUAL_SESSION_ACTIVE', 409)
        const account = this.account(index)
        const transfer = { kind, token: crypto.randomUUID(), remote: this.remoteOwned(account), email: account.email }
        this.transfers[index] = transfer
        this.blocked.add(index)
        this.store.set('transfers', this.transfers)
        const held = transfer.remote
            ? await this.call(`/internal/hybrid/accounts/${index}/hold`, 'POST', { token: transfer.token }, 60_000)
            : await this.hold(index, transfer.token)
        if (transfer.remote) importAccountSession(this.root, this.sessionPath(), account.email, held.bundle)
        if (held.planner) this.scheduler.document.state.accounts[index] = held.planner
        transfer.ready = true
        this.store.set('transfers', this.transfers)
        return transfer
    }
    async finishTransfers() {
        for (const [key, transfer] of Object.entries(this.transfers)) {
            if (!transfer.ready || !transfer.requestDone || transfer.kind === 'manual') continue
            const index = Number(key)
            if (transfer.remote)
                await this.call(`/internal/hybrid/accounts/${index}/release`, 'POST', { token: transfer.token })
            else {
                delete this.holds[index]
                this.store.set('holds', this.holds)
                this.scheduler.clearManualLock(index)
            }
            delete this.transfers[index]
            this.blocked.delete(index)
            this.store.set('transfers', this.transfers)
        }
        this.scheduler.replan()
    }
    async sync() {
        if (this.busy || this.role !== 'local') return
        this.busy = true
        try {
            for (const [key, transfer] of Object.entries(this.transfers)) {
                if (transfer.kind === 'manual' || transfer.ready || !transfer.requestDone) continue
                const held = transfer.remote
                    ? await this.call(
                          `/internal/hybrid/accounts/${key}/hold`,
                          'POST',
                          { token: transfer.token },
                          60_000
                      )
                    : await this.hold(Number(key), transfer.token)
                if (transfer.remote) importAccountSession(this.root, this.sessionPath(), transfer.email, held.bundle)
                if (held.planner) this.scheduler.document.state.accounts[key] = held.planner
                transfer.ready = true
                this.store.set('transfers', this.transfers)
            }
            const snapshot = this.snapshot()
            const remote = await this.call('/internal/hybrid/status')
            if (
                remote.revision !== snapshot.revision ||
                remote.syncPending ||
                remote.smart.config.enabled !== snapshot.schedule.enabled
            ) {
                const known = new Set(remote.smart.config.profiles.map(profile => profile.accountIndex))
                const stages = this.store.get('stages') || {}
                snapshot.initialSessions = []
                for (const account of loadAccounts(this.env).filter(a => a.proxy && !known.has(a.index))) {
                    const key = `${snapshot.revision}:${account.index}`
                    const stage = stages[key] || { id: crypto.randomUUID(), uploaded: false }
                    stages[key] = stage
                    this.store.set('stages', stages)
                    if (!stage.uploaded) {
                        await this.call(
                            `/internal/hybrid/stage-session/${stage.id}`,
                            'PUT',
                            {
                                index: account.index,
                                email: account.email,
                                bundle: exportAccountSession(this.root, this.sessionPath(), account.email)
                            },
                            60_000
                        )
                        stage.uploaded = true
                        this.store.set('stages', stages)
                    }
                    snapshot.initialSessions.push({
                        index: account.index,
                        email: account.email,
                        stageId: stage.id,
                        planner: this.scheduler.document.state.accounts[String(account.index)] ?? null
                    })
                }
                if (!remote.revision) {
                    snapshot.initialState = this.scheduler.document.state
                }
                try {
                    await this.call('/internal/hybrid/snapshot', 'PUT', snapshot, 60_000)
                } catch (error) {
                    if (error.code !== 'SYNC_PENDING') throw error
                }
            }
            this.remote = await this.call('/internal/hybrid/status')
            this.remote.syncedAt = new Date().toISOString()
            this.store.set('remote', this.remote)
            if (this.remote.revision === snapshot.revision) {
                this.store.set('stages', {})
                await this.finishTransfers()
            }
            const cursor = this.store.get('cursor') || { node: this.remote.nodeId, id: 0 }
            const events = await this.call(
                `/internal/hybrid/events?afterId=${cursor.node === this.remote.nodeId ? cursor.id : 0}`
            )
            this.store.receive(events.events, {
                node: this.remote.nodeId,
                id: events.events.at(-1)?.journalId ?? (cursor.node === this.remote.nodeId ? cursor.id : 0)
            })
            for (const row of this.store.pending()) {
                this.pm.ingestEntry(JSON.parse(row.payload))
                this.store.emitted(row.source)
            }
            for (const [index, transfer] of Object.entries(this.transfers)) {
                if (transfer.kind === 'manual' && transfer.returnPending && !this.manual.hasAccount(Number(index)))
                    await this.releaseManual(Number(index))
            }
            this.scheduler.emit('change', this.scheduler.get())
        } catch (error) {
            this.lastError = error.code || 'SYNC_PENDING'
        } finally {
            this.busy = false
        }
    }
    decorateSmart(state) {
        if (!this.enabled) return state
        const tagged = (items, node) => (items || []).map(item => ({ ...item, node }))
        const node = this.role === 'vps' ? 'vps' : 'local'
        const result = {
            ...state,
            queue: tagged(state.queue, node),
            running: tagged(state.running, node),
            sessions: tagged(state.sessions, node)
        }
        if (this.role === 'vps') return result
        const remote = this.remote?.smart
        const localUrgent = state.urgent || {}
        const remoteUrgent = remote?.urgent || {}
        const active = Boolean(localUrgent.active || remoteUrgent.active)
        const failed = [
            ...(localUrgent.failed || []).filter(item => {
                const account = loadAccounts(this.env).find(a => a.index === item.accountIndex)
                return account && !this.remoteOwned(account)
            }),
            ...(remoteUrgent.failed || [])
        ]
        result.urgent = {
            ...localUrgent,
            active,
            failed,
            remaining: (localUrgent.remaining || 0) + (remoteUrgent.remaining || 0),
            effectiveParallel: 3,
            status: active
                ? 'active'
                : failed.length
                  ? 'incomplete'
                  : [localUrgent.status, remoteUrgent.status].includes('completed')
                    ? 'completed'
                    : localUrgent.status || 'idle'
        }
        result.effectiveEnabled = state.config.enabled || active
        const proxyIndexes = new Set(
            loadAccounts(this.env)
                .filter(a => this.remoteOwned(a))
                .map(a => String(a.index))
        )
        result.accounts = Object.fromEntries(
            Object.entries(state.accounts).filter(([index]) => !proxyIndexes.has(index))
        )
        for (const [index, account] of Object.entries(remote?.accounts || {}))
            if (proxyIndexes.has(index)) result.accounts[index] = account
        result.queue.push(...tagged(remote?.queue, 'vps'))
        const remoteFresh = runtimeFresh({ online: this.online, observedAt: this.remote?.syncedAt })
        if (remoteFresh)
            result.running.push(
                ...tagged(
                    (remote?.running || []).filter(job => proxyIndexes.has(String(job.accountIndex))),
                    'vps'
                )
            )
        result.sessions = [
            ...result.sessions.filter(job => !proxyIndexes.has(String(job.accountIndex))),
            ...tagged(remote?.sessions, 'vps')
        ]
            .sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)))
            .slice(0, 100)
        result.hybrid = {
            online: this.online,
            syncedAt: this.remote?.syncedAt ?? null,
            syncPending:
                this.remote?.revision !== this.snapshot().revision ||
                Boolean(this.remote?.syncPending) ||
                this.remote?.smart?.config?.enabled !== this.scheduler.document.config.enabled,
            local: { running: state.running.length, limit: 1 },
            vps: { running: remoteFresh ? (remote?.running?.length ?? 0) : 0, limit: this.remote?.limit || 2 },
            manualHolds: Object.keys(this.transfers).map(Number)
        }
        return result
    }
    async hold(index, token, { wait = false, scope = 'group' } = {}) {
        if (!['account', 'group'].includes(scope)) fail('Invalid hold scope.', 'BAD_REQUEST', 400)
        const account = this.account(index)
        const existing = this.holds[index]
        if (existing && existing.token !== token)
            fail('Account already held by another operation.', 'ACCOUNT_HELD', 409)
        if (existing?.checkpointFailed)
            fail(
                'Previous checkpoint failed. Resume the VPS account before retrying a handoff.',
                'CHECKPOINT_FAILED',
                409
            )
        const group =
            existing?.group || deriveNetworkGroup(account, this.scheduler.document.config.networkGroupOverride)
        this.holds[index] = { token, group, scope }
        this.store.set('holds', this.holds)
        this.scheduler.setManualLock(index, scope === 'account' ? null : group)
        const records = [...this.scheduler.running.values()].filter(record => scope === 'account' ? record.job.accountIndex === index : record.job.networkGroup === group)
        if (wait && records.length) fail('Waiting for the current run to finish.', 'WAITING_FOR_RUN', 409)
        for (const record of records) {
            record.handoff = true
            let saved = false
            const onLog = entry => {
                if (entry.title === 'SESSION-CHECKPOINT' && entry.message === 'All active browser sessions saved')
                    saved = true
            }
            record.manager.on('log', onLog)
            try {
                await record.manager.stop({ signalTree: false, signal: 'SIGUSR1' })
                if (!saved || record.manager.lastExit?.code !== 0) {
                    this.holds[index].checkpointFailed = true
                    this.store.set('holds', this.holds)
                    fail('Could not confirm a saved session; account remains held.', 'CHECKPOINT_FAILED', 409)
                }
            } finally {
                record.manager.off('log', onLog)
            }
        }
        return {
            token,
            email: account.email,
            bundle: exportAccountSession(this.root, this.sessionPath(), account.email),
            planner: this.scheduler.document.state.accounts[String(index)] ?? null
        }
    }
    async releaseManual(index) {
        const transfer = this.transfers[index]
        if (!transfer || transfer.kind !== 'manual' || this.manual.hasAccount(index) || this.manualBusy.has(index))
            return
        this.manualBusy.add(index)
        try {
            transfer.returnPending = true
            this.store.set('transfers', this.transfers)
            const account = this.account(index)
            await this.call(`/internal/hybrid/accounts/${index}/release`, 'POST', {
                token: transfer.token,
                ...(transfer.ready
                    ? { bundle: exportAccountSession(this.root, this.sessionPath(), account.email) }
                    : {})
            })
            delete this.transfers[index]
            this.blocked.delete(index)
            this.store.set('transfers', this.transfers)
        } finally {
            this.manualBusy.delete(index)
        }
    }
    async handle(req, res, url, { read, send }) {
        if (!this.enabled) return false
        const route = url.pathname.replace(/\/+$/, '')
        const method = req.method
        const reply = (status, data) => {
            send(res, status, data)
            return true
        }
        try {
            if (route === '/hybrid/events' && method === 'GET')
                return reply(200, {
                    nodeId: this.store.nodeId,
                    events: this.store.events(Math.max(0, Number(url.searchParams.get('afterId')) || 0))
                })
            if (route.startsWith('/internal/hybrid/')) {
                if (this.role !== 'vps') return reply(404, { error: 'Not found' })
                const stage = /^\/internal\/hybrid\/stage-session\/([a-f0-9-]{36})$/.exec(route)
                if (stage && method === 'PUT') {
                    const body = await read(req)
                    if (!Number.isSafeInteger(body.index) || body.index < 1 || typeof body.email !== 'string')
                        fail('Invalid staged session.', 'BAD_REQUEST', 400)
                    validateAccountSession(body.email, body.bundle)
                    atomicPrivateJson(path.join(this.store.directory, 'staged', `${stage[1]}.json`), body)
                    return reply(200, { staged: true })
                }
                if (route === '/internal/hybrid/status' && method === 'GET')
                    return reply(200, {
                        nodeId: this.store.nodeId,
                        protocolVersion: this.env.MRS_WORKER_MODE === '1' ? WORKER_PROTOCOL : 2,
                        capabilities: this.env.MRS_WORKER_MODE === '1' ? workerCapabilities(this.env.MRS_WORKER_KIND, this.env) : undefined,
                        installation: this.env.MRS_WORKER_MODE === '1' ? { data: this.env.MRS_WORKER_DATA, root: this.env.MRS_WORKER_ROOT || null } : undefined,
                        manualSessions: this.manual.list(),
                        manualExits: this.env.MRS_WORKER_MODE === '1' ? this.store.get('manualExits') || {} : undefined,
                        generation: this.store.get('snapshot')?.generation || 0,
                        resources: nodeResources(),
                        revision: this.store.get('revision'),
                        syncPending: this.scheduler.suspended,
                        limit: this.hardParallel,
                        smart: this.scheduler.get(),
                        accounts: this.pm.getStatus().run.accounts,
                        points: this.pm.getPoints(),
                        history: this.pm.getHistory().slice(0, 20),
                        holds: Object.keys(this.holds).map(Number)
                    })
                if (route === '/internal/hybrid/events' && method === 'GET')
                    return reply(200, {
                        events: this.store.events(Math.max(0, Number(url.searchParams.get('afterId')) || 0))
                    })
                if (route === '/internal/hybrid/probe' && method === 'POST') {
                    const body = await read(req)
                    const results = await new AccountIpChecker({ concurrency: 1 }).check(body.accountIndexes ?? null)
                    return reply(200, {
                        results: results.map(result => ({ index: result.accountIndex, ok: Boolean(result.ip) }))
                    })
                }
                if (route === '/internal/hybrid/control' && method === 'POST') {
                    const { route: command, body = {} } = await read(req)
                    const stopAccount = /^\/smart-schedule\/accounts\/([1-9]\d*)\/stop$/.exec(command)
                    if (stopAccount) {
                        const result = await this.scheduler.stopAccount(Number(stopAccount[1]), body.jobId)
                        return reply(200, { result, smart: this.scheduler.get() })
                    }
                    if (command === '/run-once' && this.env.MRS_WORKER_MODE === '1') {
                        await this.scheduler.retryAccounts(body.accountIndexes, { preempt: false, runOnce: true })
                    } else if (command === '/capacity') {
                        if (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 32)
                            fail('Capacity must be between 1 and 32.', 'BAD_REQUEST', 400)
                        this.store.set('capacity', body.limit)
                        this.scheduler.hardParallel = body.limit
                        this.scheduler.replan()
                    } else if (command === '/smart-schedule/urgent') {
                        if (typeof body.enabled !== 'boolean') fail('enabled must be boolean.', 'BAD_REQUEST', 400)
                        this.scheduler.setUrgent(body.enabled)
                    } else if (command === '/smart-schedule/retry')
                        await this.scheduler.retryAccounts(body.accountIndexes, { preempt: body.preempt })
                    else if (command === '/smart-schedule/replan') this.scheduler.replan(body)
                    else if (command === '/stop') {
                        if (this.env.MRS_WORKER_MODE === '1') {
                            this.scheduler.suspended = true
                            this.scheduler.document.state.onceAccounts = []
                            if (this.scheduler.document.state.urgentRun) this.scheduler.document.state.urgentRun.active = false
                            this.scheduler._save()
                        }
                        await this.scheduler.stop(this.env.MRS_WORKER_MODE === '1' ? { resume: false } : {})
                    }
                    else if (['/start', '/restart'].includes(command)) {
                        if (command === '/restart') await this.scheduler.stop()
                        this.scheduler.trigger(body.accountIndex == null ? null : [Number(body.accountIndex)], {
                            force: true
                        })
                    } else fail('Unknown node command.', 'BAD_REQUEST', 400)
                    return reply(202, { applied: true, smart: this.scheduler.get() })
                }
                if (route === '/internal/hybrid/snapshot' && method === 'PUT') {
                    if (this.applying) fail('Configuration activation in progress.', 'SYNC_PENDING', 409)
                    this.applying = true
                    try {
                        const body = await read(req)
                        if (this.env.MRS_WORKER_MODE === '1' && body.protocolVersion !== WORKER_PROTOCOL) fail('Worker protocol mismatch.', 'UPGRADE_REQUIRED', 409)
                        if (
                            !/^[a-f0-9]{64}$/.test(body.revision || '') ||
                            !body.accountEnv ||
                            Object.entries(body.accountEnv).some(
                                ([key, value]) => !accountKey.test(key) || typeof value !== 'string'
                            )
                        )
                            fail('Invalid node snapshot.', 'BAD_REQUEST', 400)
                        if (this.env.MRS_WORKER_MODE === '1') {
                            const accepted = this.store.get('pendingSnapshot') || this.store.get('snapshot')
                            if (!Number.isSafeInteger(body.generation) || body.generation < 1 || !/^[a-f0-9-]{36}$/.test(body.authority || '')) fail('Invalid snapshot authority.', 'BAD_REQUEST', 400)
                            if (accepted && (accepted.authority !== body.authority || accepted.generation > body.generation || (accepted.generation === body.generation && accepted.revision !== body.revision))) fail('Stale snapshot.', 'STALE_SNAPSHOT', 409)
                        }
                        if (body.revision === this.store.get('revision')) {
                            const accepted = this.store.get('snapshot')
                            this.store.set('pendingSnapshot', null)
                            this.scheduler.suspended = false
                            if (accepted && this.scheduler.document.config.enabled !== accepted.schedule.enabled)
                                this.scheduler.update({
                                    ...this.scheduler.document.config,
                                    enabled: accepted.schedule.enabled
                                })
                            else this.scheduler._arm()
                            return reply(200, { applied: true })
                        }
                        const accounts = loadAccounts(body.accountEnv)
                        if (accounts.some(account => !account.proxy) && !(this.env.MRS_WORKER_MODE === '1' && this.env.MRS_WORKER_KIND === 'local'))
                            fail('VPS accepts proxied accounts only.', 'BAD_REQUEST', 400)
                        const validation = await validateConfig(body.botConfig, { projectRoot: this.root })
                        if (!validation.ok) fail('Invalid bot configuration.', 'BAD_REQUEST', 400)
                        const schedule = validateSmartConfig(body.schedule, accounts)
                        const previous = this.store.get('snapshot')
                        if (
                            !Number.isSafeInteger(body.generation) ||
                            body.generation < 1 ||
                            !/^[a-f0-9-]{36}$/.test(body.authority || '')
                        )
                            fail('Missing snapshot generation.', 'BAD_REQUEST', 400)
                        if (
                            previous &&
                            (previous.authority !== body.authority ||
                                previous.generation > body.generation ||
                                (previous.generation === body.generation && previous.revision !== body.revision))
                        )
                            fail('A newer configuration has already been accepted.', 'STALE_SNAPSHOT', 409)
                        for (const account of loadAccounts(previous?.accountEnv || {})) {
                            if (!accounts.some(a => a.index === account.index) && !this.holds[account.index])
                                fail('Account removal requires a handoff hold.', 'ACCOUNT_HELD', 409)
                        }
                        // Keep validated configuration durable while jobs drain. Otherwise a restart
                        // resumes the old schedule before the coordinator can retry activation.
                        body.schedule = schedule
                        this.store.set('pendingSnapshot', body)
                        if (this.scheduler.running.size && !this.canApplyMembershipSnapshot(body)) {
                            this.scheduler.suspended = true
                            fail('Waiting for running jobs before applying configuration.', 'SYNC_PENDING', 409)
                        }
                        this.scheduler.suspended = true
                        this.activateSnapshot(body)
                        return reply(200, { applied: true })
                    } finally {
                        this.applying = false
                    }
                }
                const match = /^\/internal\/hybrid\/accounts\/(\d+)\/(hold|release|delete-session)$/.exec(route)
                if (match && method === 'POST') {
                    const index = Number(match[1])
                    const body = await read(req)
                    if (!/^[a-f0-9-]{36}$/.test(body.token || '')) fail('Invalid hold token.', 'BAD_REQUEST', 400)
                    const released = this.store.get('released') || {}
                    if (!this.holds[index] && released[index] === body.token) {
                        if (match[2] === 'hold') fail('Handoff already completed.', 'STALE_HANDOFF', 409)
                        return reply(200, { released: true })
                    }
                    if (match[2] === 'hold')
                        return reply(200, await this.hold(index, body.token, { wait: Boolean(body.wait), scope: body.scope || 'group' }))
                    if (this.holds[index]?.token !== body.token) fail('Hold token does not match.', 'ACCOUNT_HELD', 409)
                    const account = loadAccounts(this.env).find(a => a.index === index)
                    if (match[2] === 'delete-session')
                        deleteStoredSessions(this.root, this.sessionPath(), account.email)
                    else if (body.bundle) {
                        if (!account) fail('Account was removed.', 'ACCOUNT_NOT_FOUND', 404)
                        importAccountSession(this.root, this.sessionPath(), account.email, body.bundle)
                    }
                    delete this.holds[index]
                    this.store.set('holds', this.holds)
                    released[index] = body.token
                    this.store.set('released', released)
                    this.scheduler.clearManualLock(index)
                    return reply(200, { released: true })
                }
                return reply(404, { error: 'Not found' })
            }
            if (this.role === 'vps') {
                if (method !== 'GET' && method !== 'OPTIONS')
                    return reply(403, { error: 'Use the home coordinator to manage this node.' })
                return false
            }
            if (method === 'POST' && route === '/manual-sessions') {
                const body = await read(req)
                const index = Number(body.accountIndex)
                if (this.manualBusy.has(index))
                    fail('Session handoff is in progress. Please retry shortly.', 'HANDOFF_BUSY', 409)
                this.manualBusy.add(index)
                try {
                    if (!['desktop', 'mobile'].includes(body.platform)) fail('Invalid platform.', 'BAD_REQUEST', 400)
                    const account = this.account(index)
                    if (this.remoteOwned(account)) {
                        let transfer = this.transfers[index]
                        if (transfer && transfer.kind !== 'manual')
                            fail('An ownership transfer is pending.', 'ACCOUNT_HELD', 409)
                        if (!transfer) {
                            transfer = { kind: 'manual', token: crypto.randomUUID(), returnPending: false }
                            this.transfers[index] = transfer
                            this.store.set('transfers', this.transfers)
                            const held = await this.call(
                                `/internal/hybrid/accounts/${index}/hold`,
                                'POST',
                                { token: transfer.token },
                                60_000
                            )
                            importAccountSession(this.root, this.sessionPath(), account.email, held.bundle)
                            transfer.ready = true
                            this.store.set('transfers', this.transfers)
                        } else if (!transfer.ready) {
                            const held = await this.call(
                                `/internal/hybrid/accounts/${index}/hold`,
                                'POST',
                                { token: transfer.token },
                                60_000
                            )
                            importAccountSession(this.root, this.sessionPath(), account.email, held.bundle)
                            transfer.ready = true
                            this.store.set('transfers', this.transfers)
                        }
                    }
                    const session = await this.manual.open({
                        accountIndex: index,
                        email: account.email,
                        preRewards: this.scheduler.isPreRewardsAccount(index),
                        platform: body.platform
                    })
                    return reply(202, { opened: true, session })
                } finally {
                    this.manualBusy.delete(index)
                }
            }
            if (method === 'POST' && /^\/manual-sessions\/\d+\/close$/.test(route)) return false
            const resume = /^\/hybrid\/accounts\/(\d+)\/resume$/.exec(route)
            if (resume && method === 'POST') {
                const index = Number(resume[1])
                if (this.manual.hasAccount(index)) fail('Close all manual windows first.', 'MANUAL_SESSION_ACTIVE', 409)
                const transfer = this.transfers[index]
                if (!transfer) fail('No handoff to return.', 'BAD_REQUEST', 400)
                if (this.manualBusy.has(index)) fail('Session handoff is in progress.', 'HANDOFF_BUSY', 409)
                if (transfer.kind === 'manual') await this.releaseManual(index)
                else {
                    if (transfer.ready) fail('Ownership sync is pending. Wait for it to finish.', 'SYNC_PENDING', 409)
                    if (transfer.remote)
                        await this.call(`/internal/hybrid/accounts/${index}/release`, 'POST', { token: transfer.token })
                    else {
                        delete this.holds[index]
                        this.store.set('holds', this.holds)
                        this.scheduler.clearManualLock(index)
                    }
                    delete this.transfers[index]
                    this.blocked.delete(index)
                    this.store.set('transfers', this.transfers)
                }
                return reply(200, { returned: true })
            }
            if (
                method === 'POST' &&
                route === '/accounts' &&
                Object.values(this.transfers).some(t => t.kind !== 'manual')
            )
                fail('Wait for the account ownership transfer to finish before adding accounts.', 'ACCOUNT_HELD', 409)
            const accountMutation = /^\/accounts\/(\d+)$/.exec(route)
            const stopScheduledAccount = /^\/smart-schedule\/accounts\/([1-9]\d*)\/stop$/.exec(route)
            if (stopScheduledAccount && method === 'POST' && this.role === 'local') {
                if (!this.permissions.schedule) return reply(403, { error: 'Schedule writes disabled.' })
                const index = Number(stopScheduledAccount[1])
                if (!this.remoteOwned(this.account(index))) return false
                if (!runtimeFresh({ online: this.online, observedAt: this.remote?.syncedAt }))
                    fail('Machine runtime cannot be verified.', 'RUNTIME_UNKNOWN', 503)
                const body = await read(req)
                const result = await this.call('/internal/hybrid/control', 'POST', { route, body }, 60000)
                await this.sync()
                return reply(200, result.result)
            }
            if (accountMutation && ['PATCH', 'DELETE'].includes(method)) {
                if (!this.permissions.accounts) return reply(403, { error: 'Account writes are disabled.' })
                const index = Number(accountMutation[1])
                res.once('finish', () => {
                    if (this.transfers[index]) this.transfers[index].requestDone = true
                    this.store.set('transfers', this.transfers)
                    void this.sync()
                })
                await this.prepareTransfer(index, 'ownership')
                return false
            }
            if (method === 'DELETE' && route.startsWith('/sessions/')) {
                const email = decodeURIComponent(route.slice('/sessions/'.length))
                const account = loadAccounts(this.env).find(a => a.email.toLowerCase() === email.toLowerCase())
                if (account) {
                    const transfer = await this.prepareTransfer(account.index, 'delete-session')
                    if (transfer.remote)
                        await this.call(`/internal/hybrid/accounts/${account.index}/delete-session`, 'POST', {
                            token: transfer.token
                        })
                    deleteStoredSessions(this.root, this.sessionPath(), account.email)
                    if (!transfer.remote) {
                        delete this.holds[account.index]
                        this.store.set('holds', this.holds)
                        this.scheduler.clearManualLock(account.index)
                    }
                    delete this.transfers[account.index]
                    this.blocked.delete(account.index)
                    this.store.set('transfers', this.transfers)
                    this.scheduler.replan()
                    return reply(200, { removed: true, email })
                }
            }
            if (
                ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) &&
                [
                    '/start',
                    '/stop',
                    '/restart',
                    '/smart-schedule',
                    '/smart-schedule/urgent',
                    '/smart-schedule/replan'
                ].includes(route)
            ) {
                if (!this.permissions.schedule) return reply(403, { error: 'Schedule writes are disabled.' })
                const body = await read(req)
                if (
                    (route === '/smart-schedule' && method !== 'PUT') ||
                    (route !== '/smart-schedule' && method !== 'POST')
                )
                    return false
                if (body.args != null || body.env != null || body.excludedAccountIndexes != null)
                    fail('Hybrid mode requires Smart Scheduler.', 'HYBRID_SMART_REQUIRED', 409)
                if (route === '/smart-schedule' && method === 'PUT') {
                    this.scheduler.update({ ...body, maxParallel: 3 })
                    await this.sync()
                    return reply(200, { ...this.decorateSmart(this.scheduler.get()), writable: true })
                }
                const selected = body.accountIndex == null ? null : this.account(body.accountIndex)
                if (
                    route.endsWith('/replan') &&
                    body.accountIndexes != null &&
                    (!Array.isArray(body.accountIndexes) ||
                        body.accountIndexes.some(index => !Number.isSafeInteger(Number(index)) || Number(index) < 1))
                )
                    fail('accountIndexes must contain positive integers.', 'BAD_REQUEST', 400)
                const remoteNeeded = !selected || this.remoteOwned(selected)
                if (remoteNeeded && !this.online) {
                    if (route === '/stop') {
                        await this.scheduler.stop()
                        return reply(503, {
                            error: 'Local jobs stopped. VPS is offline; its jobs have not been stopped.',
                            code: 'VPS_OFFLINE',
                            localApplied: true,
                            remoteApplied: false
                        })
                    }
                    fail('VPS is offline; this operation has not been applied.')
                }
                const forward = remoteNeeded
                    ? await this.call(`/internal/hybrid/control`, 'POST', { route, body }, 60_000)
                    : {}
                if (route.endsWith('/urgent')) {
                    this.scheduler.setUrgent(body.enabled)
                    const run = this.scheduler.document.state.urgentRun
                    if (body.enabled && run?.targets) {
                        run.targets = Object.fromEntries(
                            Object.entries(run.targets).filter(([index]) => {
                                const account = loadAccounts(this.env).find(a => a.index === Number(index))
                                return account && !this.remoteOwned(account)
                            })
                        )
                        this.scheduler.replan()
                        this.scheduler._save()
                    }
                } else if (route.endsWith('/replan')) this.scheduler.replan(body)
                else if (route === '/stop') await this.scheduler.stop()
                else {
                    if (route === '/restart') await this.scheduler.stop()
                    this.scheduler.trigger(body.accountIndex == null ? null : [Number(body.accountIndex)], {
                        force: true
                    })
                }
                return reply(202, { ...forward, smart: true, ...this.decorateSmart(this.scheduler.get()) })
            }
            // Writes handled by existing routes still trigger a revision sync.
            if (method !== 'GET')
                res.once('finish', () => {
                    if (res.statusCode < 300) void this.sync()
                })
            return false
        } catch (error) {
            return reply(error.status || 500, {
                error: error.code ? error.message : 'Hybrid operation failed.',
                code: error.code || 'HYBRID_ERROR'
            })
        }
    }
    close() {
        clearInterval(this.timer)
        this.store?.close()
    }
}
