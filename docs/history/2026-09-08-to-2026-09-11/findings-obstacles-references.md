# Shera Bot — Findings, Obstacles, and References Ledger

**Session archive:** [`README.md`](README.md)  
**Earlier product/PRD sessions:** [`pre-session-transcripts.md`](pre-session-transcripts.md)  
**Complete Codex transcript:** [`codex-transcript.md`](codex-transcript.md)  
**Complete ZCode continuation:** [`zcode-continuation-transcript.md`](zcode-continuation-transcript.md)  
**Tracked source manifest:** [`source-manifest.md`](source-manifest.md)  
**Decision traceability:** [`../../TRACEABILITY.md`](../../TRACEABILITY.md)

This ledger preserves findings that informed decisions, not only the final decisions. A finding is evidence or an interpretation; it is not automatically a product requirement.

## 1. Repository benchmark finding

The predecessor Codex session evaluated five open-source projects without changing this repository. The useful pattern was to take practices, not copy implementations:

| Project | Transferable practice | What Shera adopted | What the session explicitly avoided |
|---|---|---|---|
| OpenHands / Agent Canvas | Explicit browser/backend/agent-server separation; backend switching; sandbox lifecycle; mock/live test separation | Typed runtime backend registry; server-side proxy boundary; fake-runtime tests; cloud backend adapters | Direct browser knowledge of Docker/provider internals; assuming every sandbox mode is equally safe |
| Agent Zero | Declarative profiles, project-scoped configuration, deterministic extension ordering, scoped instructions | Versioned Agent Packs; profile-local prompts/tools; scoped configuration and instructions | Prompt-only security; unbounded dynamic extensions |
| LibreChat | Typed/generated client discipline, auth/resource middleware, queued turns, persisted sanitized errors | Typed clients; authorization boundaries; queued task commands; stable redacted errors | Importing its whole provider/integration surface into the prototype |
| Dify | API/worker/runtime separation; typed event adaptation; stop-aware queues; generated deployment config; path isolation | Durable event contracts; cancellation at queue boundaries; worker/runtime separation; controlled deployment config | Full visual workflow graph machinery and a large optional-service matrix |
| SuperAGI | Explicit execution records, statuses, schedules, permissions, migrations, operator history | Task state model; execution records; schedule/permission concepts; migration discipline | Legacy queue shortcuts, unsafe serialization/eval patterns, and treating older implementation quality as a template |

**Benchmark limitation:** at that time the Shera repository contained only `docs/PRD.md`; there was no runnable application, package manifest, test harness, or dev server. Therefore performance/reliability/UX metrics were **unmeasured**, not zero. The benchmark produced a capability and adoption baseline, not a performance claim.

## 2. Founder/office-hours finding

The office-hours assessment found that Shera was a coherent platform vision but not yet a validated startup problem. It recommended a narrower local coding-task runner for technical founders before building the full platform: one repository, one Agent, one bounded TypeScript/pnpm task, reviewable branch, evidence trail, no deployment/browser/package installation/remote writes, and a paid pilot test.

That recommendation is preserved in full at [`supporting/office-hours-founder-memo.md`](supporting/office-hours-founder-memo.md) and is also listed in the [source manifest](source-manifest.md). It remains a strategic warning and validation hypothesis, not a silently adopted scope change. The later grilling continued to design the broader private prototype because the user explicitly pursued the architecture and pack model.

## 3. Product-model findings

- “Scene” was a reference-product term and was renamed **Operation** for Shera.
- The final vocabulary is **Pack → Operations → Agents**; “Expert” is historical wording only.
- Agents are reusable persistent identities; an Operation is a reusable collaboration context; a task run is the concrete lifecycle unit.
- The first student Pack is intentionally focused: six Agents and three pack-defined Operations, with ad-hoc Operations for other same-Pack combinations.
- A user has one workspace in the prototype; no workspace switcher is shown, but records are internally `workspace_id`-scoped for future expansion.

## 4. Obstacles and corrections

| Obstacle/problem | Effect | Correction or current disposition |
|---|---|---|
| AgentRouter returned HTTP 402 `Budget pool quota has been exhausted` | The Codex run ended immediately after the user’s explicit D39 reply; no assistant acknowledgement was stored (`last_agent_message: null`) | Preserve the raw error and answer evidence; mark D39 as explicit-answer/incomplete-acknowledgement rather than pretending the original turn completed |
| D40–D49 were initially self-recorded as defaults | The first recovery pass answered product decisions without user confirmation, contrary to the grilling skill | Demote unasked items to drafts; resume one question at a time; only D40–D45 are user-confirmed in the continuation |
| A PRD addendum was temporarily appended | Violated the user’s later instruction not to change the previous PRD | Reverted `docs/PRD.md` to its original 338-line committed state; reconciliation now lives in `docs/TRACEABILITY.md` |
| The monolithic decision register was initially created | Made the record harder to navigate and mixed statuses | Replaced it with `docs/decisions/README.md`, `confirmed-decisions.md`, and `closure-decisions.md` |
| Blind `Expert`→`Agent` replacement created “agentss”, “Agents-private”, and awkward text | Introduced documentation defects | Fixed the artifacts; canonical glossary now governs terminology |
| Explore subagents hit model-request failures | Two source audits could not return; one consistency audit eventually completed | Do not treat unavailable subagent output as evidence; use direct source artifacts and record the failure |
| Current ZCode raw export was initially mislocated and the first parser under-counted messages | Risked an incomplete continuation transcript | Located the live model-I/O rollouts, kept raw copies locally, and preserved the readable continuation separately; cumulative-window behavior is documented |
| The referenced clipboard image was machine-local | A future agent could lose the visual reference | Copied and checksummed the image locally; its transcript description remains in the readable Codex archive |
| The continuation session began under a different model and hit a rate limit before the model switch | The first user turns ("Can you see the last codex runs", "Try again") originally ran under `gpt-6-astra`, which returned `ProviderBusinessError: ... exceeded rate limit`; the session then switched to `gpt-5.6-sol` | The switch and error are recorded here and in the readable continuation transcript's error section; the raw pre-switch export (`model-io-sess_41baab3d-...jsonl`) was rotated off disk before archiving and is listed as missing in the source manifest rather than fabricated |
| PRD and decisions intentionally conflict | Implementers could follow the obsolete three-agent/task-chat model | Added a reconciliation matrix, canonical glossary, traceability table, and mandatory reading order; PRD remains unchanged by instruction |

## 5. Reference ledger

### OpenHands / Agent Canvas

| Reference | Use in session | Verification level |
|---|---|---|
| <https://github.com/OpenHands/OpenHands/blob/main/AGENTS.md> | Repository/test/contributor boundary patterns | Source URL cited during analysis; preserve as research reference |
| <https://github.com/OpenHands/OpenHands/blob/main/README.md> | Sandbox and product boundary context | Source URL cited during analysis |
| <https://github.com/OpenHands/OpenHands/blob/main/docs/architecture.md> | Architecture separation reference | Source URL cited during analysis |
| <https://github.com/OpenHands/OpenHands/tree/main/tests/e2e> | Mock/live E2E test comparison | Source URL cited during analysis |
| <https://github.com/OpenHands/docs/blob/main/openhands/usage/agent-canvas/overview.mdx> | Browser/backend/cloud session boundary | Source URL cited during analysis |
| <https://github.com/OpenHands/docs/blob/main/openhands/usage/agent-canvas/overview.mdx?utm_source=openai> | Same reference with query parameter from transcript | Duplicate/citation variant; normalize before publication |
| <https://github.com/OpenHands/software-agent-sdk/blob/main/README.md> | SDK boundary reference | Source URL cited during analysis |

### Agent Zero

| Reference | Use in session | Verification level |
|---|---|---|
| <https://github.com/agent0ai/agent-zero> | Project/profile/extensibility comparison | Source URL cited during analysis |
| <https://github.com/agent0ai/agent-zero/tree/main/agents> | Agent profile layout | Source URL cited during analysis |
| <https://github.com/agent0ai/agent-zero/blob/main/agents/AGENTS.md> | Scoped agent instructions | Source URL cited during analysis |
| <https://github.com/agent0ai/agent-zero/blob/main/extensions/python/AGENTS.md> | Scoped extension instructions | Source URL cited during analysis |
| <https://github.com/agent0ai/agent-zero/blob/main/helpers/security.py> | Security helper comparison | Source URL cited during analysis |
| <https://github.com/agent0ai/agent-zero/blob/main/plugins/_orchestrator/AGENTS.md> | Orchestrator instruction scope | Source URL cited during analysis |

### LibreChat

| Reference | Use in session | Verification level |
|---|---|---|
| <https://github.com/danny-avila/LibreChat/blob/main/api/server/controllers/agents/callbacks.js> | Agent callback/queued execution pattern | Source URL cited during analysis |
| <https://github.com/danny-avila/LibreChat/blob/main/api/server/controllers/agents/queuedTurns.js> | Queued turns | Source URL cited during analysis |
| <https://github.com/danny-avila/LibreChat/blob/main/api/server/middleware/accessResources/canAccessResource.js> | Resource authorization | Source URL cited during analysis |
| <https://github.com/danny-avila/LibreChat/blob/main/api/server/middleware/error.js> | Sanitized errors | Source URL cited during analysis |
| <https://github.com/danny-avila/LibreChat/blob/main/package.json> | Package/workspace comparison | Source URL cited during analysis |

### Dify

| Reference | Use in session | Verification level |
|---|---|---|
| <https://github.com/langgenius/dify/blob/main/api/clients/agent_backend/event_adapter.py> | Typed agent event adaptation | Source URL cited during analysis |
| <https://github.com/langgenius/dify/blob/main/api/core/app/apps/base_app_queue_manager.py> | Queue/event semantics | Source URL cited during analysis |
| <https://github.com/langgenius/dify/blob/main/api/core/app/apps/workflow/stop_aware_ready_queue.py> | Stop-aware queue behavior | Source URL cited during analysis |
| <https://github.com/langgenius/dify/tree/main/api/core/app/apps/workflow> | Workflow execution area | Source URL cited during analysis |
| <https://github.com/langgenius/dify/blob/main/dify-agent/docs/dify-agent/guide/index.md> | Agent runtime guide | Source URL cited during analysis |
| <https://github.com/langgenius/dify/blob/main/docker/docker-compose.yaml> | Generated deployment/config pattern | Source URL cited during analysis |
| <https://github.com/langgenius/dify/blob/main/web/AGENTS.md> | Web workspace guidance | Source URL cited during analysis |

### SuperAGI

| Reference | Use in session | Verification level |
|---|---|---|
| <https://github.com/TransformerOptimus/SuperAGI/tree/main/migrations> | Migration/execution-record comparison | Source URL cited during analysis |
| <https://github.com/TransformerOptimus/SuperAGI/tree/main/tests/unit_tests> | Test organization comparison | Source URL cited during analysis |
| <https://github.com/TransformerOptimus/SuperAGI/blob/main/superagi/models/agent_execution.py> | Execution model | Source URL cited during analysis |
| <https://github.com/TransformerOptimus/SuperAGI/blob/main/superagi/controllers/agent_execution.py> | Execution controller | Source URL cited during analysis |
| <https://github.com/TransformerOptimus/SuperAGI/blob/main/superagi/agent/output_parser.py> | Output handling comparison | Source URL cited during analysis |
| <https://github.com/TransformerOptimus/SuperAGI/blob/main/superagi/agent/tool_executor.py> | Tool execution comparison | Source URL cited during analysis |

### Database and TypeScript architecture references

| Reference | Use in session | Verification level |
|---|---|---|
| <https://orm.drizzle.team/docs/get-started/node-sqlite-existing?utm_source=openai> | Drizzle SQLite setup | Source URL cited during analysis |
| <https://orm.drizzle.team/docs/sqlite/get-started-sqlite?utm_source=openai> | Drizzle SQLite support | Source URL cited during analysis |
| <https://www.prisma.io/docs/guides/database/multiple-databases?utm_source=openai> | Prisma multi-database comparison | Source URL cited during analysis |
| <https://kysely-org.github.io/kysely-apidoc/interfaces/Dialect.html?utm_source=openai> | Kysely dialect comparison | Source URL cited during analysis |

### Skills and local evidence

| Reference | Use in session | Verification level |
|---|---|---|
| `grilling` skill, mattpocock skills `1.2.3` | Design-tree interview rules | Snapshotted locally under `.session-archive/.../skills/grilling-SKILL.md` |
| `grill-me` | Wrapper that invokes `/grilling` | Snapshotted locally |
| `grill-with-docs` | Wrapper that invokes `/grilling` plus domain-modeling | Snapshotted locally |
| `office-hours` | Solo-founder product assessment | Snapshotted locally; full memo preserved |
| `domain-modeling` | Referenced by grill-with-docs | Snapshotted locally |
| `codex-clipboard-...png` | User-provided visual product-pattern reference | Copied and checksummed locally; not a product specification |

## 6. Citation and evidence cautions

- URLs above are references used in the session, not claims that Shera copied any implementation.
- The transcript contains a citation mismatch in one discussion where a Dify queue reference was associated with a LibreChat explanation. The ledger preserves both the claim and the URL family; implementation should verify the actual source before relying on it.
- Query-string variants such as `?utm_source=openai` are retained for provenance but should be normalized when building a formal bibliography.
- The office-hours memo's market recommendation and the architecture grilling's platform direction are both preserved; neither should be silently erased to make the final choice look inevitable.
