#!/usr/bin/env bash
# Appends an "Open-source leverage (recorded 2026-09-18)" section to each slice issue.
# Idempotent: issues already containing the marker are skipped.
set -euo pipefail
REPO=ihmorol/shera-bot
TMP=$(mktemp -d)
SECDIR="$TMP/sec"
mkdir -p "$SECDIR"

write() { cat > "$SECDIR/$1.md"; }

write 1 <<'EOF'
## Open-source leverage policy (recorded 2026-09-18)

Every slice issue now carries an "Open-source leverage" section naming exactly what to embed, which docs to read first, and where to look. Standing rules for all slices:

- **Embed** only permissively-licensed dependencies (MIT / Apache-2.0 / BSD / ISC) that fit the PRD §17 stack (TypeScript monorepo, Drizzle, Redis, Docker). The S01 license-inventory CI gate enforces this.
- **Pattern-only** for AGPL/GPL projects (Coder; SearXNG is allowed as an unmodified external container, no code linking) and out-of-stack projects (Dify, Coze Studio, Suna, AutoGPT Platform, Temporal server). Copy semantics and vocabulary, never code or branding.
- **Never adopt agent frameworks as the runtime** (LangGraph, CrewAI, AutoGen) — G2: agents propose, the runtime gateway validates and executes; task runs are created only from typed protocol behavior.
- **Read the linked docs first — do not discover by exploration.** When a mechanism already has an established name (lease, heartbeat, replay cursor, retry policy, signal, worktree), use the established semantics instead of inventing a variant.
- Record every adopted dependency as an engineering-decision note (E-register) in the slice PR.
EOF

write 2 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

Read the linked docs before designing — do not discover by exploration. Record adopted dependencies as an E-note in the PR.

- **Embed:** pnpm workspaces (read https://pnpm.io/workspaces) + Turborepo (read https://turborepo.com/docs — "Getting started" and "Caching"). License-inventory gate: license-checker (https://github.com/davglass/license-checker) with an allowlist accepting only MIT, Apache-2.0, BSD, ISC for linked dependencies — everything else fails CI. This gate enforces the OSS policy for every later slice.
- **Reference (layout only, MIT):** OpenClaw repo root (https://github.com/openclaw/openclaw) — a mature TypeScript pnpm workspace. Look at: root package.json workspace globs, base tsconfig, CI workflow naming. Copy configuration patterns, not code.
EOF

write 3 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

Read the linked docs before designing — do not discover by exploration. Record adopted dependencies as an E-note in the PR.

- **Embed:** zod-to-openapi (https://github.com/asteasolutions/zod-to-openapi — README "Getting started") for OpenAPI + typed-client generation from the Zod contracts; XState v5 (https://stately.ai/docs/xstate — read "State machines" and "Typegen") as the candidate implementation for the task state machine. Evaluate XState vs a hand-rolled transition table in this slice and record the choice; do not hand-roll both state machine and typegen if XState fits.
- **Pattern (vocabulary, not the server):** Temporal TS docs (https://docs.temporal.io/develop/typescript) — read the pages on Event History, Retry Policy, Signals, and Idempotency; use their semantics for the journal/replay/version fields here.
- **Do not:** LangGraph / CrewAI / AutoGen as the runtime (G2).
EOF

write 4 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

Read the linked docs before designing — do not discover by exploration. Record adopted dependencies as an E-note in the PR.

- **Pattern (primary, MIT):** OpenClaw — read the Gateway and Sandboxing sections at https://docs.openclaw.ai/; in the repo (https://github.com/openclaw/openclaw) search src/ for "supervisor", "session", "spawn", "idle", "hibernat". It is the closest public implementation of a trusted gateway supervising pi-lineage agent processes; replicate its lifecycle ideas adapted to PRD leases/recovery.
- **Embed:** better-sqlite3 (https://github.com/WiseLibs/better-sqlite3 — README sections "usage" and "pragma"; enable journal_mode=WAL) + Drizzle SQLite (https://orm.drizzle.team/docs/overview). Pi adapter: read the session/JSON Lines protocol docs in the upstream fork https://github.com/badlogic/pi-mono before defining the adapter contract.
EOF

write 5 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

Read the linked docs before designing — do not discover by exploration.

- **Reference scaffolds:** OWASP GenAI LLM Top 10 (https://genai.owasp.org/llm-top-10/) and OWASP ASVS (https://asvs.owasp.org/) — build the register by mapping their items onto PRD §16 and §22.10 instead of brainstorming threats from zero.
- **Pattern:** Magentic-UI action guards (https://microsoft.github.io/magentic-ui/ and https://github.com/microsoft/magentic-ui — read the action-approval/guardrail docs) for agent-action risk vocabulary; OpenClaw security model — "trusted gateway, untrusted execution, deterministic policy" (https://docs.openclaw.ai/ — security and sandboxing pages) for the control set.
EOF

write 6 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

Read the linked docs before designing — do not discover by exploration. Record adopted dependencies as an E-note in the PR.

- **Embed:** Auth.js v5 Google provider (read https://authjs.dev/getting-started/providers/google) with database sessions — do not hand-roll OAuth, token refresh, or session cookies.
- **Custom (boring, no dependencies):** the five-account cap is a COUNT check before signup; administrator status is a DB flag (D2/D12). No OSS applies — keep it that way.
EOF

write 7 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

Read the linked docs before designing — do not discover by exploration. Record adopted dependencies as an E-note in the PR.

- **Embed:** dockerode (https://github.com/apocas/dockerode — README + examples) for provisioning, health checks, and resource stats from the control plane.
- **Pattern-only (AGPL — copy nothing):** Coder (https://coder.com/docs — read the Workspaces and resource-quotas pages) for the provisioning → registration → health-check lifecycle mapped onto tiers and AC2.
- **Channel auth:** mirror OpenClaw's gateway/client authentication shape (https://docs.openclaw.ai/ — gateway security docs): deterministic credential check before any command, per G2.
EOF

write 8 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

Read the linked docs before designing — do not discover by exploration. Record adopted dependencies as an E-note in the PR.

- **Embed:** Socket.IO v4 (https://socket.io/docs/v4/ — read rooms, acks, and Connection state recovery: https://socket.io/docs/v4/connection-state-recovery). Note its recovery is in-memory only: durable cursor replay stays custom on top of this slice's SQLite event journal — the journal and replay path are the real work here.
- **Pattern:** OpenClaw gateway (https://github.com/openclaw/openclaw — src/gateway; docs at https://docs.openclaw.ai/) for local API + supervision wiring; Temporal Event History semantics (https://docs.temporal.io/develop/typescript) for the append-only journal and replay cursors.
EOF

write 9 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

Read the linked docs before designing — do not discover by exploration. Record adopted dependencies as an E-note in the PR.

- **Embed:** shadcn/ui (https://ui.shadcn.com/docs — Installation + the component pages you use) on Radix primitives (https://www.radix-ui.com/primitives/docs) as the accessible, keyboard-ready base for §18; TanStack Query (https://tanstack.com/query/latest/docs/framework/react/overview) for server state; react-resizable-panels (https://github.com/bvaughn/react-resizable-panels) for the collapsible workspace-panel shell.
- The `impeccable` gate still governs visual craft — these give structure and accessibility, not the look. Do not add any other component kit (no MUI/Ant).
EOF

write 10 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

- **No new dependencies.** This is an integration slice: use exactly the picks adopted in #6 (Auth.js), #7 (dockerode), #8 (Socket.IO + journal), #9 (shadcn/TanStack/react-resizable-panels) and read the doc sections listed there. If an integration gap tempts you to add a library, surface it in the PR instead (G5).
EOF

write 11 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

- **Custom by design:** the Pack schema is the product's novel object — implement D18/D28/D46 with Zod in packages/contracts. No OSS models versioned Pack → Operation → Agent catalogs; do not look for one.
- **Optional alignment (only if recorded as an E-note):** shape Skill objects compatibly with the open Agent Skills format used by OpenClaw/ClawHub (https://docs.openclaw.ai/ — Skills section) so future skill ecosystems import cleanly. Pack loader logic stays ours.
EOF

write 12 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

- **Pattern:** Letta (https://docs.letta.com/ — read the Agents → Memory docs) for memory-block scoping, provenance, and agents-as-durable-identities vocabulary. Implementation stays custom on SQLite per D37/D39 — copy semantics, not schema.
- **Embed:** nothing new — reuse the S02 contracts package.
EOF

write 13 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

- **Pattern (primary, MIT):** OpenClaw session lifecycle — repo https://github.com/openclaw/openclaw, search src/ for "idle", "hibernat", "respawn", "session"; docs Gateway section at https://docs.openclaw.ai/. Warm start, idle teardown, and durable-state reconstruction are exactly this slice's problem set, already solved there.
- **Reference:** pi-mono (https://github.com/badlogic/pi-mono) session docs for what inputs a pi session needs on reconstruction.
- **Embed:** none new (node child_process + better-sqlite3 from S03).
EOF

write 14 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

- **Custom by design:** roster, removable coordinator, per-run state isolation — implement D7/D31/D34/D42/D49 exactly as recorded. No OSS models this object set.
- **Vocabulary-only:** AutoGen group chat / team concepts (https://microsoft.github.io/autogen/) and CrewAI hierarchical process (https://docs.crewai.com/ — "Hierarchical Process" page). Read for coordination vocabulary; do not adopt, and never let the model drive orchestration (G2).
EOF

write 15 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

- **No new dependencies.** Reuse Operation contracts and roster validation from #14 (S13). Vocabulary-only reference: AutoGen team configuration (https://microsoft.github.io/autogen/) for ad-hoc team shapes. Implement D41 as recorded.
EOF

write 16 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

- **Pattern:** Magentic-UI co-planning (https://microsoft.github.io/magentic-ui/ — read the co-planning and action-approval sections; repo https://github.com/microsoft/magentic-ui) for edit-before-run preview UX; LangGraph human-in-the-loop interrupts (https://langchain-ai.github.io/langgraph/ — "Human-in-the-loop" concept pages) for pause-for-confirmation vocabulary.
- The preview gate behavior itself is D30 — concepts only, no adoption.
EOF

write 17 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

Read the linked docs before designing — do not discover by exploration. Record adopted dependencies as an E-note in the PR.

- **Embed:** BullMQ (https://docs.bullmq.io/ — read Guide → Workers, Queues, and Patterns) on Redis for queue and admission plumbing; Node child_process with detached process groups for task workers. Supervision code is this slice's work.
- **Pattern:** Temporal worker model (https://docs.temporal.io/develop/typescript — Workers and Task Queues pages) for worker↔gateway heartbeat/lease semantics; OpenClaw supervisor patterns (https://github.com/openclaw/openclaw — search src/ for "supervisor").
EOF

write 18 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

Read the linked docs before designing — do not discover by exploration. Record adopted dependencies as an E-note in the PR.

- **Embed:** CodeMirror 6 (https://codemirror.net/docs/ — prefer over Monaco: lighter and mobile-friendlier for §18); react-resizable-panels already adopted in S08.
- **Pattern (MIT):** OpenHands frontend (https://github.com/All-Hands-AI/OpenHands — look at frontend/src/components for file-browser and editor panel composition).
- **Write leases:** use the established lease semantics (Temporal/Kubernetes vocabulary: holder, expiry, revocation); custom implementation on SQLite per D6/D10.
EOF

write 19 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

Read the linked docs before designing — do not discover by exploration. Record adopted dependencies as an E-note in the PR.

- **Embed:** xterm.js (https://xtermjs.org/docs/ — read Terminal and the addons list) + node-pty (https://github.com/microsoft/node-pty — README usage) for the terminal view; Playwright (https://playwright.dev/docs/api/class-cdpsession — CDP Page.startScreencast for the live read-only browser view; https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context for the shared Chromium profile).
- **Pattern (MIT):** OpenHands browser/terminal panels (https://github.com/All-Hands-AI/OpenHands — frontend/) for read-only live-view composition.
EOF

write 20 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

Read the linked docs before designing — do not discover by exploration. Record adopted dependencies as an E-note in the PR.

- **Embed:** simple-git (https://github.com/steveukx/git-js — README) wrapping plain git; read https://git-scm.com/docs/git-worktree for worktree semantics (branch-per-agent, separate worktree, conflict queue per D6/E6).
- **Pattern:** GitHub's PR "Files changed" summary for the minimal merge-review view fields (PRD §10); OpenHands git flows (https://github.com/All-Hands-AI/OpenHands) for agent-driven git hygiene.
EOF

write 21 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

- **Custom by design:** scoped, expiring, revocable Grant objects exist in no OSS toolkit — implement D9 + E3 exactly as recorded. UX references only: Letta human-in-the-loop approvals (https://docs.letta.com/ — Tools → human-in-the-loop), LangGraph interrupts (https://langchain-ai.github.io/langgraph/), Magentic-UI action approval (https://microsoft.github.io/magentic-ui/).
- **Embed:** BullMQ delayed jobs (https://docs.bullmq.io/guide/jobs/delayed) for the 0/15m/45m/3h/24h reminder sequence — do not build a reminder scheduler.
EOF

write 22 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

Read the linked docs before designing — do not discover by exploration.

- **Embed:** MCP TypeScript SDK (https://github.com/modelcontextprotocol/typescript-sdk; docs https://modelcontextprotocol.io/) to wrap MCP servers as Connectors — the runtime executor stays authoritative (G2); Zod (already adopted) for tool I/O schemas; risk classes as data per D35/E13.
- **Do not:** adopt an agent framework's tool-permission layer; the risk-class ladder is recorded product behavior (D35/E4), implemented here.
EOF

write 23 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

Read the linked docs before designing — do not discover by exploration. Record adopted dependencies as an E-note in the PR.

- **Embed:** BullMQ retry/backoff (https://docs.bullmq.io/guide/retrying-failing-jobs) for the transient-failure policy (bounded 3 attempts, PRD §8); tree-kill (https://github.com/pkrumins/node-tree-kill) or negative-PID process-group kill for whole-tree cancellation preserving logs and partial files.
- **Pattern:** Temporal RetryPolicy semantics (https://docs.temporal.io/develop/typescript) — the PRD policy already reflects it; keep the implementation equal to the recorded policy.
EOF

write 24 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

Read the linked docs before designing — do not discover by exploration. Record adopted dependencies as an E-note in the PR.

- **Embed (biggest slice-shortener in the plan):** Vercel AI SDK — read https://ai-sdk.dev/docs/introduction, then https://ai-sdk.dev/providers/openai-compatible-providers (createOpenAICompatible covers generic and custom endpoints, including local Ollama) and the community-provider index (https://ai-sdk.dev/providers/community-providers). Covers native OpenAI/Anthropic/Google adapters, streaming, tool calls, per-call model overrides, and connection tests (§9).
- **Custom:** credential custody (local-first, masked display, runtime injection, revocation — PRD §9). Keys never reach prompts/logs (G3); no mock fallback (G4) — AI SDK errors surface as configuration states.
EOF

write 25 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

- **Custom by design:** the reservation/settlement credit ledger (D20/D21/D48) is a single-account SQLite transaction flow: reserve a bounded estimate, settle actuals, release unused, pause on shortfall. No OSS billing library applies — explicitly do not adopt one. Write it boring: one balance row, append-only ledger rows, tests for every PRD §9 branch.
EOF

write 26 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

Read the linked docs before designing — do not discover by exploration. Record adopted dependencies as an E-note in the PR.

- **Embed:** SearXNG as an unmodified external container (https://docs.searxng.org/ — enable the JSON search API) for web search; @mozilla/readability (https://github.com/mozilla/readability) + turndown (https://github.com/domchristie/turndown) for page fetch → clean markdown; unpdf (https://github.com/unjs/unpdf) for PDF text; SheetJS CE (https://docs.sheetjs.com/) for spreadsheets; image understanding via the S23 AI SDK vision APIs.
- **License note:** SearXNG is AGPL — run it as a separate container, HTTP calls only, no code linking.
EOF

write 27 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

- **Embed (no new dependencies):** ephemeral sandboxed execution via docker run/exec with --cap-drop ALL, --network none (or an allowlist), cpu/mem/pids limits, and a tmpfs workdir — reference https://docs.docker.com/reference/cli/docker/container/run/.
- **Pattern:** E2B sandbox model (https://github.com/e2b-dev/E2B — pattern only) and OpenClaw sandboxing docs (https://docs.openclaw.ai/ — Sandboxing) for the policy shape; map onto D27 risk classes.
EOF

write 28 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

- **Reference:** the S04 threat-model register is the test plan; OWASP ASVS (https://asvs.owasp.org/) and the LLM Top 10 (https://genai.owasp.org/llm-top-10/) define the checklist being verified. Automate container-escape, credential-leak, and cross-tenant checks; browser-side checks via Playwright (already adopted).
- **No new dependencies** — write tests, not tools.
EOF

write 29 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

Read the linked docs before designing — do not discover by exploration. Record adopted dependencies as an E-note in the PR.

- **Embed:** BullMQ repeatable jobs (https://docs.bullmq.io/guide/jobs/repeatable) for schedules; chokidar (https://github.com/paulmillr/chokidar — README) for file watchers; the webhook receiver is a plain Express route; de-duplicate via Redis idempotency keys (SET NX EX).
- **G2:** a schedule, watcher, or webhook event is a TypedExecutionEvent that creates a task run from typed behavior — never natural-language classification.
EOF

write 30 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

Read the linked docs before designing — do not discover by exploration.

- **Pattern:** Letta memory (https://docs.letta.com/ — Memory docs and the sleep-time agents guide) for scoping, provenance, and background-maintenance vocabulary; implement custom on SQLite per D37 (publication boundary, versioning, restore).
- **Embed:** secretlint (https://github.com/secretlint/secretlint) as the rejection-path scanner for credentials in memory writes, plus entropy heuristics. AC27 (no leakage without publication) is the acceptance bar.
EOF

write 31 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

- **Embed:** Web Notifications API (https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API) for browser notifications when the tab is unfocused; BroadcastChannel (https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel) for multi-tab sync, layered under the S07 server-cursor replay (the server cursor stays authoritative — PRD §14). Settings/onboarding UI via the shadcn primitives adopted in S08. No other dependencies.
EOF

write 32 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

- **Pattern (design against this, implement on the S02/S07 journal):** Temporal event-history replay semantics (https://docs.temporal.io/develop/typescript — Event History and Replay pages) for checkpoint/recovery vocabulary; E13 recovery classes (replayable | idempotent_retry | needs_human) drive per-tool behavior.
- **Do not:** embed the Temporal server. Semantic checkpoints are custom; PRD §13 is the spec.
EOF

write 33 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

- **Embed:** commander (https://github.com/tj/commander.js) for the admin CLI; admin endpoints as authenticated Express routes on the control plane (D47/E7 — API/CLI only; the console UI is production-gated). Audit-log every security-relevant action (PRD §15). No other dependencies.
EOF

write 34 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

Read the linked docs before designing — do not discover by exploration. Record adopted dependencies as an E-note in the PR.

- **Embed:** restic (https://restic.readthedocs.io/en/stable/ — read Backup, Restore, and Forget; use --keep-last 7 for the PRD §12 retention; run `restic check` for integrity) as an external binary scheduled by a compose-side timer or a BullMQ repeatable job. BSD-2 — external binary, no linking concerns. The restore drill is the acceptance test (AC18).
EOF

write 35 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

Read the linked docs before designing — do not discover by exploration.

- **Embed:** Playwright Test (https://playwright.dev/docs/intro — projects for chromium/firefox/webkit per §18 browsers) as the criteria runner for AC1–AC27; axe-core (https://github.com/dequelabs/axe-core) injected for keyboard/a11y assertions. Map each AC → automated test or manual-QA evidence per E14; do not hand-roll a runner.
EOF

write 36 <<'EOF'
## Open-source leverage (recorded 2026-09-18)

Read the linked docs before designing — do not discover by exploration. Record adopted dependencies as an E-note in the PR.

- **Embed:** Docker Compose (https://docs.docker.com/compose/) for the single-VM stack (web, control plane, PostgreSQL, Redis, SearXNG, reverse proxy, backup service, up to five user containers); Caddy (https://caddyserver.com/docs/ — automatic HTTPS) as reverse proxy. Healthchecks in compose; runbooks reference the restic restore drill from S33.
- **Boring by design:** no Kubernetes, no additional infrastructure.
EOF

for n in $(seq 1 36); do
  body="$TMP/body-$n.md"
  gh api "repos/$REPO/issues/$n" --jq .body > "$body"
  if grep -q "## Open-source leverage" "$body"; then
    echo "$n: section already present — skipped"
    continue
  fi
  { cat "$body"; printf '\n'; cat "$SECDIR/$n.md"; } > "$TMP/new-$n.md"
  gh issue edit "$n" --repo "$REPO" --body-file "$TMP/new-$n.md" > /dev/null
  echo "$n: updated"
done
echo "DONE"
