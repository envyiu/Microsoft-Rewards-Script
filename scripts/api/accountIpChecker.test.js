import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import test from 'node:test'

import { AccountIpChecker, probeAccountIp } from './accountIpChecker.js'

function accounts(count = 3) {
    return Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`ACCOUNT_${i + 1}_EMAIL`, `account${i + 1}@example.test`])
    )
}

async function listen(t, server) {
    const sockets = new Set()
    server.on('connection', socket => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(async () => {
        for (const socket of sockets) socket.destroy()
        await new Promise(resolve => server.close(resolve))
    })
    return server.address().port
}

test('IP probe handles direct IPv4 and IPv6 responses and rejects malformed data', async t => {
    let ip = '198.51.100.42'
    const port = await listen(
        t,
        http.createServer((_req, res) => res.end(JSON.stringify({ ip })))
    )
    const endpoint = `http://127.0.0.1:${port}`
    const ipv4 = await probeAccountIp({ url: '' }, { endpoint })
    assert.deepEqual(ipv4, { ip, family: 'IPv4', error: null })
    ip = '2001:db8::1'
    assert.equal((await probeAccountIp({ url: '' }, { endpoint })).family, 'IPv6')
    ip = 'not-an-address'
    const invalid = await probeAccountIp({ url: '' }, { endpoint })
    assert.equal(invalid.ip, null)
    assert.ok(invalid.error)
    assert.equal(JSON.stringify(invalid).includes(ip), false)
})

test('a stalled IP service times out with a redacted failure', async t => {
    const port = await listen(
        t,
        http.createServer(() => {})
    )
    const result = await probeAccountIp({ url: '' }, { endpoint: `http://127.0.0.1:${port}`, timeout: 100 })
    assert.equal(result.ip, null)
    assert.ok(result.error)
})

test('IP probe uses the authenticated HTTP proxy and never silently falls back to direct', async t => {
    const targetPort = await listen(
        t,
        http.createServer((_req, res) => res.end('{"ip":"203.0.113.4"}'))
    )
    let authCount = 0
    let rejectAuth = false
    const expected = `Basic ${Buffer.from('proxy-user@region:proxy%password').toString('base64')}`
    const proxy = http.createServer((req, res) => {
        if (rejectAuth || req.headers['proxy-authorization'] !== expected) {
            res.writeHead(407).end()
            return
        }
        authCount++
        res.end('{"ip":"203.0.113.4"}')
    })
    proxy.on('connect', (req, socket, head) => {
        if (rejectAuth || req.headers['proxy-authorization'] !== expected) {
            socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
            return
        }
        authCount++
        const upstream = net.connect(targetPort, '127.0.0.1', () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            if (head.length) upstream.write(head)
            socket.pipe(upstream).pipe(socket)
        })
        socket.on('close', () => upstream.destroy())
        upstream.on('error', () => socket.destroy())
    })
    const proxyPort = await listen(t, proxy)
    const config = {
        url: 'http://127.0.0.1',
        port: proxyPort,
        username: 'proxy-user@region',
        password: 'proxy%password',
        proxyHttp: false
    }
    const result = await probeAccountIp(config, { endpoint: `http://127.0.0.1:${targetPort}`, timeout: 1000 })
    assert.equal(result.ip, '203.0.113.4')
    assert.ok(authCount > 0)
    rejectAuth = true
    const failed = await probeAccountIp(config, { endpoint: `http://127.0.0.1:${targetPort}`, timeout: 1000 })
    assert.equal(failed.ip, null)
    assert.ok(failed.error)
    assert.equal(JSON.stringify(failed).includes(config.password), false)
})

test('bulk checks retain individual failures, respect concurrency and hide credentials', async () => {
    const env = accounts(8)
    env.ACCOUNT_2_PROXY_URL = 'socks5://proxy.example.test'
    env.ACCOUNT_2_PROXY_PORT = '1080'
    env.ACCOUNT_2_PROXY_USERNAME = 'private-user'
    env.ACCOUNT_2_PROXY_PASSWORD = 'private-password'
    let active = 0
    let maxActive = 0
    const checker = new AccountIpChecker({
        concurrency: 2,
        probe: async proxy => {
            active++
            maxActive = Math.max(maxActive, active)
            await new Promise(resolve => setTimeout(resolve, 5))
            active--
            if (proxy.url) throw new Error(`socks5://${proxy.username}:${proxy.password}@proxy.example.test`)
            return { ip: '198.51.100.1', family: 'IPv4', error: null }
        }
    })
    const results = await checker.check(null, env)
    assert.equal(maxActive, 2)
    assert.deepEqual(
        results.map(result => result.accountIndex),
        [1, 2, 3, 4, 5, 6, 7, 8]
    )
    assert.equal(results[1].route, 'proxy')
    assert.equal(results[1].ip, null)
    assert.equal(results[0].route, 'direct')
    assert.equal(JSON.stringify(results).includes('private-'), false)
    assert.deepEqual(checker.get(1, env), results[0])
    env.ACCOUNT_1_PROXY_URL = 'http://different-proxy.example.test'
    assert.equal(checker.get(1, env), null)
})

test('simultaneous checks are coalesced but the next explicit check refreshes the IP', async () => {
    let calls = 0
    const checker = new AccountIpChecker({
        probe: async () => {
            calls++
            await new Promise(resolve => setTimeout(resolve, 5))
            return { ip: '198.51.100.1', family: 'IPv4', error: null }
        }
    })
    const env = accounts()
    await Promise.all([checker.check([1, 1], env), checker.check([1], env)])
    assert.equal(calls, 1)
    await checker.check([1], env)
    assert.equal(calls, 2)
})

test('invalid selections are rejected before any IP request is sent', async () => {
    let called = false
    const checker = new AccountIpChecker({
        probe: async () => {
            called = true
        }
    })
    for (const indexes of [[], [99], [1.5], ['1'], 'all']) {
        await assert.rejects(checker.check(indexes, accounts()), { code: 'BAD_REQUEST' })
    }
    assert.equal(called, false)
})
