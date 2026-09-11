# Shera Bot — Confirmed Decisions (1–39)

Part of the decision records. Index and provenance: [`README.md`](README.md).
**Status:** D1–D38 are confirmed from explicit Codex-session answers. D39 has an explicit user answer but an incomplete original assistant acknowledgement because the provider quota error ended the turn; see D39's evidence note and the full archive.
**Terminology note (D44):** decisions 29–43 use the historical word "Expert" for what D44 renames to **"Agent"** everywhere (Pack → Operations → Agents). Historical wording below is preserved for provenance, but these sections are not current naming guidance. New UI, code, schemas, and pack files must use "Agent".

---

## D1 — Container is the prototype isolation boundary, not a permanent data architecture
**Status:** Confirmed
**Decision:** Version one runs one isolated container per user. The container is the isolation boundary, but it must not become an architectural trap: central PostgreSQL may later own conversations, tasks, memories, or provider configuration. No feature may assume "all state lives on the container filesystem."
**Implication:** Define storage ports and stable IDs from the beginning (see D2).

## D2 — Local-first data ownership with migration-ready repository ports
**Status:** Confirmed (refined)
**Decision:** Keep the maximum amount of product data inside the user container.
- **Central PostgreSQL holds only control-plane records:** account + Google OAuth identity, signup cap and administrator flags, user→container mapping, container tier/provisioning state/health/resource summary, container placement and runtime endpoint metadata, backup/snapshot metadata and restore operations, operational security events required by the control plane, emergency commands (restart/stop/cancel-all).
- **Container-local database holds product state:** conversations and messages, task and group-chat state, agent execution state, approvals and permission decisions, event history and replay cursors, memories and memory provenance, schedules and event watchers, tool inventory and tool versions, provider configuration metadata, recovery checkpoints, Git/worktree state, usage and execution history.
- **Container volume holds:** secrets, browser profiles, files, projects, private agent folders.
- **Migration readiness:** domain records get stable IDs and repository interfaces now; no domain code is coupled directly to filesystem or database implementation.
**Supersedes:** the earlier "split deliberately" framing was replaced by this stricter local-first model.
**Reconciliation:** where D8 says "PostgreSQL as source of truth," read it as *the local authoritative store (SQLite, per D10) for product state*; central PostgreSQL is authoritative only for control-plane records.

## D3 — Hybrid agent-process lifecycle
**Status:** SUPERSEDED by D32
**Original decision:** Each role keeps one long-lived Pi process for identity, memory, and coordination; every actual task runs in a separately supervised child process with bounded CPU/memory/filesystem/network/timeout policies, cancellation propagation, and independent checkpoints.
**Superseded because:** a pack may contain many experts; keeping every expert process alive wastes memory and does not scale.

## D4 — Hybrid orchestration: the control plane owns safety and lifecycle
**Status:** Confirmed
**Decision:** The General Assistant proposes plans, delegation, and synthesis through typed commands. The control plane validates commands against authorization, approval, resource, and state rules, and owns task creation, queueing, retries, cancellation, child-process supervision, event ordering, and recovery. Agents cannot directly mutate another agent's state or bypass approval policy. Every delegation is a typed command carrying actor, target, task, scope, and idempotency key.

## D5 — Hybrid persistence: current-state tables plus append-only event journal
**Status:** Confirmed
**Decision:** Maintain indexed current-state tables for fast reads, plus an append-only event journal for replay, auditing, reconnects, and recovery. Per-stream sequence numbers and replay cursors. Event payloads validated against versioned Zod schemas and carry actor, task, agent, timestamp, idempotency key, and redaction classification. Rebuild/repair tools can reconcile current state from the journal.

## D6 — Path/task-scoped workspace ownership leases
**Status:** Confirmed
**Decision:** Concurrent reads are allowed; writes require a task-scoped lease. Coding work uses isolated branches/worktrees; research artifacts use task-owned paths. Conflicts queue, fail clearly, or require an explicit merge — never a silent overwrite. Leases expire on completion, cancellation, timeout, or process failure.
**Common ground between agents:** shared task ID and goal, shared task context, per-agent capability manifest, shared status/outcome vocabulary, artifact references (never copied large content), ownership/lease metadata, handoff requirements, structured progress/failure events, explicit uncertainty fields.

## D7 — Typed agent-to-agent collaboration protocol is mandatory
**Status:** Confirmed
**Decision:** Delegation, progress, handoff, approval request, artifact publication, failure, and completion use schemas; natural language is allowed only as explanatory payload inside those schemas. Categories: `TaskProposed`, `TaskAccepted`, `TaskDelegated`, `ProgressReported`, `ArtifactPublished`, `ApprovalRequested`, `QuestionRaised`, `TaskBlocked`, `TaskFailed`, `TaskCompleted`, `HandoffRequested`.
**Required fields:** `task_id`, `parent_task_id`, `conversation_id`, `sender_agent`, `recipient_agent`, `message_type`, `goal_or_summary`, `artifact_refs`, `required_capabilities`, `risk_class`, `status`, `confidence`, `unresolved_questions`, `created_at`, `idempotency_key`.

## D8 — Custom durable task state machine for the prototype
**Status:** Confirmed
**Decision:** Explicit persisted task states and transitions. The local authoritative store is the source of truth; Redis only handles delivery and wakeups. States: `CREATED`, `PLANNED`, `QUEUED`, `RUNNING`, `WAITING_FOR_AGENT`, `WAITING_FOR_APPROVAL`, `WAITING_FOR_RESOURCE`, `RETRYING`, `CANCELLING`, `CANCELLED`, `SUCCEEDED`, `FAILED`, `PAUSED`, `RECOVERY_REQUIRED`.
**Required machinery:** transition table/function, allowed source/target states, actor and reason, idempotency key, optimistic-concurrency/version check, emitted event, retry and timeout policy, recovery behavior. Workflow graphs remain a later layer.

## D9 — Reusable, scoped, deny-by-default approval grants
**Status:** Confirmed
**Decision:** Support one-time approval plus scoped reusable grants with expiry and revocation.
**Grant fields:** `grant_id`, `principal_type` (user|agent|task), `principal_id`, `tool_id`, `capability`, `resource_scope`, `conversation_scope`, `workspace_scope`, `expires_at`, `created_by`, `approved_at`, `revoked_at`.
**Risk levels:** `READ_ONLY`, `LOCAL_MUTATION`, `DESTRUCTIVE_LOCAL`, `EXTERNAL_WRITE`, `CREDENTIAL_ACCESS`, `DEPLOYMENT`, `FINANCIAL_OR_IRREVERSIBLE`.
**Rules:** prompts cannot grant capabilities; an agent cannot approve its own action; a child task cannot widen its parent's permissions; a grant must be narrower than or equal to the requested action; resource scope must be explicit; approval decisions are immutable events; approval is rechecked when a queued task resumes; a changed tool version or changed arguments invalidates a prior one-time approval; secrets never appear in approval prompts or event payloads; the UI shows the exact tool, arguments summary, target resource, side effect, and expiry.

## D10 — SQLite in WAL mode inside each user container
**Status:** Confirmed
**Decision:** One SQLite database per user container in WAL mode, behind repository interfaces. Explicit schema migrations, foreign keys and uniqueness enabled, short transactions, append-only event journal tables, busy timeout and bounded retry for lock contention. No direct SQL from agent processes; all writes go through application repositories. Snapshot/restore as part of the user volume backup. A single local persistence service or write coordinator handles high-contention event/state writes; read-only queries may come from web app and agents.

## D11 — One supervised runtime gateway as the local authority
**Status:** Confirmed
**Decision:** Each user container exposes one supervised runtime service that owns SQLite writes, task state transitions, event sequencing, approvals, leases, and child-process supervision. Agents and UI use a typed local API.
```text
container-runtime
├── runtime-gateway        # only component allowed authoritative transitions/event sequencing
├── persistence
├── task-supervisor
├── scheduler
├── agent-process: <expert> (on demand)
└── child-task-processes
```
Agents may propose commands, stream progress, publish artifacts, request approvals, report failures, and ask for delegation; the gateway decides validity. Typed local transport: Unix domain socket where supported, loopback HTTP/WebSocket fallback in development, versioned Zod schemas, authenticated process identity, request IDs and idempotency keys, bounded payloads, structured errors.

## D12 — Typed backend registry and cloud-runtime contract
**Status:** Confirmed
**Decision:** The web app talks to a typed `RuntimeBackend` contract; local container, remote container, and managed cloud backends implement it.
**Operations:** `provisionRuntime`, `resumeRuntime`, `getRuntimeStatus`, `getRuntimeCapabilities`, `openSession`, `sendCommand`, `subscribeEvents`, `requestFileOrArtifact`, `pauseRuntime`, `stopRuntime`, `cancelTask`.
**Backends:** `LocalContainerBackend`, `RemoteContainerBackend`, `ManagedCloudBackend`.
**The frontend never knows:** Docker container IDs, host paths, internal service ports, cloud provider IDs, provider credentials, sandbox implementation details. The gateway returns an opaque runtime handle and session-scoped access information. Cloud backends support create/resume, readiness and health, endpoint discovery, session auth, explicit cleanup/keep-alive, timeout and failure classification.

## D13 — TypeScript runtime gateway; Pi behind a versioned child-process adapter
**Status:** Confirmed (provisional for the prototype)
**Decision:** Implement the gateway, supervisor, scheduler, persistence, authorization, event model, and provider adapters in TypeScript; Pi runs as child processes behind a typed adapter. Validate with a process-supervision spike before committing to a long-term Pi integration contract.
**Pi owns:** role identity, prompt/profile assembly, model interaction, tool proposal, progress explanation, result synthesis.
**Pi does not own:** authorization, approval decisions, durable task transitions, event sequencing, retry policy, leases, container lifecycle, provider secret persistence, cross-agent writes.

## D14 — JSON Lines over stdin/stdout for the Pi adapter
**Status:** Confirmed
**Decision:** Pi child processes communicate with the gateway over versioned JSONL on stdin/stdout (lowest operational/token cost). The runtime gateway exposes HTTP/WebSocket externally. Required events: `ready`, `heartbeat`, `message_delta`, `tool_proposed`, `progress`, `artifact_published`, `approval_requested`, `checkpoint`, `completed`, `failed`, `cancelled`, `fatal`, plus protocol-level `PiCommand`, `PiHeartbeat`, `PiCheckpoint`, `PiFailure`, `PiShutdown`.
**Behavior:** stdout carries protocol messages only; stderr is diagnostic and redacted before logging; every message has a correlation ID; the gateway detects process death independently of a final event; heartbeats detect hung processes; the gateway can terminate the whole child process tree; invalid messages are rejected and recorded as protocol failures; the protocol is versioned; tests use fake Pi processes with deterministic events and failures.

## D15 — Canonical state plus compact references for context
**Status:** Confirmed
**Decision:** Store shared context in the local database and artifacts; send compact event envelopes and retrieve only relevant context. Each expert receives current task goal, its assigned subtask, relevant recent events, referenced artifact metadata, required capabilities, constraints and approval state, and unresolved questions. Large files, prior messages, reports, and logs stay outside the prompt. A role-aware context compiler enforces a maximum token budget, priority ordering, truncation rules, artifact-reference substitution, secret filtering, deterministic assembly, and a record of what was included.

## D16 — Zero-configuration start, optional onboarding, full settings editor
**Status:** Confirmed
**Decision:** Shera is usable immediately with safe defaults; users who want control get an ordered onboarding wizard; a full settings editor covers everything afterward.
**First arrival auto-creates:** balanced tier, expert profiles, default model policy, default tool permissions, notification settings, approval policy, workspace and memory settings, task/retry limits, local database and runtime services, and the deployment's default provider/model assignment.
**Two paths:** use Shera immediately (defaults stay active, no blocking wizard), or run onboarding (ordered wizard, each step keeps the recommended default, skippable and reopenable).
**Settings categories:** Account, Agents/Experts, Providers and models, Model budgets, Tools, Permissions and approvals, Workspace, Files and projects, Memory, Schedules and watchers, Notifications, Privacy and retention, Runtime and resource tier, Git and repositories, Backups and recovery. Onboarding and settings must use the same configuration commands and schemas. UI shows recommended default, current value, why it matters, risk/cost impact, and reset-to-default; advanced settings are progressively disclosed.
**Constraint:** automatic setup must not silently invent credentials or select a provider with unexpected privacy or cost behavior; defaults come from explicit deployment policy, local model availability, or user configuration.

## D17 — Credit-backed provider model; no mock fallback in the user runtime
**Status:** Confirmed
**Decision:** The administrator supplies the initial provider, model catalog, and per-user credit allocation. Users may optionally configure their own provider and model to reduce platform cost. There is no mock fallback in the user-facing runtime. A missing or invalid provider produces a clear configuration/setup state, never fake completion. Provider and model configuration stays editable through onboarding and settings. Provider credentials stay inside the user container and are never copied to central PostgreSQL.
**Forward constraint:** future customer-specific expert sets must be replaceable without rewriting the runtime.

## D18 — Versioned, declarative agent packs
**Status:** Confirmed
**Decision:** An agent pack is a declarative, versioned bundle: manifest, expert profiles, prompt fragments, capability declarations, tool allow-list, default model policy, memory policy, collaboration policy, onboarding schema, settings schema, UI identity metadata, and pack version + compatibility range. The runtime, storage, authorization, task engine, and event model stay pack-independent. First pack: student (initially Researcher, Developer, General Assistant).
**Safeguards:** manifests are schema-validated; pack code cannot bypass runtime authorization; pack capabilities are upper bounds, not grants; user/admin permissions can narrow a pack; pack versions are pinned per workspace; upgrades require compatibility checks and migration notes; existing tasks retain the pack version that created them; tool and capability changes require explicit review; customer-specific packs cannot access another customer's data.
**Extended by D29** (pack contains many experts and operations, not just three roles).

## D19 — Multiple packs per deployment, one pinned pack per workspace
**Status:** Confirmed (provisional; refined by D29)
**Decision:** One installation can serve multiple audiences; each workspace is assigned one pinned, versioned customer pack. Rules: a task is permanently associated with the workspace's pack version; pack changes affect new tasks only; existing conversations and tasks keep their original pack version; agents from different packs do not silently collaborate; cross-pack collaboration requires an explicit bridge policy; user permissions can restrict which packs are available; the runtime loads packs from a registry rather than branching on customer names; pack manifests cannot override global security, tenancy, approval, or resource rules.
**Refined by D29:** a workspace's single pack exposes many Experts and Operations.

## D20 — Internal reservation-and-settlement credit ledger with a simple UI
**Status:** Confirmed
**Decision:** Admin grants credits through the control plane. Platform-provider requests reserve a bounded estimate before execution, settle against actual usage, and release unused reservations. If a reservation cannot be made, the task pauses before calling the model. Custom-provider requests do not consume Shera credits but still record local usage and latency. Provider failures release reservations unless the provider may have processed the request; ambiguous outcomes are not blindly retried. Credits never authorize tools, filesystem writes, deployment, or external actions — those remain separate approval capabilities. Existing tasks retain their provider/model snapshot unless explicitly changed.
**User-facing UI:** available credits, used credits, estimated task cost, provider/model, cost source (platform credit or custom provider). Internal ledger tables: `credit_account`, `credit_transaction`, `usage_record`, `cost_estimate`, `reservation`, `settlement`, `release`.

## D21 — Single account-level credit balance in version one
**Status:** Confirmed
**Decision:** All workspaces draw from one account-level balance. Workspace spending caps can be added later as a reservation policy layer without changing the ledger. UI shows Shera credits remaining, reserved for active tasks, used this month, custom-provider usage.

## D22 — Provider credential custody
**Status:** Confirmed
**Decision:** Admin-funded provider credentials are deployment secrets (secret manager or protected environment); never written to SQLite, central PostgreSQL, prompts, memories, artifacts, or logs; the gateway receives only the provider configuration it needs; usage is charged to the account credit ledger; the model catalog is exposed as metadata, not secrets. User custom-provider credentials are encrypted inside the user container, decrypted only at call time from a protected bootstrap key; agents receive a provider reference, never the raw credential; the UI shows masked values with revoke/replace; scope is account- or workspace-level by explicit user choice; custom-provider requests do not consume Shera credits.
**Non-negotiable:** agent packs cannot contain secrets; prompts and event payloads contain provider IDs, not credentials; error handling redacts headers, authorization fields, URLs with embedded secrets, and provider response bodies where needed; provider keys are excluded from backups unless the backup is explicitly encrypted and authorized; a provider change affects new tasks, and existing tasks keep a provider snapshot or fail safely if the credential was revoked.

## D23 — Repository and workspace strategy
**Status:** Confirmed (replaces the earlier 20-package monorepo proposal)
**Decision:** Three deployable applications, a small set of shared contract packages, and feature modules inside each application.
```text
shera-bot/
├── apps/
│   ├── web/                 # Next.js UI; owns rendering only
│   ├── control-plane/       # Express API; owns central PostgreSQL records only
│   └── user-runtime/        # runtime gateway + local authority
├── packages/
│   ├── contracts/           # Zod schemas and inferred types
│   ├── clients/             # typed clients
│   ├── agent-pack-sdk/      # manifest/schema/loader
│   ├── pi-protocol/         # JSONL protocol + fake Pi
│   ├── provider-contracts/  # provider-neutral concepts
│   ├── observability/       # logging, redaction, metrics, audit
│   └── test-kit/            # deterministic fakes
├── agent-packs/student/v1/
├── infra/{compose,docker,migrations,backup,deployment}/
├── tests/{contract,integration,e2e,recovery,security,benchmark}/
├── docs/{architecture,decisions,protocols,runbooks,PRD.md}/
├── package.json, pnpm-workspace.yaml, turbo.json, tsconfig.base.json, AGENTS.md
```
Keep scheduler, supervisor, persistence, and recovery as **modules inside** `apps/user-runtime` initially; split only when measurements justify it. Inside `apps/user-runtime`: `bootstrap/`, `modules/` (conversations, tasks, events, approvals, agents, providers, workspace, memory, schedules, recovery, runtime), `adapters/` (sqlite, redis, filesystem, browser, process, providers), `transport/` (http, websocket, local-api), `main.ts`. Each module uses a small standard shape (`*.types.ts`, `*.commands.ts`, `*.service.ts`, `*-repository.ts`, `*-transitions.ts`, `*.events.ts`, `*.test.ts`).

**Ten maintainability rules:**
1. One owner per boundary (web renders; control plane owns central ops; user runtime owns execution; Pi owns reasoning/proposals; pack owns role behavior; adapters own external systems).
2. No raw infrastructure leakage (no SQL outside repository adapters; no `child_process` outside supervisor/Pi adapter; no provider SDK outside provider adapters; no Docker API outside provisioning adapters; no Redis in domain modules; no filesystem path assumptions in shared contracts).
3. Typed discriminated unions for statuses, event kinds, backend kinds, risk classes, provider types, agent roles.
4. Stable error taxonomy (`code`, `category`, `safe_message`, `retryable`, `user_action`, `internal_details`, `correlation_id`); internal details never cross the user boundary unredacted.
5. State transitions are pure and explicit: `(current_state, command, policy, version) → accepted transition | typed rejection`; the transaction checks version, applies the transition, appends the event, updates the projection, and commits atomically.
6. Every side-effecting command is idempotent (`command_id`, `idempotency_key`, `actor_id`, `task_id`, `expected_version`); never deduplicate by message text.
7. Agents propose, runtime decides (capability, grant, lease, resource, budget, state, provider availability, conflict policy).
8. Prefer artifacts over prompt copying.
9. Local instructions are scoped: one root `AGENTS.md`; add directory-level instructions only where ownership or testing rules differ.
10. Generated files have one source of truth (OpenAPI/clients from contracts; Compose from templates; migration metadata from the tool; i18n bundles from locale sources).

**Testing strategy:** unit tests mirror modules; contract tests verify web↔control-plane, control-plane↔runtime, runtime↔Pi, old event versions, and unknown-field rejection; integration tests use real SQLite + real migrations + fake Pi + fake provider + fake clock + isolated temp filesystem; recovery tests cover process death, gateway restart, interrupted tool, pending approval, queued task, Redis unavailable, provider timeout, ambiguous provider response, duplicate webhook, browser reconnect; E2E has three modes (`mock-runtime` fast/deterministic, `local-runtime` real gateway + fakes, `live-provider` opt-in and never default CI).
**Working order (Phase 0–7):** 0 architecture contracts; 1 small vertical slice (login, cap, one container, one General Assistant chat, SQLite, streaming, reconnect/replay, fake provider, fake Pi); 2 three-agent runtime; 3 workspace and leases; 4 safety and execution; 5 user configuration; 6 recovery and autonomy; 7 scale and portability (remote/cloud backends, admin console).

## D24 — Drizzle ORM with independent PostgreSQL and SQLite schemas and migrations
**Status:** Confirmed
**Decision:** Drizzle ORM; PostgreSQL via node-postgres; SQLite via `node:sqlite` initially (subject to the runtime spike); separate schema definitions, separate migration directories, repository interfaces above Drizzle. Do not attempt one portable physical schema across both databases.
**Rules:** never use schema push in deployed environments; generate and commit migrations; review generated SQL; test every migration from the previous released database version; test backup restoration followed by migration; enable SQLite foreign keys and WAL explicitly; run SQLite integrity checks during backup verification; keep transactions short; no database calls from React components or Pi processes; no raw SQL outside adapters, migrations, and explicitly reviewed performance queries; repository interfaces remain domain-oriented; every state transition and its event append occur in one transaction; never serialize executable data or use `eval`; track central and local migration versions independently.

## D25 — Zod-first contracts with generated OpenAPI and typed clients
**Status:** Confirmed
**Decision:** Define request, response, command, and event schemas in `packages/contracts` (http, events, commands, pi, runtime, providers, packs, errors); infer TypeScript types from Zod; generate OpenAPI documentation and typed clients from the same schemas.
**Rules:** contracts contain schemas and types, not database queries or business logic; every event has a version; unknown fields are rejected for internal protocol messages unless explicitly marked extensible; user-facing HTTP errors use stable error codes; WebSocket and Pi messages carry correlation IDs; schema changes require contract tests; runtime and control-plane versions negotiate compatibility; a task created under an older agent-pack version keeps its original contract snapshot where required.

## D26 — Durable event journal plus replay cursors; WebSockets for live fanout only
**Status:** Confirmed
**Decision:** WebSockets deliver live events; the runtime stores events durably and replays from the client's last acknowledged cursor. Redis is never the source of truth (fanout, transient queues, locks, wakeups only).
**Event fields:** `event_id`, `stream_id`, `sequence`, `event_type`, `event_version`, `actor`, `task_id`, `conversation_id`, `occurred_at`, `payload`, `redaction_class`. **Client cursor:** `stream_id`, `last_received_sequence`, `last_acknowledged_sequence`, `connection_id`.
**Reconnect flow:** client sends last acknowledged cursor → runtime replays missing durable events → resumes live delivery → client marks events replayed or live → duplicate event IDs ignored → if the cursor is outside retention, the runtime returns a snapshot plus a new cursor.
**Rules:** append-only journal; immutable payloads; projections can be rebuilt; every event type has a schema and version; WebSocket handlers do not mutate task state; commands use HTTP or a typed command channel; events are emitted only after the durable transaction succeeds; heartbeats are transport-level, not business events; a disconnected client never causes task cancellation; browser closure does not stop work.

## D27 — Container boundary plus restricted child processes for version one
**Status:** Confirmed
**Decision:** The user container is the primary isolation boundary; child tasks run as an unprivileged user with path, resource, timeout, and network policies. Explicitly not equivalent to a hardened microVM; stronger isolation is a later runtime backend behind the same contracts.
**Version-one isolation:** container isolated from other users and the host; Pi processes run without host Docker socket access; child tasks run under a restricted OS user; workspace paths are resolved and checked before every file operation; working directory is fixed to the task/workspace scope; resource limits on CPU, memory, process count, disk, and wall-clock time; network disabled by default for code execution and capability-based for research/browser/provider operations; external writes remain approval-gated; tool-created processes inherit the parent task's limits; process trees are terminated on cancellation; logs and errors are redacted.
**Required security tests:** path traversal and symlink escape; workspace boundary escape; environment-variable secret exposure; process-tree escape; resource exhaustion; network policy bypass; credential leakage in stdout/stderr; agent-created tool privilege escalation; cross-task lease violation; cross-user container access.

## D28 — Built-in versioned packs in the monorepo for version one, behind a loader interface
**Status:** Confirmed
**Decision:** Packs are versioned directories in the repository, selected from a local registry.
```text
agent-packs/
├── student/{v1,v2}
└── registry.ts
```
Each workspace stores `agent_pack_id`, `agent_pack_version`, `manifest_hash`, `installed_at`. Each task stores `task_agent_pack_id`, `task_agent_pack_version`, `task_agent_pack_hash` so a pack upgrade cannot silently change an existing task.
**Future loader interface:** `resolve(packId, version)`, `validate(manifest)`, `verifyIntegrity(pack)`, `checkCompatibility(pack, runtimeVersion)`; loaders `BuiltInPackLoader`, `SignedPackagePackLoader`, `AdminRegistryPackLoader`.
**Trust rules:** a pack is data and configuration, not unrestricted code; prompts cannot bypass authorization; capabilities are upper bounds; tool permissions are rechecked by the runtime; manifests are schema-validated; hashes recorded; changes require compatibility checks; existing tasks remain pinned; packs cannot contain secrets, host paths, Docker socket access, or arbitrary startup commands.

## D29 — Revised product model: Pack → Operations → Agents (historical transcript wording: Experts)
**Status:** Confirmed; historical "Expert" wording superseded by D44 (current term: Agent)
**Decision:** The product is hierarchical and navigation is Telegram-like. "Scene" is renamed **Operation**.
```text
Customer Pack
├── Experts            # persistent, reusable agent identities
├── Expert Teams       # predefined collaboration rosters
├── Operations         # reusable collaborative workspaces/templates
├── Skills             # knowledge and workflow instructions
├── Connectors         # authenticated external integrations
├── onboarding
├── defaults
└── UI metadata
```
- **Expert** — a specialized agent with a stable identity, reusable across Operations and also usable in a direct chat.
- **Operation** — a task-oriented collaborative workspace/chat that assembles existing experts for a specific kind of work; not a new class of agent and not an independent mini-application.
- **Expert Team** — a recommended roster for an Operation; each active expert still runs through the same gateway, task state machine, approval policy, and Pi adapter.
- **Skill / Connector** — see D38.

The sidebar has two sections: **Experts** (persistent direct chats) and **Operations** (group chats). A direct expert chat can propose creating an Operation; an Operation can also be started from the sidebar. Experts communicate only through the typed collaboration protocol (D7), and the runtime still controls membership, tools, connectors, approvals, leases, credit, artifact access, and Operation state.
**Reproducibility:** every task stores `pack_id`, `pack_version`, `pack_hash`, `operation_id`, `operation_version`, `operation_hash`, `expert_roster`, `skill_snapshot`, `connector_snapshot`, `provider_snapshot`.
**Terminology:** Pack = audience catalog; Operation = task-oriented collaboration configuration/create workspace; Expert = specialized agent profile; Expert Team = predefined group; Skill = reusable capability/knowledge bundle; Connector = external integration; Task = concrete execution created from an Operation; Workspace = persistent user-owned environment containing tasks, projects, files, and memory.
**Product-term note:** "Expert" is the user-facing term; "agent" is the technical term for the same object. Code identifiers use `agent`; UI copy may say "Expert."

## D30 — Operation launch uses a preview step
**Status:** Confirmed
**Decision:** When the user selects an Operation, Shera opens a preview showing the Operation purpose, recommended experts, skills, connectors, provider/model, estimated credit usage, approval requirements, and expected outputs. The user may add or remove experts from the same pack, then confirms before any model task or external action starts. The Operation chat and task are created only after confirmation. An advanced setting may later allow immediate start.

## D31 — An Operation chat is a reusable workspace containing multiple independently tracked task runs
**Status:** Confirmed
**Decision:** Distinguish three objects: **Operation definition** (reusable collaboration template), **Operation workspace/chat** (persistent, reusable, supports follow-ups), and **Operation task/run** (one concrete execution).
```text
Research Paper Operation
└── Research Paper workspace chat
    ├── Task: Find sources
    ├── Task: Compare theories
    ├── Task: Draft literature review
    └── Task: Check citations
```
Each run keeps its own task ID, state machine, event stream, approval history, provider snapshot, credit usage, artifacts, and recovery checkpoint. The chat remains available for follow-ups without merging multiple executions into one untraceable task.

## D32 — Three separate lifecycles: persistent Agent identity, warm on-demand Agent session, persistent task worker
**Status:** Confirmed (supersedes D3); historical "expert" wording is superseded by D44
**Decision:**
1. **Persistent expert identity** — always durable: expert profile, direct chat, private memory, settings, capabilities, Operation memberships, task history. Survives process termination, container restart, pack upgrade, and browser closure.
2. **Warm expert session** — a supervised Pi process used for conversation, planning, and coordination. Starts on demand, stays warm while actively used, may hibernate after an idle timeout, is reconstructable from durable state, and is never the sole owner of durable information.
3. **Persistent task worker** — a separately supervised process for actual work. If the task is `RUNNING`, `WAITING_FOR_TOOL`, `WAITING_FOR_AGENT`, `WAITING_FOR_APPROVAL`, `RETRYING`, or `CANCELLING`, its lifecycle is governed by the task, not the chat's idle timer.
**Rules:** a running worker is never stopped by the expert-session idle timeout; closing the browser does not stop the task; the worker sends heartbeats; the gateway supervises the process tree; progress and checkpoints are written to SQLite; the task lease is renewed while the worker is healthy; a stalled worker is detected separately from a slow but healthy worker; resource pressure may pause or queue new work but should not arbitrarily kill healthy running work; cancellation terminates the worker and its descendants; scheduled Operations may wake the required experts and workers automatically.
**Policy:** idle expert with no active task → may hibernate; expert coordinating an active Operation → keep warm when resources permit; healthy long-running task → keep worker alive; worker crash with safe checkpoint → restart and resume; container restart with safe checkpoint → restore and resume; unknown external side effect → pause for review; user cancellation → terminate the complete process tree.
**Recovery:** the task itself stays durable. After restart the runtime finds non-terminal tasks, inspects the last checkpoint and last known side effect, decides whether continuation is safe, resumes safe work automatically, pauses work with an uncertain external effect for review, and shows `RECOVERING`, `RESUMED`, or `RECOVERY_REQUIRED`. A task must not claim exact resume unless the tool and step actually support it.

## D33 — Semantic checkpoints after meaningful steps, lightweight progress events between
**Status:** Confirmed
**Decision:** Checkpoint at safe semantic boundaries (search query completed, document downloaded, source set finalized, analysis artifact saved, code patch applied, test command completed, approval received, external request confirmed), not after every token or on an arbitrary timer.
**Checkpoint fields:** `task_id`, `step_id`, `checkpoint_version`, `completed_actions`, `pending_action`, `artifact_refs`, `provider_usage`, `lease_state`, `approval_state`, `external_effect_state`, `resume_instructions`, `created_at`.
Long-running work continues independently of browser presence; recovery pauses only when an external effect cannot be proven safe to replay.

## D34 — Messages and task runs are separate records; the runtime, not the LLM, decides task creation
**Status:** Confirmed (refined)
**Decision:** Every message is persisted as conversation content; a task run is created only when execution requires lifecycle supervision. Task detection is **entirely outside the agent's reasoning**: the runtime infers it from typed protocol events, never from natural-language classification or an `is_task` field. The agent is not asked to classify messages or carry extra planning burden.
```text
text response only      → conversation turn
tool proposal           → create or attach TaskRun
delegation proposal     → create TaskRun
approval request        → create or attach TaskRun
Operation confirmation  → create TaskRun
scheduled trigger       → create TaskRun
webhook / file event    → create TaskRun
```
**Internal objects:** `Conversation`, `Message`, `Turn` (one response cycle), `TaskRun` (work needing lifecycle supervision), `ToolExecution`, `Checkpoint`, `Artifact`. **Pi emits only:** `message_delta`, `tool_proposed`, `delegation_proposed`, `approval_requested`, `progress`, `artifact_published`, `checkpoint`, `completed`, `failed`, `cancelled`. The gateway handles task creation, state transitions, retries, approvals, credit reservation, leases, event journaling, recovery, and cancellation.

## D35 — Read-only tools automatic; local mutation previewed; grants bypass prompts; "full access" is explicit scoped grants
**Status:** Confirmed (refined)
**Decision:**
```text
Read-only tool                → execute automatically
Local file mutation           → show preview and request approval
Code execution                → show command, working directory, resource policy, approval state
Repository mutation           → show diff/branch/worktree and request approval
External write                → request approval
Destructive/irreversible      → request explicit approval
```
A matching reusable grant (`Always approve this tool`, `... for this expert`, `... in this workspace`, `... for this repository/path`) lets the runtime execute without another prompt, but the grant is still checked deterministically for correct user, expert, workspace, tool version, capability, resource scope, operation/task policy, expiry, revocation, and not-broader-than-requested.
**"Full access" is not a hidden agent mode** — it is a set of explicit capability grants, visible and revocable in settings. The runtime still enforces tenant, container, path, resource, tool-capability, credential, pack, task-state, provider, and credit policy. A prompt cannot override those rules.

## D36 — User controls the Agent roster; General Assistant proposes; runtime validates
**Status:** Confirmed; historical "expert" wording is superseded by D44
**Decision:** The user can change the roster directly. The General Assistant may propose `ExpertInvited`, `ExpertRemovalProposed`, `OperationReplanned`, `SkillRequested`, `ConnectorRequested`; the runtime verifies pack membership, Operation policy, permissions, cost, and connector impact before applying. Low-risk additions from the approved expert pool may be auto-accepted; changes that increase cost, access, or external capability require user approval.

## D37 — Agent-private memory is private by default; publication into Operation context is explicit
**Status:** Confirmed; historical "Expert" wording is superseded by D44
**Decision:**
**Scopes:** Account memory, Workspace memory, Operation memory, Task memory, Expert-private memory.
| Memory type | Visible to |
|---|---|
| Expert-private | That expert only |
| Direct-chat | That expert and the user |
| Operation | User and participating experts |
| Task | Task participants and runtime |
| Workspace | Agents allowed by workspace policy |
| Account | User and explicitly authorized runtime services |
An expert may propose `MemoryCandidateProposed` with `memory_id`, `scope`, `summary`, `source_refs`, `confidence`, `sensitivity`, `expires_at`. Policy: public-to-Operation notes may be shared automatically; private memories cannot be copied automatically; sensitive memories require user approval; credentials and secrets are rejected; source references are preserved; the user can inspect, edit, revoke, or forget memory; provenance is retained; pack upgrades do not silently rewrite existing memory.

## D38 — Strict separation of Skill, Tool, and Connector; effective capability is a layered intersection
**Status:** Confirmed; historical "Expert" wording in this section is superseded by D44
**Decision:**
- **Skill** = instructions and workflow knowledge (instructions, templates, examples, expected outputs, quality checks, recommended tools, compatible expert roles). A skill cannot execute code, access credentials, or grant permission.
- **Tool** = executable capability with a runtime-owned definition: `tool_id`, `version`, `input_schema`, `output_schema`, `capabilities`, `risk_class`, `timeout`, `resource_limits`, `redaction_policy`, `approval_policy`. Experts only propose tool calls; the runtime validates and executes them.
- **Connector** = authenticated integration with an external service: authentication configuration, supported actions, tool bindings, permission scopes, connection status, rate limits, redaction rules, account/workspace visibility. An Operation may recommend a connector but cannot automatically authorize or install one.
A pack references capabilities rather than duplicating implementations.
**Effective capability rule:**
```text
Platform capability
∩ Pack allowance
∩ Agent defaults
∩ Operation assignment
∩ Workspace policy
∩ User grants
∩ Current task requirements
= Effective capability
```
No lower-level configuration may widen an upper-level restriction (for example, an Operation disabling repository writes overrides a user's general write grant inside that Operation).

## D39 — One reusable persistent agent identity with scoped assignments inside each Operation
**Status:** Confirmed from explicit user answer; incomplete original acknowledgement
**Evidence:** The user answered `for the prototype yes` to the original Q39. The Codex assistant's acknowledgement was not produced because the run terminated with `HTTP 402 Payment Required: Budget pool quota has been exhausted` (AgentRouter) immediately afterward. The exact question, answer, timestamp, raw rollout, and recovery transcript are preserved in [`../history/2026-09-08-to-2026-09-11/codex-transcript.md`](../history/2026-09-08-to-2026-09-11/codex-transcript.md).
**Decision:** For the prototype, the same Agent appearing in multiple Operations has one persistent identity across all Operations. One Agent profile, one direct chat, one private memory, and one settings surface. Each Operation gives that Agent a scoped assignment.
**Rules:** separate Operation context and task history; private memory is not automatically published into Operations (D37); Operation-specific instructions do not permanently rewrite the Agent profile; Operation tasks pin the Agent and Operation versions used for that task.
**Reconfirmation trigger:** Reopen this decision if the prototype changes the Agent identity model, pack boundary, or private-memory semantics.
