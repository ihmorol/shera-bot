# Sequential coding ledger

Owner instruction, 2026-10-20: delegate one sub-agent, wait for completion, independently check/review/integrate, then delegate the next. Maximum one active child. Existing work on dev/complete-prototype is preserved. Integration means local reviewed commits on this working branch; release and main-branch readiness still require their recorded verification gates.

## Task 1: S11 source formatting gate

Owner: /root/s11_format_gate. Scope: exactly the 15 inherited files in output/implementation-2026-10-20/source-format-check.log. Formatting only, no behavior changes. Acceptance: whitespace-only diff, source formatting gate, relevant S11 tests and independent parent checks. Status: delegated; review/integration pending. Parent baseline HEAD: cc891e44d34cd4287ce62170cf09a411e2d27eb4. Existing uncommitted integration/security/persistence work is outside this task.

## Next task selection

Select only after Task 1 review/integration. Address remaining concrete correctness/security issues before dependent product slices. Full outstanding scope remains docs/BUILD_MAP.md and output/implementation-2026-10-20/progress.md. A green formatting gate alone does not complete S11 or the product.

Task 1 review PASS and integrated locally: 2aebcc3b2d44453b284d62f22d33e710e42503ee. Parent independently compared every task file to formatting of the pre-task HEAD, then passed source formatting, lint and 84 tests. No remote/main merge claimed.

## Task 2: Runtime request and startup boundaries

Owner: /root/runtime_boundary_completion. Ownership: control-plane runtime API proxy/test and runtime bootstrap/tests. Scope: malformed message attribution and startup-failure resource cleanup. Preserve prior uncommitted integration work; no staging/commits by child. Acceptance: red/green regressions, parent diff review, relevant tests/type checks, then one local integration commit including required baseline dependencies. Status: delegated, review pending.

Parent review preparation: verified server-derived endpoint/credential selection, account-bound management registration and workspace checks, digest-only rotation persistence, runtime-owned Agent-folder path/link rejection, and stable-volume wiring. PostgreSQL execution and actual Docker recreation remain unverified.

Task 2 parent review PASS and integrated locally: ca11ef54e65a6321d18f15652c1e46ef8a1b62e7. Regression fixture corrected during review. 772 tests/72 suites, source lint/format, typecheck and production build passed. Parent reviewed the required prior integration dependencies before staging them with this completion. PostgreSQL/Docker/browser gaps remain explicit. No main/remote merge claimed.

## Task 3: Real PostgreSQL validation

Owner: /root/postgres_validation. Baseline ca11ef54e65a6321d18f15652c1e46ef8a1b62e7. Scope: official workspace-local PostgreSQL 16 Windows binaries, isolated test environment, bounded host-portability repairs in existing PG helper/resolver tests only. Acceptance: official source/version receipt, actual cluster smoke, actual database-suite outputs and cleanup; parent reviews any source patch and independently reruns a meaningful subset before integration. No global installs, services or new npm dependencies. Status: delegated; parent review pending.

Task 3 parent review PASS and integrated locally: bc8efbbd04a7e5791938b437b3942b59433cad68. Parent independently passed all 834 tests in 84 files against PostgreSQL 16.15, checked the inherited-pipe fix and lint/diff checks. Evidence: task-3/EVIDENCE.md and task-3/parent-full-suite.log. Database setup is workspace-local. No main/remote merge claimed.

## Task 4: Authenticated live transport

Owner: /root/authenticated_live_transport, sole active child. Baseline bc8efbbd04a7e5791938b437b3942b59433cad68. Scope: same-origin browser WebSocket routing through authenticated account-selected control plane and management channel, managed workspace enforcement, expiry/signout lifecycle and meaningful transport regressions. No dependencies, main merge or deployment. Parent owns independent review, cross-layer smoke and final integration; no later task starts first. Status: implementation in progress.

Task 4 resumed after usage-limit interruption by owner instruction. Only /root/authenticated_live_transport was resumed; other task owners remain inactive until parent review/integration. Parent login browser smoke passed at 360/768/1440; evidence parent-browser/EVIDENCE.md. Authenticated pages remain outside that smoke.

Parent Task 4 preparation found and reproduced B19 (actual CP missing JSON parsing) and B20 (Next internal origin rejects legitimate browser POST). Both assigned to the active child as necessary chat-send dependencies, with regressions required; evidence parent-browser/findings.md and the before-task-4 JSON receipts. Reset draft issue remains unconfirmed.

Next queued task after Task 4 integration: B21 stale settings drafts after reset, reproduced in real browser (parent-browser/settings-reset-localhost-results.json). Task 4 scope stays on authenticated transport and its HTTP-send prerequisites.

## Failed-agent recovery queue

Owner's newest instruction: continue the interrupted work and resume failed agents from their checkpoints, retaining sequential delegation. /root/authenticated_live_transport was resumed first. Do not restart completed responsibilities just because an older owner failed: formatting is integrated in Task 1; runtime boot/storage/folder repairs were reviewed in Task 2; PostgreSQL validation completed in Task 3. The existing release audit is preserved. Pi integration research and remaining S11/S12 product work remain queued after the active transport task and reproduced settings repair, subject to their documented source/license/dependency boundaries. No other child is active.
