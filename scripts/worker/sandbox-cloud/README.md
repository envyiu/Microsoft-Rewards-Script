# Docker cloud sandbox worker

This deployment runs the independent worker release inside a Node 24 Bookworm container because the sandbox has no systemd and its host Node is 22. Host `systemd` installers/provisioning upgrades do not apply.

Current remote: `sbx_001m6k1azq6xsbkzggx3qw8bd30@sbx_cloud`.

- Image: `msrw-worker:current`; code/build context: `/home/agent/msrw`.
- Private durable data: `/home/agent/msrw/data`, mounted at `/data`. Never delete/recreate this folder to repair an offline worker.
- Container: `msrw-worker`, `--restart always`, host networking, API loopback 3010, shm256MiB, memory2800MiB/2CPU limits. New workers initially start paused with capacity1; current concurrency is managed by Manager.
- Manager host user units: `msrw-sandbox-tunnel`, `msrw-sandbox-recover.timer` (60s), `msrw-sandbox-backup.timer` (30min).
- Recovery/backup scripts: `~/.local/lib/msrw-sandbox/`; private backups: `~/.local/state/msrw-rewards-fix/sandbox-backups/`, retained7days. SQLite backups use the online backup API, not raw live database copies. Backups contain credentials/session material and must remain private.

At daily platform restart, allow offline time, retain the original worker identity/data, reconnect the SSH tunnel and start the existing container. A job killed by the platform is interrupted, not successful; worker scheduler and telemetry recovery reconcile it after restart. Account ownership remains with this worker. Never automatically reassign offline accounts to another machine.

Docker restart policy works when its daemon returns; the Manager-side recovery timer is an additional path if the worker container did not start. This timer requires the Manager host to be running, its user systemd active, and the gateway and relay to provide sandbox SSH. Platform suspension/restart is not zero downtime. The provider's scheduled 24-hour restart has not yet been verified end to end; the checks below do not establish recovery in every case. No software in the worker can guarantee recovery from a deleted sandbox or unavailable cloud control plane. Restore private backup only while all copies of that worker are stopped, retaining its journal identity and session/planner state.

Use Docker stop/start/restart only when paused and drained (or explicitly testing with zero accounts). For upgrade, drain through Manager, make a consistent backup, rebuild the image from the independent release and replace the container while reusing the same data mount/env. Do not use the systemd upgrade button.

References: https://docs.docker.com/ai/sandboxes/cloud/usage/ and https://docs.docker.com/ai/sandboxes/usage/ . Files/images persist across stop/restart while the sandbox exists; deletion is different.

## Permanent access through the regular relay VPS

Relay: `azureuser@172.197.219.56`. This replaces the Docker-cloud CLI/certificate path for normal operation and does not use VPS 1. The sandbox runs `msrw-access` independently of `msrw-worker`, with `--restart always` and persistent keys in `/home/agent/msrw/access`. It reconnects outbound SSH every five seconds after a broken connection.

Two reverse forwards are restricted to relay loopback: `127.0.0.1:33310` -> worker API3010; `127.0.0.1:32222` -> maintenance SSH2222. The relay authorized key uses `restrict`, explicit `permitlisten` entries and a forced false command, so the tunnel key cannot run a shell on the relay. It is separate from the administrator's existing SSH key. No firewall/public listener changes are required.

On the Manager machine, `ssh msrw-sandbox` opens the maintenance environment through `msrw-relay` using the administrator key and a pinned host key. The maintenance container mounts `/home/agent` and the Docker socket to manage the Worker; this is administrative access. `msrw-sandbox-tunnel.service` maps local33110 through the relay to33310, preserving the Manager's worker URL/token/identity. Recovery and backup scripts use `~/.local/lib/msrw-sandbox/ssh.sh`. They do not require `sbx login` or an unexpired Docker SSH certificate. Private backups now include both consistent Worker databases and the gateway keys.

`access/` contains the reproducible gateway build files. Supply the administrator public key as `admin.pub` in a private build context; do not add private keys or Worker data to an image. The active gateway image is `msrw-sandbox-access:20261104-v2`. Its start script is `/home/agent/msrw/start-access.sh`.

The sandbox filesystem and Docker state must survive the platform restart; deletion still requires restoring private backups. The relay VPS must be available. Keep Docker certificate access as an optional break-glass route; normal traffic uses long-lived SSH keys, which can be revoked rather than renewed daily.

## Proxy egress recovery

Some direct Sandbox-to-proxy TCP connections reached the proxy host but stalled
before completing the SOCKS5 greeting. The same endpoints completed through the
relay VPS. `access/egress.sh` carries only the six configured proxy ports through
a separate SSH key restricted on the relay with `permitopen`; the key has no
shell or remote-listen access. Local forwards bind to `127.0.0.1` and use the
existing proxy credentials unchanged. The Worker resolves
`proxysupper.ddns.net` to loopback inside its container, while the relay resolves
and connects to the actual proxy endpoints.

`access/start-egress.sh` starts the tunnel container and waits for all six
loopback listeners before starting/recovering `msrw-worker`. `start.sh` is the
recovery entry point and runs the egress check before starting the Worker. The
Worker container also uses `access/wait-worker-egress.sh` as its entrypoint
wrapper, so Docker's automatic restart waits for the tunnel after a platform
restart even if Docker starts the Worker container first. If the relay is
unavailable, startup is deferred and Docker/Manager recovery retries it rather
than sending accounts into a local-proxy retry loop. Do not remove
`msrw-access`: it still provides the independent Manager-to-Worker maintenance
tunnel. Do not put the egress private key in the Worker data directory, release
archives or Git.

The installed host files are sourced from this directory: `start.sh` becomes
`/home/agent/msrw/start.sh`, `access/start-egress.sh` becomes
`/home/agent/msrw/start-egress.sh`, `access/egress.sh` becomes
`/home/agent/msrw/access-build/egress.sh`, and
`access/wait-worker-egress.sh` becomes
`/home/agent/msrw/access/wait-worker-egress.sh`. Keep the private keys and
pinned `known_hosts` only in `/home/agent/msrw/access` with directory mode 700.

After replacement, the previous Worker container may be kept stopped as a
rollback copy with restart policy `no`. Do not start it while the replacement
uses the same `/data` directory. To roll back, pause and drain the replacement,
stop it, then restore the old container name and restart policy before starting
it.

Validation performed: administrator SSH through the relay; tunnel key shell denied; reverse ports bound only to loopback; reverse SSH deliberately terminated and automatically reconnected; original Worker container continued running; Worker API preserved its identity; consistent backup restored and SQLite integrity checked.

On 2026-11-05, direct Sandbox SOCKS5 greeting timeouts were reproduced on
proxy port 47915 while the VPS path remained healthy. The restricted egress key
was denied an unlisted destination; all six proxy ports then completed
unauthenticated read-only Earn requests through the Worker `proxy-chain`/`Impit`
path. The Worker container was replaced only after a consistent backup and
scheduler drain; its account roster, identity, two-thread setting and APPLIED
state were preserved. A controlled Worker restart with the egress sidecar
restarted restored the same Worker identity and APPLIED state.
