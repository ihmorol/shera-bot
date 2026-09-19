# Shera Bot — Owner decision D51: dual harness (Pi default, Hermes selectable)

**ID:** D51
**Status:** Confirmed (explicit product-owner instruction, 2026-09-19)
**Date:** 2026-09-19
**Recorded as:** SYNC-3 (PRD synchronization of 2026-09-19)
**Evidence source:** Owner instruction in the build-orchestration session, 2026-09-19, verbatim:

> "keep two option, this is a prd and a decision change. do it seriously , update related docs whicever needed. i want pi as a default, and hermes as a second option to choose which harness agent will use"

## Decision

The agent runtime supports **two harness options** for an Agent's session process:

1. **Pi** — the **default** harness (the product-maintained fork `ihmorol/shera-pi`, D13/D14; supervision seam validated by E17).
2. **Hermes** — a **second, selectable** harness option.

The choice of harness is **Agent configuration** ("which harness the Agent will use"); Pi is the default when unspecified. The runtime gateway supervises either harness through the same supervised adapter seam; the runtime remains authoritative regardless of harness (G2, D4 unchanged).

## Rationale

The owner directs optionality at the harness layer while keeping Pi as the default path. This composes with — rather than overturns — the just-recorded E17 spike result: E17 validated the Pi supervision seam (JSONL stdio child process, variant A) and that seam becomes the **default path** of the dual-harness design. Per-Agent selection matches the owner's wording ("which harness agent will use") and fits the existing per-Agent configuration surfaces (role defaults, settings; PRD §5).

## Alternatives considered (preserved, not deleted)

1. **Pi only** (status quo, D13/D14 as recorded) — rejected by the owner: optionality at the harness layer is wanted.
2. **Hermes as the default** — rejected by the owner: "i want pi as a default".
3. **Harness choice per Operation, per workspace, or per task run** — not chosen; the owner ties the choice to the Agent. A pack-level default with per-Agent override remains an implementation refinement, not a separate product decision.

## Affected PRD sections (SYNC-3 edits)

- **Header** — baseline updated to D1–D51, E1–E17; date chain gains 2026-09-19 (SYNC-3).
- **§5 (Agents)** — "An Agent's Pi session process" becomes a session process on the Agent's selected harness (Pi default, Hermes optional).
- **§17 (Technology stack)** — the Pi adapter line names Pi as the default harness and records Hermes as the selectable second harness behind the same supervised adapter seam.
- **§19 (Acceptance criteria), AC4** — "on-demand supervised Pi session process" becomes "on-demand supervised session process on its selected harness (Pi default, Hermes optional — D51)".
- **§22 (Engineering TODO register)** — new item: confirm the Hermes upstream source, license, adapter protocol, and upstream-sync process.

## Implementation implications

- **D13/D14 remain valid** and now describe the default path. E17 stays "Delegated engineering (pending owner review)" for its remaining calls (`node:sqlite`, E11 backup mechanism); this instruction confirms only its Pi-default direction.
- **The supervision seam must be harness-agnostic from S07 onward.** S12 (on-demand Agent session supervision: warm, hibernate, reconstruct) implements both harnesses behind the E17 seam contract; S10 (pack schema) carries the per-Agent harness field (`Pi | Hermes`, default `Pi`); S11 (Agent settings) exposes the selection surface.
- **Hermes upstream evidence is required before any Hermes code path exists.** The owner supplies the Hermes source, license, adapter protocol, and maintenance evidence — the same evidence pattern used for the Pi fork ([`../../PI_FORK.md`](../../PI_FORK.md)). Until then, no code, schema, or UI may claim Hermes support; a missing harness is a clear configuration state, never a fake (G4). An engineering record (E18) will be filed when the Hermes evidence lands; the S03 spike harness (`spikes/d13/`) is the template for a Hermes adapter spike if the adapter needs its own comparative evidence.
- PRD §19 AC4's verification and the S12 acceptance path now include the harness-selection field with Pi as the exercised default; the Hermes path is contract-defined but untestable until the upstream evidence arrives (open item, tracked in [`../../TRACEABILITY.md`](../../TRACEABILITY.md)).

## Verification coverage

- **TRACEABILITY** D51 row (this file is the evidence); SYNC-3 row records the PRD edit set.
- Contract tests for the per-Agent harness field with Pi default (S10); settings-surface QA (S11); dual-harness session supervision tests (S12); harness-agnostic gateway seam contract tests (S07).
- Hermes path: **not verifiable** until owner-supplied upstream evidence lands (explicit open item — never silently resolved, G5).
