# Shera Bot — Decision and Requirement Traceability

**Status:** Working traceability baseline for the synchronized PRD and the post-PRD decision records.  
**Last updated:** 2026-10-01 (S09 chunk 3 — evidence appended to the D26/D34/E8/E10/E13 rows; no decision statuses changed)  
**Canonical vocabulary:** [`GLOSSARY.md`](GLOSSARY.md)  
**Decision index:** [`decisions/README.md`](decisions/README.md)  
**Full session evidence:** `history/2026-09-08-to-2026-09-11/README.md` — removed from the working tree in commit `9d8b81c`; retrieve from Git history (for example `cea3ba1`) or the local `.session-archive/` copy.

## PRD synchronization record

On 2026-09-11 the product owner instructed synchronization of `docs/PRD.md` and the marketing landing page with the final decisions. The PRD was updated in place to reflect D1–D45 and E1–E8; the original 2026-09-08 baseline remains available in Git history (commit `8bacf81`) and in the session archive. The instruction that previously kept the PRD unchanged ("Dont change previous prd", 2026-09-11) is itself superseded by this later explicit instruction; both are preserved in the continuation transcript. The `business-landing-portfolio/` marketing site was aligned to the six-Agent student pack and Pack/Operation vocabulary and registered as an out-of-scope marketing surface in its README.

On 2026-09-17 the owner answered the Stage-1 roster question and delegated the Stage-2 dispositions in one instruction (verbatim in [`decisions/open-items-decisions-2026-09-17.md`](decisions/open-items-decisions-2026-09-17.md)). Recorded as **SYNC-2**: the PRD was synchronized with D46 (header, §5 lead and mapping paragraph, §5.4, §9 exhausted-credit visibility, §15 prototype admin note, §§21–22 pointer); D47–D50 and E9–E14 are engineering- and prototype-scope records with no further PRD text changes beyond those noted.

On 2026-09-19 the owner directed dual harness support — "i want pi as a default, and hermes as a second option to choose which harness agent will use" (verbatim in [`decisions/owner-decision-d51-dual-harness-2026-09-19.md`](decisions/owner-decision-d51-dual-harness-2026-09-19.md)). Recorded as **SYNC-3**: the PRD was synchronized with D51 (header, §5 Agent session process, §17 stack adapter line, §19 AC4, §22 new Hermes-evidence item). D51 extends rather than supersedes D13/D14 — Pi remains the default harness and E17's validated seam its supervision path; the Hermes path stays contract-defined until the owner supplies its upstream source and license evidence (same pattern as `PI_FORK.md`).

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
| D26 | Confirmed | Codex Q26 | — | §§8, 14 | Replay cursor/reconnect tests. S09 (2026-10-01): idempotent `message.send` + receipt replay (`e248490`, `messages.test.ts`); WS transport + live reducer with the reconnect replay batch marker (`66e7506`, `runtime-live.test.ts`); cursor-ack-on-render so the replay resume covers rendered history only (`8cc44c2`); two-tab fanout + reconnect replay-once probe (`65876dd`, `recovery-probes.test.ts`); full-path replay leg in the mock-runtime E2E (`0780ba3`) |
| D27 | Confirmed | Codex Q27 | — | §§6, 7, 16 | Escape/resource/network tests |
| D28 | Confirmed | Codex Q28 | — | §§5, 17 | Pack loader/hash tests |
| D29 | Confirmed / product model revision | User image + taxonomy clarification | Extends D18/D19 | §§4, 5 | Pack/Operation/Agent model |
| D30 | Confirmed | Codex Q30 | — | §§4, 8 | Operation preview E2E |
| D31 | Confirmed | Codex Q31 | — | §4 | Multiple task runs per Operation |
| D32 | Confirmed / supersedes D3 | Codex Q32 + long-running-job clarification | D3 | §§6, 13 | Session/worker/recovery tests |
| D33 | Confirmed | Codex Q33 | — | §13 | Semantic checkpoint tests |
| D34 | Confirmed / refined | Codex Q34 + user objection | — | §8 | Runtime task-detection tests. S09 (2026-10-01): G2/D34 regression — a plain conversation turn creates NO task run and no `task.*` journal events anywhere (`e248490`, `messages.test.ts`; whole-path assertion in the mock-runtime E2E, `0780ba3`) |
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
| D51 | Confirmed | Owner instruction 2026-09-19 (verbatim in [`decisions/owner-decision-d51-dual-harness-2026-09-19.md`](decisions/owner-decision-d51-dual-harness-2026-09-19.md)) | Extends D13/D14 — Pi remains the default harness; E17's seam is the default path | §§5, 17, 19, 22 | Harness-field contract tests (S10); settings QA (S11); dual-harness supervision tests (S12); harness-agnostic gateway seam (S07); Hermes path blocked on owner-supplied upstream evidence |
| SYNC-2 | Confirmed | Owner instruction 2026-09-17 (same message as D46) | Records the 2026-09-17 PRD sync | §§5, 9, 15, 21–22 | PRD header/sections updated; this file updated |
| SYNC-3 | Confirmed | Owner instruction 2026-09-19 (same message as D51) | Records the 2026-09-19 dual-harness PRD sync | §§5, 17, 19, 22 | PRD header/sections updated; this file updated |
| E1 | Engineering | PRD §24 delegation; D42 refinement | — | §6 | Admission/queue/resource tests |
| E2 | Engineering | PRD §24 delegation; D26 extension | — | §14 | Event retention/cursor tests |
| E3 | Engineering | PRD §24 delegation; PRD §8 timing | — | §8 | Reminder scheduler tests |
| E4 | Engineering | PRD §24 delegation; PRD §7/D35 | — | §7 | Tool inventory/approval tests |
| E5 | Engineering | PRD §24 delegation; PRD §§8, 13 | — | §§8, 13 | Watcher dedup/recovery tests |
| E6 | Engineering | PRD §24 delegation; PRD §10 | — | §10 | Worktree/merge approval tests |
| E7 | Engineering | PRD §24 delegation; D23 + D45 | — | §§19, 22 | Phase gates and acceptance runner |
| E8 | Engineering | PRD §24 delegation; D23 | — | §19, §22 | CI suite configuration. S09 (2026-10-01): the E8 mock-runtime mode is executable acceptance — deterministic in-process runtime (`8079f76`, `e2e-mode.test.ts`), the mock-runtime E2E driving login → chat → send → stream → refresh → replay through the real client/proxy/runtime (`0780ba3`, `apps/web/test/e2e/mock-runtime-e2e.test.ts`), and the recovery probes (`3b3cd5f`, `65876dd`) |
| E9 | Delegated engineering (pending owner review) | PRD §§9, 12 + D17/D22; owner instruction 2026-09-17 | Clarifies the §12 boundary | §§9, 12 | Secret-redaction/custody tests |
| E10 | Delegated engineering (pending owner review) | E2 + owner instruction 2026-09-17 | Refines E2 for the prototype | §14 | Snapshot-fallback contract test. S09 (2026-10-01): the fallback is an honest typed surface — `snapshot_required` replays as the typed `SNAPSHOT_REQUIRED_MESSAGE` state, never fabricated history (chunk 1 `5128959`: wire parser `runtime-client.test.ts` "a snapshot-required answer surfaces as its own honest kind, never as events"; typed fallback state `runtime-live.test.ts` "the E10 snapshot fallback is the honest typed surface"; render branch `runtime-chat.test.ts` "a real-data failure is the §2.4 error state with the safe message"; fix round 2026-10-01 corrected the earlier `s09-real-rows.test.ts` citation — that file covers the command/replay receipt round-trip, not snapshot_required); unknown streams replay as an honest empty batch (`e2e-mode.test.ts`); the reconnect resume cursor acknowledges after render (`8cc44c2`) |
| E11 | Delegated engineering (pending owner review) | PRD §12/§21; D10, D13; owner instruction 2026-09-17 | Details D10 | §§12, 21 | Stage 7 restore drill; acceptance 18 |
| E12 | Delegated engineering (pending owner review) | D40 + owner instruction 2026-09-17 | Applies D40 to the schema | §§12, 17 | Workspace-scoping repository tests |
| E13 | Delegated engineering (pending owner review) | PRD §13; D33, E2; owner instruction 2026-09-17 | Details D33 | §13 | Recovery-class test matrix. S09 (2026-10-01) first recovery-class probes for the conversation slice: kill -9 mid-stream restart on the same SQLite file — journal intact, receipt replays, nothing invented (`3b3cd5f`, `kill9-recovery.test.ts`); oversized/empty typed rejections with no partial effects, duplicate-send receipt replay (referencing `messages.test.ts`), and the two-tab fanout/reconnect probe (`65876dd`, `recovery-probes.test.ts`) |
| E14 | Delegated engineering (pending owner review) | PRD §§21–22; owner instruction 2026-09-17 | Defines register closure policy | §§21, 22 | Ledger accuracy at stage gates |
| E15 | Delegated engineering (pending owner review) | Owner instructions 2026-09-18 (leverage OSS across the build; per-issue references); 2026-09-18 research with license verification | — | §§17, 22, 23 (no product text changes) | S01 license-allowlist CI gate; per-slice "Open-source leverage" sections in issues #1–#36; per-slice E-notes |
| E16 | Delegated engineering (pending owner review) | Issue #2 (S01); `BUILD_MAP` §5–§6; phase-0 plan §1/§8; owner instructions 2026-09-17, including the `ihmorol/shera-pi` fork URL | Resolves the S01 plan-confirmation conflict for this slice only; fork evidence update supersedes the missing-source blocker in decision 9, preserving its history. **Recorded as "E15" on 2026-09-17 and renumbered to E16 on 2026-09-19**: the E15 identifier had been taken on `main` by the 2026-09-18 OSS-leverage record; the renumbering is mechanical and preserves the record's full content (G5, surfaced not buried) | §17, §22.1, §22.22, §23 | Last pushed S01 CI green on PR #37; 15 tests incl. license-expression regressions; [fork source/license verification](pi-fork/verification-2026-09-17.md), not runtime acceptance |
| E17 | Delegated engineering (pending owner review) | Issue #4 (S03); spike runs of 2026-09-19 (`spikes/d13/results/supervision-2026-09-19.txt`, `spikes/d13/results/sqlite-2026-09-19.txt`, machine-readable JSON + per-iteration artifacts alongside); D13, D14, D10, D24, E11 | Resolves D13's provisional status for the prototype ("validated as recorded": supervision seam = Pi child process with versioned JSONL over stdin/stdout, per D14); validates D24's `node:sqlite` initial driver choice against D10's requirements; makes E11's deferred final call on the backup mechanism (`VACUUM INTO` + `PRAGMA integrity_check`). Variant B (HTTP sidecar) and better-sqlite3 preserved as named alternatives with measured reasons | §22.3 (evidence for E11's §§12, 21 targets unchanged) | Spike evidence committed under `spikes/d13/`; one documented command re-runs each benchmark; root baseline 196/196 tests on `f19ee52`; fake Pi only, no network; no production dependency added |
| E19 | Delegated engineering (pending owner review) | Issue #11 (S10); `agent-packs/student/v1/manifest.json`; D46, D29, D19 | Resolves the D46 subagent sub-item at the engineering level: subordinate execution = a typed task run through the gateway; one subordinate run per (workspace, Agent) placeholder for S16; no private-memory inheritance (S29) | §5, §13 | Pack manifest validation + workspace pack-pinning tests; `pack-pin.test.ts` |
| E20 | Delegated engineering (pending owner review) | Review of stacked PRs #46–#49 on `fix/s10-windows-portability-gates` (`48c1f00`, `aaf2be7`); fresh-context adversarial review + verification pass with negative controls | Records two cross-platform test-harness defects found by review — a hardcoded POSIX PostgreSQL path (`SHERA_PG_BIN` resolver replaces it) and SQLite temp dirs deleted with open handles (connection registry + bounded retry). Records the correction that the first fix missed two suites. **No product behavior, schema, contract, or acceptance criterion changed** | §22 (verification evidence only; no PRD text change) | `pnpm test` on Windows: 15 failed files / 604 passed → 9 failed files / 609 passed. **Not verified:** the 9 PostgreSQL-dependent suites against a real PostgreSQL 16 install (needs Linux CI or `SHERA_PG_BIN`) |

## E22 implementation evidence, 2026-10-20

[Engineering record E22](decisions/engineering-record-e22-runtime-integration-2026-10-20.md) records the runtime integration repair batch. Tests, build, type checking, source lint and boundary checks support bounded HTTP-routing, management-startup and persistence claims. PostgreSQL, Docker and browser QA remain unverified. Existing acceptance statuses below are unchanged. Implementation owner: coding agent; release verification owner: maintainer. Evidence: output/implementation-2026-10-20/ in this checkout.

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

- **Exact subagent semantics** (D46): the engineering-level choice is now recorded — [E19](decisions/engineering-record-e19-d46-subagent-semantics-2026-10-02.md) (filed 2026-10-02 with slice S10): subordinate execution = a typed task run through the gateway (the same-identity worker reading; the "another same-Pack Agent as subordinate" reading is deferred to S13), a one-run-per-(workspace, Agent) concurrency placeholder for S16, and a no-private-memory-inheritance boundary for S29. Owner veto at the S10 merge gate (G8); a product-level reversal supersedes E19 via a recorded decision.
- **Pi fork follow-through** (PRD §22.1): the original missing-repository/license-documentation blocker is resolved by the owner's `https://github.com/ihmorol/shera-pi.git` and the verified MIT copy, modification obligations, and proposed sync procedure in [`PI_FORK.md`](PI_FORK.md). The S01 documentation is supplied for owner review, not blanket compliance or runtime acceptance. Still open: dependency/build inventory, bundled-file notices (including the incomplete Highlight.js attribution), tested adapter integration, and approval of the maintenance procedure. Owner: Emon; implementation owner: the real-fork integration slice (S07, or an earlier explicitly scoped experiment); evidence target: before real integration/build distribution, with artifact-level notice verification in S35. History and status transition: [E16 fork evidence update](decisions/engineering-record-e16-2026-09-17.md#fork-evidence-update-2026-09-17).
- **Stage-3 plan confirmations** (dark-only `apps/web` v1, CI provider, pnpm/Node pins): S01 was executed on 2026-09-17 under the owner's instruction to start building, with these recorded as **Delegated — pending owner review** in E16 (decision 1 of that record notes the conflict between the plan draft's approval gate and `BUILD_MAP` §6/issue #2). Owner review of E16 closes them.
- **UX_RECOMMENDATIONS**: dispositioned as not-adopted-now (D50, Delegated, pending owner review); individual recommendations are evaluated per Phase-1 UI slice.

Each remaining item needs an owner, evidence target, and decision record before it is treated as closed.

## Related-but-out-of-scope artifacts

- **`business-landing-portfolio/`** — the marketing/waitlist site (Next.js). Its copy was synchronized to the final decisions on 2026-09-11 (six Agents, Pack → Operations → Agents vocabulary, Operation-based demo). It is a marketing surface that intentionally simplifies the product model and sells the long-term vision; it is out of scope for the prototype's acceptance criteria (PRD §19) and its waitlist is UI-only until a backend provider is connected. Its README records these boundaries.

## PostgreSQL verification follow-up, 2026-10-20

The earlier E20/E22 local PostgreSQL verification gap is resolved: the executor and parent independently passed 834 tests in 84 files using real PostgreSQL 16.15. See the dated follow-ups in E20 and E22 and `output/sequential-coding-2026-10-20/task-3/parent-full-suite.log`. Acceptance statuses are unchanged; Docker, real OAuth/provider integration and browser acceptance still need their recorded checks.


## E23 live transport follow-up, 2026-10-20

[Engineering record E23](decisions/engineering-record-e23-authenticated-live-transport-2026-10-20.md) completes E22's deferred authenticated live-routing implementation. Parent browser evidence covers a seeded real session, account-bound runtime, live user message, refresh/reconnect and actual Auth.js signout; this does not prove real Google login, model execution, Docker replacement or full browser acceptance. Full integration checks and exact commit are pending the sequential review ledger. Existing acceptance statuses and product decisions are unchanged.

## E24 S11 agent identity follow-up, 2026-10-24

## E25 S12 session supervision follow-up, 2026-10-24

[Engineering record E25](decisions/engineering-record-e25-s12-session-supervision-2026-10-24.md) records the S12 implementation on branch `s12-agent-session` (commits 857f98f…d5205d7): the versioned JSONL D14 protocol and SessionSupervisor lifecycle (heartbeats, escalation, restart windows, terminal failure), the single process-spawn seam with the env-configured harness command and the D15 context through the environment, durable idempotent session replies (`session-reply-<event_id>` through the one conversations command path), the presence read model on the agent API with the chat header's honest chip and once-per-browser-session note, and the four policy env knobs with typed range validation. Recorded limitations: live presence WebSocket fanout is deferred (the 5 s poll is the mechanism of record), and D51 per-Agent harness selection is deferred to the providers slice. Full suite 936/936 tests in 90 files; boundary guards PASS; real-browser captures under `apps/web/.impeccable/review/s12/` with the journal showing measured start latencies, idle hibernations, and idle-resume restarts. NOT verified (standing): the real Pi binary, Docker, real OAuth. Acceptance statuses and product decisions are unchanged.


[Engineering record E24](decisions/engineering-record-e24-s11-agent-identity-2026-10-24.md) records the S11 implementation: v4/v5 identity migrations with the composite `(workspace_id, agent_id)` key (D39 one-identity, E12 scoping), journaled get-or-create direct chats, atomic settings commands, the folder-guard seam over the durable file store, and the reconciliation merge of the two S11 continuation lines (this branch's fix/taste-pass line with the device hardening line carrying E23). The unjournaled settings-command boundary is a recorded, bounded decision — re-derive from the pack seed on DB loss; recovery stays with S31/S32. Fresh-archive gate: 855/855 tests in 85 files against real host PostgreSQL 16, all gates green. Two-axis reviews MERGEABLE; recorded follow-ups: PATCH-route retirement (P2), the AC4 Operation-context identity test (S12/S13), a two-account live-transport isolation test, the GET-side-effect restructure, and idempotency receipts (S30). Acceptance statuses and product decisions are unchanged.

## E26 S13 Operation chat follow-up, 2026-10-24

[Engineering record E26](decisions/engineering-record-e26-s13-operation-chat-2026-10-24.md) records the S13 Operation chat implementation on branch `s13-operation-chat` (chunks ec2ba95…9163bbe plus the consolidated review-fix round afeddf0…317a3fa) and closes the D46 sub-item's S13 promise (issue #14 criterion 9, the record [E19](decisions/engineering-record-e19-d46-subagent-semantics-2026-10-02.md) deferred here): subordinate execution = EXACTLY ONE identity-less child run per TaskDelegated event with `parent_task_id`, created only through the runtime's delegation path (the plain append refuses the type — no in-process bypass), idempotent via a same-transaction receipt; D46 reading 2 (a different same-Pack Agent as delegated-identity subordinate) stays deferred and concurrency limits stay the S16 placeholder. Recorded as bounded limitations, not silent gaps: D36 risk classification is CLIENT-asserted (server-side `requires_approval` derivation deferred to the providers slice with per-Agent cost metadata), the approval-ARTIFACT gate is S20's, and run transition legality is the runtime gateway's (`applyRunState` validates the D8 vocabulary only; no HTTP route exposes state writes). The receipts seam (D23 rule 6) now also covers remove-roster commands — a replayed remove answers the original applied outcome and an absent member is the idempotent no-op, so `OPERATION_ROSTER_AGENT_NOT_FOUND` is no longer produced. Full suite 1012/1012 tests in 89 files, zero skipped; root typecheck gate green; AC2 (peer-to-peer notice), AC3 (requires_approval recording), and AC8 (chat usable after runs complete) evidence pinned by name. Standards review MERGEABLE; spec review MERGEABLE WITH CONDITIONS — the conditions are closed by this round. Acceptance statuses and product decisions are unchanged.

## S14 ad-hoc Operations follow-up, 2026-10-24

The S14 ad-hoc Operation slice (branch `s14-adhoc-operations`, commits a919e04…e1fd604 plus the evidence chunk) implements D41/D42 on the runtime and web surfaces: unnamed ad-hoc creation through POST /v1/operations (`name: null` → the server-derived `Ad-hoc · N Agents` auto-label, `definition_ref: null` → the durable ad-hoc identity), the typed create refusals (`OPERATION_ROSTER_EMPTY`, pack-defined `OPERATION_NAME_REQUIRED`), the OperationRenameCommand envelope with the rename route behind the browser allowlist, derived `auto_label`/`is_adhoc` read-model fields, the pinned pack's `pack_summary` (skills + connectors) on the detail read model, and the web creation form (optional name, zero-Agent inline refusal, named peer-to-peer coordinator choice), rename affordance (idle edit action, editing state, read-after-write persistence; the empty-name submit is blocked client-side and the runtime independently answers the typed `OPERATION_COMMAND_INVALID` 400), ad-hoc marking in the chat header and sidebar, and the collapsible pack-details strip — closing the 2026-09-13 conformance finding [F6](../mockup/reviews/2026-09-13/docs-conformance-audit-2026-09-13.md) ("Ad-hoc created chat lacks the collapsible roster/skills/connectors summary"): the summary renders the roster count plus the pinned pack's skills and connectors with the honest fixed "Not configured" connector status (D38); the historical audit files stay unchanged as history. Evidence: 21 real-browser captures under `apps/web/.impeccable/review/s14/` (creation flow and header at 360/768/1440, empty-form refusal, peer-to-peer choice, auto-label chat, pack summary open/collapsed, rename editing/validation/persisted states, sidebar marking, roster-picker hover, keyboard focus) from a live session that exercised POST /v1/operations (unnamed and named), the roster add with its D36 confirm step, an @-addressed thread message, a successful rename, and the wire-level empty-name rename rejection; no new animations (the only transitions are the pre-existing skeleton pulse and color hover patterns). Full suite 1144/1144 tests in 96 files, typecheck, lint, format, boundary guards, and build green; the mock control plane used for the gate (capture-only session/status stand-in + local-API passthrough) was never committed. NOT verified (standing owners): real Google OAuth behind the session (mock projection), real providers/Pi runs, Docker, live WS fanout for the Operation thread (refetch-based refresh), real connector configuration. Acceptance statuses and product decisions are unchanged.

## E27 S16 task worker supervision follow-up, 2026-10-25

[Engineering record E27](decisions/engineering-record-e27-s16-worker-supervision-2026-10-25.md) records the S16 implementation on branch `s16-worker-supervision` (chunks 61b6a8f…4cb945e, PR #58 open) and closes the concurrency placeholder [E19](decisions/engineering-record-e19-d46-subagent-semantics-2026-10-02.md)/E26 left with S16: D32 layer 3 — ONE supervised worker process per run, governed by the task state (no idle timer, no hibernation; the AC25 hibernation-independence proof composes both supervisors over the same journal) — plus E1 admission control. The recorded choices: a crash escalates (shutdown frame → SIGTERM → SIGKILL) and lands the run in `RECOVERY_REQUIRED`, never terminal `FAILED` (FAILED would foreclose the D32 recovery policy; the resume-or-fail decision is the recovery slice's); the admission queue is durable `task_workers` lease rows + the in-process supervisor, with **BullMQ/Redis rejected** (D10/PRD §17 — no second state store or network dependency on the single VM); kernel enforcement via `prlimit --as/--nproc` exec'd as a binary (never a shell), including the empirically verified per-uid RLIMIT_NPROC honesty about why `--nproc=1` aborts Node at boot; the disk `statfs` probe fails OPEN as a documented posture (a demanded floor without a probe is a typed startup failure); refusal never kills — runs go durably QUEUED with four machine-readable reasons and re-admit oldest-first; progress/checkpoints commit journal event + row in one transaction (D10); boot reconciliation reaps dead-pid rows (EPERM counts alive), re-queues QUEUED runs through the same gate, and leaves RECOVERY_REQUIRED for the recovery slice; `hibernateIdleSessionsNow("resource_pressure")` hibernates idle sessions immediately under pressure with the reason journaled while healthy workers are never killed for capacity (the automatic trigger policy is recorded open, not silently absent); `SHERA_WORKER_HARNESS_COMMAND` absent = runs behave exactly as before (G4); and `GET /v1/workers/admission` is the one allowlisted browser read, giving UI_DESIGN S11's resource states a real surface. Full suite 1154/1154 tests, zero skipped (supervisor 16, admission 16, workers-api 11, web readout 13); boundary-guard exceptions named in both guard surfaces. NOT verified (standing): real task-worker harnesses, Docker/cgroups, real OAuth. Acceptance statuses and product decisions are unchanged.
