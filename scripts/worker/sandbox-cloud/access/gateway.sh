#!/bin/sh
set -eu
/usr/sbin/sshd -D -e &
server=$!
trap 'kill "$server" ${tunnel:-} 2>/dev/null || true; exit 0' TERM INT
while kill -0 "$server" 2>/dev/null; do
 ssh -F /dev/null -N -T -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/state/known_hosts -o ExitOnForwardFailure=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -i /state/relay_ed25519 -R 127.0.0.1:33310:127.0.0.1:3010 -R 127.0.0.1:32222:127.0.0.1:2222 azureuser@172.197.219.56 &
 tunnel=$!
 wait "$tunnel" || true
 sleep 5 & wait $! || true
done
exit 1
