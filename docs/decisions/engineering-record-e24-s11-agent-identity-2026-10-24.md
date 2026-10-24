# E24: S11 agent identity implementation record

- ID: E24
- Status: Delegated engineering, pending owner review; locally verified
- Date: 2026-10-24
- Evidence source: orchestrator reconciliation session. Two S11 continuation lines were merged: this branch's backend-fix and UI-taste-pass line (commits 90597f9…1f34d2d, 97d4b2b…9804b03, 1f023b6) and the device line `feat/task-4-authenticated-live-transport` (2aebcc3 formatting, ca11ef5 secure account routing/storage, bc8efbb PG test fix, 5bb1092 E23 live transport — see E22/E23). Merge commit 1411216. Fresh-archive gate logs in the PR evidence pack; two-axis review records quoted below. No deployment authorization inferred.
- Supersedes: no product decision. Implements D32 (layer 1), D39, D16, D18/D28, E12; integrates E22/E23 into the S11 stack.
- Affected PRD sections: 4.2, 5, 19 (AC3, AC4, AC16 partially). No PRD text or acceptance-status changes.

## Decision and rationale

**Identity storage (v4 migration).** Agent identity is four container-local SQLite tables — `agents`, `agent_settings`, `agent_memory_entries`, `agent_task_history` — keyed by the composite primary key `(workspace_id, agent_id)` (E12 workspace scoping is structural, not conventional). One row per Agent per workspace is the one-identity guarantee (D39) enforced by the schema, with a race-contained get-or-create on top.

**Direct chats (v5 migration).** `agent_direct_chats` binds each Agent to exactly one real conversation, created by a journaled get-or-create (`AgentsService.getOrCreateDirectChat`): the creation runs as one transactional unit, rolls back atomically on a PK race and re-reads the winner's binding, and the `conversation.created` publish fires strictly after COMMIT (fanout containment). The binding survives restart; the same conversation id is re-resolved, never duplicated.

**Settings commands (D16) are atomic and unjournaled — bounded.** Each settings command is applied as ONE atomic transaction unit. The typed command union (`packages/contracts/src/agent.ts`) is the single mutation surface shape. Settings commands are deliberately NOT written to the event journal today: no agent-domain event stream exists yet (it arrives with session/Operation slices), and journalling a partial stream now would create a second, weaker source of truth. On DB loss the unjournaled state (`user_instructions`, provider pair, `tool_defaults`, the binding row) is re-derived from the pack seed; DB lifetime is the container filesystem's, with backup/recovery owned by S31/S32. This is recorded here because it is a real durability boundary, not an oversight — it is also stated at the three code sites (service, route, contracts).

**Pack re-seed never clobbers user state.** `upsertFromPack` refreshes pack-owned fields only; `user_instructions` and the default provider are never rewritten by a re-seed (test: re-seed keeps a user edit). Pack files themselves are read-only at runtime — no write path exists into `agent-packs/`.

**Folder guard seam with a durable store.** `AgentFoldersService` is a pure guard (URI parse, actor/owner resolution, access decision) over an injected `AgentFolderStore`. Production wires `FileAgentFolderStore` (disk-backed, sha256-hashed workspace root, per-parent symlink checks, `O_NOFOLLOW` reads, 0600 atomic writes); tests inject maps. Cross-Agent access is denied with the typed 403 `AGENT_FOLDER_ACCESS_DENIED` over real HTTP, and the denial is tested at the API, service, and post-restart layers.

**GET /v1/agents/:id materializes the direct chat — documented side effect.** The detail route get-or-creates the binding (journaled, idempotent). A link-prefetch can therefore create chats silently; benign (idempotent, pack-scoped) but recorded: a later slice should pre-provision at seed time or move binding to an explicit POST command.

**PATCH routes are redundant with the D16 command surface.** The browser allowlist already refuses them; they remain reachable only on the loopback local API. Retirement in favor of the single command surface is recorded as the follow-up (the P2 from the standards review).

**Idempotency keys without a receipt store.** `idempotency_key` is schema-required and validated, but not stored; replay is value-idempotent under last-write-wins (and `reset_all` re-anchors to the pack seed). A delayed stale replay can overwrite a newer value — acceptable for this slice; receipts must arrive with S30 onboarding, which must not assume at-least-once ordering.

## Alternatives considered

- Journalling settings commands now was rejected: it would duplicate a source of truth ahead of the agent event stream; revisit at the session/Operation slices.
- Pre-provisioning all six direct chats at seed time was deferred: it removes the GET side effect but changes seeding semantics mid-slice; recorded as the route-owner follow-up.
- A receipt store for idempotency was deferred to S30 (onboarding/settings) where command ordering becomes contractual.
- Keeping the local per-file charset constant from the device line was rejected in favor of the shared `AGENT_FOLDER_HOST_CHARSET` export from the seeding boundary (one rule, two enforcement points).
- In-memory-only folder storage was rejected by E22 already; `FileAgentFolderStore` completes that decision on the S11 seam.

## Ownership and verification

Implementation owner: orchestrator + delegated coding agents; review/release owner: maintainer. The runtime owns agent rows, settings, folders, direct chats; the control plane owns sessions, account routing and live transport (E22/E23); web owns same-origin calls only.

**Fresh-archive gate (merge commit 1411216):** install/lint/format/typecheck green; **855/855 tests in 85 files** against real host PostgreSQL 16 (SHERA_PG_BIN), zero skipped; build, boundary guards, license inventory, 27 mockup tests green.

**Two-axis review (2026-10-24):** adversarial spec review — MERGEABLE; 6/7 acceptance criteria PROVEN with test citations; AC4 ("no second identity inside an Operation") is PARTIAL because the Operation/harness-run machinery does not consume `agent_id` yet (S12/S13 own that test). Standards review — MERGEABLE; zero P0/P1, one P2 (PATCH retirement, follow-up), five P3 notes (GET side effect, unjournaled-settings traceability line — satisfied by this record, idempotency receipts, route allowlist notes). Security review of the E23 surface — recorded separately in the PR evidence pack.

**UI gate evidence:** 21 browser captures under `apps/web/.impeccable/review/s11/` (360/768/1440 px, keyboard focus incl. zoomed capture, hover, reset-armed/reset-synced/saved-affordance states, gate-unconfigured and fixture states), updated by the same commits that fixed the findings — evidence is current with the final UI.

**Follow-ups recorded (not blocking):** PATCH-route retirement (P2); AC4 Operation-context test (S12/S13); two-account live-transport isolation test; GET-side-effect restructure; idempotency receipts (S30).

## Reconciliation note

The device line (built on the owner's laptop from cc891e4 without this branch's then-unpushed fixes) was merged, not rebased: both lines touch the agent services and web surfaces. Conflict resolutions and their rationale are in the merge commit message (1411216). `dev/device-handoff-2026-10-21` remains an evidence-preservation archive branch on the remote (design assets, avatar sources, validation logs) and is intentionally NOT merged to main.
