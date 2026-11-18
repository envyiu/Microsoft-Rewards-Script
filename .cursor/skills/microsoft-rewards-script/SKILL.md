---
name: microsoft-rewards-script
description: Guides work on the Microsoft Rewards Worker and its sibling Manager/dashboard, including protocol 3, scheduling, ownership, manual sessions, releases and migration. Also covers bot login, browser sessions, Rewards activities and legacy Control API compatibility.
---

# Microsoft Rewards Script

Use this skill as the project context layer. It is designed so an agent can make a focused change without rediscovering the whole repository. Read `AGENTS.md` first, then choose the reference document that matches the task:

- [ARCHITECTURE.md](ARCHITECTURE.md) for control flow, modules and data contracts.
- [OPERATIONS.md](OPERATIONS.md) for running the bot, Docker, accounts, configuration, API and recovery.
- [DEVELOPMENT.md](DEVELOPMENT.md) for editing, testing, logging contracts and risk controls.
- The existing [user README](../../../README.md) for the public setup/configuration surface.
- The existing [Control API README](../../../scripts/api/README.md) for exact API behavior.
- [Manager architecture](../../../../rewards-dashboard/manager/ARCHITECTURE.md) for service boundaries, account-scoped manual handoff, snapshots and shared contracts; read this before changing Fleet, worker ownership, installers or migration.

## What the project does

Manager owns the complete account configuration, desired settings, assignments and aggregate history. Independent local/VPS workers own only their assigned subset, browser runtime, Smart progress, sessions and durable events. Manager never runs browsers. The bot runtime inside each worker preserves its existing login, activity, search and session contracts. Docker/cron and the protocol 2 coordinator are legacy compatibility paths, not the standalone deployment model.

## Fast orientation

```text
src/index.ts
  -> config + accounts + Logger/SessionStore
  -> Browser/BrowserFunc/ReactFunc + Login
  -> dashboard/bootstrap + Activities
  -> SearchManager -> BrowserSearch or experimental ApiSearch
  -> report/claim actions -> session checkpoint -> cleanup

rewards-dashboard/manager/server.js -> core.js + provisioner.js -> authenticated worker HTTP / SSH tunnel
scripts/worker/server.js -> WorkerAgent -> scripts/api/server.js -> SmartScheduler -> ProcessManager
packages/contracts -> pure schema/protocol/account/store helpers, packaged into Manager without browser imports
scripts/docker/entrypoint.sh / scripts/api/fleet.js -> legacy deployment only
```

Use these entry points to choose the smallest safe change:

| Task                                                                        | Start here                                                                                | Then read                                                                |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Login, OAuth, 2FA, bot warning                                              | `src/browser/auth/Login.ts`                                                               | `ARCHITECTURE.md` auth section; `OPERATIONS.md` login recovery           |
| Cookies, fingerprint, proxy, session                                        | `src/browser/Browser.ts`, `src/util/SessionStore.ts`                                      | `ARCHITECTURE.md` browser/session section                                |
| Dashboard, Rewards page, RSC, server action                                 | `src/browser/BrowserFunc.ts`, `src/browser/ReactFunc.ts`                                  | `ARCHITECTURE.md` Rewards/RSC section                                    |
| Daily Set, offers, punchcards, streaks                                      | `src/functions/activities/`                                                               | `ARCHITECTURE.md` activity section                                       |
| New Outlook/Hotmail accounts, seven-day pre-Rewards mode, first-visit setup | `src/functions/NewAccount.ts`, `src/functions/RewardsOnboarding.ts`                       | `ARCHITECTURE.md` system boundary; `OPERATIONS.md` standalone deployment |
| Search quota or mobile/desktop scheduling                                   | `src/functions/SearchManager.ts`, `SearchProgress.ts`                                     | `ARCHITECTURE.md` search section; `DEVELOPMENT.md` quota invariants      |
| Search query generation                                                     | `src/functions/QueryEngine.ts`, `SearchQueryQueue.ts`                                     | `ARCHITECTURE.md` query section                                          |
| Docker, cron, scheduling                                                    | `scripts/docker/`, `compose.yaml`                                                         | `OPERATIONS.md` execution modes                                          |
| Cloud Sandbox, relay, restart or backup                                     | `scripts/worker/sandbox-cloud/`                                                           | `OPERATIONS.md` Sandbox section and its runbook                          |
| Control API                                                                 | `scripts/api/`                                                                            | `scripts/api/README.md`, then `ARCHITECTURE.md` API section              |
| Log parsing or API status                                                   | `src/logging/Logger.ts`, `scripts/api/logParser.js`                                       | `DEVELOPMENT.md` log contract                                            |
| Config/account/env                                                          | `src/contracts/BotConfig.ts`, `src/util/Load.ts`, `src/interface/`, `config.example.json` | `OPERATIONS.md` precedence and safety                                    |

## Mandatory workflow

1. Run `git status --short` and inspect the relevant existing diff. Preserve all user changes.
2. Read the matching reference section before changing high-risk code.
3. Trace the existing path and reuse its helper, HTTP client, browser context, session checkpoint, logger and error-recovery conventions.
4. Make the smallest source-level patch. Do not edit generated `dist/` files or secrets.
5. Run focused tests first, then build/lint and any contract tests affected by the change.
6. Review `git diff --check`, status and the final diff for accidental assets or credentials.
7. Report what changed, what was verified, and what remains environment-dependent.

## Rules that prevent common regressions

- Configuration has multiple authorities: `Config.ts` types, `Validator.ts` defaults/schema, `config.example.json`, environment overrides and Docker sync. Update all relevant layers when adding a setting.
- Environment account slots are sparse and numeric (`ACCOUNT_N_EMAIL`); the loader sorts slot numbers and validates each account. Never assume accounts are contiguous or expose passwords/tokens in logs/API responses.
- Session reuse is a feature, not a cache to bypass casually. Cookie changes and optional fingerprints are checkpointed through `SessionStore`; preserve the mobile/desktop distinction and account identity.
- New-account mode must branch before Rewards login/bootstrap and point-based search. Preserve its absolute 168-hour deadline and query checkpoints through handoff, restart and midnight. Keep the shared context guard active in manual windows; do not remove it to work around a Microsoft service redirect. See `test:new-account` and the capability gate before importing new accounts onto a worker.
- In new-account warmup, distinguish reserved search attempts from verified completions. Preserve the daily 30 desktop / 20 mobile attempt budgets and `queryCapsReached`; an uncertain result consumes a reservation and is not a login failure. Rewards-account daily caps remain unknown and must not be inferred from warmup limits.
- The current cloud Sandbox uses Docker and a separate SSH gateway through the regular relay VPS, not the systemd installer. Preserve worker identity, persistent data and private gateway keys; never reassign accounts merely because the tunnel is down. The Manager tunnel and the restricted proxy-egress tunnel are separate; keep egress bound to loopback, limit its SSH key to the six configured proxy ports, and keep the Worker startup gate. Read the Sandbox runbook before maintenance.
- Manual Desktop/Mobile/Android locks are per account, even when another account shares the proxy. Only the selected account's active job makes the request wait. Do not move/stop its proxy siblings or wait for the whole worker. Ordinary explicit assignment moves remain group based.
- A running worker may accept membership-only snapshots only when retained account environments/profiles and node settings remain unchanged and removed accounts are held/not running. Use the existing compatibility check; configuration changes still drain as required.
- `MRS_CONFIG_FILE` and `MRS_SKIP_ENV_FILE=1` must also reach manual helpers. A standalone worker must not fall back to a source checkout's `config.json` or account `.env`.
- Android retains its account-bound Damru device/login; these are separate from desktop/mobile browser cookies. Return automatic execution only after device stop, not viewer closure. Failed/unknown checkpoints keep durable holds.
- Manager uses `3012`, dashboard `8890`, worker `3010`, all loopback by default. Account import belongs to Manager; a worker's public account/config writes are intentionally denied.
- Keep earning lock artwork is not a disabled control. Click enabled point cards through the native Rewards control, including YouTube/puzzle and missing-hash cards; verify freshly and retain bounded same-day rediscovery. See `RenderedEarnActions` and the Rewards regression matrix.
- Rendered Earn/Quest verification uses the adapted v5 parsers in `src/browser/parsers/`; preserve unique signed-offer matching, unknown credit, streak expiry and the existing versioned journal contract. Never replace custom Manager/Worker scheduling with upstream Control API.
- Rewards pages are Next.js/RSC-driven. If a selector or server action changes, update the bootstrap/parser/recovery path rather than adding an unrelated one-off request.
- Search counters, search plans, worker caps and “probe on zero quota” behavior are coupled. Read `SearchProgress`, `SearchManager`, `BrowserSearch` and `ApiSearch` together before changing quota logic.
- Browser search and API search do not have the same anti-bot, cookie, action-reporting or quota behavior. Keep experimental API paths opt-in.
- Logger titles and message shapes are machine-consumed. When changing them, inspect `scripts/api/logParser.js` and its tests before committing.
- Assets under `src/functions/*.json` are copied to `dist/functions/` by `scripts/main/copyAssets.js`; build output is not a place to fix source behavior.
- API writes can mutate mounted configuration and schedules. Treat `/config`, `/schedule`, `/start`, `/stop`, `/restart`, `/shutdown` and session deletion as state-changing operations; preserve the auth and opt-in guards.

## Scheduler learning data

Read [collector operations](../../../scripts/learning/README.md) before changing telemetry, experiments, export or training preparation. Keep the training store separate from business events, omit secrets/query text, preserve retry UUIDs and ACK deduplication, and split data by collection time. Unknown daily query caps stay unset and block search-budget trials; collection days alone never authorize AI control.

## Validation baseline

For a normal source change, run:

```bash
npm run build
npm run lint
npm run test:log-parser
npm run test:search-quota
git diff --check
```

For docs-only changes, at minimum check links/paths and `git diff --check`. For login/browser/session changes, add a safe-account smoke test when available; do not claim live Microsoft behavior was verified if only static tests ran. For Docker changes, inspect both the shell scripts and the image/compose contract. For API changes, use the API README and test auth, state transitions and redaction behavior.

## Handoff format

End implementation work with a compact handoff:

```text
Changed: <behavior and files>
Preserved: <important existing user changes or contracts>
Verified: <commands and outcomes>
Risk: <live-account/Docker/API/environment caveats>
Next: <only if a human decision or environment step remains>
```

## Conservative Smart policy

For Smart scheduler/search changes, read the final **Conservative Rewards sessions** section in `ARCHITECTURE.md` and its regression matrix in `DEVELOPMENT.md`. Default Rewards plans are `accountSession`; preserve the rolling start ledger, per-query reservations and holds in the handoff planner. Retry/Urgent/learning cannot replenish them. Legacy quota/Earn-only jobs and zero-quota probes are not part of this default policy. Follow [Smart Mode](../../../docs/SMART_MODE_VI.md) for operator release and paused rollout/rollback.
