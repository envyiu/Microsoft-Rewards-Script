import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const kind = process.env.MRS_WORKER_KIND || 'remote'
if (!['local', 'remote'].includes(kind)) throw new Error('MRS_WORKER_KIND must be local or remote')
if (!process.env.API_TOKEN || process.env.API_TOKEN.length < 16 || /[\r\n]/.test(process.env.API_TOKEN) || !['127.0.0.1', '::1', 'localhost'].includes(process.env.API_HOST || '127.0.0.1')) {
    throw new Error('Workers require API_TOKEN and a loopback API_HOST')
}
if (!process.env.MRS_WORKER_DATA) throw new Error('MRS_WORKER_DATA is required')
const data = path.resolve(process.env.MRS_WORKER_DATA)
fs.mkdirSync(data, { recursive: true, mode: 0o700 })
process.chdir(data)
Object.assign(process.env, {
    MRS_WORKER_MODE: '1', MRS_NODE_ROLE: 'vps', MRS_WORKER_KIND: kind,
    MRS_NODE_DATA: path.join(data, 'journal'), SMART_SCHEDULE_FILE: path.join(data, 'smart-schedule.json'),
    MRS_CONFIG_FILE: path.join(data, 'config.json'), API_DIAGNOSTICS_DIR: path.join(data, 'diagnostics'), MRS_SKIP_ENV_FILE: '1',
    API_ALLOW_ACCOUNT_WRITE: 'false', API_ALLOW_CONFIG_WRITE: 'false', API_ALLOW_SCHEDULE_WRITE: 'false'
})
// Assigned accounts only ever come from the accepted, durable worker snapshot.
for (const key of Object.keys(process.env)) if (/^ACCOUNT_\d+_/.test(key)) delete process.env[key]
if (!fs.existsSync(process.env.MRS_CONFIG_FILE)) {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'))
    config.sessionPath = path.join(data, 'sessions')
    if (kind === 'remote') config.headless = true
    fs.writeFileSync(process.env.MRS_CONFIG_FILE, JSON.stringify(config), { mode: 0o600 })
}
if (!fs.existsSync(process.env.SMART_SCHEDULE_FILE)) {
    fs.writeFileSync(process.env.SMART_SCHEDULE_FILE, JSON.stringify({ config: { enabled: false }, state: { accounts: {}, sessions: [] } }), { mode: 0o600 })
}
await import('../api/server.js')
