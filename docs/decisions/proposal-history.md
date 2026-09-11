# Shera Bot — Proposal and Alternative History (P1–P9)

**Status:** Historical proposal record; not a new decision source.  
**Index:** [`README.md`](README.md)  
**Final dispositions:** [`closure-decisions.md`](closure-decisions.md)  
**Purpose:** Preserve the recommendations, alternatives, rationale, objections, and final disposition that were drafted while closing the Codex grilling session. The grilling rule is important: a proposal is not a product decision until the product owner answers it or an already-authoritative PRD clause settles it.

## P1 — Terminology

**Problem:** The session used “Expert” for the user-facing identity and “agent” for the technical process, while the PRD used “agent” throughout. Leaving both as current vocabulary would create schema, pack, UI, and documentation drift.

**Alternatives considered:**

1. **Agent everywhere:** UI, docs, code, schemas, database columns, and pack manifests all use Agent; keep Operations as the product framing.
2. **Expert everywhere:** use Expert in product and implementation identifiers, including `expert_id` and `experts/` pack directories.
3. **Expert in UI, agent in code:** product copy says Expert/Operation while TypeScript, schemas, database, and pack YAML say `agent`/`operation`.
4. **Agent in UI and code but remove Operations:** rejected because it would drop the user's chosen Operation framing.

**Recommendation at the time:** option 3, because it aligned with the PRD and agent-framework terminology while giving the product a more approachable term.

**User outcome:** The user explicitly corrected this: **Agent everywhere; do not drop the Operation framing; Operation → Agents.** Recorded as D44. The historical recommendation is retained here to explain the change.

## P2 — Concurrency and admission

**Problem:** Multiple Agents and task workers may compete for one user's CPU, memory, process count, disk, and provider capacity. The system needs to protect healthy long-running work without making resource exhaustion invisible.

**Alternatives considered:**

1. Kill or preempt work when capacity is exceeded.
2. Allow unrestricted parallelism and let processes fail naturally.
3. Queue new work while preserving healthy running and approval-waiting work; hibernate idle Agent sessions under pressure.
4. Serialize all Agent work to avoid resource contention.

**Recommendation:** option 3. It preserves the PRD's full-parallelism goal while honoring D32's rule that an active task is governed by its task lifecycle, not by a chat idle timer.

**Final disposition:** Already substantially decided by PRD §6 and refined as E1. This is an engineering admission policy, not a new product choice.

## P3 — Event retention and cursor fallback

**Problem:** D26 requires durable replay cursors, but high-volume streamed deltas could grow the local event journal indefinitely. Clients also need a deterministic behavior when their cursor is older than retained events.

**Alternatives considered:**

1. Retain every event forever, including every token delta.
2. Keep only current state and reload all history after reconnect.
3. Retain the journal for the container lifetime, compact low-value high-volume deltas under an explicit size policy, keep conversation content durable, and return a state snapshot plus a new cursor when a cursor is outside retention.
4. Use Redis Streams as the long-term event source.

**Recommendation:** option 3. It preserves auditability and replay while preventing transport-level deltas from becoming the only storage growth driver.

**Final disposition:** E2, engineering-level extension of D26. Exact thresholds remain implementation-defined and are listed as open in `TRACEABILITY.md`.

## P4 — Approval reminder ownership

**Problem:** The PRD specifies reminder times and muting, but the owner of reminder scheduling and the distinction between a reminder and a new task were not explicit.

**Alternatives considered:**

1. The web client schedules reminders.
2. Each Agent schedules its own reminders.
3. The runtime scheduler owns reminders; reminders are delivery events and never alter task state.
4. A reminder creates a new supervised task.

**Recommendation:** option 3. Browser closure, multiple tabs, and Agent process hibernation must not change the approval schedule.

**Final disposition:** PRD §8 already fixes the user-visible timing (immediate, 15 minutes, 45 minutes, 3 hours, 24 hours; none afterward). E3 records the engineering ownership and event semantics.

## P5 — Agent-created Tool lifecycle

**Problem:** The PRD allows Agents to create and activate non-destructive Tools, but the record needed to prevent a declarative Tool from becoming an unreviewed executable privilege escalation.

**Alternatives considered:**

1. Let an Agent create executable code and activate it immediately.
2. Disallow Agent-created Tools entirely in the prototype.
3. Store versioned declarative Tool records; apply the normal mutation/approval policy; require a runtime grant for activation; execute only through the runtime Tool executor.
4. Allow creation automatically but require approval only when the Tool is first used.

**Recommendation:** option 3. It preserves extensibility without letting a Pack, Skill, or Agent bypass runtime policy.

**Final disposition:** PRD §7 already distinguishes non-destructive and risky Tool creation. E4 records the schema/version/activation detail.

## P6 — Scheduler and watcher semantics

**Problem:** Schedules, file watchers, webhooks, dependent tasks, and external events can be delivered more than once or missed during downtime. Recovery must not duplicate effects.

**Alternatives considered:**

1. At-most-once delivery and silently drop events during downtime.
2. At-least-once delivery with no deduplication.
3. At-least-once delivery with idempotency keys and de-duplication; missed occurrences are catch-up/skip decisions recorded by policy.
4. Replay every missed trigger after restart regardless of side effect risk.

**Recommendation:** option 3. It matches D23's idempotency rule and D32/D33's safe-recovery boundary; option 4 is unsafe for external effects.

**Final disposition:** PRD §§8 and 13 settle the trigger and no-duplication requirements. E5 records the implementation semantics.

## P7 — Git and merge coordination

**Problem:** Multiple coding tasks may touch the same repository. The system must preserve reviewability and prevent a background Agent from silently mutating the main branch.

**Alternatives considered:**

1. All coding Agents edit the shared checkout directly.
2. Give every task an isolated branch/worktree, queue conflicts, validate, and require user approval before merging.
3. Automatically merge clean branches without asking.
4. Allow Agents to push directly to the remote and let a hosted service resolve conflicts.

**Recommendation:** option 2. It is already the PRD's intended behavior and gives the user a small, reviewable merge surface.

**Final disposition:** PRD §10 settles the behavior. E6 records the engineering refinement: no force-push and no silent merge.

## P8 — Build order and definition of done

**Problem:** The full platform could be built in many orders, and the revised Pack/Operation/Agent model adds acceptance behavior not present in the original PRD criteria 1–21.

**Alternatives considered:**

1. Build all three Agents, all Tools, browser automation, cloud backends, and admin UI before validating a vertical slice.
2. Build the Phase 0–7 sequence from D23: contracts first, then a small vertical slice, then Agent runtime, workspace/safety, configuration/recovery, and portability.
3. Follow the office-hours memo and build only the narrow local coding runner before any platform architecture.
4. Build the visual dashboard first and connect runtime behavior later.

**Recommendation:** option 2 for the private prototype, while retaining the office-hours recommendation as a strategic validation warning. Do not claim the wider startup hypothesis is validated by architecture work.

**Final disposition:** E7. The prototype definition of done is PRD §19 criteria 1–21 plus D45 criteria 22–27 for Phase 1–6; Phase 7 is optional for the private prototype.

## P9 — Testing default

**Problem:** Live provider tests are expensive and nondeterministic, while the runtime needs meaningful tests for state, recovery, approvals, replay, and Agent/Pi boundaries before credentials exist.

**Alternatives considered:**

1. Run live provider tests in every CI build.
2. Use only unit tests and mock UI behavior.
3. Use deterministic fake Provider, fake Pi, fake clock, fake filesystem, and mock-runtime/local-runtime E2E; keep live-provider tests opt-in.
4. Skip recovery/contract tests until the first deployment.

**Recommendation:** option 3. The mock path must exercise the real task/runtime path, not a parallel toy implementation.

**Final disposition:** E8, engineering-level extension of D23's testing strategy.

## Evidence note

P1–P9 were created while recovering the cut-off session. They are preserved because the reasoning path matters, but they must not be mistaken for additional product-owner answers. D40–D45 are the actual continued-session answers; E1–E8 are engineering dispositions delegated by PRD §24 or already covered by the PRD.
