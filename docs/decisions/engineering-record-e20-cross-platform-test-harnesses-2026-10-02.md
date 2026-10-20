# E20 — Cross-platform test harnesses: the S10 stack review findings

- **ID:** E20
- **Status:** Delegated engineering (pending owner review)
- **Date:** 2026-10-02
- **Evidence source:** review of the stacked S07–S10 pull requests (#46 → #47 → #48 → #49) on branch `fix/s10-windows-portability-gates` (commits `48c1f00`, `aaf2be7`), plus a fresh-context adversarial review of that fix and a verification pass with negative controls.
- **Supersedes:** nothing. **Refines:** nothing. **Product impact:** none — no product behavior, schema, contract, or user-visible surface changed.

## What was found

Running `pnpm test` at the S10 stack tip (`bac6acb`) on Windows reported **15 failed test files while 604 individual tests passed**. Every failure was a *suite-level load error* with **zero failed assertions**: the suites were green in substance and red only because of the host platform. Two independent root causes, both real defects.

### Finding 1 — PostgreSQL binaries resolved from a hardcoded Debian path

`apps/control-plane/test/helpers/pg-cluster.ts` pinned `PG_BIN = "/usr/lib/postgresql/16/bin"` (introduced in S05, commit `74933b8`). On any host without that exact layout, all 8 control-plane/integration suites died during collection with `spawnSync .../initdb ENOENT` — an error naming neither the missing prerequisite nor a remedy.

Replaced with `resolvePgBin()`: `SHERA_PG_BIN` override → conventional install locations (Debian, Red Hat, Homebrew, both Windows Program Files layouts) → PATH lookup. When nothing resolves it throws a message naming the env var, the remedy, and every path probed — satisfying **G4** (a missing prerequisite is a clear configuration state, never a raw spawn error). Resolution runs before any temp directory is created, so a missing PostgreSQL no longer strands temp dirs.

`exists` is injected, so the contract is unit-tested on any host (5 tests, no PostgreSQL installed).

### Finding 2 — SQLite temp directories deleted while their handles were still open

Six user-runtime suites opened a container-local database in a `mkdtemp` directory and deleted it in `afterAll` without ever calling `close()`. POSIX permits unlinking an open file, so this passed on Linux. Windows locks the file **and the `-wal`/`-shm` sidecars the handle owns**, so `rmSync` threw `EPERM` and failed suites whose assertions had all passed.

`apps/user-runtime/test/helpers/temp-resources.ts` now registers connections so handles are released before deletion, and retries deletion with a bounded backoff for Windows' lock-release lag. Non-transient filesystem errors still propagate, so cleanup can never mask a real failure. Exhaustion is reported on stderr (never silently dropped, never thrown). Resources are tracked by their `close()` function rather than by importing the driver, which keeps the helper outside the **D23 rule 2** persistence boundary (`pnpm boundary-guards` PASS, 188 files).

<!-- continued in "Alternatives considered" -->
## Alternatives considered

- **Make the 9 PostgreSQL suites skip when PG is absent** — rejected. That is a fake pass (G4): these suites carry the S05 identity/auth assertions, and silently skipping them would remove real coverage from every Windows/macOS run. The prerequisite now fails loudly and actionably instead.
- **Vendor a Postgres binary or use a container for the cluster** — deferred; the S05 harness already records Docker as unusable on this host and Compose infrastructure as an S35 concern. The resolver is the swappable seam.
- **`rmSync` with `maxRetries` alone** — insufficient. Retries cannot help while a handle is open; the release is the fix and the retry is only for lock-release lag.
- **Close every connection in each test's `finally` only** — rejected as the sole mechanism, because a test that throws before its `finally` would still leak. Registry-plus-retry covers both.

## Correction recorded (the first fix was incomplete)

The first fix (`48c1f00`) claimed all 6 SQLite suites were repaired. An adversarial review showed **that claim was materially misleading**: `s09-real-rows` and `s09-message-send` create their database inside `composeLocalApi`, whose handle owns the SQLite connection, and neither suite closed it. The retry loop converted a loud `EPERM` into a silent leak — each suite burned the full retry budget and left a temp directory behind, so the suites passed in exit code only. Fixed in `aaf2be7` via `trackConnection(composed)`.

Verification used a **negative control**: removing only `trackConnection(composed)` returns the suite to 5.3 s and one leaked directory per suite, proving the change is causal rather than cosmetic. Measured suite time 10.45 s → 1.53 s; leaked temp directories 2 → 0.

The same review found `SHERA_PG_BIN` probed only `initdb` and never `initdb.exe`, which meant the override could not work on Windows — the platform the fix targets. Also fixed, with a regression test confirmed to fail when the condition is reverted.

A further verification pass measured the retry budget at ~5 s, not the ~10 s a stale comment claimed, and the comment was corrected. Part of the observed speedup therefore came from the shorter budget rather than from the handle fix alone; the negative control isolates the handle fix as the cause of the leak being gone.

## Verification

| Gate | Result |
|---|---|
| `pnpm lint` | pass |
| `pnpm format:check` | pass |
| `pnpm typecheck` | 10/10 |
| `pnpm boundary-guards` | PASS — 188 source files |
| `pnpm test` | **609 passed, 50 skipped, 9 failed files** (from 604 passed / 15 failed) |

The 6 repaired suites and the 5 resolver tests are green. The 9 remaining failures are the PostgreSQL suites, unrunnable on a host without PostgreSQL 16; they now fail with the actionable configuration message rather than `ENOENT`.

## Explicitly NOT verified

- The 9 PostgreSQL-dependent suites against a real PostgreSQL 16 install. They require the Linux CI runner or a local PG 16 with `SHERA_PG_BIN` set. No acceptance status in [`../TRACEABILITY.md`](../TRACEABILITY.md) changes on the basis of this record.
- No product behavior, acceptance criterion, or decision status is altered by this record.

## Implementation implications

- `SHERA_PG_BIN` is now a documented interface of the S05 harness. Renaming it is a cheap but recorded change, not a silent drift.
- Any future suite that opens a database should register the connection (`trackConnection`) rather than relying on `rmSync` alone.
- The host platform is a first-class review consideration here: every one of these suites was green on the Linux CI runner, so host-portability gaps are invisible to CI as currently configured.

## Real PostgreSQL follow-up, 2026-10-20

Evidence source: owner instruction in the current Codex chat to complete coding one delegated task at a time, followed by parent review and local integration. Task 3 used workspace-local PostgreSQL 16.15 Windows binaries obtained through PostgreSQL.org and EDB; provenance and checks are in `output/sequential-coding-2026-10-20/task-3/EVIDENCE.md`. No global installation or service was created.

The first cluster started successfully but its server inherited captured `pg_ctl` pipes, preventing the synchronous launcher from returning on Windows. The test helper now ignores launcher stdio; PostgreSQL diagnostics continue to use the existing log file. Retaining captured pipes was rejected because the live server holds them open after launcher exit. Implementation boundary and owner: control-plane test harness, coding agent. Product behavior, PRD text, supersession and acceptance statuses do not change.

Both executor and parent independently passed all 834 tests in 84 files against real PostgreSQL, with no skipped tests. Parent evidence: `output/sequential-coding-2026-10-20/task-3/parent-full-suite.log`. This resolves the earlier local PostgreSQL verification gap, including authentication, migrations, provisioning and recovery cases. Actual Docker recreation, Google OAuth, live providers, Pi/Hermes integration and browser acceptance remain unverified.
