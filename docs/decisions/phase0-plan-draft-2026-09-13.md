# Phase 0 build plan — DRAFT for owner approval (Stage 3 Planner output)

**Date:** 2026-09-13 · **Status:** draft — nothing scaffolded. Per `docs/DEV_WORKFLOW.md` Stage 3 the owner approves this slice list before any scaffolding starts.
**Informed by:** the committed static mockup (`mockup/` — validated three-panel shell, interaction inventory with statuses in `mockup/REFERENCE.md`), PRD §247–261/§338–361, confirmed-decisions (repo layout, Zod-first, pnpm/Turborepo), D13 spike pending.

## 0. What carries over from the mockup (evidence, not code)

The mockup validated, at the interaction level, and the product client should reproduce: the three-panel floating shell (25/45/30 defaults, 12px seams), chat-first landing with an Agent profile panel as the default workspace view, the approval dialog with five fixed choices, run/task-run cards in D8 vocabulary, honest empty/states, and the palette-style search. It did NOT validate: real runtime behavior, auth, persistence, or provider calls. Mockup code is a reference, not a port — the client is rebuilt in Next.js against Zod contracts.

## 1. Monorepo scaffold (slice S1)

```
/ (pnpm + Turborepo, Node LTS pinned)
  apps/web/               Next.js client (dark-only v1, ~360px+, keyboard-complete)
  apps/control-plane/     Express gateway: auth, sessions, approvals, credits, persistence (PostgreSQL)
  apps/runtime-gateway/   Pi process supervision, typed execution events (D13 spike decides the seam)
  packages/contracts/     Zod schemas + generated types — single source of truth
  packages/testing/       harness: fake Pi provider seam, fake clock, recovery fixtures
  infra/                  Dockerfile, Compose, deploy runbook (Stage 8)
```

S1 acceptance: `pnpm install && pnpm lint && pnpm typecheck && pnpm test` green locally + CI workflow (lint → typecheck → test on push/PR to main); smoke test imports `packages/contracts`.

## 2. First shared Zod contracts (slice S2, 10 contracts)

1. `Session` (Google OAuth identity, tier, workspace_id — see ⚠ item 6)
2. `Pack` (version, roster — **blocked on D43 mapping decision**, ⚠ item 7)
3. `Agent` (identity, default provider/model, skills/tools refs, persistent identity per D39)
4. `Operation` (template ref, roster, coordinator, status)
5. `TaskRun` + `RunState` (queued/running/waiting_approval/retrying/paused/succeeded/failed/recovery_required per D8, with exhaustive legal transitions)
6. `TypedExecutionEvent` (the only thing that can create tasks — G2; JSONL-serialized, cursor-bearing for replay per D26)
7. `ApprovalRequest` + `Grant` (tool, args digest, scope, expiry, revocable; five-choice response shape per PRD §8)
8. `ArtifactRef` (producer run, path in container workspace, size)
9. `CreditReservation`/`Settlement` (reserve → settle/release per D20–D22; exhausted-credit transition per item 3)
10. `MemoryEntry` (scopes shared/agent-private, publication flag per D37)

⚠ Two contracts are blocked on owner decisions: `Pack` (item 7/D43) and the `workspace_id` representation (item 6). S2 starts with the other eight; these two land as amendments.

## 3. Operation/task state machine (slice S3)

States per D8 vocabulary; transitions as an exhaustive data table with tests rejecting illegal moves (e.g. succeeded → running, failed → retrying without a retry event). Recovery enters `recovery_required` only from events an external effect marked unprovable (D33; per-tool semantics item 9 defaults to needs-human). Waiting-approval freezes work but never kills sibling runs (D32).

## 4. Approval model as data (slice S4)

Classification is a field on tool definitions — `read-only | local-mutation (preview) | gated` — never prose inference (G2/G6). Grants: scoped (tool/agent/session), expiring, revocable, runtime-owned; the UI can only display and request revocation. Threat-model pass maps OWASP LLM01/04/06/08 onto grants, approval gates, redaction and resource limits (security-reviewer slice).

## 5. Filesystem layout contract (slice S5)

Container workspace: `workspace://` tree (shared) + `agent://<id>/` private scopes, write-leases on agent edits, deletion always asks. Contract-level only in Phase 0; enforcement arrives with the runtime.

## 6. Harness (slice S5/S6)

Unit/contract/integration/recovery/E2E slots; **fake Pi provider seam** (scripted typed events); **fake clock** (retry/backoff/recovery timers become deterministic); live-provider tests opt-in only (G7).

## 7. Slice order and gates

| Slice | Deliverable | Gate |
|---|---|---|
| S1 | Scaffold + CI skeleton | pnpm pipeline green locally + CI file valid |
| S2 | 8 contracts (2 deferred pending owner) | contract tests round-trip fixtures |
| S3 | State machine module | illegal transitions rejected in tests |
| S4 | Approval model + threat model draft | owner line-by-line read (P9) |
| S5 | Filesystem contract + harness seams | fake-clock recovery test green |
| S6 | D13 supervision spike | node:sqlite vs driver decision recorded (E-record) |

## 8. Open questions this plan assumes (owner to confirm at approval)

- Dark-only theme for `apps/web` v1 per PRODUCT.md, even though the mockup explored light mode — confirm.
- CI provider choice (GitHub Actions assumed) — E-record at S1.
- pnpm version pin and Node LTS line — engineering choice at S1.
- The ten Stage-2 dispositions (see `open-items-brief-2026-09-13.md`) — items 6/7 block S2 completion.
