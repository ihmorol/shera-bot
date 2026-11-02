/**
 * Write-leases repository (S17 chunk 2; PRD §4.3, D6, G5, G6) — the only
 * place write_leases SQL lives.
 *
 * LEASE VOCABULARY is the established one (Temporal/Kubernetes): a lease has a
 * HOLDER (here: always a task — task_id NOT NULL — acting through a user or
 * Agent actor), an EXPIRY (expires_at, extended by renew), and REVOCATION
 * (release). No invented variants.
 *
 * THE CONTRACT (D6): concurrent reads are ALWAYS allowed (they never touch
 * this table); every WRITE requires a task-scoped lease on the exact path.
 * Exclusivity is per exact path WITHIN a workspace: a second ACTIVE lease on
 * the same path is refused with the typed LEASE_CONFLICT naming the existing
 * holder + task. There is no silent overwrite (G5): contention surfaces as a
 * typed error and STOPS.
 *
 * LEASE PATHS are scoped URIs (`workspace://<path>` or
 * `agent://<agent_id>/<path>`) validated with the SAME parser as the nodes
 * table (parseScopedWorkspaceUri) and stored CANONICALLY, so equivalent URI
 * spellings (percent-encoding, a trailing slash) collide into one lease path.
 * A scope root is structural — no lease can be taken on it (the same
 * WorkspaceNodeTypeError a root write gets).
 *
 * EXPIRY uses an injectable clock. An expired lease (expires_at <= now) no
 * longer blocks anything: a new acquirer wins the path and the lapsed row is
 * marked released (steal-by-expiry). A lapsed lease cannot be renewed — the
 * path must be re-acquired.
 *
 * FORCE-RELEASE POLICY (steal-by-policy): the runtime releases a task's leases
 * ONLY through releaseLeasesForTask when the task reaches a terminal state —
 * completion, cancellation, failure, or process death (the gateway calls it
 * from the task-finish seam; S17 chunk 3 wires that call). A lease NEVER
 * outlives its task. There is deliberately NO mid-task, path-scoped steal: if
 * someone else needs a leased path while the task is live, they get the typed
 * conflict and stop (G5).
 *
 * THE WRITE GATE (assertWriteAllowed) is what the workspace-files repository
 * routes every write through:
 * - a user write is blocked ONLY by an ACTIVE lease whose holder is an Agent —
 *   the typed WRITE_LEASE_CONFLICT carries the tooltip data (holding Agent
 *   name/id + task identifier, "Developer is editing this file · task #4");
 *   user-held leases never block the panel user;
 * - an agent write requires an ACTIVE lease held by ITS OWN task (and its own
 *   agent id) on that exact path; otherwise the typed WRITE_LEASE_REQUIRED —
 *   naming a foreign holder + task when one exists, so the conflict is
 *   visible, never absorbed.
 *
 * THE DELETE GATE (gateDelete — the F1 review fix) is what the files
 * repository routes every USER delete through: an ACTIVE agent-held lease on
 * the deleted path (or on any path under a deleted directory) blocks with the
 * same WriteLeaseConflictError; user-held leases never block the panel user;
 * and a passing delete purges released-or-expired rows on the deleted paths so
 * no stale lease resurrects deleted content. Agent deletes are refused by the
 * files repository before any gate (G6); mkdir stays deliberately ungated
 * (structural, creates-only) — the write plus delete gates cover every
 * mutating or destructive path.
 *
 * The agent display NAME for conflict reporting is injected
 * (agentNameResolver): this repository owns write_leases SQL only and never
 * queries the agents table (each repository owns its tables' SQL); the
 * composition layer wires the agents-repository lookup, and an unwired or
 * missing name falls back to the agent id.
 *
 * WORKSPACE SCOPING IS NOT OPTIONAL (E12): exclusivity, lookups, and cleanup
 * key rows by workspace_id (task ids and lease ids are runtime-minted UUIDs,
 * unique across workspaces in practice).
 */
import { randomUUID } from "node:crypto";

import type { DatabaseSync } from "node:sqlite";

import type { SqliteTransactions } from "./transactions.ts";
import {
  parseScopedWorkspaceUri,
  PrivateScopeDeniedError,
  WorkspaceNodeTypeError,
  type ParsedScopedUri,
  type WorkspaceStorageActor,
} from "./workspace-files-repository.ts";

/** The typed rejection for acquiring over an ACTIVE lease on the same path. */
export class LeaseConflictError extends Error {
  readonly code = "LEASE_CONFLICT" as const;
  readonly category = "conflict" as const;

  constructor(
    readonly holder_type: string,
    readonly holder_id: string,
    readonly task_id: string,
    readonly path: string,
  ) {
    super(`path ${path} is already leased by task ${task_id} (holder ${holder_type} ${holder_id})`);
    this.name = "LeaseConflictError";
  }
}

/** The typed rejection for renewing a lease whose expiry has passed. */
export class LeaseExpiredError extends Error {
  readonly code = "LEASE_EXPIRED" as const;
  readonly category = "conflict" as const;

  constructor(
    readonly leaseId: string,
    readonly taskId: string,
    readonly expiredAt: string,
  ) {
    super(`lease ${leaseId} expired at ${expiredAt}; re-acquire the path instead of renewing`);
    this.name = "LeaseExpiredError";
  }
}

/**
 * The typed refusal for a lease operation by a task that does not hold the
 * lease (unknown lease, foreign task, or already-released lease).
 */
export class LeaseNotHeldError extends Error {
  readonly code = "LEASE_NOT_HELD" as const;
  readonly category = "unauthorized" as const;

  constructor(
    readonly leaseId: string,
    readonly taskId: string,
  ) {
    super(`task ${taskId} does not hold lease ${leaseId}`);
    this.name = "LeaseNotHeldError";
  }
}

/** The typed rejection for a non-positive lease TTL. */
export class LeaseTtlInvalidError extends Error {
  readonly code = "LEASE_TTL_INVALID" as const;
  readonly category = "validation" as const;

  constructor(readonly ttlMs: number) {
    super("a lease TTL must be a positive number of milliseconds");
    this.name = "LeaseTtlInvalidError";
  }
}

/**
 * The typed conflict blocking a USER write: an Agent holds an active lease on
 * the exact path. Carries the tooltip data — holding Agent name/id + task
 * identifier ("Developer is editing this file · task #4"). Agent ids and task
 * ids are identifiers, not secrets (G3).
 */
export class WriteLeaseConflictError extends Error {
  readonly code = "WRITE_LEASE_CONFLICT" as const;
  readonly category = "conflict" as const;

  constructor(
    readonly holdingAgentId: string,
    readonly holdingAgentName: string,
    readonly taskId: string,
    readonly path: string,
  ) {
    super(`${holdingAgentName} (agent ${holdingAgentId}) is editing ${path} in task ${taskId}`);
    this.name = "WriteLeaseConflictError";
  }
}

/**
 * The typed refusal for an AGENT write without an active lease held by its
 * own task on the exact path. When a foreign task's active lease exists, the
 * fields name it (the conflict is surfaced, never absorbed — G5).
 */
export class WriteLeaseRequiredError extends Error {
  readonly code = "WRITE_LEASE_REQUIRED" as const;
  readonly category = "conflict" as const;

  constructor(
    readonly agentId: string,
    readonly path: string,
    readonly conflictingTaskId: string | null,
    readonly conflictingHolderId: string | null,
  ) {
    const message =
      conflictingTaskId !== null && conflictingHolderId !== null
        ? `agent ${agentId} may not write ${path}: task ${conflictingTaskId} (agent ${conflictingHolderId}) holds the lease`
        : `agent ${agentId} may not write ${path} without a lease held by its own task`;
    super(message);
    this.name = "WriteLeaseRequiredError";
  }
}

/** One write_leases row (the durable lease). */
export interface WriteLease {
  lease_id: string;
  workspace_id: string;
  scope: "workspace" | "agent";
  agent_id: string | null;
  /** The lease holder is ALWAYS a task (D6: task-scoped). */
  task_id: string;
  /** Canonical scoped URI of the leased path. */
  path: string;
  holder_type: "user" | "agent";
  holder_id: string;
  acquired_at: string;
  expires_at: string;
  renewed_at: string | null;
  released_at: string | null;
}

/** Options for the write-leases repository. */
export interface WriteLeasesRepositoryOptions {
  /**
   * Injectable clock (tests, recovery replay). Default: the wall clock.
   */
  now?: () => Date;
  /**
   * Resolves an Agent's display name for conflict reporting (the tooltip
   * data). Unwired resolver or unknown agent → the agent id is used.
   */
  agentNameResolver?: (workspaceId: string, agentId: string) => string | null;
}

const LEASE_COLUMNS = `
  lease_id,
  workspace_id,
  scope,
  agent_id,
  task_id,
  path,
  holder_type,
  holder_id,
  acquired_at,
  expires_at,
  renewed_at,
  released_at`;

type LeaseRow = Omit<
  WriteLease,
  "scope" | "agent_id" | "holder_type" | "renewed_at" | "released_at"
> & {
  scope: string;
  agent_id: string | null;
  holder_type: string;
  renewed_at: string | null;
  released_at: string | null;
};

function toLease(row: LeaseRow): WriteLease {
  return {
    lease_id: row.lease_id,
    workspace_id: row.workspace_id,
    scope: row.scope as "workspace" | "agent",
    agent_id: row.agent_id,
    task_id: row.task_id,
    path: row.path,
    holder_type: row.holder_type as "user" | "agent",
    holder_id: row.holder_id,
    acquired_at: row.acquired_at,
    expires_at: row.expires_at,
    renewed_at: row.renewed_at,
    released_at: row.released_at,
  };
}

/**
 * Parse a lease path with the nodes-table parser and reject scope roots as
 * structural (WorkspaceNodeTypeError). Returns the parsed URI plus the
 * CANONICAL path string the lease table keys exclusivity on.
 */
function parseLeasePath(uri: string): { parsed: ParsedScopedUri; canonical: string } {
  const parsed = parseScopedWorkspaceUri(uri);
  if (parsed.segments.length === 0) throw new WorkspaceNodeTypeError();
  const base = parsed.scope === "workspace" ? "workspace://" : `agent://${parsed.agent_id}/`;
  return { parsed, canonical: base + parsed.segments.join("/") };
}

function assertTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new LeaseTtlInvalidError(ttlMs);
}

/**
 * Escape the LIKE wildcards a canonical lease path may legally contain
 * (decoded segment names may carry '%' or '_'; '\' is impossible — the URI
 * parser rejects it) so the subtree prefix match matches exactly.
 */
function likeSubtreePattern(canonicalPath: string): string {
  return `${canonicalPath.replace(/[\\%_]/g, (char) => `\\${char}`)}/%`;
}

export class WriteLeasesRepository {
  private readonly now: () => Date;
  private readonly agentNameResolver:
    ((workspaceId: string, agentId: string) => string | null) | null;

  constructor(
    private readonly tx: SqliteTransactions,
    options: WriteLeasesRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.agentNameResolver = options.agentNameResolver ?? null;
  }

  /**
   * Acquire an exclusive task-scoped lease on one path. A second ACTIVE lease
   * on the same canonical path (any holder, even the same task — a holder
   * renews, it does not re-acquire) is the typed LeaseConflictError. Expired
   * leases never block: the new acquirer wins and the lapsed rows on this
   * path are marked released. D39 applies to leasing: an Agent holder never
   * leases another Agent's private folder.
   */
  acquireLease(
    workspaceId: string,
    uri: string,
    taskId: string,
    // A lease holder is always a task's user or Agent work (D6: task-scoped)
    // — the runtime's own storage reader never holds a lease, so the holder
    // union stays the S17 pair even though the storage actor widened.
    holder: { type: "user" | "agent"; id: string },
    ttlMs: number,
  ): WriteLease {
    assertTtl(ttlMs);
    const { parsed, canonical } = parseLeasePath(uri);
    if (parsed.scope === "agent" && holder.type === "agent" && holder.id !== parsed.agent_id) {
      throw new PrivateScopeDeniedError(holder.id, parsed.agent_id as string);
    }

    return this.tx.transaction((db) => {
      const nowIso = this.now().toISOString();
      const active = this.findActiveLease(db, workspaceId, canonical, nowIso);
      if (active !== null) {
        throw new LeaseConflictError(
          active.holder_type,
          active.holder_id,
          active.task_id,
          canonical,
        );
      }
      // Steal-by-expiry: a lapsed lease loses the path; mark it released so
      // the table keeps at most one meaningful row per live holding.
      db.prepare(
        `UPDATE write_leases SET released_at = ?
         WHERE workspace_id = ? AND path = ? AND released_at IS NULL AND expires_at <= ?`,
      ).run(nowIso, workspaceId, canonical, nowIso);

      const lease: WriteLease = {
        lease_id: `lease_${randomUUID()}`,
        workspace_id: workspaceId,
        scope: parsed.scope,
        agent_id: parsed.agent_id,
        task_id: taskId,
        path: canonical,
        holder_type: holder.type,
        holder_id: holder.id,
        acquired_at: nowIso,
        expires_at: new Date(Date.parse(nowIso) + ttlMs).toISOString(),
        renewed_at: null,
        released_at: null,
      };
      db.prepare(
        `INSERT INTO write_leases (
           lease_id, workspace_id, scope, agent_id, task_id, path,
           holder_type, holder_id, acquired_at, expires_at, renewed_at, released_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      ).run(
        lease.lease_id,
        lease.workspace_id,
        lease.scope,
        lease.agent_id,
        lease.task_id,
        lease.path,
        lease.holder_type,
        lease.holder_id,
        lease.acquired_at,
        lease.expires_at,
      );
      return lease;
    });
  }

  /**
   * Renew one lease: ONLY the holding task may renew; a lapsed lease cannot
   * be renewed (LeaseExpiredError — re-acquire instead), and a released or
   * unknown lease is LeaseNotHeldError. The expiry moves to now + ttl.
   */
  renewLease(leaseId: string, taskId: string, ttlMs: number): WriteLease {
    assertTtl(ttlMs);
    return this.tx.transaction((db) => {
      const row = this.findLeaseById(db, leaseId);
      if (row === null || row.task_id !== taskId) throw new LeaseNotHeldError(leaseId, taskId);
      if (row.released_at !== null) throw new LeaseNotHeldError(leaseId, taskId);
      const now = this.now();
      const nowIso = now.toISOString();
      if (Date.parse(row.expires_at) <= now.getTime()) {
        throw new LeaseExpiredError(leaseId, taskId, row.expires_at);
      }
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      db.prepare(
        `UPDATE write_leases SET expires_at = ?, renewed_at = ?
         WHERE workspace_id = ? AND lease_id = ?`,
      ).run(expiresAt, nowIso, row.workspace_id, leaseId);
      return toLease(this.findLeaseById(db, leaseId) as LeaseRow);
    });
  }

  /**
   * Release one lease. Holder-task-only; idempotent for the holder (a second
   * release is a no-op). A foreign task's release is refused and leaves the
   * lease active. The runtime's force-release is releaseLeasesForTask, never
   * a mid-task path steal (see the force-release policy above).
   */
  releaseLease(leaseId: string, taskId: string): void {
    this.tx.transaction((db) => {
      const row = this.findLeaseById(db, leaseId);
      if (row === null || row.task_id !== taskId) throw new LeaseNotHeldError(leaseId, taskId);
      if (row.released_at !== null) return;
      db.prepare(
        `UPDATE write_leases SET released_at = ? WHERE workspace_id = ? AND lease_id = ?`,
      ).run(this.now().toISOString(), row.workspace_id, leaseId);
    });
  }

  /**
   * Every ACTIVE (unreleased, unexpired) lease of one workspace, oldest first
   * — the lease list read (GET /v1/workspace/leases). Released and lapsed
   * rows are history, not holdings, so they never appear. Reads only.
   */
  listActiveLeases(workspaceId: string): WriteLease[] {
    const nowIso = this.now().toISOString();
    return (
      this.tx
        .connection()
        .prepare(
          `SELECT ${LEASE_COLUMNS} FROM write_leases
           WHERE workspace_id = ? AND released_at IS NULL AND expires_at > ?
           ORDER BY acquired_at ASC, lease_id ASC`,
        )
        .all(workspaceId, nowIso) as unknown as LeaseRow[]
    ).map(toLease);
  }

  /**
   * Release EVERY unreleased lease of one task — the task-terminal
   * force-release (completion, cancellation, failure, process death). A lease
   * cannot outlive its task. Returns the number of leases released. The
   * gateway calls this from the task-finish seam (S17 chunk 3 wires the call).
   */
  releaseLeasesForTask(taskId: string): number {
    return this.tx.transaction((db) => {
      const result = db
        .prepare(
          `UPDATE write_leases SET released_at = ? WHERE task_id = ? AND released_at IS NULL`,
        )
        .run(this.now().toISOString(), taskId);
      return Number(result.changes);
    });
  }

  /**
   * THE D6 WRITE GATE. The workspace-files repository routes every write
   * through this before touching workspace_nodes (reads never come here).
   *
   * - User actor: allowed unless an ACTIVE lease held by an AGENT exists on
   *   the exact canonical path → WriteLeaseConflictError carrying the tooltip
   *   data. User-held leases never block the user.
   * - Agent actor: requires an ACTIVE lease held by ITS OWN task (task_id
   *   match AND holder_type 'agent' AND holder_id = the actor's agent id) on
   *   the exact canonical path; otherwise WriteLeaseRequiredError, naming a
   *   foreign holder + task when one exists.
   *
   * A scope root is structural (WorkspaceNodeTypeError) — it can never be
   * leased or written.
   */
  assertWriteAllowed(
    workspaceId: string,
    uri: string,
    actor: WorkspaceStorageActor,
    taskId?: string,
  ): void {
    const { canonical } = parseLeasePath(uri);
    const db = this.tx.connection();
    const nowIso = this.now().toISOString();

    if (actor.type === "user") {
      const blocking = db
        .prepare(
          `SELECT ${LEASE_COLUMNS} FROM write_leases
           WHERE workspace_id = ? AND path = ?
             AND released_at IS NULL AND expires_at > ?
             AND holder_type = 'agent'
           ORDER BY acquired_at ASC LIMIT 1`,
        )
        .get(workspaceId, canonical, nowIso) as LeaseRow | undefined;
      if (blocking !== undefined) {
        throw new WriteLeaseConflictError(
          blocking.holder_id,
          this.resolveAgentName(workspaceId, blocking.holder_id),
          blocking.task_id,
          canonical,
        );
      }
      return;
    }

    // Agent actor: the write must carry a task, and that task must hold an
    // active lease on the exact path, bound to this very agent.
    const own =
      taskId === undefined
        ? null
        : (db
            .prepare(
              `SELECT ${LEASE_COLUMNS} FROM write_leases
               WHERE workspace_id = ? AND path = ?
                 AND released_at IS NULL AND expires_at > ?
                 AND task_id = ? AND holder_type = 'agent' AND holder_id = ?
               ORDER BY acquired_at ASC LIMIT 1`,
            )
            .get(workspaceId, canonical, nowIso, taskId, actor.id) as LeaseRow | undefined);
    if (own) return;

    // Surface a foreign holder when one exists (G5: name the conflict).
    const foreign = this.findActiveLease(db, workspaceId, canonical, nowIso);
    throw new WriteLeaseRequiredError(
      actor.id,
      canonical,
      foreign?.task_id ?? null,
      foreign?.holder_id ?? null,
    );
  }

  /**
   * THE USER-DELETE GATE (D6, G6 — the F1 review fix; the write gate's
   * sibling). The workspace-files repository routes every USER delete through
   * this before touching workspace_nodes; agent deletes never reach it (the
   * AGENT_DELETE_REQUIRES_APPROVAL refusal owns them first).
   *
   * - An ACTIVE lease held by an AGENT on the deleted path — or, when a
   *   directory's subtree goes with it, on ANY canonical path under it
   *   (recursive deletes, and non-recursive empty-directory deletes alike: a
   *   claimed-but-unwritten path inside the directory dies with it) — blocks
   *   with the same WriteLeaseConflictError a gated write gets, carrying the
   *   holding Agent + task. A live task must not watch its leased content
   *   vanish, and no delete may leave content a stale lease can resurrect.
   * - User-held active leases never block the panel user (the write gate's
   *   rule); they die with their task through releaseLeasesForTask.
   * - When the delete is allowed, every RELEASED-or-EXPIRED lease row on the
   *   deleted paths is deleted outright, so no dangling row survives the
   *   node: a later agent write under a stale lease cannot re-materialize
   *   deleted parents. Live user-held rows are left to their task's terminal
   *   force-release — a lease never dies before its task.
   *
   * The subtree match is a canonical-prefix match over parseLeasePath's
   * canonical form (base + decoded segments joined with '/'), with LIKE
   * wildcards in names escaped.
   */
  gateDelete(
    workspaceId: string,
    uri: string,
    actor: WorkspaceStorageActor,
    options: { includeSubtree: boolean },
  ): void {
    const { canonical } = parseLeasePath(uri);
    const db = this.tx.connection();
    const nowIso = this.now().toISOString();

    const pathPredicate = options.includeSubtree
      ? `path = ? OR path LIKE ? ESCAPE '\\'`
      : `path = ?`;
    const pathParams: string[] = options.includeSubtree
      ? [canonical, likeSubtreePattern(canonical)]
      : [canonical];

    const blocking = db
      .prepare(
        `SELECT ${LEASE_COLUMNS} FROM write_leases
         WHERE workspace_id = ? AND (${pathPredicate})
           AND released_at IS NULL AND expires_at > ?
           AND holder_type = 'agent'
         ORDER BY acquired_at ASC LIMIT 1`,
      )
      .get(workspaceId, ...pathParams, nowIso) as LeaseRow | undefined;
    if (blocking !== undefined) {
      throw new WriteLeaseConflictError(
        blocking.holder_id,
        this.resolveAgentName(workspaceId, blocking.holder_id),
        blocking.task_id,
        canonical,
      );
    }

    // The delete proceeds: purge the history rows on the deleted paths so
    // nothing dangles over vanished content.
    db.prepare(
      `DELETE FROM write_leases
       WHERE workspace_id = ? AND (${pathPredicate})
         AND (released_at IS NOT NULL OR expires_at <= ?)`,
    ).run(workspaceId, ...pathParams, nowIso);
  }

  /**
   * The one ACTIVE (unreleased, unexpired) lease on a canonical path, if any.
   * Reads only; must run on the caller's connection/transaction.
   */
  private findActiveLease(
    db: DatabaseSync,
    workspaceId: string,
    canonicalPath: string,
    nowIso: string,
  ): LeaseRow | null {
    const row = db
      .prepare(
        `SELECT ${LEASE_COLUMNS} FROM write_leases
         WHERE workspace_id = ? AND path = ? AND released_at IS NULL AND expires_at > ?
         ORDER BY acquired_at ASC LIMIT 1`,
      )
      .get(workspaceId, canonicalPath, nowIso) as LeaseRow | undefined;
    return row ?? null;
  }

  private findLeaseById(db: DatabaseSync, leaseId: string): LeaseRow | null {
    const row = db
      .prepare(`SELECT ${LEASE_COLUMNS} FROM write_leases WHERE lease_id = ?`)
      .get(leaseId) as LeaseRow | undefined;
    return row ?? null;
  }

  private resolveAgentName(workspaceId: string, agentId: string): string {
    return this.agentNameResolver?.(workspaceId, agentId) ?? agentId;
  }
}
