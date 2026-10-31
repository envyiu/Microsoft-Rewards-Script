# Hybrid Smart mode

> **Legacy protocol 2 reference.** New installations use separate
> [Worker](../worker/README.md) and [Manager](../../../rewards-dashboard/manager/README.md)
> archives. Group-wide manual holds and whole-node drain described below are old
> coordinator behavior, not the protocol 3 manual-open contract. Standalone manual
> actions hold only the selected account, even when others share its proxy; see
> [current technical contracts](../../../rewards-dashboard/manager/ARCHITECTURE.md).

The home Control API owns account configuration and combines two independent Smart schedulers. Accounts with a proxy run on the VPS (two automatic jobs maximum); direct accounts run at home (one maximum). Android and visible manual browsers stay at home. Urgent mode cannot bypass these limits. Disable cron; hybrid launches use Smart mode only.

## Services and state

- VPS: Node 24+, the same compiled runtime and locked Patchright package as home, bundled headless Chromium, and a systemd service with `User=tool`, `KillMode=control-group`, `Restart=on-failure`. The deployed runtime is `/home/tool/msrw/current`; working directory and persistent state are `/home/tool/.local/share/msrw`.
- VPS environment: `MRS_NODE_ROLE=vps`, `MRS_NODE_DATA=/home/tool/.local/share/msrw/hybrid`, `SMART_SCHEDULE_FILE=/home/tool/.local/share/msrw/smart-schedule.json`, `API_HOST=127.0.0.1`, `API_PORT=3010`, and a private `API_TOKEN`. Do not configure a second cron runner or an autonomous scheduler at home for proxied accounts.
- Home environment: `MRS_NODE_ROLE=local`, `MRS_REMOTE_URL=http://127.0.0.1:3011`, and private `MRS_REMOTE_TOKEN`. A separate user systemd service forwards `127.0.0.1:3011` to VPS `127.0.0.1:3010` over SSH using the existing default key and pinned host key.
- Home hybrid state defaults to `config/hybrid/node.sqlite`. VPS sessions, scheduler progress, holds, configuration revisions, and event cursors persist independently of the home connection. Keep state directories private and exclude them from Git and runtime artifacts.
- VPS materialization resolves `sessionPath` to an absolute path in the API service working directory. Workers start in the release directory, so a relative path would make them read a different session database from the migration and handoff APIs.

## Behavior

The VPS stores the latest accepted subset of account credentials and configuration, so its scheduler keeps running when home is offline. Configuration is sent as an authenticated snapshot with a persistent coordinator identity and increasing generation; old generations cannot replace newer ones. New configuration pauses new VPS jobs and waits for current jobs to finish before activation. Offline home changes remain pending.

Opening a proxied account's manual browser first reserves its VPS network group, asks the running bot to checkpoint using SIGUSR1, and verifies both the checkpoint marker and process exit. The current account's desktop/mobile session and region are transferred transactionally. VPS resumes that group only after all manual windows close and session return is acknowledged. A failed checkpoint never counts as a successful handoff. Persisted holds have no automatic expiry. Use **Return session to VPS** after closing windows if an interrupted home session needs recovery. If the initial checkpoint failed, returning retains the VPS's own saved session instead of overwriting it with an old home copy.

Account edits/deletion use the same ownership hold. Direct-to-proxy and proxy-to-direct moves carry per-account scheduler progress and sessions before releasing ownership. Session deletion is performed on the owning node and the home cache. There is no automatic failover from VPS to home.

VPS event identities survive restarts. Home receives events into a durable inbox; dashboard source-event markers and point history are committed together, so replay does not double count. Older results can fill history without replacing newer account status. Important results retain 90 days; raw events retain up to 7 days and are capped at 128 MiB / 50,000 rows. The UI keeps its existing bounded log buffers.

## Internal API

All endpoints require the normal Control API token. VPS APIs bind only to loopback and are reached through SSH. These endpoints must never be forwarded to the public dashboard:

- `GET /internal/hybrid/status`, `GET /internal/hybrid/events?afterId=N`
- `PUT /internal/hybrid/snapshot`: subset account environment, validated bot/scheduler configuration, revision, generation, coordinator identity; initial per-account sessions/progress only for newly owned accounts.
- `PUT /internal/hybrid/stage-session/:uuid`: private per-account session staging before ownership activation. Node transport uses gzip for large payloads, with a bounded expanded body; normal configuration edits do not resend sessions. Staged files are removed after activation and remain available if activation must recover after a crash.
- `POST /internal/hybrid/control`: fixed Smart control routes, no arbitrary commands or environment overrides.
- `POST /internal/hybrid/accounts/:index/hold|release|delete-session`: token-bound persistent handoff; releases are idempotent.
- `POST /internal/hybrid/probe`: proxy egress check without running Microsoft account activities.

Home exposes redacted node metadata on existing account/Smart APIs, durable redacted log replay at `GET /hybrid/events`, and `POST /hybrid/accounts/:index/resume` for returning a manual hold. Credentials and raw session contents never appear in dashboard responses.

## Rollout and rollback

Build into a separate staging directory while live jobs exist. Drain home jobs without interrupting them, close manual sessions, stop the home API, replace the compiled runtime, configure hybrid environment and SSH service, then start home. Initially leave both schedulers disabled while the first snapshot, session migration, and proxy probes complete. Restore scheduling only after confirming home owns direct accounts exclusively and VPS owns proxy accounts exclusively. Start with one VPS job, inspect resource usage and the initial scheduled job, then use the hard limit of two. Do not create extra account runs just for benchmarks.

For rollback, disable scheduling on both nodes, wait for jobs to finish, and hand back the latest VPS sessions/progress before removing the home hybrid environment. Never re-enable the original all-local scheduler while VPS still owns running accounts.

Run `node --test scripts/api/hybrid.test.js scripts/api/hybridApi.test.js`, scheduler/log/session tests, TypeScript/lint checks, dashboard tests/UI mocks, and `git diff --check`. The hybrid API fixtures use fake bot processes and synthetic sessions only.

## Fleet dashboard (protocol 2)

Set `MRS_FLEET_ENABLED=1` on the **local** Control API to use the fleet coordinator. VPS agents keep `MRS_NODE_ROLE=vps`. Upgrade the existing VPS API before enabling the coordinator; an older agent is reported as `UPGRADE_REQUIRED`, never given a new assignment. The first start imports the existing node ID, ownership, event cursor, settings and 1-local/2-VPS limits into the private hybrid SQLite store. Keep the old remote environment for migration/rollback; registered machines subsequently use the registry.

**Settings → Machines** provides shared bot/scheduler defaults, per-machine overrides, inheritance/reset controls, independent scheduler enable/capacity, resource samples and operation status. Managed fields are session location, clustering and VPS headless mode. Configuration writes drain active jobs before application. `Saved`/`pending` is not an acknowledgement; the machine must accept the corresponding revision. Offline machines retain their last accepted schedule.

**Run on…** in Smart account actions/detail or the multi-select toolbar previews every account affected by a proxy-group move. Direct accounts remain Local. New accounts use the existing proxy group's owner, otherwise Local. Default moves reserve the group and wait for its current job; **Move now** verifies a checkpoint before proceeding. The durable operation prepares current sessions/progress, revokes the source snapshot, activates the destination, and only then releases source holds. Source loss never permits a move from cached data. Transfers can be retried; a transfer still in its holding phase can be cancelled while its source is reachable. Account/proxy edits are blocked during assignment changes.

**Add VPS** supports Ubuntu 24.04 x86_64 with existing local SSH keys and passwordless sudo. It first shows an ED25519 host fingerprint for explicit verification, pins that key in a private known-hosts file, then uploads a release containing code and lockfiles only. It installs Node 24.22.1 with checksum verification, locked dependencies and Chromium, checks a blank browser page, installs the worker service and a dedicated local SSH tunnel, and registers the new node paused with capacity one and no accounts. It never creates a cloud VM, copies the local `.env`/session DB in the code archive, opens a public API port, or changes swap/RAM limits. Keys and tokens stay server-side. Failed steps expose an error code and are retryable; after an API restart retry an interrupted install from Operations. Removing an empty connection stops its tunnel, not the VPS; retained raw event journals remain private and bounded.

Public Control API routes (dashboard forwards these with `/api`):

- `GET/POST /nodes`, `GET /nodes/ssh-keys`, `PATCH/DELETE /nodes/:id`.
- `GET/PUT /execution-config/defaults`, `GET/PUT /nodes/:id/config`, `GET /nodes/:id/resources`.
- `POST /fleet-scheduler` with `{enabled}` changes desired scheduler enable state on all registered machines.
- `GET /account-assignments`, `POST /account-assignments/preview`, `POST /account-assignments` with `{accountIndexes,targetNodeId,now}`.
- `GET /node-operations/:id`, `POST /node-operations/:id/retry|trust|cancel`. Install trust requires the displayed fingerprint; assignment cancellation is limited to the holding phase.

Machine configuration bodies are `{bot,schedule}`: complete values for defaults, sparse overrides for individual nodes. Send `{}` to reset a machine to defaults. Public responses mask webhook credentials; sending a redaction marker preserves the previous secret. Account profiles and network-group overrides remain shared. Existing `/config` writes update Local overrides. New writes require the existing configuration/schedule permission gates; no arbitrary shell or arbitrary remote-URL endpoint is exposed.

The UI polls resource/status data only while Machines is visible; agents cache system samples for five seconds. Coordinator sync allows three node requests concurrently, maintains independent per-node generations/cursors, and isolates failed nodes. Raw session bundles for a transfer are stored in a private operation directory and removed after completion/cancellation. The existing journal retention and client 3,000-line log bound remain in effect.

Validation: `node --test scripts/api/fleet.test.js scripts/api/nodeProvisioner.test.js` uses synthetic accounts, fake child workers and injected SSH transports. Dashboard `tests/machines.browser.cjs` exercises inheritance, preserved drafts/focus, SSH enrollment mocks and narrow screens; `tests/smart-mode.browser.cjs` includes machine filtering, bulk group preview/move and the 30/100-account log benchmark.
