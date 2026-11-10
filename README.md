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

The control plane creates runtime containers through Docker (image `shera-user-runtime:dev`) on an internal-only network with no published ports. The image is built from [`infra/deploy/Dockerfile.user-runtime`](infra/deploy/Dockerfile.user-runtime); the one-VM production stack (compose, Caddy, backup, monitor, smoke gate) lives in [`infra/deploy/`](infra/deploy/) with its operator path in [`docs/s35-deploy-runbook.md`](docs/s35-deploy-runbook.md). On a host without Docker the web + control-plane pair still boots (that is how the S35 smoke HTTP legs were verified); the per-account runtime containers are the piece that needs an engine.

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

Integration tests start a real PostgreSQL cluster. Point `SHERA_PG_BIN` at local PostgreSQL 16 binaries first (on Ubuntu: `SHERA_PG_BIN=/usr/lib/postgresql/16/bin`). Live-provider tests are opt-in and never run by default (G7).

The E48 record pins the full suite at 2533 tests in 236 files, with boundary guards, typecheck, and build green. The acceptance gate is separate:

```bash
pnpm exec playwright install          # once: chromium, firefox, webkit binaries
pnpm acceptance                       # the 27-row browser + HTTP matrix (reports to tests/acceptance/evidence/)
```

## Current status

The 35-slice build plan is COMPLETE (S01–S35, all merged; the map and the per-slice evidence pointers live in [`docs/BUILD_MAP.md`](docs/BUILD_MAP.md)). Final verification 2026-11-10: full suite 2533/2533 green, acceptance GREEN on main.

What remains is operational, not construction: the owner's acceptance verdicts (the S34 ledger), the live VM deployment per [`docs/s35-deploy-runbook.md`](docs/s35-deploy-runbook.md), the host-side verification of issues [#83](https://github.com/ihmorol/shera-bot/issues/83)/[#84](https://github.com/ihmorol/shera-bot/issues/84) on the deployment host, and the CI environment fix ([#78](https://github.com/ihmorol/shera-bot/issues/78)). Not yet validated against real services: Google OAuth sign-in and live model providers — [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md) keeps the standing list with evidence.

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
