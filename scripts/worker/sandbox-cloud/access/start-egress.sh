#!/bin/sh
set -eu

# Start the small SSH transport before the Worker. It exposes only the six
# configured SOCKS proxy ports on the sandbox host's loopback interface.
docker container inspect msrw-egress >/dev/null 2>&1 \
    && docker start msrw-egress >/dev/null \
    || docker run -d \
        --name msrw-egress \
        --restart always \
        --network host \
        --memory 64m \
        --cpus 0.1 \
        --entrypoint /bin/sh \
        -v /home/agent/msrw/access:/state:ro \
        -v /home/agent/msrw/access-build/egress.sh:/usr/local/bin/egress.sh:ro \
        msrw-sandbox-access:20261104-v2 \
        -c 'exec /usr/local/bin/egress.sh' >/dev/null

# Wait for every local-forward listener before allowing recovery to start the
# account worker. A failed tunnel must keep the worker from entering a retry
# storm against dead localhost proxies.
python3 - <<'PY'
import socket
import sys
import time

ports = (17973, 19702, 22376, 35161, 47915, 55267)
deadline = time.monotonic() + 60
pending = set(ports)
while pending and time.monotonic() < deadline:
    for port in tuple(pending):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                pending.remove(port)
        except OSError:
            pass
    if pending:
        time.sleep(1)
if pending:
    print("Proxy egress tunnel is not ready; worker start deferred.", file=sys.stderr)
    sys.exit(1)
PY
