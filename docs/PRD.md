# Shera Bot Prototype Product Requirements Document

**Status:** Approved prototype specification  
**Date:** 2026-09-08  
**Scope:** Private prototype for validating a multi-agent, Grok Bot-inspired assistant

## 1. Product definition

Shera Bot is an independent, general-purpose AI assistant platform inspired by existing products such as Grok Bot. It provides three specialized AI agents, persistent user workspaces, tool use, autonomous tasks, multi-agent collaboration, provider/model choice, and transparent execution through a Telegram-like web interface.

The product uses its own name, branding, UI, prompts, system behavior, and implementation. It must not copy Grok or xAI trademarks, proprietary code, private infrastructure, protected assets, or internal architecture. Open-source components are used only under their applicable licenses.

The prototype validates the end-to-end experience and runtime architecture before expanding the platform. It is private testing software, not a production-scale launch.

## 2. Goals and non-goals

### 2.1 Goals

1. Validate a Telegram-like dashboard for persistent agent chats.
2. Validate three independent Pi-based agents with distinct roles and private identities.
3. Validate expandable workspaces with files, terminal, browser, task activity, and tool results.
4. Validate user-triggered and autonomous agent work.
5. Validate multi-agent delegation and transparent group chats.
6. Validate user-selected AI providers, models, and custom OpenAI-compatible endpoints.
7. Validate local-first user data storage inside isolated user containers.
8. Validate dynamic approval for risky actions.
9. Validate restart recovery, backups, and container portability.
10. Produce evidence for deciding whether to build the larger platform.

### 2.2 Explicit prototype non-goals

- More than five users.
- More than one cloud VM.
- Native mobile apps or PWA packaging.
- Real billing or subscriptions.
- X/social search.
- Full desktop takeover or user browser/terminal control.
- Model training, fine-tuning, or weight modification.
- Multi-region deployment or production high availability.
- Enterprise organizations, team administration, or full audit UI.
- Guaranteed correctness of agent outputs.
- Unrestricted autonomous external actions.
- User data export or permanent data purge.
- Public tool marketplace.
- Provider guarantees beyond configured APIs.

## 3. Users, access, and tiers

### 3.1 Audience priority

1. Researchers.
2. Individual developers.
3. Students.

The product remains general-purpose and supports any research discipline.

### 3.2 Authentication and access

- Google OAuth is the only login method.
- Open signup is allowed until five accounts are registered.
- Signup is refused after the five-account cap.
- Administrator status is a manually managed database flag.
- No real payments are processed.
- Light, Balanced, and Heavy tiers are simulated and may be assigned by a user or administrator.
- Balanced is the development and prototype default.

### 3.3 Resource tiers

| Tier | CPU | RAM | Storage |
|---|---:|---:|---:|
| Light | 1 vCPU | 2 GB | 10 GB |
| Balanced | 2 vCPU | 4 GB | 25 GB |
| Heavy | 4 vCPU | 8 GB | 50 GB |

## 4. User experience

### 4.1 Dashboard

After login, the user lands on a simple Telegram-like dashboard with a sidebar. The sidebar contains persistent Researcher, Developer, and General Assistant chats, user-created task chats, and automatically created group chats. It shows unread, running, approval-required, failed, and completed states.

The user can message an agent directly, create a task-specific chat, create a group chat, or follow an agent-created group chat after delegation.

### 4.2 Chat types

**Agent chat:** persistent conversation with one fixed-role agent. It has access to that agent's private profile folder, the shared workspace, and relevant shared task/system information.

**Task-specific chat:** user-defined task conversation that may involve one or more agents. At completion the user may keep, archive, or delete it. Kept chats auto-archive after seven days. Deleted chats are soft-deleted and retained indefinitely.

**Multi-agent group chat:** created by the user or an agent. It includes the user, orchestrator, and participating agents. The orchestrator may add or remove agents as the task evolves. The user may message the group or address any individual agent directly. Agent messages, progress, tool activity, approvals, and results are visible.

After a group task completes, the user is notified and the group chat is archived as read-only. It cannot be continued directly.

### 4.3 Workspace

Chat is the default view. Each chat has an expandable workspace panel, similar to an agent harness, and the workspace can open as a separate full-page view.

The prototype workspace includes a file/folder browser, file editor, terminal panel, interactive browser panel, task/progress panel, tool-call history/results, shared files, and private agent files.

The user receives a live shared read-only view of browser and terminal activity. Direct takeover is future work. The UI must prevent conflicting simultaneous control.

## 5. Agents

All agents run as separate Pi processes in one user container. Each has a fixed role with editable user instructions, a private profile folder, private memory, role defaults, and access to the shared workspace and shared task context.

### 5.1 Researcher

The Researcher investigates questions and produces evidence-backed outputs. It searches and reads public web sources, compares authority and recency, extracts claims and quotations, reads uploaded PDFs/documents/spreadsheets/images, creates literature reviews and reports, manages citations and source indexes, monitors configured sources, and delegates coding/data work to Developer or synthesis work to General Assistant.

Default tools include web search/page fetch, interactive browser, document/PDF parsing, image understanding, spreadsheet/data analysis, file tools, notes, report generation, schedules, event monitoring, and delegation.

It may read shared files, write research notes/reports/artifacts, and read/write its private folder. Destructive and external-write actions require approval. Outputs include citations, evidence tables, reports, confidence statements, and unresolved questions. Its identity is evidence-driven and explicit about uncertainty.

### 5.2 Developer

The Developer inspects repositories, creates and modifies code, runs tests/linters/type checks/builds, diagnoses regressions, creates scripts and integrations, runs technical experiments, operates browsers and terminals, manages branches/worktrees/commits/patches, generates documentation, monitors repositories/files/builds/webhooks, and creates reusable tools.

Default tools include file browser/editor, terminal, sandboxed code execution, Git, browser automation, web search, document/PDF parsing, spreadsheet/data analysis, image understanding, artifact generation, schedules, event monitoring, and delegation.

It may read/write assigned project workspaces and its private folder, run non-destructive commands automatically, and execute code inside the user container. Repository mutation, deletion, package installation, deployment, and external writes require approval.

Coding work uses an agent-specific branch and separate worktree. Related conflicting work is queued until the earlier change finishes. The main orchestrator prepares merges and asks the user before final merge.

### 5.3 General Assistant

The General Assistant handles general questions, planning, coordination, user-facing synthesis, memory, task creation, and group orchestration. It clarifies goals, chooses whether one or multiple agents are needed, delegates to Researcher and Developer, combines results, writes and formats content, manages notes/checklists/documents, tracks approvals, and produces final answers/artifacts.

Default tools include orchestration, shared files, web search/browser, document/PDF tools, image understanding, spreadsheet/data analysis, artifacts, schedules, monitoring, delegation, and tool inventory.

It may read shared files, read/write its private folder, create plans/notes/artifacts, coordinate tasks, and read agent results. It may not silently modify another agent's private files. Destructive and external-write actions require approval. It is transparent about delegated work.

## 6. Runtime and tenancy

Each user receives one isolated container acting as that user's cloud computer. It contains three Pi processes, one shared workspace, three private profile folders, shared task/group/system information, user-local provider and repository credentials, one shared browser profile, and persistent task/memory/artifact/tool state.

All three agents may work independently or collaborate on one task. Full parallelism is allowed subject to CPU, memory, process, and storage limits. When resources are exhausted, running work continues and new jobs queue.

### 6.1 Deployment

Local development uses Docker Compose. The real prototype uses one Ubuntu 24.04 cloud VM running Docker Compose with the web app, Express control-plane API, PostgreSQL, Redis, reverse proxy, backup service, and up to five user containers.

The runtime API is provider-neutral and portable so a user container can later move to its own VM. Product behavior must not depend on Docker-specific paths or APIs.

## 7. Tools and agent-created tools

Prototype-functional tools are web search/page reading, interactive browser, file upload/read/write/edit/share, terminal, sandboxed code execution, PDF/document parsing, spreadsheet/data analysis, image understanding, Git clone/import/branches/worktrees/validation/merge preparation, artifact generation, delegation/group orchestration, schedules, file-change monitoring, memory, tool inventory, and dynamic approvals.

Minimal external API tools have a name, base URL, HTTP method, path, headers/body template, and credential reference. Read requests run automatically. Writes/deletes require approval. Calls have timeouts and response-size limits, appear in redacted history, and can be disabled.

Agents may create and activate non-destructive tools automatically. Risky tools require approval. The creating agent selects private or shared inventory scope. Tools run in the same user container in the prototype. Each tool exposes its name, purpose, owner, scope, permissions, and version.

Future integrations include broad webhook/event builders, advanced external connectors, specialized parsers/artifact formats, advanced tool signing/sandboxing/distribution, native clients, full desktop takeover, and additional Pi integrations.

## 8. Autonomy, tasks, and approvals

Agents support user-triggered and autonomous work. Autonomous triggers include schedules, shared-file changes, private-folder changes, Git changes, incoming webhooks, completion of another agent's task, agent-evaluated conditions, and external service events.

Read-only and non-destructive actions may run automatically. Risky actions include destructive file operations, repository mutation, external writes/deletes, messages, deployments, purchases, and similar side effects. Risky actions pause for approval by default.

Approval choices are: **Approve this execution only**, **Always approve this tool**, **Always approve this tool for this agent**, **Reject this action**, and **Cancel the task**. Permissions are reviewable and revocable in settings.

Approval requests wait indefinitely. Reminders occur immediately, at 15 minutes, at 45 minutes, at 3 hours, and at 24 hours. No reminders occur after 24 hours. Turning reminders off stops notifications only; the task stays paused until approval or rejection.

Tasks retry transient failures with bounded backoff up to three times, then pause and notify. Immediate cancellation stops parent, child, and queued work while preserving logs and partial files.

## 9. Providers and models

Supported providers are native OpenAI, Anthropic, and Google adapters; Ollama/local models; generic OpenAI-compatible endpoints; and user-defined custom providers.

Custom provider fields are display name, protocol type, base URL, API key or no-key mode, model identifier, optional organization/project, optional headers, optional request parameters, connection test, enable/disable, and per-agent/per-conversation assignment.

Each agent has a default provider/model. Users may override the provider/model per conversation. Provider keys are local-first inside the user container, runtime-injected, masked, revocable, and never written to prompts, chat history, memory, tool history, logs, shared files, or tool inventory. The central service does not persist provider keys.

## 10. Projects and Git

Users may upload/import project archives or clone repositories from Git URLs. Private repository credentials are provided per repository, stored locally inside the user container, and scoped to that repository.

There is no artificial project-count limit. Capacity is limited by the user container. Projects are shared by default, with optional restriction to selected agents.

Coding agents use separate branches and worktrees. Non-coding agents publish notes, research, reports, and artifacts through the shared task area. Related conflicting work is queued rather than concurrently merged.

The orchestrator prepares merge requests and runs available validation. The minimal merge approval view shows only the change summary, changed files, validation status, conflict status, and target branch. The user may approve, reject, or request changes. The orchestrator never silently merges into the main branch.

## 11. Memory and learning

Runtime learning only is supported. Models are not fine-tuned and weights are not modified.

There is one shared user/workspace memory and one private memory per agent. Agents automatically update memory from conversations, tasks, files, outcomes, and corrections. Users may view, edit, update, delete, permanently forget, disable automatic memory globally or per agent, inspect sources, and restore earlier versions.

Passwords, API keys, tokens, payment data, and similar secrets must never be saved to memory.

## 12. Data, privacy, storage, and backups

Conversations, files, projects/worktrees, memories, browser state, tasks, group chats, tool inventory, provider keys, repository credentials, and artifacts remain inside the user container. The central service stores only account identity, Google OAuth identity, container mapping, and minimal operational metadata.

Warn when storage exceeds 80%. Never automatically delete user files. At 100%, block actions that create or expand data while preserving chat, reading, deletion, export, and cleanup.

Snapshot each user persistent volume every six hours and retain the latest seven snapshots. Administrators may trigger restore. User data export is future work.

## 13. Restart and recovery

Persistent volumes remount automatically. All Pi processes restart. Queued tasks resume from durable state. Interrupted tasks resume from a safe checkpoint or pause for review. Group-chat history and membership restore. Schedules and event watchers restart without duplication. Pending approvals remain pending. Browser profile/cookies restore. Potentially duplicated external effects are not blindly replayed. The dashboard shows recovery status. If safe recovery cannot be proven, the task pauses and notifies.

## 14. Real-time transport and notifications

WebSockets handle chat streaming, agent/group messages, progress, tool activity, approvals, notifications, browser/terminal events, and recovery status. HTTP handles Google OAuth, settings, providers, files, projects, task commands, history, and administration.

Notifications are live updates in the open workspace, in-app completion/failure/approval notifications, and browser notifications when the tab is open but unfocused. Users can enable/disable browser and in-app notifications, mute one approval, one task, or all approval reminders. Pending approvals stay visible when reminders are muted.

Tasks continue after browser closure. Reconnect reloads durable history and replays missed events from the last acknowledged cursor. Multiple tabs synchronize. Commands are idempotent. Approval decisions propagate across tabs. The UI identifies live, replayed, delayed, and disconnected events.

## 15. Admin console

The manually flagged administrator can list users, enable/disable accounts, assign tiers, provision/restart/stop containers, view container status and resource usage, trigger backups and restore one of seven snapshots, emergency-cancel all tasks for one user, and view recent container/task failures.

Security-relevant actions are logged internally even without a full audit UI.

## 16. Network and security

User containers may access the public internet for research and approved services, but have no inbound public access. The control plane communicates with containers through an authenticated internal runtime channel. Containers cannot access other users' containers, volumes, processes, or credentials. Agents cannot access host Docker sockets or host filesystem paths. Localhost services are scoped to the user container.

Network actions are classified as read-only or external-write. External writes and risky actions require approval. Provider keys, Git credentials, and browser cookies never appear in prompts, logs, memory, messages, or tool inventory. All logs redact sensitive values.

## 17. Technology stack

- Next.js, React, TypeScript, and Tailwind CSS for the web application.
- Express.js with TypeScript for the control-plane API.
- PostgreSQL for central metadata, durable task routing, and operational state.
- Redis for transient queues, pub/sub, and live-event support.
- WebSockets plus HTTP.
- Docker Compose locally and on the single cloud VM.
- pnpm/Turborepo TypeScript monorepo.
- Zod shared schemas.
- TypeScript adapter around the product-maintained Pi fork.

Low-level library versions, exact cloud provider, database table names, module boundaries, and visual details remain engineering/design decisions.

## 18. Quality baseline

The prototype must work on current Chrome, Edge, Firefox, and Safari; support responsive layouts from approximately 360px mobile width through large desktop; provide keyboard-accessible core flows, visible focus states, meaningful labels, loading/empty/error/disconnected states, automatic reconnect, missed-event replay, bounded payloads, redacted errors, idempotent commands, pagination/virtualization for long lists, health checks, and clear degradation when providers/tools are unavailable.

Normal command acknowledgement target is approximately 500ms under normal local/cloud conditions. No formal WCAG certification, multi-region SLA, production high availability, or full load-testing program is required for prototype acceptance.

## 19. Prototype acceptance criteria

1. Google OAuth login works and the five-account cap is enforced.
2. A Balanced-tier user container is provisioned.
3. Three agent chats are available.
4. Each agent runs as a separate Pi process with its own private profile folder.
5. User-created task chats work.
6. Agents can create group chats and delegate work.
7. Live agent messages, progress, tool calls, approvals, and results are visible.
8. Prototype-functional tools work end-to-end.
9. Agents can create reusable private/shared tools under the approval policy.
10. Built-in, local, OpenAI-compatible, and custom providers can be configured and tested.
11. Per-agent defaults and per-conversation provider overrides work.
12. At least one autonomous scheduled or event-triggered task completes.
13. Risky actions pause and display the defined approval choices and reminder sequence.
14. Transient failures retry no more than three times before pausing and notifying.
15. Immediate cancellation stops parent, child, and queued work while preserving partial outputs.
16. Shared/private files, chats, tasks, memories, browser state, and tools persist across restart.
17. A coding task uses a separate branch/worktree and asks approval before merge.
18. Automatic backups run and an administrator restores one snapshot.
19. Restart recovery restores processes, state, schedules, browser profile, and approvals safely.
20. Desktop and mobile web layouts work on target browsers.
21. No critical cross-user isolation or credential-leak failure is observed.

## 20. Future work register

- Native iOS/Android app and installable PWA enhancements.
- Full browser/desktop takeover.
- X/social search, social feeds, voice, image generation, video generation, and richer multimodal workflows.
- Production billing, subscriptions, usage metering, and cost controls.
- User/admin data export, permanent purge, and configurable retention.
- Enterprise organizations, teams, roles, and audit interface.
- Multi-region deployment, high availability, autoscaling, and per-user VM orchestration.
- Managed production secrets service.
- Advanced connector/OAuth framework and webhook/event-condition builder.
- Tool review, signing, sandboxing, marketplace, and distribution.
- Model routing, fallback, quotas, and scale cost optimization.
- Distributed tracing, external error monitoring, formal load testing, and performance budgets.
- Cross-device synchronization for local-first data.
- Cloud-provider migration automation.

## 21. Visual/design TODO register

1. Product name, logo, typography, colors, and brand voice.
2. Dashboard information architecture and sidebar details.
3. Desktop/mobile wireframes and breakpoints.
4. Agent identity, avatar, status, and chat-header treatment.
5. Group-chat member display and agent attribution.
6. Message, tool-call, progress, error, approval, and artifact components.
7. Expandable workspace panel sizing and full-page transition.
8. File browser, editor, terminal, browser, task, and tool-history layouts.
9. Live browser/terminal visualization.
10. Approval dialog wording and hierarchy.
11. Notification center, badges, and muted-state treatment.
12. Provider/model settings screens.
13. Memory-management screens.
14. Tool inventory and permission screens.
15. Project import, Git clone, worktree, and merge-review screens.
16. Admin console layouts.
17. Loading, empty, offline, reconnecting, queued, paused, failed, and recovered states.
18. Keyboard and screen-reader interaction design.
19. Design tokens and visual regression test plan.

## 22. Engineering TODO register

1. Confirm Pi fork license, dependency licenses, and upstream-sync process.
2. Define Pi adapter and process-supervisor contracts.
3. Define shared/private filesystem layout and persistence format.
4. Define Docker-independent runtime API.
5. Select exact cloud provider and Ubuntu image process.
6. Define PostgreSQL schema, migrations, and retention markers.
7. Define Redis queue, pub/sub, replay, and idempotency semantics.
8. Define WebSocket event envelope, cursors, and authorization.
9. Define provider adapter interface and custom-provider validation.
10. Define sandboxing for terminal, code, and agent-created tools.
11. Define browser service and shared Chromium profile lifecycle.
12. Define schedules, file watchers, webhooks, event de-duplication, and recovery.
13. Define approval policy schema, reminder scheduler, and revocation.
14. Define Git worktree allocation, conflict queue, validation runner, and merge coordinator.
15. Define memory schema, provenance, versioning, secret filters, and restore.
16. Define backup format, scheduler, restore process, and integrity checks.
17. Define resource monitoring and queue admission.
18. Define redaction rules and security logging.
19. Build threat model and container-escape test plan.
20. Automate acceptance tests in Section 19.
21. Create manual QA scenarios for chat, groups, approvals, recovery, and mobile layout.
22. Add license inventory generation to CI.
23. Add deployment and disaster-recovery runbooks.

## 23. Open-source and legal compliance

The project follows strict compliance. It preserves every dependency's license, copyright notices, attribution, and source/disclosure obligations; maintains a dependency/license inventory; reviews Pi fork obligations and modifications; and does not present open-source work as proprietary. Product branding and behavior remain independent from Grok/xAI.

## 24. Decision boundary

This document is implementation-ready for the private prototype. Engineering may choose low-level libraries, exact versions, cloud provider, table names, module boundaries, and visual details without reopening product decisions. Changes to user-visible scope, data ownership, approval safety, tenancy, agent roles, persistence, or acceptance criteria require an explicit product decision and an update to this document.
