/**
 * Workspace files storage repository (S17 chunk 1; PRD §4.3, D6, D23 rule 8,
 * D39, E12, AC16) — the only place workspace-files SQL lives.
 *
 * STORAGE IS ROW-BASED: every file and directory is a workspace_nodes row
 * (content is a BLOB in the row), so there is NO filesystem behind this tree —
 * traversal and symlink escapes are impossible at the storage layer by
 * construction. Path safety is therefore a URI-RESOLUTION property:
 * parseScopedWorkspaceUri either parses a URI into a path confined to its
 * scope subtree, or rejects it with the typed WorkspacePathError — percent
 * decoding happens BEFORE the segment checks, so %2e%2e, %2F and %5C cannot
 * smuggle traversal, separators, or null bytes past the raw-string checks
 * (the same ordering discipline as the S11 folder guard). There is no
 * normalization step that could widen a parsed path into an escape.
 *
 * Ownership rules (D39): the shared workspace:// tree and every Agent's
 * private agent://<agent_id>/ folder are scopes of ONE table. An Agent actor
 * may touch its OWN private scope and the shared workspace scope; another
 * Agent's private scope is the typed PrivateScopeDeniedError in EVERY
 * operation, before any row is read or written. The user actor — the panel
 * viewer — may access both scopes.
 *
 * Delete rules (G6, D6): delete is NEVER agent-triggered. An Agent actor gets
 * the typed AgentDeleteRefusedError in every scope (even its own folder);
 * only the user path deletes, and a non-empty directory refuses a
 * non-recursive delete. Scope denial is checked BEFORE the delete refusal, so
 * a cross-private agent delete reads as the denial, not the refusal.
 *
 * Write leases (D6, S17 chunk 2): concurrent reads are always allowed here;
 * every WRITE is gated through the write-lease gate (assertWriteAllowed of
 * the write-leases repository, injected at construction — the gate is a
 * required collaborator so an ungated repository cannot exist). A user write
 * is blocked only while an Agent holds an ACTIVE lease on the exact path
 * (WRITE_LEASE_CONFLICT carrying the holding Agent + task — the tooltip
 * data); an agent write requires an active lease held by its own task
 * (WRITE_LEASE_REQUIRED). Scope denial (D39) is checked BEFORE the gate, so a
 * cross-private agent write reads as the denial, not a lease error. Delete is
 * never agent-triggered (below) and directories are structural (no leases on
 * roots), so the gate covers the whole agent-writable surface.
 *
 * WORKSPACE SCOPING IS NOT OPTIONAL (E12): every method takes workspace_id
 * and every statement keys rows by it — the same URI in two workspaces is two
 * independent trees, and the same agent_id's private folder in two workspaces
 * are two independent folders.
 *
 * Scope roots are materialized rows with NULL parent_id, created
 * deterministically and idempotently (PRIMARY KEY (workspace_id, id)) the
 * first time a write/mkdir needs a parent under them. Read paths never
 * mutate: a fresh scope lists as [] and its root resolves to null until
 * something exists under it.
 */
import { randomUUID } from "node:crypto";

import type { DatabaseSync } from "node:sqlite";

import type { SqliteTransactions } from "./transactions.ts";

/**
 * The actor addressing the workspace file tree (D4 Actor subset): the storage
 * layer distinguishes the user panel path from an Agent's path, because the
 * private-folder denials (D39) and the delete refusal (G6) hang on exactly
 * that distinction. The runtime/admin/system actor kinds of the contracts'
 * Actor shape never address this repository directly — the gateway composes
 * user and Agent paths.
 */
export type WorkspaceStorageActor = { type: "user"; id: string } | { type: "agent"; id: string };

/**
 * The agent:// folder-URI host charset (packages/contracts agent.ts, mirrored
 * by the seeding boundary in agents-repository.ts). A seeded Agent's id always
 * satisfies it, so its private folder root is always addressable here.
 */
const AGENT_HOST_CHARSET = /^[a-z0-9_-]+$/;

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

/**
 * The typed rejection for a URI that is not a safe scoped address: a foreign
 * scheme, an out-of-charset agent host, traversal or dot segments (raw OR
 * percent-encoded), backslash separators (raw OR %5C), an encoded slash
 * inside a segment, empty segments (double slashes, leading slashes), control
 * characters (raw OR %00), or malformed percent-escapes. Validation-category:
 * malformed INPUT — the message never echoes the hostile input (G3).
 */
export class WorkspacePathError extends Error {
  readonly code = "WORKSPACE_PATH_INVALID" as const;
  readonly category = "validation" as const;

  constructor() {
    super("the URI is not a safe workspace:// or agent://<agent_id>/<path> address");
    this.name = "WorkspacePathError";
  }
}

/**
 * The typed rejection for an addressed node that does not exist in THIS
 * workspace (E12: existence is always workspace-scoped). The path is the
 * caller's own input and is echoed as an identifier, never as content (G3).
 */
export class WorkspaceNodeNotFoundError extends Error {
  readonly code = "WORKSPACE_NODE_NOT_FOUND" as const;
  readonly category = "state" as const;

  constructor(workspaceId: string, uri: string) {
    super(`workspace node ${uri} not found in workspace ${workspaceId}`);
    this.name = "WorkspaceNodeNotFoundError";
  }
}

/**
 * The typed rejection for an operation whose target node is the WRONG KIND:
 * reading a directory, listing a file, writing over a directory, deleting the
 * structural scope root, or a file sitting in the middle of a path.
 */
export class WorkspaceNodeTypeError extends Error {
  readonly code = "WORKSPACE_NODE_TYPE_CONFLICT" as const;
  readonly category = "state" as const;

  constructor() {
    super("the addressed node kind does not allow this operation");
    this.name = "WorkspaceNodeTypeError";
  }
}

/**
 * The typed denial for an Agent reaching another Agent's private folder (D39)
 * — runtime-level, checked before any row is touched, in every operation.
 * Carries the stable code/category pair so the transport's typed error
 * middleware maps it onto the SheraError taxonomy (403) without
 * special-casing; agent ids are identifiers, not secrets (G3).
 */
export class PrivateScopeDeniedError extends Error {
  readonly code = "PRIVATE_SCOPE_DENIED" as const;
  readonly category = "unauthorized" as const;

  constructor(actorAgentId: string, ownerAgentId: string) {
    super(`agent ${actorAgentId} may not access agent ${ownerAgentId}'s private folder`);
    this.name = "PrivateScopeDeniedError";
  }
}

/**
 * The typed refusal for an Agent-triggered delete (G6, D6): agents never
 * delete workspace files — shared OR private — because delete is a
 * DESTRUCTIVE_LOCAL effect gated by the user approval path. The refusal is
 * scope-uniform; the approval-path delete lands with the runtime slice that
 * owns approvals, not as a repository bypass.
 */
export class AgentDeleteRefusedError extends Error {
  readonly code = "AGENT_DELETE_REQUIRES_APPROVAL" as const;
  readonly category = "unauthorized" as const;

  constructor(actorAgentId: string) {
    super(`agent ${actorAgentId} cannot delete workspace files; delete requires the user approval path`);
    this.name = "AgentDeleteRefusedError";
  }
}

/** The typed rejection for deleting (or replacing) a non-empty directory. */
export class WorkspaceDirectoryNotEmptyError extends Error {
  readonly code = "WORKSPACE_DIRECTORY_NOT_EMPTY" as const;
  readonly category = "state" as const;

  constructor() {
    super("the directory is not empty; a non-recursive delete refuses it");
    this.name = "WorkspaceDirectoryNotEmptyError";
  }
}

/** The parsed shape of a scoped storage URI. */
export interface ParsedScopedUri {
  scope: "workspace" | "agent";
  /** The owning Agent when scope is 'agent'; null for the shared scope. */
  agent_id: string | null;
  /**
   * Percent-decoded, validated segments INSIDE the scope; [] is the scope
   * root. Never contains '', '.', '..' segments, separators, or control
   * characters.
   */
  segments: string[];
}

/**
 * Parse one `workspace://<relative-path>` or `agent://<agent_id>/<path>` URI,
 * or reject it as the typed WorkspacePathError. Safety rules, in order:
 *
 * - the scheme must be exactly `workspace://` or `agent://`;
 * - the raw URI must carry no control characters;
 * - an agent host must match the contracts' agent:// charset (a seeded
 *   Agent's id always does; uppercase or spaced hosts are rejections, not
 *   case-normalized aliases);
 * - every path segment is percent-DECODED first (a malformed escape such as
 *   %ZZ is a rejection, not a crash), then checked: it must not be empty (''
 *   — no double or leading slashes), '.', '..', contain '/' or '\', or carry
 *   a control character. A single trailing slash is the root marker and is
 *   dropped.
 *
 * A URI either parses to a path confined to its scope's subtree or fails —
 * there is no normalization step that could widen it into an escape.
 */
export function parseScopedWorkspaceUri(uri: string): ParsedScopedUri {
  if (hasControlCharacter(uri)) throw new WorkspacePathError();

  if (uri.startsWith("workspace://")) {
    return { scope: "workspace", agent_id: null, segments: parseSegments(uri.slice("workspace://".length)) };
  }
  if (uri.startsWith("agent://")) {
    const afterScheme = uri.slice("agent://".length);
    const hostEnd = afterScheme.indexOf("/");
    const agentId = hostEnd < 0 ? afterScheme : afterScheme.slice(0, hostEnd);
    if (!AGENT_HOST_CHARSET.test(agentId)) throw new WorkspacePathError();
    const rawPath = hostEnd < 0 ? "" : afterScheme.slice(hostEnd + 1);
    return { scope: "agent", agent_id: agentId, segments: parseSegments(rawPath) };
  }
  throw new WorkspacePathError();
}

function parseSegments(rawPath: string): string[] {
  const segments = rawPath.split("/");
  // A single trailing slash is the root marker; every OTHER empty segment
  // (leading slash, double slash) is invalid.
  if (segments[segments.length - 1] === "") segments.pop();
  const decoded: string[] = [];
  for (const segment of segments) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      throw new WorkspacePathError();
    }
    if (value === "" || value === "." || value === "..") throw new WorkspacePathError();
    if (value.includes("/") || value.includes("\\")) throw new WorkspacePathError();
    if (hasControlCharacter(value)) throw new WorkspacePathError();
    decoded.push(value);
  }
  return decoded;
}

/** One workspace_nodes row WITHOUT content (tree/view shape). */
export interface WorkspaceNode {
  id: string;
  workspace_id: string;
  scope: "workspace" | "agent";
  agent_id: string | null;
  parent_id: string | null;
  name: string;
  is_directory: 0 | 1;
  size: number;
  mime_type: string | null;
  created_by_type: string;
  created_by_id: string;
  created_at: string;
  updated_at: string;
}

/** A file node WITH its content (read/write result shape). */
export interface WorkspaceFileContent extends WorkspaceNode {
  content: Uint8Array;
}

/** Options for the user-path delete. */
export interface WorkspaceDeleteOptions {
  /** Delete a directory and its whole subtree. Default: false. */
  recursive?: boolean;
}

/** Options for the gated write path. */
export interface WorkspaceWriteOptions {
  /**
   * The Agent's task requesting the write (D6: agent writes are task-scoped
   * and lease-gated). Required for agent writes to pass the lease gate;
   * ignored for user writes.
   */
  task_id?: string;
}

/**
 * The write-lease gate every write goes through (D6, S17 chunk 2). Satisfied
 * structurally by WriteLeasesRepository.assertWriteAllowed — declared here so
 * the files repository never imports the leases repository (the dependency
 * points one way: leases → files, for the shared URI parser).
 */
export interface WorkspaceWriteLeaseGate {
  assertWriteAllowed(
    workspaceId: string,
    uri: string,
    actor: WorkspaceStorageActor,
    taskId?: string,
  ): void;
}

/** Deterministic root ids/names: one shared root, one root per Agent scope. */
function scopeRootId(scope: "workspace" | "agent", agentId: string | null): string {
  return scope === "workspace" ? "root:workspace" : `root:agent:${agentId}`;
}

function scopeRootName(scope: "workspace" | "agent", agentId: string | null): string {
  return scope === "workspace" ? "workspace" : `agent:${agentId}`;
}

const NODE_COLUMNS = `
  id,
  workspace_id,
  scope,
  agent_id,
  parent_id,
  name,
  is_directory,
  size,
  mime_type,
  created_by_type,
  created_by_id,
  created_at,
  updated_at`;

type NodeRow = Omit<WorkspaceNode, "is_directory" | "scope"> & {
  is_directory: number;
  scope: string;
};

function toNode(row: NodeRow): WorkspaceNode {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    scope: row.scope as "workspace" | "agent",
    agent_id: row.agent_id,
    parent_id: row.parent_id,
    name: row.name,
    is_directory: row.is_directory === 1 ? 1 : 0,
    size: Number(row.size),
    mime_type: row.mime_type,
    created_by_type: row.created_by_type,
    created_by_id: row.created_by_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class WorkspaceFilesRepository {
  /**
   * The write-lease gate is a REQUIRED collaborator (D6, G5): there is no
   * ungated construction, so a silent lease bypass is unrepresentable. Repos
   * sharing one database share one SqliteTransactions instance.
   */
  constructor(
    private readonly tx: SqliteTransactions,
    private readonly writeLeases: WorkspaceWriteLeaseGate,
  ) {}

  /**
   * Write (create or replace) one file. Missing parent directories are
   * auto-created; rewriting an existing file replaces content/size/mime in
   * place (same id, created_by preserved — the first writer's provenance
   * stays). The write goes through the lease gate FIRST (D6): a user write
   * is blocked by an active agent lease on the exact path, an agent write
   * requires its own task's active lease — refused writes mutate nothing.
   * Runs in one short transaction; a call inside an open transaction joins it.
   */
  write(
    workspaceId: string,
    uri: string,
    actor: WorkspaceStorageActor,
    content: Uint8Array,
    mimeType: string | null,
    options?: WorkspaceWriteOptions,
  ): WorkspaceFileContent {
    const parsed = parseScopedWorkspaceUri(uri);
    this.assertScopeAccess(actor, parsed);
    // A file needs a final segment: the scope root itself is structural
    // (like delete), so writing "workspace://" is a kind error, not a crash.
    const name = parsed.segments[parsed.segments.length - 1];
    if (name === undefined) throw new WorkspaceNodeTypeError();
    // D6 lease gate: after URI + scope validation, before any row is touched.
    this.writeLeases.assertWriteAllowed(workspaceId, uri, actor, options?.task_id);
    return this.tx.transaction((db) => {
      const parentId = this.materializeParents(db, workspaceId, parsed, actor);
      const now = new Date().toISOString();
      const existing = this.findChild(db, workspaceId, parsed, parentId, name);

      if (existing !== undefined) {
        if (existing.is_directory === 1) throw new WorkspaceNodeTypeError();
        db.prepare(
          `UPDATE workspace_nodes
           SET size = ?, mime_type = ?, content = ?, updated_at = ?
           WHERE workspace_id = ? AND id = ?`,
        ).run(content.byteLength, mimeType, content, now, workspaceId, existing.id);
        return this.readFileContent(db, workspaceId, existing.id);
      }

      const id = `node_${randomUUID()}`;
      db.prepare(
        `INSERT INTO workspace_nodes (
           id, workspace_id, scope, agent_id, parent_id, name,
           is_directory, size, mime_type, content,
           created_by_type, created_by_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        workspaceId,
        parsed.scope,
        parsed.agent_id,
        parentId,
        name,
        content.byteLength,
        mimeType,
        content,
        actor.type,
        actor.id,
        now,
        now,
      );
      return this.readFileContent(db, workspaceId, id);
    });
  }

  /**
   * Read one file byte-exact. Directories are a typed kind error — content
   * travels only through read().
   */
  read(workspaceId: string, uri: string, actor: WorkspaceStorageActor): WorkspaceFileContent {
    const node = this.resolveOrThrow(workspaceId, uri, actor);
    if (node.is_directory === 1) throw new WorkspaceNodeTypeError();
    return this.readFileContent(this.tx.connection(), workspaceId, node.id);
  }

  /**
   * Resolve a URI to its tree row (metadata only — content never rides the
   * resolution), or null when the node does not exist. A fresh scope's root
   * resolves to null until something exists under it.
   */
  resolve(workspaceId: string, uri: string, actor: WorkspaceStorageActor): WorkspaceNode | null {
    const parsed = parseScopedWorkspaceUri(uri);
    this.assertScopeAccess(actor, parsed);
    const db = this.tx.connection();
    const row = this.findNodeByUri(db, workspaceId, parsed);
    return row === null ? null : toNode(row);
  }

  /**
   * List one directory's children — directories first, then files, each by
   * name (the Files tab's stable ordering). A fresh scope's root lists as []
   * (reads never materialize rows); any other missing directory is a typed
   * not-found.
   */
  list(workspaceId: string, uri: string, actor: WorkspaceStorageActor): WorkspaceNode[] {
    const parsed = parseScopedWorkspaceUri(uri);
    this.assertScopeAccess(actor, parsed);
    const db = this.tx.connection();
    const row = this.findNodeByUri(db, workspaceId, parsed);
    if (row === null) {
      if (parsed.segments.length === 0) return [];
      throw new WorkspaceNodeNotFoundError(workspaceId, uri);
    }
    if (row.is_directory !== 1) throw new WorkspaceNodeTypeError();
    return this.listChildren(db, workspaceId, row.id);
  }

  /**
   * Create a directory. Idempotent: an existing directory returns the SAME
   * row (same id); an existing file in the target position (or mid-path) is a
   * typed kind error. Missing parents are auto-created, matching write().
   */
  mkdir(workspaceId: string, uri: string, actor: WorkspaceStorageActor): WorkspaceNode {
    const parsed = parseScopedWorkspaceUri(uri);
    this.assertScopeAccess(actor, parsed);
    // The scope roots are structural (created implicitly by writes): mkdir of
    // the root itself is the same kind error as deleting it.
    const name = parsed.segments[parsed.segments.length - 1];
    if (name === undefined) throw new WorkspaceNodeTypeError();
    return this.tx.transaction((db) => {
      const parentId = this.materializeParents(db, workspaceId, parsed, actor);
      const existing = this.findChild(db, workspaceId, parsed, parentId, name);
      if (existing !== undefined) {
        if (existing.is_directory !== 1) throw new WorkspaceNodeTypeError();
        return toNode(existing);
      }
      const now = new Date().toISOString();
      const id = `node_${randomUUID()}`;
      db.prepare(
        `INSERT INTO workspace_nodes (
           id, workspace_id, scope, agent_id, parent_id, name,
           is_directory, size, mime_type, content,
           created_by_type, created_by_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, NULL, NULL, ?, ?, ?, ?)`,
      ).run(
        id,
        workspaceId,
        parsed.scope,
        parsed.agent_id,
        parentId,
        name,
        actor.type,
        actor.id,
        now,
        now,
      );
      return toNode(this.findNodeById(db, workspaceId, id) as NodeRow);
    });
  }

  /**
   * USER-PATH delete. Agent actors are refused BEFORE any row is touched
   * (AgentDeleteRefusedError, every scope — G6/D6); the scope denial is
   * checked first so a cross-private agent delete reads as the denial.
   * Files delete outright; directories require recursive: true when
   * non-empty (the subtree goes atomically with the directory). The scope
   * roots are structural and cannot be deleted.
   */
  delete(
    workspaceId: string,
    uri: string,
    actor: WorkspaceStorageActor,
    options?: WorkspaceDeleteOptions,
  ): void {
    const parsed = parseScopedWorkspaceUri(uri);
    this.assertScopeAccess(actor, parsed);
    if (actor.type === "agent") throw new AgentDeleteRefusedError(actor.id);
    if (parsed.segments.length === 0) throw new WorkspaceNodeTypeError();

    this.tx.transaction((db) => {
      const row = this.findNodeByUri(db, workspaceId, parsed);
      if (row === null) throw new WorkspaceNodeNotFoundError(workspaceId, uri);
      if (row.is_directory === 1 && options?.recursive !== true) {
        const child = db
          .prepare(
            `SELECT id FROM workspace_nodes WHERE workspace_id = ? AND parent_id = ? LIMIT 1`,
          )
          .get(workspaceId, row.id);
        if (child !== undefined) throw new WorkspaceDirectoryNotEmptyError();
      }
      if (row.is_directory === 1) {
        db.prepare(
          `WITH RECURSIVE subtree(id) AS (
             SELECT id FROM workspace_nodes WHERE workspace_id = ? AND id = ?
             UNION ALL
             SELECT child.id FROM workspace_nodes child
               JOIN subtree ON child.parent_id = subtree.id
             WHERE child.workspace_id = ?
           )
           DELETE FROM workspace_nodes
             WHERE workspace_id = ? AND id IN (SELECT id FROM subtree)`,
        ).run(workspaceId, row.id, workspaceId, workspaceId);
      } else {
        db.prepare(`DELETE FROM workspace_nodes WHERE workspace_id = ? AND id = ?`).run(
          workspaceId,
          row.id,
        );
      }
    });
  }

  /**
   * D39 (private folders) + panel access: an Agent may address its OWN
   * private scope and the shared workspace scope; another Agent's private
   * scope is denied in EVERY operation, before any row is read or written.
   * The user actor — the panel viewer — may access both scopes.
   */
  private assertScopeAccess(actor: WorkspaceStorageActor, parsed: ParsedScopedUri): void {
    if (parsed.scope === "agent" && actor.type === "agent" && actor.id !== parsed.agent_id) {
      throw new PrivateScopeDeniedError(actor.id, parsed.agent_id as string);
    }
  }

  /**
   * The id of the direct parent of parsed.segments: the scope root row,
   * materialized (idempotently, deterministic id) if absent, plus any missing
   * intermediate directories. A file mid-path is a typed kind error. Must run
   * inside the caller's transaction.
   */
  private materializeParents(
    db: DatabaseSync,
    workspaceId: string,
    parsed: ParsedScopedUri,
    actor: WorkspaceStorageActor,
  ): string {
    const rootId = scopeRootId(parsed.scope, parsed.agent_id);
    const root = this.findNodeById(db, workspaceId, rootId);
    if (root === undefined) {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO workspace_nodes (
           id, workspace_id, scope, agent_id, parent_id, name,
           is_directory, size, mime_type, content,
           created_by_type, created_by_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, 1, 0, NULL, NULL, ?, ?, ?, ?)`,
      ).run(
        rootId,
        workspaceId,
        parsed.scope,
        parsed.agent_id,
        scopeRootName(parsed.scope, parsed.agent_id),
        actor.type,
        actor.id,
        now,
        now,
      );
    }

    let parentId = rootId;
    // All segments EXCEPT the final one become directories (the caller owns
    // the final segment). Iteration (not index access) keeps every name a
    // definite string.
    for (const name of parsed.segments.slice(0, -1)) {
      const existing = this.findChild(db, workspaceId, parsed, parentId, name);
      if (existing !== undefined) {
        if (existing.is_directory !== 1) throw new WorkspaceNodeTypeError();
        parentId = existing.id;
        continue;
      }
      const now = new Date().toISOString();
      const id = `node_${randomUUID()}`;
      db.prepare(
        `INSERT INTO workspace_nodes (
           id, workspace_id, scope, agent_id, parent_id, name,
           is_directory, size, mime_type, content,
           created_by_type, created_by_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, NULL, NULL, ?, ?, ?, ?)`,
      ).run(
        id,
        workspaceId,
        parsed.scope,
        parsed.agent_id,
        parentId,
        name,
        actor.type,
        actor.id,
        now,
        now,
      );
      parentId = id;
    }
    return parentId;
  }

  /** Row lookup walking from the scope root, or null anywhere along the way. */
  private findNodeByUri(
    db: DatabaseSync,
    workspaceId: string,
    parsed: ParsedScopedUri,
  ): NodeRow | null {
    const root = this.findNodeById(db, workspaceId, scopeRootId(parsed.scope, parsed.agent_id));
    if (root === undefined) return null;
    if (parsed.segments.length === 0) return root;

    let parentId: string = root.id;
    let row: NodeRow | undefined;
    for (const segment of parsed.segments) {
      row = this.findChild(db, workspaceId, parsed, parentId, segment);
      if (row === undefined) return null;
      parentId = row.id;
    }
    return row as NodeRow;
  }

  private findNodeById(db: DatabaseSync, workspaceId: string, id: string): NodeRow | undefined {
    return db
      .prepare(`SELECT ${NODE_COLUMNS} FROM workspace_nodes WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, id) as NodeRow | undefined;
  }

  /**
   * Child lookup under one parent. The scope predicates re-state what the
   * parent chain already implies (a subtree never crosses scopes) — cheap,
   * explicit defense so no query can ever reach across a scope boundary.
   */
  private findChild(
    db: DatabaseSync,
    workspaceId: string,
    parsed: ParsedScopedUri,
    parentId: string,
    name: string,
  ): NodeRow | undefined {
    if (parsed.scope === "workspace") {
      return db
        .prepare(
          `SELECT ${NODE_COLUMNS} FROM workspace_nodes
           WHERE workspace_id = ? AND parent_id = ? AND name = ?
             AND scope = 'workspace' AND agent_id IS NULL`,
        )
        .get(workspaceId, parentId, name) as NodeRow | undefined;
    }
    return db
      .prepare(
        `SELECT ${NODE_COLUMNS} FROM workspace_nodes
         WHERE workspace_id = ? AND parent_id = ? AND name = ?
           AND scope = 'agent' AND agent_id = ?`,
      )
      .get(workspaceId, parentId, name, parsed.agent_id) as NodeRow | undefined;
  }

  private listChildren(db: DatabaseSync, workspaceId: string, parentId: string): WorkspaceNode[] {
    return (
      db
        .prepare(
          `SELECT ${NODE_COLUMNS} FROM workspace_nodes
           WHERE workspace_id = ? AND parent_id = ?
           ORDER BY is_directory DESC, name ASC`,
        )
        .all(workspaceId, parentId) as NodeRow[]
    ).map(toNode);
  }

  private readFileContent(
    db: DatabaseSync,
    workspaceId: string,
    id: string,
  ): WorkspaceFileContent {
    const row = db
      .prepare(
        `SELECT ${NODE_COLUMNS}, content FROM workspace_nodes
         WHERE workspace_id = ? AND id = ?`,
      )
      .get(workspaceId, id) as (NodeRow & { content: Uint8Array }) | undefined;
    if (row === undefined) throw new WorkspaceNodeNotFoundError(workspaceId, id);
    return { ...toNode(row), content: row.content };
  }

  private resolveOrThrow(
    workspaceId: string,
    uri: string,
    actor: WorkspaceStorageActor,
  ): WorkspaceNode {
    const node = this.resolve(workspaceId, uri, actor);
    if (node === null) throw new WorkspaceNodeNotFoundError(workspaceId, uri);
    return node;
  }
}
