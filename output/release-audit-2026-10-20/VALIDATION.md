# Validation evidence, 2026-10-20

Target: isolated `git archive` of live-main commit `42ddc798115665b9976093f24ffd930f8ababd87`.
Environment: Windows; Node v24.19.0; pnpm 12.4.1. Product source and user's checkout were not edited.

| Check | Fresh local result | Log |
|---|---|---|
| Frozen dependency install | Pass. Initial offline install lacked cached tarballs; frozen online install succeeded without dependency changes. | `install.log`, `install-online.log` |
| Lint | Pass | `lint.log` |
| Formatting | Pass | `format-check.log` |
| Typecheck | Pass, ten package tasks and root check | `typecheck.log` |
| Architectural boundary guards | Pass, 191 source files scanned | `boundary-guards.log` |
| License inventory | Pass under current policy; sharp binary exception still pending owner review | `license-inventory.log`, `source/artifacts/license-inventory.json` |
| Product tests | Incomplete overall: 61 files passed, nine failed setup; 645 tests passed, 50 skipped. PostgreSQL 16 server binaries unavailable. Two failed-setup cleanup hooks also waited until their 180s timeout. | `tests.log` |
| Mockup regression | Pass, 27 tests | `mockup-tests.log` |
| Production build | Pass, actual Next.js routes built | `build.log` |
| Running-build HTTP smoke | Pass as a defect reproducer: B01, B02, B05 observed | `smoke.mts`, `smoke.log` |

The smoke starts the real runtime bootstrap and built web server on ephemeral loopback ports, configures the web runtime proxy, and uses a disposable audit SQLite file. It observes:

- `/login` has a disabled Google sign-in button.
- `POST /internal/v1/registration` on the real runtime responds 404, confirming the authenticated registration API is not mounted.
- An anonymous `POST /api/runtime/v1/conversations/commands` with a caller-chosen workspace creates a conversation with HTTP 200. This is an observed missing authorization boundary, not a hypothetical future gap.

First smoke attempt incorrectly expected `/internal/v1/health` to be absent. It returned 200 because the local API deliberately implements a health probe. The assumption was corrected to the actual registration endpoint, then the full smoke passed. The first attempt's assertion failure and Windows shutdown assertion are preserved in `smoke-first-attempt.log`; they are not counted as product defects. The corrected script awaits server-process exit before runtime shutdown.

The nine PostgreSQL-dependent suites are not classified as nine product bugs. Install/configure real PostgreSQL 16 (`SHERA_PG_BIN`) or use the Linux environment and rerun them for a full fresh local result. Separately, the failed-setup teardown path should not hang when required dependencies are missing.

Live GitHub CI was inspected on 2026-10-20: run 37586953882 completed successfully on 2026-10-07 on this exact main SHA, including full Linux verify, license, and mockup jobs. CI evidence is historical execution on the current source commit; fresh local Windows execution above has its own stated limit.

Not performed: real OAuth consent with credentials, paid/live-provider calls, Docker/container deployment (Docker executable unavailable on this host), two real user accounts, full browser matrix, visual/accessibility QA, restore/rollback drills, penetration testing, or load/24h soak. No claim of production safety or complete acceptance follows from these checks. No new dependency, product fix, deployment, tag, release, or merge was made.
