# Architecture and Runtime Contracts

This document describes how the repository behaves internally. It is intentionally more specific than the public README and should be used before changing runtime code.

## 1. System boundary

Newly imported Outlook/Hotmail accounts default to `NEW_ACCOUNT_MODE=true`; existing environment records without that field retain Rewards behavior. A `warmup` execution plan runs before all Rewards orchestration, uses Microsoft-only login, the ordinary browser/proxy/identity and count-only Bing queries, and returns null point totals. `common/preRewardsGuard.cjs` blocks Rewards hosts and Bing Rewards endpoints for the entire context, with service workers blocked. Manual Desktop/Mobile helpers receive the same guard from the owning worker's planner, including during temporary local handoff.

Smart retains `newAccount.startedAt/readyAt` inside the transferred account planner, preserving them across local midnight and restarting only daily service/query progress. The first checkpoint with a verified query and persisted browser session starts 168 hours. Every checkpoint records absolute job query counts; replay cannot double-count. Warmup has 20 mobile/30 desktop queries per day, slices of at most five, ordinary timing/account/network locks, and at most three service attempts/day. Urgent never expands this budget. On expiry, new Rewards quotas start unknown; warmup queries are never credited as Rewards points. Workers advertise `preRewardsV1`; Manager refuses snapshots containing enabled new-account mode when it is absent.

Microsoft service visits call `NewAccountServices.ts`: a fixed sample text upload, a fixed To Do task, up to three inbox messages, and Calendar Today/week navigation. Durable artifact markers travel in the warmup plan and checkpoint alongside daily service-action confirmations. Daily rollover resets visits/actions but preserves artifact markers; missed action confirmation receives the same bounded service retry budget. Remote filename/task-name checks also avoid duplicates when a mutation succeeded before its checkpoint was saved. Unknown controls, upload conflicts or inaccessible message bodies remain pending, and mail content is excluded from logs.

Rewards first-visit onboarding uses visible controls scoped to the welcome/goal dialogs. It opens the four learning sections, tracks the smallest Roblox reward manually, and visits Earn/level tasks. Every action is verified against freshly loaded parent progress; unsupported UI remains pending. It never redeems, enables auto-redeem, or treats the search/Daily Set prerequisites as completed merely because a link was clicked.

Fresh membership can omit lifetime/header counters. Login accepts its valid level/progress/remaining payload only alongside the visible welcome heading and Get started control; missing counters alone are not authentication evidence. The welcome/goal containers may omit `role=dialog`, so fallback scopes use their heading and exact action controls. Each learning accordion may open a blocking tutorial dialog: close it before continuing. With diagnostics enabled, an unconfirmed step captures the page privately and logs only its step/status.

The bot runtime is a Node.js 24 CommonJS application compiled from strict TypeScript to `dist/`. In the standalone deployment it runs only inside an independent Worker. The sibling Manager owns account configuration, Fleet/SSH and dashboard management; it has no browser/runtime dependency. Read [Manager / Worker technical contracts](../../../../rewards-dashboard/manager/ARCHITECTURE.md) before changing deployment or ownership.

The following runtime layers remain relevant; Docker/cron and coordinator entrypoints describe legacy compatibility:

1. The bot runtime in `src/`, which executes its assigned account subset and owns browsers, Rewards activities, searches, sessions and logging.
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
- `src/interface/` contains configuration/account/dashboard/search/activity types. Pure bot schema/defaults live in `src/contracts/BotConfig.ts`; runtime validation/default filling is in `src/util/Validator.ts`.
- `src/util/Load.ts` loads runtime config and account environment; `MRS_CONFIG_FILE` overrides checkout search paths. Standalone Worker skips checkout `.env` and materializes only accepted snapshot accounts.
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

- a runtime-probed native identity for desktop contexts;
- a sourced Patchright device descriptor plus pre-navigation CDP client hints for mobile contexts;
- account proxy routing and Chromium's non-proxied-UDP WebRTC policy;
- optional certificate-error tolerance;
- default timeout and mobile device/context settings;
- persisted storage state and optional mobile-profile restoration.

The identity probe uses a loopback page whose own JavaScript writes the observable navigator/screen values into the DOM while the loopback server records request headers. Desktop contexts do not inject or override identity fields. The active mobile catalog contains only Android 11+ portrait-phone descriptors with explicit screen and viewport values from the installed Patchright descriptor source. CDP sessions remain attached for the lifetime of each mobile page and detach when that page closes; callers must create pages through the shared identity-page helper before navigation.

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

Expired cookies are sanitized before storage. Browser identity snapshots are stored only when the configuration/account policy permits it. Region metadata is not a replacement for the account’s configured language/country until the locale flow accepts it.

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

Login checks the Rewards earn page first when the browser already has authentication cookies; fresh sessions retain the explicit login route. An unrecognized Rewards `/auth/login` page gets one earn-page recovery, and the auth route or tracking cookies alone cannot establish login success.

Bing verification first checks the authenticated `_U` cookie and existing Bing profile before starting an interactive sign-in. Mobile homepages can omit the desktop `#id_n` element: in that case the existing Bing flyout endpoint must return a valid account through `mapFlyoutToDashboard` before the session is accepted. Guest, malformed, error and timed-out responses do not verify login. Rewards access, Bing sign-in and mobile app OAuth are separate outcomes. A redirect to `account.live.com/Abuse` stops repeated attempts for that authorization flow without declaring the account globally locked. OAuth diagnostics expose only host/path, HTTP status and code presence; never authorization codes, token values or login hints.

An unrecognized `/earn` page gets one navigation back to `/earn` after three unknown-state checks, using its existing session; auth/account-review routes are excluded and the overall login limit remains bounded. After login, `verifyBingSession()` and `finalizeLogin()` establish the Rewards context and checkpoint. Unknown pages and unrecoverable errors generate diagnostics when enabled. The special empty alert returned by Microsoft’s login postback can be a successful session recovery; non-empty alerts remain fatal. Do not turn all postback alerts into success.

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

Fresh parsed counters emit timestamped `SMART-QUOTA` snapshots. After successful account sessions, Smart mode reconciles the other platforms' terminal states with those counters; a search session's own platform still follows its `SMART-SEARCH-END` result. Reopening a platform preserves workers/query history and grants retries only once per day/max/progress observation. Fully terminal accounts with no pending workers receive bounded read-only `quota` execution plans: at most three attempts per local day, spaced two hours from the last check/observation and excluded from the final five minutes before midnight. They use normal locks and browser/session helpers, disable every worker/search/background task and return immediately after the dashboard read. Stale, unknown, failed-login, bot-warning and previous-day observations cannot revive jobs.

`bootstrap(page)` opens `/earn`, dismisses the first-time welcome dialog, fetches earn/dashboard HTML, derives deployment/build and router-tree metadata, snapshots RSC state, and resolves Next server-action IDs from static and dynamic chunks. `reportServerAction()` posts the action with fingerprint headers, cookies, `Next-Action`, router state and deployment ID, then interprets acknowledgment and available-points values.

When a server action or offer request is stale, `refreshEarnSnapshot()`, `getRewardsPageHtml()`, `ensureOffer()` and `refreshCurrentRewardsContext()` are the intended repair points. Avoid hard-coding a second action POST without preserving deployment/router/cookie state.

### Selective upstream v5 integration (2026-10-31)

The custom Manager/Worker runtime stays on its current architecture; this is not a v5 API/config migration. `src/browser/parsers/{RewardCardParser,EarnPageParser,PunchCardPageParser}.ts` are adapted from upstream tag `v5.0.0` (`b78f616`, GPL-3.0-or-later). They read rendered state in an isolated tab of the existing account context, with bounded navigation and unconditional cleanup. `BrowserFunc.withRewardsPage` never changes the active manual/main page or bypasses the account proxy/fingerprint/session. Keep first-visit onboarding and the pre-Rewards guard intact.

Keep earning explicitly requests rendered verification. Scroll each task section into view before reading because Rewards can defer content below the viewport; parse the resulting Flight payload after those reads. Match DOM cards to signed RSC offers only by unique offer identity, or a unique exact normalized destination plus title. Never manufacture a hash from visible text. Unmatched visible point cards keep the worker pending. Initial quest discovery supplements Flight parents from rendered cards; empty streamed quest children get a bounded rendered fallback. Locked/multi-day/app tasks and manual claims retain the existing deferral rules.

Partner streaks carry the enclosing Flight `expiresAt` as `resetAt`; expired partners are discarded before logging or activity guards. Normalize partner counters conservatively. Preserve the independent numeric daily `streakCounter` and the version-1 journal observation contract; cycle counts must not replace the daily counter.

`util/PointAccounting` and URL `OfferVerification` separate request acceptance, fresh completion and attributable credit. Poll fresh state at most three times with two-second gaps. A total-balance increase alone cannot prove one offer's credit; require matching per-offer progress and sufficient observed balance delta. Unknown/decreasing observations stay unknown. Quest reports and claims use the same credit arithmetic. `getCurrentPoints` must refresh failed dashboard reads, not return an old `reactSnapshot` as fresh. Account aggregate totals remain independently reconciled from actual before/after balances.

## 8. Activity dispatch

`src/functions/Activities.ts` dispatches standard browser/API activity implementations. Core groups are:

- `DailySet`: reads the active `dailySetItems` group and its expiry from the fresh earn-page Flight payload, including when the legacy/flyout dashboard omits it or the worker runs in another timezone. Missing/expired/malformed data is unknown, never completed. After claims, a second snapshot must confirm every attempted card complete before `dailySetVerified` allows a completion marker. These cards are also excluded from More Promotions.
- `MorePromotions`: merges legacy lists with signed `/earn` offers. Supplemental banners require a matching reportable offer. It checks newly unlocked cards in a bounded second wave and may visit a still-pending ordinary Bing/Rewards link once in the existing account context, respecting activity settings. Completion requires a fresh snapshot confirming every attempted card and no remaining eligible card, including missing-hash cards. Missing page/section data is unknown. Card-status logs explain locked, non-point, unsupported/other-worker and unverified states; a successful report alone is not completion.
- `PromotionActivityRunner`: supports URL rewards and routes `exploreonbing`-style items to SearchOnBing.
- `PunchCards`: reads parent title/points/task progress from the card's own resolved React subtree, including lazy references; zero-point parents/activation steps are not discarded. Each action uses current signed child metadata and is followed by fresh child and parent reads. New unlocks are processed with at most 32 distinct child attempts per quest/run. Disappearing completed CTAs require a parent-progress increase, and COMPLETE requires a fresh complete parent. Multi-day searches, app requirements, disabled/locked steps and manual claims remain explicitly deferred. Claims still require `autoClaimPunchcardRewards`. Smart completion means today's available steps were verified/deferred, not that every multi-day quest is complete.
- `ClaimBonusPoints`, `ClaimReward`, `ActivateSearchPerk` and `EnsureStreakProtection`: use the bootstrapped server-action/reporting path and retry through refreshed context where supported.

API activity modules such as `UrlReward` ensure live offers/hashes, report actions against `/earn` with the matching router state, inspect acknowledgment/balance and retry once after context refresh. URL reward reports may retry HTTP 503 once through the active browser request context, retaining the account proxy/cookies; an unsuccessful response remains an error. App modules use an access token and platform endpoints: Daily Check-In uses type 103, app rewards use type 101, and Read-to-Earn posts articles until the available gain stops.

The `reportActivity` wire payload encodes promotional offers as `isPromotional: 'true'` (a string), matching the Rewards client; non-promotional offers retain the React `$undefined` sentinel. Keep `ParsedOffer.isPromotional` boolean internally and convert at serialization. A controlled live comparison for Plan a trip returned HTTP 503 with a boolean and HTTP 200 with the string, with verified completion and a five-point balance increase.

Activities should be idempotent enough for a retry after a stale context. A failed report must not be logged as collected points solely because the page request succeeded.

Flight reference IDs are scoped to each HTML response: resolve plain/lazy/property references before joining earn/dashboard payloads. Never let a dashboard record overwrite an earn record with the same ID. Daily `streakCounter` is parsed independently of `isProtectionOn`; do not infer it from partner `completedDays`, stamp counts or successful bot runs. `REWARDS-STREAK` emits the versioned, browser-free `packages/contracts/rewards.cjs` observation contract. Worker/Manager journals retain it as an important event; dashboard stores it monotonically, independently of account outcome timestamps. An unavailable refresh keeps a labelled last-known count. Protection remains a separate compatibility field.

`ReadToEarn` reads the Android app promotion's `pointmax`/`pointprogress` before and after article submissions. It polls briefly for delayed counter changes, stops after three no-progress submissions or ten total submissions, and only sets `readToEarnVerified` when the offered quota is confirmed full. A lower/stale app balance relative to the browser does not prematurely stop reading; credit is taken from verified counter progress. Missing token, unavailable counters and HTTP 200 without progress remain pending. Search cooldown is not imposed on unfinished Daily Set/Read to Earn work; each failed worker retains its own retry deadline. Ready Daily Set/Read to Earn sessions take priority over search jobs across accounts, and normal session selection chooses Read to Earn before Search Perk so a perk cannot conceal pending reading work from that priority.

Both regular and urgent Smart worker batches report completion immediately per worker through `Activities.trackWorker`, using an error baseline for that activity only. Punchcard mobile/desktop stages share their own failure flag until the final stage; tracking resets for each account. The scheduler retains emitted completion markers even if a later worker or the process fails. Each failed worker keeps its own `workerRetryAt` deadline; ready workers are selected separately, so a failed promotion cannot delay a fresh Search Perk. Legacy shared retry deadlines migrate to the failed workers without resetting their attempt counts. End-of-batch completion inference is intentionally disabled.

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

This section describes compatibility modes. Standalone installations instead use `scripts/worker/server.js`, `WorkerAgent` and per-worker Smart Scheduler; dashboard cron is disabled.

`scripts/docker/entrypoint.sh` sets timezone, validates scheduler/API mode, counts accounts, synchronizes config, applies `CONFIG_*` overrides, snapshots environment and may trigger an initial run. `run_daily.sh` imports the container environment, uses a lock with stale-lock recovery, applies bounded random sleep, invokes `npm start` or an API trigger and removes the lock on exit. `healthcheck.sh` checks cron in scheduler mode or `/health` in API mode.

The Control API is dependency-free Node ESM. `server.js` owns auth, CORS, `ProcessManager`, memory logs/history and endpoint routing. `runCommand.js` prefers `dist/index.js` and falls back to `ts-node` source, with an explicitly validated override. `accounts.js` remaps account indexes for single/excluded account runs while redacting secrets. Diagnostics exposure is limited to safe `error-*` files.

The API process states are `idle`, `start`, `running` and `stopping`. Stop operations target the child process group and have a bounded timeout. Config/schedule writes and session deletion are state-changing endpoints and require authentication/opt-in guards. The exact endpoint contract is maintained in `scripts/api/README.md`; update it when behavior changes.

## 14. Standalone ownership and manual sessions

Manager's `core.js` holds full credentials/configuration, durable assignments and event cursors. Worker journal/sessions/Smart progress stay in its private data directory, separate from release code. Shared validation comes from the versioned `packages/contracts` package, built from the pure schema; Manager vendors this package instead of importing runtime modules.

Normal assignment moves still expand proxy groups. Manual Desktop/Mobile/Android requests select exactly one account, use `scope: account` holds and wait only for that account's active job. A null network-group scheduler lock prevents that account's automated execution without blocking proxy siblings. Manual helpers reuse current session/fingerprint/region; Android reuses its separate account-bound Damru device/login. Clean browser closure or confirmed Android device stop permits return to the original worker; viewer closure alone does not.

`Hybrid.canApplyMembershipSnapshot` allows roster-only changes beside unrelated running jobs, preserving their environments, profiles and node settings. General config edits still drain when required. Do not regress this distinction into a worker-wide wait for an idle manual account. Authority/generation/revision and persistent token holds remain mandatory even on this fast path.

See the Manager technical contracts for the full operation state machine, crash recovery, acknowledgement, migration and systemd/release regression requirements.
