# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the engineering-skills entry point. It defers to the canonical documents; it never replaces them.
- **`docs/adr/`** — architecture decision records *additional to* the repo's product decision register (`docs/decisions/`). Product decisions always win over ADRs.

## Authority chain (repo-specific)

This repo has an unusually strong pre-existing documentation baseline. Where a skill's general guidance could conflict with it, the authority order is:

1. `docs/PRD.md` + `docs/decisions/` (recorded product decisions, D1–D50/E-records)
2. `docs/TRACEABILITY.md` (acceptance status: only code + tests + evidence change it)
3. `docs/GLOSSARY.md` (vocabulary: **Pack → Operations → Agents**; `Expert`/`Scene` are historical aliases)
4. `docs/BUILD_MAP.md` + `docs/DEV_WORKFLOW.md` (process; how slices are built and merged)
5. `CONTEXT.md` and `docs/adr/` (engineering-skill orientation; never contradict 1–4)

## Layout

Single-context. This is a pnpm/Turborepo monorepo (3 apps + 7 packages), but the domain is one product context; the shared vocabulary lives in `docs/GLOSSARY.md` and the contracts in `packages/contracts`. Split into per-context `CONTEXT.md` files (with `CONTEXT-MAP.md`) only when a bounded context actually emerges — not preemptively.
