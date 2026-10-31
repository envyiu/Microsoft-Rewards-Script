# Operations, Configuration and Recovery

This is the operational companion to the architecture document. It explains how to run the project safely without exposing credentials or confusing generated state with source.

## Standalone deployment: start here

New Outlook/Hotmail imports default to a seven-day pre-Rewards phase. Dashboard account forms expose Auto/On/Off and show the deadline, daily query/service counts and authentication attention state. `newAccountMode` is accepted by account import/edit APIs and mapped to `ACCOUNT_N_NEW_ACCOUNT_MODE`. Old accounts are not automatically enrolled. Do not import enabled accounts until all destination workers advertise `preRewardsV1`. Do not test expiry by changing clocks or timestamps on real accounts; use synthetic test clocks. Normal runtime refuses enabled new accounts without an elapsed eligibility time in the worker-generated execution plan.

For OTP, CAPTCHA or unsupported service initialization, use the guarded manual Desktop/Mobile window. It opens Bing and preserves the account's current identity/session. The guard remains active until that window is closed, even if the deadline passes while it is open. Initialization accepts supported Microsoft terms, creates one personal sample text file in OneDrive (`MSRW getting started.txt`) and one To Do task (`MSRW: Explore Microsoft To Do`), reads at most three Inbox messages, and views Calendar around today. It does not send mail, open message links/attachments, invite attendees, or enable subscriptions. Sample creation is remembered in durable `newAccount.artifacts`, while `serviceActions` resets daily; ambiguous UI remains pending rather than claiming completion. Mail bodies and subjects are never written to action logs. A rollback to an older worker requires pausing the affected new accounts first.

New installations use separate Manager and Worker archives. Follow [Worker installation](../../../scripts/worker/README.md) and [Manager installation/migration](../../../../rewards-dashboard/manager/README.md). Source/cron examples below remain development or legacy instructions; do not run the old coordinator beside the new Manager/Worker system.

- Dashboard: `127.0.0.1:8890`; Manager API: `127.0.0.1:3012`; worker API: `127.0.0.1:3010`. Manager and worker have separate tokens; dashboard uses Manager credentials server-side and optional dashboard login. Account/config writes target Manager, not the worker's denied management routes.
- Local user services: `msrw-manager-api`, `msrw-dashboard`, optional `msrw-worker`. VPS uses system service `msrw-worker` under the normal worker user. Inspect active unit WorkingDirectory/EnvironmentFiles to discover actual state locations; an upgraded VPS may retain legacy paths.
- Machine configuration is `manager.env` / `worker.env`; account authority and desired settings live in Manager's private control store. Worker snapshot, sessions, journal, Smart progress and diagnostics live beneath `MRS_WORKER_DATA`.
- Desktop/Mobile/Android opens are account scoped. Wait only for the selected account's Running job. Other accounts, including the same proxy, keep running; do not stop a node or move its proxy group to make a manual open work.
- Browser session/fingerprint/region are preserved during temporary handoff. Damru's account-bound native Android login is separate; stop the device to return ownership. Closing its viewer is insufficient.
- Offline changes stay Pending until the worker acknowledges the desired revision. Workers continue accepted Smart schedules when Manager is offline. Never infer Running from stale logs or cached rosters, or fail over an offline account automatically.

Before an actual upgrade, pause/drain the worker and close/return manual sessions. A binary/service restart is maintenance, unlike an ordinary manual open. Preserve current data privately and verify checkpoint markers before replacing code. Never restore old cookies over newer work as a shortcut rollback.

## 1. Prerequisites and first run

Required:

- Node.js `>=24.0.0` and npm;
- Chromium installed by `npx patchright install chromium` for local browser mode;
- a valid Microsoft Rewards account configuration;
- a writable session directory and, for Docker, writable mounted config/session directories.

Typical local setup:

```bash
npm install
npm run install:browser
cp config.example.json config.json
# create the local environment file from the tracked env template when available
npm run build
npm start
```

The repository’s current worktree may have a deleted `env.example` as an intentional user change. If the template is needed for inspection, use `git show HEAD:env.example` read-only or recover it only when explicitly requested; do not overwrite the user’s deletion automatically. Never paste real secrets into tracked files.

The development entry point is `npm run dev` (equivalent to the TypeScript entry with `-dev`). `npm run ts-start` runs the source entry without that flag. Use a dedicated test account and review the effective configuration before either command.

## 2. Configuration precedence

Standalone Worker uses an explicit `MRS_CONFIG_FILE` and `MRS_SKIP_ENV_FILE=1`; both runtime and manual helper loaders honor these. The following source/Docker/API modes have different precedence and must not be confused with standalone paths.

### Local source/runtime

`src/util/Load.ts` searches likely root/dist/src locations for configuration. A local `config.json` is normally copied from `config.example.json` and is ignored by git. Environment values win over `.env`; the loader also supports account values from the process environment.

The public template and runtime validator can have different defaults. For every behavior, inspect both `config.example.json` and `src/util/Validator.ts`; do not infer the effective value from one file alone.

### Docker

The image mounts a config directory and a sessions directory. The entrypoint can generate config from the example, synchronize new keys and apply `CONFIG_*` overrides. Docker forces `headless=true`. `CONFIG_AUTO_SYNC=true` can write missing keys atomically and create a backup. Review mounted-file diffs after upgrades; backups may contain secrets.

The compose defaults use a timezone and cron schedule that can differ from local settings. The container runtime sets `FORCE_HEADLESS=1`, `TZ=UTC` in the image environment and `PLAYWRIGHT_BROWSERS_PATH=0`; compose can override timezone/schedule behavior.

### Control API

The API can read and, when explicitly enabled/authenticated, write effective config and schedule files. API mutations are persistent state changes. Before using them, read the exact endpoint and opt-in rules in `scripts/api/README.md`.

An enabled Smart Scheduler has no default run window (`windows: []`). Keep the API running to start the new day's
eligible work at the next 30-second planning tick after midnight in each profile's timezone. Explicit windows,
quiet hours and account/network locks still apply. This daily rollover also works when the API runs directly,
without Docker or cron.

## 3. Account environment contract

Account slots use numeric prefixes and need not be contiguous:

```text
ACCOUNT_N_EMAIL       required
ACCOUNT_N_PASSWORD    optional/flow-dependent
ACCOUNT_N_TOTP        optional
ACCOUNT_N_RECOVERY    optional
ACCOUNT_N_GEO_LOCALE  optional country code or auto
ACCOUNT_N_LANG_CODE   optional language
ACCOUNT_N_PROXY       optional
ACCOUNT_N_SAVE_FINGERPRINT_MOBILE   optional boolean
ACCOUNT_N_SAVE_FINGERPRINT_DESKTOP  optional boolean
```

The repository also supports a global API token for the Control API. Exact variable names and examples are in the tracked template/README; do not duplicate actual values in docs or logs.

The loader sorts account indexes numerically, validates each account with Zod and creates an account-scoped proxy/HTTP context. A missing optional auth method may be valid if the selected Microsoft login flow can prompt or reuse a session; a malformed account is rejected. Never assume `ACCOUNT_1_*` is the only account.

## 4. Common commands

```bash
npm run build             # clean dist, compile TypeScript, copy JSON assets
npm start                 # execute built dist/index.js
npm run ts-start          # execute src/index.ts through ts-node
npm run dev               # source run with -dev
npm run api               # start the dependency-free Control API
npm run manual-login     # helper for an interactive login/session flow
npm run open-session     # open an existing session for inspection
npm run clear-diagnostics
npm run clear-sessions
```

The manual-login/open-session helpers are interactive and browser-dependent; they are not substitutes for a headless Docker health check. Session clearing is destructive to persisted login state and must be limited to the intended session directory/account.

## 5. Docker and cron modes

The container entrypoint supports scheduler and API-oriented modes. The normal scheduler path is:

```text
compose -> entrypoint.sh
        -> config/env preparation
        -> cron installation
        -> run_daily.sh at schedule
        -> npm start
```

`run_daily.sh` uses a lock file, detects stale/stuck runs, applies configured minimum/maximum random sleep and traps cleanup. If it calls the Control API instead of `npm start`, the API process owns the child run state.

When diagnosing Docker:

1. Check the mounted config is readable and matches the expected schema.
2. Check the account count reported by the entrypoint without printing values.
3. Check timezone and cron schedule; a correct cron expression can still run at an unexpected local hour.
4. Check the healthcheck mode: cron health and API health are different.
5. Check the session mount is persistent; a recreated container without it will require login again.
6. Check Chromium/system libraries and `FORCE_HEADLESS` before changing bot logic.

Do not edit files inside the built image to repair a source bug. Patch the repository, rebuild and verify the resulting image/compose contract.

## 6. Control API safety

The API uses `API_TOKEN` and accepts Bearer or `X-API-Key` authentication according to its README. `/health` may be intentionally accessible for a healthcheck; do not assume every endpoint is public. `/events` has its own token-query behavior documented in the API README.

Read-only operational endpoints include status, points, logs, errors, history, accounts, sessions, diagnostics and config views. State-changing endpoints include:

- process start/stop/restart/shutdown;
- config sync and config writes;
- schedule writes;
- session deletion.

Use the API’s redacted account/status endpoints rather than inspecting `.env`, `config.json`, SQLite rows, cookies or fingerprint files. If an endpoint exposes a credential, treat it as a bug and fix the redaction boundary before using it operationally.

`ProcessManager` keeps a bounded memory log buffer and run history, tracks `idle/start/running/stopping`, and parses the child’s logger output. When API state is wrong, inspect the raw structured log envelope and `scripts/api/logParser.js` before changing process logic.

## 7. Authentication and manual recovery

Use the login state machine and its diagnostics rather than repeatedly deleting sessions:

1. Inspect the account-specific log/diagnostic without exposing credentials.
2. Confirm the proxy, locale and user-agent path are stable.
3. Try the interactive manual-login helper when a human challenge is required.
4. Check whether the session was checkpointed after login.
5. Only delete the targeted account/platform session if the stored state is demonstrably stale/corrupt.
6. Retry once and inspect whether the failure is Microsoft-side, proxy-side, browser-side or parser-side.

Passwordless approval has a bounded wait and retry. TOTP is generated through OTPAuth when configured. Email/recovery code paths may require interactive input. A non-empty Microsoft error alert is a real failure; an empty postback alert may be a successful session transition and is handled specially by the login code.

Rewards sign-in, Bing sign-in and mobile app authorization are separate checks. If a signed-in Rewards
session receives a Flyout response without account data, dashboard loading verifies the existing Bing
session once per account/platform/day in that bot process, checkpoints cookies and restores Rewards
actions before reading Flyout again. A missing/invalid balance remains unavailable; it is never replaced
with zero. This recovery needs an active browser and does not replace an explicitly supplied cookie jar.
Checkpoint/Stop during login is an interruption, not an email/password failure; the handoff owns the exit
result and normal failed-session logging must not overwrite it.

If Rewards lands on `about:blank` during OAuth, check that the browser host-resolver workaround is present before changing redirect handling. If the account reaches a bot-warning profile, respect `contintueOnBotWarning`; continuing is an explicit risk choice and should remain visible in logs/config.

## 8. Sessions, diagnostics and cleanup

The session database stores mobile/desktop records keyed by account email and platform. It may contain cookies, storage state, fingerprints and region metadata. Treat it as credential-equivalent:

- keep it under the configured ignored sessions path;
- do not copy it into bug reports;
- do not commit or print it;
- back it up only through a controlled secret-safe process.

Diagnostics can include screenshots, HTML and URLs from unknown/error pages. The API intentionally serves only safe `error-*` files. Clear diagnostics only after confirming the target directory; do not use broad recursive deletion against the workspace.

On normal shutdown, the bot aborts Edge background work, closes desktop/mobile browsers, checkpoints sessions, flushes webhooks and exits. A process killed at the wrong time may leave a stale lock or partial session; the next run has stale-lock/recovery paths, but inspect before deleting.

## 9. Search operations

Normal browser search is the default safety/reference path. Experimental API search is opt-in and has different cookies, anti-bot behavior, action reporting and caps. If search points are zero or the dashboard counter is temporarily unavailable, the current implementation can make at most three bounded probe searches when `runOnZeroPoints` is enabled, then stops unless a positive quota is observed.

Search quotas are read from mobile/desktop dashboard state, with current `/earn` RSC enrichment. If counters are absent/malformed, logs should say unavailable; do not “fix” this by assigning a large default. A quota of zero and an unavailable quota are operationally different even though both can produce no normal work.

For query failures, check in this order:

1. effective locale/language and query-engine config;
2. local `search-queries.json` availability in both source and built asset paths;
3. external source failures (Google/Wikipedia/Bing/RSS) and proxy routing;
4. cluster deduplication/stagnation logs;
5. quota/worker scheduling and report-action acknowledgments.

Do not replace the large local query asset with a tiny fixture in the working tree. Use a unit-test fixture or a mocked source instead.

## 10. Troubleshooting matrix

### Idle manual account is waiting behind other jobs

Inspect the selected account's fresh execution state and operation members, without exposing account secrets. A new manual operation should contain only that index with `scope: account`. A null network-group lock is intentional. Sibling proxy accounts are not blockers. Check both source and local worker support for membership-only snapshot activation; old code can wait on `scheduler.running.size` for the whole node. Do not work around this by stopping unrelated jobs. A real bot/config/profile change can still legitimately require drain.

### Services exit cleanly without listening, or ignore configuration

Check service status, socket listeners and sanitized journal diagnostics. Manager must resolve its `current` symlink when detecting the executable entrypoint. The systemd unit must load the actual absolute EnvironmentFile path; a successful unit-verification exit code alone does not rule out warnings. Do not print token files to diagnose this.

### Build fails after a clean install

Confirm Node 24+, run `npm install`, install Chromium with `npm run install:browser`, then run `npm run build`. Check TypeScript errors in `src/`; do not patch `dist/`. If the failure concerns copied JSON, inspect `scripts/main/copyAssets.js` and the source asset paths.

### API reports no current run

Check API auth, child process state, `ProcessManager` logs and the logger envelope. Confirm whether the child command selected `dist/index.js` or the ts-node fallback. The API may be healthy while the bot is idle.

### API shows wrong points/status

Inspect `scripts/api/logParser.js` against the actual log titles/messages. Do not change parser regexes or logger strings independently. Add/adjust parser tests with redacted representative messages.

### Login loops or redirects

Inspect Login state transitions, same-state refresh counts, diagnostics, host-resolver workaround, proxy and session freshness. Avoid increasing the iteration cap blindly; loops often mean an unrecognized page state or stale cookies.

### Search runs too long or reports no progress

Check counter availability, `SearchProgress`, `SearchManager`, worker caps, stagnant limits, `runOnZeroPoints`, report acknowledgments and dashboard refreshes. The bounded zero-quota probe must remain bounded.

### Docker runs at the wrong time

Check `TZ`, compose environment, cron expression and `run_daily.sh` random delay. Verify whether the run is direct cron or API-triggered. Do not infer container UTC behavior from a local shell timezone.

### Repeated login after container restart

Check that the sessions mount is persistent, the configured session path is the mounted path, fingerprint-saving policy is intentional and no cleanup command removed the database.

### Bot warning or suspicious-account behavior

Treat it as an account/platform risk, not a normal selector bug. Preserve the warning, verify proxy/fingerprint/session consistency and require explicit configuration before continuing.

## 11. Safe operational reporting

An operational report should include timestamps, account index or redacted identity, platform, mode, exit state, point deltas, error titles and validation commands. It should not include passwords, tokens, raw cookies, full storage state, fingerprints, recovery codes, session DB content or unredacted config.

## 12. Missing quest cards / Keep earning / streak

Inspect `MORE-PROMOTIONS` card-status and `PUNCHCARD` quest-step reasons before retrying. `locked-prerequisite`, `waiting-day-or-search`, `requires-app` and `manual-claim` are deferred conditions, not successful completion or permission to force reports. A seven-day search task is satisfied by genuine daily search progress; normal worker schedules revisit quests on subsequent days. A positive HTTP acknowledgment or point balance alone does not prove a specific child complete. Missing parent/child/page data leaves the worker pending.

Dashboard Daily streak is separate from protection and partner streaks. Zero means a confirmed zero; “chưa đọc được” means unknown; “dữ liệu cũ” means the last successful observation is unavailable/stale (24-hour display limit). New values arrive after the worker reads authenticated Rewards pages and the durable event is synchronized. Do not replace unknown with zero, clear sessions or toggle protection merely to refresh the displayed count. Store raw diagnostic payloads only in private directories with mode 0700/0600 and never attach them to Git or logs.

### Manual browser reports Missing X server / $DISPLAY

A systemd user worker can start before the graphical session and discover only a Wayland socket. Chromium must then launch with `--ozone-platform=wayland`; setting WAYLAND_DISPLAY alone does not select its backend. `scripts/main/browserDisplay.js` selects X11 when DISPLAY exists, otherwise Wayland when WAYLAND_DISPLAY exists. Test a headed browser with DISPLAY removed to reproduce this service environment. Do not change account cookies or clear sessions to repair a display failure.
