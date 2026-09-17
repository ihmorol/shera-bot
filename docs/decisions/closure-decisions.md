# Shera Bot — Continued Decisions and Engineering Records

Part of the decision records. Index and provenance: [`README.md`](README.md). Confirmed decisions 1–39: [`confirmed-decisions.md`](confirmed-decisions.md).

> The original grilling run was cut off at Question 39 by a provider quota error. This record preserves the one-question-at-a-time continuation through D45, the full disposition of pre-written proposals P1–P9, and engineering decisions E1–E8. See [`proposal-history.md`](proposal-history.md) for every proposal, alternative, recommendation, objection, and outcome. Later records (D46–D50, E9–E14, 2026-09-17) are in [`open-items-decisions-2026-09-17.md`](open-items-decisions-2026-09-17.md).
>
> Evidence links below into `../history/2026-09-08-to-2026-09-11/` refer to the archive removed from the working tree in commit `9d8b81c`; retrieve those files from Git history (for example `cea3ba1`) or the local `.session-archive/` copy. The quoted evidence is preserved as recorded.

---

# Confirmed in this session

## D40 — Workspace model
**Status:** Confirmed — Q40 answered 2026-09-11 ("yes go with this", option 1)
**Evidence:** [`zcode-continuation-transcript.md`](../history/2026-09-08-to-2026-09-11/zcode-continuation-transcript.md), Q40 section.
**Decision:** One workspace per user. The container is the workspace; there is no workspace switcher in the UI. All product records are still scoped by `workspace_id` internally, so multi-workspace can be enabled later without a data migration. The workspace owns tasks, projects, files, memories, and its Agent/Operation configuration, and is pinned to the assigned customer pack.
**Rationale:** matches one-container-per-user (D1/D2) and the simplicity goal (D16) while preserving the multi-workspace option that D19 assumed.

## D41 — Chat taxonomy: Agents + Operations only, with ad-hoc Operations
**Status:** Confirmed — Q41 answered 2026-09-11 ("option 1")
**Evidence:** [`zcode-continuation-transcript.md`](../history/2026-09-08-to-2026-09-11/zcode-continuation-transcript.md), Q41 section; historical "Expert" wording is superseded by D44.
**Decision:** The sidebar has exactly two chat sections: **Agents** (persistent direct chats) and **Operations** (collaborative chats). The PRD's user-created "task-specific chat" type is retired as a separate type (at decision time the PRD was unchanged and this was recorded per PRD §24; the PRD was later synchronized on 2026-09-11).
- A direct Agent chat handles single-Agent work and spawns task runs automatically when execution requires lifecycle supervision (D34).
- All multi-Agent work happens inside an Operation. An Operation instance is either **pack-defined** (instantiated from the pack's `operation.yaml`) or **ad-hoc** (the user selects a custom Agent roster from the same pack on the spot, with no reusable definition behind it).
- Ad-hoc Operations obey the same rules as pack-defined ones: same-pack roster, runtime-validated roster changes (D36), and full pinning of pack version, roster, skills/tools/connectors, and provider snapshot (D29).
- This supersedes the group-chat lifecycle in PRD §4.2; Operation chats remain reusable workspaces with independently tracked task runs (D31).

## D42 — Operation coordinator
**Status:** Confirmed — Q42 answered 2026-09-11 ("ok", recommendation accepted)
**Evidence:** [`zcode-continuation-transcript.md`](../history/2026-09-08-to-2026-09-11/zcode-continuation-transcript.md), Q42 section.
**Decision:** The General Assistant is the **default coordinator** of every Operation, but it is removable.
- Pack definitions may name a different coordinator Agent (`coordinator: <agent-id>`) or `coordinator: none`.
- The user may remove the GA from any Operation, including pack-defined ones.
- Without a coordinator, Agents coordinate peer-to-peer through the typed collaboration protocol (D7). The runtime remains the safety and lifecycle authority in all cases (D4) — removing the coordinator changes who synthesizes, never who validates.
- Coordinator proposals for roster changes still follow D36 (user controls; runtime validates).

## D43 — Student pack v1 scope
**Status:** Confirmed — Q43 answered 2026-09-11 ("option 2"). The roster-reuse clause ("each Agent is reused across at least two Operations") is **superseded by D46** (2026-09-17); the pack scope below stands.
**Evidence:** [`zcode-continuation-transcript.md`](../history/2026-09-08-to-2026-09-11/zcode-continuation-transcript.md), Q43 section; supersession: [`open-items-decisions-2026-09-17.md`](open-items-decisions-2026-09-17.md) D46.
**Decision:** The first pack (`agent-packs/student/v1`) ships with **6 Agents** and **3 pack-defined Operations**:
- **Agents:** General Assistant, Researcher, Developer, Citation Manager, Programming Tutor, Study Planner.
- **Operations:** Research Paper, Programming Assignment, Exam Preparation.
- Each Agent is reused across at least two Operations (e.g., Researcher in Research Paper and Exam Preparation) so D39's scoped-assignment reuse model is genuinely exercised.
- Ad-hoc Operations (D41) cover any combination outside these three.
- Adding more Agents/Operations later is pack content work (D18), not runtime work; the ~10-Agent catalog sketched in the session remains a future content addition.

## D44 — Terminology: "Agent" everywhere; Operation framing retained
**Status:** Confirmed — Q44 answered 2026-09-11 ("Agent everywhere, option 1. dont drop operation framing. Operation -> Agents.")
**Evidence:** [`zcode-continuation-transcript.md`](../history/2026-09-08-to-2026-09-11/zcode-continuation-transcript.md), Q44 section.
**Decision:** The product vocabulary is **Pack → Operations → Agents**. The word "Agent" is used everywhere — UI copy, product docs, code identifiers, Zod schemas, DB tables, and pack YAML. The session's word "Expert" is retired.
- The Operations framing is unchanged in substance; only the noun changes: an Operation assembles **Agents** (formerly "Experts"), and the sidebar sections are **Agents** and **Operations**.
- Decisions 29–43 say "Expert"; read "Expert" as "Agent". Their substance is unchanged and the historical wording in the records is preserved as-is.
- One-to-one mapping: Expert (in earlier decisions) = Agent. There is no separate "Expert" concept.

## D45 — Definition of done: six additional acceptance criteria
**Status:** Confirmed — Q45 answered 2026-09-11 ("option 1")
**Evidence:** [`zcode-continuation-transcript.md`](../history/2026-09-08-to-2026-09-11/zcode-continuation-transcript.md), Q45 section.
**Decision:** The prototype's definition of done adds six acceptance criteria to PRD §19 (at decision time the PRD was unchanged and they were recorded here; they are now part of PRD §19 following the 2026-09-11 synchronization):
22. A workspace is pinned to a versioned customer pack, and existing tasks retain the pack/Operation/agent versions that created them (D29, D40).
23. An Operation launches through a preview that shows agents, skills, connectors, provider/model, estimated credits, and approval requirements before execution (D30).
24. One Operation chat can hold multiple independently tracked task runs without merging their state, events, or cost (D31, D34).
25. A long-running task survives browser closure, keeps its worker alive while healthy, and resumes from a semantic checkpoint after a restart (D32, D33).
26. Read-only tools run automatically, local mutations show a preview, and a matching reusable grant executes without another prompt while still being policy-checked (D35).
27. Agent-private memory does not leak into Operation context without explicit publication (D37).

---

# Resolution of draft proposals

The product-question frontier reached during this session is complete. Full proposal text and alternatives are preserved in [`proposal-history.md`](proposal-history.md). P1 was decided by D44; P2/P4/P7 were already decided by the PRD; the remaining details are engineering-level choices delegated by PRD §24 and recorded as E1–E8. This does not mean every implementation question is closed; open items remain listed in [`../TRACEABILITY.md`](../TRACEABILITY.md).

| Draft | Disposition |
|---|---|
| P1 Terminology | **Resolved by D44** — "Agent" everywhere; Operation framing retained. |
| P2 Concurrency and admission | **Already decided by PRD §6** (parallelism within limits; running work continues, new jobs queue). Refinement: E1. |
| P3 Event retention | **Engineering decision E2.** |
| P4 Approval reminder ownership | **Already decided by PRD §8** (reminder times, muting, task stays paused). Refinement: E3. |
| P5 Agent-created tool lifecycle | **Already decided by PRD §7** (non-destructive auto-activation, approval for risky, inventory scope). Refinement: E4. |
| P6 Scheduler/watcher semantics | **Already decided by PRD §8/§13** (triggers, no duplication on restart). Refinement: E5. |
| P7 Git/merge coordination | **Already decided by PRD §10** (branches/worktrees, conflict queueing, merge approval). Refinement: E6. |
| P8 Build order and definition of done | **Engineering decision E7**, anchored on D23 Phase 0–7 and D45. |
| P9 Testing default | **Engineering decision E8**, anchored on D23's testing strategy. |

## E1 — Concurrency and admission control
**Status:** Engineering decision — recorded under PRD §24 delegation.
The runtime enforces CPU, memory, process-count, disk, and provider-concurrency limits per container. When limits are reached, new work queues; healthy running work and approval-waiting work are never killed for capacity. Only an explicit admin emergency action (cancel-all) force-stops work. Idle agent sessions may hibernate immediately under resource pressure (D32).

## E2 — Event retention and cursor fallback
**Status:** Engineering decision — recorded under PRD §24 delegation.
The event journal is retained for the lifetime of the container. High-volume, low-value events (streamed message deltas) may be compacted under a size policy; conversation content remains durable. If a client cursor falls outside retention, the runtime returns a state snapshot plus a new cursor (extends D26).

## E3 — Approval reminder delivery
**Status:** Engineering decision — recorded under PRD §24 delegation.
The runtime scheduler owns reminder timing per PRD §8 (immediate, 15 minutes, 45 minutes, 3 hours, 24 hours; none after). Reminders are delivery events, not tasks, and never change task state; muting affects delivery only.

## E4 — Agent-created tool lifecycle
**Status:** Engineering decision — recorded under PRD §24 delegation.
Agent-created tools are declarative, versioned records in the local tool inventory (name, purpose, input/output schema, owner, scope, risk class, permissions, version). Creation follows the standard preview/approval policy (D35); activation into an agent's or Operation's toolset requires a runtime grant; destructive tools always require explicit approval. Every agent-created tool executes through the runtime executor — no bypass of validation, limits, or approval.

## E5 — Scheduler and watcher semantics
**Status:** Engineering decision — recorded under PRD §24 delegation.
Schedules and watchers are declarative records evaluated by the runtime scheduler with at-least-once firing, idempotency keys, and de-duplication (D23 Rule 6). Occurrences missed while the container is down are not blindly replayed; the scheduler decides catch-up versus skip by policy and records the decision. Watchers restart after recovery without duplicate firing.

## E6 — Git and merge coordination
**Status:** Engineering decision — recorded under PRD §24 delegation.
Each coding task gets an isolated branch and worktree; conflicting edits queue. The orchestrator prepares a merge request showing the change summary, changed files, validation status, conflict status, and target branch. Main-branch merges always require explicit user approval; the runtime never force-pushes or silently merges (PRD §10).

## E7 — Build order and definition of done
**Status:** Engineering decision — recorded under PRD §24 delegation.
Build in D23's Phase 0–7 order. The private prototype is done when PRD §19 criteria 1–21 **plus the six additions adopted in D45** pass for Phase 1–6 scope. Phase 7 (remote/cloud backends, admin console, benchmark trend tracking) is optional for the private prototype.

## E8 — Testing default
**Status:** Engineering decision — recorded under PRD §24 delegation.
CI runs unit, contract, integration, recovery, and `mock-runtime` E2E suites. `live-provider` tests are opt-in only and never run by default. Deterministic fake provider and fake Pi processes are mandatory `test-kit` components, and the mock path must exercise the real task/runtime code (D23).

---

# Supersession map

| Earlier | Superseded / refined by | Note |
|---|---|---|
| D2 initial "split deliberately" | D2 (refined) | Strict local-first: maximum product data in container; central PG = control-plane only. |
| D3 long-lived process per role | D32 | Persistent identity + on-demand session + task-governed worker. |
| D8 "PostgreSQL as source of truth" | D2, D10 | Product-state authority is container SQLite; central PG is control-plane only. |
| D18/D19 three-role agent pack | D29 + D43 | Pack contains an agent catalog, teams, Operations, skills, connectors; student pack v1 = 6 agents, 3 Operations. |
| D23 earlier 20-package monorepo | D23 (revised) | Three apps + ≤7 packages + feature modules. |
| "Expert" terminology (D29–D43) | D44 | "Agent" everywhere; Pack → Operations → Agents. |
| D43 "reused across at least two Operations" clause | **D46** (2026-09-17) | One home Operation per Agent; the coordinator role is cross-Operation (D42) and is not a roster assignment; cross-Operation work runs through subagent triggering. Full table: [`open-items-decisions-2026-09-17.md`](open-items-decisions-2026-09-17.md). |
| PRD §4.1/§4.2 dashboard and chat types | D29, D30, D31, D41, D44 | Sidebar = Agents + Operations; task-chat type retired; Operation preview; reusable Operation workspaces. |
| PRD §5 "three agents" | D29, D39, D43 | Agents become reusable identities inside a customer pack. |

---

# Deferred (explicitly out of scope for the private prototype)

From PRD §20 and the grilling session: native mobile/PWA packaging; full browser/desktop takeover; social/X search; production billing and metering; user/admin data export and permanent purge; enterprise orgs/teams/audit UI; multi-region and HA; managed secrets service; connector/OAuth marketplace; tool signing/marketplace/distribution; model routing/fallback optimization at scale; distributed tracing and formal load testing; cross-device sync for local-first data; cloud migration automation; cross-pack agent mixing (requires an explicit bridge policy).
