# Coding progress, 2026-10-20

Partial implementation. Not ready to publish. Changes are local and uncommitted on dev/complete-prototype, based on the unmerged S11 branch. S11 is not declared complete or merged. Product backlog authority remains docs/BUILD_MAP.md and issues #2-#36.

## Implemented in this batch

- Sign-in navigation and gating of nested private pages; session-derived chat attribution.
- Session-derived runtime HTTP routing, workspace checks, shared allowlist, authenticated message/settings authors and bounded command bodies.
- Authenticated management listener wired into startup, account-bound registration and digest rotation surviving process restart.
- Stable per-account container volume specification; lost-credential provisioning recovery and PostgreSQL advisory serialization.
- Disk-backed private Agent files behind existing guards, surviving runtime reconstruction; traversal/link/isolation checks.
- Recognized Express error handler with safe responses; proxy support for empty responses.

## Fresh verification

- integrated-tests.log: 769 tests passed in 71 suites. One extra PostgreSQL-dependent suite failed during setup, leaving three skipped tests. No full-suite pass claimed.
- typecheck.log: ten package checks and root check passed. build.log: production build passed.
- lint.log: source-scoped lint passed. Changed-file formatting passed.
- source-format-check.log: 15 inherited S11 files still fail formatting.
- Boundary guards: 217 source files passed. mockup.log: 27/27. licenses.log: passed with its existing owner-review exception.
- built-web-smoke.json: actual built HTTP login/private routes and typed API refusals passed. Boot, registration, credential restart and file persistence use real HTTP/SQLite in tests.
- entrypoint-smoke.json: actual runtime process entrypoint returned authenticated health 200 and anonymous health 401; owned smoke servers were stopped.
- Browser tool initialization failed twice with a Windows sandbox helper error. Visual, responsive, keyboard and reduced-motion QA are unverified. ui-detector.json: no login markup findings.

## Remaining work, in dependency order

The exhaustive baseline findings and per-slice acceptance gaps remain in ../release-audit-2026-10-20/RELEASE-READINESS.md. Related code changes alone do not close those findings.

1. Complete/review S11: formatting, full Agent settings/direct-chat/folder acceptance, provider-dependent reset behavior and browser QA.
2. Secure per-account Socket.IO routing and deployed reconnect/replay. The new proxy implements HTTP only.
3. Real PostgreSQL suites, including stale status, credential loss and cross-process concurrency; actual Docker volume replacement. These require PostgreSQL 16 and Docker prerequisites absent here.
4. S12-S16: Operation membership/lifecycle, preview/confirmation, subagent runs, real Pi/Hermes integration, worker supervision/concurrency and task lifecycle. Preserve D51 source/license constraints. Mocks/spikes do not satisfy integration.
5. S17-S27: workspace/files/terminal, approval/grant enforcement, providers, credit reservation/settlement, tools and sandbox/security. Unfinished surfaces still contain fixtures.
6. S28-S33: scheduling, scoped memory publication, checkpoints/recovery, admin operations and verified backup/restore. Volumes are not backups.
7. S34-S35: all 27 acceptance criteria; security/recovery/E2E; images, VM configuration, OAuth/secrets/TLS, notices/runbooks and restore drill. Website deployment follows these gates. Desktop distribution needs a packaging decision after the web prototype works.

Unknown bugs may remain. Passing tests and merged-slice counts do not establish a percentage of coding complete. No deployment, paid calls, credentials, releases or external messages were used.

Sequential follow-up: 15-file formatting gate repaired and integrated as 2aebcc3. Runtime boundary fixes reviewed; fresh parent checks pass 772 tests, source lint/format, typecheck and production build. The prior formatting failure above is historical and resolved. See ../sequential-coding-2026-10-20/ledger.md.

2026-10-20 Task 3 follow-up: real PostgreSQL is now available locally. Executor and parent independently passed the complete 834-test/84-file suite, including the database-dependent tests. The Windows launcher inherited-pipe hang is repaired in the test helper. This supersedes the earlier PostgreSQL-unavailable checkpoint only. See the sequential ledger and task-3 evidence.
