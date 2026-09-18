# Shera Bot

Shera Bot is a private prototype for a local-first, multi-agent assistant platform. The product design is documented and synchronized with the final decisions (D1–D50, E1–E14; D47–D50/E9–E14 Delegated pending owner review); the product runtime implementation has not yet been established, but its monorepo scaffold exists (S01 — placeholders, no behavior). A static client mockup lives in `mockup/`, and a separate marketing/waitlist site lives in `business-landing-portfolio/`.

## Client mockup

Start with [`mockup/README.md`](mockup/README.md) to run the static UI. Future agents should read [`mockup/HANDOFF.md`](mockup/HANDOFF.md) and [`mockup/REFERENCE.md`](mockup/REFERENCE.md) for implemented interactions, simulated/inert features, completed pane changes and known blockers. [`mockup/UX_RECOMMENDATIONS.md`](mockup/UX_RECOMMENDATIONS.md) contains proposed first-use improvements, and the [`dated review archive`](mockup/reviews/2026-09-13/README.md) preserves the audit and screenshots.

The mockup is not a working backend or proof of prototype acceptance. Its UX recommendations are not adopted product decisions.

## Monorepo (development)

The workspace holds the runtime scaffold (S01 — placeholders only; no application behavior yet):

- Apps: `apps/web` (Next.js client), `apps/control-plane` (Express API), `apps/user-runtime` (runtime gateway)
- Packages: `packages/contracts`, `clients`, `agent-pack-sdk`, `pi-protocol`, `provider-contracts`, `observability`, `test-kit`
- Non-workspace directories: `agent-packs/` (pack definitions), `infra/` (deployment), `tests/<tier>/` (E8 test tiers)

Requires Node 24.19.0 (`.nvmrc`) and pnpm 12.4.1 (`packageManager`), enforced by `engines` and `.npmrc`.

```bash
pnpm install             # workspace install (frozen lockfile in CI)
pnpm lint                # eslint, one flat config at the root
pnpm format:check        # prettier
pnpm typecheck           # tsc for every workspace member (turbo), plus repo-level files
pnpm test                # vitest (contract tier first; E8 tiers under tests/)
pnpm build               # turbo (apps/web: next build)
pnpm license:inventory   # dependency + license gate; fails on an unreviewed license
pnpm mockup:test         # the static mockup's regression suite
```

CI (`.github/workflows/ci.yml`) runs the same commands on pull requests to `main`, uploads the license inventory as an artifact, and runs the mockup regression job. The choices behind the pipeline — pins, CI provider, layout, license policy and its one reviewed exception — are recorded in E16 ([`docs/decisions/engineering-record-e16-2026-09-17.md`](docs/decisions/engineering-record-e16-2026-09-17.md); filed as "E15" on 2026-09-17, renumbered on 2026-09-19 to resolve the identifier collision with the OSS-leverage record).

## Start here

Before modifying architecture or code, read the documentation in this order:

1. [`docs/README.md`](docs/README.md) — canonical documentation index.
2. [`docs/PRD.md`](docs/PRD.md) — synchronized product baseline (2026-09-17, per D1–D50/E1–E14; original 2026-09-08 baseline in Git history).
3. [`docs/decisions/README.md`](docs/decisions/README.md) — decision index.
4. [`docs/GLOSSARY.md`](docs/GLOSSARY.md) — canonical vocabulary: **Pack → Operations → Agents**.
5. [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md) — PRD reconciliation, decision status, acceptance coverage, and open items.
6. Historical context: `docs/history/2026-09-08-to-2026-09-11/README.md` is absent from the working tree after commit `9d8b81c`. Consult the archive in Git history (for example `cea3ba1`) and local raw exports where available; read relevant full evidence before relying on a summary.

## Rules for future agents

- The PRD was synchronized with the final decisions on 2026-09-11 by explicit user instruction. Future product decisions that change user-visible scope, data ownership, approval safety, tenancy, agent roles, persistence, or acceptance criteria must again be recorded as decisions and synchronized into the PRD (PRD §24).
- Later decision records supplement or supersede conflicting PRD wording; check `docs/TRACEABILITY.md` before implementing an affected area.
- Use **Agent** everywhere. `Expert` is historical wording only and is not a separate product object.
- Preserve the **Operation** framing: the canonical hierarchy is **Pack → Operations → Agents**.
- Preserve evidence status. Do not turn inferred, provisional, superseded, deferred, or engineering decisions into ordinary confirmed product decisions.
- Do not discard an alternative, finding, obstacle, reference, or failed attempt merely because a later decision changed direction.
- When changing architecture, update the decision record, traceability row, glossary if needed, and the session/history index if the change came from a new decision.
- `business-landing-portfolio/` is a marketing surface: keep its copy consistent with the canonical vocabulary (Agent, never Expert/Scene), but it is out of scope for prototype acceptance criteria.
