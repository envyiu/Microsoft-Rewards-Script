import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { createRequire } from 'node:module'
import test from 'node:test'

import { createBrowserProxyConfig, createProxyRelay } from '../../common/proxyRelay.cjs'

const require = createRequire(import.meta.url)
require('ts-node').register({ transpileOnly: true })
const HttpClient = require('../../src/util/Http.ts').default

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    return server.address().port
}

async function closeServer(server) {
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
}

function startAuthenticatedSocks5Server(expectedUsername, expectedPassword) {
    const sockets = new Set()
    const server = net.createServer(socket => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))

        let buffer = Buffer.alloc(0)
        let stage = 'greeting'
        let targetHost
        let targetPort

        const consume = length => {
            const value = buffer.subarray(0, length)
            buffer = buffer.subarray(length)
            return value
        }

        const processBuffer = () => {
            while (!socket.destroyed) {
                if (stage === 'greeting') {
                    if (buffer.length < 2) return
                    const methodCount = buffer[1]
                    if (buffer.length < methodCount + 2) return
                    consume(methodCount + 2)
                    socket.write(Buffer.from([0x05, 0x02]))
                    stage = 'authentication'
                } else if (stage === 'authentication') {
                    if (buffer.length < 2) return
                    const usernameLength = buffer[1]
                    if (buffer.length < usernameLength + 3) return
                    const passwordLength = buffer[usernameLength + 2]
                    const totalLength = usernameLength + passwordLength + 3
                    if (buffer.length < totalLength) return
                    const request = consume(totalLength)
                    const username = request.subarray(2, 2 + usernameLength).toString('utf8')
                    const password = request.subarray(3 + usernameLength).toString('utf8')
                    if (username !== expectedUsername || password !== expectedPassword) {
                        socket.end(Buffer.from([0x01, 0x01]))
                        return
                    }
                    socket.write(Buffer.from([0x01, 0x00]))
                    stage = 'request'
                } else if (stage === 'request') {
                    if (buffer.length < 4) return
                    const addressType = buffer[3]
                    let addressLength
                    if (addressType === 0x01) addressLength = 4
                    else if (addressType === 0x04) addressLength = 16
                    else if (addressType === 0x03) {
                        if (buffer.length < 5) return
                        addressLength = buffer[4] + 1
                    } else {
                        socket.destroy(new Error('Unsupported SOCKS5 address type'))
                        return
                    }

                    const addressOffset = addressType === 0x03 ? 5 : 4
                    const totalLength = addressOffset + addressLength + 2
                    if (buffer.length < totalLength) return
                    const request = consume(totalLength)
                    const encodedAddress = request.subarray(addressOffset, addressOffset + addressLength)
                    if (addressType === 0x01) targetHost = [...encodedAddress].join('.')
                    else if (addressType === 0x04) targetHost = '::1'
                    else targetHost = encodedAddress.subarray(1).toString('utf8')
                    targetPort = request.readUInt16BE(totalLength - 2)

                    const upstream = net.createConnection({ host: targetHost, port: targetPort })
                    upstream.once('error', error => socket.destroy(error))
                    upstream.once('connect', () => {
                        stage = 'tunneled'
                        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]))
                        socket.pipe(upstream)
                        upstream.pipe(socket)
                    })
                    return
                } else {
                    return
                }
            }
        }

        socket.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk])
            processBuffer()
        })
    })

    return {
        server,
        async listen() {
            return listen(server)
        },
        async close() {
            for (const socket of sockets) socket.destroy()
            await closeServer(server)
        }
    }
}

function startTargetServer() {
    const server = http.createServer((_request, response) => response.end('through-authenticated-socks5'))
    return { server, listen: () => listen(server), close: () => closeServer(server) }
}

function getThroughHttpProxy(proxyUrl, targetPort) {
    const proxy = new URL(proxyUrl)
    return new Promise((resolve, reject) => {
        const request = http.request(
            {
                hostname: proxy.hostname,
                port: Number(proxy.port),
                method: 'GET',
                path: `http://127.0.0.1:${targetPort}/proxy-check`,
                headers: { host: `127.0.0.1:${targetPort}` }
            },
            response => {
                let body = ''
                response.setEncoding('utf8')
                response.on('data', chunk => (body += chunk))
                response.on('end', () => resolve({ status: response.statusCode, body }))
            }
        )
        request.once('error', reject)
        request.end()
    })
}

const accountProxy = port => ({
    proxyHttp: true,
    url: 'socks5://127.0.0.1',
    port,
    username: 'proxy-user@region',
    password: 'proxy:pass%word'
})

test('browser proxy settings use a loopback relay for authenticated SOCKS5 and close it', async () => {
    const socks = startAuthenticatedSocks5Server('proxy-user@region', 'proxy:pass%word')
    const target = startTargetServer()
    const socksPort = await socks.listen()
    const targetPort = await target.listen()
    let lease

    try {
        lease = await createBrowserProxyConfig(accountProxy(socksPort))
        assert.match(lease.proxy.server, /^http:\/\/127\.0\.0\.1:\d+$/)
        assert.equal(lease.proxy.username, undefined)
        assert.equal(lease.proxy.password, undefined)

        const response = await getThroughHttpProxy(lease.proxy.server, targetPort)
        assert.deepEqual(response, { status: 200, body: 'through-authenticated-socks5' })
    } finally {
        await lease?.close()
        await target.close()
        await socks.close()
    }
})

test('HTTP client requests use the authenticated SOCKS5 relay when proxying is enabled', async () => {
    const socks = startAuthenticatedSocks5Server('proxy-user@region', 'proxy:pass%word')
    const target = startTargetServer()
    const socksPort = await socks.listen()
    const targetPort = await target.listen()
    const client = new HttpClient(accountProxy(socksPort))

    try {
        const response = await client.request({ url: `http://127.0.0.1:${targetPort}/http-client-check`, responseType: 'text' })
        assert.equal(response.status, 200)
        assert.equal(response.data, 'through-authenticated-socks5')
    } finally {
        await client.close()
        await target.close()
        await socks.close()
    }
})

test('no relay is allocated for unauthenticated SOCKS5', async () => {
    const relay = await createProxyRelay({
        proxyHttp: true,
        url: 'socks5://proxy.example.test',
        port: 1080,
        username: '',
        password: ''
    })
    assert.equal(relay, null)
})
