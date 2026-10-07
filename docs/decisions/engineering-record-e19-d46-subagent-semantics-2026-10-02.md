# E19 — S10 D46 sub-item: subordinate execution semantics for the prototype

**Status:** Delegated engineering record — decided by the orchestrator while executing slice **S10** (issue #11) under the owner's standing instruction to keep building with subagents (2026-09-28, restated 2026-10-01/02); **owner veto at the G8 merge gate**. This record resolves the D46 sub-item the tracker required before the S10 pack-schema freeze; it is an ENGINEERING decision inside the recorded product frame (D46, D51), not a product decision.
**Date:** 2026-10-02.

> **Identifier note:** E18 is reserved by the D51/SYNC-3 record ([`owner-decision-d51-dual-harness-2026-09-19.md`](owner-decision-d51-dual-harness-2026-09-19.md)) for the future Hermes engineering record. This record takes **E19** to avoid the E15/E16 collision pattern (see the identifier note in [`engineering-record-e16-2026-09-17.md`](engineering-record-e16-2026-09-17.md)).

## Evidence

- **D46** ([`open-items-decisions-2026-09-17.md`](open-items-decisions-2026-09-17.md)): the sub-item — "exact subagent semantics: same-identity worker instance vs. another same-Pack Agent as subordinate, concurrency limits, memory scope" — with the recorded evidence target "before the Agent/Operation contracts freeze (S10/S13) or recorded as an engineering decision at that point." Issue #11's acceptance criterion repeats it: "Open sub-item recorded, not silently decided … if this slice has to fix the shape, record the choice as an engineering decision and link it."
- **D51/SYNC-3** (2026-09-19): dual harness decided at the product level (Pi default, Hermes selectable per Agent); the S03 spike ([`../../spikes/d13/`](../../spikes/d13/)) proved JSONL-stdio supervision of an EXTERNAL worker process driven by the gateway.
- **S07/S09 code** (`apps/user-runtime`): `HarnessRunService` already executes subordinate work as typed runs created only from D34 triggers (G2); the `HarnessAdapter` seam (D51) is harness-agnostic; the S09 slice proved a scripted subordinate producer completing durable turns.
- **Issue #11** (S10): the pack schema freezes Operation/Agent shapes — the roster is single-membership (D46) with the default-coordinator exemption; the subagent semantics shape what a subordinate Agent IS at the pack level.

## Decision

1. **Subordinate execution = a task run driven through the gateway, not a second signed-in identity.** In the prototype, a subordinate (D46's "subagent") is a **task run owned by the same workspace**, created only from a typed D34 trigger (G2), executed by the workspace's configured harness adapter (Pi default per D51), and journalled on the task's own stream. The subordinate has NO independent session, NO independent chat identity, and NO approval authority (G6: agents never self-approve; approvals belong to the human). This matches the shipped code (S07 `HarnessRunService`, S09 live turns) and D46's own framing that subagent execution is a subordinate agent execution WITHIN an Operation, not a separate object type.
2. **"Same-identity worker instance" is the prototype reading; "another same-Pack Agent as subordinate" is deferred.** D46 offered two readings. The prototype implements the first (the pack's rostered Agent's worker instance executes the subordinate run under the Operation's coordinator). The second reading — one Agent literally delegating to a DIFFERENT rostered Agent as its subordinate with delegated identity — requires the S13 Operation-collaboration contracts and is recorded there, not here. Nothing in the S10 pack schema prevents it: roster membership + the D42 coordinator model carry it.
3. **Concurrency limit: one subordinate run per (workspace, Agent) at a time** — a PROTOTYPE placeholder (the admission-control slice S16 owns the real ladder). The limit is enforced socially by the current fake adapter (synchronous), and the constraint is recorded here so S16 inherits a written baseline.
4. **Memory scope: the subordinate run reads Operation-scoped context only.** Subordinate runs receive the task's typed context (trigger, Operation pin, snapshots per D29) — never another Agent's private memory (D39 boundaries), never workspace-global state beyond the Operation's own artifacts. The full memory model (scopes, provenance, publication) is S29's slice; this record fixes only the subordinate boundary: **no private-memory inheritance**.

## Rationale

The pack schema freeze (S10) needed the subordinate shape BEFORE roster/coordinator semantics could be trusted, and the shipped S07/S09 code already embodies reading 1. Recording it as an E-record keeps the D46 sub-item's "recorded, not silently decided" requirement while staying inside the engineering lane: every element here is derivable from shipped code plus already-recorded decisions (D46's framing, D34 triggers, D39 boundaries, G6 approval rules). The owner retains the veto at G8; a product-level reversal would supersede this record and flow to S13/S16, not to the pack schema (which stays neutral between the readings — see implications).

## Alternatives considered (preserved)

- **Another same-Pack Agent as subordinate with delegated identity (D46 reading 2) now:** rejected for S10 — it needs the S13 collaboration contracts (roster hand-off, coordinator-removal semantics, cross-Agent attribution) that do not exist yet; pre-building it would freeze shapes S13 owns. Recorded as the S13 follow-up.
- **Subordinate = a separate OS process per run (the S03 spike's literal shape):** rejected as the PROTOTYPE semantic — the spike proved the transport, but the product boundary is the typed run, not the process; the process is the harness adapter's implementation detail (D51).
- **Concurrency: unbounded subordinate runs:** rejected — even the prototype needs a written ceiling so S16's admission control starts from a recorded baseline rather than silence.
- **Memory: subordinates inherit the requesting Agent's private memory:** rejected outright — violates the D39 private-memory boundary and G6; the publication boundary is S29's and must remain opt-in by design.

## Affected PRD sections

PRD §5 (Agent model — read, unchanged), §7 (Operations — read, unchanged), D46 (the sub-item this record resolves at the engineering level; the product record itself is untouched). No PRD text changes were made or needed.

## Implementation implications

- The S10 pack schema (shipped in this slice) stays neutral: roster membership + coordinator semantics carry both D46 readings; nothing in `packages/agent-pack-sdk` or `agent-packs/student/v1` encodes subordinate identity.
- S13 (Operation chat) inherits reading 2 as its recorded design target; S16 (admission control) inherits the one-run-per-(workspace, Agent) placeholder as the baseline to supersede; S29 (memory) inherits the no-private-memory-inheritance boundary as already binding.
- The verification coverage for this record is the S10 suite (pack schema single-membership with the coordinator exemption, `packages/agent-pack-sdk/src/manifest.test.ts`) plus the shipped S07/S09 subordinate-run behavior (G2/D34 regression tests).

## Verification coverage

- Pack-level: `packages/agent-pack-sdk/src/manifest.test.ts` (D46 single-membership + coordinator exemption; the schema test the D46 record promised).
- Runtime-level: `apps/user-runtime/src/modules/tasks/task-run-creator.test.ts` (typed non-trigger rejections) and `apps/user-runtime/src/modules/runtime/harness-run-service.test.ts` "no task run on normal messages" coverage (G2/D34); the S10 `pack-pin.test.ts` end-to-end test additionally proves the subordinate run stamps its D29 snapshots.
- Owner veto point: the S10 merge gate (G8) — a product-level reversal supersedes this record via a recorded decision (PRD §24), never a silent edit.
