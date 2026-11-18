# Scheduler learning collection (v1)

This is observation and dataset preparation, not an AI scheduler. Existing account ownership, automatic proxy-group locks, manual account-only locks, quotas and hard worker capacity remain authoritative. No model can issue runtime commands through this API.

Manager creates one private collection identity and HMAC key, delivered only in authenticated worker snapshots. Training identities are pseudonyms shared across worker transfers; credentials, email addresses, proxy URLs, query text and browser payloads are never training fields. Operational logs have separate retention and access rules.

## Collection calendar

The clock starts after every assigned worker reports enabled telemetry, a resource sample and no collector errors. Existing logs are not retroactively treated as measured training examples.

- Days 1–7: unchanged scheduler baseline.
- Days 8–28: eligible randomized observations, at most 10% trial dispatches. Only reduce concurrency by one during a recorded two-hour block; exclude manual holds, urgent jobs, warmup accounts, errors and nearby deadlines. Seven accepted daily quality reports are required first.
- Search-budget trials additionally require explicit desktop/mobile daily query caps. **Unknown caps remain unset. Do not infer a daily cap from point quotas or per-session limits.** Current runtime quotas/safety settings stay active. This deployment does not enable search-budget trials without these caps.
- Days 29–35: held-out observations; collection experiments are disabled. Human review and offline validation remain required after day 35. No automatic model activation.

A failed quality gate delays readiness; elapsed days alone never establish training readiness. Readiness targets are 5,000 usable executions, 200 per observed task group, >=99% linked outcomes and >=95% estimated measured runtime coverage. Sparse or absent task/platform groups still require review. These thresholds are collection gates, not proof of model performance.

## What is recorded

Decisions contain pre-dispatch candidates, running attempts, config/runtime revisions, chosen action, assignment propensity and experimental block. Every runtime attempt has a new UUID. Typed activity phases and every instrumented actual query send get durable outbox events; uncertain sends consume the configured daily budget too. Desktop/mobile counters are separate and automatically executed queries only. Existing account planner state carries counts during handoff.

Resources: node CPU/load/RAM/swap/disk/PSI/cgroup limits, plus child process trees including browser descendants. PSS is used for observed memory; RSS is diagnostic only. Samples are 1s during the first 15s, 5s while active, 30s idle, or 15s under collector overhead. Process exit between samples is missing measurement, not zero resource cost. Cumulative live-process CPU counters do not include children that already exited.

Account-day snapshots carry timezone, deadline, enabled work, quota-known flags, completed work, warmup/manual/hold status and a goal revision. Unknown points stay null. Interrupted/time-out/restart/handoff attempts are censored. The exporter uses only decision state as features; post-execution information remains labels and outcomes crossing split boundaries are censored.

## Storage, sync and operation

Worker: `$MRS_WORKER_DATA/learning/learning.sqlite` plus private `outbox/`. Manager: `<control>/learning/learning.sqlite` and daily `reports/YYYY-MM-DD.json`. Files are mode 0600, directories 0700. Include both paths in private backups. Manager-only outage does not stop collection or execution. SQLite ingestion commits before ACK; replay deduplicates by collection/source/sequence. Worker retains unacknowledged events; ACKed records expire after 7 days. Manager keeps normalized events 180 days, resource samples 90 days. Above 128MiB worker database/WAL, resource sampling is dropped and reported; readiness must fail on dropped samples. Monitor disk during long outages.

Authenticated Manager GET endpoints:

- `/learning/status`: collection clock, phase, per-source health and readiness reasons.
- `/learning/quality`: linkage, resource coverage estimate, missing query outcomes, gaps, clock skew and observed IP conflicts.
- `/learning/export?after=0`: paginated immutable high-watermark export; reuse `snapshotId` for every page.

Worker internal GET `/internal/learning/events?after=0`, POST `/internal/learning/ack` are protected by the existing worker API authentication and loopback/tunnel boundary. Never publish them.

Prepare an immutable dataset using a local authenticated Manager connection (load token privately into the environment):

```sh
node scripts/learning/prepare.js /private/new-dataset-directory
```

The directory must not already exist. Output includes SHA256 manifest, pseudonymous records, execution examples split by collection day 1–21 / 22–28 / 29–35, and account-day observations. `final` account-day labels require later observations; do not interpret unfinalized rows as daily failures. Exporter gates are preliminary: review per-source/task coverage, missing query instrumentation, shared-IP freshness, final day labels and model baselines before training. No CatBoost/RL model is trained or activated by this command.

Verification: build first, then `node --test scripts/learning/*.test.js`, Smart scheduler/worker tests and Manager integration tests. Exercise actual collection and inspect health after deployment; synthetic tests alone do not establish real browser coverage.

Warmup query reservations and verified completions are distinct: a send whose result cannot be confirmed still consumes the existing 30 desktop / 20 mobile daily budget. The planner clips the next job against persisted reservations (including handoff/restart) and stops that platform until the next account day when exhausted. It must not repeatedly retry the cap error, label it an authentication failure, raise the cap, or fabricate successful completions. `newAccountStatus.queryCapsReached` identifies this state.
