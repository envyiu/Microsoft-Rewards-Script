import { deepMerge } from '../configEditor.js'
import { runtimeFresh } from '../execution.js'
import { redactSecrets } from '../lib.js'
import { validateSmartConfig } from '../smartScheduler.js'

const MANAGED_BOT_KEYS = ['sessionPath', 'clusters']

function fail(message, code = 'BAD_REQUEST', status = 400) {
    throw Object.assign(new Error(message), { code, status })
}

function redactSettings(value) {
    const cloned = structuredClone(value)
    return { ...cloned, ...(cloned.bot ? { bot: redactSecrets(cloned.bot) } : {}) }
}

export function restoreRedactedSettings(value, previous) {
    if (value === '***REDACTED***') return previous
    if (Array.isArray(value)) return value.map((v, i) => restoreRedactedSettings(v, previous?.[i]))
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([k, v]) => {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) fail('Unsafe configuration key.')
                return [k, restoreRedactedSettings(v, previous?.[k])]
            })
        )
    }
    return value
}

export async function handleFleetNodeRoutes(fleet, req, res, url, io, fallbackHandle) {
    const route = url.pathname.replace(/\/+$/, '')
    const method = req.method
    const reply = (status, data) => {
        io.send(res, status, data)
        return true
    }

    try {
        if (
            method !== 'GET' &&
            /^\/accounts(?:\/\d+)?$/.test(route) &&
            fleet.operations.some(o => o.kind === 'assignment' && o.phase !== 'done')
        ) {
            fail('Finish machine transfers before editing account identities or proxies.', 'ACCOUNT_HELD', 409)
        }

        if (route === '/fleet-scheduler' && method === 'POST') {
            if (!fleet.permissions.schedule) return reply(403, { error: 'Schedule writes disabled.' })
            const body = await io.read(req)
            if (typeof body.enabled !== 'boolean') fail('enabled must be boolean.')
            for (const n of fleet.registry.nodes) {
                n.overrides = deepMerge(n.overrides, { schedule: { enabled: body.enabled } })
            }
            fleet.save()
            void fleet.sync()
            return reply(202, { saved: true, status: 'pending' })
        }

        if (['POST', 'PATCH', 'DELETE'].includes(method) && /^\/accounts(?:\/\d+)?$/.test(route)) {
            res.once('finish', () => {
                if (res.statusCode >= 300) return
                fleet.registry.defaults.schedule.profiles = structuredClone(fleet.scheduler.document.config.profiles)
                fleet.save()
                queueMicrotask(() => void fleet.sync())
            })
        }

        const nodeRoute = /^\/nodes\/([^/]+)(?:\/(config|resources|retry|trust))?$/.exec(route)
        const stopAccount = /^\/smart-schedule\/accounts\/([1-9]\d*)\/stop$/.exec(route)
        if (stopAccount && method === 'POST') {
            if (!fleet.permissions.schedule) return reply(403, { error: 'Schedule writes disabled.' })
            const index = Number(stopAccount[1])
            fleet.account(index)
            const body = await io.read(req)
            const owner = fleet.owner(index)
            if (owner === 'local') return reply(200, await fleet.scheduler.stopAccount(index, body.jobId))
            const status = fleet.states.get(owner)
            if (!runtimeFresh({ online: status?.online, observedAt: status?.observedAt })) {
                fail('Machine runtime cannot be verified. Refresh and retry.', 'RUNTIME_UNKNOWN', 503)
            }
            const result = await fleet.call('/internal/hybrid/control', 'POST', { route, body }, 60000, owner)
            await fleet.syncNode(fleet.node(owner))
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
            if (method !== 'GET' && (!fleet.permissions.config || !fleet.permissions.schedule)) {
                return reply(403, { error: 'Configuration and schedule writes are required.' })
            }
            if (route === '/nodes/ssh-keys' && method === 'GET') {
                return reply(200, { keys: fleet.provisioner.keys() })
            }
            if (route === '/nodes' && method === 'GET') {
                return reply(200, {
                    nodes: fleet.nodesView(),
                    operations: fleet.operations.map(o => fleet.publicOperation(o)).slice(-100)
                })
            }
            if (route === '/nodes' && method === 'POST') {
                return reply(202, {
                    operation: fleet.publicOperation(await fleet.provisioner.add(await io.read(req)))
                })
            }
            if (route === '/execution-config/defaults') {
                if (method === 'GET') {
                    return reply(200, {
                        config: redactSettings(fleet.registry.defaults),
                        managedBotKeys: MANAGED_BOT_KEYS
                    })
                }
                if (method === 'PUT') {
                    const value = restoreRedactedSettings(await io.read(req), fleet.registry.defaults)
                    for (const key of MANAGED_BOT_KEYS) {
                        if (value.bot?.[key] !== fleet.registry.defaults.bot[key]) {
                            fail(`${key} is managed by the runtime.`)
                        }
                    }
                    await fleet.validateSettings(value)
                    for (const n of fleet.registry.nodes) {
                        await fleet.validateSettings(deepMerge(value, n.overrides))
                    }
                    fleet.registry.defaults = value
                    fleet.save()
                    void fleet.sync()
                    return reply(202, { saved: true, status: 'pending' })
                }
            }
            if (nodeRoute) {
                const id = decodeURIComponent(nodeRoute[1])
                const action = nodeRoute[2]
                const n = fleet.node(id)
                if (action === 'config') {
                    if (method === 'GET') {
                        return reply(200, {
                            overrides: redactSettings(n.overrides),
                            effective: redactSettings(fleet.effective(id)),
                            defaults: redactSettings(fleet.registry.defaults),
                            managedBotKeys: [...MANAGED_BOT_KEYS, ...(id !== 'local' ? ['headless'] : [])]
                        })
                    }
                    if (method === 'PUT') {
                        const value = restoreRedactedSettings(await io.read(req), n.overrides)
                        for (const key of [...MANAGED_BOT_KEYS, ...(id !== 'local' ? ['headless'] : [])]) {
                            if (Object.hasOwn(value.bot || {}, key)) fail(`${key} is managed by the runtime.`)
                        }
                        if (value.schedule?.profiles || value.schedule?.networkGroupOverride) {
                            fail('Account profiles and network groups are shared settings.')
                        }
                        await fleet.validateSettings(deepMerge(fleet.registry.defaults, value))
                        n.overrides = value
                        fleet.save()
                        void fleet.sync()
                        return reply(202, { saved: true, status: 'pending' })
                    }
                }
                if (action === 'resources' && method === 'GET') {
                    return reply(200, { resources: fleet.nodesView().find(x => x.id === id).resources })
                }
                if (!action && method === 'PATCH') {
                    const body = await io.read(req)
                    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) {
                        fail('Name must be 1–80 characters.')
                    }
                    n.name = body.name.trim()
                    fleet.save()
                    return reply(200, { saved: true })
                }
                if (!action && method === 'DELETE') {
                    if (
                        id === 'local' ||
                        fleet.accounts().some(a => fleet.owner(a) === id) ||
                        fleet.operations.some(
                            o => o.phase !== 'done' && (o.target === id || o.members?.some(m => m.source === id))
                        ) ||
                        Object.values(fleet.transfers).some(t => t.sourceNode === id)
                    ) {
                        fail('Move all accounts and finish transfers before removing this machine.', 'NODE_BUSY', 409)
                    }
                    await fleet.provisioner.remove(n)
                    fleet.registry.nodes = fleet.registry.nodes.filter(x => x.id !== id)
                    fleet.save()
                    return reply(200, { removed: true })
                }
            }
            const operation = /^\/node-operations\/([a-f0-9-]+)(?:\/(retry|trust|cancel))?$/.exec(route)
            if (operation) {
                const op = fleet.operations.find(o => o.id === operation[1])
                if (!op) fail('Operation not found.', 'NOT_FOUND', 404)
                if (method === 'GET') return reply(200, { operation: fleet.publicOperation(op) })
                if (method === 'POST' && operation[2]) {
                    const body = await io.read(req)
                    if (operation[2] === 'cancel') {
                        if (op.kind === 'assignment') await fleet.cancelMove(op)
                        else await fleet.provisioner.cancel(op)
                    } else if (op.kind === 'install') {
                        await fleet.provisioner.resume(op, operation[2], body)
                    } else {
                        if (body.now) op.now = true
                        op.status = 'pending'
                        fleet.saveOperations()
                        void fleet.sync()
                    }
                    return reply(202, { operation: fleet.publicOperation(op) })
                }
            }
            if (route === '/account-assignments/preview' && method === 'POST') {
                const b = await io.read(req)
                return reply(200, { accounts: fleet.preview(b.accountIndexes, b.targetNodeId) })
            }
            if (route === '/account-assignments' && method === 'GET') {
                return reply(200, {
                    assignments: fleet.registry.assignments,
                    operations: fleet.operations.filter(o => o.kind === 'assignment').map(o => fleet.publicOperation(o))
                })
            }
            if (route === '/account-assignments' && method === 'POST') {
                return reply(202, { operation: fleet.createMove(await io.read(req)) })
            }
            return reply(405, { error: 'Method not allowed.' })
        }

        if (method === 'PUT' && route === '/smart-schedule') {
            if (!fleet.permissions.schedule) return reply(403, { error: 'Schedule writes disabled.' })
            const b = await io.read(req)
            await fleet.validateSettings({ bot: fleet.registry.defaults.bot, schedule: b })
            fleet.registry.defaults.schedule = validateSmartConfig(b, fleet.accounts())
            fleet.save()
            void fleet.sync()
            return reply(202, { ...fleet.decorateSmart(fleet.scheduler.get()), writable: true })
        }

        if (['PUT', 'PATCH'].includes(method) && route === '/config') {
            if (!fleet.permissions.config) return reply(403, { error: 'Configuration writes disabled.' })
            const patch = restoreRedactedSettings(await io.read(req), fleet.effective('local').bot)
            const b = method === 'PATCH' ? deepMerge(fleet.effective('local').bot, patch) : patch
            for (const key of MANAGED_BOT_KEYS) {
                if (b[key] !== fleet.effective('local').bot[key]) fail(`${key} is managed by the runtime.`)
            }
            await fleet.validateSettings({ bot: b, schedule: fleet.effective('local').schedule })
            for (const key of MANAGED_BOT_KEYS) delete b[key]
            fleet.node('local').overrides.bot = b
            fleet.save()
            void fleet.sync()
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
            if (!fleet.permissions.schedule) return reply(403, { error: 'Schedule writes disabled.' })
            const b = await io.read(req)
            if (b.args != null || b.env != null || b.excludedAccountIndexes != null) {
                fail('Fleet mode requires Smart Scheduler.')
            }
            if (route.endsWith('/urgent') && typeof b.enabled !== 'boolean') fail('enabled must be boolean.')
            if (b.accountIndex != null) fleet.account(Number(b.accountIndex))
            if (route.endsWith('/retry')) {
                if (b.preempt != null && typeof b.preempt !== 'boolean') {
                    fail('preempt must be boolean.', 'BAD_REQUEST', 400)
                }
                if (
                    !Array.isArray(b.accountIndexes) ||
                    !b.accountIndexes.length ||
                    b.accountIndexes.some(index => !Number.isSafeInteger(index))
                ) {
                    fail('Select valid account indexes.', 'BAD_REQUEST', 400)
                }
                for (const index of b.accountIndexes) fleet.account(index)
            }
            const ids = route.endsWith('/retry')
                ? [...new Set(b.accountIndexes.map(index => fleet.owner(index)))]
                : b.accountIndex == null
                  ? fleet.registry.nodes.map(n => n.id)
                  : [fleet.owner(Number(b.accountIndex))]
            const results = await Promise.all(
                ids.map(async id => {
                    try {
                        const nodeBody = route.endsWith('/retry')
                            ? {
                                  ...b,
                                  accountIndexes: b.accountIndexes.filter(index => fleet.owner(index) === id)
                              }
                            : b
                        if (
                            id !== 'local' &&
                            route !== '/stop' &&
                            fleet.effective(id).schedule.normalPolicy?.enabled !== false &&
                            fleet.states.get(id)?.remote?.capabilities?.conservativeSessionsV1 !== true
                        ) {
                            fail('Upgrade machine for conservative account sessions.', 'UPGRADE_REQUIRED', 409)
                        }
                        if (id !== 'local') {
                            await fleet.call('/internal/hybrid/control', 'POST', { route, body: nodeBody }, 60000, id)
                        } else if (route.endsWith('/retry')) {
                            await fleet.scheduler.retryAccounts(nodeBody.accountIndexes, {
                                preempt: nodeBody.preempt
                            })
                        } else if (route.endsWith('/urgent')) {
                            fleet.scheduler.setUrgent(b.enabled)
                            const run = fleet.scheduler.document.state.urgentRun
                            if (run?.targets) {
                                run.targets = Object.fromEntries(
                                    Object.entries(run.targets).filter(([i]) => fleet.owner(Number(i)) === 'local')
                                )
                            }
                            fleet.scheduler._save()
                            fleet.scheduler.replan()
                        } else if (route.endsWith('/replan')) {
                            fleet.scheduler.replan(b)
                        } else if (route === '/stop') {
                            await fleet.scheduler.stop()
                        } else {
                            if (route === '/restart' && !fleet.scheduler.document.config.normalPolicy?.enabled) {
                                await fleet.scheduler.stop()
                            }
                            const indexes = b.accountIndex == null ? null : [Number(b.accountIndex)]
                            if (fleet.scheduler.document.config.normalPolicy?.enabled && indexes) {
                                await fleet.scheduler.retryAccounts(indexes, { runOnce: true })
                            } else {
                                fleet.scheduler.trigger(indexes, { force: true })
                            }
                        }
                        return { nodeId: id, applied: true }
                    } catch (e) {
                        return { nodeId: id, applied: false, error: e.code || 'NODE_ERROR' }
                    }
                })
            )
            const rejected = results.find(r => !r.applied)
            const blocked = [
                'ALREADY_RUNNING',
                'ACCOUNT_HELD',
                'SESSION_LIMIT',
                'SESSION_REST',
                'SESSION_UNCERTAIN',
                'ACCOUNT_HOLD',
                'ACCOUNT_LOCKED',
                'VERIFICATION_REQUIRED'
            ].includes(rejected?.error)
            return reply(rejected ? (blocked ? 409 : 503) : 202, {
                ...(rejected ? { error: rejected.error, code: rejected.error } : {}),
                results,
                ...fleet.decorateSmart(fleet.scheduler.get())
            })
        }

        if (method === 'POST' && route === '/manual-sessions') {
            const original = io.read
            const body = await original(req)
            if (fleet.operationFor(Number(body.accountIndex))) {
                fail('Wait for the machine transfer before opening a manual browser.', 'ACCOUNT_HELD', 409)
            }
            const transfer = fleet.transfers[body.accountIndex]
            if (transfer && !transfer.sourceNode) transfer.sourceNode = fleet.owner(Number(body.accountIndex))
            return fallbackHandle(req, res, url, { ...io, read: async () => body })
        }

        return fallbackHandle(req, res, url, io)
    } catch (error) {
        return reply(error.status || (error.code === 'BAD_REQUEST' ? 400 : 500), {
            error: error.status || error.code === 'BAD_REQUEST' ? error.message : 'Machine operation failed.',
            code: error.code || 'FLEET_ERROR'
        })
    }
}
