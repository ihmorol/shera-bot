# Shera Bot — Decision Records Index

**Status:** D1–D45 recorded; E1–E8 recorded as engineering decisions; SYNC-1 records the 2026-09-11 PRD/landing-page synchronization; no D46–D49 exist.  
**Last updated:** 2026-09-11  
**Canonical vocabulary:** **Pack → Operations → Agents**.  
**PRD policy:** [`docs/PRD.md`](../PRD.md) was synchronized with D1–D45 on 2026-09-11 by explicit product-owner instruction (previously it was the unchanged 2026-09-08 baseline).

## Start here

1. [`../README.md`](../README.md) — repository entry point and mandatory rules.
2. [`../PRD.md`](../PRD.md) — synchronized product baseline (2026-09-11, D1–D45).
3. [`README.md`](README.md) — this index and status semantics.
4. [`confirmed-decisions.md`](confirmed-decisions.md) — Codex D1–D39, including historical wording and evidence limitations.
5. [`closure-decisions.md`](closure-decisions.md) — continued D40–D45, engineering E1–E8, proposal dispositions, supersession, and deferred work.
6. [`proposal-history.md`](proposal-history.md) — full P1–P9 recommendations, alternatives, rationale, and dispositions.
7. [`../GLOSSARY.md`](../GLOSSARY.md) — authoritative names and object boundaries.
8. [`../TRACEABILITY.md`](../TRACEABILITY.md) — PRD reconciliation, implementation/test mapping, acceptance criteria, and open items.
9. [`../history/2026-09-08-to-2026-09-11/README.md`](../history/2026-09-08-to-2026-09-11/README.md) — complete three-day archive and source inventory, including earlier product-origin sessions.
10. [`../history/2026-09-08-to-2026-09-11/source-manifest.md`](../history/2026-09-08-to-2026-09-11/source-manifest.md) — tracked source inventory, checksums, and missing-source notes.

## Status vocabulary

- **Confirmed** — explicit product-owner answer is preserved in the readable transcript.
- **Confirmed / incomplete acknowledgement** — the user's explicit answer exists, but the original assistant acknowledgement was lost or interrupted (D39).
- **Confirmed / refined** — accepted, then narrowed or corrected by a later clarification.
- **Provisional** — selected for the prototype but requires a named spike or validation before becoming permanent (D13, D19).
- **Superseded** — retained for history; a later decision is authoritative.
- **Engineering** — an implementation choice delegated by PRD §24 or derived from an accepted boundary; not a new product decision.
- **Deferred** — intentionally outside the private prototype.
- **Open** — deliberately not silently decided; see [`../TRACEABILITY.md`](../TRACEABILITY.md).

## Decision records

| File | Contents |
|---|---|
| [`confirmed-decisions.md`](confirmed-decisions.md) | D1–D39 from the original Codex grilling. D3 is superseded by D32; D39 is confirmed from an explicit answer but has an incomplete original acknowledgement. Historical `Expert` wording is retained only as evidence and is superseded by D44. |
| [`closure-decisions.md`](closure-decisions.md) | D40–D45 answered one at a time in this session; E1–E8 engineering dispositions; proposal dispositions; supersession and deferred registers. |
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
- The General Assistant is the default removable coordinator; the runtime remains authoritative whether coordination is centralized or peer-to-peer.
- Student Pack v1 contains six Agents and three Operations.

## PRD relationship

`docs/PRD.md` was synchronized with the final decisions on 2026-09-11 by explicit product-owner instruction (recorded as SYNC-1 in [`../TRACEABILITY.md`](../TRACEABILITY.md)). The original 2026-09-08 baseline is preserved in Git history (commit `8bacf81`) and the session archive. Future product decisions must again be recorded as decisions and synchronized into the PRD per PRD §24.

D45 adopted acceptance criteria 22–27; they are now part of PRD §19. "Adopted" means part of the definition of done; it does not mean implemented or verified.

## Evidence archive

The complete readable transcripts, benchmark findings, office-hours memo, reference ledger, obstacles, corrections, skills, source inventory, and checksums are in [`../history/2026-09-08-to-2026-09-11/`](../history/2026-09-08-to-2026-09-11/). Exact raw machine exports are local-only under `.session-archive/2026-09-08-to-2026-09-11/` and are ignored by Git.
