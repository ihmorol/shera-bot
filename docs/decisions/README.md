# Shera Bot — Decision Records Index

**Status:** D1–D51 recorded (D51 owner-confirmed, 2026-09-19); E1–E17 recorded as engineering decisions (E1–E14 on 2026-09-17; E15 on 2026-09-18; E16 on 2026-09-17 with slice S01, renumbered from "E15" on 2026-09-19 to resolve the identifier collision; E17 on 2026-09-19 with slice S03); SYNC-1, SYNC-2, and SYNC-3 record the PRD synchronizations of 2026-09-11, 2026-09-17, and 2026-09-19. D46 and D51 are owner-confirmed; D47–D50 and E9–E17 are Delegated (agent-decided under the owner's explicit instructions) pending owner review.
**Last updated:** 2026-09-19
**Canonical vocabulary:** **Pack → Operations → Agents**.
**PRD policy:** [`docs/PRD.md`](../PRD.md) was synchronized with D1–D45 on 2026-09-11, with D46 on 2026-09-17 (SYNC-2), and with D51 on 2026-09-19 (SYNC-3) by explicit product-owner instruction (previously it was the unchanged 2026-09-08 baseline).

## Start here

1. [`../README.md`](../README.md) — repository entry point and mandatory rules.
2. [`../PRD.md`](../PRD.md) — synchronized product baseline (2026-09-19, D1–D51/E1–E17).
3. [`README.md`](README.md) — this index and status semantics.
4. [`confirmed-decisions.md`](confirmed-decisions.md) — Codex D1–D39, including historical wording and evidence limitations.
5. [`closure-decisions.md`](closure-decisions.md) — continued D40–D45, engineering E1–E8, proposal dispositions, supersession, and deferred work.
6. [`open-items-decisions-2026-09-17.md`](open-items-decisions-2026-09-17.md) — D46–D50 and E9–E14: the Stage-1 roster/subagent decision and the Stage-2 disposition of the ten open items, with the filled disposition ledger.
7. [`proposal-history.md`](proposal-history.md) — full P1–P9 recommendations, alternatives, rationale, and dispositions.
8. [`../GLOSSARY.md`](../GLOSSARY.md) — authoritative names and object boundaries.
9. [`../TRACEABILITY.md`](../TRACEABILITY.md) — PRD reconciliation, implementation/test mapping, acceptance criteria, and open items.
10. `../history/2026-09-08-to-2026-09-11/README.md` — complete three-day archive and source inventory, including earlier product-origin sessions. Removed from the working tree in commit `9d8b81c`; retrieve it from Git history (for example `cea3ba1`) or the local `.session-archive/` copy.
11. `../history/2026-09-08-to-2026-09-11/source-manifest.md` — tracked source inventory, checksums, and missing-source notes (same retrieval note as above).

## Status vocabulary

- **Confirmed** — explicit product-owner answer is preserved in the readable transcript.
- **Confirmed / incomplete acknowledgement** — the user's explicit answer exists, but the original assistant acknowledgement was lost or interrupted (D39).
- **Confirmed / refined** — accepted, then narrowed or corrected by a later clarification.
- **Delegated** — decided by the agent under an explicit owner instruction (D47–D50, E9–E14, 2026-09-17; E15, 2026-09-18), with rationale, alternatives, and evidence recorded; becomes Confirmed on owner review.
- **Provisional** — selected for the prototype but requires a named spike or validation before becoming permanent (D13, D19).
- **Superseded** — retained for history; a later decision is authoritative.
- **Engineering** — an implementation choice delegated by PRD §24 or derived from an accepted boundary; not a new product decision.
- **Deferred** — intentionally outside the private prototype.
- **Open** — deliberately not silently decided; see [`../TRACEABILITY.md`](../TRACEABILITY.md).

## Decision records

| File | Contents |
|---|---|
| [`confirmed-decisions.md`](confirmed-decisions.md) | D1–D39 from the original Codex grilling. D3 is superseded by D32; D39 is confirmed from an explicit answer but has an incomplete original acknowledgement. Historical `Expert` wording is retained only as evidence and is superseded by D44. |
| [`closure-decisions.md`](closure-decisions.md) | D40–D45 answered one at a time in this session; E1–E8 engineering dispositions; proposal dispositions; supersession and deferred registers. D43's roster-reuse clause is superseded by D46. |
| [`open-items-decisions-2026-09-17.md`](open-items-decisions-2026-09-17.md) | D46 (owner-confirmed roster/subagent model and student pack v1 mapping) and the Delegated records D47–D50 + E9–E14 covering the ten Stage-2 open items; filled disposition ledger; 2026-09-17 supersession and production-gate additions. |
| [`oss-leverage-decisions-2026-09-18.md`](oss-leverage-decisions-2026-09-18.md) | E15: the open-source leverage policy (embed / pattern-only / never-adopt tiers, license allowlist gate, anti-creativity rule) and the per-slice adoption map; mirrors the "Open-source leverage" sections in issues #1–#36 and BUILD_MAP §8. |
| [`engineering-record-e16-2026-09-17.md`](engineering-record-e16-2026-09-17.md) | E16 (filed 2026-09-17 as "E15"; renumbered 2026-09-19): S01 scaffold record — plan-approval conflict resolution, CI provider, toolchain pins, TypeScript line, layout, test runner, license gate with reviewed exceptions, and the owner-supplied Pi fork (`ihmorol/shera-pi`) evidence update. Delegated, pending owner review. |
| [`engineering-record-e17-2026-09-19.md`](engineering-record-e17-2026-09-19.md) | E17: S03 spike record — Pi supervision seam (variant A validated, D13/D14 "validated as recorded"), SQLite driver (`node:sqlite`, validating D24's initial choice), and E11 backup mechanism (`VACUUM INTO` + `PRAGMA integrity_check`), with measured evidence. Delegated, pending owner review; the owner's D51 instruction (same day) confirms its Pi-default direction. |
| [`owner-decision-d51-dual-harness-2026-09-19.md`](owner-decision-d51-dual-harness-2026-09-19.md) | D51 (owner-confirmed, SYNC-3): dual harness — Pi is the default Agent session harness, Hermes is a selectable second option chosen per Agent; extends (does not supersede) D13/D14; Hermes path blocked on owner-supplied upstream source and license evidence, same pattern as `PI_FORK.md`. |
| [`engineering-record-e19-d46-subagent-semantics-2026-10-02.md`](engineering-record-e19-d46-subagent-semantics-2026-10-02.md) | E19 (filed 2026-10-02 with slice S10; **E18 remains reserved** for the D51 Hermes engineering record): resolves the D46 sub-item at the engineering level — subordinate execution = a typed task run through the gateway (same-identity worker reading; D46 reading 2 deferred to S13), one subordinate run per (workspace, Agent) placeholder, no private-memory inheritance. Delegated, owner veto at the S10 G8 gate. |
| [`engineering-record-e20-cross-platform-test-harnesses-2026-10-02.md`](engineering-record-e20-cross-platform-test-harnesses-2026-10-02.md) | E20 (filed 2026-10-02 during review of stacked PRs #46–#49): records two cross-platform test-harness defects — a hardcoded POSIX PostgreSQL binary path (now a `SHERA_PG_BIN` resolver, G4 configuration-state error) and SQLite temp directories deleted with open handles (connection registry + bounded retry). Records the correction that the first fix missed two suites. **No product behavior or acceptance status changes**; the 9 PostgreSQL-dependent suites remain unverified on a host without PostgreSQL 16. Delegated, pending owner review. |
| [`engineering-record-e21-agent-visual-identity-2026-10-02.md`](engineering-record-e21-agent-visual-identity-2026-10-02.md) | E21 (filed 2026-10-02 with the Agent 3D identity profiles change): records that the Pack's authored `ui_identity` (hue + glyph) is now authoritative in the client — previously declared and pinned by a test, then silently discarded at render time — plus the derived-fallback, hue-boundary, silhouette-distinctness, code-point-glyph, and non-finite-hue rules. Includes the correction that 4 silhouette buckets collapsed the six shipped Agents into 3. Presentation only (D38); **owner item:** `UI_DESIGN` §21 item 4 leaves avatar art open for the owner's sketch. Delegated, pending owner review. |
| [`proposal-history.md`](proposal-history.md) | Full P1–P9 problem statements, alternatives, recommendations, objections, and final dispositions. |

## Current product model

```text
Pack
├── Operations
│   └── Agents
│       ├── Skills
│       ├── Tools
│       └── Connectors
```

- A user has one workspace in the prototype; the user container is its isolation boundary.
- The sidebar has two sections: **Agents** (persistent direct chats) and **Operations** (reusable collaborative chats).
- An Operation may be pack-defined or ad hoc, but all Agents must come from the same Pack.
- Each Agent is rostered in exactly one pack-defined Operation; cross-Operation work runs through **subagent triggering** — an Agent can trigger multiple subagents within its Operation (D46).
- The General Assistant is the default removable coordinator of every Operation; its cross-Operation presence is the coordinator role, not a roster assignment (D42, D46). The runtime remains authoritative whether coordination is centralized or peer-to-peer.
- Student Pack v1 contains six Agents and three Operations, mapped per D46.

## PRD relationship

`docs/PRD.md` was synchronized with the final decisions on 2026-09-11 by explicit product-owner instruction (recorded as SYNC-1 in [`../TRACEABILITY.md`](../TRACEABILITY.md)) and with D46 on 2026-09-17 (SYNC-2: §5 lead and mapping paragraph, §5.4, §9 exhausted-credit visibility, §15 prototype admin note, §§21–22 pointer, header). The original 2026-09-08 baseline is preserved in Git history (commit `8bacf81`) and the session archive. Future product decisions must again be recorded as decisions and synchronized into the PRD per PRD §24.

D45 adopted acceptance criteria 22–27; they are now part of PRD §19. "Adopted" means part of the definition of done; it does not mean implemented or verified.

## Evidence archive

The complete readable transcripts, benchmark findings, office-hours memo, reference ledger, obstacles, corrections, skills, source inventory, and checksums are in the `../history/2026-09-08-to-2026-09-11/` archive — **removed from the working tree in commit `9d8b81c`**; retrieve it from Git history (for example `cea3ba1`) or the local `.session-archive/2026-09-08-to-2026-09-11/` copy (ignored by Git) rather than assuming the path exists.
