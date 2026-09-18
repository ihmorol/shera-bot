# Shera Bot — Build map (35-slice plan)

**Status:** Process index. Subordinate to [`PRD.md`](PRD.md) and the decision records — where this file could contradict them, they win. It records *how* the prototype is built, never *what* it is.
**Created:** 2026-09-17 · **Tracker:** GitHub issue #1 in [this repository](https://github.com/ihmorol/shera-bot/issues) (private) · **Executors:** AI coding agents under the gates in [`DEV_WORKFLOW.md`](DEV_WORKFLOW.md).

Issue numbers below are GitHub issues in this repository (`https://github.com/ihmorol/shera-bot/issues/<n>`). Issue #1 is the tracker and carries the expanded protocol; this file is its repo-side twin so the plan survives outside GitHub.

## 1. Where the project stands

- **Design: complete.** `docs/PRD.md` (D1–D50, E1–E14, acceptance criteria 1–27), `docs/decisions/`, `docs/TRACEABILITY.md`, `docs/GLOSSARY.md`, `docs/UI_DESIGN.md`.
- **Existing code:** the static client mockup (`mockup/`) and the separate, git-ignored marketing site (`business-landing-portfolio/`). Both are reference evidence.
- **Runtime behavior: not implemented.** S01's monorepo placeholders and CI landed via PR #37 (2026-09-19); no database or deployed runtime exists. The 35 slices below build the prototype in dependency order.
- **Pi fork identified (2026-09-17):** the owner supplied `ihmorol/shera-pi`. [`PI_FORK.md`](PI_FORK.md) supplies verified source/MIT-license evidence and proposed maintenance guidance for S01 review. No real-fork integration, runtime revision pin, dependency audit, or upstream test run is implied.

## 2. How to work a slice

Per `docs/DEV_WORKFLOW.md` §5 (the standing loop): read the slice and the decisions it names → write the failing test/reproducer first → implement only that slice → hand over an evidence pack (exact commands and output, a runnable demo path or screenshots, and an explicit "not verified" list) → fresh-context adversarial review (plus a security review where the slice is security-sensitive) → **merge only after the owner's explicit approval sentence**. One slice per pull request.

Do not start a slice whose `Blocked by` issues are still open.

Each slice issue ends with an **Open-source leverage** section (E15, recorded 2026-09-18 in [`decisions/oss-leverage-decisions-2026-09-18.md`](decisions/oss-leverage-decisions-2026-09-18.md)): read the linked docs before designing — do not discover by exploration — and record adopted dependencies as an E-note in the pull request. The standing rules and the per-slice borrow map are in §8 below.

## 3. Guardrails (every slice)

- **G1** Vocabulary is **Pack → Operations → Agents**; "Agent" in UI, code, schemas, pack files, and tests. `Expert` and `Scene` are historical words only.
- **G2** Agents propose; the runtime gateway validates and executes. Task runs are created only from typed protocol behavior — never natural-language classification.
- **G3** No secrets in prompts, events, logs, memory, artifacts, transcripts, or docs.
- **G4** No fake-completion fallback: a missing or invalid provider produces a clear configuration state.
- **G5** Never silently resolve a recorded conflict in code or fixtures — surface it and record a decision.
- **G6** Read-only tools run automatically; local mutations preview; risky effects are approval-gated; an agent never self-approves.
- **G7** Live-provider tests are opt-in and never default CI.
- **G8** Every main-branch merge of coding work gets the owner's explicit approval after a fresh-context review.

Neither the PRD nor user-visible scope, data ownership, approval safety, tenancy, agent roles, persistence, or acceptance criteria may change without a recorded product decision (PRD §24).

## 4. UI slices

Slices that ship user-visible UI must run the **`impeccable`** skill exactly as its SKILL.md requires (`impeccable context` → matching playbook → `reference/craft-floor.md` before any UI edit) and then an adversarial **taste pass** with `impeccable critique` and/or the `/design-review` skill, recording findings and fixes in the pull request. The craft floor — contrast, depth, spacing rhythm, type scale and measure, one authored motion moment, every state, themed browser surfaces, product-language copy — is acceptance criteria. Verify in a real browser at ~360px/768px/1440px plus keyboard-only and `prefers-reduced-motion`, with screenshots.

Design authority is [`UI_DESIGN.md`](UI_DESIGN.md) and [`../PRODUCT.md`](../PRODUCT.md). `mockup/` is reference evidence for interaction and density, never code to copy. Final logo art and avatar illustration style remain open for the owner's reference material.

## 5. The slice map

| Slice | Issue | Phase | Blocked by | Advances |
|---|---|---|---|---|
| S01 Monorepo scaffold, CI gate, pinned toolchain, license inventory | #2 | 0 | — | PRD §22.1, §22.22 |
| S02 Core contracts, task/run state machine, typed execution events | #3 | 0 | S01 | PRD §17, D5, D8, D25 |
| S03 Pi supervision spike + SQLite driver decision | #4 | 0 | S02 | D13, D24, §22.3 |
| S04 Threat model and security control register | #5 | 0 | S01 | §22.19, P10 |
| S05 Control plane: Google OAuth, five-account cap, sessions, admin flag | #6 | 1 | S01, S02 | AC1, D2, D12 |
| S06 Container provisioning, runtime registration, internal channel | #7 | 1 | S05 | AC2, D12, D27 |
| S07 Runtime gateway: local API, SQLite WAL, event journal, WebSocket replay | #8 | 1 | S02, S03, S06 | D5, D10, D11, D26 |
| S08 Web client shell and Agent chat UI | #9 | 1 | S02 | §21.1–21.6, AC20 |
| S09 End-to-end thin slice: login → container → chat → stream → refresh → replay | #10 | 1 | S07, S08 | D23 Phase 1 |
| S10 Pack loader, student pack v1, workspace pack pinning | #11 | 2 | S02, S09 | AC22, D18, D28, D46 |
| S11 Agent identity: six direct chats, private folders, private memory, settings | #12 | 2 | S09, S10 | AC3, AC4, D32, D39 |
| S12 On-demand Agent session supervision: warm, hibernate, reconstruct | #13 | 2 | S03, S11 | AC4, D32 |
| S13 Operation chat: roster, removable coordinator, independent task runs, typed collaboration | #14 | 2 | S11 | AC6, AC24, D7, D31, D34, D42, D49 |
| S14 Ad-hoc Operation creation with same-Pack roster | #15 | 2 | S13 | AC5, D41 |
| S15 Operation launch preview gate | #16 | 2 | S10, S13 | AC6, AC23, D30 |
| S16 Task worker supervision and admission control | #17 | 2 | S12 | AC25, D32, E1 |
| S17 Workspace panel: Files, Editor, private files, artifacts, write leases | #18 | 3 | S16 | AC16, D6, D10 |
| S18 Terminal and browser read-only live views, shared Chromium profile | #19 | 3 | S17 | AC19, AC21 |
| S19 Git worktrees, conflict queue, merge review | #20 | 3 | S17 | AC17, D6, E6 |
| S20 Approvals: requests, five choices, grants, reminders, revocation | #21 | 4 | S16 | AC13, AC26, D9, E3 |
| S21 Tool executor, risk-class ladder, agent-created tool inventory | #22 | 4 | S07, S20 | AC8, AC9, AC26, D35, E4 |
| S22 Retries and process-tree cancellation | #23 | 4 | S16, S21 | AC14, AC15 |
| S23 Providers, credential custody, connection tests, defaults and overrides | #24 | 4 | S16, S20 | AC10, AC11, D17, D20, D22, E9 |
| S24 Credit ledger: reserve, settle, release, insufficient-credits pause | #25 | 4 | S23 | D20, D21, D48 |
| S25 Research and data tools: web search, page fetch, documents, spreadsheets, images | #26 | 4 | S21 | AC8, D15 |
| S26 Execution tools: sandboxed code execution and terminal with policy | #27 | 4 | S21 | AC8, D27 |
| S27 Security test suite from the threat model | #28 | 4 | S21, S22, S23, S25, S26 | AC21, D27 |
| S28 Schedules, watchers, webhooks, one autonomous task | #29 | 5 | S22, S23 | AC12, E5 |
| S29 Memory: scopes, provenance, publication boundary, secret rejection | #30 | 5 | S13, S20 | AC27, D37 |
| S30 Settings, onboarding, notification center, multi-tab sync | #31 | 5 | S20, S23, S29 | D16, PRD §14 |
| S31 Semantic checkpoints, restart recovery, recovery surfaces | #32 | 6 | S16, S22, S28 | AC19, AC25, D32, D33, E13 |
| S32 Admin API and CLI | #33 | 6 | S06, S16 | D47, E7 |
| S33 Backups: six-hour snapshots, integrity checks, restore drill | #34 | 6 | S31, S32 | AC18, E11 |
| S34 Acceptance ledger, criteria runner, cross-browser QA | #35 | 7 | S31, S33 | AC1–AC27, E14 |
| S35 Deployment: Compose on one VM, runbooks, smoke tests, monitoring | #36 | 7 | S34 | PRD §6.1, §22.23 |

Acceptance criteria 1–27 (PRD §19) are covered by the slices named above; the PRD §21 visual register is resolved by S08/S11/S13–S21/S23–S25/S28–S31, and the §22 engineering register by S01–S05, S07, S27, S32–S36.

## 6. Open items that stay open

- **Exact subagent semantics** (D46 sub-item): same-identity worker instance versus another same-Pack Agent invoked as a subordinate, concurrency limits, memory-scope boundaries. Evidence target: before the Agent/Operation contracts freeze (S10/S13), or recorded as an engineering decision at that point. Tracked in `TRACEABILITY.md`.
- **Pi fork follow-through:** the missing-identity/documentation blocker from S01 is resolved by the owner-supplied fork and [`PI_FORK.md`](PI_FORK.md), with the earlier blocked state preserved in E16 (the S01 scaffold record, renumbered from "E15" on 2026-09-19). Dependency/build inventory, vendored notices, adapter verification, and maintenance-procedure approval remain open; Emon and the integration slice own evidence before real-fork consumption, with distribution-notice checks in S35. The inspected source SHA is not an adopted runtime pin.
- **Stage-3 plan confirmations** awaiting the owner: dark-only `apps/web` v1, CI provider, pnpm/Node pins (`decisions/phase0-plan-draft-2026-09-13.md` §8). S01 executed on 2026-09-17 with them recorded as Delegated pending review in E16 — including the resolution of the conflict between the plan draft's approval gate and §6/issue #2.
- **`mockup/UX_RECOMMENDATIONS.md`**: dispositioned as not-adopted-now (D50); individual recommendations are evaluated per UI slice.

## 7. Keeping this file current

When issues are created, split, merged, or renumbered, update the table in the same pull request. Acceptance statuses live in [`TRACEABILITY.md`](TRACEABILITY.md) and may only change with code, tests, and evidence links (E14) — never to match a fixture or screenshot.

## 8. Open-source leverage (E15, recorded 2026-09-18)

Standing rules for every slice (full record: [`decisions/oss-leverage-decisions-2026-09-18.md`](decisions/oss-leverage-decisions-2026-09-18.md)):

- **Embed** only MIT / Apache-2.0 / BSD / ISC dependencies that fit the PRD §17 stack; the S01 license-inventory CI gate enforces this.
- **Pattern-only** for AGPL/GPL projects (Coder; SearXNG allowed only as an unmodified external container) and out-of-stack platforms (Dify, Coze Studio, Suna, AutoGPT Platform, Temporal server) — copy semantics and vocabulary, never code or branding.
- **Never adopt agent frameworks as the runtime** (LangGraph, CrewAI, AutoGen) — G2; vocabulary-only reference for S13–S15.
- **Read the linked docs first — do not discover by exploration.** Established mechanism names (lease, heartbeat, replay cursor, retry policy, signal, worktree) keep their established semantics. A slice that cannot name a reference is an over-design signal — raise it before inventing.
- Every adopted dependency gets an E-note in the slice PR.

Per-slice map (the issue bodies carry the same map with exact doc links and repo search terms; the append script is archived at `artifacts/oss-issue-sections.sh`):

| Slice | Embed | Pattern-only / reference |
|---|---|---|
| S01 | pnpm workspaces + Turborepo; license-checker allowlist gate | OpenClaw repo layout (MIT) |
| S02 | zod-to-openapi; XState v5 (evaluate vs hand-rolled transition table) | Temporal event-history / retry / signal vocabulary |
| S03 | better-sqlite3 (WAL) + Drizzle | OpenClaw process supervision; pi-mono protocol docs |
| S04 | — | OWASP GenAI LLM Top 10 + ASVS; Magentic-UI action guards; OpenClaw security model |
| S05 | Auth.js (Google provider, database sessions) | — |
| S06 | dockerode | Coder provisioning model (AGPL — docs only); OpenClaw channel auth |
| S07 | Socket.IO v4 (durable cursor replay stays custom) | OpenClaw gateway; Temporal event history |
| S08 | shadcn/ui + Radix; TanStack Query; react-resizable-panels | — |
| S09 | — (integration; reuse S05–S08 picks, no new dependencies) | — |
| S10 | — (Pack schema is novel) | OpenClaw skills format — optional alignment, requires an E-note |
| S11 | — (reuse S02 contracts) | Letta memory blocks / durable-agent-identity vocabulary |
| S12 | — (node child_process + better-sqlite3) | OpenClaw session lifecycle; pi-mono session docs |
| S13 | — (implement D7/D31/D34/D42/D49 as recorded) | AutoGen / CrewAI vocabulary only |
| S14 | — (reuse S13) | AutoGen team configuration vocabulary |
| S15 | — | Magentic-UI co-planning; LangGraph interrupt vocabulary |
| S16 | BullMQ | Temporal worker model; OpenClaw supervisor patterns |
| S17 | CodeMirror 6 | OpenHands workspace panels; lease semantics (Temporal/Kubernetes vocabulary) |
| S18 | xterm.js + node-pty; Playwright (CDP screencast; launchPersistentContext) | OpenHands browser/terminal panels |
| S19 | simple-git | git-worktree docs; GitHub PR "Files changed" view |
| S20 | BullMQ delayed jobs (reminder sequence) | Letta HITL; LangGraph interrupts; Magentic-UI action approval |
| S21 | MCP TypeScript SDK (MCP servers wrapped as Connectors) | — |
| S22 | BullMQ retry/backoff; tree-kill / process-group kill | Temporal RetryPolicy semantics |
| S23 | Vercel AI SDK (native + OpenAI-compatible + community providers) | — |
| S24 | — (custom ledger; explicitly no billing libraries) | — |
| S25 | SearXNG (external container); @mozilla/readability + turndown; unpdf; SheetJS CE | — |
| S26 | docker run/exec sandboxing (no new dependencies) | E2B sandbox model; OpenClaw sandboxing docs |
| S27 | — (reuse Playwright; write tests, not tools) | OWASP checklists from S04 |
| S28 | BullMQ repeatable jobs; chokidar | — |
| S29 | secretlint | Letta memory / sleep-time-agents vocabulary |
| S30 | Web Notifications API; BroadcastChannel | — |
| S31 | — (custom checkpoints on the S02/S07 journal) | Temporal replay semantics |
| S32 | commander | — |
| S33 | restic (external binary, BSD-2) | — |
| S34 | Playwright Test; axe-core | — |
| S35 | Docker Compose; Caddy | — |
