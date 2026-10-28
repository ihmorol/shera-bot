/**
 * Committed migration chain for the container-local SQLite database (S07).
 *
 * Mirrors the control-plane discipline (D24): migrations are committed,
 * reviewed SQL applied by a single runner — schema push is never used. Each
 * entry appends a version; the runner records applied versions in
 * schema_migrations and is safe to call on any prior state (idempotent).
 *
 * v1 — append-only event journal + the conversations aggregate. BOTH tables
 * carry workspace_id from day one (E12): every row is tenant-scoped at the
 * storage layer, not only at the API layer. The journal's primary key is
 * (workspace_id, stream_id, sequence): streams live INSIDE workspaces, so the
 * same aggregate id in two workspaces never collides (AC3). event_id
 * uniqueness is workspace-scoped too — UNIQUE (workspace_id, event_id), so
 * the same event id in two workspaces are independent rows (E12) and the
 * idempotent no-op for a repeated event_id can only ever match a row the
 * SAME workspace wrote (C-3; schema not shipped anywhere — branch unmerged,
 * edited in place per the committed-migration discipline).
 *
 * v2 — command receipts (D23 rule 6): one row per accepted command keyed by
 * (workspace_id, idempotency_key), recorded in the SAME transaction as the
 * command's effects, so a repeated key replays the recorded result instead of
 * duplicating effects.
 *
 * v3 — workspace pack pinning (S10; D19, D28): the workspace record gains the
 * pin columns D28 names for the prototype — agent_pack_id, agent_pack_version,
 * manifest_hash, installed_at. One pinned pack version per workspace (D19):
 * a task is permanently associated with the version pinned at its creation
 * (the task.created journal payload carries the creation-time snapshot), so a
 * pack upgrade affects NEW tasks only. The four pin columns are either all
 * set (pinned) or all NULL (a workspace exists but no pack is installed yet);
 * a half-pinned row is unrepresentable. This is the first table keyed by
 * workspace_id ALONE — a workspace is the tenant root, not a child record;
 * every other product-state table keeps the (workspace_id, id) scoping (E12).
 *
 * v4 — agent identities (S11 chunk 1; D32 layer 1, D39): Agents become
 * durable, workspace-scoped rows seeded from the workspace's pinned pack.
 * The agents primary key is (workspace_id, agent_id) — the same agent_id in
 * two workspaces are independent rows (E12), so every workspace can seed the
 * same pinned pack. Pack-owned fields (display_name, role_description,
 * ui_identity, capabilities_json, home_operation_id) are refreshed by
 * re-seeding; user_instructions and the default provider pair are user-owned
 * and a re-seed never clobbers them. private_folder_path records the agent's
 * private folder URI (agent://<agent_id>/). agent_settings holds the raw
 * per-agent settings blob — the typed D16 command surface arrives with S11
 * chunk 2. agent_memory_entries and agent_task_history are workspace-scoped
 * ledger placeholders: publication rules and cross-agent reads arrive with
 * the memory slice, so nothing at this layer reads across agents.
 *
 * v5 — agent direct-chat binding (S11 chunk 2; D39, one identity everywhere):
 * a conversation can BE a direct Agent chat, and the binding is a dedicated
 * mapping table rather than a nullable column on conversations — conversations
 * stay agent-agnostic (a direct chat is a binding to an identity, not a
 * conversation subtype), and the binding carries its own guarantees at the
 * storage layer: PRIMARY KEY (workspace_id, agent_id) makes "exactly one
 * direct chat per (workspace, agent)" unrepresentable to violate, and
 * UNIQUE (workspace_id, conversation_id) keeps the mapping one-to-one (a
 * conversation is the direct chat of at most one Agent in its workspace).
 * conversation_id is validated by the writer (the conversations row is
 * created in the SAME transaction as the binding), so no FOREIGN KEY is
 * declared — matching the v4 agent tables. The same agent_id in two
 * workspaces binds two independent chats (E12).
 *
 * v6 — Operation chat records (S13 chunk 2; D31, D34, D36, D46, D49): the
 * persisted Operation chat (the S02 `Operation` stays the conversation-summary
 * wire shape — this is the D31 workspace/chat OBJECT), its queryable roster,
 * its runs, the D7 collaboration events, persisted D36 roster refusals, and
 * the D49 coordinator lifecycle events.
 *
 * Normalization taste: the D29 pinning snapshot is stored WITHOUT the roster —
 * pack_id/pack_version/capabilities/provider_snapshot live on the operations
 * row, while roster membership is its own operation_roster table keyed
 * (workspace_id, operation_id, agent_id). The roster is the single source of
 * truth for membership (queryable at the storage layer, E12) and the read
 * model assembles pinning.roster_agent_ids from it — the JSON can never drift
 * from the table. operation_roster_refusals persists every refused roster
 * change (D36) so the UI can show WHY; operation_coordinator_events records
 * D49's CoordinatorSet/CoordinatorRemoved lifecycle events.
 *
 * operation_runs: one D31 run per row — its own D8 state (the same vocabulary
 * as TaskRun, never a second state machine), its own D26 events_seq_cursor
 * (last applied stream sequence; 0 = none yet), credits placeholder, and
 * artifact ids. parent_task_id is the D34/D46 delegation link (the parent
 * RUN's id); no FOREIGN KEY is declared — the writer validates the parent in
 * the same workspace, matching the v4/v5 discipline. Run ids that begin with
 * "operation:" are rejected by the writer: that prefix is reserved for the
 * Operation-chat event stream sentinel below.
 *
 * operation_collaboration_events (D7): the STREAM DESIGN CHOICE — a D7 event
 * is streamed per RUN when run_id is set (stream_id = run_id, mirroring
 * OperationRun.events_seq_cursor), and on the Operation chat itself when
 * run_id is null (stream_id = "operation:<operation_id>", the sentinel run ids
 * can never take). Both stream kinds are 1-based, gapless per stream (D26),
 * with PRIMARY KEY (workspace_id, stream_id, sequence) and workspace-scoped
 * event_id uniqueness — the same shape as the v1 journal. The run cursor and
 * the event row commit in the SAME transaction.
 *
 * v7 — Operation chat binding + message addressing (S13 chunk 3; D41, D7):
 * an Operation chat IS a real conversation (D41 chat taxonomy), so the
 * binding follows the v5 agent_direct_chats pattern: a dedicated mapping
 * table, not a column on conversations. PRIMARY KEY (workspace_id,
 * operation_id) makes "exactly one chat conversation per (workspace,
 * operation)" unrepresentable to violate, and UNIQUE (workspace_id,
 * conversation_id) keeps the mapping one-to-one; the conversation row is
 * created in the SAME transaction as the binding, so no FOREIGN KEY is
 * declared (the v4/v5/v6 discipline). The same operation_id in two
 * workspaces binds two independent chats (E12).
 *
 * operation_message_recipients stores the @-addressing resolution of one
 * Operation-chat message (D7 recipient semantics): when a message text
 * mentions roster Agents, the runtime resolves the mentions against the
 * Operation roster at SEND time and records the resolved recipient Agent ids
 * here, keyed by (workspace_id, message_id) — the journal event payload stays
 * verbatim (the literal text is never rewritten), and an absent row means the
 * message was unaddressed (recipients = [], Operation-wide). The conversation
 * aggregate itself stays agent-agnostic; this is Operation-domain metadata.
 *
 * v8 — task workers (S16 chunk 1; D32 layer 3, D33, D10): one row per
 * supervised worker incarnation, keyed (workspace_id, run_id, worker_id) —
 * the same run_id in two workspaces are independent rows (E12), and a run may
 * carry successive incarnations over its life, so worker_id (fresh per
 * incarnation) completes the key. This table is the LEASE DURABILITY D32
 * names: the runtime gateway renews lease_expires_at on every healthy frame,
 * and a future recovery slice reads the row (state, heartbeat_at,
 * last_progress_json) to reconstruct what survived a gateway restart — the
 * worker's progress is NEVER only in process memory (D10). The state
 * vocabulary is the task-state lifecycle, NOT the session's warm/hibernate
 * one: starting|running|stalled|exited|killed — a healthy worker runs until
 * done/stopped (no idle timer, no hibernation; AC25), `stalled` marks a
 * missed-heartbeat detection (distinct from a slow-but-heartbeating worker,
 * which stays `running`), `exited` an exit nobody initiated, `killed` a
 * supervisor-initiated termination. run_id is validated by the writer (the
 * run row lives in the same database, written through the operations
 * repositories) so no FOREIGN KEY is declared — the v4/v5/v6 discipline.
 *
 * v9 — workspace files storage (S17 chunk 1; PRD §4.3, D6, D23 rule 8, D39):
 * the real file tree behind every chat's workspace panel. Storage is
 * ROW-BASED — files are BLOBs inside workspace_nodes, not filesystem entries —
 * so path traversal and symlink escapes are impossible at the storage layer
 * by construction; path safety is enforced at URI resolution in the
 * workspace-files repository (typed rejections, tested there).
 *
 * workspace_nodes: one row per file or directory, keyed (workspace_id, id)
 * (E12). scope is 'workspace' (the shared workspace:// tree) or 'agent' (a
 * private agent://<agent_id>/ folder, D39) — the CHECK ties agent_id to the
 * agent scope exactly. parent_id is NULL only for the per-scope root
 * directories the repository materializes deterministically; every other node
 * hangs off a real parent, so UNIQUE (workspace_id, parent_id, name) makes a
 * duplicate sibling name unrepresentable (NULL parent rows — the roots — are
 * created idempotently by primary key). Names cannot be empty, '.', '..' or
 * carry '/' or '\' separators (the separator check uses char(92) so the SQL
 * text needs no backslash escaping): the schema refuses what resolution
 * rejects. Directories carry no content and size 0; files always carry a BLOB
 * (zero-length allowed). created_by_type/created_by_id follow the contracts'
 * Actor shape (D4) — user and agent actors are recorded at write time.
 *
 * write_leases: D6 write-lease rows, task-scoped BY DESIGN (task_id NOT NULL
 * — a lease is always held inside a task run, never floating). Chunk 1
 * creates the table; acquisition/renewal/release semantics land in S17
 * chunk 2 against this schema. holder_type/holder_id mirror the Actor shape;
 * agent_id is the holding agent when the holder is an Agent (null for
 * user-held leases). path records the leased URI.
 *
 * artifact_refs: ArtifactRef records with provenance (D23 rule 8) — the
 * producing task run (producer_task_id, NOT NULL per the contracts'
 * ArtifactRef) and the producing Agent when one exists
 * (producer_agent_id, nullable: the user can produce artifacts too). Content
 * is stored here for the prototype so an artifact survives independent of any
 * workspace_nodes entry. Chunk 1 creates the table; the artifact repository
 * lands in chunk 2.
 *
 * v10 — approval records (S20 chunk 1, renumbered from v9 at the S17
 * integration rebase; D9, PRD §8, E3, E12, G3): the four
 * durable tables the approval lifecycle pauses runs against.
 *
 * approval_requests mirrors the contracts ApprovalRequest one-to-one — tool
 * identity, version, capability, risk class, EXPLICIT resource scope, the
 * args_digest, the side-effect summary the UI renders, and the pending |
 * approved | rejected | cancelled status with its resolution stamps. There is
 * NO raw-arguments column: approval records carry the sha256 args_digest only
 * (G3 — raw arguments never enter approval records, events, or logs).
 * requested_by is the D4 Actor, stored as validated JSON.
 *
 * approval_grants mirrors the contracts ApprovalGrant: only the three approve
 * choices create grants (reject/cancel do not), each grant pins the tool
 * VERSION (a changed version invalidates a one-time approval), scopes to an
 * explicit resource, a conversation ("any" or one id), and the workspace
 * (E12), carries its expiry and one_time flag, and records approved_at /
 * revoked_at — everything revocable (D9).
 *
 * approval_reminders holds the five E3 reminder slots per request
 * (reminder_index 0-4 onto APPROVAL_REMINDER_SCHEDULE_SECONDS [0, 900, 2700,
 * 10800, 86400]); due_at is written at request time on the injected clock and
 * delivered_at stays NULL until a reminder is delivered. Delivery events never
 * change task state (E3).
 *
 * approval_mutes is the reminder-silencing ledger (scope 'approval' | 'task' |
 * 'all', target_id nullable for the 'all' scope).
 *
 * Every table is workspace-scoped as PRIMARY KEY prefix (E12); task_id,
 * conversation_id, and approval_id references are validated by the writers in
 * the same workspace, so no FOREIGN KEY is declared — the v4/v5/v6/v8
 * discipline.
 */
import type { DatabaseSync } from "node:sqlite";

export interface SqliteMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    name: "event-journal-and-conversations",
    sql: `
      CREATE TABLE IF NOT EXISTS event_journal (
        stream_id      TEXT    NOT NULL,
        sequence       INTEGER NOT NULL CHECK (sequence >= 1),
        event_id       TEXT    NOT NULL,
        event_type     TEXT    NOT NULL,
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        payload        TEXT    NOT NULL,
        workspace_id   TEXT    NOT NULL,
        occurred_at    TEXT    NOT NULL,
        correlation_id TEXT    NOT NULL,
        PRIMARY KEY (workspace_id, stream_id, sequence),
        UNIQUE (workspace_id, event_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS event_journal_workspace_idx
        ON event_journal (workspace_id, stream_id);

      CREATE TABLE IF NOT EXISTS conversations (
        id           TEXT    NOT NULL,
        workspace_id TEXT    NOT NULL,
        title        TEXT    NOT NULL,
        revision     INTEGER NOT NULL CHECK (revision >= 1),
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL,
        PRIMARY KEY (workspace_id, id)
      ) STRICT;
    `,
  },
  {
    version: 2,
    name: "command-receipts",
    sql: `
      CREATE TABLE IF NOT EXISTS command_receipts (
        workspace_id    TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        command_type    TEXT NOT NULL,
        result_json     TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        PRIMARY KEY (workspace_id, idempotency_key)
      ) STRICT;
    `,
  },
  {
    version: 3,
    name: "workspace-pack-pinning",
    sql: `
      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id       TEXT NOT NULL PRIMARY KEY,
        agent_pack_id      TEXT,
        agent_pack_version TEXT,
        manifest_hash      TEXT,
        installed_at       TEXT,
        CHECK (
          (
            agent_pack_id IS NULL
            AND agent_pack_version IS NULL
            AND manifest_hash IS NULL
            AND installed_at IS NULL
          )
          OR
          (
            agent_pack_id IS NOT NULL
            AND agent_pack_version IS NOT NULL
            AND manifest_hash IS NOT NULL
            AND installed_at IS NOT NULL
          )
        )
      ) STRICT;
    `,
  },
  {
    version: 4,
    name: "agent-identities",
    sql: `
      CREATE TABLE IF NOT EXISTS agents (
        agent_id               TEXT    NOT NULL,
        workspace_id           TEXT    NOT NULL,
        display_name           TEXT    NOT NULL,
        role_description       TEXT    NOT NULL,
        avatar_hue             INTEGER NOT NULL CHECK (avatar_hue >= 0 AND avatar_hue <= 360),
        initial_glyph          TEXT    NOT NULL,
        default_provider_id    TEXT    NOT NULL,
        default_provider_model TEXT    NOT NULL,
        user_instructions      TEXT,
        capabilities_json      TEXT    NOT NULL CHECK (json_valid(capabilities_json)),
        private_folder_path    TEXT    NOT NULL,
        home_operation_id      TEXT,
        is_seeded_from_pack    INTEGER NOT NULL CHECK (is_seeded_from_pack IN (0, 1)),
        created_at             TEXT    NOT NULL,
        updated_at             TEXT    NOT NULL,
        PRIMARY KEY (workspace_id, agent_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS agent_settings (
        workspace_id  TEXT NOT NULL,
        agent_id      TEXT NOT NULL,
        settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (workspace_id, agent_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS agent_memory_entries (
        id           INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        agent_id     TEXT NOT NULL,
        content      TEXT NOT NULL,
        created_at   TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS agent_task_history (
        id           INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        agent_id     TEXT NOT NULL,
        task_id      TEXT NOT NULL,
        created_at   TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 5,
    name: "agent-direct-chat-binding",
    sql: `
      CREATE TABLE IF NOT EXISTS agent_direct_chats (
        workspace_id    TEXT NOT NULL,
        agent_id        TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        PRIMARY KEY (workspace_id, agent_id),
        UNIQUE (workspace_id, conversation_id)
      ) STRICT;
    `,
  },
  {
    version: 6,
    name: "operation-chat-records",
    sql: `
      CREATE TABLE IF NOT EXISTS operations (
        operation_id           TEXT    NOT NULL,
        workspace_id           TEXT    NOT NULL,
        definition_ref         TEXT,
        name                   TEXT    NOT NULL,
        status                 TEXT    NOT NULL CHECK (status IN ('active', 'completed', 'failed')),
        coordinator_agent_id   TEXT    NOT NULL,
        pack_id                TEXT    NOT NULL,
        pack_version           TEXT    NOT NULL,
        capabilities_json      TEXT    NOT NULL CHECK (json_valid(capabilities_json)),
        provider_snapshot_json TEXT    NOT NULL CHECK (json_valid(provider_snapshot_json)),
        created_at             TEXT    NOT NULL,
        updated_at             TEXT    NOT NULL,
        PRIMARY KEY (workspace_id, operation_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS operation_roster (
        workspace_id      TEXT    NOT NULL,
        operation_id      TEXT    NOT NULL,
        agent_id          TEXT    NOT NULL,
        pack_id           TEXT    NOT NULL,
        pack_version      TEXT    NOT NULL,
        requires_approval INTEGER NOT NULL CHECK (requires_approval IN (0, 1)),
        added_at          TEXT    NOT NULL,
        PRIMARY KEY (workspace_id, operation_id, agent_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS operation_roster_refusals (
        id           INTEGER PRIMARY KEY,
        workspace_id TEXT    NOT NULL,
        operation_id TEXT    NOT NULL,
        agent_id     TEXT,
        pack_id      TEXT,
        refusal_code TEXT    NOT NULL,
        message      TEXT    NOT NULL,
        command_json TEXT    NOT NULL CHECK (json_valid(command_json)),
        created_at   TEXT    NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS operation_coordinator_events (
        id           INTEGER PRIMARY KEY,
        workspace_id TEXT    NOT NULL,
        operation_id TEXT    NOT NULL,
        event_id     TEXT    NOT NULL,
        event_type   TEXT    NOT NULL CHECK (event_type IN ('CoordinatorSet', 'CoordinatorRemoved')),
        agent_id     TEXT,
        created_at   TEXT    NOT NULL,
        UNIQUE (workspace_id, event_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS operation_runs (
        run_id                 TEXT    NOT NULL,
        workspace_id           TEXT    NOT NULL,
        operation_id           TEXT    NOT NULL,
        parent_task_id         TEXT,
        state                  TEXT    NOT NULL CHECK (state IN (
          'CREATED', 'PLANNED', 'QUEUED', 'RUNNING',
          'WAITING_FOR_AGENT', 'WAITING_FOR_APPROVAL', 'WAITING_FOR_RESOURCE',
          'RETRYING', 'CANCELLING', 'CANCELLED', 'SUCCEEDED', 'FAILED',
          'PAUSED', 'RECOVERY_REQUIRED')),
        events_seq_cursor      INTEGER NOT NULL CHECK (events_seq_cursor >= 0),
        provider_snapshot_json TEXT,
        credits_json           TEXT    NOT NULL CHECK (json_valid(credits_json)),
        artifacts_json         TEXT    NOT NULL CHECK (json_valid(artifacts_json)),
        created_at             TEXT    NOT NULL,
        updated_at             TEXT    NOT NULL,
        PRIMARY KEY (workspace_id, run_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS operation_runs_by_operation_idx
        ON operation_runs (workspace_id, operation_id);

      CREATE INDEX IF NOT EXISTS operation_runs_by_parent_idx
        ON operation_runs (workspace_id, parent_task_id);

      CREATE TABLE IF NOT EXISTS operation_collaboration_events (
        workspace_id             TEXT    NOT NULL,
        stream_id                TEXT    NOT NULL,
        sequence                 INTEGER NOT NULL CHECK (sequence >= 1),
        event_id                 TEXT    NOT NULL,
        operation_id             TEXT    NOT NULL,
        run_id                   TEXT,
        type                     TEXT    NOT NULL,
        sender_agent_id          TEXT    NOT NULL,
        recipient_agent_ids_json TEXT    NOT NULL CHECK (json_valid(recipient_agent_ids_json)),
        correlation_id           TEXT    NOT NULL,
        payload_json             TEXT    NOT NULL CHECK (json_valid(payload_json)),
        issued_at                TEXT    NOT NULL,
        PRIMARY KEY (workspace_id, stream_id, sequence),
        UNIQUE (workspace_id, event_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS operation_collaboration_events_by_operation_idx
        ON operation_collaboration_events (workspace_id, operation_id);
    `,
  },
  {
    version: 7,
    name: "operation-chat-binding-and-addressing",
    sql: `
      CREATE TABLE IF NOT EXISTS operation_chats (
        workspace_id    TEXT NOT NULL,
        operation_id    TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        PRIMARY KEY (workspace_id, operation_id),
        UNIQUE (workspace_id, conversation_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS operation_message_recipients (
        workspace_id      TEXT NOT NULL,
        message_id        TEXT NOT NULL,
        operation_id      TEXT NOT NULL,
        addressed_to_json TEXT NOT NULL CHECK (json_valid(addressed_to_json)),
        recorded_at       TEXT NOT NULL,
        PRIMARY KEY (workspace_id, message_id)
      ) STRICT;
    `,
  },
  {
    version: 8,
    name: "task-workers",
    sql: `
      CREATE TABLE IF NOT EXISTS task_workers (
        workspace_id       TEXT    NOT NULL,
        run_id             TEXT    NOT NULL,
        worker_id          TEXT    NOT NULL,
        pid                INTEGER,
        state              TEXT    NOT NULL CHECK (state IN ('starting', 'running', 'stalled', 'exited', 'killed')),
        heartbeat_at       TEXT,
        lease_expires_at   TEXT    NOT NULL,
        last_progress_json TEXT    CHECK (last_progress_json IS NULL OR json_valid(last_progress_json)),
        started_at         TEXT    NOT NULL,
        PRIMARY KEY (workspace_id, run_id, worker_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS task_workers_by_run_idx
        ON task_workers (workspace_id, run_id);

      CREATE INDEX IF NOT EXISTS task_workers_live_idx
        ON task_workers (workspace_id, state);
    `,
  },
  {
    version: 9,
    name: "workspace-storage",
    sql: `
      CREATE TABLE IF NOT EXISTS workspace_nodes (
        id              TEXT    NOT NULL,
        workspace_id    TEXT    NOT NULL,
        scope           TEXT    NOT NULL CHECK (scope IN ('workspace', 'agent')),
        agent_id        TEXT,
        parent_id       TEXT,
        name            TEXT    NOT NULL CHECK (
          length(name) BETWEEN 1 AND 255
          AND name NOT IN ('.', '..')
          AND instr(name, '/') = 0
          AND instr(name, char(92)) = 0
        ),
        is_directory    INTEGER NOT NULL CHECK (is_directory IN (0, 1)),
        size            INTEGER NOT NULL CHECK (size >= 0),
        mime_type       TEXT,
        content         BLOB,
        created_by_type TEXT    NOT NULL CHECK (created_by_type IN ('user', 'agent', 'runtime', 'admin', 'system')),
        created_by_id   TEXT    NOT NULL,
        created_at      TEXT    NOT NULL,
        updated_at      TEXT    NOT NULL,
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, parent_id, name),
        CHECK (
          (scope = 'workspace' AND agent_id IS NULL)
          OR (scope = 'agent' AND agent_id IS NOT NULL)
        ),
        CHECK (
          (is_directory = 1 AND content IS NULL)
          OR (is_directory = 0 AND content IS NOT NULL)
        ),
        CHECK (is_directory = 0 OR size = 0)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS workspace_nodes_scope_idx
        ON workspace_nodes (workspace_id, scope, agent_id);

      CREATE TABLE IF NOT EXISTS write_leases (
        lease_id     TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        scope        TEXT NOT NULL CHECK (scope IN ('workspace', 'agent')),
        agent_id     TEXT,
        task_id      TEXT NOT NULL,
        path         TEXT NOT NULL,
        holder_type  TEXT NOT NULL CHECK (holder_type IN ('user', 'agent', 'runtime', 'admin', 'system')),
        holder_id    TEXT NOT NULL,
        acquired_at  TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        renewed_at   TEXT,
        released_at  TEXT,
        PRIMARY KEY (workspace_id, lease_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS write_leases_by_path_idx
        ON write_leases (workspace_id, path);

      CREATE INDEX IF NOT EXISTS write_leases_by_task_idx
        ON write_leases (workspace_id, task_id);

      CREATE TABLE IF NOT EXISTS artifact_refs (
        artifact_id       TEXT    NOT NULL,
        workspace_id      TEXT    NOT NULL,
        name              TEXT    NOT NULL,
        artifact_type     TEXT    NOT NULL,
        size              INTEGER NOT NULL CHECK (size >= 0),
        mime_type         TEXT    NOT NULL,
        content           BLOB    NOT NULL,
        producer_agent_id TEXT,
        producer_task_id  TEXT    NOT NULL,
        created_at        TEXT    NOT NULL,
        PRIMARY KEY (workspace_id, artifact_id)
      ) STRICT;
    `,
  },
  {
    version: 10,
    name: "approval-records",
    sql: `
      CREATE TABLE IF NOT EXISTS approval_requests (
        workspace_id        TEXT    NOT NULL,
        approval_id         TEXT    NOT NULL,
        task_id             TEXT    NOT NULL,
        conversation_id     TEXT    NOT NULL,
        tool_id             TEXT    NOT NULL,
        tool_version        TEXT    NOT NULL,
        capability          TEXT    NOT NULL,
        risk_class          TEXT    NOT NULL CHECK (risk_class IN (
          'READ_ONLY', 'LOCAL_MUTATION', 'DESTRUCTIVE_LOCAL', 'EXTERNAL_WRITE',
          'CREDENTIAL_ACCESS', 'DEPLOYMENT', 'FINANCIAL_OR_IRREVERSIBLE')),
        resource_scope      TEXT    NOT NULL,
        args_digest         TEXT    NOT NULL,
        side_effect_summary TEXT    NOT NULL,
        requested_by_json   TEXT    NOT NULL CHECK (json_valid(requested_by_json)),
        requested_at        TEXT    NOT NULL,
        status              TEXT    NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
        resolved_at         TEXT,
        resolved_by_choice  TEXT    CHECK (resolved_by_choice IS NULL OR resolved_by_choice IN (
          'approve-this-execution-only', 'always-approve-this-tool',
          'always-approve-this-tool-for-this-agent', 'reject-this-action',
          'cancel-the-task')),
        PRIMARY KEY (workspace_id, approval_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS approval_requests_by_task_idx
        ON approval_requests (workspace_id, task_id);

      CREATE INDEX IF NOT EXISTS approval_requests_by_status_idx
        ON approval_requests (workspace_id, status);

      CREATE TABLE IF NOT EXISTS approval_grants (
        workspace_id       TEXT    NOT NULL,
        grant_id           TEXT    NOT NULL,
        source_choice      TEXT    NOT NULL CHECK (source_choice IN (
          'approve-this-execution-only', 'always-approve-this-tool',
          'always-approve-this-tool-for-this-agent')),
        principal_type     TEXT    NOT NULL CHECK (principal_type IN ('user', 'agent', 'task')),
        principal_id       TEXT    NOT NULL,
        tool_id            TEXT    NOT NULL,
        tool_version       TEXT    NOT NULL,
        capability         TEXT    NOT NULL,
        resource_scope     TEXT    NOT NULL,
        conversation_scope TEXT    NOT NULL,
        workspace_scope    TEXT    NOT NULL,
        expires_at         TEXT,
        one_time           INTEGER NOT NULL CHECK (one_time IN (0, 1)),
        created_by_json    TEXT    NOT NULL CHECK (json_valid(created_by_json)),
        approved_at        TEXT    NOT NULL,
        revoked_at         TEXT,
        PRIMARY KEY (workspace_id, grant_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS approval_grants_by_principal_idx
        ON approval_grants (workspace_id, principal_type, principal_id);

      CREATE INDEX IF NOT EXISTS approval_grants_by_tool_idx
        ON approval_grants (workspace_id, tool_id);

      CREATE TABLE IF NOT EXISTS approval_reminders (
        workspace_id   TEXT    NOT NULL,
        approval_id    TEXT    NOT NULL,
        reminder_index INTEGER NOT NULL CHECK (reminder_index BETWEEN 0 AND 4),
        due_at         TEXT    NOT NULL,
        delivered_at   TEXT,
        PRIMARY KEY (workspace_id, approval_id, reminder_index)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS approval_reminders_due_idx
        ON approval_reminders (workspace_id, due_at);

      CREATE TABLE IF NOT EXISTS approval_mutes (
        workspace_id TEXT    NOT NULL,
        mute_id      TEXT    NOT NULL,
        scope        TEXT    NOT NULL CHECK (scope IN ('approval', 'task', 'all')),
        target_id    TEXT,
        created_at   TEXT    NOT NULL,
        PRIMARY KEY (workspace_id, mute_id)
      ) STRICT;
    `,
  },
];

/**
 * Diagnostic read (adapter-internal, AC7): the applied migration versions in
 * ascending order. Tests pin the chain head through this helper instead of
 * running raw SQL outside adapters/sqlite.
 */
export function appliedMigrationVersions(db: DatabaseSync): number[] {
  return (
    db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
      version: number | bigint;
    }[]
  ).map((row) => (typeof row.version === "bigint" ? Number(row.version) : row.version));
}

/**
 * Diagnostic read (adapter-internal, AC7): true when the named table exists
 * in the current schema. Catalog introspection goes through `PRAGMA
 * table_list` — the SQLite catalog interface — because it reads NO product
 * rows (schema metadata only, like the schema_migrations bookkeeping), so the
 * E12 workspace predicate does not apply to it.
 */
export function sqliteTableExists(db: DatabaseSync, tableName: string): boolean {
  const rows = db.prepare("PRAGMA table_list").all() as Array<
    Record<string, string | number | bigint | null>
  >;
  return rows.some(
    (row) => row.schema === "main" && row.type === "table" && row.name === tableName,
  );
}

export function applyMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const applied = new Set(
    (
      db.prepare("SELECT version FROM schema_migrations").all() as { version: number | bigint }[]
    ).map((row) => (typeof row.version === "bigint" ? Number(row.version) : row.version)),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction may already have been rolled back by SQLite; the
        // original error below is the one that matters.
      }
      throw error;
    }
  }
}
