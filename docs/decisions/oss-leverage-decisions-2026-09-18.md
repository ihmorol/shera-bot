# Shera Bot — Open-source leverage decision (2026-09-18): E15

Part of the decision records. Index and provenance: [`README.md`](README.md). Previous records: [`confirmed-decisions.md`](confirmed-decisions.md) (D1–D39), [`closure-decisions.md`](closure-decisions.md) (D40–D45, E1–E8), [`open-items-decisions-2026-09-17.md`](open-items-decisions-2026-09-17.md) (D46–D50, E9–E14).

> **Provenance.** On 2026-09-18 the product owner gave four instructions in one session, preserved verbatim:
>
> 1. **"find opensource projects that exactly match my project. or maybe a few differences that can be tweeked and changed."**
> 2. **"how can we take advantage of these opensource projects while our build to reduce time and optimization and avoid new creativity."**
> 3. **"in all the issues refernce the opensource product and tell them to use them without wasting tokens. tell them to read the docs and where to look exactly in all the issues."**
> 4. **"did you update the docs? update them and commit them and push them so that other agents and people can see also."**
>
> The agent researched the open-source landscape on 2026-09-18 (web research; every cited documentation URL HTTP-verified before citation), appended an **"Open-source leverage (recorded 2026-09-18)"** section to issues #1–#36 in this repository, and records the resulting engineering policy here as **E15**.

---

# E15 — Open-source leverage policy and per-slice adoption map

**Status:** Delegated engineering (pending owner review) — decided by the agent under the owner's 2026-09-18 instructions quoted in the provenance block; becomes Confirmed on owner review. No PRD text changes; this record operates under PRD §24's delegation of engineering library choices.
**Evidence:** Owner messages 2026-09-18 (this session, verbatim above). 2026-09-18 research findings: whole-product candidates OpenClaw (MIT), Suna/Kortix (Apache-2.0), Coze Studio (Apache-2.0), Dify (Apache-2.0 with additional terms), LibreChat (MIT), AutoGPT Platform; layer candidates Letta (Apache-2.0), Temporal (MIT), Magentic-UI, OpenHands (MIT), AutoGen, CrewAI, Coder (AGPL); all URLs cited in the issue sections returned HTTP 200 on 2026-09-18. Operational record: issues #1–#36 updated with per-slice "Open-source leverage" sections; the append script is archived at `artifacts/oss-issue-sections.sh` (idempotent; safe to re-run).

**Decision:**

1. **Three-tier policy for every slice.**
   - **Embed** — permissively licensed dependencies (MIT / Apache-2.0 / BSD / ISC) that fit the PRD §17 stack (TypeScript monorepo, Drizzle, Redis, Docker). Preferred wherever a mature component exists.
   - **Pattern-only** — AGPL/GPL projects and out-of-stack projects (Dify, Coze Studio, Suna, AutoGPT Platform, Temporal server, Coder): copy semantics and vocabulary, never code or branding.
   - **Never adopt** — agent frameworks as the orchestration runtime (LangGraph, CrewAI, AutoGen): G2 keeps task-run creation typed and gateway-owned; vocabulary-only reference is allowed. Whole platforms are never the base.
2. **License allowlist gate.** S01's license-inventory CI job (PRD §22.22) accepts only MIT, Apache-2.0, BSD, and ISC for linked dependencies; anything else fails CI. AGPL/GPL is permitted only as an unmodified external service (SearXNG container, HTTP calls only) or external binary (restic, BSD-2), with no code linking.
3. **Per-slice adoption map** (the binding mapping; the issue sections carry the same content with exact doc links and repo search terms):

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

4. **Anti-creativity rule.** Each slice's design notes name its reference project or embedded component before implementation begins. Established mechanism names — lease, heartbeat, replay cursor, retry policy, signal, worktree — are used with their established semantics rather than local variants. A slice that cannot name a reference treats that as an over-design signal and raises it with the owner before inventing.
5. **Per-slice recording.** Every adopted dependency is recorded as an engineering note (E-register entry or explicit note in the slice pull request) in the slice's evidence pack, keeping the S01 license inventory honest.

**Rationale:** the owner instructed reducing build time and avoiding unnecessary invention. Every individual layer of the architecture has a battle-tested open-source reference; the product's genuinely novel parts — Pack → Operation → Agent versioning, typed task-run creation, scoped grant objects, the credit ledger — have no OSS equivalent and remain governed by the recorded decisions (D1–D50). Embedding boring, permissively-licensed components and mirroring proven semantics is the cheapest path to the 27 acceptance criteria on a solo-developer schedule.

**Alternatives considered (preserved):**
- (a) Base the prototype on a whole platform (Dify, Coze Studio, Suna, AutoGPT Platform) — rejected: stack mismatch with PRD §17 (Python/Go/Supabase vs the TypeScript monorepo); adoption would submerge the runtime gateway, which is the actual product; Dify's additional license terms restrict multi-tenant SaaS and branding.
- (b) Adopt LangGraph / CrewAI / AutoGen as the orchestration runtime — rejected: contradicts G2 (agents propose; the gateway validates and executes; typed events create task runs). Retained as vocabulary references for S13–S15 only.
- (c) Embed the Temporal server for durable tasks — rejected for the prototype: additional infrastructure beyond one VM / five users; its event-history, retry, and signal semantics are mirrored by S02/S22/S31 instead.
- (d) Build everything in-house with no external references — rejected: contradicts the owner's instruction; slower and weaker on security and performance patterns.
- (e) Adopt LibreChat as the client shell — rejected: no per-user container tenancy and no task lifecycle; the §17 stack is preserved by building the shell on shadcn/Radix/TanStack instead.

**Affected PRD sections:** none changed (no product text). Touchpoints: §17 (engineering library choices delegated by §24), §22 (implementation register — items satisfied via the named components), §23 (license compliance operationalized by the S01 allowlist gate).

**Implementation implications:** per-slice "Open-source leverage" sections in issues #1–#36 (exact doc links, doc sections, and repo search terms); BUILD_MAP §8 mirrors this map as the repo-side twin; S01 ships the license-allowlist CI gate; individual slices record their concrete adoptions as E-notes. No changes to Pack/Operation/Agent contracts, the approval model, tenancy, or acceptance criteria.

**Verification coverage:** S01's CI gate proves the allowlist mechanically (PRD §22.22); each slice's evidence pack lists adopted dependencies with its E-note; the S34 acceptance runner is unaffected; the TRACEABILITY decision-index row for E15 tracks closure on owner review.

---

**Sync note (2026-09-18):** issues #1–#36 carry the operational sections; [`../BUILD_MAP.md`](../BUILD_MAP.md) §8 mirrors the map; [`../TRACEABILITY.md`](../TRACEABILITY.md) carries the E15 decision-index row; [`../README.md`](../README.md) and the decision index were updated. No PRD synchronization was needed (no product text changed).
