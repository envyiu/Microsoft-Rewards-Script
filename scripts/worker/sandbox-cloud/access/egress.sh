#!/bin/sh
set -u

# Carry only the configured upstream proxy TCP endpoints over the authenticated
# relay SSH connection. The matching authorized key is restricted with
# permitopen entries for these exact destinations and has no shell access.
while :; do
    /usr/bin/ssh -F /dev/null -N -T \
        -o BatchMode=yes \
        -o IdentitiesOnly=yes \
        -o StrictHostKeyChecking=yes \
        -o UserKnownHostsFile=/state/known_hosts \
        -o ExitOnForwardFailure=yes \
        -o ConnectTimeout=15 \
        -o ServerAliveInterval=15 \
        -o ServerAliveCountMax=3 \
        -i /state/egress_ed25519 \
        -L 127.0.0.1:17973:proxysupper.ddns.net:17973 \
        -L 127.0.0.1:19702:proxysupper.ddns.net:19702 \
        -L 127.0.0.1:22376:proxysupper.ddns.net:22376 \
        -L 127.0.0.1:35161:proxysupper.ddns.net:35161 \
        -L 127.0.0.1:47915:proxysupper.ddns.net:47915 \
        -L 127.0.0.1:55267:proxysupper.ddns.net:55267 \
        azureuser@172.197.219.56
    sleep 5
done
