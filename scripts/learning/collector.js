import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { LearningStore, learningConfig, learningIdentity } from '../../packages/contracts/learning.js'
import { nodeResources } from '../api/nodeResources.js'
import { loadAccounts } from '../../packages/contracts/accounts.js'
import { AccountIpChecker } from '../api/accountIpChecker.js'
import { deriveNetworkGroup } from '../api/smartScheduler.js'
import { preRewardsActive } from '../../packages/contracts/newAccount.js'

let clockTicks = 100
try {
    clockTicks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100
} catch {
    /* Supported Linux normally exposes 100 ticks. */
}
const digest = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex')
const numeric = (text, pattern) => {
    const v = text.match(pattern)?.[1]
    return v === undefined ? null : Number(v)
}
export function processResources(roots, proc = '/proc') {
    const processes = []
    for (const name of fs.readdirSync(proc)) {
        if (!/^\d+$/.test(name)) continue
        try {
            const raw = fs.readFileSync(path.join(proc, name, 'stat'), 'utf8')
            const a = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
            processes.push({
                pid: Number(name),
                parent: Number(a[1]),
                group: Number(a[2]),
                ticks: Number(a[11]) + Number(a[12]),
                start: a[19]
            })
        } catch {
            /* Exiting processes are normal. */
        }
    }
    return roots.map(({ attemptId, pid }) => {
        const descendants = new Set([pid])
        let previous = -1
        while (previous !== descendants.size) {
            previous = descendants.size
            for (const p of processes) if (descendants.has(p.parent) || p.group === pid) descendants.add(p.pid)
        }
        let ticks = 0,
            pss = 0,
            rss = 0,
            read = 0,
            write = 0,
            knownPss = true,
            alive = false
        for (const p of processes.filter(p => descendants.has(p.pid))) {
            try {
                const stat = fs.readFileSync(path.join(proc, String(p.pid), 'stat'), 'utf8')
                if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] !== p.start) continue
                const status = fs.readFileSync(path.join(proc, String(p.pid), 'status'), 'utf8')
                ticks += p.ticks
                rss += (numeric(status, /VmRSS:\s+(\d+)/) || 0) * 1024
                alive = true
                try {
                    const smaps = fs.readFileSync(path.join(proc, String(p.pid), 'smaps_rollup'), 'utf8')
                    pss += (numeric(smaps, /\nPss:\s+(\d+)/) || 0) * 1024
                } catch {
                    knownPss = false
                }
                try {
                    const io = fs.readFileSync(path.join(proc, String(p.pid), 'io'), 'utf8')
                    read += numeric(io, /\n?read_bytes:\s+(\d+)/) || 0
                    write += numeric(io, /\n?write_bytes:\s+(\d+)/) || 0
                } catch {
                    /* Optional metric. */
                }
            } catch {
                /* Process ended during measurement. */
            }
        }
        return {
            attemptId,
            cpuSeconds: ticks / clockTicks,
            pssBytes: knownPss && alive ? pss : null,
            rssBytes: alive ? rss : null,
            readBytes: read,
            writeBytes: write,
            alive
        }
    })
}
function extras() {
    const result = {}
    for (const [file, key] of [
        ['cpu', 'pressureCpu'],
        ['memory', 'pressureMemory']
    ])
        try {
            result[key] = numeric(fs.readFileSync('/proc/pressure/' + file, 'utf8'), /some avg10=([\d.]+)/)
        } catch {}
    try {
        const raw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()
        if (raw !== 'max') result.cgroupMemoryMax = Number(raw)
    } catch {}
    try {
        const [quota, period] = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(' ')
        if (quota !== 'max') result.cgroupCpuCores = Number(quota) / Number(period)
    } catch {}
    try {
        result.oomKills = numeric(fs.readFileSync('/sys/fs/cgroup/memory.events', 'utf8'), /oom_kill (\d+)/)
    } catch {}
    return result
}
export class LearningCollector {
    constructor({ directory, nodeId, config = null, environment = process.env }) {
        this.environment = environment
        this.nodeId = nodeId
        this.store = new LearningStore(directory, { nodeId })
        this.active = new Map()
        this.errors = 0
        this.dropped = 0
        this.ipChecker = new AccountIpChecker({ concurrency: 1 })
        this.lastDays = new Map()
        this.outbox = path.join(directory, 'outbox')
        fs.mkdirSync(this.outbox, { recursive: true, mode: 0o700 })
        this.configure(config || this.store.get('config'))
        // A crashed runtime has no verified outcome. Never turn it into a successful short job.
        for (const row of this.store.get('openAttempts') || []) {
            this.active.set(row.attemptId, { file: path.join(this.outbox, row.attemptId + '.jsonl'), offset: 0 })
            this.drain(row.attemptId)
            this.active.delete(row.attemptId)
            this.write('attempt_end', { ...row, interrupted: true, reason: 'worker-restart' })
            this.write('gap', { attemptId: row.attemptId, reason: 'worker-restart', count: 1 })
            fs.rmSync(path.join(this.outbox, row.attemptId + '.jsonl'), { force: true })
        }
        this.store.set('openAttempts', [])
    }
    configure(config) {
        if (!config) return
        this.config = learningConfig(config)
        this.store.set('config', this.config)
    }
    identity(kind, value) {
        return this.config ? learningIdentity(this.config.identitySecret, kind, value) : null
    }
    write(kind, data, options) {
        if (!this.config?.enabled) return
        try {
            const bytes = fs.statSync(path.join(this.store.directory, 'learning.sqlite')).size
            const wal = path.join(this.store.directory, 'learning.sqlite-wal')
            const size = bytes + (fs.existsSync(wal) ? fs.statSync(wal).size : 0)
            if (kind === 'resource' && size > 128 * 1024 * 1024) {
                this.dropped++
                if (this.dropped === 1)
                    this.store.append(this.config.collectionId, 'gap', { reason: 'disk-pressure', count: 1 })
                return
            }
            this.store.append(this.config.collectionId, kind, data, options)
        } catch {
            this.errors++
        }
    }
    queryUsage(index, day, platform) {
        if (!this.config?.enabled) return 0
        const account = loadAccounts().find(a => a.index === index)
        if (!account) return 0
        return (
            this.store.db
                .prepare('SELECT used FROM query_budget WHERE account=? AND day=? AND platform=?')
                .get(this.identity('account', account.email.toLowerCase()), day, platform)?.used || 0
        )
    }
    descriptor(job, scheduler) {
        const a = loadAccounts().find(a => a.index === job.accountIndex)
        if (!a) return {}
        const state = scheduler.document.state.accounts[String(a.index)] || {}
        const profile = scheduler.document.config.profiles.find(p => p.accountIndex === a.index)
        const parts = new Intl.DateTimeFormat('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
            timeZone: profile?.timezone || 'UTC'
        }).formatToParts(new Date())
        const minute =
            Number(parts.find(x => x.type === 'hour')?.value) * 60 + Number(parts.find(x => x.type === 'minute')?.value)
        const deadline = profile?.deadline?.split(':').map(Number) || [23, 0]
        const p = state.platforms?.[job.platform]
        return {
            accountId: this.identity('account', a.email.toLowerCase()),
            networkId: this.identity('network', deriveNetworkGroup(a, scheduler.document.config.networkGroupOverride)),
            type: job.type,
            platform: job.platform,
            workers: job.workers || [],
            searchBudget: job.searchBudget,
            dueAt: job.dueAt,
            reason: job.reason,
            attempts: job.attempts || 0,
            deadlineMinutes: Math.max(0, deadline[0] * 60 + deadline[1] - minute),
            newAccount: preRewardsActive(a, state),
            quotaKnown: p?.quotaKnown,
            remaining: p?.quotaKnown ? p.remaining : null,
            usedQueries: p?.queries,
            manual: scheduler.manualLocks.has(a.index),
            allowed: scheduler.accountFilter(a)
        }
    }
    experiment(scheduler, job, rng = Math.random) {
        const baseline = { arm: 'control', probability: 1, experimental: false, job }
        if (this.capacityChoice) return { ...this.capacityChoice, job }
        const config = this.config
        if (!config?.experimentAllowed || !config.startedAt || job.urgent || job.type !== 'search') return baseline
        const age = (Date.now() - Date.parse(config.startedAt)) / 86400000
        const state = scheduler.document.state.accounts[String(job.accountIndex)]
        const descriptor = this.descriptor(job, scheduler)
        const cap = config.dailySearchCaps?.[job.platform]
        if (
            age < 7 ||
            age >= 28 ||
            !cap ||
            !state ||
            descriptor.deadlineMinutes < 120 ||
            descriptor.manual ||
            descriptor.attempts ||
            !descriptor.quotaKnown ||
            job.searchBudget < 5 ||
            descriptor.usedQueries + job.searchBudget > cap
        )
            return baseline
        const key = 'experiment:' + new Date().toISOString().slice(0, 10)
        const counts = this.store.get(key) || { control: 0, trial: 0 }
        const admitted = counts.trial + 1 <= Math.floor((counts.control + counts.trial + 1) * 0.1)
        const probability = admitted ? config.experimentRate : 0
        const trial = admitted && rng() < probability
        return trial
            ? {
                  arm: 'budget-reduced',
                  probability,
                  experimental: true,
                  job: { ...job, searchBudget: Math.max(1, Math.floor(job.searchBudget * 0.8)) }
              }
            : { ...baseline, probability: 1 - probability }
    }
    capacity(scheduler, rng = Math.random) {
        const normal = scheduler.document.config.maxParallel,
            config = this.config
        this.capacityChoice = null
        if (scheduler.document.config.normalPolicy?.enabled) return normal
        if (
            scheduler.manualLocks.size ||
            scheduler.queue.some(job => job.type === 'warmup' || this.descriptor(job, scheduler).deadlineMinutes < 120)
        )
            return normal
        if (
            !config?.experimentAllowed ||
            normal < 2 ||
            scheduler.document.state.urgentRun?.active ||
            scheduler.document.state.onceAccounts?.length ||
            this.errors
        )
            return normal
        const age = (Date.now() - Date.parse(config.startedAt || '')) / 86400000
        if (!(age >= 7 && age < 28)) return normal
        const key = 'experiment:' + new Date().toISOString().slice(0, 10),
            counts = this.store.get(key) || { control: 0, trial: 0 }
        if (counts.trial + 1 > Math.floor((counts.control + counts.trial + 1) * 0.1)) return normal
        const blockId = digest([this.nodeId, Math.floor(Date.now() / 7200000)])
        let block = this.store.get('capacity-block')
        if (block?.blockId !== blockId) {
            block = { blockId, trial: rng() < config.experimentRate, probability: config.experimentRate }
            this.store.set('capacity-block', block)
        }
        if (!block.trial) {
            this.capacityChoice = {
                arm: 'control',
                probability: 1,
                blockProbability: 1 - block.probability,
                blockId,
                experimental: false,
                limit: normal
            }
            return normal
        }
        this.capacityChoice = {
            arm: 'concurrency-reduced',
            probability: 1,
            blockProbability: block.probability,
            blockId,
            experimental: true,
            limit: normal - 1
        }
        return normal - 1
    }
    decision(scheduler, job, choice, queue = scheduler.queue) {
        if (!this.config?.enabled) return null
        if (this.capacityChoice) choice = this.capacityChoice
        const countKey = 'experiment:' + new Date().toISOString().slice(0, 10),
            counts = this.store.get(countKey) || { control: 0, trial: 0 }
        counts[choice?.experimental ? 'trial' : 'control']++
        this.store.set(countKey, counts)
        const decisionId = crypto.randomUUID(),
            selected = this.descriptor(job, scheduler),
            candidates = queue.slice(0, 512).map(j => this.descriptor(j, scheduler))
        this.write('decision', {
            decisionId,
            ...selected,
            selected,
            candidates,
            candidateCount: queue.length,
            candidatesTruncated: queue.length > 512,
            running: [...scheduler.running.values()].map(r => this.descriptor(r.job, scheduler)),
            maxParallel: scheduler.document.config.maxParallel,
            effectiveParallel: this.capacityChoice?.limit || scheduler.document.config.maxParallel,
            hardParallel: scheduler.hardParallel || scheduler.document.config.maxParallel,
            cooldownMin: scheduler.document.config.cooldownMinutes.min,
            cooldownMax: scheduler.document.config.cooldownMinutes.max,
            searchCap: scheduler.document.config.searchSafetyCap,
            policy: choice?.experimental ? 'collection-explore-v1' : 'baseline-v1',
            arm: choice?.arm || 'control',
            probability: choice?.probability ?? 1,
            experimental: choice?.experimental || false,
            blockId: choice?.blockId,
            blockProbability: choice?.blockProbability,
            configRevision: digest(scheduler.document.config),
            runtimeRevision: this.runtimeRevision
        })
        return decisionId
    }
    startAttempt(record, scheduler, decisionId) {
        if (!this.config?.enabled) return {}
        this.scheduler = scheduler
        record.manager.on('status', event => {
            if (event.reason === 'running') this.tick(true)
        })
        const file = path.join(this.outbox, record.executionId + '.jsonl')
        fs.writeFileSync(file, '', { mode: 0o600, flag: 'wx' })
        const row = { attemptId: record.executionId, decisionId, ...this.descriptor(record.job, scheduler) }
        this.active.set(record.executionId, { ...row, file, offset: 0, record, started: performance.now() })
        this.store.set(
            'openAttempts',
            [...this.active.values()].map(({ attemptId, decisionId, accountId, type, workers, platform }) => ({
                attemptId,
                decisionId,
                accountId,
                type,
                workers,
                platform
            }))
        )
        this.write('attempt_start', row)
        const a = loadAccounts().find(a => a.index === record.job.accountIndex)
        if (a) void this.probe(a, record.executionId, scheduler)
        const state = scheduler.document.state.accounts[String(record.job.accountIndex)]
        const carried = state?.learningQueries || {}
        for (const platform of ['desktop', 'mobile'])
            this.store.db
                .prepare(
                    'INSERT INTO query_budget(account,day,platform,used) VALUES(?,?,?,?) ON CONFLICT(account,day,platform) DO UPDATE SET used=MAX(used,excluded.used)'
                )
                .run(row.accountId, record.job.day, platform, carried[platform] || 0)
        return {
            MRS_LEARNING_OUTBOX: file,
            MRS_LEARNING_ATTEMPT: record.executionId,
            MRS_LEARNING_LEDGER: path.join(this.store.directory, 'learning.sqlite'),
            MRS_LEARNING_ACCOUNT: row.accountId,
            MRS_LEARNING_CAPS: JSON.stringify(
                record.job.type === 'warmup' ? { desktop: 30, mobile: 20 } : this.config.dailySearchCaps
            ),
            MRS_LEARNING_TIMEZONE:
                scheduler.document.config.profiles.find(p => p.accountIndex === record.job.accountIndex)?.timezone ||
                'UTC'
        }
    }
    async probe(account, attemptId, scheduler) {
        try {
            let result = this.ipChecker.get(account.index)
            if (!result || Date.now() - Date.parse(result.checkedAt) > 300000)
                [result] = await this.ipChecker.check([account.index])
            this.write('network', {
                attemptId,
                accountId: this.identity('account', account.email.toLowerCase()),
                networkId: this.identity(
                    'network',
                    deriveNetworkGroup(account, scheduler.document.config.networkGroupOverride)
                ),
                ipId: result.ip ? this.identity('ip', result.ip) : null,
                checkedAt: result.checkedAt,
                durationMs: result.durationMs,
                known: Boolean(result.ip)
            })
        } catch {
            this.errors++
        }
    }
    capture(record, entry) {
        if (!this.config?.enabled) return
        if (entry.title === 'SMART-WORKER-END') {
            const task = /^worker=([^|\s]+)$/.exec(entry.message.trim())?.[1]
            if (task) this.write('activity', { attemptId: record.executionId, task, phase: 'verified', verified: true })
        }
        this.drain(record.executionId)
    }
    drain(attemptId) {
        const active = this.active.get(attemptId)
        if (!active) return
        try {
            const stat = fs.statSync(active.file)
            if (stat.size - active.offset > 4 * 1024 * 1024) {
                this.write('gap', { attemptId, reason: 'outbox-invalid', count: 1 })
                active.offset = stat.size
                return
            }
            const fd = fs.openSync(active.file, 'r')
            const bytes = Buffer.alloc(stat.size - active.offset)
            fs.readSync(fd, bytes, 0, bytes.length, active.offset)
            fs.closeSync(fd)
            const text = bytes.toString()
            const end = text.lastIndexOf('\n')
            if (end < 0) return
            for (const line of text.slice(0, end).split('\n')) {
                if (!line) continue
                try {
                    const row = JSON.parse(line)
                    if (!/^[a-f0-9-]{36}$/.test(row.eventId || '') || !['activity', 'query'].includes(row.kind))
                        throw Error()
                    this.write(
                        row.kind,
                        { ...row.data, attemptId, eventId: row.eventId },
                        { at: row.observedAt, dedup: row.eventId }
                    )
                } catch {
                    this.write('gap', { attemptId, reason: 'outbox-invalid', count: 1 })
                }
            }
            active.offset += Buffer.byteLength(text.slice(0, end + 1))
        } catch {
            this.errors++
        }
    }
    endAttempt(record, exit) {
        const active = this.active.get(record.executionId)
        if (!active) return
        this.drain(record.executionId)
        const state = this.scheduler.document.state.accounts[String(record.job.accountIndex)]
        if (state?.day === record.job.day)
            state.learningQueries = Object.fromEntries(
                this.store.db
                    .prepare('SELECT platform,used FROM query_budget WHERE account=? AND day=?')
                    .all(active.accountId, record.job.day)
                    .map(r => [r.platform, r.used])
            )
        const result = record.searchResult
        const accountSession = record.job.type === 'accountSession'
        const normalVerified =
            accountSession &&
            !record.normalFailure &&
            record.job.workers.every(w => record.workerResults.has(w)) &&
            Boolean(record.quotaSnapshot)
        const succeeded =
            exit.code === 0 &&
            record.manager.getStatus().run.accounts?.length > 0 &&
            record.manager.getStatus().run.accounts.every(a => a.success === true)
        this.write('attempt_end', {
            attemptId: record.executionId,
            decisionId: active.decisionId,
            accountId: active.accountId,
            type: record.job.type,
            workers: record.job.workers || [],
            platform: record.job.platform,
            durationMs: Math.max(0, performance.now() - active.started),
            failure: record.normalFailure,
            noProgressQueries: record.normalMetrics?.noProgressQueries,
            reconciliations: record.normalMetrics?.reconciliations,
            logins: record.normalMetrics?.logins,
            success: record.handoff
                ? null
                : succeeded &&
                  (accountSession
                      ? normalVerified
                      : record.job.type === 'workers'
                        ? record.job.workers.every(w => record.workerResults.has(w))
                        : record.job.type === 'warmup'
                          ? (record.warmupQueries || 0) >= record.job.searchBudget
                          : record.job.type === 'quota'
                            ? Boolean(record.quotaSnapshot)
                            : Boolean(result?.quotaAvailable && (result.points > 0 || result.remaining === 0))),
            verified: accountSession
                ? normalVerified
                : record.job.type === 'workers'
                  ? record.job.workers.every(w => record.workerResults.has(w))
                  : record.job.type === 'quota'
                    ? Boolean(record.quotaSnapshot)
                    : record.job.type === 'warmup'
                      ? (record.warmupQueries || 0) >= record.job.searchBudget
                      : result?.quotaAvailable === true,
            interrupted: Boolean(record.handoff),
            timedOut: Boolean(record.timedOut),
            staleDay: record.job.day !== this.scheduler.document.state.accounts[String(record.job.accountIndex)]?.day,
            queries: accountSession
                ? record.normalQueries
                : record.job.type === 'warmup'
                  ? record.warmupQueries
                  : result?.queries,
            points: result?.quotaAvailable ? result.points : null,
            remaining: result?.quotaAvailable ? result.remaining : null,
            quotaKnown: result?.quotaAvailable,
            completedWorkers: [...record.workerResults],
            reason: record.userStopped
                ? 'user-stop'
                : record.handoff
                  ? 'handoff'
                  : record.timedOut
                    ? 'timeout'
                    : exit.code !== 0
                      ? 'error'
                      : succeeded
                        ? 'completed'
                        : 'pending',
            exitCode: exit.code >= 0 ? exit.code : null
        })
        this.active.delete(record.executionId)
        this.store.set(
            'openAttempts',
            [...this.active.values()].map(({ attemptId, decisionId, accountId, type, workers, platform }) => ({
                attemptId,
                decisionId,
                accountId,
                type,
                workers,
                platform
            }))
        )
        fs.rmSync(active.file, { force: true })
    }
    days() {
        if (!this.scheduler) return
        let bot = {}
        try {
            bot = JSON.parse(fs.readFileSync(this.environment.MRS_CONFIG_FILE, 'utf8'))
        } catch {
            return
        }
        for (const account of loadAccounts()) {
            const state = this.scheduler.document.state.accounts[String(account.index)],
                profile = this.scheduler.document.config.profiles.find(p => p.accountIndex === account.index)
            if (!state || !profile) continue
            const required = profile.allowedWorkers.filter(w =>
                w === 'streakProtection'
                    ? bot.ensureStreakProtection
                    : bot.workers?.['do' + w[0].toUpperCase() + w.slice(1)]
            )
            const warmup = preRewardsActive(account, state),
                mobile = bot.workers?.doMobileSearch === true,
                desktop = bot.workers?.doDesktopSearch === true
            const known =
                warmup ||
                ((!mobile || state.platforms.mobile.quotaKnown) && (!desktop || state.platforms.desktop.quotaKnown))
            const complete = warmup
                ? state.platforms.desktop.queries >= 30 &&
                  state.platforms.mobile.queries >= 20 &&
                  ['onedrive', 'todo', 'outlook', 'calendar'].every(
                      s => state.newAccount?.services?.includes(s) && state.newAccount?.serviceActions?.includes(s)
                  )
                : known &&
                  required.every(w => state.workersCompleted.includes(w)) &&
                  (!mobile || state.platforms.mobile.complete) &&
                  (!desktop || state.platforms.desktop.complete)
            const accountId = this.identity('account', account.email.toLowerCase()),
                row = {
                    accountId,
                    day: state.day,
                    timezone: profile.timezone,
                    deadlineMinutes: Number(profile.deadline.slice(0, 2)) * 60 + Number(profile.deadline.slice(3)),
                    goalRevision: digest({ required, mobile, desktop, warmup, deadline: profile.deadline }),
                    requiredWorkers: required,
                    completedWorkers: state.workersCompleted,
                    failedWorkers: state.workersFailed,
                    mobileEnabled: mobile,
                    desktopEnabled: desktop,
                    mobileComplete: state.platforms.mobile.complete,
                    desktopComplete: state.platforms.desktop.complete,
                    mobileQuotaKnown: state.platforms.mobile.quotaKnown,
                    desktopQuotaKnown: state.platforms.desktop.quotaKnown,
                    mobileQueries: state.platforms.mobile.queries,
                    desktopQueries: state.platforms.desktop.queries,
                    newAccount: warmup,
                    manual: this.scheduler.manualLocks.has(account.index),
                    held: !this.scheduler.accountFilter(account),
                    enabled: this.scheduler.document.config.enabled,
                    complete: Boolean(complete),
                    known: Boolean(known),
                    earnVerified: state.earnScanVerified,
                    earnObservedAt: state.earnLastScannedAt,
                    observedAt: new Date().toISOString()
                }
            const previous = this.lastDays.get(accountId)
            const stable = digest({ ...row, observedAt: null })
            if (!previous || previous.hash !== stable || Date.now() - previous.at > 300000) {
                this.write('day', row)
                this.lastDays.set(accountId, { hash: stable, at: Date.now() })
            }
        }
    }
    attach(scheduler, manual) {
        this.scheduler = scheduler
        this.manual = manual
        try {
            this.runtimeRevision = digest([
                fs.readFileSync(path.join(scheduler.projectRoot, 'dist/index.js'), 'utf8'),
                fs.readFileSync(path.join(scheduler.projectRoot, 'scripts/api/smartScheduler.js'), 'utf8')
            ])
        } catch {
            this.runtimeRevision = digest('unknown-runtime')
        }
        this.lastSample = 0
        this.lastDaysAt = 0
        this.lastPrune = 0
        this.timer = setInterval(() => this.tick(), 1000)
        this.timer.unref()
        this.tick()
    }
    tick(force = false) {
        if (!this.config?.enabled || !this.scheduler) return
        const starting = [...this.active.values()].some(a => a.started && performance.now() - a.started < 15000)
        const interval = this.active.size ? (this.slowSampling ? 15000 : starting ? 1000 : 5000) : 30000
        if (!force && Date.now() - this.lastSample < interval) return
        this.lastSample = Date.now()
        const cpu = process.cpuUsage(),
            start = performance.now()
        try {
            for (const id of this.active.keys()) this.drain(id)
            const resources = nodeResources(),
                processes = processResources(
                    [...this.active.values()]
                        .filter(a => a.record.manager.pid)
                        .map(a => ({ attemptId: a.attemptId, pid: a.record.manager.pid }))
                )
            const used = process.cpuUsage(cpu)
            const cpuMs = (used.user + used.system) / 1000
            this.slowSampling = cpuMs > interval * 0.01
            this.write('resource', {
                cpuCores: resources.cpuCores,
                cpuPercent: resources.cpuPercent,
                load1: resources.loadAverage[0],
                memoryTotal: resources.memory.total,
                memoryAvailable: resources.memory.available,
                swapUsed: resources.swap.used,
                diskAvailable: resources.disk?.available,
                active: this.active.size,
                manual: this.manual?.list().length || 0,
                processes,
                sampleIntervalMs: interval,
                collectorCpuMs: cpuMs,
                collectorWallMs: performance.now() - start,
                ...extras()
            })
            if (Date.now() - this.lastDaysAt > 30000) {
                this.lastDaysAt = Date.now()
                this.days()
            }
            if (Date.now() - this.lastPrune > 3600000) {
                this.lastPrune = Date.now()
                this.store.prune()
            }
        } catch {
            this.errors++
        }
    }
    status() {
        return {
            version: 1,
            enabled: this.config?.enabled || false,
            collectionId: this.config?.collectionId || null,
            active: this.active.size,
            errors: this.errors,
            droppedSamples: this.dropped,
            records: this.store.stats(),
            lastSampleAt: this.lastSample ? new Date(this.lastSample).toISOString() : null
        }
    }
    close() {
        clearInterval(this.timer)
        for (const id of this.active.keys()) this.drain(id)
        this.store.close()
    }
}
