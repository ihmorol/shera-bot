# Shera Bot Documentation Index

This directory contains the product baseline, the decision records, and the complete evidence archive for the three-day design session. **Read this index first.**

## Required reading order

1. [`PRD.md`](PRD.md) — the product baseline, synchronized with decisions D1–D45 on 2026-09-11 (original 2026-09-08 baseline in Git history, commit `8bacf81`).
2. [`decisions/README.md`](decisions/README.md) — current decision index and status vocabulary.
3. [`GLOSSARY.md`](GLOSSARY.md) — canonical terms for new work: **Pack → Operations → Agents**.
4. [`TRACEABILITY.md`](TRACEABILITY.md) — decision/PRD reconciliation, acceptance coverage, and open implementation items.
5. [`decisions/confirmed-decisions.md`](decisions/confirmed-decisions.md) — Codex decisions D1–D39, including historical wording and evidence status.
6. [`decisions/closure-decisions.md`](decisions/closure-decisions.md) — continued decisions D40–D45, engineering records E1–E8, proposal history, supersession, and deferred work.


## Document authority

- The PRD was originally frozen because the product owner instructed: **do not change the previous PRD**. On 2026-09-11 the same owner explicitly instructed synchronization with the final decisions, and the PRD was updated in place (SYNC-1 in [`TRACEABILITY.md`](TRACEABILITY.md)).
- Later decisions and reconciliations are recorded in the decision records and reconciled in [`TRACEABILITY.md`](TRACEABILITY.md). New product decisions must be recorded as decisions and synchronized into the PRD (PRD §24).
- New normative documentation must use **Agent**, never introduce a separate **Expert** concept, and retain the **Operation** framing.
- Historical transcripts and quoted historical decision text preserve the words that were actually used. They are evidence, not current naming guidance.
- Raw machine exports are local-only under `.session-archive/` and are checksummed by `source-manifest.json`; they are intentionally ignored by Git.
- The marketing site in [`../business-landing-portfolio/`](../business-landing-portfolio/) is a separate Next.js application whose copy follows the canonical vocabulary; it is out of scope for prototype acceptance criteria.

## Current record count

- Confirmed decisions: D1–D45, plus synchronization record SYNC-1.
- Engineering decisions: E1–E8.
- Adopted acceptance criteria: 1–27 (22–27 added by D45 and now included in PRD §19).
- Explicitly deferred items and unresolved implementation-defined items are listed in [`TRACEABILITY.md`](TRACEABILITY.md) and [`closure-decisions.md`](decisions/closure-decisions.md).
