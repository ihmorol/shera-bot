# Shera Bot — Open-items decisions (2026-09-17): D46–D50, E9–E14

Part of the decision records. Index and provenance: [`README.md`](README.md). Previous records: [`confirmed-decisions.md`](confirmed-decisions.md) (D1–D39), [`closure-decisions.md`](closure-decisions.md) (D40–D45, E1–E8).

> **Provenance.** On 2026-09-17 the product owner answered the Stage-1 gate item and delegated the Stage-2 dispositions in one instruction, preserved verbatim:
>
> - Stage 1: **"currently an agent can run only one operation, but the same agent can trigger multiple subagents."** → recorded as **D46** (owner-confirmed; this is the owner's answer to the D43 roster-mapping conflict, open-items brief item 7).
> - Stage 2: **"based on prd and all the decisions make the smart and best suitable choices for each one."** → the ten open items in [`../TRACEABILITY.md`](../TRACEABILITY.md) were dispositioned by the agent from the PRD and the recorded decisions: **D47–D50** and **E9–E14**.
>
> **Status semantics.** D46 is **Confirmed** (explicit owner answer). D47–D50 and E9–E14 are marked **Delegated** — decided by the agent under the explicit owner instruction above, with full rationale, alternatives, and evidence sources recorded; they become **Confirmed** on owner review. Corrections are cheap: nothing in this batch is implemented yet.
>
> The Stage-1 gate's second item (UX_RECOMMENDATIONS adoption) was not separately answered by the owner; it is dispositioned as **D50** under the same delegation and flagged for review.
>
> **Stage-2 disposition ledger** (the brief's empty owner table, filled under this delegation):

| # | Item | Disposition | Record |
|---|---|---|---|
| 1 | Admin scope | **Decide** — admin API/CLI only in the prototype; console production-gated | D47 |
| 2 | Admin secrets | **Decide** — provider credentials local-first in the container, admin-provisioned | E9 |
| 3 | Credits/exhausted | **Decide** — pause before the model call, explicit visible state, admin top-up | D48 |
| 4 | Event compaction | **Decide contract, defer thresholds** — append-only prototype | E10 |
| 5 | SQLite backups | **Decide mechanism** (consistent snapshot + integrity check + drill); replication production-gated | E11 |
| 6 | `workspace_id` | **Decide** — invariant per D40 applied to every product table | E12 |
| 7 | Pack mapping (D43) | **Decide (owner)** — one home Operation per Agent; subagents carry cross-Operation work | D46 |
| 8 | Coordinator lifecycle | **Decide** — removable at any time; work continues peer-to-peer | D49 |
| 9 | Recovery semantics | **Decide** — declarative per-tool class, default `needs_human` | E13 |
| 10 | PRD TODOs | **Decide** — all contract-defined until implemented; ledger in TRACEABILITY | E14 |

---

# D46 — Agent roster rule and the subagent model (student pack v1 mapping)

**Status:** Confirmed — owner answer 2026-09-17, quoted verbatim in the provenance block above.
**Evidence:** Owner message 2026-09-17 (this session), answering the Stage-1 gate item recorded in [`../DEV_WORKFLOW.md`](../DEV_WORKFLOW.md) Stage 1 and the F1 finding in [`../../mockup/HANDOFF.md`](../../mockup/HANDOFF.md) §7 / [`../../mockup/reviews/2026-09-13/docs-conformance-audit-2026-09-13.md`](../../mockup/reviews/2026-09-13/docs-conformance-audit-2026-09-13.md) §4 F1. Supersedes the roster-reuse clause of D43 and the matching sentences in PRD §5, [`../UI_DESIGN.md`](../UI_DESIGN.md) §1.4, and `PRODUCT.md`.
**Decision:**
1. **One home Operation per Agent.** An Agent's scoped assignment (D39) is a single pack-defined Operation. D43's clause "each Agent is reused across at least two Operations" is withdrawn; an Agent is rostered in exactly one Operation.
2. **The coordinator role is not a roster assignment.** The General Assistant remains the default coordinator of every Operation and stays removable (D42). Its cross-Operation presence is the coordinator role specifically and does not count as multi-Operation rostering; pack definitions may still name a different coordinator (D42), as the fixture does for Exam Preparation.
3. **Subagents.** The same Agent can trigger multiple subagents. "Subagent" is the owner's term for a subordinate agent execution triggered by an Agent within its Operation; it is not a new object type. The runtime machinery for this already exists in the decisions: typed delegation events create task runs (D34), an Operation holds multiple independently tracked task runs (D31), and delegated work runs in separately supervised task workers under admission control (D32, E1). Multiple subagents may be triggered by the same Agent.
4. **Student pack v1 roster mapping** (the concrete application; skills/tools/connectors per Agent remain pack content under D18/D43):

| Operation | Coordinator | Rostered Agents |
|---|---|---|
| Research Paper | General Assistant (default, D42) | General Assistant, Researcher, Citation Manager |
| Programming Assignment | General Assistant (default, D42) | General Assistant, Developer, Programming Tutor |
| Exam Preparation | Study Planner (pack override, D42) | Study Planner |

Cross-Operation work — past-paper drills, syllabus source indexing — is delivered by subagent triggering inside the Operation that needs it, not by dual roster membership. Ad-hoc Operations (D41) continue to combine any same-Pack Agents and cover every other combination.

**Rationale:** resolves the recorded F1 conflict (three roster slots × three Operations leave arithmetic room for nine assignments; the ≥2-each rule needed twelve) without growing rosters or duplicating identities, and matches the owner's stated model. Reuse of a specialist across scenarios now happens through delegation, which the runtime already supervises, instead of through duplicate memberships.
**Alternatives considered (preserved):**
- (a) Relax to "≥1 Operation per Agent" leaving multi-membership possible — not selected; the owner's sentence states "only one operation".
- (b) Grow rosters to four slots to satisfy ≥2 — not selected; invents roster content and contradicts the stated model.
- (c) Per-Operation skill variants of the same identity — not selected; dilutes "one persistent identity" (D39).
- Alternative reading considered and rejected: "run only one operation" as a concurrency statement (one Operation at a time) rather than roster membership; rejected because the sentence answers the F1 roster question ("currently…") and the subagent clause then has no referent.
**Affected PRD sections:** §5 (rewritten lead and mapping paragraph), §5.4 (Citation Manager sentence), §19 (criteria 3–6 unchanged and re-confirmed), §4.2 (unchanged; coordinator text already matches D42).
**Implementation implications:** Pack schema ships `operations[].agents` as single-membership (S2 contract now unblocked); Agent profile "Operation memberships" lists exactly one Operation for specialists (the coordinator badge still marks the role); roster chips render the single roster; the Exam Preparation fixture roster drops to its one rostered Agent; nothing in the runtime depends on cross-Operation membership.
**Verification coverage:** fixture update recorded in [`../../mockup/HANDOFF.md`](../../mockup/HANDOFF.md) §21 with the test suite green; PRD/UI_DESIGN/PRODUCT sentence sync verified by the grep list in that entry; later: Pack manifest validation tests (S2) reject an Agent in two rosters.
**Open sub-item (not silently decided):** exact subagent semantics — whether a subagent is a same-identity worker instance or another same-Pack Agent invoked as a subordinate, concurrency limits, and memory-scope boundaries. Owner + evidence target: before the Agent/Operation contracts freeze, or as an engineering record at that point. Listed in [`../TRACEABILITY.md`](../TRACEABILITY.md).

---

# D47 — Admin operation model in the private prototype

**Status:** Delegated — decided by the agent under the owner's 2026-09-17 instruction; owner review pending.
**Evidence:** PRD §§3.2, 15; E7 (admin console optional for the prototype); open-items brief item 1.
**Decision:** The prototype implements the PRD §15 admin capabilities as an authenticated **admin API/CLI** on the control plane (admin token held by the owner; security-relevant actions logged per PRD §15), including credit top-up (D48), account enable/disable, container lifecycle, backup trigger, and restore (E11). No admin console UI ships in the prototype; the console remains production-gated (E7 Phase 7). Administrator status stays a manually managed database flag (PRD §3.2).
**Rationale:** ≤5 accounts on one VM operated by one person; an admin UI is the heaviest option, needs its own auth surface and tests, and delivers no prototype evidence that the API path doesn't. Acceptances 18 and 21 are satisfiable through the audited API.
**Alternatives considered:** (a) read-only admin page — rejected: partial UI still carries auth/test cost for no prototype value; (c) full console — deferred to Phase 7 per E7.
**Affected PRD sections:** §15 (prototype-scope note added), §3.2 (unchanged).
**Implementation implications:** control-plane admin endpoints + CLI wrapper; admin token never rendered; audit entries for every admin action; restore procedure documented with E11.
**Verification coverage:** Stage 7/8 runbook includes the admin CLI procedures; the E11 restore drill is performed through it.

---

# D48 — Exhausted-credit behavior

**Status:** Delegated — decided by the agent under the owner's 2026-09-17 instruction; owner review pending.
**Evidence:** PRD §9 ("if a reservation cannot be made, the task pauses before calling the model"); D20–D22 (reservation/settlement, single balance); open-items brief item 3.
**Decision:** When a reservation cannot be made, the run enters the existing `paused` state with the explicit pause reason `insufficient_credits` — a distinct, user-visible state with a notification, not a silent stall and not a resource-queue placement (the queue in E1 is for capacity exhaustion of resource limits, which is different). The task resumes only after an admin top-up (D47) or the user cancels; credits remain internal prototype accounting, and production billing/metering stays future work (glossary, PRD §20).
**Rationale:** PRD §9 already fixes the pause-before-call behavior; this record makes the state explicit and testable and names the unblocking paths. Queue-on-exhaustion would conflate credit starvation with resource admission and hide a condition the user must act on.
**Alternatives considered:** (a) queue behind resources like E1 — rejected (conflation, no user action surfaced); (c) threshold warnings only — rejected (does not define the terminal state).
**Affected PRD sections:** §9 (visibility clause added).
**Implementation implications:** run-state pause-reason field in the S3 state machine; notification + card copy; admin top-up endpoint (D47).
**Verification coverage:** contract test — reservation fails → `paused (insufficient_credits)`; resume after top-up; UI state fixture.

---

# D49 — Coordinator removal lifecycle

**Status:** Delegated — decided by the agent under the owner's 2026-09-17 instruction; owner review pending.
**Evidence:** D42 (coordinator removable; peer-to-peer fallback; runtime authoritative); D32 (healthy running work and approval-waiting work are never killed for capacity); open-items brief item 8.
**Decision:** Coordinator removal is allowed at any time, including while runs are active. On removal, in-flight work continues under peer-to-peer coordination through the typed collaboration protocol (D7); the runtime remains the lifecycle and safety authority (D4, D42) and never depends on the coordinator's presence. Removal is recorded as an event and reflected in the UI with the peer-to-peer fallback notice (the mockup already carries this copy). Synthesis responsibility falls to the remaining roster under pack policy.
**Rationale:** D42's removability is unqualified and the coordinator is a synthesis role, not lifecycle machinery; blocking or pausing on removal would add a UI state machine and would preempt healthy work, contradicting D32.
**Alternatives considered:** (a) block removal during active runs — rejected (adds a non-decision-derived state and contradicts unqualified removability); (b) pause the run for re-coordination — rejected (preempts healthy work, D32).
**Affected PRD sections:** §4.2 (already states the fallback; no text change), §8 (no change).
**Implementation implications:** coordinator is a mutable Operation field; `CoordinatorRemoved`/`CoordinatorSet` events; roster editor stays display/request only — grants and validation remain runtime-owned (D36).
**Verification coverage:** state-machine/integration test — remove coordinator mid-run, run completes, events and approvals intact.

---

# D50 — UX_RECOMMENDATIONS disposition (Stage-1 gate item)

**Status:** Delegated — recorded under the owner's 2026-09-17 instruction; owner review pending. (The owner answered only the D43 part of the Stage-1 gate; this disposition is flagged for explicit review.)
**Evidence:** [`../../mockup/UX_RECOMMENDATIONS.md`](../../mockup/UX_RECOMMENDATIONS.md) ("not implemented or adopted product decisions"); DEV_WORKFLOW Stage 1 ("decide whether to adopt any part… that is a product decision, not a repair").
**Decision:** Not adopted as a redesign. The document remains a design input; its recommendations are evaluated screen-by-screen when the real client screens are built, starting with the S2 chat-first landing in the Phase-1 UI slices, with PRD and UI_DESIGN as the binding spec. The mockup retains its current behavior meanwhile; nothing in the mockup changes as a result of this record.
**Rationale:** adopting it wholesale now would be a UI-scope change riding on Stage-1 repairs (the workflow forbids that); the real client is a rebuild (phase0-plan §0) so evaluating each recommendation at build time is cheaper, better-informed, and reversible.
**Alternatives considered:** adopt wholesale — rejected (unvalidated redesign; UI_DESIGN rewrite); reject outright — rejected (the evidence remains useful; deletion would violate the preservation rule).
**Affected PRD sections:** none (no normative text changes).
**Implementation implications:** Phase-1 UI slice specs cite specific recommendations they adopt; UI_DESIGN remains authoritative until then.
**Verification coverage:** the Phase-1 S2 slice spec records which recommendations were applied.

---

# E9 — Provider credential custody

**Status:** Delegated engineering record — decided by the agent under the owner's 2026-09-17 instruction; owner review pending.
**Evidence:** PRD §9 (local-first, runtime-injected, masked, never centrally persisted), §12 (local-first wording), D17, D22, G3; open-items brief item 2 (the "admin deployment secrets vs §12 wording" tension).
**Decision:** Provider credentials — platform-supplied (admin-funded) and user-supplied — live only in the user container's local credential store, injected at call time by the runtime, masked everywhere, revocable/replaceable, and never written to prompts, events, logs, memory, artifacts, or the control plane. Admin provisioning writes the platform credential into the container's store at provisioning/top-up time; it is never displayed back. The administrator's own deployment secrets (admin token, database credentials) are deployment environment/secret-file material, not product data, and are therefore outside PRD §12's local-credential rule — this is the recorded reading of that boundary.
**Rationale:** resolves the brief's item-2 tension without introducing a second custody store or central persistence; matches the recorded decision set exactly.
**Alternatives considered:** (a) server-side provider keys — rejected (contradicts §9/§12 and D22); (b) env-file keys referenced by ID — rejected (splits custody, complicates rotation).
**Affected PRD sections:** §9, §12 (no normative change; boundary clarified here).
**Implementation implications:** credential-reference fields in provider contracts; container-local encrypted-at-rest store (engineering detail at implementation); redaction filters per PRD §18/§22.
**Verification coverage:** secret-redaction and custody tests (Stage 3 security slice; Stage 6 list).

---

# E10 — Event retention in the prototype

**Status:** Delegated engineering record — decided by the agent under the owner's 2026-09-17 instruction; owner review pending.
**Evidence:** E2 (retention lifetime + cursor fallback contract), D26 (event honesty, cursors, replay); open-items brief item 4.
**Decision:** The prototype runs the event journal append-only for the container's lifetime and performs **no compaction**; E2's fallback contract — a cursor outside retention returns a state snapshot plus a new cursor — is implemented in the API shape for forward compatibility, and the numeric size/time thresholds are assigned to the production gate.
**Rationale:** at prototype scale (≤5 users, one VM) compaction has no operational need and carries evidence-loss risk; keeping the hook in the contract preserves E2 without guessing thresholds.
**Alternatives considered:** size-based compaction now — rejected; time-based — rejected.
**Affected PRD sections:** none (PRD §14 unchanged).
**Implementation implications:** events table keeps the retention/fallback hook; cursor API returns snapshot+cursor when a cursor predates the (empty) retention horizon.
**Verification coverage:** event retention/cursor tests per E2; snapshot-fallback contract test.

---

# E11 — SQLite backup and restore mechanism

**Status:** Delegated engineering record — decided by the agent under the owner's 2026-09-17 instruction; owner review pending.
**Evidence:** PRD §12 (snapshot every six hours, keep seven), §21 (tested restore), acceptance 18; D10, D13 (driver pending spike); open-items brief item 5.
**Decision:** Backups are consistent snapshots via the SQLite online backup facility (or `VACUUM INTO` on a quiesced connection — final call at the D13 spike, see S6), taken on the PRD §12 schedule (every 6 hours, keep the latest 7) and verified with `PRAGMA integrity_check` at snapshot time. Restore = stop container services → verify integrity of the chosen snapshot → replace the local database and workspace mounts → restart → resume tasks from their semantic checkpoints. The restore drill is executed and recorded as evidence at Stage 7 and satisfies acceptance 18. Replication-style options (for example litestream) are assigned to the production gate.
**Rationale:** WAL-consistent snapshots are the mechanism the driver actually guarantees; a documented, drilled restore is the PRD §21 requirement ("tested restore"), not the scheduler.
**Alternatives considered:** litestream-style replication — production-gated; document-only approach — rejected (acceptance 18 requires a performed restore).
**Affected PRD sections:** §12 (unchanged), §21 (evidence target noted).
**Implementation implications:** backup service in the container (or control-plane-triggered), snapshot metadata in control plane, integrity checks in the restore path.
**Verification coverage:** Stage 7 restore drill recorded; acceptance 18 manual procedure.

---

# E12 — `workspace_id` invariant

**Status:** Delegated engineering record — decided by the agent under the owner's 2026-09-17 instruction; owner review pending.
**Evidence:** D40 (one workspace; internal `workspace_id`; no migration needed later), D19; open-items brief item 6.
**Decision:** Every product-state table in container-local SQLite carries `workspace_id` (a single default value in the prototype: one workspace per container), as do the control-plane rows that map users to workspaces/containers. All repository interfaces are workspace-scoped by construction — no query bypasses the scope. Future multi-workspace therefore needs new rows and a switcher, not a schema migration.
**Rationale:** D40 already decided this at the product level; recording the invariant now is the cheap moment (pre-contracts), and retrofitting IDs into SQLite and JSONL after the prototype is the expensive path.
**Alternatives considered:** (b) container-is-the-workspace with no column — rejected (retrofit cost); (c) hybrid column on cross-container tables only — rejected (inconsistent scoping).
**Affected PRD sections:** §12 (no text change), §17 (implementation detail).
**Implementation implications:** Drizzle schemas include the column on every product table; repository layer enforces the scope; JSONL/event records carry it.
**Verification coverage:** repository/persistence tests assert scoping; migration test verifies the single default value.

---

# E13 — Per-tool recovery semantics for ambiguous external effects

**Status:** Delegated engineering record — decided by the agent under the owner's 2026-09-17 instruction; owner review pending.
**Evidence:** PRD §13 (recovery pauses when an external effect cannot be proven safe to replay), D33, E2; D34–D36 (typed triggers, approval model); open-items brief item 9.
**Decision:** Tool definitions declare `recovery: replayable | idempotent_retry | needs_human`. The default when a tool does not declare a class is `needs_human`. After an interruption, the runtime consults the class: `replayable` tools re-execute from the checkpoint, `idempotent_retry` re-executes under their idempotency key, `needs_human` enters `recovery_required` and pauses for review. The field is data on the tool record — never prose inference (G2/G6).
**Rationale:** matches the approval model's "classification is data" principle (phase0-plan S4) and gives the recovery path a deterministic answer per tool while defaulting safely.
**Alternatives considered:** (b) default-everything-to-needs-human without the field — rejected (no path to automatic recovery for known-safe tools); (c) runtime heuristics per effect class — rejected (inference the decisions already forbid).
**Affected PRD sections:** §13 (no text change).
**Implementation implications:** field in the tool schema (S2 contracts), fake-Pi scripts per class, recovery tests per class.
**Verification coverage:** recovery test matrix — one scripted ambiguous effect per class; `recovery_required` only for `needs_human`.

---

# E14 — PRD TODO registers: closure policy

**Status:** Delegated engineering record — decided by the agent under the owner's 2026-09-17 instruction; owner review pending.
**Evidence:** PRD §§21–22 registers; D23–D45, E1–E8; open-items brief item 10.
**Decision:** Every PRD §21/§22 item is **contract-defined until implemented and verified** — nothing in those registers is treated as done without code, tests, and evidence. [`../TRACEABILITY.md`](../TRACEABILITY.md) carries the per-item ledger marking each entry as *resolved by decision* (the contract is fixed and recorded), *contract-defined* (shape agreed, implementation pending), or *production-gated*. Acceptance criteria 22–27 keep their statuses ("adopted, not implemented").
**Rationale:** the risk the brief names is silently treating contract-defined as done; an explicit ledger with categories removes the ambiguity without pretending implementation exists.
**Alternatives considered:** (a) per-item audit now — pointless while nothing is implemented; (c) production-gate the whole register — rejects items that decisions have already resolved.
**Affected PRD sections:** §§21–22 (pointer note added).
**Implementation implications:** TRACEABILITY gains the ledger; stage gates update rows as slices land.
**Verification coverage:** ledger accuracy reviewed at each stage gate.

---

# Supersession updates (2026-09-17)

| Earlier | Superseded / refined by | Note |
|---|---|---|
| D43 "each Agent is reused across at least two Operations" clause | **D46** | One home Operation per Agent; the coordinator role is cross-Operation (D42) but is not a roster assignment. D43's scope (6 Agents, 3 Operations) stands. |
| PRD §5 "each reused across at least two of the three pack-defined Operations" | **D46** | Rewritten in the 2026-09-17 PRD sync (SYNC-2). |
| UI_DESIGN §1.4 "Each Agent appears in at least two Operations" | **D46** | Synced 2026-09-17. |
| `PRODUCT.md` capability bullet "Each Agent appears in at least two Operations" | **D46** | Synced 2026-09-17. |
| Open-items brief items 1–10 (unowned) | **D46–D50, E9–E14** | Dispositions in the ledger above; brief table filled. |

# Production-gated (added 2026-09-17)

- Admin console UI (E7 Phase 7; D47 keeps it out of the prototype).
- Production billing/metering (D48; unchanged from PRD §20).
- Event-compaction size/time thresholds (E10).
- SQLite replication-style backup (E11).

# Owner review note

D46 is owner-confirmed. D47–D50 and E9–E14 are **Delegated** records: they were produced from the PRD and the confirmed decision set under the owner's explicit instruction, and they become Confirmed when the owner reviews them. Because nothing is implemented yet, any correction re-opens only the affected record and its ledger row — no code or data migration is involved.
