#!/bin/sh
set -eu

cd /home/agent/msrw
/home/agent/msrw/start-egress.sh

if docker container inspect msrw-worker >/dev/null 2>&1; then
    docker start msrw-worker >/dev/null
else
    docker run -d \
        --name msrw-worker \
        --restart always \
        --network host \
        --shm-size 256m \
        --memory 2800m \
        --cpus 2 \
        --stop-timeout 60 \
        --log-opt max-size=10m \
        --log-opt max-file=3 \
        --add-host proxysupper.ddns.net:127.0.0.1 \
        --entrypoint /usr/local/bin/wait-worker-egress.sh \
        --env-file data/worker.env \
        -v /home/agent/msrw/data:/data \
        -v /home/agent/msrw/access/wait-worker-egress.sh:/usr/local/bin/wait-worker-egress.sh:ro \
        msrw-worker:current \
        node scripts/worker/server.js >/dev/null
fi
