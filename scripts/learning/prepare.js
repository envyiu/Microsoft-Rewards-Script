import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const DAY = 86400000
/** Split by decision time, never by random rows. Outcomes do not become features. */
export function prepareDataset(records, startedAt, asOf = new Date().toISOString(), { sorted = false } = {}) {
    const epoch = Date.parse(startedAt),
        cutoff = Date.parse(asOf)
    if (!Number.isFinite(epoch) || !Number.isFinite(cutoff)) throw Error('Collection has not started')
    const rows = sorted
        ? records
        : records
              .filter(r => Date.parse(r.observedAt) <= cutoff)
              .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.id - b.id)
    const machineAtDecision = new Map(),
        historyAtDecision = new Map(),
        latestMachine = new Map(),
        recentOutcomes = new Map()
    const decisions = new Map(),
        starts = new Map(),
        ends = new Map(),
        resources = new Map(),
        days = new Map(),
        queries = new Map()
    for (const row of rows) {
        if (Date.parse(row.observedAt) > cutoff) continue
        const p = row.data
        if (row.kind === 'decision') {
            decisions.set(p.decisionId, row)
            machineAtDecision.set(p.decisionId, latestMachine.get(row.sourceNode) || null)
            historyAtDecision.set(p.decisionId, [...(recentOutcomes.get(row.sourceNode) || [])])
        }
        if (row.kind === 'attempt_start') starts.set(p.attemptId, row)
        if (row.kind === 'attempt_end') {
            ends.set(p.attemptId, row)
            const history = recentOutcomes.get(row.sourceNode) || []
            history.push({
                durationMs: p.durationMs ?? null,
                success: p.interrupted || p.timedOut ? null : (p.success ?? null)
            })
            recentOutcomes.set(row.sourceNode, history.slice(-20))
        }
        if (row.kind === 'resource') latestMachine.set(row.sourceNode, { observedAt: row.observedAt, data: p })
        if (row.kind === 'resource')
            for (const process of p.processes || []) {
                const samples = resources.get(process.attemptId) || []
                samples.push({ at: row.observedAt, ...process })
                resources.set(process.attemptId, samples)
            }
        if (row.kind === 'query' && p.phase === 'intent') {
            const set = queries.get(p.attemptId) || new Set()
            set.add(p.queryId)
            queries.set(p.attemptId, set)
        }
        if (row.kind === 'day') {
            const key = p.accountId + ':' + p.day + ':' + p.goalRevision
            const list = days.get(key) || []
            list.push(row)
            days.set(key, list)
        }
    }
    const attempts = [],
        excluded = { missingDecision: 0, outsideWindow: 0 }
    for (const [id, start] of starts) {
        const decision = decisions.get(start.data.decisionId)
        if (!decision || Date.parse(decision.observedAt) > Date.parse(start.observedAt)) {
            excluded.missingDecision++
            continue
        }
        const dayIndex = Math.floor((Date.parse(decision.observedAt) - epoch) / DAY) + 1
        if (dayIndex < 1 || dayIndex > 35) {
            excluded.outsideWindow++
            continue
        }
        const boundary = epoch + (dayIndex <= 21 ? 21 : dayIndex <= 28 ? 28 : 35) * DAY
        const observedFinish = ends.get(id),
            finish = observedFinish && Date.parse(observedFinish.observedAt) < boundary ? observedFinish : undefined,
            end = finish?.data,
            censored =
                !end ||
                end.interrupted ||
                end.timedOut ||
                end.staleDay ||
                ['worker-restart', 'handoff', 'user-stop', 'spawn-error'].includes(end.reason)
        const samples = (resources.get(id) || []).filter(s => Date.parse(s.at) < boundary),
            pss = samples.map(s => s.pssBytes).filter(Number.isFinite)
        attempts.push({
            attemptId: id,
            decisionId: decision.data.decisionId,
            sourceNode: start.sourceNode,
            dayIndex,
            split: dayIndex <= 21 ? 'train' : dayIndex <= 28 ? 'validation' : 'test',
            observedAt: decision.observedAt,
            features: {
                ...decision.data,
                machine: machineAtDecision.get(decision.data.decisionId),
                recentOutcomes: historyAtDecision.get(decision.data.decisionId) || []
            },
            labels: {
                censored: Boolean(censored),
                durationMs: end?.durationMs ?? null,
                success: censored ? null : (end?.success ?? null),
                verified: censored ? null : (end?.verified ?? null),
                points: end?.quotaKnown ? (end.points ?? null) : null,
                queryIntents: queries.get(id)?.size || 0,
                peakObservedPssBytes: pss.length ? Math.max(...pss) : null,
                resourceSamples: samples.length
            },
            outcomeObservedAt: finish?.observedAt || null
        })
    }
    const accountDays = []
    for (const list of days.values()) {
        const first = list[0].data
        // Convert timestamps into the account timezone before applying its own deadline.
        const eligible = list.filter(r => {
            const p = new Intl.DateTimeFormat('en-CA', {
                timeZone: first.timezone || 'UTC',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23'
            }).formatToParts(new Date(r.observedAt))
            const get = k => p.find(x => x.type === k)?.value
            return (
                `${get('year')}-${get('month')}-${get('day')}` === first.day &&
                Number(get('hour')) * 60 + Number(get('minute')) <= first.deadlineMinutes
            )
        })
        const latest = eligible.at(-1)
        if (!latest) continue
        const afterDeadline = list.some(
            r => Date.parse(r.observedAt) > Date.parse(latest.observedAt) && !eligible.includes(r)
        )
        accountDays.push({
            accountId: first.accountId,
            day: first.day,
            goalRevision: first.goalRevision,
            timezone: first.timezone,
            deadlineMinutes: first.deadlineMinutes,
            observedAt: latest.observedAt,
            requiredWorkers: first.requiredWorkers,
            known: latest.data.known,
            complete: latest.data.known ? latest.data.complete : null,
            final: Boolean(afterDeadline),
            manual: latest.data.manual,
            held: latest.data.held
        })
    }
    return { attempts, accountDays, excluded }
}
export async function exportDataset({ url = 'http://127.0.0.1:3012', token = process.env.MANAGER_TOKEN, output }) {
    if (!token || !output) throw Error('Set MANAGER_TOKEN and supply a new private output directory')
    const base = new URL(url)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
        throw Error('Use the local Manager endpoint or a local SSH tunnel')
    const get = async endpoint => {
        const r = await fetch(new URL(endpoint, base), { headers: { authorization: 'Bearer ' + token } })
        if (!r.ok) throw Error('Manager request failed: ' + r.status)
        return r.json()
    }
    const status = await get('/learning/status')
    if (!status.startedAt) throw Error('Collection has not started')
    fs.mkdirSync(output, { mode: 0o700 })
    const staging = path.join(output, '.staging.sqlite'),
        db = new DatabaseSync(staging)
    fs.chmodSync(staging, 0o600)
    db.exec(
        'CREATE TABLE records(id INTEGER PRIMARY KEY,observed TEXT,envelope TEXT); CREATE INDEX ordered ON records(observed,id)'
    )
    const insert = db.prepare('INSERT INTO records VALUES(?,?,?)'),
        raw = fs.openSync(path.join(output, 'records.jsonl'), 'wx', 0o600),
        hash = crypto.createHash('sha256')
    let after = 0,
        snapshotId,
        count = 0,
        data,
        asOf
    try {
        for (;;) {
            const q = new URLSearchParams({ after: String(after) })
            if (snapshotId !== undefined) q.set('snapshotId', String(snapshotId))
            const page = await get('/learning/export?' + q)
            snapshotId = page.snapshotId
            const content = page.records.map(r => JSON.stringify(r) + '\n').join('')
            fs.writeSync(raw, content)
            hash.update(content)
            count += page.records.length
            db.exec('BEGIN')
            try {
                for (const row of page.records) insert.run(row.id, row.observedAt, JSON.stringify(row))
                db.exec('COMMIT')
            } catch (e) {
                db.exec('ROLLBACK')
                throw e
            }
            if (page.done) break
            if (page.nextCursor <= after) throw Error('Export cursor did not advance')
            after = page.nextCursor
        }
        fs.fsyncSync(raw)
        asOf = new Date().toISOString()
        const ordered = (function* () {
            for (const row of db.prepare('SELECT envelope FROM records ORDER BY observed,id').iterate())
                yield JSON.parse(row.envelope)
        })()
        data = prepareDataset(ordered, status.startedAt, asOf, { sorted: true })
    } finally {
        fs.closeSync(raw)
        db.close()
        fs.rmSync(staging, { force: true })
    }
    const files = { 'records.jsonl': { rows: count, sha256: hash.digest('hex') } }
    const write = (name, rows) => {
        const content = rows.map(r => JSON.stringify(r) + '\n').join('')
        fs.writeFileSync(path.join(output, name), content, { mode: 0o600, flag: 'wx' })
        files[name] = { rows: rows.length, sha256: crypto.createHash('sha256').update(content).digest('hex') }
    }
    for (const split of ['train', 'validation', 'test'])
        write(
            split + '.jsonl',
            data.attempts.filter(a => a.split === split)
        )
    write('account-days.jsonl', data.accountDays)
    const manifest = {
        version: 1,
        collectionId: status.collectionId,
        startedAt: status.startedAt,
        asOf,
        snapshotId,
        splitDays: { train: [1, 21], validation: [22, 28], test: [29, 35] },
        features: 'decision state only; outcome fields excluded',
        files,
        excluded: data.excluded,
        quality: status.collectionQuality || status.quality,
        readyForTraining:
            status.ageDays >= 28 &&
            (status.collectionQuality || status.quality).accepted &&
            !status.readinessReasons?.includes('source-health-not-met') &&
            !status.readinessReasons?.includes('sparse-task-groups') &&
            data.attempts.filter(a => !a.labels.censored).length >= 5000,
        readyForAutonomousControl: false
    }
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' })
    return manifest
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    exportDataset({ url: process.env.MANAGER_URL, output: process.argv[2] })
        .then(m =>
            console.log(
                JSON.stringify({ collectionId: m.collectionId, files: m.files, readyForTraining: m.readyForTraining })
            )
        )
        .catch(e => {
            console.error(e.message)
            process.exitCode = 1
        })
}
