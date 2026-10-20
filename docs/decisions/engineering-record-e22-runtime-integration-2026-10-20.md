# E22: Authenticated runtime routing and durable storage

- ID: E22
- Status: Delegated engineering, pending owner review; partially verified
- Date: 2026-10-20
- Evidence source: current Codex chat, owner instructions "Then can you complete the coding part?" and "continue". Local branch dev/complete-prototype, based on S11 commit cc891e44d34cd4287ce62170cf09a411e2d27eb4. Logs: output/implementation-2026-10-20/ in this checkout. No deployment authorization inferred.
- Supersedes: no product decision. Refines implementation of D1, D2, D11, D12, D16, D22 and E12.
- Affected PRD sections: 3.3, 5, 6, 12, 16, 17 and 19. No PRD text or acceptance-status changes.

## Decision and rationale

Browser runtime HTTP commands pass through the web server and authenticated control plane. The session account determines the runtime target and workspace. A shared allowlist limits exposed paths; workspace selectors must match. Message/settings author identity comes from the session. Browser input cannot select an internal endpoint or obtain the channel bearer. Web runtime POST bodies are capped at 64 KiB before forwarding.

Managed runtimes retain the local API and Socket.IO server on loopback. A separate management listener authenticates registration, credential rotation and the narrow forwarded HTTP API. Bootstrap configuration carries a digest only. Committed digest rotation is atomically persisted beside SQLite, preserving the active credential across process restart; a new bootstrap resets the saved set. Registration and workspace are bound to the configured account.

The container specification mounts a stable per-account Docker volume at /app/data for SQLite, Agent files and channel metadata. Container replacement retains it. This is persistence, not backup/restore. Production Agent folder composition now supplies disk-backed storage behind existing guards, rejecting unsafe paths and links. Tests may inject maps. Runtime-owned storage must remain inaccessible to task processes when file tools arrive.

Provisioning holds a per-account PostgreSQL transaction advisory lock. Concurrent attempts receive the existing in-progress error. Process exit releases the lock, allowing stale-status recovery. A running container with lost control-plane credentials is re-provisioned under the existing recovery contract, retaining its data volume. Real PostgreSQL execution is unverified here.

## Alternatives considered

- Browser-selected runtime URLs were rejected because they bypass account routing.
- Exposing the full local router was rejected; management forwarding requires authentication, a narrow allowlist and workspace validation.
- Persisting raw bearers was rejected; runtime storage retains digests only.
- In-memory provisioning locks were rejected because they cannot coordinate processes.
- In-memory production files were rejected because restart discarded them.
- General file tooling and authenticated Socket.IO proxying remain in their existing slices.

## Ownership and verification

Implementation owner: coding agent. Review/release owner: maintainer. Control plane owns sessions, runtime selection and provisioning locks; runtime owns credential checks and local storage; web owns same-origin requests and gated pages. These changes implement existing criteria and introduce none.

Tests cover anonymous/foreign-workspace refusal, trusted authors, request-size bounds, safe errors, real management startup, account-bound registration, credential rotation/restart, folder restart/isolation/link rejection and volume configuration. Type checking, production build, source lint, boundary guards, license inventory and 27 mockup tests pass. The integrated run passed 769 tests, with one extra PostgreSQL-dependent suite failing during setup and three tests skipped. This is not a full-suite pass.

Unverified: full PostgreSQL authentication/provisioning/concurrency suites, Docker volume recreation, Google OAuth, live providers, Pi/Hermes integration and browser visual/keyboard QA. Browser initialization failed twice with a Windows sandbox helper error. Built-website HTTP smoke checks passed; the login markup detector found no issues. Fifteen inherited S11 files fail formatting. No CI run, commit, push or deployment occurred. No acceptance criteria are upgraded.

## Sequential integration follow-up, 2026-10-20

Under the owner's one-agent-at-a-time instruction, the parent independently verified and committed the formatting-only correction as 2aebcc3b2d44453b284d62f22d33e710e42503ee. The earlier 15-file formatting failure is resolved. A second executor reproduced and fixed malformed-payload attribution crashes and local-bind cleanup leaks; parent review corrected the array regression fixture and required typed 400 passthrough. Parent validation now passes 772 tests in 72 suites, source lint/format, all package/root type checks and production build. Evidence: output/sequential-coding-2026-10-20/. PostgreSQL, Docker and browser acceptance remain open.
