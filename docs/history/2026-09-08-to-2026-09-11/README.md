# Shera Bot — Three-Day Design Session Archive

**Session window:** 2026-09-08 through 2026-09-11  
**Repository:** `E:\PROJECTS\shera-bot`  
**Primary thread:** Codex thread `01a0800a-6bb4-7a33-a0d9-4c211cb70f6e`  
**Purpose:** Preserve the complete reasoning trail behind Shera Bot's architecture and product model so future agents do not rely on a short summary or a machine-local session history.

## Start here

1. Read [`docs/README.md`](../../README.md) for the repository documentation map.
2. Read [`docs/PRD.md`](../../PRD.md) as the unchanged 2026-09-08 baseline. Do not treat later records as an excuse to edit it without a new direct instruction.
3. Read [`docs/decisions/README.md`](../../decisions/README.md), then [`confirmed-decisions.md`](../../decisions/confirmed-decisions.md) and [`closure-decisions.md`](../../decisions/closure-decisions.md).
4. Read [`GLOSSARY.md`](../../GLOSSARY.md) and [`TRACEABILITY.md`](../../TRACEABILITY.md) for the canonical vocabulary and implementation mapping.
5. Read [`pre-session-transcripts.md`](pre-session-transcripts.md) for the earlier product-origin, PRD/TODO, and office-hours sessions.
6. Read [`codex-transcript.md`](codex-transcript.md) for the complete readable benchmark/grilling transcript through Q39.
7. Read [`zcode-continuation-transcript.md`](zcode-continuation-transcript.md) for the complete continuation, recovery, one-question-at-a-time decisions, and documentation work.
8. Read [`findings-obstacles-references.md`](findings-obstacles-references.md) for benchmark findings, founder analysis, references, obstacles, and corrections.
9. Read [`source-manifest.md`](source-manifest.md) for the tracked source inventory and checksums.
10. Read [`supporting/office-hours-founder-memo.md`](supporting/office-hours-founder-memo.md) for the complete founder assessment.
11. Read [`skills/`](skills/) for the snapshotted grilling, wrapper, office-hours, and domain-modeling skill instructions.
12. Use the local-only [raw source manifest](../../../.session-archive/2026-09-08-to-2026-09-11/source-manifest.json) only when exact raw evidence or checksum verification is required.

## Timeline

### 2026-09-08 — product assessment and benchmark

- The original PRD was assessed as a thoughtful but very broad platform vision rather than a validated startup wedge.
- The five-repository comparison covered OpenHands / Agent Canvas, Agent Zero, LibreChat, Dify, and SuperAGI.
- The benchmark correctly classified the repository as requirements-only at that point: no runnable application, package manifest, test harness, or dev server existed at the root, so runtime metrics were **unmeasured**, not zero.
- The grilling began with isolation, tenancy, data ownership, process lifecycle, orchestration, persistence, and approval safety.

### 2026-09-09 — runtime and safety architecture

- The session settled local-first data ownership, a supervised runtime gateway, a durable task state machine, scoped approvals, SQLite WAL, typed contracts, the Pi JSONL boundary, cloud backend portability, and the three-application/small-package repository strategy.
- The session also recorded the OpenHands-inspired browser/backend/runtime separation and the need to keep Redis out of the source-of-truth role.

### 2026-09-10 — configuration, providers, and packs

- The session settled zero-configuration defaults with optional onboarding and a full settings editor.
- Admin-funded provider access and credits were separated from optional user custom providers.
- Versioned declarative customer packs and workspace pinning replaced a hardcoded three-role platform model.

### 2026-09-11 — Operations, Agents, and recovery

- The product model changed from Scene to **Operation**.
- The user-facing hierarchy became **Pack → Operations → Agents**.
- Agents became persistent logical identities with on-demand sessions and task-governed workers.
- Operation chats became reusable collaborative workspaces with independently tracked task runs.
- The Codex run stopped after the user answered Question 39 with `for the prototype yes`; AgentRouter returned HTTP 402 because its budget pool quota was exhausted.
- This session recovered the answer, continued one question at a time through Q45, and recorded the user's explicit instruction to use **Agent everywhere**, retain Operations, and leave the previous PRD unchanged.

## Session outcomes

- Codex readable transcript: predecessor benchmark/Q1 plus the complete 124-message main extraction through Q39.
- Continued readable transcript: the local ZCode continuation, including Q40–Q45 and the archive/reconciliation work.
- Confirmed decision records: D1–D45.
- Engineering records: E1–E8, explicitly delegated by PRD §24 rather than presented as user product decisions.
- D45 adds acceptance criteria 22–27, but they are recorded outside the unchanged PRD.
- D39 is based on an explicit user reply, but the original Codex acknowledgement was lost to the quota failure; it is therefore marked as incomplete-evidence confirmation, not silently presented as a normal acknowledged turn.
- Full proposal history is preserved in [`../../decisions/proposal-history.md`](../../decisions/proposal-history.md); the tracked source inventory is [`source-manifest.md`](source-manifest.md).

## Evidence and privacy boundary

- The tracked Markdown transcripts exclude hidden system/developer prompts, internal reasoning, credentials, and raw tool payloads.
- Exact raw rollouts, the attached reference image, skill snapshots, and source files are copied into `.session-archive/2026-09-08-to-2026-09-11/`, checksummed, and ignored by Git.
- A missing or unavailable source is recorded in `source-manifest.json`; absence is never silently replaced with a fabricated transcript.
- The archive is historical evidence. The canonical current vocabulary and status rules are in `docs/GLOSSARY.md`, `docs/TRACEABILITY.md`, and the decision indexes.
