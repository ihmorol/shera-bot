# Shera Bot — Decision and Requirement Traceability

**Status:** Working traceability baseline for the synchronized PRD and the post-PRD decision records.  
**Last updated:** 2026-09-17  
**Canonical vocabulary:** [`GLOSSARY.md`](GLOSSARY.md)  
**Decision index:** [`decisions/README.md`](decisions/README.md)  
**Full session evidence:** `history/2026-09-08-to-2026-09-11/README.md` — removed from the working tree in commit `9d8b81c`; retrieve from Git history (for example `cea3ba1`) or the local `.session-archive/` copy.

## PRD synchronization record

On 2026-09-11 the product owner instructed synchronization of `docs/PRD.md` and the marketing landing page with the final decisions. The PRD was updated in place to reflect D1–D45 and E1–E8; the original 2026-09-08 baseline remains available in Git history (commit `8bacf81`) and in the session archive. The instruction that previously kept the PRD unchanged ("Dont change previous prd", 2026-09-11) is itself superseded by this later explicit instruction; both are preserved in the continuation transcript. The `business-landing-portfolio/` marketing site was aligned to the six-Agent student pack and Pack/Operation vocabulary and registered as an out-of-scope marketing surface in its README.

On 2026-09-17 the owner answered the Stage-1 roster question and delegated the Stage-2 dispositions in one instruction (verbatim in [`decisions/open-items-decisions-2026-09-17.md`](decisions/open-items-decisions-2026-09-17.md)). Recorded as **SYNC-2**: the PRD was synchronized with D46 (header, §5 lead and mapping paragraph, §5.4, §9 exhausted-credit visibility, §15 prototype admin note, §§21–22 pointer); D47–D50 and E9–E14 are engineering- and prototype-scope records with no further PRD text changes beyond those noted.

## Authority and status semantics

- `Confirmed` — explicit product-owner answer is preserved in the transcript.
- `Confirmed / incomplete acknowledgement` — explicit user answer exists, but the original assistant acknowledgement was lost or interrupted (D39).
- `Confirmed / refined` — the product owner accepted the decision and later clarification narrows or corrects it.
- `Provisional` — chosen for the prototype but requires a stated spike or validation before being treated as permanent (D13, D19).
- `Superseded` — historical decision retained for provenance; a later decision is authoritative.
- `Engineering` — implementation choice delegated by PRD §24 or derived from an already-confirmed product boundary; not a new product decision.
- `Deferred` — intentionally outside the private prototype.
- `Open` — not silently decided; requires a future product or engineering decision.

## Decision index

| ID | Status | Evidence | Supersedes / refined by | PRD touchpoints | Implementation / verification |
|---|---|---|---|---|---|
| D1 | Confirmed | Codex Q1, predecessor transcript | — | §§6, 12, 16 | Container boundary; tenancy/security tests |
| D2 | Confirmed / refined | Codex Q2 + local-first clarification | Refines initial D2 | §§6, 12, 17 | Repository ports; central/local storage tests |
| D3 | Superseded | Codex Q3 | D32 | §6 | Historical process model only |
| D4 | Confirmed | Codex Q4 | — | §§5, 8, 16 | Control-plane command validation |
| D5 | Confirmed | Codex Q5 | — | §§8, 14 | Event journal/projection tests |
| D6 | Confirmed | Codex Q6 | — | §§4, 7, 10 | Lease/conflict tests |
| D7 | Confirmed | Codex Q7 | — | §8 | Typed collaboration contract tests |
| D8 | Confirmed / storage scope refined | Codex Q8 | D2/D10 clarify local authority | §§8, 17 | Task transition unit tests |
| D9 | Confirmed | Codex Q9 | — | §8, §16 | Approval policy/security tests |
| D10 | Confirmed | Codex Q10 | — | §§12, 17 | SQLite migration/recovery tests |
| D11 | Confirmed | Codex Q11 | — | §§6, 14 | Runtime gateway integration tests |
| D12 | Confirmed | Codex Q12 + OpenHands comparison | — | §§6, 17 | Backend contract tests |
| D13 | Confirmed / provisional | Codex Q13 | — | §17 | Pi process-supervision spike |
| D14 | Confirmed | Codex Q14 | — | §17 | JSONL protocol/fake-Pi tests |
| D15 | Confirmed | Codex Q15 | — | §§5, 8, 17 | Context compiler budget tests |
| D16 | Confirmed / refined | Codex Q16 | — | §§4, 9 | Onboarding/settings contract tests |
| D17 | Confirmed / refined | Codex Q17 | — | §§9, 12, 20 | Provider configuration/error tests |
| D18 | Confirmed / extended | Codex Q18 | D29 | §§5, 17 | Pack manifest validation |
| D19 | Confirmed / refined | Codex Q19 | D29/D40 | §§6, 17 | Workspace pack pinning tests |
| D20 | Confirmed | Codex Q20 | — | §§9, 20 | Reservation/settlement ledger tests |
| D21 | Confirmed | Codex Q21 | — | §9 | Account balance tests |
| D22 | Confirmed | Codex Q22 | — | §§9, 12, 16 | Secret-redaction/custody tests |
| D23 | Confirmed / revised | Repository comparison + Q23 | Replaces 20-package proposal | §17, §22 | Monorepo boundary/CI checks |
| D24 | Confirmed | Codex Q24 | — | §17, §22 | Drizzle migration checks |
| D25 | Confirmed | Codex Q25 | — | §§14, 17 | Zod/OpenAPI contract tests |
| D26 | Confirmed | Codex Q26 | — | §§8, 14 | Replay cursor/reconnect tests |
| D27 | Confirmed | Codex Q27 | — | §§6, 7, 16 | Escape/resource/network tests |
| D28 | Confirmed | Codex Q28 | — | §§5, 17 | Pack loader/hash tests |
| D29 | Confirmed / product model revision | User image + taxonomy clarification | Extends D18/D19 | §§4, 5 | Pack/Operation/Agent model |
| D30 | Confirmed | Codex Q30 | — | §§4, 8 | Operation preview E2E |
| D31 | Confirmed | Codex Q31 | — | §4 | Multiple task runs per Operation |
| D32 | Confirmed / supersedes D3 | Codex Q32 + long-running-job clarification | D3 | §§6, 13 | Session/worker/recovery tests |
| D33 | Confirmed | Codex Q33 | — | §13 | Semantic checkpoint tests |
| D34 | Confirmed / refined | Codex Q34 + user objection | — | §8 | Runtime task-detection tests |
| D35 | Confirmed / refined | Codex Q35 + full-access clarification | — | §§7, 8, 16 | Tool approval/grant tests |
| D36 | Confirmed | Codex Q36 | — | §8 | Roster validation tests |
| D37 | Confirmed | Codex Q37 | — | §11 | Memory publication/provenance tests |
| D38 | Confirmed | Codex Q38 | — | §7 | Skill/tool/connector contract tests |
| D39 | Confirmed / incomplete acknowledgement | Explicit user reply `for the prototype yes`; original acknowledgement lost to HTTP 402 | — | §§5, 8 | Reconfirm if scope changes; identity pinning tests |
| D40 | Confirmed | ZCode Q40; `zcode-continuation-transcript.md` | — | §§4, 6 | One workspace; internal `workspace_id` |
| D41 | Confirmed | ZCode Q41 | Retires PRD task-chat type | §§4.1–4.2 | Agents/Operations navigation; ad-hoc Operation E2E |
| D42 | Confirmed | ZCode Q42; answer `ok` accepted recommendation | — | §§4.2, 5, 8 | Coordinator removal/peer protocol tests |
| D43 | Confirmed / roster clause superseded | ZCode Q43 | Roster-reuse clause superseded by D46 | §§5, 19 | Six-Agent/three-Operation pack fixture |
| D44 | Confirmed | ZCode Q44 | Supersedes historical Expert terminology | §§4, 5, 17, 21 | Glossary/lint terminology check |
| D45 | Confirmed | ZCode Q45 | Adds criteria 22–27 | §19 | Acceptance traceability below |
| SYNC-1 | Confirmed | User instruction 2026-09-11: "lets sync the prd, and landing page with the final decisions" | Supersedes the earlier leave-PRD-unchanged instruction | All | PRD synchronized 2026-09-11; landing page aligned; this file updated |
| D46 | Confirmed | Owner message 2026-09-17 (verbatim in the record) | Supersedes D43's roster-reuse clause; refines PRD §5, UI_DESIGN §1.4, PRODUCT.md | §§5, 19 | One home Operation per Agent; subagent triggering; pack v1 mapping; Pack contract tests (S2) |
| D47 | Delegated (pending owner review) | Owner instruction 2026-09-17 delegating Stage-2 dispositions | Extends E7 | §15 | Admin API/CLI procedures; restore drill through the CLI |
| D48 | Delegated (pending owner review) | Owner instruction 2026-09-17 | Confirms PRD §9 pause behavior; adds visible state | §9 | Reservation-failure contract test; resume-after-top-up |
| D49 | Delegated (pending owner review) | Owner instruction 2026-09-17 | Fills D42's removal lifecycle | §§4.2, 8 | Remove-coordinator-mid-run integration test |
| D50 | Delegated (pending owner review) | Owner instruction 2026-09-17 | Disposes the UX_RECOMMENDATIONS gate item | — | Phase-1 slice specs cite adopted recommendations |
| SYNC-2 | Confirmed | Owner instruction 2026-09-17 (same message as D46) | Records the 2026-09-17 PRD sync | §§5, 9, 15, 21–22 | PRD header/sections updated; this file updated |
| E1 | Engineering | PRD §24 delegation; D42 refinement | — | §6 | Admission/queue/resource tests |
| E2 | Engineering | PRD §24 delegation; D26 extension | — | §14 | Event retention/cursor tests |
| E3 | Engineering | PRD §24 delegation; PRD §8 timing | — | §8 | Reminder scheduler tests |
| E4 | Engineering | PRD §24 delegation; PRD §7/D35 | — | §7 | Tool inventory/approval tests |
| E5 | Engineering | PRD §24 delegation; PRD §§8, 13 | — | §§8, 13 | Watcher dedup/recovery tests |
| E6 | Engineering | PRD §24 delegation; PRD §10 | — | §10 | Worktree/merge approval tests |
| E7 | Engineering | PRD §24 delegation; D23 + D45 | — | §§19, 22 | Phase gates and acceptance runner |
| E8 | Engineering | PRD §24 delegation; D23 | — | §19, §22 | CI suite configuration |
| E9 | Delegated engineering (pending owner review) | PRD §§9, 12 + D17/D22; owner instruction 2026-09-17 | Clarifies the §12 boundary | §§9, 12 | Secret-redaction/custody tests |
| E10 | Delegated engineering (pending owner review) | E2 + owner instruction 2026-09-17 | Refines E2 for the prototype | §14 | Snapshot-fallback contract test |
| E11 | Delegated engineering (pending owner review) | PRD §12/§21; D10, D13; owner instruction 2026-09-17 | Details D10 | §§12, 21 | Stage 7 restore drill; acceptance 18 |
| E12 | Delegated engineering (pending owner review) | D40 + owner instruction 2026-09-17 | Applies D40 to the schema | §§12, 17 | Workspace-scoping repository tests |
| E13 | Delegated engineering (pending owner review) | PRD §13; D33, E2; owner instruction 2026-09-17 | Details D33 | §13 | Recovery-class test matrix |
| E14 | Delegated engineering (pending owner review) | PRD §§21–22; owner instruction 2026-09-17 | Defines register closure policy | §§21, 22 | Ledger accuracy at stage gates |
| E15 | Delegated engineering (pending owner review) | Issue #2 (S01); `BUILD_MAP` §5–§6; phase-0 plan §1/§8; owner instruction "Lets start building" 2026-09-17 | Resolves the S01 plan-confirmation conflict for this slice only | §17, §22.1, §22.22, §23 | CI green on PR #37 (verify, license inventory, mockup regression); 15 tests incl. license-expression regressions; license gate negative test |

## D45 acceptance traceability (criteria 22–27)

| Criterion | Source decision | Implementation boundary | Verification target | Status |
|---|---|---|---|---|
| 22. Workspace pins Pack/Operation/Agent versions | D29, D39, D40 | Pack loader, workspace/task repositories | Contract + persistence + restart tests | Adopted in PRD §19; not implemented |
| 23. Operation launch preview | D30 | Web preview + runtime command | Browser E2E with no execution before confirm | Adopted in PRD §19; not implemented |
| 24. Reusable Operation with independent task runs | D31, D34, D41 | Conversation/Operation/task modules | Multiple-run isolation integration test | Adopted in PRD §19; not implemented |
| 25. Browser-close survival and semantic resume | D32, D33 | Supervisor, checkpoint/recovery modules | Worker/browser-close/restart recovery test | Adopted in PRD §19; not implemented |
| 26. Read-only auto; mutation preview; reusable grant | D35 | Tool executor + approval policy | Risk-class and grant matrix tests | Adopted in PRD §19; not implemented |
| 27. Agent-private memory publication boundary | D37 | Memory repository + publication command | Cross-Agent visibility/security test | Adopted in PRD §19; not implemented |

## PRD reconciliation matrix

`docs/PRD.md` was synchronized with the decision records on 2026-09-11 (SYNC-1). The table below records, per section, what changed from the 2026-09-08 baseline and which decisions drove it. The baseline text remains retrievable from Git history (commit `8bacf81`) and the session archive.

| PRD section | 2026-09-08 baseline | Synchronized state (current) | Driving decisions |
|---|---|---|---|
| §§4.1–4.2 | Three fixed chats plus task-specific and group chats | Sidebar = Agents + Operations; task-chat type retired; Operation preview; reusable Operation workspaces with independent task runs; ad-hoc Operations; removable default coordinator | D29–D31, D41, D42, D44 |
| §5 | Researcher, Developer, General Assistant as always-on Pi processes | Reusable Agents in Packs; student pack v1 = six Agents (adds Citation Manager, Programming Tutor, Study Planner); persistent identity + on-demand sessions + task workers | D29, D32, D39, D43 |
| §6 | Three Pi processes per container | Supervised runtime gateway, on-demand Agent sessions, task workers; queue-on-exhaustion without killing healthy work | D11, D32, E1 |
| §§8, 16 | Risky actions pause; task/retry/cancel behavior | Adds runtime-inferred task creation (never NL classification) and scoped, expiring, revocable approval grants | D9, D34–D36 |
| §9 | Provider adapters and per-agent/provider settings | Adds reservation-and-settlement credits with single account balance; admin-funded providers; no mock fallback | D17, D20–D22 |
| §11 | Shared and private memory | Explicit memory scopes; Agent-private memory published into Operation context only explicitly | D37 |
| §§12–14 | Restart, WebSocket, replay, recovery | Adds semantic checkpoints; recovery pauses on unprovable external effects; exact effect handling remains implementation-defined | D5, D26, D32–D33, E2 |
| §17 | Stack named; module boundaries/versions open | Adds control-plane-only PostgreSQL, WAL SQLite, Drizzle, Redis-never-source-of-truth, three-app monorepo, Zod-first contracts, JSONL Pi adapter | D2, D8, D10, D23–D26, D13–D14 |
| §19 | Acceptance criteria 1–21 | Criteria 3–6 updated to the Pack/Operation model; criteria 22–27 added | D29, D45 |
| §§21–22 | Visual and engineering TODO lists | Partially resolved by D23–D45/E1–E8; the ten open items were dispositioned on 2026-09-17 (D46–D50, E9–E14) | D23–D45, D46–D50, E1–E14 |
| §24 | Explicit decisions should update PRD | Baseline honored during the freeze; PRD updated in place on 2026-09-11 by explicit instruction (SYNC-1) | SYNC-1 |

## Stage-2 disposition ledger (2026-09-17)

The ten implementation-defined items that were open on 2026-09-13 were dispositioned on 2026-09-17 under the owner's delegation (verbatim instruction in [`decisions/open-items-decisions-2026-09-17.md`](decisions/open-items-decisions-2026-09-17.md), which also holds the full rationale, alternatives, and verification targets).

| Item | Disposition | Record | Evidence target |
|---|---|---|---|
| Admin scope (E7 defers admin console) | Decided | D47 | Stage 7/8 runbook: admin CLI procedures |
| Admin provider-credential custody vs PRD §12 wording | Decided | E9 | Secret-redaction/custody tests (Stage 3/6) |
| Exhausted-credit UX and billing boundary | Decided | D48 | Reservation-failure contract test; top-up resume |
| Event compaction thresholds | Contract decided; thresholds production-gated | E10 | Snapshot-fallback contract test |
| SQLite backup/restore/migration procedure | Mechanism decided; replication production-gated | E11 | Stage 7 restore drill (acceptance 18) |
| `workspace_id` invariant | Decided (applies D40) | E12 | Workspace-scoping repository tests |
| Complete student Pack mapping (D43 conflict) | Decided by owner | D46 | Pack manifest validation (S2); fixture update entry |
| Coordinator removal lifecycle | Decided | D49 | Remove-coordinator-mid-run integration test |
| Per-tool recovery semantics | Decided | E13 | Recovery-class test matrix |
| PRD TODO register closure | Decided | E14 | Ledger accuracy at stage gates |

## Open / implementation-defined items (remaining)

Still deliberately open — not silently decided:

- **Exact subagent semantics** (D46): whether a subagent is a same-identity worker instance or another same-Pack Agent invoked as a subordinate, concurrency limits, and memory-scope boundaries. Owner + evidence target: before the Agent/Operation contracts freeze (Phase 0 S2), or recorded as an engineering decision at that point.
- **Pi fork license, modification obligations, and upstream-sync process** (PRD §22.1, S01 acceptance criterion): no Pi fork exists in the owner's GitHub account, nothing local matches it, and no repository document names the upstream project or its license — so the criterion could not be met without inventing text (G3/G5). Owner input required to identify the upstream; evidence target: before S03/S07, where the adapter first appears. Recorded in [`decisions/engineering-record-e15-2026-09-17.md`](decisions/engineering-record-e15-2026-09-17.md) decision 9.
- **Stage-3 plan confirmations** (dark-only `apps/web` v1, CI provider, pnpm/Node pins): S01 was executed on 2026-09-17 under the owner's instruction to start building, with these recorded as **Delegated — pending owner review** in E15 (decision 1 of that record notes the conflict between the plan draft's approval gate and `BUILD_MAP` §6/issue #2). Owner review of E15 closes them.
- **UX_RECOMMENDATIONS**: dispositioned as not-adopted-now (D50, Delegated, pending owner review); individual recommendations are evaluated per Phase-1 UI slice.

Each remaining item needs an owner, evidence target, and decision record before it is treated as closed.

## Related-but-out-of-scope artifacts

- **`business-landing-portfolio/`** — the marketing/waitlist site (Next.js). Its copy was synchronized to the final decisions on 2026-09-11 (six Agents, Pack → Operations → Agents vocabulary, Operation-based demo). It is a marketing surface that intentionally simplifies the product model and sells the long-term vision; it is out of scope for the prototype's acceptance criteria (PRD §19) and its waitlist is UI-only until a backend provider is connected. Its README records these boundaries.
