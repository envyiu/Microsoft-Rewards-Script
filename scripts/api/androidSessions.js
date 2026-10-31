import crypto from 'node:crypto'
import net from 'node:net'
import { envBool, envStr } from './lib.js'

// First-time provisioning can start Redroid, apply a device profile, and
// install the split APKM. Keep the request open long enough for that work;
// status/viewer calls still complete immediately.
const SOCKET_TIMEOUT_MS = 600000

function socketPath() {
    const configured = envStr('DAMRU_BRIDGE_SOCKET')
    if (configured) return configured
    // Host services use the per-user runtime directory, while the container
    // mounts the same socket at /run/damru. Keep both defaults working.
    const runtimeDir = envStr('XDG_RUNTIME_DIR')
    return runtimeDir ? `${runtimeDir}/damru/bridge.sock` : '/run/damru/bridge.sock'
}

export function normalizeAccountEmail(value) {
    return String(value ?? '').trim().toLowerCase()
}

export function accountRefForEmail(email) {
    return crypto.createHash('sha256').update(normalizeAccountEmail(email), 'utf8').digest('hex')
}

function buildProxyUri(index) {
    const urlValue = envStr(`ACCOUNT_${index}_PROXY_URL`)
    const port = envStr(`ACCOUNT_${index}_PROXY_PORT`)
    if (!urlValue || !port) return null
    let parsed
    try {
        parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(urlValue) ? urlValue : `http://${urlValue}`)
        if (!parsed.hostname || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) return null
        parsed.port = String(port)
        const username = envStr(`ACCOUNT_${index}_PROXY_USERNAME`)
        const password = envStr(`ACCOUNT_${index}_PROXY_PASSWORD`)
        if ((username && !password) || (!username && password)) return null
        if (username || password) {
            parsed.username = username ?? ''
            parsed.password = password ?? ''
        }
        return parsed.toString()
    } catch {
        return null
    }
}

function hasProxySettings(index) {
    return ['URL', 'PORT', 'USERNAME', 'PASSWORD'].some(field => envStr(`ACCOUNT_${index}_PROXY_${field}`))
}

function callBridge(action, data = {}) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath())
        let raw = ''
        let settled = false
        const finish = (error, value) => {
            if (settled) return
            settled = true
            socket.destroy()
            if (error) reject(error)
            else resolve(value)
        }
        socket.setTimeout(SOCKET_TIMEOUT_MS, () => {
            const error = new Error('Host bridge timed out.')
            error.code = 'BRIDGE_TIMEOUT'
            finish(error)
        })
        socket.on('error', error => {
            const wrapped = new Error(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
                ? 'Host bridge is not running.'
                : 'Host bridge connection failed.')
            wrapped.code = 'BRIDGE_UNAVAILABLE'
            finish(wrapped)
        })
        socket.on('data', chunk => {
            raw += chunk.toString('utf8')
            const end = raw.indexOf('\n')
            if (end === -1) return
            let payload
            try {
                payload = JSON.parse(raw.slice(0, end))
            } catch {
                const error = new Error('Host bridge returned invalid data.')
                error.code = 'BRIDGE_ERROR'
                return finish(error)
            }
            if (!payload?.ok) {
                const error = new Error(typeof payload?.error === 'string' ? payload.error : 'Host bridge request failed.')
                error.code = payload?.code || 'BRIDGE_ERROR'
                return finish(error)
            }
            finish(null, payload.result ?? {})
        })
        socket.on('connect', () => socket.write(`${JSON.stringify({ action, data })}\n`))
    })
}

export function proxyForAccount(index) {
    return buildProxyUri(index)
}

export async function getAndroidSessions() {
    return callBridge('status')
}

export async function openAndroidSession({ accountIndex, email }) {
    const proxy = buildProxyUri(accountIndex)
    if (!proxy && hasProxySettings(accountIndex)) {
        const error = new Error(`ACCOUNT_${accountIndex} has an incomplete proxy configuration.`)
        error.code = 'INVALID_PROXY_CONFIG'
        throw error
    }
    const scheme = proxy ? new URL(proxy).protocol.toLowerCase() : ''
    return callBridge('open', {
        accountRef: accountRefForEmail(email),
        accountIndex,
        proxy,
        httpProxy: proxy && envBool(`ACCOUNT_${accountIndex}_PROXY_HTTP`, false) && ['http:', 'https:'].includes(scheme) ? proxy : null
    })
}

export async function openAndroidViewer({ accountIndex, email }) {
    return callBridge('viewer', { accountRef: accountRefForEmail(email), accountIndex })
}

export async function stopAndroidSession({ accountIndex, email }) {
    return callBridge('stop', { accountRef: accountRefForEmail(email), accountIndex })
}

export async function deleteAndroidSession({ accountIndex, email, worker, confirmation }) {
    return callBridge('delete', { accountRef: accountRefForEmail(email), accountIndex, worker, confirmation })
}
