import fs from 'node:fs'
import { runtimeFresh } from './execution.js'
import path from 'node:path'
import crypto from 'node:crypto'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { Hybrid } from './hybrid.js'
import { atomicPrivateJson } from './hybridStore.js'
import { loadAccounts } from './accounts.js'
import { deriveNetworkGroup, validateSmartConfig } from './smartScheduler.js'
import { readConfig, deepMerge, validateConfig } from './configEditor.js'
import { exportAccountSession, importAccountSession } from './sessionStore.js'
import { redactSecrets } from './lib.js'
import { nodeResources } from './nodeResources.js'
import { NodeProvisioner } from './nodeProvisioner.js'

const compress = promisify(gzip)
const accountKey =
    /^ACCOUNT_[1-9]\d*_(EMAIL|PASSWORD|TOTP_SECRET|RECOVERY_EMAIL|GEO_LOCALE|LANG_CODE|PROXY_(URL|PORT|USERNAME|PASSWORD|HTTP|AXIOS)|SAVE_FINGERPRINT_(MOBILE|DESKTOP))$/
const clone = value => structuredClone(value)
const redactSettings = value => ({ ...clone(value), ...(value.bot ? { bot: redactSecrets(value.bot) } : {}) })
const managedBotKeys = ['sessionPath', 'clusters']
function fail(message, code = 'BAD_REQUEST', status = 400) {
    throw Object.assign(new Error(message), { code, status })
}
function hash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function restoreRedacted(value, previous) {
    if (value === '***REDACTED***') return previous
    if (Array.isArray(value)) return value.map((v, i) => restoreRedacted(v, previous?.[i]))
    if (value && typeof value === 'object')
        return Object.fromEntries(
            Object.entries(value).map(([k, v]) => {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) fail('Unsafe configuration key.')
                return [k, restoreRedacted(v, previous?.[k])]
            })
        )
    return value
}

export class Fleet extends Hybrid {
    constructor(options) {
        const environment = options.environment || process.env
        environment.MRS_REMOTE_URL ||= 'http://127.0.0.1:1'
        environment.MRS_REMOTE_TOKEN ||= 'unconfigured'
        super({ ...options, environment })
        this.registry = this.store.get('fleet')
        this.states = new Map()
        this.operations = this.store.get('fleetOperations') || []
        this.operationBusy = new Set()
        this.provisioner = new NodeProvisioner(this)
        this.initialize()
        for (const op of this.operations)
            if (op.kind === 'install' && op.phase !== 'done' && ['running', 'pending'].includes(op.status)) {
                op.status = 'error'
                op.error = 'INSTALL_INTERRUPTED'
            }
        this.saveOperations()
        for (const op of this.operations.filter(o => o.kind === 'assignment' && o.phase !== 'done'))
            for (const m of op.members) this.blocked.add(m.index)
        for (const node of this.registry?.nodes || [])
            if (node.id !== 'local')
                this.states.set(node.id, this.store.get(`node:${node.id}:status`) || this.states.get(node.id) || {})
    }
    get hardParallel() {
        return this.registry ? this.effective('local').schedule.maxParallel : 1
    }
    save() {
        this.store.set('fleet', this.registry)
    }
    node(id) {
        const node = this.registry?.nodes.find(n => n.id === id)
        if (!node) fail('Machine not found.', 'NOT_FOUND', 404)
        return node
    }
    accounts() {
        return loadAccounts(this.env)
    }
    initialize() {
        if (this.registry) return
        const accounts = this.accounts()
        const existing = this.remote
        const oldNodeId = existing?.nodeId || crypto.randomUUID()
        const hasRemote = this.env.MRS_REMOTE_TOKEN !== 'unconfigured'
        let saved = {}
        try {
            saved = JSON.parse(
                fs.readFileSync(
                    this.env.SMART_SCHEDULE_FILE || path.join(this.root, 'config', 'smart-schedule.json'),
                    'utf8'
                )
            )
        } catch {}
        const schedule = this.scheduler?.document.config || validateSmartConfig(saved.config || saved, accounts)
        this.registry = {
            version: 2,
            defaults: { bot: clone(readConfig(this.root).data), schedule: { ...clone(schedule), maxParallel: 1 } },
            nodes: [{ id: 'local', name: 'Local', kind: 'local', overrides: {} }],
            assignments: {},
            initial: true
        }
        if (hasRemote) {
            this.registry.nodes.push({
                id: oldNodeId,
                name: 'VPS 1',
                kind: 'vps',
                url: this.env.MRS_REMOTE_URL,
                token: this.env.MRS_REMOTE_TOKEN,
                overrides: { schedule: { maxParallel: existing?.limit || 2 } },
                legacy: true,
                ...(this.env.MRS_REMOTE_SSH_HOST
                    ? {
                          ssh: {
                              host: this.env.MRS_REMOTE_SSH_HOST,
                              user: this.env.MRS_REMOTE_SSH_USER || 'tool',
                              port: Number(this.env.MRS_REMOTE_SSH_PORT || 22),
                              key: 'id_ed25519',
                              service: 'msrw-vps-tunnel.service'
                          }
                      }
                    : {})
            })
            this.states.set(oldNodeId, { remote: existing, online: false })
            const cursor = this.store.get('cursor')
            if (cursor) this.store.set(`node:${oldNodeId}:cursor`, cursor)
        }
        for (const a of accounts) this.registry.assignments[a.index] = a.proxy && hasRemote ? oldNodeId : 'local'
        this.save()
    }
    attach(context) {
        Object.assign(this, context)
        this.initialize()
        this.scheduler.hardParallel = this.hardParallel
        this.pm.prependListener('log', entry => {
            entry.nodeId ||= this.registry.nodes.some(n => n.id === entry.sourceNode) ? entry.sourceNode : 'local'
            entry.nodeName ||= this.registry.nodes.find(n => n.id === entry.nodeId)?.name || entry.nodeId
        })
        super.attach(context)
        this.applyLocal()
    }
    owner(account) {
        const a = typeof account === 'object' ? account : this.accounts().find(a => a.index === Number(account))
        if (!a) return this.registry?.assignments[Number(account)] || 'local'
        // A direct account remains held on its former owner until an explicit safe transfer completes.
        return (
            this.registry?.assignments[a.index] ||
            (a.proxy ? this.registry?.nodes.find(n => n.legacy)?.id : null) ||
            'local'
        )
    }
    owns(account) {
        return this.owner(account) === 'local' && !this.blocked.has(account.index)
    }
    remoteOwned(account) {
        return this.owner(account) !== 'local'
    }
    metadata(account) {
        const id = this.owner(account),
            node = this.registry?.nodes.find(n => n.id === id)
        return {
            node: id === 'local' ? 'local' : 'vps',
            nodeId: id,
            nodeName: node?.name || id,
            nodeOnline: id === 'local' || Boolean(this.states.get(id)?.online),
            assignmentPending: Boolean(this.operationFor(account.index))
        }
    }
    operationFor(index) {
        return this.operations.find(
            op => op.kind === 'assignment' && op.phase !== 'done' && op.members.some(m => m.index === Number(index))
        )
    }
    snapshotOwner(account) {
        const op = this.operationFor(account.index)
        if (op?.phase === 'revoking') return null
        if (op?.phase === 'activating') return op.target
        return this.owner(account)
    }
    effective(id) {
        const node = this.registry.nodes.find(n => n.id === id)
        const value = deepMerge(this.registry.defaults, node?.overrides || {})
        value.bot.clusters = 1
        if (id !== 'local') {
            value.bot.headless = true
            value.bot.sessionPath = 'sessions'
        } else value.bot.sessionPath = this.registry.defaults.bot.sessionPath
        return value
    }
    applyLocal() {
        if (!this.registry || !this.scheduler) return
        const value = this.effective('local')
        const revision = hash(value)
        const state = this.store.get('localApplied')
        if (state === revision) return
        if (this.scheduler.running.size) {
            this.localPending = true
            this.scheduler.suspended = true
            return
        }
        atomicPrivateJson(path.join(this.root, 'config.json'), value.bot)
        this.scheduler.hardParallel = value.schedule.maxParallel
        this.scheduler.suspended = false
        this.scheduler.update(validateSmartConfig(value.schedule, this.accounts()))
        this.store.set('localApplied', revision)
        this.localPending = false
    }
    snapshot(id = this.registry.nodes.find(n => n.id !== 'local')?.id) {
        const indexes = new Set(
            this.accounts()
                .filter(a => this.snapshotOwner(a) === id)
                .map(a => a.index)
        )
        const value = this.effective(id)
        const accountEnv = Object.fromEntries(
            Object.entries(this.env).filter(([key]) => accountKey.test(key) && indexes.has(Number(key.split('_')[1])))
        )
        const schedule = clone(value.schedule)
        schedule.profiles = schedule.profiles.filter(p => indexes.has(p.accountIndex))
        const content = { protocolVersion: 2, accountEnv, botConfig: value.bot, schedule }
        const revision = hash(content)
        let desired = this.store.get(`node:${id}:desired`)
        if (desired?.revision !== revision) {
            desired = { revision, generation: (desired?.generation || 0) + 1 }
            this.store.set(`node:${id}:desired`, desired)
        }
        // Adopt legacy generations before the first update without changing identity/cursors.
        const accepted = this.states.get(id)?.remote
        if (accepted?.revision !== revision && desired.generation <= (accepted?.generation || 0)) {
            desired.generation = accepted.generation + 1
            this.store.set(`node:${id}:desired`, desired)
        }
        return { ...content, ...desired, authority: this.store.nodeId }
    }
    async call(route, method = 'GET', body, timeout = 20_000, nodeId) {
        const match = /\/accounts\/(\d+)\//.exec(route)
        nodeId ||= match
            ? this.transfers[match[1]]?.sourceNode || this.owner(Number(match[1]))
            : this.registry.nodes.find(n => n.id !== 'local')?.id
        const node = this.node(nodeId)
        if (node.id === 'local') fail('Remote machine is required.')
        const state = this.states.get(nodeId) || {}
        this.states.set(nodeId, state)
        try {
            const json = body === undefined ? null : Buffer.from(JSON.stringify(body))
            const compressed = json?.length > 65536
            const response = await fetch(new URL(route, node.url), {
                method,
                headers: {
                    Authorization: `Bearer ${node.token}`,
                    'Content-Type': 'application/json',
                    ...(compressed ? { 'Content-Encoding': 'gzip' } : {})
                },
                ...(json === null ? {} : { body: compressed ? await compress(json) : json }),
                signal: AbortSignal.timeout(timeout)
            })
            const data = await response.json()
            state.online = true
            if (!response.ok)
                fail(data.error || 'Machine rejected the request.', data.code || 'NODE_ERROR', response.status)
            return data
        } catch (error) {
            if (!error.status) {
                state.online = false
                fail('Machine unavailable; its accepted schedule continues independently.', 'NODE_OFFLINE', 503)
            }
            throw error
        }
    }
    async syncNode(node) {
        const state = this.states.get(node.id) || {}
        this.states.set(node.id, state)
        if (state.busy || node.installing) return
        state.busy = true
        try {
            let remote = await this.call('/internal/hybrid/status', 'GET', undefined, 8000, node.id)
            if (remote.nodeId !== node.id) {
                // The one legacy connection may not have been observed before migration.
                if (node.legacy && !state.remote?.nodeId) {
                    const old = node.id
                    node.id = remote.nodeId
                    for (const [index, id] of Object.entries(this.registry.assignments))
                        if (id === old) this.registry.assignments[index] = node.id
                    this.states.delete(old)
                    this.states.set(node.id, state)
                    this.save()
                } else fail('Machine identity does not match the registered node.', 'NODE_IDENTITY', 409)
            }
            if (remote.protocolVersion !== 2)
                fail('Upgrade this machine runtime before applying fleet settings.', 'UPGRADE_REQUIRED', 409)
            state.remote = remote
            state.observedAt = new Date().toISOString()
            const snapshot = this.snapshot(node.id)
            if (
                snapshot.revision !== remote.revision ||
                remote.syncPending ||
                snapshot.schedule.enabled !== remote.smart.config.enabled
            ) {
                const known = new Set(remote.smart.config.profiles.map(p => p.accountIndex))
                const stages = this.store.get(`node:${node.id}:stages`) || {}
                snapshot.initialSessions = []
                for (const account of this.accounts().filter(
                    a => this.snapshotOwner(a) === node.id && !known.has(a.index)
                )) {
                    const key = `${snapshot.revision}:${account.index}`
                    const stage = stages[key] || { id: crypto.randomUUID(), uploaded: false }
                    stages[key] = stage
                    this.store.set(`node:${node.id}:stages`, stages)
                    if (!stage.uploaded) {
                        await this.call(
                            `/internal/hybrid/stage-session/${stage.id}`,
                            'PUT',
                            {
                                index: account.index,
                                email: account.email,
                                bundle: exportAccountSession(this.root, this.sessionPath(), account.email)
                            },
                            60000,
                            node.id
                        )
                        stage.uploaded = true
                        this.store.set(`node:${node.id}:stages`, stages)
                    }
                    snapshot.initialSessions.push({
                        index: account.index,
                        email: account.email,
                        stageId: stage.id,
                        planner: this.scheduler.document.state.accounts[account.index]
                    })
                }
                if (!remote.revision) snapshot.initialState = this.scheduler.document.state
                try {
                    await this.call('/internal/hybrid/snapshot', 'PUT', snapshot, 60000, node.id)
                } catch (error) {
                    if (error.code !== 'SYNC_PENDING') throw error
                }
            }
            remote = await this.call('/internal/hybrid/status', 'GET', undefined, 8000, node.id)
            state.remote = remote
            state.observedAt = new Date().toISOString()
            state.syncedAt = new Date().toISOString()
            state.error = null
            this.store.set(`node:${node.id}:status`, { remote, syncedAt: state.syncedAt, online: false })
            if (remote.revision === snapshot.revision) this.store.set(`node:${node.id}:stages`, {})
            const cursor = this.store.get(`node:${node.id}:cursor`) || { node: node.id, id: 0 }
            const events = await this.call(
                `/internal/hybrid/events?afterId=${cursor.id}`,
                'GET',
                undefined,
                8000,
                node.id
            )
            const next = { node: node.id, id: events.events.at(-1)?.journalId || cursor.id }
            this.store.receive(
                events.events.map(entry => ({ ...entry, nodeId: node.id, nodeName: node.name })),
                next
            )
            this.store.set(`node:${node.id}:cursor`, next)
        } catch (error) {
            state.error = error.code || 'NODE_ERROR'
        } finally {
            state.busy = false
        }
    }
    async sync() {
        if (this.busy || !this.registry || !this.scheduler) return
        this.busy = true
        try {
            this.applyLocal()
            for (const a of this.accounts())
                if (!Object.hasOwn(this.registry.assignments, a.index)) {
                    const group = deriveNetworkGroup(a, this.scheduler.document.config.networkGroupOverride)
                    const peer = this.accounts().find(
                        p =>
                            p.index !== a.index &&
                            Object.hasOwn(this.registry.assignments, p.index) &&
                            deriveNetworkGroup(p, this.scheduler.document.config.networkGroupOverride) === group
                    )
                    this.registry.assignments[a.index] = !a.proxy ? 'local' : peer ? this.owner(peer) : 'local'
                    this.save()
                }
            // Existing account edit/deletion handoffs continue through the same durable holds.
            for (const [key, t] of Object.entries(this.transfers)) {
                if (t.kind === 'manual' || !t.requestDone || this.operationFor(Number(key))) continue
                if (!t.ready && t.remote && this.states.get(t.sourceNode)?.online === false) continue
                try {
                    if (!t.ready) {
                        const held = t.remote
                            ? await this.call(
                                  `/internal/hybrid/accounts/${key}/hold`,
                                  'POST',
                                  { token: t.token },
                                  60000,
                                  t.sourceNode
                              )
                            : await this.hold(Number(key), t.token)
                        if (t.remote) importAccountSession(this.root, this.sessionPath(), t.email, held.bundle)
                        if (held.planner) this.scheduler.document.state.accounts[key] = held.planner
                        t.ready = true
                        this.store.set('transfers', this.transfers)
                    }
                    const account = this.accounts().find(a => a.index === Number(key))
                    if (account) {
                        const group = deriveNetworkGroup(account, this.scheduler.document.config.networkGroupOverride)
                        const peer = this.accounts().find(
                            a =>
                                a.index !== account.index &&
                                deriveNetworkGroup(a, this.scheduler.document.config.networkGroupOverride) === group
                        )
                        if (!account.proxy) this.registry.assignments[key] = 'local'
                        else if (peer) this.registry.assignments[key] = this.owner(peer)
                    }
                    if (!account) delete this.registry.assignments[key]
                    this.save()
                } catch (error) {
                    t.error = error.code || 'TRANSFER_FAILED'
                    this.store.set('transfers', this.transfers)
                }
            }
            void this.advanceOperations()
            const nodes = this.registry.nodes.filter(n => n.id !== 'local')
            let offset = 0
            await Promise.all(
                Array.from({ length: Math.min(3, nodes.length) }, async () => {
                    while (offset < nodes.length) await this.syncNode(nodes[offset++])
                })
            )
            for (const row of this.store.pending()) {
                this.pm.ingestEntry(JSON.parse(row.payload))
                this.store.emitted(row.source)
            }
            void this.advanceOperations()
            await this.finishTransfers()
            for (const [key, t] of Object.entries(this.transfers))
                if (t.kind === 'manual' && t.returnPending && !this.manual.hasAccount(Number(key)))
                    await this.releaseManual(Number(key))
            this.online = nodes.every(n => this.states.get(n.id)?.online)
            this.scheduler.emit('change', this.scheduler.get())
        } catch (error) {
            this.lastError = error.code || 'FLEET_ERROR'
        } finally {
            this.busy = false
        }
    }
    async prepareTransfer(index, kind) {
        if (this.operationFor(index)) fail('A machine transfer is pending.', 'ACCOUNT_HELD', 409)
        const owner = this.owner(index)
        const result = await super.prepareTransfer(index, kind)
        result.sourceNode = owner
        this.store.set('transfers', this.transfers)
        return result
    }
    async finishTransfers() {
        for (const [key, t] of Object.entries(this.transfers)) {
            if (!t.ready || !t.requestDone || t.kind === 'manual') continue
            const affected = new Set([t.sourceNode, this.registry.assignments[key]])
            const nodes = this.registry.nodes.filter(n => n.id !== 'local' && affected.has(n.id))
            if (
                nodes.some(n => {
                    const s = this.states.get(n.id)
                    return !s?.online || s.remote?.revision !== this.snapshot(n.id).revision
                })
            )
                continue
            if (t.remote)
                await this.call(
                    `/internal/hybrid/accounts/${key}/release`,
                    'POST',
                    { token: t.token },
                    20000,
                    t.sourceNode
                )
            else {
                delete this.holds[key]
                this.store.set('holds', this.holds)
                this.scheduler.clearManualLock(Number(key))
            }
            delete this.transfers[key]
            this.blocked.delete(Number(key))
            this.store.set('transfers', this.transfers)
        }
    }
    bundleFile(op, index) {
        return path.join(this.store.directory, 'operations', op.id, `${index}.json`)
    }
    saveOperations() {
        this.store.set('fleetOperations', this.operations)
    }
    publicOperation(op) {
        return {
            id: op.id,
            kind: op.kind,
            phase: op.phase,
            status: op.status,
            error: op.error || null,
            target: op.target,
            now: op.now,
            accounts: op.members?.map(m => ({ index: m.index, source: m.source })),
            createdAt: op.createdAt,
            updatedAt: op.updatedAt,
            steps: op.steps || [],
            hostFingerprint: op.hostFingerprint || null
        }
    }
    preview(indexes, target) {
        this.node(target)
        if (!Array.isArray(indexes) || !indexes.length) fail('Select at least one account.')
        const all = this.accounts()
        const selected = indexes.map(i => this.account(Number(i)))
        if (target !== 'local' && selected.some(a => !a.proxy)) fail('Accounts without a proxy must stay on Local.')
        const groups = new Set(
            selected.map(a => deriveNetworkGroup(a, this.scheduler.document.config.networkGroupOverride))
        )
        const members = all.filter(a =>
            groups.has(deriveNetworkGroup(a, this.scheduler.document.config.networkGroupOverride))
        )
        if (target !== 'local' && members.some(a => !a.proxy))
            fail('This group contains a direct account; it must stay on Local.')
        for (const a of members)
            if (this.transfers[a.index] || this.operationFor(a.index) || this.manual.hasAccount(a.index))
                fail('A selected group has a manual session or pending transfer.', 'ACCOUNT_HELD', 409)
        for (const id of new Set([target, ...members.map(a => this.owner(a))]))
            if (id !== 'local' && (this.states.get(id)?.remote?.protocolVersion || this.node(id).protocolVersion) !== 2)
                fail('Upgrade the selected machine before moving accounts.', 'UPGRADE_REQUIRED', 409)
        return members.map(a => ({
            index: a.index,
            email: a.email,
            source: this.owner(a),
            sourceName: this.node(this.owner(a)).name,
            target
        }))
    }
    createMove(body) {
        const members = this.preview(body.accountIndexes, body.targetNodeId).filter(m => m.source !== body.targetNodeId)
        if (!members.length) fail('These accounts already run on the selected machine.')
        const op = {
            id: crypto.randomUUID(),
            kind: 'assignment',
            phase: 'holding',
            status: 'pending',
            target: body.targetNodeId,
            now: Boolean(body.now),
            members: members.map(m => ({ index: m.index, source: m.source, token: crypto.randomUUID() })),
            createdAt: new Date().toISOString()
        }
        this.operations = this.operations
            .filter(o => o.phase !== 'done')
            .concat(this.operations.filter(o => o.phase === 'done').slice(-99), op)
        for (const m of op.members) this.blocked.add(m.index)
        this.saveOperations()
        void this.sync()
        return this.publicOperation(op)
    }
    async advanceOperations() {
        await Promise.all(
            this.operations
                .filter(o => o.kind === 'assignment' && o.phase !== 'done')
                .map(async op => {
                    if (this.operationBusy.has(op.id)) return
                    this.operationBusy.add(op.id)
                    try {
                        for (const m of op.members) this.blocked.add(m.index)
                        if (op.phase === 'holding') {
                            for (const m of op.members) {
                                if (m.saved) continue
                                const held =
                                    m.source === 'local'
                                        ? await this.hold(m.index, m.token, { wait: !op.now })
                                        : await this.call(
                                              `/internal/hybrid/accounts/${m.index}/hold`,
                                              'POST',
                                              { token: m.token, wait: !op.now },
                                              60000,
                                              m.source
                                          )
                                atomicPrivateJson(this.bundleFile(op, m.index), held)
                                importAccountSession(
                                    this.root,
                                    this.sessionPath(),
                                    this.account(m.index).email,
                                    held.bundle
                                )
                                if (held.planner) this.scheduler.document.state.accounts[m.index] = held.planner
                                this.scheduler._save()
                                m.saved = true
                                this.saveOperations()
                            }
                            this.scheduler._save()
                            op.phase = 'revoking'
                            this.saveOperations()
                        }
                        if (op.phase === 'revoking') {
                            let ready = true
                            for (const source of new Set(op.members.map(m => m.source))) {
                                if (source === 'local') continue
                                const s = this.states.get(source)
                                if (!s?.online || s.remote?.revision !== this.snapshot(source).revision) ready = false
                            }
                            if (ready) {
                                op.phase = 'activating'
                                this.saveOperations()
                            }
                        }
                        if (op.phase === 'activating') {
                            const s = this.states.get(op.target)
                            const ready =
                                op.target === 'local' ||
                                (s?.online && s.remote?.revision === this.snapshot(op.target).revision)
                            if (ready) {
                                // Persist ownership before releasing source holds. A retry only releases, never reimports.
                                for (const m of op.members) this.registry.assignments[m.index] = op.target
                                this.save()
                                op.phase = 'releasing'
                                this.saveOperations()
                            }
                        }
                        if (op.phase === 'releasing') {
                            for (const m of op.members) {
                                if (m.released) continue
                                if (m.source === 'local') {
                                    delete this.holds[m.index]
                                    this.store.set('holds', this.holds)
                                    this.scheduler.clearManualLock(m.index)
                                } else
                                    await this.call(
                                        `/internal/hybrid/accounts/${m.index}/release`,
                                        'POST',
                                        { token: m.token },
                                        20000,
                                        m.source
                                    )
                                m.released = true
                                this.saveOperations()
                            }
                            op.phase = 'done'
                            op.status = 'applied'
                            op.error = null
                            for (const m of op.members) this.blocked.delete(m.index)
                            this.saveOperations()
                            this.scheduler.replan()
                            fs.rmSync(path.join(this.store.directory, 'operations', op.id), {
                                recursive: true,
                                force: true
                            })
                        } else {
                            op.status = 'pending'
                            op.error = null
                        }
                    } catch (error) {
                        op.status =
                            error.code === 'WAITING_FOR_RUN' || error.code === 'NODE_OFFLINE' ? 'waiting' : 'error'
                        op.error = error.code || 'TRANSFER_FAILED'
                    }
                    op.updatedAt = new Date().toISOString()
                    this.saveOperations()
                    this.operationBusy.delete(op.id)
                })
        )
    }
    async cancelMove(op) {
        if (op.phase !== 'holding' || this.operationBusy.has(op.id))
            fail('Only an idle transfer that has not revoked ownership can be cancelled.', 'OPERATION_BUSY', 409)
        this.operationBusy.add(op.id)
        try {
            for (const m of op.members) {
                if (m.source === 'local') {
                    if (this.holds[m.index]?.token === m.token) {
                        delete this.holds[m.index]
                        this.store.set('holds', this.holds)
                        this.scheduler.clearManualLock(m.index)
                    }
                } else {
                    const status = await this.call('/internal/hybrid/status', 'GET', undefined, 8000, m.source)
                    if (status.holds.includes(m.index))
                        await this.call(
                            `/internal/hybrid/accounts/${m.index}/release`,
                            'POST',
                            { token: m.token },
                            20000,
                            m.source
                        )
                }
            }
            op.phase = 'done'
            op.status = 'cancelled'
            op.error = null
            for (const m of op.members) this.blocked.delete(m.index)
            this.saveOperations()
            this.scheduler.replan()
            fs.rmSync(path.join(this.store.directory, 'operations', op.id), { recursive: true, force: true })
        } finally {
            this.operationBusy.delete(op.id)
        }
    }
    nodesView() {
        return this.registry.nodes.map(n => {
            const s = this.states.get(n.id),
                local = n.id === 'local',
                value = this.effective(n.id)
            return {
                id: n.id,
                name: n.name,
                kind: n.kind,
                ssh: n.ssh ? { host: n.ssh.host, port: n.ssh.port, user: n.ssh.user } : null,
                online: local || Boolean(s?.online),
                resources: local ? nodeResources() : s?.remote?.resources || null,
                observedAt: local ? new Date().toISOString() : s?.observedAt || null,
                runtimeKnown: local || runtimeFresh({ online: s?.online, observedAt: s?.observedAt }),
                running: local
                    ? this.scheduler.get().running.length
                    : runtimeFresh({ online: s?.online, observedAt: s?.observedAt })
                      ? s?.remote?.smart?.running?.length || 0
                      : 0,
                limit: value.schedule.maxParallel,
                enabled: value.schedule.enabled,
                accountCount: this.accounts().filter(a => this.owner(a) === n.id).length,
                status: local
                    ? this.localPending
                        ? 'pending'
                        : 'applied'
                    : !s?.online
                      ? 'offline'
                      : s.error
                        ? 'error'
                        : s.remote?.revision !== this.snapshot(n.id).revision || s.remote?.syncPending
                          ? 'pending'
                          : 'applied',
                error: s?.error || null,
                sync: local
                    ? null
                    : {
                          desiredRevision: this.snapshot(n.id).revision,
                          acceptedRevision: s?.remote?.revision || null,
                          suspended: Boolean(s?.remote?.syncPending)
                      },
                syncedAt: local ? new Date().toISOString() : s?.syncedAt || null,
                installing: Boolean(n.installing)
            }
        })
    }
    decorateSmart(state) {
        if (!this.registry) return state
        const localIndexes = new Set(
            this.accounts()
                .filter(a => this.owner(a) === 'local')
                .map(a => String(a.index))
        )
        const tag = (items, id) =>
            (items || []).map(j => ({
                ...j,
                node: id === 'local' ? 'local' : 'vps',
                nodeId: id,
                nodeName: this.node(id).name
            }))
        const result = {
            ...state,
            accounts: Object.fromEntries(Object.entries(state.accounts).filter(([i]) => localIndexes.has(i))),
            running: tag(
                state.running.filter(j => localIndexes.has(String(j.accountIndex))),
                'local'
            ),
            queue: tag(
                state.queue.filter(j => localIndexes.has(String(j.accountIndex))),
                'local'
            ),
            sessions: tag(
                state.sessions.filter(j => localIndexes.has(String(j.accountIndex))),
                'local'
            )
        }
        const urgent = [state.urgent || {}]
        for (const n of this.registry.nodes.filter(n => n.id !== 'local')) {
            const remote = this.states.get(n.id)?.remote?.smart
            const indexes = new Set(
                this.accounts()
                    .filter(a => this.owner(a) === n.id)
                    .map(a => String(a.index))
            )
            for (const [i, a] of Object.entries(remote?.accounts || {})) if (indexes.has(i)) result.accounts[i] = a
            const status = this.states.get(n.id)
            if (runtimeFresh({ online: status?.online, observedAt: status?.observedAt }))
                result.running.push(
                    ...tag(
                        (remote?.running || []).filter(job => {
                            const account = this.accounts().find(account => account.index === job.accountIndex)
                            return (
                                indexes.has(String(job.accountIndex)) &&
                                account &&
                                (!job.email || job.email.toLowerCase() === account.email.toLowerCase())
                            )
                        }),
                        n.id
                    )
                )
            result.queue.push(...tag(remote?.queue, n.id))
            result.sessions.push(...tag(remote?.sessions, n.id))
            urgent.push(remote?.urgent || {})
        }
        result.sessions.sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)))
        result.sessions = result.sessions.slice(0, 100)
        const failed = urgent
            .flatMap(u => u.failed || [])
            .filter((x, i, all) => all.findIndex(y => y.accountIndex === x.accountIndex && y.worker === x.worker) === i)
        result.urgent = {
            ...state.urgent,
            active: urgent.some(u => u.active),
            failed,
            remaining: urgent.reduce((n, u) => n + (u.remaining || 0), 0),
            effectiveParallel: this.registry.nodes.reduce((n, x) => n + this.effective(x.id).schedule.maxParallel, 0)
        }
        result.effectiveEnabled =
            this.registry.nodes.some(n => this.effective(n.id).schedule.enabled) || result.urgent.active
        result.hybrid = {
            online: this.registry.nodes.every(n => n.id === 'local' || this.states.get(n.id)?.online),
            syncPending: this.nodesView().some(n => n.status === 'pending'),
            nodes: this.nodesView(),
            local: { running: state.running.length, limit: this.hardParallel },
            vps: {
                running: result.running.filter(j => j.node !== 'local').length,
                limit: this.registry.nodes
                    .filter(n => n.id !== 'local')
                    .reduce((v, n) => v + this.effective(n.id).schedule.maxParallel, 0)
            },
            manualHolds: Object.keys(this.transfers).map(Number),
            operations: this.operations.filter(o => o.phase !== 'done').map(o => this.publicOperation(o))
        }
        return result
    }
    async validateSettings(value) {
        const v = await validateConfig(value.bot, { projectRoot: this.root })
        if (!v.ok) fail(`Invalid bot configuration: ${v.errors.join('; ')}`)
        validateSmartConfig(value.schedule, this.accounts())
        const owners = new Map()
        for (const a of this.accounts()) {
            const group = deriveNetworkGroup(a, value.schedule.networkGroupOverride)
            if (owners.has(group) && owners.get(group) !== this.owner(a))
                fail('Move the affected accounts onto one machine before merging their network groups.')
            owners.set(group, this.owner(a))
        }
        if (
            this.operations.some(o => o.kind === 'assignment' && o.phase !== 'done') &&
            JSON.stringify(value.schedule.networkGroupOverride) !==
                JSON.stringify(this.registry.defaults.schedule.networkGroupOverride)
        )
            fail('Finish transfers before changing network groups.', 'ACCOUNT_HELD', 409)
    }
    async handle(req, res, url, io) {
        const route = url.pathname.replace(/\/+$/, ''),
            method = req.method
        const reply = (status, data) => {
            io.send(res, status, data)
            return true
        }
        try {
            if (
                method !== 'GET' &&
                /^\/accounts(?:\/\d+)?$/.test(route) &&
                this.operations.some(o => o.kind === 'assignment' && o.phase !== 'done')
            )
                fail('Finish machine transfers before editing account identities or proxies.', 'ACCOUNT_HELD', 409)
            if (route === '/fleet-scheduler' && method === 'POST') {
                if (!this.permissions.schedule) return reply(403, { error: 'Schedule writes disabled.' })
                const body = await io.read(req)
                if (typeof body.enabled !== 'boolean') fail('enabled must be boolean.')
                for (const n of this.registry.nodes)
                    n.overrides = deepMerge(n.overrides, { schedule: { enabled: body.enabled } })
                this.save()
                void this.sync()
                return reply(202, { saved: true, status: 'pending' })
            }
            if (['POST', 'PATCH', 'DELETE'].includes(method) && /^\/accounts(?:\/\d+)?$/.test(route))
                res.once('finish', () => {
                    if (res.statusCode >= 300) return
                    this.registry.defaults.schedule.profiles = clone(this.scheduler.document.config.profiles)
                    this.save()
                    queueMicrotask(() => void this.sync())
                })
            const nodeRoute = /^\/nodes\/([^/]+)(?:\/(config|resources|retry|trust))?$/.exec(route)
            const stopAccount = /^\/smart-schedule\/accounts\/([1-9]\d*)\/stop$/.exec(route)
            if (stopAccount && method === 'POST') {
                if (!this.permissions.schedule) return reply(403, { error: 'Schedule writes disabled.' })
                const index = Number(stopAccount[1])
                this.account(index)
                const body = await io.read(req)
                const owner = this.owner(index)
                if (owner === 'local') return reply(200, await this.scheduler.stopAccount(index, body.jobId))
                const status = this.states.get(owner)
                if (!runtimeFresh({ online: status?.online, observedAt: status?.observedAt }))
                    fail('Machine runtime cannot be verified. Refresh and retry.', 'RUNTIME_UNKNOWN', 503)
                const result = await this.call('/internal/hybrid/control', 'POST', { route, body }, 60000, owner)
                await this.syncNode(this.node(owner))
                return reply(200, result.result)
            }
            if (
                route === '/nodes' ||
                nodeRoute ||
                route === '/execution-config/defaults' ||
                route.startsWith('/account-assignments') ||
                route.startsWith('/node-operations') ||
                route === '/nodes/ssh-keys'
            ) {
                if (method !== 'GET' && (!this.permissions.config || !this.permissions.schedule))
                    return reply(403, { error: 'Configuration and schedule writes are required.' })
                if (route === '/nodes/ssh-keys' && method === 'GET')
                    return reply(200, { keys: this.provisioner.keys() })
                if (route === '/nodes' && method === 'GET')
                    return reply(200, {
                        nodes: this.nodesView(),
                        operations: this.operations.map(o => this.publicOperation(o)).slice(-100)
                    })
                if (route === '/nodes' && method === 'POST')
                    return reply(202, {
                        operation: this.publicOperation(await this.provisioner.add(await io.read(req)))
                    })
                if (route === '/execution-config/defaults') {
                    if (method === 'GET')
                        return reply(200, { config: redactSettings(this.registry.defaults), managedBotKeys })
                    if (method === 'PUT') {
                        const value = restoreRedacted(await io.read(req), this.registry.defaults)
                        for (const key of managedBotKeys)
                            if (value.bot?.[key] !== this.registry.defaults.bot[key])
                                fail(`${key} is managed by the runtime.`)
                        await this.validateSettings(value)
                        // A default change must also validate every inherited effective configuration.
                        for (const n of this.registry.nodes) await this.validateSettings(deepMerge(value, n.overrides))
                        this.registry.defaults = value
                        this.save()
                        void this.sync()
                        return reply(202, { saved: true, status: 'pending' })
                    }
                }
                if (nodeRoute) {
                    const id = decodeURIComponent(nodeRoute[1]),
                        action = nodeRoute[2],
                        n = this.node(id)
                    if (action === 'config') {
                        if (method === 'GET')
                            return reply(200, {
                                overrides: redactSettings(n.overrides),
                                effective: redactSettings(this.effective(id)),
                                defaults: redactSettings(this.registry.defaults),
                                managedBotKeys: [...managedBotKeys, ...(id !== 'local' ? ['headless'] : [])]
                            })
                        if (method === 'PUT') {
                            const value = restoreRedacted(await io.read(req), n.overrides)
                            for (const key of [...managedBotKeys, ...(id !== 'local' ? ['headless'] : [])])
                                if (Object.hasOwn(value.bot || {}, key)) fail(`${key} is managed by the runtime.`)
                            if (value.schedule?.profiles || value.schedule?.networkGroupOverride)
                                fail('Account profiles and network groups are shared settings.')
                            await this.validateSettings(deepMerge(this.registry.defaults, value))
                            n.overrides = value
                            this.save()
                            void this.sync()
                            return reply(202, { saved: true, status: 'pending' })
                        }
                    }
                    if (action === 'resources' && method === 'GET')
                        return reply(200, { resources: this.nodesView().find(x => x.id === id).resources })
                    if (!action && method === 'PATCH') {
                        const body = await io.read(req)
                        if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80)
                            fail('Name must be 1–80 characters.')
                        n.name = body.name.trim()
                        this.save()
                        return reply(200, { saved: true })
                    }
                    if (!action && method === 'DELETE') {
                        if (
                            id === 'local' ||
                            this.accounts().some(a => this.owner(a) === id) ||
                            this.operations.some(
                                o => o.phase !== 'done' && (o.target === id || o.members?.some(m => m.source === id))
                            ) ||
                            Object.values(this.transfers).some(t => t.sourceNode === id)
                        )
                            fail(
                                'Move all accounts and finish transfers before removing this machine.',
                                'NODE_BUSY',
                                409
                            )
                        await this.provisioner.remove(n)
                        this.registry.nodes = this.registry.nodes.filter(x => x.id !== id)
                        this.save()
                        return reply(200, { removed: true })
                    }
                }
                const operation = /^\/node-operations\/([a-f0-9-]+)(?:\/(retry|trust|cancel))?$/.exec(route)
                if (operation) {
                    const op = this.operations.find(o => o.id === operation[1])
                    if (!op) fail('Operation not found.', 'NOT_FOUND', 404)
                    if (method === 'GET') return reply(200, { operation: this.publicOperation(op) })
                    if (method === 'POST' && operation[2]) {
                        const body = await io.read(req)
                        if (operation[2] === 'cancel') {
                            if (op.kind === 'assignment') await this.cancelMove(op)
                            else await this.provisioner.cancel(op)
                        } else if (op.kind === 'install') await this.provisioner.resume(op, operation[2], body)
                        else {
                            if (body.now) op.now = true
                            op.status = 'pending'
                            this.saveOperations()
                            void this.sync()
                        }
                        return reply(202, { operation: this.publicOperation(op) })
                    }
                }
                if (route === '/account-assignments/preview' && method === 'POST') {
                    const b = await io.read(req)
                    return reply(200, { accounts: this.preview(b.accountIndexes, b.targetNodeId) })
                }
                if (route === '/account-assignments' && method === 'GET')
                    return reply(200, {
                        assignments: this.registry.assignments,
                        operations: this.operations
                            .filter(o => o.kind === 'assignment')
                            .map(o => this.publicOperation(o))
                    })
                if (route === '/account-assignments' && method === 'POST')
                    return reply(202, { operation: this.createMove(await io.read(req)) })
                return reply(405, { error: 'Method not allowed.' })
            }
            if (method === 'PUT' && route === '/smart-schedule') {
                if (!this.permissions.schedule) return reply(403, { error: 'Schedule writes disabled.' })
                const b = await io.read(req)
                await this.validateSettings({ bot: this.registry.defaults.bot, schedule: b })
                this.registry.defaults.schedule = validateSmartConfig(b, this.accounts())
                this.save()
                void this.sync()
                return reply(202, { ...this.decorateSmart(this.scheduler.get()), writable: true })
            }
            if (['PUT', 'PATCH'].includes(method) && route === '/config') {
                if (!this.permissions.config) return reply(403, { error: 'Configuration writes disabled.' })
                const patch = restoreRedacted(await io.read(req), this.effective('local').bot)
                const b = method === 'PATCH' ? deepMerge(this.effective('local').bot, patch) : patch
                for (const key of managedBotKeys)
                    if (b[key] !== this.effective('local').bot[key]) fail(`${key} is managed by the runtime.`)
                await this.validateSettings({ bot: b, schedule: this.effective('local').schedule })
                for (const key of managedBotKeys) delete b[key]
                this.node('local').overrides.bot = b
                this.save()
                void this.sync()
                return reply(202, { saved: true, status: 'pending' })
            }
            if (
                method === 'POST' &&
                [
                    '/start',
                    '/restart',
                    '/stop',
                    '/smart-schedule/urgent',
                    '/smart-schedule/replan',
                    '/smart-schedule/retry'
                ].includes(route)
            ) {
                if (!this.permissions.schedule) return reply(403, { error: 'Schedule writes disabled.' })
                const b = await io.read(req)
                if (b.args != null || b.env != null || b.excludedAccountIndexes != null)
                    fail('Fleet mode requires Smart Scheduler.')
                if (route.endsWith('/urgent') && typeof b.enabled !== 'boolean') fail('enabled must be boolean.')
                if (b.accountIndex != null) this.account(Number(b.accountIndex))
                if (route.endsWith('/retry')) {
                    if (b.preempt != null && typeof b.preempt !== 'boolean')
                        fail('preempt must be boolean.', 'BAD_REQUEST', 400)
                    if (
                        !Array.isArray(b.accountIndexes) ||
                        !b.accountIndexes.length ||
                        b.accountIndexes.some(index => !Number.isSafeInteger(index))
                    )
                        fail('Select valid account indexes.', 'BAD_REQUEST', 400)
                    for (const index of b.accountIndexes) this.account(index)
                }
                const ids = route.endsWith('/retry')
                    ? [...new Set(b.accountIndexes.map(index => this.owner(index)))]
                    : b.accountIndex == null
                      ? this.registry.nodes.map(n => n.id)
                      : [this.owner(Number(b.accountIndex))]
                const results = await Promise.all(
                    ids.map(async id => {
                        try {
                            const nodeBody = route.endsWith('/retry')
                                ? {
                                      ...b,
                                      accountIndexes: b.accountIndexes.filter(index => this.owner(index) === id)
                                  }
                                : b
                            if (id !== 'local')
                                await this.call(
                                    '/internal/hybrid/control',
                                    'POST',
                                    { route, body: nodeBody },
                                    60000,
                                    id
                                )
                            else if (route.endsWith('/retry'))
                                await this.scheduler.retryAccounts(nodeBody.accountIndexes, {
                                    preempt: nodeBody.preempt
                                })
                            else if (route.endsWith('/urgent')) {
                                this.scheduler.setUrgent(b.enabled)
                                const run = this.scheduler.document.state.urgentRun
                                if (run?.targets)
                                    run.targets = Object.fromEntries(
                                        Object.entries(run.targets).filter(([i]) => this.owner(Number(i)) === 'local')
                                    )
                                this.scheduler._save()
                                this.scheduler.replan()
                            } else if (route.endsWith('/replan')) this.scheduler.replan(b)
                            else if (route === '/stop') await this.scheduler.stop()
                            else {
                                if (route === '/restart') await this.scheduler.stop()
                                this.scheduler.trigger(b.accountIndex == null ? null : [Number(b.accountIndex)], {
                                    force: true
                                })
                            }
                            return { nodeId: id, applied: true }
                        } catch (e) {
                            return { nodeId: id, applied: false, error: e.code || 'NODE_ERROR' }
                        }
                    })
                )
                return reply(results.some(r => !r.applied) ? 503 : 202, {
                    results,
                    ...this.decorateSmart(this.scheduler.get())
                })
            }
            if (method === 'POST' && route === '/manual-sessions') {
                // Base handler stores the handoff before calling the owner; reject active assignment groups.
                const original = io.read
                const body = await original(req)
                if (this.operationFor(Number(body.accountIndex)))
                    fail('Wait for the machine transfer before opening a manual browser.', 'ACCOUNT_HELD', 409)
                const transfer = this.transfers[body.accountIndex]
                if (transfer && !transfer.sourceNode) transfer.sourceNode = this.owner(Number(body.accountIndex))
                return super.handle(req, res, url, { ...io, read: async () => body })
            }
            return super.handle(req, res, url, io)
        } catch (error) {
            return reply(error.status || (error.code === 'BAD_REQUEST' ? 400 : 500), {
                error: error.status || error.code === 'BAD_REQUEST' ? error.message : 'Machine operation failed.',
                code: error.code || 'FLEET_ERROR'
            })
        }
    }
}
