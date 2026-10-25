## S06 — Container provisioning, runtime registration, authenticated internal channel (issue #7)

**Slice:** S06 of 35 (parent tracker #1). **Branch:** `s06-container-provisioning`, HEAD `254d3cd`. **Sensitive slice** — security review pass included; owner scrutiny (P9) remains an explicit open item below.

### What landed

- **D12 `RuntimeBackend` contract** (`packages/contracts/src/runtime.ts`): `provisionRuntime` / `resumeRuntime` / `stopRuntime` / `getRuntimeStatus`, typed `RuntimeBackendFailure`, tier-limit constants matching PRD §3.3 exactly (Light 1 vCPU/2/10, Balanced 2/4/25, Heavy 4/8/50 GB→GiB), runtime internal metadata typed TS-only (never in the OpenAPI contract — the frontend never learns container IDs, host paths, or internal ports).
- **`LocalContainerBackend`** (`apps/control-plane/src/runtime/local-container-backend.ts`) + **container spec builder** (`container-spec.ts`): the only two files speaking engine vocabulary (D23 rule 2, enforced by the portability grep test). Tier limits applied as hard engine limits (`NanoCpus`, `Memory`, `MemorySwap=Memory` — no swap headroom); no `Binds`, no `PortBindings` (their absence is the D27 isolation property, asserted by test and by the TS type); management network only; liveness probe is a namespace-internal loopback TCP connect.
- **Idempotent lifecycle with adopt-vs-recreate semantics**: deterministic per-user container name is the idempotency key. On name conflict: an owned container whose credential digest matches this call's token is **adopted** with its existing handle (handle continuity); an owned container with a mismatched digest is **recreated** (credential recovery; volume-less, so recreation is lossless); a foreign-owned container is never adopted or removed — typed `RUNTIME_TENANT_MISMATCH`.
- **Authenticated internal channel** (D2, PRD §16): 256-bit URL-safe bearer token per container; DB stores the SHA-256 digest only; the container env receives the digest only; runtime gateway (`apps/user-runtime`) verifies in constant time (`timingSafeEqual` over fixed-length digests) **before** any command (G2, OpenClaw gateway auth shape); rotation = stage new digest (current credential) → commit (new credential, old pruned immediately), bounded at two digests, fail-closed; rejections recorded as security events on both sides.
- **Control-plane records** (drizzle migration `0002`, additive): user→container mapping, tier, provisioning state, health summary, runtime endpoint, token hash + rotated-at. Account targeting is session-derived only on every route (no account/handle parameters; proven by the cross-tenant integration test).
- **Web-facing responses leak nothing** — asserted, not inspected: all 10 reachable routes scanned (body + headers) for token, container ID/ref, internal endpoint/port, image name, `/var/run/`; server log scanned; typed 401s scanned too.

### Verification (orchestrator, fresh `git archive HEAD | tar -x` on pinned toolchain, HEAD `254d3cd`)

| Gate | Result |
|---|---|
| `pnpm lint` | pass |
| `pnpm format:check` | pass |
| `pnpm typecheck` | 10/10 tasks pass |
| `pnpm test` | **296/296 pass** (23 files) — regression budget was 196; S06 adds 100 |
| `pnpm build` | pass |
| `pnpm license:inventory` | pass, no drift |
| `pnpm mockup:test` | **27/27 pass** |

CI: Actions runs on recent pushes fail in ~4s with "The job was not started because recent account payments have failed or your spending limit needs to be increased" (billing/spending-limit block, same as recorded on PR #37). Local fresh-archive evidence above stands in, per the recorded process note in DEV_WORKFLOW.

### Review record (fresh-context, three reviewers + fix round + delta re-verification)

Implementer HEAD `86694bb` was reviewed by **Standards** and **adversarial Spec** reviewers; findings (1 BLOCK, 3 FIX-THEN-MERGE) were fixed red-first in commits `09d04f1`, `7f81764`, `313a627`, `254d3cd`:

- **FIX A (was BLOCK)** — adoption-path handle discontinuity: re-provision over an existing container returned a freshly minted handle while the adopted container kept its old label (and its old credential digest), permanently bricking the runtime after provision-after-stop while reporting success. Now: adopt requires digest match + account label match + well-formed handle label (returns the container's existing handle); otherwise recreate; foreign-owned containers untouched (typed mismatch). Invariants asserted by new tests: handle continuity, channel-works-immediately, cross-tenant guard.
- **FIX B** — crashed-provision wedge (status `provisioning`, no handle, after a control-plane crash) is now documented at the guard: truthful errors, no fake success; bounded recovery (staleness rule / lease / reaper) is owned by S07/S12 supervision (E17 seam).
- **FIX 3** — concurrent first login: the mapping-insert unique violation (SQLSTATE 23505) is retried once with a re-load instead of surfacing as a 500.
- **FIX 1** — portability grep now actually scans the channel code (`channel-client.ts`, `channel-token.ts`) and the app entry, with vacuous-pass assertions; app-entry comments reworded engine-neutral.

**Security review (post-fix tree): VERDICT MERGEABLE, zero BLOCK.** Credential lifecycle clean (raw token exists in memory + registry redaction only; digest to DB/container; nothing in logs/events/responses/OpenAPI); tenancy clean (session-only targeting; ownership check before any removal); rotation protocol clean (fail-closed, bounded, persisted only after commit); fix-round seams not attacker-influenceable. Notable NOTEs recorded for later slices: internal API lacks a typed error middleware (untyped HTML 400/404 with stack under non-production NODE_ENV — add in S35 image or a follow-up); one stage-success/commit-failure wedges rotation until restart (recommend stage-replaces-uncommitted-staged-digest in S07); runtime trusts registration payload fields — S07 must re-verify bindings before using them for authorization decisions; real engine path + listener posture re-verification owned by S35.

**Standards + Spec re-verification of the fix delta:** see the merge-record comment (appended after their re-review).

### Adopted dependencies (E-note)

- **dockerode `5.0.1`** (Apache-2.0) — runtime dep of `@shera-bot/control-plane` only; sole import site is the sanctioned adapter file. `@types/dockerode 4.0.1` (MIT, dev). `pnpm-workspace.yaml` `allowBuilds` disables build scripts for transitive `ssh2` / `protobufjs` / `cpu-features` (reviewed: protobufjs postinstall is a no-op version warning; ssh2 install.js builds optional native acceleration unused by this slice) — reduces supply-chain script surface, no functional downside.
- `apps/user-runtime` gains `express 5.2.1` + `@types/express 5.0.6` + workspace contracts.
- Coder docs used **pattern-only** (AGPL — nothing copied). OpenClaw gateway/client auth shape adopted as the deterministic pre-command credential check.

### NOT-VERIFIED (honest list)

- Real engine behavior of create/adopt/recreate (409 semantics, env inspection, force-remove) — no container daemon on this host (recorded constraint in the backend header); exercised via a stubbed engine client behind a constructor seam; **real verification owned by S35 (Compose)**, which must also re-verify D27 at the engine level (no published ports, management-network-only, listener posture).
- True parallel concurrent-provision race — covered via deterministic violation injection, not live parallel requests.

### Owner items (open)

- **P9 owner scrutiny** of this sensitive slice (tenancy boundary, credentials, isolation) — delegation waives review bottlenecks, never scrutiny of auth/migrations/isolation.
- CI Actions billing/spending-limit (runs still fail to start as of 2026-09-19; will confirm on this PR's first push).
- Storage tier limit is recorded as a label, not engine-enforced (storage-driver property; honestly declared in the contract + tests).
- Crashed-provision wedge recovery and rotation stage/commit window hardening → S07/S12 supervision (E17 seam), recorded in code comments.
