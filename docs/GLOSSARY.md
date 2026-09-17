# Shera Bot — Canonical Glossary

**Status:** Authoritative vocabulary for new documentation and implementation.  
**Last updated:** 2026-09-17 (D46–D50, E9–E14)  
**Decision source:** D29–D50 in [`decisions/`](decisions/) — [`confirmed-decisions.md`](decisions/confirmed-decisions.md), [`closure-decisions.md`](decisions/closure-decisions.md), [`open-items-decisions-2026-09-17.md`](decisions/open-items-decisions-2026-09-17.md).

## Naming rule

Use **Agent** everywhere: UI, product copy, code identifiers, schemas, database columns, pack manifests, and tests. The earlier session used **Expert** in decisions D29–D43; that is historical wording only and is a one-to-one alias for Agent. Do not introduce a separate Expert concept.

The canonical hierarchy is:

```text
Pack → Operations → Agents
```

## Core product objects

### Pack
An audience-specific, versioned catalog of Operations, Agents, Agent Teams, Skills, Connectors, defaults, onboarding, and UI metadata. A workspace pins one Pack version. A Pack is configuration and data, not unrestricted executable code.

### Agent
A specialized, reusable AI identity with a profile, direct chat, private memory, settings, capabilities, one scoped Operation assignment, and task history. An Agent is a logical durable identity; its Pi session process is on-demand. An Agent can trigger multiple **subagents** within its Operation. In code, use identifiers such as `agent_id`, `agent_profile`, and `agent_roster`.

### Subagent
The owner's term (2026-09-17, D46) for a subordinate agent execution triggered by an Agent within its Operation; multiple subagents may be triggered by the same Agent. It is not a separate object type. Delegated work becomes independently tracked task runs (D31/D34) executed in supervised task workers (D32). Exact semantics — same-identity worker instances versus other same-Pack Agents invoked as subordinates, concurrency limits, and memory-scope boundaries — remain an open item in [`TRACEABILITY.md`](TRACEABILITY.md).

### Agent Team
A predefined recommended roster of Agents for an Operation. It is not a separate process architecture. Active Agents still run through the shared runtime gateway, task state machine, approval policy, and Pi adapter.

### Operation definition
A versioned, reusable task-oriented collaboration template in a Pack. It declares purpose, recommended/allowed Agents, skills, connectors, outputs, collaboration rules, coordinator policy, and default approval behavior.

### Operation workspace/chat
A persistent user-visible collaborative chat created from an Operation definition or created ad hoc. It contains the user, selected Agents, shared Operation context, and multiple independently tracked task runs. It remains available for follow-up work.

### Operation task/run
One concrete execution inside an Operation workspace/chat. It has its own task ID, state machine, events, approvals, provider snapshot, credit usage, artifacts, leases, and recovery checkpoint. The run, not the chat, is the lifecycle boundary.

### Workspace
The user's durable product scope. In the prototype there is one workspace per user and the user container is that workspace. The UI has no workspace switcher, but records are scoped by `workspace_id` so multiple workspaces can be added later without a migration.

### User container
The prototype isolation and execution boundary for one user. It contains the local SQLite database, workspace files/projects, browser state, secrets, Agent-private folders, runtime gateway, on-demand Agent sessions, and task workers. It is an infrastructure boundary, not a substitute for every domain object.

### Task run
A supervised unit of work that requires lifecycle handling. Normal conversation messages and turns do not automatically become task runs. The runtime creates a task run from typed behavior such as a tool proposal, delegation, approval request, Operation confirmation, schedule, webhook, or file event.

### Turn
One response cycle in a Conversation. A turn can remain conversational or cause the runtime to create/attach a TaskRun when typed execution behavior appears.

### Conversation
Durable messages and turns in a direct Agent chat or Operation workspace/chat. Conversation history is distinct from task lifecycle state.

## Capability layers

### Skill
Reusable knowledge and workflow instructions: prompts, templates, examples, expected outputs, quality checks, recommended tools, and compatible Agent roles. A Skill cannot execute code, access credentials, or grant permission.

### Tool
A runtime-owned executable capability. A Tool has a version, input/output schemas, capabilities, risk class, timeout, resource limits, redaction policy, and approval policy. Agents propose Tool calls; the runtime validates and executes them.

### Connector
An authenticated integration with an external service. A Connector owns authentication configuration, supported actions, tool bindings, permission scopes, connection status, rate limits, redaction rules, and account/workspace visibility. A Pack or Operation may recommend a Connector but cannot authorize or install it by configuration alone.

### Effective capability
The capability actually available to an Agent for one task:

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

A lower layer cannot widen an upper-layer restriction.

## Runtime and storage

### Runtime gateway
The one supervised local authority inside a user container. It owns authoritative task transitions, SQLite writes, event sequencing, approvals, leases, child-process supervision, scheduling, recovery, and the local HTTP/WebSocket API.

### Agent session
A warm, supervised Pi process used for conversation, planning, and coordination. It starts on demand, may hibernate after idle time, and is reconstructed from durable state. It never owns the only copy of durable data.

### Task worker
A separately supervised process for actual work. Its lifecycle follows the task state, not the Agent-session idle timer. Healthy long-running work survives browser closure; cancellation terminates the whole process tree.

### Central PostgreSQL
The control-plane database. It stores account/OAuth identity, signup and administrator state, user-to-container mapping, provisioning/health/resource summaries, runtime endpoint metadata, backup/restore metadata, and required security/administrative events. It does not mirror user conversations, files, memories, provider keys, or local task internals in the prototype.

### Container-local SQLite
The product-state database inside each user container. It stores conversations, tasks, approvals, events/cursors, memories, schedules/watchers, tool inventory, provider metadata, checkpoints, Git/worktree state, and usage history. It uses WAL mode, migrations, foreign keys, bounded lock retries, and repository interfaces.

### Credits
An internal prototype accounting unit for platform-provider model usage. Requests reserve an estimate, settle against actual usage, and release unused reservation. Credits are not real billing, subscriptions, or authorization to use tools or perform side effects. Custom-provider requests do not consume Shera credits but are measured locally.

### Billing/metering
Production commercial accounting and subscription/usage infrastructure. It is explicitly future work and must not be conflated with the prototype's internal credit ledger.

## Safety and evidence terms

### Approval grant
A scoped, expiring, revocable runtime permission. Grants are checked deterministically for user, Agent, workspace, Operation/task, tool version, capability, resource scope, expiry, and revocation. A prompt cannot create a grant.

### Semantic checkpoint
A durable recovery point after a meaningful step such as a completed search, downloaded document, saved artifact, applied patch, completed test, received approval, or confirmed external request.

### Event journal
An append-only durable record of lifecycle-significant and user-visible events. Current-state projections serve fast reads; replay cursors support reconnect and recovery.

### Historical alias
A term retained inside old transcripts or decision text for provenance but not valid for new normative work. Current aliases: `Expert` → `Agent`; `Scene` → `Operation`; old task-specific chat → task run inside a direct Agent chat or Operation.
