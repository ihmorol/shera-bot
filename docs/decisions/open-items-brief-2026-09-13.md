# Scout brief — ten open implementation-defined items

**Date:** 2026-09-13 · **Role:** Scout (read-only analysis, no recommendations on product questions)
**Purpose:** Stage 2 of `docs/DEV_WORKFLOW.md` — the product owner picks **decide / defer / production-gate** per item; this brief supplies the trade-offs. Sources: `docs/TRACEABILITY.md` (Open items), `docs/decisions/confirmed-decisions.md`, `docs/decisions/closure-decisions.md`, `docs/PRD.md`, `mockup/HANDOFF.md` §7/§15/§17.
**Legend:** ⚠ = touches Phase 0 contracts and should be decided before the scaffold slice.

---

### 1. Admin UI scope vs manual/admin API (E7 defers admin console)
- **Depends on:** nothing upstream; blocks only admin ergonomics.
- **Options:** (a) no admin UI in the prototype — admin operations via a secret-bearing CLI/API on the VM; (b) minimal read-only admin page behind the admin credential; (c) full admin console (E7 deferred it — heaviest).
- **Deferral risk:** low for the prototype; without (a) being written down, "how does the admin fund credits / approve seats" stays undefined.
- **Interacts with:** E7, D17 (admin-funded providers), item 2.
- **Verdict field for owner:** ______

### 2. Admin deployment secrets vs PRD §12 local-credential wording ⚠ (threat model input)
- **Depends on:** Stage 3 threat model; Stage 7 deployment.
- **Options:** (a) admin-supplied provider keys stored server-side only, never rendered (matches D17 masked handling); (b) keys in an env file owned by the admin, referenced by ID; (c) platform-funded keys only for the prototype (no user-supplied keys at all).
- **Deferral risk:** medium — the Zod provider contract and Settings UI shape assume a decision; changing later is a migration.
- **Interacts with:** D17, D22, G3 (never expose secrets), item 1.

### 3. Credits vs billing/metering + exhausted-credit UX ⚠ (reservation contract)
- **Depends on:** D20–D22 (reservation/settlement, single balance).
- **Options for exhausted-credit state:** (a) hard stop with a "free up reserves" action; (b) queue-on-exhaustion like D32's queue-on-crash; (c) warnings at thresholds only. Billing: prototype = internal accounting only (PRD), metering deferred to production gate.
- **Deferral risk:** medium — the run state machine needs the exhausted transition to exist even if the UX is refined later.
- **Interacts with:** D20–D22, D32, PRD §15; item 1.

### 4. Event compaction thresholds and retention policy
- **Depends on:** D26 (event honesty, cursors, replay).
- **Options:** (a) size-based compaction (compact when JSONL > N MB, keep last M events + checkpoints); (b) time-based; (c) defer entirely — append-only JSONL for the prototype, compaction to the production gate.
- **Deferral risk:** low for the prototype (small scale), but the **event/cursor contract shape** must leave room — decide the *contract hook*, not the thresholds, in Phase 0.
- **Interacts with:** D26, D5, item 10.

### 5. SQLite backup consistency, restore and migration procedure
- **Depends on:** D13 spike (node:sqlite vs other) — driver choice changes the backup mechanism.
- **Options:** (a) `VACUUM INTO` snapshots on a timer (simple, WAL-consistent); (b) litestream-style replication (heavier); (c) document-only for the prototype, real drill at Stage 7.
- **Deferral risk:** low until Stage 7 (the approved next release needs a *tested restore*, PRD §21).
- **Interacts with:** D13 spike, PRD §21 6h/keep-7.

### 6. Exact `workspace_id` invariant + future multi-workspace migration ⚠
- **Depends on:** D40 (one workspace per account), D19 (no switcher).
- **Options:** (a) every row carries `workspace_id` from day one (single value "default"); (b) workspace = the container, no column (migration would be a rewrite); (c) hybrid — column only on tables that cross containers (files, events).
- **Deferral risk:** **high** if (b) — retrofitting IDs into SQLite/JSONL after the prototype is real work; cheap if decided in Phase 0 contracts.
- **Interacts with:** D40, D19, filesystem layout contract.

### 7. Complete student Pack mapping (6 Agents × 3 Operations, skills/tools/connectors) ⚠ — **D43 conflict lives here**
- **Depends on:** D29/D32/D39/D43; the mockup fixture conflict is recorded in `mockup/HANDOFF.md` §7 (F1) — with three roster slots per Operation, "each Agent in ≥2 Operations" (D43's example) is arithmetically impossible.
- **Options:** (a) relax D43 to "each Agent appears in ≥1 Operation, each Operation has 3 Agents"; (b) grow rosters to 4 slots where needed; (c) add per-Operation skill variants so identity persists but participation differs.
- **Deferral risk:** **high** — the Pack schema (Phase 0 contract) cannot be authored while the mapping conflicts; the mockup cannot fix it in fixtures (G5).
- **Interacts with:** D43, D29, D39; PRD §5.

### 8. Operation coordinator lifecycle when removed
- **Depends on:** D44 (removable default coordinator; peer-to-peer fallback copy exists in the mockup).
- **Options:** (a) removal is blocked while runs are active (only between runs); (b) removal mid-run pauses the run for re-coordination; (c) pure peer-to-peer continues and the runtime only reassigns on failure.
- **Deferral risk:** medium — the state machine needs at least a stubbed transition; the mockup already shows the fallback copy.
- **Interacts with:** D44, D32.

### 9. Per-tool recovery semantics for ambiguous external effects
- **Depends on:** D33/E2 (recovery pauses on unprovable external effects).
- **Options:** (a) per-tool table: each tool declares `replayable | idempotent-retry | needs-human` (extensible, matches the tools inventory); (b) default everything ambiguous to needs-human; (c) runtime heuristic per effect class.
- **Deferral risk:** medium — (b) is a safe prototype default; the approval-model data shape (Phase 0) should carry the field.
- **Interacts with:** D33, E2, D34–D36; item 10.

### 10. Which PRD TODOs are fully resolved vs only contract-defined ⚠
- **Depends on:** PRD §§21–22 register; D23–D45 resolved many.
- **Options:** (a) audit each TODO now against implemented behavior (none is implemented — all are contract-defined until Phase 1+); (b) mark all as "contract-defined, pending implementation trace" with the traceability table as the ledger; (c) production-gate the whole register.
- **Deferral risk:** low if (b) is chosen explicitly — the risk is *silently* treating contract-defined as done.
- **Interacts with:** D45, acceptance criteria 22–27; items 4, 9.

---

**Disposition block — filled 2026-09-17** under the owner's instruction *"based on prd and all the decisions make the smart and best suitable choices for each one"* (Stage 1's D43 item answered separately by the owner: *"currently an agent can run only one operation, but the same agent can trigger multiple subagents"*). Records: [`open-items-decisions-2026-09-17.md`](open-items-decisions-2026-09-17.md). Items 1–10 are disposed by D46–D50 and E9–E14; D47–D50/E9–E14 are Delegated pending owner review.

| # | Item | disposition | One-line disposition |
|---|---|---|---|
| 1 | Admin scope | **decide** (D47) | Authored admin API/CLI on the control plane; console UI production-gated (E7). |
| 2 | Admin secrets | **decide** (E9) | Provider credentials live only in the container's local store, admin-provisioned, never rendered or centrally persisted. |
| 3 | Credits/exhausted | **decide** (D48) | Reservation failure pauses the run before the model call with an explicit visible reason; resumes after admin top-up; billing production-gated. |
| 4 | Event compaction | **decide contract / defer thresholds** (E10) | Append-only in the prototype; E2's snapshot+cursor fallback kept in the API shape; numeric thresholds production-gated. |
| 5 | SQLite backups | **decide mechanism** (E11) | Online-backup snapshots on the PRD §12 schedule with integrity checks; drilled restore at Stage 7; replication production-gated. |
| 6 | workspace_id | **decide** (E12) | Column on every product table with a single default value; repository-scoped queries; no future migration needed. |
| 7 | Pack mapping (D43) | **decide — owner** (D46) | One home Operation per Agent; cross-Operation work via subagent triggering; mapping table recorded. |
| 8 | Coordinator lifecycle | **decide** (D49) | Removable at any time, including mid-run; work continues peer-to-peer; runtime stays authoritative. |
| 9 | Recovery semantics | **decide** (E13) | Per-tool declarative classes with `needs_human` as the default; classification is data, never prose. |
| 10 | PRD TODOs | **decide** (E14) | All §21/§22 items are contract-defined until implemented; TRACEABILITY carries the per-item ledger. |
