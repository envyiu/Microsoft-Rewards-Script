---
name: microsoft-rewards-script
description: Guides agents through understanding, modifying, testing, and operating this TypeScript/Patchright Microsoft Rewards automation project. Use when working in this repository, especially around login, browser sessions, Rewards activities, search quotas, Docker/cron, the Control API, or configuration.
---

# Microsoft Rewards Script

Use this skill as the project context layer. It is designed so an agent can make a focused change without rediscovering the whole repository. Read `AGENTS.md` first, then choose the reference document that matches the task:

- [ARCHITECTURE.md](ARCHITECTURE.md) for control flow, modules and data contracts.
- [OPERATIONS.md](OPERATIONS.md) for running the bot, Docker, accounts, configuration, API and recovery.
- [DEVELOPMENT.md](DEVELOPMENT.md) for editing, testing, logging contracts and risk controls.
- The existing [user README](../../../README.md) for the public setup/configuration surface.
- The existing [Control API README](../../../scripts/api/README.md) for exact API behavior.

## What the project does

The bot processes one or more Microsoft accounts. For each account it loads configuration and persisted session state, creates fingerprinted mobile/desktop browser contexts, completes Microsoft authentication, bootstraps Rewards pages and Next server-action metadata, runs configured activities, calculates mobile and desktop search quotas, performs browser or experimental API searches, reports activity/bonus actions, persists cookies/fingerprints/region, and cleans up. A cluster mode can distribute accounts across worker processes. Docker can schedule runs with cron, and the dependency-free Control API can start, stop, inspect and configure a running process.

## Fast orientation

```text
src/index.ts
  -> config + accounts + Logger/SessionStore
  -> Browser/BrowserFunc/ReactFunc + Login
  -> dashboard/bootstrap + Activities
  -> SearchManager -> BrowserSearch or experimental ApiSearch
  -> report/claim actions -> session checkpoint -> cleanup

scripts/docker/entrypoint.sh -> config/env sync -> cron/API -> npm start
scripts/api/server.js       -> ProcessManager -> child run -> parsed logs/state
```
Use these entry points to choose the smallest safe change:

| Task | Start here | Then read |
| --- | --- | --- |
| Login, OAuth, 2FA, bot warning | `src/browser/auth/Login.ts` | `ARCHITECTURE.md` auth section; `OPERATIONS.md` login recovery |
| Cookies, fingerprint, proxy, session | `src/browser/Browser.ts`, `src/util/SessionStore.ts` | `ARCHITECTURE.md` browser/session section |
| Dashboard, Rewards page, RSC, server action | `src/browser/BrowserFunc.ts`, `src/browser/ReactFunc.ts` | `ARCHITECTURE.md` Rewards/RSC section |
| Daily Set, offers, punchcards, streaks | `src/functions/activities/` | `ARCHITECTURE.md` activity section |
| Search quota or mobile/desktop scheduling | `src/functions/SearchManager.ts`, `SearchProgress.ts` | `ARCHITECTURE.md` search section; `DEVELOPMENT.md` quota invariants |
| Search query generation | `src/functions/QueryEngine.ts`, `SearchQueryQueue.ts` | `ARCHITECTURE.md` query section |
| Docker, cron, scheduling | `scripts/docker/`, `compose.yaml` | `OPERATIONS.md` execution modes |
| Control API | `scripts/api/` | `scripts/api/README.md`, then `ARCHITECTURE.md` API section |
| Log parsing or API status | `src/util/Logger.ts`, `scripts/api/logParser.js` | `DEVELOPMENT.md` log contract |
| Config/account/env | `src/config/`, `src/interface/`, `config.example.json` | `OPERATIONS.md` precedence and safety |

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
- Rewards pages are Next.js/RSC-driven. If a selector or server action changes, update the bootstrap/parser/recovery path rather than adding an unrelated one-off request.
- Search counters, search plans, worker caps and “probe on zero quota” behavior are coupled. Read `SearchProgress`, `SearchManager`, `BrowserSearch` and `ApiSearch` together before changing quota logic.
- Browser search and API search do not have the same anti-bot, cookie, action-reporting or quota behavior. Keep experimental API paths opt-in.
- Logger titles and message shapes are machine-consumed. When changing them, inspect `scripts/api/logParser.js` and its tests before committing.
- Assets under `src/functions/*.json` are copied to `dist/functions/` by `scripts/main/copyAssets.js`; build output is not a place to fix source behavior.
- API writes can mutate mounted configuration and schedules. Treat `/config`, `/schedule`, `/start`, `/stop`, `/restart`, `/shutdown` and session deletion as state-changing operations; preserve the auth and opt-in guards.

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
