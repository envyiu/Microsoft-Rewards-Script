#!/bin/sh
set -eu

# Docker may restart this container before the egress sidecar reconnects after
# a platform restart. Hold the Worker process until all local forwards accept
# connections; Docker's restart policy retries this check if egress is absent.
node --input-type=module <<'JS'
import net from 'node:net'

const ports = [17973, 19702, 22376, 35161, 47915, 55267]
const deadline = Date.now() + 60_000
const probe = port => new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const finish = ready => { socket.destroy(); resolve(ready) }
    socket.setTimeout(800, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
})

while (Date.now() < deadline) {
    const ready = await Promise.all(ports.map(probe))
    if (ready.every(Boolean)) break
    await new Promise(resolve => setTimeout(resolve, 1000))
}
const final = await Promise.all(ports.map(probe))
if (!final.every(Boolean)) {
    console.error('Proxy egress is unavailable; deferring Worker startup.')
    process.exit(1)
}
JS

exec /usr/local/bin/docker-entrypoint.sh "$@"
