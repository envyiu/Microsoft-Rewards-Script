import fs from 'node:fs'
import { hourlyLoadAdmission, proxyCooldownMethods } from './replay-policy.mjs'

const [inputPath, outputPath, earlyScale = '1', laterScale = '1', reserveScale = '1', hourlyCeiling = 'Infinity'] = process.argv.slice(2)
const workload = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
const minute = 60_000
const hour = 60 * minute
const caps = new Map([['Windows 10', 3], ['Windows Server 2019', 2]])
const config = { spreadLoadV1: true }
const gap = type => (type === 'warmup' ? 30 : 90) * minute

function replay(jobs, model, opens, closes, capacity) {
    const completed = [], running = [], accountEnd = new Map(), proxyEnd = new Map()
    const proxyPolicy = {
        document: { config, state: {} },
        _proxyCooldownUntil(group, account, now) {
            const previous = proxyEnd.get(group)
            return previous && previous.accountIndex !== account && previous.end + 20 * minute > now
                ? previous.end + 20 * minute : 0
        }
    }
    const byAccount = new Map()
    for (const job of jobs) {
        if (!byAccount.has(job.accountIndex)) byAccount.set(job.accountIndex, [])
        byAccount.get(job.accountIndex).push(job)
    }
    for (let now = opens; now < closes; now += minute) {
        for (let i = running.length - 1; i >= 0; i--) {
            if (running[i].end > now) continue
            completed.push(running[i])
            running.splice(i, 1)
        }
        const candidates = []
        for (const [accountIndex, queue] of byAccount) {
            if (!queue.length) continue
            const [next] = queue
            const ready = Math.max(opens, next.release, (accountEnd.get(accountIndex) ?? 0) + gap(next.type))
            const remainingWorkMs = queue.reduce((sum, item) => sum + item[model][0] * minute, 0)
            const criticalPath = queue.reduce(
                (sum, item, i) => sum + Math.max(item[model][0], item[model][1] * (model === 'model' ? Number(reserveScale) : 1)) * minute + (i ? gap(item.type) : 0),
                0
            )
            candidates.push({
                ...next,
                dueAt: new Date(ready).toISOString(),
                estimatedSessionMs: next[model][0] * minute,
                remainingWorkMs,
                timeToDeadlineMs: closes - now,
                completionSlackMs: closes - Math.max(now, ready) - criticalPath
            })
        }
        const scale = model === 'model' ? Number(now < opens + 3 * hour ? earlyScale : laterScale) : 1
        const total = candidates.reduce((sum, job) => sum + job.remainingWorkMs, 0)
        const hoursLeft = Math.max(1, (closes - now) / hour)
        const ceilingScale = model === 'model' && total > 0 ? Number(hourlyCeiling) * minute * hoursLeft / total : Infinity
        const loadForecast = candidates.map(job => ({ ...job, remainingWorkMs: job.remainingWorkMs * Math.min(scale, ceilingScale) }))
        const admit = hourlyLoadAdmission(config, loadForecast, completed, running, new Set(), now)
        candidates.sort((a, b) => a.completionSlackMs - b.completionSlackMs)
        for (const job of candidates) {
            if (running.length >= capacity) break
            if (Date.parse(job.dueAt) > now || running.some(record => record.job.networkGroup === job.networkGroup)) continue
            if (proxyCooldownMethods._proxyDispatchUntil.call(proxyPolicy, job, now) || !admit(job)) continue
            const end = now + job.durationMs
            const record = { job, start: now, end, startedAt: new Date(now).toISOString(), endedAt: new Date(end).toISOString() }
            running.push(record)
            accountEnd.set(job.accountIndex, end)
            proxyEnd.set(job.networkGroup, { accountIndex: job.accountIndex, end })
            byAccount.get(job.accountIndex).shift()
        }
    }
    return [...completed, ...running]
}

function summarize(records, opens, closes) {
    const hourly = Array.from({ length: 17 }, (_, i) => {
        const left = opens + i * hour
        return records.reduce((sum, r) => sum + Math.max(0, Math.min(r.end, left + hour) - Math.max(r.start, left)), 0) / minute
    })
    const done = records.filter(r => r.end <= closes)
    const tasks = done.flatMap(r => r.job.completed)
    const search = done.reduce((sum, r) => sum + (r.job.queries ?? 0), 0)
    return {
        hourly, early: hourly.slice(0, 3).reduce((a, b) => a + b, 0), peak: Math.max(...hourly),
        sessions: done.length, search, tasks: tasks.length,
        dailySet: tasks.filter(t => t === 'dailySet').length,
        dailyCheckIn: tasks.filter(t => t === 'dailyCheckIn').length
    }
}

const reports = []
for (const day of [...new Set(workload.map(r => r.day))].sort()) {
    const opens = Date.parse(day + 'T06:00:00+07:00')
    const closes = opens + 17 * hour
    for (const [worker, capacity] of caps) {
        const jobs = workload
            .filter(r => r.day === day && r.worker === worker && Date.parse(r.start) >= opens && Date.parse(r.end) <= closes)
            .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
            .map(r => ({ ...r, accountIndex: r.account, networkGroup: r.proxy, release: Date.parse(r.dueAt) || Date.parse(r.start) }))
        const recorded = jobs.map(job => ({ job, start: Date.parse(job.start), end: Date.parse(job.end) }))
        reports.push({
            day, worker, capacity,
            recorded: summarize(recorded, opens, closes),
            baseline: summarize(replay(jobs, 'baseline', opens, closes, capacity), opens, closes),
            learned: summarize(replay(jobs, 'model', opens, closes, capacity), opens, closes)
        })
    }
}
fs.writeFileSync(outputPath, JSON.stringify(reports, null, 2) + '\n')
for (const { day, worker, baseline, learned } of reports) {
    console.log(day, worker, JSON.stringify([baseline, learned].map(({ hourly, ...metrics }) => metrics)))
}
