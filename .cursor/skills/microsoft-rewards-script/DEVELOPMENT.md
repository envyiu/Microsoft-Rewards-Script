# Development, Change Recipes and Verification

Use this document when implementing or reviewing a change. It records the contracts most likely to break silently.

## 1. Repository conventions

- TypeScript runtime code lives in `src/`; JavaScript operational scripts live in `scripts/`.
- Output is CommonJS compiled to `dist/`; never hand-edit generated output.
- Formatting uses Prettier: no semicolons, single quotes, four-space indentation, 120-column width and no trailing commas.
- ESLint checks TypeScript and ignores generated/operational state directories such as `dist`, `sessions` and diagnostics.
- The compiler is strict and rejects unused locals. Prefer existing project types and narrow guards over `any`.
- Use the existing `Http`, `Logger`, `SessionStore`, `BrowserFunc`, `ReactFunc`, `Utils` and activity helpers instead of duplicating infrastructure.
- Keep error messages useful but redacted. An account email may be represented through the project’s existing logger identity; credentials and session material must never be logged.

## 2. Baseline verification

For a normal source change:

```bash
npm run build
npm run lint
npm run test:log-parser
npm run test:search-quota
git diff --check
```

The quota test imports `dist/browser/ReactFunc.js`, so it must run after a successful build. If build and tests are launched in parallel, a test can fail with `MODULE_NOT_FOUND` before `dist/` exists; rerun sequentially before diagnosing code. A live Microsoft smoke run is separate from these deterministic checks and must be reported as environment-dependent.

For a docs-only change, verify paths and links, line/format sanity and `git diff --check`. For shell/Docker changes, run shell syntax checks where available and inspect the image/compose files together. For API changes, exercise redacted read-only behavior and state-changing auth/guard paths with a test environment.

## 3. Change recipe: configuration field

When adding or changing a configuration field, trace every layer:

1. Add/update the TypeScript interface in `src/interface/Config.ts`.
2. Add/update Zod schema, constraints and runtime default in `src/config/Validator.ts`.
3. Add/update `config.example.json` with safe, non-secret documentation values.
4. Add Docker `CONFIG_*` parsing/override support if the field is container-operable.
5. Check `ConfigSync` behavior for old config files and missing keys.
6. Update README and `OPERATIONS.md` if it is user-visible.
7. Add validation tests or focused assertions for invalid/edge values.
8. Verify both local and Docker precedence; environment values must not silently bypass validation.

Do not rename `contintueOnBotWarning` casually. It is part of the compatibility surface even though the spelling is incorrect. A rename requires a migration or backward-compatible alias across all config sources.

## 4. Change recipe: account/auth/session

Before changing login or browser state:

1. Read the Login state classifier and method implementation.
2. Identify whether the state is mobile, desktop, OAuth/app token or Rewards page state.
3. Preserve bounded retries, same-state refresh protection, diagnostics and final checkpointing.
4. Check host resolver, user-agent/fingerprint, proxy and cookie application order.
5. Keep manual and automated flows distinct; do not block headless mode on a prompt.
6. Add a parser/state regression test where possible, then do a safe-account smoke test if authorized.

For session changes, maintain the `(email, platform)` identity, WAL/SQLite lifecycle, cookie sanitization and optional fingerprint policy. Avoid changing stored JSON shape without a migration or tolerant reader.

## 5. Change recipe: Rewards/RSC/server action

For a new activity or Rewards endpoint:

1. Find the existing activity dispatch path and choose browser or API implementation consistently.
2. Bootstrap/refresh the Rewards page through `BrowserFunc` and `ReactFunc`; do not assume action IDs are static.
3. Use the current cookie/fingerprint/router/deployment state for server actions.
4. Treat response acknowledgment and balance/points as separate signals.
5. Retry only through the established stale-context refresh path and keep retries bounded.
6. Make the operation idempotent enough for one retry after a context refresh.
7. Log a stable activity title/message that the API parser can tolerate.
8. Update public/config docs only if the activity is user-configurable.

When parsing RSC, reject malformed values conservatively. For counters, offers and points, “unknown” is safer than a fabricated positive number that can schedule excessive work.

## 6. Change recipe: search quota or scheduling

Read these together before editing: `SearchProgress.ts`, `SearchManager.ts`, `BrowserSearch.ts`, `ApiSearch.ts`, `SearchOnBing.ts` and `BonusTracker.ts`.

The invariants are:

- mobile and desktop quota are separate;
- desktop may combine ordinary PC and eligible Edge search components;
- absent/malformed dashboard counters mean unavailable;
- zero/unavailable probe mode is bounded to three searches in current browser/API implementations;
- positive quota switches to normal caps/stagnant limits;
- every worker stops on no progress and refreshes dashboard state only through the existing path;
- browser and API search are not interchangeable implementations;
- bonus searches and Visual Search have separate limits/activation paths.

Add or update a focused test when changing counter parsing, quota calculation, scheduling gates or zero-quota probing. Test missing, malformed, zero, positive and platform-split values.

## 7. Change recipe: query engine/assets

`QueryEngine` treats source failures as empty source results, combines configured sources, normalizes whitespace, de-duplicates case-insensitively and optionally shuffles. RSS has URL selector resolution, XML size limits and unsafe declaration rejection. `SearchQueryQueue` owns topic/cluster state and seen sets.

When adding a query source:

1. Add its type/config contract.
2. Add the handler and safe error logging.
3. Add it to source ordering/validation.
4. Ensure locale/proxy/fingerprint handling matches existing sources.
5. Preserve de-duplication and cache-key semantics.
6. Add a fixture/unit test; do not mutate the large production query JSON to simulate a source.

When changing a JSON asset, verify that `scripts/main/copyAssets.js` copies it and that both source and built paths work. Treat `src/functions/search-queries.json` as user/runtime data, not a convenient formatting target.

## 8. Change recipe: logger/API state

The logger output is a machine-readable internal contract:

```text
[timestamp] [user] [LEVEL] PLATFORM [TITLE] message
```

Before changing a title or parseable message:

1. Search `scripts/api/logParser.js` and all parser tests.
2. Search API status/points/history consumers for the title.
3. Decide whether to preserve backward-compatible text or update every parser/test.
4. Keep account IDs and URLs redacted as the existing code expects.
5. Test worker/cluster forwarding if the message is emitted by a worker.

Do not make the API infer state from arbitrary console output when a stable logger event can be used. Do not emit secret-bearing error strings merely to aid debugging.

## 9. Change recipe: Docker/cron

Shell behavior spans `Dockerfile`, `compose.yaml`, `scripts/docker/entrypoint.sh`, `run_daily.sh`, `healthcheck.sh`, `crontab.template` and `scripts/nix/run.sh`. Review them as one system.

For a Docker setting, determine:

- whether it is build-time, container environment, mounted config or cron schedule;
- whether the entrypoint persists a mutation to the mounted config;
- whether headless is forced;
- whether timezone changes the effective schedule;
- whether the healthcheck mode changes;
- whether a restart preserves sessions and locks.

For cron changes, preserve stale-lock recovery, bounded random sleep, signal traps and non-zero exit propagation. Avoid broad cleanup commands or unresolved globs.

## 10. Change recipe: Control API

The API is separate from the TypeScript bot and uses dependency-free Node ESM scripts. A safe API change should inspect:

- `server.js` route/auth/CORS behavior;
- `processManager.js` child state/stop timeout/log buffer;
- `runCommand.js` command selection and safety checks;
- `accounts.js` redaction/index remapping;
- config/schedule stores and atomic writes;
- diagnostics path restrictions;
- `scripts/api/README.md` and any API tests.

Classify every endpoint as read-only or state-changing. Preserve token checks and explicit opt-in guards for writes. Never expose raw account credentials, cookies, fingerprints, config backups or arbitrary diagnostic paths.

## 11. Known high-risk areas

| Area | Why it is fragile | Verification |
| --- | --- | --- |
| Microsoft login | Dynamic page states, OAuth redirects, 2FA and bot challenges | state/parser tests plus safe-account smoke |
| Patchright/fingerprint | Browser identity and anti-bot behavior are cross-cutting | build + browser smoke; inspect session checkpoint |
| RSC/action parsing | Next payload/action IDs change independently of TypeScript | parser fixtures, bootstrap/action logs |
| Search counters | Mobile/desktop/Edge semantics can be confused | quota tests for null/zero/positive/split |
| Logger strings | API derives state from titles/messages | log parser tests and API status check |
| Config sync/overrides | Docker can persist changes and force headless | validator + mounted-config review |
| Session DB | Contains credential-equivalent material | migration/read compatibility and no-secret review |
| Cron locks | Stale/stuck process can suppress daily runs | shell syntax and controlled scheduler test |
| Search JSON assets | Large user/runtime data and build-copy dependency | source/dist asset check |

## 12. Current inspected worktree notes

At the time this handoff was written, the worktree already contained user changes in `package.json`, browser/auth files, search activity files and `src/functions/search-queries.json`, plus an untracked `config.json.bak` and `scripts/api/searchQuota.test.js`; `env.example` was deleted in the worktree. Do not restore, reformat, squash or discard these changes as part of unrelated work.

The current validation baseline completed successfully after building first:

- `npm run build`
- `npm run lint`
- `npm run test:log-parser` — 9 passing tests
- `npm run test:search-quota` — 4 passing tests

The quota test initially raced a parallel build and could not import `dist`; that was an execution-order issue. Run it sequentially after build.

## 13. Final review checklist

Before handing off code:

- [ ] `git status --short` was reviewed before and after editing.
- [ ] Existing user changes remain intact.
- [ ] No secrets, session data, diagnostics, backup config or generated `dist/` files were added.
- [ ] Config changes cover interface, validator, example, Docker override/sync and docs as applicable.
- [ ] Login/session/browser changes preserve platform identity, retries, cleanup and checkpointing.
- [ ] Search changes preserve quota split, bounded probing, caps and stagnation stops.
- [ ] Logger/API contract changes include parser/tests/docs.
- [ ] `npm run build`, `npm run lint` and relevant tests passed, or failures are explicitly explained.
- [ ] `git diff --check` is clean.
- [ ] Live-account/Docker/API behavior not actually tested is labeled as unverified.
