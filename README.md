# Shera Bot

Shera Bot is a private prototype of a multi-agent AI assistant platform. It runs for at most five users on one VM. Its job is to validate the end-to-end product experience and the runtime architecture; the evidence it produces decides whether the larger platform gets built.

A versioned **Pack** holds specialized **Agents** that work in **Operations**. The user talks to them in a Telegram-like web client. Agents propose; the runtime validates and executes every action. Risky work pauses for a scoped, expiring, revocable approval. User data lives local-first inside an isolated per-user container; the central service stores only control-plane records.

> [!NOTE]
> This is private testing software, not a production deployment. It makes no guarantee about the correctness of agent outputs.

## The product model

The canonical hierarchy:

```text
Pack → Operations → Agents
```

- A **Pack** is a versioned catalog of Operations, Agents, skills, connectors, and defaults. A workspace pins one Pack version. The prototype ships `agent-packs/student/v1`.
- An **Operation** is a reusable collaborative chat with a purpose, a roster, and its own task runs. The student pack defines three: Research Paper, Programming Assignment, and Exam Preparation. Users can also open ad hoc Operations.
- An **Agent** is a durable identity: one profile, one direct chat, one private memory, one settings surface. The student pack defines six: General Assistant, Researcher, Developer, Citation Manager, Programming Tutor, and Study Planner. Each Agent is rostered in exactly one Operation; cross-Operation work runs through subagent triggering (D46).

Three rules shape everything else:

1. **Agents propose; the runtime decides.** No surface shows an agent action as done before the runtime validates it.
2. **Approvals are runtime objects.** Risky actions offer five fixed choices. A prompt cannot create a grant; grants are checked, scoped, and revocable.
3. **Events are honest.** Live, replayed, delayed, and disconnected events are visually distinct (D26). Durable history comes from an append-only event journal, so a refresh or reconnect shows the real past.

Providers, credits, and resource tiers round out the model. Built-in and custom providers are planned; the credit ledger is internal accounting with reservation and settlement; tiers are simulated. There are no real payments.

## Architecture

pnpm and Turborepo monorepo. All TypeScript, ESM.

| Path | Purpose |
| --- | --- |
| `apps/web` | Next.js client: login, direct Agent chats, Operations, settings. Dark-only theme. |
| `apps/control-plane` | Express API: Google OAuth, five-account signup cap, sessions, PostgreSQL. Provisions one runtime container per user and proxies browser traffic to it. |
| `apps/user-runtime` | The runtime gateway, one per user, inside a container. Owns state changes, the event journal, approvals, leases, and supervised agent sessions and task workers. |
| `packages/contracts` | Zod schemas. The source of truth for every API shape. |
| `packages/agent-pack-sdk` | Pack manifest schema, loader, and SHA-256 integrity checks. |
| `packages/clients` | API clients generated from the contracts (`pnpm gen:clients`). |
| `packages/pi-protocol`, `packages/provider-contracts`, `packages/observability` | Reserved packages. Still empty; later slices fill them. |
| `packages/test-kit` | Shared test helpers. |
| `agent-packs/` | Versioned pack content. `student/v1` is the pinned pack. |
| `tests/` | Cross-cutting tiers: contract, integration, e2e, recovery, security, benchmark. |
| `spikes/` | Preserved spike evidence. Kept, never deleted. |
| `infra/` | Deployment. Arrives with a later slice. |
| `mockup/` | Static HTML/JS mockup of the client, with its own regression suite. It is not the product. |
| `docs/` | PRD, decision records, glossary, traceability, build plan, handoffs. |

### Where data lives

- **Central PostgreSQL** holds control-plane records only: accounts, OAuth identities, sessions, container mappings, backups, security events.
- **Container-local SQLite** (WAL mode) holds product state: conversations, task runs, approvals, events, memories, schedules, tool inventory, checkpoints.

Conversations, files, memories, and provider keys stay inside the user's container. The control plane never mirrors them.

## Running locally

Pinned toolchain: Node 24.19.0 (`.nvmrc`) and pnpm 12.4.1 (`packageManager`). `engines` enforces both.

```bash
pnpm install --frozen-lockfile
```

Copy `apps/control-plane/.env.example` and `apps/web/.env.example`, then fill the values. `SHERA_WEB_ORIGIN` must match on both apps. Generate `AUTH_SECRET` with `openssl rand -hex 32`. For a local run without a pinned origin, set `AUTH_TRUST_HOST=true`.

Local ports: web on 3000, control plane on 3001, the runtime gateway on 8080 inside its container. The web client expects the control plane at `127.0.0.1:3001`, so start it with `PORT=3001`.

```bash
cd apps/control-plane && pnpm db:migrate && PORT=3001 pnpm start   # identity + provisioning
cd apps/web && pnpm dev                                            # the client
```

The control plane creates runtime containers through Docker (image `shera-user-runtime:dev`) on an internal-only network with no published ports. The image build and the full container lifecycle are unvalidated work; no Dockerfile or compose file is committed yet.

### Checks

```bash
pnpm lint               # eslint, one flat config at the root
pnpm format:check       # prettier
pnpm typecheck          # tsc across the workspace (turbo)
pnpm test               # vitest: all tiers, plus co-located tests
pnpm build              # turbo (apps/web: next build)
pnpm boundary-guards    # architecture boundary checks
pnpm license:inventory  # dependency + license gate
pnpm mockup:test        # the mockup's regression suite
```

Integration tests start a real PostgreSQL cluster. Point `SHERA_PG_BIN` at local PostgreSQL 16 binaries first. Live-provider tests are opt-in and never run by default (G7).

The S15 record (E28) pins the full suite at 1210 tests in 98 files, with boundary guards, typecheck, and build green. The latest CI runs on `main` pass the same pipeline.

## Current status

Design is complete. The PRD carries decisions D1–D51 and acceptance criteria 1–27. Implementation follows a 35-slice build plan (GitHub issues #2–#36) with guardrails G1–G8 as acceptance criteria.

Landed (S01–S16): monorepo scaffold, contracts, control plane with auth, container provisioning, the runtime gateway, the web shell, the end-to-end thin slice, the pack loader, agent identity with private-folder isolation, on-demand agent sessions, Operation chats, ad-hoc Operations, the launch preview gate, and task-worker supervision. S17–S35 are open; the live list is in [`docs/BUILD_MAP.md`](docs/BUILD_MAP.md).

Not yet validated against real services: Google OAuth sign-in, the Docker lifecycle, and live model providers. [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md) keeps the standing list with evidence.

## Documentation

Read in this order before changing architecture or product behavior:

1. [`AGENTS.md`](AGENTS.md): mandatory loading rules and non-negotiables for agents working in this repo.
2. [`docs/README.md`](docs/README.md): documentation index.
3. [`docs/PRD.md`](docs/PRD.md): the synchronized product baseline.
4. [`docs/decisions/README.md`](docs/decisions/README.md): decision index.
5. [`docs/GLOSSARY.md`](docs/GLOSSARY.md): canonical vocabulary.
6. [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md): acceptance coverage and open items.

## Vocabulary

> [!IMPORTANT]
> The canonical terms are **Agent** and **Operation**. `Expert` and `Scene` are historical aliases from old transcripts and decision records. Do not use them in new code, schemas, UI, or docs.
