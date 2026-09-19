# E17 — S03 Pi supervision seam and SQLite driver decision

Part of the decision records. Index and provenance: [`README.md`](README.md). Previous record: [`engineering-record-e16-2026-09-17.md`](engineering-record-e16-2026-09-17.md).

**Status:** Delegated engineering record (pending owner review) — decided by the agent while executing slice **S03** (issue #4) under the same 2026-09-17 build delegation recorded in E16; owner review pending.
**Date:** 2026-09-19.

**Evidence (exact sources):**
- Issue #4 (S03) — the slice's acceptance criteria and its two engineering questions.
- Supervision spike runs of 2026-09-19 on this host (Linux 7.0.0-31-generic x86_64, Node v24.21.0, fake Pi stub only, no network, no model calls): raw console output preserved at [`../../spikes/d13/results/supervision-2026-09-19.txt`](../../spikes/d13/results/supervision-2026-09-19.txt) with the machine-readable run at `spikes/d13/results/supervision-2026-09-19T16-28-28-846Z.json` (5 iterations per timing scenario, 3 per backpressure scenario, per-iteration stub emit logs and supervisor journals preserved under `spikes/d13/results/run-*`).
- SQLite driver comparison runs of 2026-09-19 on the same host: raw console output at [`../../spikes/d13/results/sqlite-2026-09-19.txt`](../../spikes/d13/results/sqlite-2026-09-19.txt) with the machine-readable run at `spikes/d13/results/sqlite-2026-09-19T16-31-38-966Z.json` (per-case databases preserved under `spikes/d13/results/sqlite-run-*`).
- D13 (Confirmed, provisional for the prototype), D14 (JSONL over stdin/stdout), D10 (SQLite WAL, repository interfaces, busy timeout), D24 (Drizzle; SQLite via `node:sqlite` initially "subject to the runtime spike"), E11 (backup mechanism — "final call at the D13 spike"): [`confirmed-decisions.md`](confirmed-decisions.md), [`open-items-decisions-2026-09-17.md`](open-items-decisions-2026-09-17.md).

## Decision

1. **Supervision seam: Variant A — Pi as a child process with versioned JSONL over stdin/stdout (D13/D14 validated as recorded for the prototype).** D13's provisional status is thereby resolved as **"validated as recorded"**: no deviation from D13 or D14 is introduced. The sidecar alternative lost on measured grounds (below) and remains preserved as a named alternative.
2. **SQLite driver: `node:sqlite` (bundled in Node 24) as the D24 SQLite driver for the prototype**, validating D24's recorded initial choice. All D10 requirements were exercised against it and passed (below).
3. **E11 final call — backup mechanism: `VACUUM INTO` + `PRAGMA integrity_check` on the copy.** This is the "final call at the D13 spike" E11 deferred: node:sqlite exposes no online-backup API (feature-detected, absent in Node v24.21.0), and the measured `VACUUM INTO` path (85.6 ms for a 4.85 MB WAL database, integrity `ok`, row counts equal) is well inside the PRD §12 six-hour schedule. E11's other alternative (the driver-native online backup facility) is what better-sqlite3 would have offered; it is preserved below as part of the losing alternative, not deleted.

## Measured results (medians; full distributions in the evidence files)

### Supervision (metric × variant; both variants share one contract, one supervision core, one scenario battery)

| Metric (how produced) | A: JSONL stdio child | B: loopback HTTP sidecar |
|---|---|---|
| Cold start → ready (spawn + ready handshake, 5 runs) | 135.05 ms | 195.44 ms |
| Time-to-first-token, cold prompt (20 ms stub TTFT delay included, 5 runs) | 29.98 ms | 30.37 ms |
| Time-to-first-token, warm session (second prompt, live process, 5 runs) | 25.86 ms | 27.90 ms |
| kill −9 mid-stream: crash-detection latency (`exit`/hangup vs kill request, 5 runs) | 4.90 ms | 6.09 ms |
| kill −9 mid-stream: durable message loss (stub emit log vs supervisor journal, 5 runs) | 0 tokens | 0 tokens |
| kill −9 mid-stream: restart latency (new process, same session, 5 runs) | 140.42 ms | 198.85 ms |
| Tokens missing after cursor-based recovery (must be 0) | 0 of 200 | 0 of 200 |
| Hung-process detection window (watchdog 500 ms, 50 ms poll; stub stops tokens + heartbeats, 5 runs) | 522.53 ms | 523.95 ms |
| Backpressure: source-side `write() === false` events observed by the fake Pi (1.6 KB tokens, 25 ms/token consumer, bounded queue 50, 3 runs) | 12 (producer genuinely pauses via `drain`) | 0 (fetch/undici buffers client-side; no TCP backpressure propagation) |
| Backpressure: supervisor queue peak / pause / resume | 82 / 58 / 4 | 64 / 43 / 4 |
| Backpressure: token loss (must be 0 after end-to-end drain) | 0 | 0 |
| Transport-specific caller code (non-blank, non-comment lines) | 140 (`variant-a.ts`) | 226 (`variant-b.ts`) |
| Stub host code | 63 | 97 |

Scenario method: identical fake-Pi engine under both transports; loss = stub's synchronous emit log minus the supervisor's durable journal; restart re-prompts from the journaled cursor (`from_seq`); the heartbeat watchdog fires on protocol-event silence (heartbeats feed it); both stubs bind/attach loopback-only (A: OS pipe; B: `127.0.0.1` HTTP) with zero network calls.

### SQLite drivers (same scenario set, same machine, same SQLite semantics; drivers differ in API and defaults)

| Requirement (how produced) | node:sqlite (Node v24.21.0, engine 3.53.4) | better-sqlite3 12.4.1 (engine 3.50.4) |
|---|---|---|
| WAL mode (set via `PRAGMA journal_mode=WAL`, verified again after reopen) | wal → wal → wal | wal → wal → wal |
| Explicit migrations (versioned `schema_migrations` runner; second run applies 0) | pass | pass |
| Foreign keys, default state (orphan insert on a fresh connection) | rejected | rejected |
| Foreign keys, explicit `PRAGMA foreign_keys=ON` (D10 requires explicit) | rejected | rejected |
| busy_timeout 0 ms under a held write lock (second writer in a child process) | SQLITE_BUSY at 0.38 ms | SQLITE_BUSY at 0.43 ms |
| busy_timeout 100 ms (hold 300 ms) | SQLITE_BUSY at 101.7 ms | SQLITE_BUSY at 103.7 ms |
| busy_timeout 5000 ms (hold 300 ms) | blocked, then succeeded | blocked, then succeeded |
| Throughput context: 20 000 prepared inserts, one transaction | 134 954 rows/s (148.2 ms) | 166 446 rows/s (120.2 ms) |
| E11 backup: `VACUUM INTO` (4.85 MB source) | 85.58 ms | 27.71 ms |
| E11 backup: `PRAGMA integrity_check` on the copy + row-count match | ok, 20 000/20 000 | ok, 20 000/20 000 |
| Driver-native online backup API (feature-detected) | absent | present (27.84 ms, integrity ok) |
| Dependency footprint | none (Node builtin) | native module; requires build-script approval and ABI-matched binaries (the `allowBuilds` approval friction was hit live in this spike before the benchmark could run) |

Contention method: because both drivers are synchronous, writer 2 runs in a child process while writer 1 holds `BEGIN IMMEDIATE` for 300 ms in the parent; the child sets `PRAGMA busy_timeout` itself and reports wait/outcome. The 5000 ms waits (~135 ms / ~183 ms observed) end when the parent commits — the child's clock starts after its own process startup, so the observed wait is the remaining hold time, which is the honest measurement.

## Rationale

**Variant A.** Equal or better on every measured axis that matters to the gateway: comparable TTFT and stream throughput, faster and simpler crash detection (kernel exit event vs hangup inference), faster restart (one process hop fewer), 86 fewer transport-specific caller lines (140 vs 226 per the table above) plus a simpler stub, and — the decisive differentiator — end-to-end backpressure: with a slow consumer, variant A's OS pipe actually signals the producer (`write() === false`, producer pauses until `drain`), so memory stays bounded at both ends; variant B's fetch/undici reader absorbs the pause in user space (0 source-side signals at prototype scale), converting slow consumers into unbounded caller-side buffering that no supervisor queue can see. Variant B's remaining value is architectural (a stand-in for remote/multi-container gateway topologies) and is preserved as the named alternative for that future need, not discarded.

**node:sqlite.** D24 already named it "initially, subject to the runtime spike," and the spike validates every requirement that actually matters: WAL (persists across reopen), explicit idempotent migrations, foreign keys enforced (by default *and* explicitly — both drivers default FK on, which the spike measured instead of assuming), and busy_timeout honoured under real cross-process contention in all three timeout regimes. Its throughput is ~23 % behind better-sqlite3 on this micro-benchmark (135k vs 166k inserts/s), which is irrelevant at prototype product-state scale (one user container, short transactions, single persistence coordinator per D10). It wins on what the prototype cannot afford to carry: zero native dependencies — no build-script approvals, no ABI breakage across Node upgrades, no supply-chain surface — consistent with the E15 leverage policy. The engine version skew (3.53.4 bundled vs 3.50.4 in better-sqlite3 12.4.1) is noted and favours node:sqlite.

**E11 final call.** With node:sqlite, the online-backup facility E11 first named is unavailable, and the measured `VACUUM INTO` path satisfies E11's actual requirements: consistent copy (row counts and integrity verified at snapshot time), far inside schedule. E11's restore drill at Stage 7 is unchanged. The backup copy is produced with the source's WAL mode not carried over (measured: the copy opens in `delete` journal mode), so the restore procedure must set WAL explicitly after replacement — recorded in implementation implications.

## Alternatives considered (preserved)

- **Variant B — loopback HTTP sidecar:** rejected for the prototype supervision seam (see rationale; 0 source-side backpressure signals, +2 startup hops, +86 caller lines, slower restart). **Kept alive** as the candidate seam if Pi supervision ever crosses a container or host boundary (remote gateway topology), which variant A's pipe cannot do. Nothing in this record forecloses it there.
- **better-sqlite3 12.4.1:** rejected for the prototype driver role. It measured faster (inserts and scans), carries a driver-native online backup API, and passed every D10 requirement — it lost on dependency footprint and the operational friction of native builds (observed during this very spike: the missing native binding silently produced "built" state claims and required an `allowBuilds` approval to fix), not on capability. If prototype workloads ever outgrow node:sqlite's throughput, or an online-backup API becomes required, switching is contained behind D10's repository interfaces.
- **Drizzle over better-sqlite3 with node:sqlite dropped from D24:** rejected — changes D24's recorded choice without a measured need; D24's node:sqlite clause was written exactly for this spike to settle.
- **Litestream-style replication for backups (E11):** unchanged — production-gated by E11, not re-litigated here.
- **Longer-horizon supervision features** (process-tree kill, checkpoint/restore under D32): out of spike scope; S07/S12 build on this seam and must exercise them against the real Pi.

## Affected PRD sections

§22.3 (S03 engineering-todo entry — supervision seam and SQLite driver question settled by measurement). No PRD text changes were made or needed; this record resolves the provisional markers recorded in the decisions register (D13, D24's node:sqlite clause, E11's deferred final call) — cross-references added to D13's status line and TRACEABILITY, per the documentation rules.

## Implementation implications

- S07 (runtime gateway) implements the Pi adapter as variant A: versioned JSONL over stdin/stdout, strict `\n`-only framing with partial-line flush on stream end, correlation IDs, `ready`/`heartbeat`/token/`completed`/`fatal` event floor (D14's full vocabulary on top), heartbeat watchdog (500 ms class), cursor-based resume (`from_seq`), bounded queue with source pause/resume, SIGKILL-then-restart recovery, protocol violations recorded not ignored.
- Backpressure must keep the two ends distinct in design and tests: supervisor-side bounded queue (pause the source at the bound, resume at half) and source-side pipe signal handling (`write() === false` → suspend until `drain`). The spike's shared supervision core (`spikes/d13/src/supervision-core.ts`) is the reference behaviour, deliberately light; the production version belongs in `apps/user-runtime` + `packages/pi-protocol` per the slice plan.
- S07/S12 wire the SQLite persistence through Drizzle on node:sqlite: open → `PRAGMA journal_mode=WAL` + `PRAGMA foreign_keys=ON` explicitly (D24 rule, measured harmless), versioned migrations in transactions, `PRAGMA busy_timeout` plus bounded retry per D10, short transactions.
- The E11 backup service uses `VACUUM INTO` on the live WAL database, then `PRAGMA integrity_check` and a row-count verification on the copy before recording snapshot metadata; a restored database re-executes `PRAGMA journal_mode=WAL` and the pending migration check (E11's "test backup restoration followed by migration" applies unchanged).
- No production dependency is introduced by this slice: the spike's `better-sqlite3` devDependency stays inside `spikes/d13/` (isolated pnpm workspace, its own lockfile); no spike file is imported by `apps/*` or `packages/*`.

## Verification coverage

- Both variants run with one documented command each against the fake Pi only: `node src/bench-supervision.ts` (from `spikes/d13/`; flags `--iter N`, `--iter-backpressure N`) — acceptance met; no network calls; variant B binds 127.0.0.1 only.
- SQLite comparison runs with one command: `node src/bench-sqlite.ts` — acceptance met; no dependencies beyond the spike package's existing ones.
- Raw outputs and per-iteration artifacts preserved under `spikes/d13/results/` (supervision: 5 iterations/scenario, 3 for backpressure; sqlite: per-case databases). Everything under `spikes/` is committed as evidence.
- Root workspace baseline re-verified after the branch fast-forward to `f19ee52`: `pnpm install --frozen-lockfile` clean; `pnpm test` 196/196 passing (15 files) — the count includes S05's tests merged into main, superseding the 182 figure quoted in the slice brief.
- **Not verified in this spike:** real Pi behaviour (fake stub only, by design — D14's fake-Pi test rule); Windows/macOS pipe and signal behaviour (Linux only); multi-writer SQLite contention beyond the three timeout regimes; VACUUM INTO at production database sizes (4.85 MB measured); Drizzle-on-node:sqlite integration (D24 names the driver; the ORM wiring is S07 work); the exact watchdog/busy-timeout production values (measured classes here, tuning deferred to S07 recovery tests); supervisor-process death (the kill −9 loss row kills the stub while the supervisor survives — the journal is the supervisor's own appendFileSync path; in all measured iterations the kill landed at a quiet boundary with zero tokens in flight, so loss-prevention is evidenced by cursor re-emission — 200/200 distinct tokens — not by an in-flight-loss measurement).

## Open items this record leaves standing

1. **Owner review of this Delegated record** — the supervision seam (A), the driver (node:sqlite), and the E11 final call (`VACUUM INTO`) all remain Delegated until reviewed, per the same rule as E16.
2. `docs/decisions/README.md` record-count line and index still say E1–E16; this slice's scope constraint confined register edits to D13's status line and the TRACEABILITY row, so the index update is left to the next doc-touching slice (surfaced here rather than done silently).
