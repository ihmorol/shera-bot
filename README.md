# Shera Bot

Shera Bot is a private prototype for a local-first, multi-agent assistant platform. The product design is documented and synchronized with the final decisions (D1–D45); the root application implementation has not yet been established. A separate marketing/waitlist site lives in `business-landing-portfolio/`.

## Start here

Before modifying architecture or code, read the documentation in this order:

1. [`docs/README.md`](docs/README.md) — canonical documentation index.
2. [`docs/PRD.md`](docs/PRD.md) — synchronized product baseline (2026-09-11, per D1–D45; original 2026-09-08 baseline in Git history).
3. [`docs/decisions/README.md`](docs/decisions/README.md) — decision index.
4. [`docs/GLOSSARY.md`](docs/GLOSSARY.md) — canonical vocabulary: **Pack → Operations → Agents**.
5. [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md) — PRD reconciliation, decision status, acceptance coverage, and open items.
6. [`docs/history/2026-09-08-to-2026-09-11/README.md`](docs/history/2026-09-08-to-2026-09-11/README.md) — complete three-day session archive.

## Rules for future agents

- The PRD was synchronized with the final decisions on 2026-09-11 by explicit user instruction. Future product decisions that change user-visible scope, data ownership, approval safety, tenancy, agent roles, persistence, or acceptance criteria must again be recorded as decisions and synchronized into the PRD (PRD §24).
- Later decision records supplement or supersede conflicting PRD wording; check `docs/TRACEABILITY.md` before implementing an affected area.
- Use **Agent** everywhere. `Expert` is historical wording only and is not a separate product object.
- Preserve the **Operation** framing: the canonical hierarchy is **Pack → Operations → Agents**.
- Preserve evidence status. Do not turn inferred, provisional, superseded, deferred, or engineering decisions into ordinary confirmed product decisions.
- Do not discard an alternative, finding, obstacle, reference, or failed attempt merely because a later decision changed direction.
- When changing architecture, update the decision record, traceability row, glossary if needed, and the session/history index if the change came from a new decision.
- `business-landing-portfolio/` is a marketing surface: keep its copy consistent with the canonical vocabulary (Agent, never Expert/Scene), but it is out of scope for prototype acceptance criteria.
