import fs from 'node:fs'
import os from 'node:os'

let previous
let cached
export function nodeResources() {
    if (cached && Date.now() - Date.parse(cached.measuredAt) < 5000) return cached
    const now = process.hrtime.bigint()
    const cpus = os.cpus()
    const totals = cpus.reduce(
        (v, cpu) => {
            v.total += Object.values(cpu.times).reduce((a, b) => a + b, 0)
            v.idle += cpu.times.idle
            return v
        },
        { total: 0, idle: 0 }
    )
    const cpuPercent =
        previous && totals.total > previous.total
            ? Math.max(0, Math.min(100, 100 * (1 - (totals.idle - previous.idle) / (totals.total - previous.total))))
            : null
    previous = { ...totals, now }
    let memory = {}
    try {
        for (const line of fs.readFileSync('/proc/meminfo', 'utf8').trim().split('\n')) {
            const [key, value] = line.split(':')
            memory[key] = Number.parseInt(value, 10) * 1024
        }
    } catch {}
    let disk = null
    try {
        const stat = fs.statfsSync('/')
        disk = {
            total: stat.blocks * stat.bsize,
            available: stat.bavail * stat.bsize,
            used: (stat.blocks - stat.bfree) * stat.bsize
        }
    } catch {}
    const total = memory.MemTotal || os.totalmem()
    const available = memory.MemAvailable || os.freemem()
    cached = {
        measuredAt: new Date().toISOString(),
        cpuCores: cpus.length,
        cpuPercent,
        loadAverage: os.loadavg(),
        memory: { total, available, used: total - available },
        swap: { total: memory.SwapTotal || 0, used: (memory.SwapTotal || 0) - (memory.SwapFree || 0) },
        disk
    }
    return cached
}
