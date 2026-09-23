# Architecture and Runtime Contracts

This document describes how the repository behaves internally. It is intentionally more specific than the public README and should be used before changing runtime code.

## 1. System boundary

The project is a Node.js 24 CommonJS application compiled from strict TypeScript to `dist/`. It has three operational layers:

1. The bot runtime in `src/`, which owns accounts, browsers, Rewards activities, searches, sessions and logging.
2. The container/scheduler layer in `scripts/docker/`, `compose.yaml` and `Dockerfile`, which prepares configuration and invokes the runtime on cron or on demand.
3. The Control API in `scripts/api/`, which starts a child runtime, parses its structured logs, keeps memory/history state and optionally writes configuration/schedule files.

The core dependency direction is:

```text
interfaces/constants/config/util
        ↓
browser + auth + React/RSC parsing
        ↓
activities + search
        ↓
index.ts orchestration
        ↓
CLI, Docker/cron, or Control API process wrapper
```

Keep lower layers independent of the API wrapper. The API must observe the bot through its process/log/session/config interfaces rather than becoming a second bot implementation.

## 2. Build and module boundaries

- `src/index.ts` is the executable orchestration root. `MicrosoftRewardsBot` owns per-run state and dependencies; `main()` performs process-level startup and shutdown.
- `src/interface/` contains configuration/account/dashboard/search/activity types. Types explain shape, but runtime validation is in `src/config/Validator.ts`.
- `src/config/` loads `.env`, account slots and JSON configuration, validates values, applies Docker overrides and synchronizes missing config keys.
- `src/browser/` owns Patchright contexts/pages, fingerprint injection, browser utilities, login and Microsoft/Rewards page interaction.
- `src/functions/` contains activity dispatch, search, query generation and reward reporting. `Activities.ts` is the high-level dispatcher.
- `src/util/` contains HTTP, locale/proxy helpers, SQLite session persistence, logging, webhooks and diagnostics.
- `scripts/` is deliberately JavaScript/shell and is used for build asset copying, API process management, Docker entrypoint/scheduling and tests.

The TypeScript compiler uses `rootDir: src`, `outDir: dist`, strict checking, JSON module resolution and no unused locals. The build also copies the two search JSON assets into `dist/functions/`; a successful TypeScript compile without copied assets is not a complete build.

## 3. Main run lifecycle

`src/index.ts` follows this sequence:

1. Process startup validates the Node version, installs signal/uncaught-error handlers and initializes logging/session infrastructure.
2. The constructor loads configuration and account definitions, then creates `Logger`, `Utils`, `Activities`, browser helpers, `ReactFunc`, `SearchManager` and shared HTTP/session dependencies.
3. `initialize()` loads accounts and emits warnings for experimental features.
4. `run()` emits a run-start event. With `clusters > 1`, the primary process chunks account indexes and forks workers with Node `cluster`; with one cluster it runs directly.
5. Each worker runs its assigned accounts serially, respecting the configured account delay. Worker logs/statistics are sent to the primary, which aggregates outcomes and emits run-end state.
6. For each account, `runTasks()` emits account start, sets locale and account-scoped clients, calls `Main(account)`, emits success/failure and waits before the next account.
7. Shutdown flushes queued webhooks, closes session state and returns an exit code based on account/worker outcomes.

Account processing is intentionally serial inside a worker. Parallelism is introduced only by cluster workers and, where configured, by the mobile/desktop search or Edge background tasks. Do not add unbounded account-level concurrency without re-evaluating proxy, session, rate-limit and log aggregation behavior.

## 4. Per-account orchestration

`Main(account)` resets account state and derives the execution mode:

- `experimental.apiSearch` selects the API search implementation.
- `experimental.apiSearchOnBing` allows the API path for SearchOnBing activities.
- `fullApi` is true only when API search is enabled and either API SearchOnBing is enabled or normal browser SearchOnBing is disabled.
- App activities require an access token; the mobile browser OAuth path can acquire it.

The normal account flow is:

1. Create a mobile browser context through `Browser.createBrowser()`, applying the account proxy, fingerprint, user agent and mobile settings.
2. Run `Login.login()`. Depending on state, this may perform password/OTP/TOTP/recovery/passwordless steps or reuse an existing session. Manual login pauses the browser flow for the user; automated mode resumes after a checkpoint.
3. Verify the Rewards/Bing session, save cookies/fingerprint checkpoint, and load dashboard data. A bot-warning profile is treated as unsafe unless `contintueOnBotWarning` explicitly allows continuing.
4. Resolve `geoLocale: auto` from the account/profile where possible, update locale/Accept-Language and keep the account metadata in the session store.
5. Acquire app access token and app dashboard/earnable data if app activities are enabled. If app bootstrap is unavailable, skip app tasks rather than pretending they succeeded.
6. Start optional Edge browsing in the background when enabled and supported.
7. Run streak protection, Daily Set, search perk activation, More Promotions, app check-in/promotions/read-to-earn and punchcards according to configuration and availability.
8. Build the search plan through `SearchManager`. Create desktop context only when desktop tasks, punchcards, visual search or desktop search require it. Mobile and desktop workers may run concurrently when configured.
9. Claim bonus/reward points, wait for Edge background completion, load final points and report initial versus collected totals.
10. In `finally`, abort background work, close desktop/mobile contexts, persist session state and release account-scoped resources.

If a Rewards request fails because the page/context is stale, `refreshCurrentRewardsContext()` can rebuild the page/login/bootstrap state and retry once. New code should use this recovery path rather than repeating the full account flow ad hoc.

## 5. Browser, fingerprint and session layers

`src/browser/Browser.ts` creates Patchright Chromium contexts with:

- fingerprint-generator/injector output;
- mobile or desktop user agent/client hints from `UserAgent.ts`;
- account proxy routing and WebRTC protection;
- optional certificate-error tolerance;
- default timeout and mobile device/context settings;
- persisted storage state and optional fingerprint restoration.

The mobile and desktop sessions are separate logical records. `BrowserFunc.ts` caches cookies for each platform, filters/apply cookies by URL, parses `Set-Cookie`, checkpoints changes and handles session refresh. Do not merge mobile/desktop cookie jars or use a desktop context to infer mobile quota.

`SessionStore.ts` uses Node `node:sqlite` with WAL mode. Its primary tables are:

```text
sessions(
  email TEXT,
  platform TEXT CHECK(platform IN ('mobile','desktop')),
  storage_state TEXT,
  fingerprint TEXT,
  updated_at INTEGER,
  PRIMARY KEY(email, platform)
)

account_metadata(
  email TEXT COLLATE NOCASE PRIMARY KEY,
  resolved_region TEXT,
  updated_at INTEGER
)
```

Expired cookies are sanitized before storage. Fingerprints are stored only when the configuration/account policy permits it. Region metadata is not a replacement for the account’s configured language/country until the locale flow accepts it.

`MediaBlocker` may abort image/media requests after authentication while leaving login hosts available. `BrowserUtils` handles dismissals, ghost-click behavior, net-error reloads, tab cleanup and FIDO suppression. Changes to these helpers can affect every activity and should be tested as browser infrastructure, not as a single offer fix.

## 6. Authentication state machine

`src/browser/auth/Login.ts` is a bounded state machine (maximum iteration count and same-state refresh protection). It classifies pages such as:

- email and password forms;
- footer/method picker/passkey/passwordless flows;
- “keep me signed in”;
- TOTP, email-code and recovery-code steps;
- locked/error/unknown pages;
- logged-in Rewards/Bing and `chromewebdata`/redirect states.

Authentication methods live under `src/browser/auth/methods/`:

- `EmailLogin` and password flow submit the primary credentials.
- `PasswordlessLogin` approves the displayed app number with a bounded timeout and retry.
- `Totp2FA` generates OTPAuth codes or requests interactive input.
- `GetACodeLogin` handles email-code entry.
- `RecoveryEmailLogin` handles recovery addresses/codes.
- `MobileAccessLogin` obtains the app OAuth token through the browser/request path.

After login, `verifyBingSession()` and `finalizeLogin()` establish the Rewards context and checkpoint. Unknown pages and unrecoverable errors generate diagnostics when enabled. The special empty alert returned by Microsoft’s login postback can be a successful session recovery; non-empty alerts remain fatal. Do not turn all postback alerts into success.

The browser layer includes a host resolver workaround for Microsoft OAuth redirects that otherwise land on `about:blank`. Treat that Chromium argument as auth-critical.

## 7. Rewards dashboard, Next/RSC and server actions

`BrowserFunc.getDashboardData()` first requests the primary Rewards user-info endpoint, retries/falls back to the flyout endpoint, applies response cookies and maps the result to `DashboardData`. The current implementation additionally fetches `/earn`, parses its Next/RSC payload and enriches `userStatus.counters.pcSearch` and `mobileSearch` from `pointsCounters.pc`/`pointsCounters.mobile` when valid.

`ReactFunc.ts` parses `self.__next_f.push(...)` chunks and related serialized data. It extracts:

- offers and activity definitions;
- streak and streak-protection state;
- account/profile information;
- punchcard/quest data;
- action IDs and page snapshot values;
- search counters from the earn page.

The search-counter parser is intentionally conservative: absent, malformed or non-numeric counters produce `null`, not a guessed quota. Search scheduling then distinguishes “unavailable” from “complete”.

`bootstrap(page)` opens `/earn`, dismisses the first-time welcome dialog, fetches earn/dashboard HTML, derives deployment/build and router-tree metadata, snapshots RSC state, and resolves Next server-action IDs from static and dynamic chunks. `reportServerAction()` posts the action with fingerprint headers, cookies, `Next-Action`, router state and deployment ID, then interprets acknowledgment and available-points values.

When a server action or offer request is stale, `refreshEarnSnapshot()`, `getRewardsPageHtml()`, `ensureOffer()` and `refreshCurrentRewardsContext()` are the intended repair points. Avoid hard-coding a second action POST without preserving deployment/router/cookie state.

## 8. Activity dispatch

`src/functions/Activities.ts` dispatches standard browser/API activity implementations. Core groups are:

- `DailySet`: runs incomplete current daily-set items.
- `MorePromotions`: filters actionable, unlocked, non-promotional offers.
- `PromotionActivityRunner`: supports URL rewards and routes `exploreonbing`-style items to SearchOnBing.
- `PunchCards`: parses parent/child quests from RSC/API data, skips search-quota children, and claims punchcard rewards only when `autoClaimPunchcardRewards` is enabled.
- `ClaimBonusPoints`, `ClaimReward`, `ActivateSearchPerk` and `EnsureStreakProtection`: use the bootstrapped server-action/reporting path and retry through refreshed context where supported.

API activity modules such as `UrlReward` ensure live offers/hashes, report actions, inspect acknowledgment/balance and retry once after context refresh. App modules use an access token and platform endpoints: Daily Check-In uses type 103, app rewards use type 101, and Read-to-Earn posts articles until the available gain stops.

Activities should be idempotent enough for a retry after a stale context. A failed report must not be logged as collected points solely because the page request succeeded.

## 9. Search architecture and quota contract

The search path is:

```text
Dashboard/RSC counters
        ↓
SearchProgress.calculateQuotas()
        ↓
SearchManager worker plan
        ↓
BrowserSearch or experimental ApiSearch
        ↓
Bing search + reportActivity + bonus tracker
        ↓
dashboard refresh and final summary
```

`SearchProgress` keeps mobile separate and derives desktop from the non-Edge PC counter plus eligible Edge search contribution. Explicit Edge offers are recognized by offer ID/name/title/subtype. Never replace this with a single combined total without checking the source offer semantics.

`SearchManager.getSearchPoints()` starts a worker only when its platform is enabled and remaining points are positive, except when `runOnZeroPoints` is enabled. In zero/unavailable mode, current browser/API implementations perform at most three probe searches; once a positive quota is observed, normal caps and stagnant limits apply. This bounded probe is for stale/unavailable counters, not permission to run an unlimited search loop.

`BrowserSearch` uses a query queue, browser Bing searches, a normal cap of up to 100 attempts, page refreshes, a stagnant limit and bounded per-query retries. `ApiSearch` uses the experimental HTTP Bing search/report path, a lower normal cap, periodic dashboard refresh and its own stagnant limit. Both must retain platform state and stop on no progress.

`BonusTracker` finds the bare Bing search bonus, applies its maximum search count and stops on prolonged stagnation. `SearchOnBing` activates the relevant offer, loads the local 74-title activity asset or remote fallback, and chooses browser/API execution according to the configuration path.

### Query generation

`QueryEngine` gathers configured sources in parallel: Google Trends, Wikipedia trending/random, Hacker News, Reddit, local JSON and RSS selectors. It normalizes whitespace, de-duplicates case-insensitively, optionally shuffles and falls back safely on source errors. RSS parsing has a size limit and rejects XML declaration/DOCTYPE/ENTITY patterns before parsing.

`SearchQueryQueue` caches a locale/source-keyed topic promise, refills after exhaustion, tracks seen main topics and normalized queries, and asks `QueryCore.getSearchCluster()` for each topic. Clustering combines Bing suggestions and related terms, interleaves them, removes the main topic duplicate, selects at most eight related queries and shuffles the cluster. The main topic is still included.

Visual Search is desktop-only and has its own activation/offer validation, bounded attempts and seed de-duplication. It should not be folded into ordinary text search quota logic.

## 10. Edge browsing background task

The experimental Edge task requires an app token and discovers/activates the Edge streak/promotion. It targets a configured duration (normally 30 minutes), clamps report intervals to a safe range, adds jitter, reports through platform activities using Edge cookies/MUID/MC1, checks server completion, and remains abortable. It runs beside foreground work and is always aborted/awaited during account cleanup. Changes must preserve cancellation and must not leave a background timer or browser context alive after an account finishes.

## 11. Configuration and account data flow

The effective configuration is assembled from several layers:

```text
config.example.json / config.json
        ↓
Load.ts searches root, dist and src locations
        ↓
Zod schema + Validator defaults/constraints
        ↓
Docker ConfigSync and CONFIG_* overrides (container path)
        ↓
runtime configuration
```

Environment values take precedence over `.env`. Account slots are named `ACCOUNT_N_EMAIL` and optional per-slot password/TOTP/recovery/region/language/proxy/fingerprint variables. Slots may be sparse; the loader sorts numeric indexes and validates each complete account.

`config.example.json` is a user-facing template. `Validator.ts` also supplies runtime defaults, and these are not guaranteed to be identical. When adding or interpreting a field, inspect both. The `ConfigEnvOverrides` parser is strict about booleans/numbers/arrays and forces headless mode in Docker. `ConfigSync` can atomically patch missing keys and create a backup; never treat that backup as safe to commit.

The configured `geoLocale` may be a two-letter country or `auto`; language is validated as a BCP-47-like code. Proxy validation supports HTTP/HTTPS/SOCKS4/SOCKS5 with protocol-specific credential/port checks.

## 12. HTTP, proxy and logging contracts

`Http.ts` wraps Impit with a default timeout and exponential retry policy. Permanent 4xx errors are not retried except for timeout/rate-limit classes such as 408/425/429. Shared/direct and account/proxy clients are distinct; header merging is case-insensitive.

`Logger.ts` emits an envelope like:

```text
[timestamp] [user] [LEVEL] MOBILE|DESKTOP|MAIN [TITLE] message
```

Console/webhook filters, diagnostics and cluster IPC all depend on this structure. `scripts/api/logParser.js` extracts run/account/search/point/error state from titles and messages. Treat title names and parseable message fragments as a public internal API.

Discord/Ntfy/Telegram webhooks are queued with `p-queue` and flushed during shutdown; Ntfy priority changes for warning/error levels. Do not block core activity execution on a webhook unless the existing helper explicitly requires it.

## 13. Docker, cron and Control API boundaries

`scripts/docker/entrypoint.sh` sets timezone, validates scheduler/API mode, counts accounts, synchronizes config, applies `CONFIG_*` overrides, snapshots environment and may trigger an initial run. `run_daily.sh` imports the container environment, uses a lock with stale-lock recovery, applies bounded random sleep, invokes `npm start` or an API trigger and removes the lock on exit. `healthcheck.sh` checks cron in scheduler mode or `/health` in API mode.

The Control API is dependency-free Node ESM. `server.js` owns auth, CORS, `ProcessManager`, memory logs/history and endpoint routing. `runCommand.js` prefers `dist/index.js` and falls back to `ts-node` source, with an explicitly validated override. `accounts.js` remaps account indexes for single/excluded account runs while redacting secrets. Diagnostics exposure is limited to safe `error-*` files.

The API process states are `idle`, `start`, `running` and `stopping`. Stop operations target the child process group and have a bounded timeout. Config/schedule writes and session deletion are state-changing endpoints and require authentication/opt-in guards. The exact endpoint contract is maintained in `scripts/api/README.md`; update it when behavior changes.
