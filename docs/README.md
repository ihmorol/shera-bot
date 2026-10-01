# Shera Bot Documentation Index

This directory contains the product baseline and decision records. **Read this index first.** Historical evidence referenced by older documents was removed from the working tree in commit `9d8b81c`; consult Git history (for example `cea3ba1`) and the local raw archive where available rather than assuming those paths exist.

## Required reading order

1. [`PRD.md`](PRD.md) — the product baseline, synchronized with decisions D1–D45 on 2026-09-11 (SYNC-1) and D46 on 2026-09-17 (SYNC-2; original 2026-09-08 baseline in Git history, commit `8bacf81`).
2. [`decisions/README.md`](decisions/README.md) — current decision index and status vocabulary.
3. [`GLOSSARY.md`](GLOSSARY.md) — canonical terms for new work: **Pack → Operations → Agents**.
4. [`TRACEABILITY.md`](TRACEABILITY.md) — decision/PRD reconciliation, acceptance coverage, and open implementation items.
5. [`decisions/confirmed-decisions.md`](decisions/confirmed-decisions.md) — Codex decisions D1–D39, including historical wording and evidence status.
6. [`decisions/closure-decisions.md`](decisions/closure-decisions.md) — continued decisions D40–D45, engineering records E1–E8, proposal history, supersession, and deferred work.
7. [`decisions/open-items-decisions-2026-09-17.md`](decisions/open-items-decisions-2026-09-17.md) — D46–D50 and E9–E14: the roster/subagent decision and the ten open-item dispositions (D47–D50/E9–E14 Delegated, pending owner review).
8. [`decisions/oss-leverage-decisions-2026-09-18.md`](decisions/oss-leverage-decisions-2026-09-18.md) — E15: the open-source leverage policy (embed / pattern-only / never-adopt tiers, S01 license-allowlist gate, anti-creativity rule) and the per-slice adoption map (Delegated, pending owner review).


## Document authority

- The PRD was originally frozen because the product owner instructed: **do not change the previous PRD**. On 2026-09-11 the same owner explicitly instructed synchronization with the final decisions, and the PRD was updated in place (SYNC-1 in [`TRACEABILITY.md`](TRACEABILITY.md)).
- Later decisions and reconciliations are recorded in the decision records and reconciled in [`TRACEABILITY.md`](TRACEABILITY.md). New product decisions must be recorded as decisions and synchronized into the PRD (PRD §24).
- New normative documentation must use **Agent**, never introduce a separate **Expert** concept, and retain the **Operation** framing.
- Historical transcripts and quoted historical decision text preserve the words that were actually used. They are evidence, not current naming guidance.
- Raw machine exports are local-only under `.session-archive/` and are checksummed by `source-manifest.json`; they are intentionally ignored by Git.
- The marketing site in [`../business-landing-portfolio/`](../business-landing-portfolio/) is a separate Next.js application whose copy follows the canonical vocabulary; it is out of scope for prototype acceptance criteria.

## Development process

- [`e2e-demo-path.md`](e2e-demo-path.md) — the S09 E2E demo path (login → chat → send → stream → refresh → replay) with its executable evidence and the pending browser-verification checklist.
- [`DEV_WORKFLOW.md`](DEV_WORKFLOW.md) — solo-developer workflow from current state through production shipment, using AI agents under explicit verification gates. Process documentation only; subordinate to the PRD and decision records.
- [`BUILD_MAP.md`](BUILD_MAP.md) — the 35-slice build plan with live GitHub issue numbers, the agent working protocol, guardrails G1–G8, the UI gate, and the open items. Process index only; subordinate to the PRD and decision records.
- [`decisions/engineering-record-e16-2026-09-17.md`](decisions/engineering-record-e16-2026-09-17.md) — E16: S01 scaffold/CI choices (Delegated, pending owner review), review corrections, and the owner-supplied Pi fork evidence update. Filed as "E15" on 2026-09-17; renumbered E16 on 2026-09-19 (identifier collision with the OSS-leverage record) and incorporated in the decision index.
- [`PI_FORK.md`](PI_FORK.md) — verified fork/upstream source snapshot, verbatim MIT license reference, modification obligations, and proposed upstream-sync procedure. Includes the JSONL RPC versus CBOR protocol distinction and the remaining dependency/distribution audit boundary; source evidence is not runtime acceptance.
- [`pi-fork/verification-2026-09-17.md`](pi-fork/verification-2026-09-17.md) — fork source checks, immutable references, draft corrections, and verification limits; [`pi-fork/LICENSE`](pi-fork/LICENSE) is the unmodified license copy.

## Client design and mockup documentation

- [`UI_DESIGN.md`](UI_DESIGN.md) — target client UI specification; subordinate to PRD/recorded product decisions.
- [`../mockup/README.md`](../mockup/README.md) — run the static mockup, status boundaries and documentation index.
- [`../mockup/REFERENCE.md`](../mockup/REFERENCE.md) — detailed current screens, routes, fixtures, controls, implementation status and state lifetime.
- [`../mockup/HANDOFF.md`](../mockup/HANDOFF.md) — completed review/pane changes, user-request evidence, checks, failed attempts and future-agent instructions.
- [`../mockup/UX_RECOMMENDATIONS.md`](../mockup/UX_RECOMMENDATIONS.md) — proposed calmer first-use experience; not an adopted redesign or new product decision.
- [`../mockup/reviews/2026-09-13/README.md`](../mockup/reviews/2026-09-13/README.md) — preserved independent audit, verification and screenshot evidence.

Mockup interactions, fixture output and pane tests do not establish runtime behavior or change the acceptance statuses in `TRACEABILITY.md`. The mockup's post-login landing was repaired on 2026-09-13 to match the specified chat-first home (`#/app`); remaining mockup deviations (light-theme exploration, fixture-only states) stay documented in the mockup's own docs rather than silently adopted. The Exam Preparation fixture roster was aligned to D46 on 2026-09-17 with a HANDOFF §21 entry.

## Current record count

- Confirmed decisions: D1–D50 (D46–D50 recorded 2026-09-17; D47–D50 are Delegated pending owner review), plus synchronization records SYNC-1 and SYNC-2.
- Engineering decisions: E1–E16 (E9–E14 recorded 2026-09-17; E15 recorded 2026-09-18; E16 recorded 2026-09-17 with slice S01 and renumbered from "E15" on 2026-09-19 to resolve the identifier collision — all Delegated pending owner review). E16's fork follow-up records source/license evidence; no new product decision was made.
- Adopted acceptance criteria: 1–27 (22–27 added by D45 and now included in PRD §19).
- The ten implementation-defined items open on 2026-09-13 were dispositioned on 2026-09-17 (see [`decisions/open-items-decisions-2026-09-17.md`](decisions/open-items-decisions-2026-09-17.md)); remaining open items are listed in [`TRACEABILITY.md`](TRACEABILITY.md).
