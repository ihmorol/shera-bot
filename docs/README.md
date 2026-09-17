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


## Document authority

- The PRD was originally frozen because the product owner instructed: **do not change the previous PRD**. On 2026-09-11 the same owner explicitly instructed synchronization with the final decisions, and the PRD was updated in place (SYNC-1 in [`TRACEABILITY.md`](TRACEABILITY.md)).
- Later decisions and reconciliations are recorded in the decision records and reconciled in [`TRACEABILITY.md`](TRACEABILITY.md). New product decisions must be recorded as decisions and synchronized into the PRD (PRD §24).
- New normative documentation must use **Agent**, never introduce a separate **Expert** concept, and retain the **Operation** framing.
- Historical transcripts and quoted historical decision text preserve the words that were actually used. They are evidence, not current naming guidance.
- Raw machine exports are local-only under `.session-archive/` and are checksummed by `source-manifest.json`; they are intentionally ignored by Git.
- The marketing site in [`../business-landing-portfolio/`](../business-landing-portfolio/) is a separate Next.js application whose copy follows the canonical vocabulary; it is out of scope for prototype acceptance criteria.

## Development process

- [`DEV_WORKFLOW.md`](DEV_WORKFLOW.md) — solo-developer workflow from current state through production shipment, using AI agents under explicit verification gates. Process documentation only; subordinate to the PRD and decision records.

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
- Engineering decisions: E1–E14 (E9–E14 recorded 2026-09-17, Delegated pending owner review).
- Adopted acceptance criteria: 1–27 (22–27 added by D45 and now included in PRD §19).
- The ten implementation-defined items open on 2026-09-13 were dispositioned on 2026-09-17 (see [`decisions/open-items-decisions-2026-09-17.md`](decisions/open-items-decisions-2026-09-17.md)); remaining open items are listed in [`TRACEABILITY.md`](TRACEABILITY.md).
