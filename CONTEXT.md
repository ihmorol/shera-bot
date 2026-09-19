# Context — Shera Bot prototype

Engineering-skills entry point. **This file orients; the canonical documents decide.**

## What this is

A private multi-agent AI assistant prototype (≤5 users, one VM): versioned customer **Packs** of specialized **Agents** (six, student pack v1) working in **Operations** (reusable collaborative chats) through a Telegram-like web client. Agents propose; the runtime gateway validates and executes every action. Risky work pauses for scoped, expiring, revocable user approval. User data lives local-first in isolated per-user containers (SQLite WAL); the central service stores only control-plane records (PostgreSQL).

## Where truth lives (read in this order when touching a slice)

1. `AGENTS.md` — mandatory loading rules and non-negotiables.
2. `docs/PRD.md` — synchronized product baseline (D1–D51, E-records; acceptance criteria 1–27 in §19; D51 = dual harness, Pi default + Hermes selectable).
3. `docs/decisions/` — the decision register; `docs/TRACEABILITY.md` — acceptance status (never upgraded without evidence).
4. `docs/GLOSSARY.md` — vocabulary is binding: **Pack → Operations → Agents**; identifiers `agent_id`, `operation`, `task_run` (never "Expert"/"Scene").
5. `docs/BUILD_MAP.md` — the 35-slice build plan (GitHub issues #2–#36), guardrails G1–G8, merge gates; `docs/DEV_WORKFLOW.md` — the standing loop (red-first, evidence pack, fresh-context review).

## Code map

- `apps/web` — Next.js client (dark-only v1; UI slices run the impeccable gate)
- `apps/control-plane` — Express identity layer (Google OAuth, five-account cap; central PostgreSQL via Drizzle)
- `apps/user-runtime` — runtime gateway (per-user container authority; SQLite WAL)
- `packages/contracts` — Zod source of truth (S02); `packages/clients` — generated clients (D25)
- `packages/{agent-pack-sdk,pi-protocol,provider-contracts,observability,test-kit}` — see package docstrings for filling slices
- `agent-packs/` — versioned pack content (student v1 in S10); `infra/` — arrives with S06/S35
- `tests/{contract,integration,e2e,recovery,security,benchmark}` — E8 tiers; `spikes/` — preserved evidence, never deleted

## Working agreements

- One slice per PR; red tests first; guardrails G1–G8 (BUILD_MAP §3) are acceptance criteria.
- Pipeline: `pnpm install --frozen-lockfile && pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build`; license gate via `pnpm license:inventory` (E15 allowlist); mockup regression `node --test mockup/dock-layout.test.cjs` must stay green (27 tests).
- Pinned toolchain: Node 24.x (`.nvmrc`), pnpm 12.4.1 (`packageManager`).
