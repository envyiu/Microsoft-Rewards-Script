import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

function defaultWin32Inspector(pid) {
    const powershell = path.join(
        process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
    )
    const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue; if ($p -and $p.CreationDate) { @{ c = ([datetime]$p.CreationDate).ToUniversalTime().ToString('o'); n = $p.Name } | ConvertTo-Json -Compress }`
    const raw = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3000
    }).trim()
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed?.c ? { boot: 'win32', started: `${parsed.c}:${parsed.n || ''}` } : null
}

// A PID alone can refer to an unrelated process after a restart. Linux exposes
// the boot identifier and immutable process start ticks; Windows exposes CIM
// Win32_Process CreationDate + Name.
export function processIdentity(
    pid,
    { platform = process.platform, root = '/proc', win32Inspector = defaultWin32Inspector } = {}
) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null
    if (platform === 'linux') {
        try {
            const boot = fs.readFileSync(`${root}/sys/kernel/random/boot_id`, 'utf8').trim()
            const stat = fs.readFileSync(`${root}/${pid}/stat`, 'utf8')
            const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
            const started = fields[19]
            return boot && /^\d+$/.test(started) ? { boot, started } : null
        } catch {
            return null
        }
    }
    if (platform === 'win32') {
        try {
            return win32Inspector(pid)
        } catch {
            return null
        }
    }
    return null
}

export function processReplaced(expected, actual) {
    return Boolean(expected && actual && (expected.boot !== actual.boot || expected.started !== actual.started))
}
