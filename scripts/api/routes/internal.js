import path from 'node:path'

import { ACCOUNT_KEY as accountKey, WORKER_PROTOCOL, workerCapabilities } from '../../../packages/contracts/protocol.js'
import { loadAccounts } from '../../../packages/contracts/accounts.js'
import { atomicPrivateJson } from '../../../packages/contracts/store.js'
import { AccountIpChecker } from '../accountIpChecker.js'
import { validateConfig } from '../configEditor.js'
import { nodeResources } from '../nodeResources.js'
import { dispatchSchedulerCommand } from '../scheduler/SchedulerCommands.js'
import { deleteStoredSessions, importAccountSession, validateAccountSession } from '../sessionStore.js'
import { validateSmartConfig } from '../smartScheduler.js'

function fail(message, code = 'HYBRID_UNAVAILABLE', status = 503) {
    throw Object.assign(new Error(message), { code, status })
}

export async function handleInternalHybridRoutes(hybrid, req, res, url, { read, reply }) {
    const route = url.pathname.replace(/\/+$/, '')
    const method = req.method

    if (route === '/hybrid/events' && method === 'GET') {
        return reply(200, {
            nodeId: hybrid.store.nodeId,
            events: hybrid.store.events(Math.max(0, Number(url.searchParams.get('afterId')) || 0))
        })
    }

    if (!route.startsWith('/internal/hybrid/')) return false
    if (hybrid.role !== 'vps') return reply(404, { error: 'Not found' })

    const stage = /^\/internal\/hybrid\/stage-session\/([a-f0-9-]{36})$/.exec(route)
    if (stage && method === 'PUT') {
        const body = await read(req)
        if (!Number.isSafeInteger(body.index) || body.index < 1 || typeof body.email !== 'string') {
            fail('Invalid staged session.', 'BAD_REQUEST', 400)
        }
        validateAccountSession(body.email, body.bundle)
        atomicPrivateJson(path.join(hybrid.store.directory, 'staged', `${stage[1]}.json`), body)
        return reply(200, { staged: true })
    }

    if (route === '/internal/hybrid/status' && method === 'GET') {
        return reply(200, {
            nodeId: hybrid.store.nodeId,
            ...hybrid.runtimeStatus?.(),
            protocolVersion: hybrid.env.MRS_WORKER_MODE === '1' ? WORKER_PROTOCOL : 2,
            capabilities:
                hybrid.env.MRS_WORKER_MODE === '1'
                    ? workerCapabilities(hybrid.env.MRS_WORKER_KIND, hybrid.env)
                    : { conservativeSessionsV1: true },
            installation:
                hybrid.env.MRS_WORKER_MODE === '1'
                    ? { data: hybrid.env.MRS_WORKER_DATA, root: hybrid.env.MRS_WORKER_ROOT || null }
                    : undefined,
            manualSessions: hybrid.manual.list(),
            manualExits: hybrid.env.MRS_WORKER_MODE === '1' ? hybrid.store.get('manualExits') || {} : undefined,
            generation: hybrid.store.get('snapshot')?.generation || 0,
            resources: nodeResources(),
            learning: hybrid.learning?.status(),
            revision: hybrid.store.get('revision'),
            syncPending: hybrid.scheduler.suspended,
            limit: hybrid.hardParallel,
            smart: hybrid.scheduler.get(),
            accounts: hybrid.pm.getStatus().run.accounts,
            points: hybrid.pm.getPoints(),
            history: hybrid.pm.getHistory().slice(0, 20),
            holds: Object.keys(hybrid.holds).map(Number)
        })
    }

    if (route === '/internal/hybrid/events' && method === 'GET') {
        return reply(200, {
            events: hybrid.store.events(Math.max(0, Number(url.searchParams.get('afterId')) || 0))
        })
    }

    if (route === '/internal/hybrid/probe' && method === 'POST') {
        const body = await read(req)
        const results = await new AccountIpChecker({ concurrency: 1 }).check(body.accountIndexes ?? null)
        return reply(200, {
            results: results.map(result => ({ index: result.accountIndex, ok: Boolean(result.ip) }))
        })
    }

    if (route === '/internal/hybrid/control' && method === 'POST') {
        const { route: command, body = {} } = await read(req)
        const dispatched = await dispatchSchedulerCommand({
            scheduler: hybrid.scheduler,
            command,
            body,
            isWorkerMode: hybrid.env.MRS_WORKER_MODE === '1',
            strict: true,
            onCapacity: payload => {
                if (!Number.isInteger(payload.limit) || payload.limit < 1 || payload.limit > 32) {
                    fail('Capacity must be between 1 and 32.', 'BAD_REQUEST', 400)
                }
                hybrid.store.set('capacity', payload.limit)
                hybrid.scheduler.hardParallel = payload.limit
                hybrid.scheduler.replan()
            }
        })
        return reply(dispatched.status, dispatched.payload)
    }

    if (route === '/internal/hybrid/snapshot' && method === 'PUT') {
        if (hybrid.applying) fail('Configuration activation in progress.', 'SYNC_PENDING', 409)
        hybrid.applying = true
        try {
            const body = await read(req)
            if (hybrid.env.MRS_WORKER_MODE === '1' && body.protocolVersion !== WORKER_PROTOCOL) {
                fail('Worker protocol mismatch.', 'UPGRADE_REQUIRED', 409)
            }
            if (
                !/^[a-f0-9]{64}$/.test(body.revision || '') ||
                !body.accountEnv ||
                Object.entries(body.accountEnv).some(
                    ([key, value]) => !accountKey.test(key) || typeof value !== 'string'
                )
            ) {
                fail('Invalid node snapshot.', 'BAD_REQUEST', 400)
            }
            if (hybrid.env.MRS_WORKER_MODE === '1') {
                const accepted = hybrid.store.get('pendingSnapshot') || hybrid.store.get('snapshot')
                if (
                    !Number.isSafeInteger(body.generation) ||
                    body.generation < 1 ||
                    !/^[a-f0-9-]{36}$/.test(body.authority || '')
                ) {
                    fail('Invalid snapshot authority.', 'BAD_REQUEST', 400)
                }
                if (
                    accepted &&
                    (accepted.authority !== body.authority ||
                        accepted.generation > body.generation ||
                        (accepted.generation === body.generation && accepted.revision !== body.revision))
                ) {
                    fail('Stale snapshot.', 'STALE_SNAPSHOT', 409)
                }
            }
            if (body.revision === hybrid.store.get('revision')) {
                const accepted = hybrid.store.get('snapshot')
                hybrid.store.set('pendingSnapshot', null)
                hybrid.scheduler.suspended = false
                if (accepted && hybrid.scheduler.document.config.enabled !== accepted.schedule.enabled) {
                    hybrid.scheduler.update({
                        ...hybrid.scheduler.document.config,
                        enabled: accepted.schedule.enabled
                    })
                } else {
                    hybrid.scheduler._arm()
                }
                return reply(200, { applied: true })
            }
            const accounts = loadAccounts(body.accountEnv)
            if (
                accounts.some(account => !account.proxy) &&
                !(
                    hybrid.env.MRS_WORKER_MODE === '1' &&
                    (hybrid.env.MRS_WORKER_KIND === 'local' || body.allowDirectAccounts === true)
                )
            ) {
                fail('Remote direct-IP accounts require explicit Manager opt-in.', 'BAD_REQUEST', 400)
            }
            const validation = await validateConfig(body.botConfig, { projectRoot: hybrid.root })
            if (!validation.ok) fail('Invalid bot configuration.', 'BAD_REQUEST', 400)
            const schedule = validateSmartConfig(body.schedule, accounts)
            const previous = hybrid.store.get('snapshot')
            if (
                !Number.isSafeInteger(body.generation) ||
                body.generation < 1 ||
                !/^[a-f0-9-]{36}$/.test(body.authority || '')
            ) {
                fail('Missing snapshot generation.', 'BAD_REQUEST', 400)
            }
            if (
                previous &&
                (previous.authority !== body.authority ||
                    previous.generation > body.generation ||
                    (previous.generation === body.generation && previous.revision !== body.revision))
            ) {
                fail('A newer configuration has already been accepted.', 'STALE_SNAPSHOT', 409)
            }
            for (const account of loadAccounts(previous?.accountEnv || {})) {
                if (!accounts.some(a => a.index === account.index) && !hybrid.holds[account.index]) {
                    fail('Account removal requires a handoff hold.', 'ACCOUNT_HELD', 409)
                }
            }
            body.schedule = schedule
            hybrid.store.set('pendingSnapshot', body)
            if (hybrid.scheduler.running.size && !hybrid.canApplyMembershipSnapshot(body)) {
                hybrid.scheduler.suspended = true
                fail('Waiting for running jobs before applying configuration.', 'SYNC_PENDING', 409)
            }
            hybrid.scheduler.suspended = true
            hybrid.activateSnapshot(body)
            return reply(200, { applied: true })
        } finally {
            hybrid.applying = false
        }
    }

    const match = /^\/internal\/hybrid\/accounts\/(\d+)\/(hold|release|delete-session)$/.exec(route)
    if (match && method === 'POST') {
        const index = Number(match[1])
        const body = await read(req)
        if (!/^[a-f0-9-]{36}$/.test(body.token || '')) fail('Invalid hold token.', 'BAD_REQUEST', 400)
        const released = hybrid.store.get('released') || {}
        if (!hybrid.holds[index] && released[index] === body.token) {
            if (match[2] === 'hold') fail('Handoff already completed.', 'STALE_HANDOFF', 409)
            return reply(200, { released: true })
        }
        if (match[2] === 'hold') {
            return reply(
                200,
                await hybrid.hold(index, body.token, { wait: Boolean(body.wait), scope: body.scope || 'group' })
            )
        }
        if (hybrid.holds[index]?.token !== body.token) fail('Hold token does not match.', 'ACCOUNT_HELD', 409)
        const account = loadAccounts(hybrid.env).find(a => a.index === index)
        if (match[2] === 'delete-session') {
            deleteStoredSessions(hybrid.root, hybrid.sessionPath(), account.email)
        } else if (body.bundle) {
            if (!account) fail('Account was removed.', 'ACCOUNT_NOT_FOUND', 404)
            importAccountSession(hybrid.root, hybrid.sessionPath(), account.email, body.bundle)
        }
        delete hybrid.holds[index]
        hybrid.store.set('holds', hybrid.holds)
        released[index] = body.token
        hybrid.store.set('released', released)
        hybrid.scheduler.clearManualLock(index)
        return reply(200, { released: true })
    }

    return reply(404, { error: 'Not found' })
}
