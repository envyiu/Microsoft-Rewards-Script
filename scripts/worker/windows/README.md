# Native Windows Workers

The current native Windows deployment runs the same standalone Worker release
as a **remote, headless** executor. It is a separate machine in Manager, with no
manual browser or Android capability. It does not replace the existing Local
worker. The Linux/systemd installer does not apply. After the one-time updater bootstrap, Fleet Update supports Windows through the authenticated Worker API and its independent supervisor.

## Installed layout

Everything is beneath `%LOCALAPPDATA%\MSRWWorker`, inside the user's hidden
AppData folder. No global Node installation or PATH modification is needed.

- `runtime\node-v24.22.2-win-x64`: private Node/npm runtime.
- `browsers`: private Patchright Chromium installation; its path must also be
  passed to Worker children through `PLAYWRIGHT_BROWSERS_PATH`.
- `worker`: extracted standalone release and production dependencies.
- `data`: durable identity/journal, accepted configuration, sessions and Smart state.
- `worker.json`: private machine environment, including the API token.
- `access`: dedicated relay private key and pinned `known_hosts`.
- `logs`: Worker/tunnel logs, each rotated at 10 MiB with three retained copies.
- `run.ps1`, `job-process.ps1`, `supervisor.mjs`, `start.vbs`: user watchdog.

Keep ACL inheritance restricted to the owning user, SYSTEM and administrators.
Never put private keys or `worker.json` in a release, repository or shared folder.
The install bootstrap verifies the Node ZIP against the pinned official SHA256
and the Worker archive against its transfer checksum before extraction.

## Startup and remote access

`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\MSRWWorker` launches
`start.vbs` at **user sign-in**. The named mutex in `run.ps1` prevents duplicates
within that Windows session in the original Windows 10 deployment. The current
source uses an installation-specific global mutex to prevent duplicates across
interactive and batch sessions. This is a user application, not a system service:
it requires that user's session, does not run while Windows is asleep/off, and
starts after sign-in following a reboot. Locking the session leaves it running.

The additional **Windows Server 2016** target uses a Scheduled Task named
`MSRWWorker`, with an AtStartup trigger delayed 30 seconds and S4U batch logon
under `envyiu` at limited privilege. This does not store a Windows password and
does not require an interactive desktop sign-in. Task restart is enabled and
its execution time limit is disabled. Do not add the Windows 10 Run entry to
this server. Its private installation is beneath that user's AppData folder;
`run.ps1` resolves its root from its own location and passes `MSRW_WORKER_HOME`
to descendants, so a different batch-session environment cannot redirect data.

The server initially lacked Visual C++ runtime DLLs required by Impit. Verify
native modules as well as Chromium; installing browser files alone is insufficient.
Use the signed [Microsoft x64 Visual C++ Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170)
when needed. Its shared runtime installs in Windows system locations; all Worker,
Node, browser and private data files remain under AppData. Use `/norestart` during
provisioning and record any installer reboot requirement instead of rebooting
an active server automatically.

The supervisor restarts Worker and SSH independently after five seconds. Nested
Windows Job Objects terminate descendants when a Worker or supervisor generation
exits, preventing old browser/job processes surviving beside a replacement.
Do not replace this with a detached Node launch without descendant cleanup.

Worker binds only `127.0.0.1:3010`. Its dedicated key opens reverse SSH from
Windows to `azureuser@172.197.161.37`, exposing only relay loopback `33410`.
The Manager user's `msrw-windows-tunnel.service` maps local loopback `33120`
to that relay port. The relay key has a forced false command, no interactive
shell, and an exact `permitlisten` restriction. Removing the relay connection
does not pause accepted Smart work; events can synchronize after it reconnects.

The Server 2016 target instead reuses its existing inbound SSH through relay
loopback `2222`. The Manager user's `msrw-windows-server-tunnel.service` forwards
Manager loopback `33130` to target loopback `3010` via ProxyJump. Target host keys
are pinned in `~/.local/share/msrw-target-access/known_hosts`; do not disable host
verification for the persistent connection. Server `transport.json` contains
`{"enabled": false}` to disable the separate reverse tunnel, preventing a clash
with Windows 10's relay port. Optional `transport.command` and `transport.args`
can configure a different dedicated SSH transport for future deployments.

The target currently lacks working SFTP. Bootstrap artifacts can be downloaded
through a temporary loopback HTTP forward inside authenticated SSH, with archive
checksums verified before extraction. Serve only release/install artifacts,
never credentials or Worker data, and remove that temporary forward afterward.

Register the authenticated protocol-3 endpoint in Manager as a remote Worker;
registration starts paused with zero accounts and capacity one. Assign accounts
through Manager only. Do not edit a second account list on Windows.

## Maintenance and verification

Pause and drain through Manager before replacing code, stopping the watchdog or
backing up/restoring databases. Preserve `data` and worker identity. Windows uses
forced process-tree termination for bot stop; Unix `SIGUSR1` checkpoint signalling
is not available. Let running accounts complete before a handoff/maintenance;
never bypass a failed checkpoint or remove its durable hold.

Acceptance checks: native x64 Node, SQLite and Impit load; a real Chromium
headless page opens/closes; unauthenticated API requests are denied; Manager sees
the matching APPLIED revision; the empty Worker retains its identity after
restart; SSH reconnects; duplicate starts do not create a second watchdog; Job
Object cleanup removes synthetic descendants. These do not establish Microsoft
login or account-task completion before an account is assigned and tested.

## Current relay access (2026-11-08)

Relay is now `azureuser@172.197.161.37`. Windows-side startup files and
Manager-side Windows tunnel services use this address. Relay listeners remain
loopback-only; no Worker API or command endpoint is published directly.

Open the Windows 10 command page from the Manager machine:

```sh
ssh -N -L 18080:127.0.0.1:38080 azureuser@172.197.161.37
```

Then visit `http://127.0.0.1:18080/cmd.php`. This endpoint can execute commands;
keep access behind authenticated SSH.

Administrative SSH into Server 2016:

```sh
ssh -i ~/.ssh/target_key -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=~/.local/share/msrw-target-access/known_hosts \
  -o ProxyJump=azureuser@172.197.161.37 -p 2222 envyiu@127.0.0.1
```

The target host key was compared with the existing target through the old relay
before accepting the new route. Windows 10 keeps its original Worker watchdog
and Startup command-tunnel watchdog; temporary migration tasks are not required
once these watchdogs own the new connections. Do not restart an executing Worker
merely to change SSH transport.

On inspection during this relay migration, Server 2016 no longer had the
`MSRWWorker` task or its `worker.json`; its administrative SSH route was migrated
without reinstalling a Worker. The installation description above is historical
for that target, not evidence that its Worker is currently installed.

## Smart state after a crash

A matching snapshot revision alone does not prove scheduling is enabled: compare
`smart.config.enabled` with the Manager's desired `schedule.enabled`. Manager
re-sends the authenticated snapshot on this drift, including when the revision
is unchanged. An intentionally disabled Manager schedule remains disabled.

Smart saves now flush the temporary file before rename and keep a separately
written `smart-schedule.json.last-good`. Corrupt primary state is preserved as
`.corrupt-<timestamp>` and recovered from a valid last-good document. If an
existing worker loses both copies, startup fails instead of silently creating
empty progress. Do not replace the whole runtime with a newer scheduler just to
fix this: retain the operator's current scheduling policy.

Before recovery, back up SQLite with its online backup API (including committed
WAL data), copy the JSON files and preserve worker identity. `PRAGMA quick_check`
checks structural integrity; it cannot establish that a JSON checkpoint survived
a power failure. Never delete the session database or reset event IDs/cursors.

For an already reset Smart document, `scripts/api/recoverSmartState.js` provides
an offline, pure recovery helper. Pass the existing document and ordered durable
journal rows `{ts, payload}`. It restores confirmed worker completions, observed
quotas and query counts for the current account day, retains unfinished search
reservations, and returns a paused document plus counts. It does not emit events
or manufacture points. Preserve the original and inspect the summary before
writing the recovered document while the Worker is stopped. Recovery is limited
to recorded evidence; missing transient state is not an exact historical restore.
Resume through the Manager's accepted desired configuration after verification.

For maintenance, create `%LOCALAPPDATA%\MSRWWorker\maintenance.flag` before
stopping the supervisor; the patched outer `run.ps1` loop waits while the marker
exists. Confirm no Worker process remains before changing its JSON. Remove the
marker after restoring state to let the existing watchdog restart it. Killing
only `supervisor.mjs` without this guard is insufficient: the outer watchdog
starts it again after five seconds and live state can overwrite a recovery.

Relay SSH now uses `ClientAliveInterval 30` / `ClientAliveCountMax 3` for
`azureuser`, so abandoned connections are removed rather than retaining reverse
ports indefinitely after a Windows crash or public-IP change. Identify the exact
stale listener/session before removing it; never kill all relay SSH sessions.

Account membership and new-account lifecycle are separate from daily progress.
Never derive a seven-day lifecycle start from the earliest retained search log:
older events may already have been pruned. Recovery marks a missing lifecycle for
operator review unless an explicit valid startedAt/readyAt pair is available.
Do not restore Manager account lists from worker snapshots as part of a Smart
state repair. Recent user-confirmed deletions and mature-account status remain
authoritative. Verify Manager, worker and the Smart UI roster after recovery.
