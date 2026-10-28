/**
 * S17 chunk 2: write-lease contract (PRD §4.3, D6, G5, G6, AC16 partial).
 *
 * RED-FIRST: this suite was committed failing, then implemented against.
 *
 * What is pinned here (Temporal/Kubernetes lease vocabulary: holder, expiry,
 * revocation — no invented variants):
 * - acquireLease: exclusive per exact path WITHIN a workspace; a second ACTIVE
 *   lease on the same path is the typed LEASE_CONFLICT naming the existing
 *   holder + task. Equivalent URI spellings (percent-encoding, trailing slash)
 *   canonicalize to one lease path. Expired leases never block: a new acquirer
 *   wins and the lapsed row is marked released (steal-by-expiry). Concurrent
 *   READS never touch leases — they are the files repository's concern and are
 *   always allowed.
 * - renewLease: only the holding task renews (LEASE_NOT_HELD otherwise); an
 *   expired or released lease cannot be renewed (LEASE_EXPIRED /
 *   LEASE_NOT_HELD) — the path must be re-acquired.
 * - releaseLease: holder-task-only; idempotent for the holder. The runtime
 *   force-release is releaseLeasesForTask (steal-by-policy: task completion,
 *   cancellation, failure, or process death) — never a mid-task path steal.
 * - A lease cannot outlive its task: releaseLeasesForTask releases every
 *   unreleased lease of the task and only those.
 * - assertWriteAllowed (the D6 write gate): a user write is blocked only by an
 *   ACTIVE agent lease on the exact path, with the tooltip data attached
 *   (holding Agent name/id + task identifier — "Developer is editing this
 *   file · task #4"); an agent write requires an active lease held by its own
 *   task (WRITE_LEASE_REQUIRED otherwise, naming a foreign holder when one
 *   exists — conflicts surface and stop, G5).
 * - Scope roots are structural: no lease can be taken on them. D39 holds for
 *   leasing too: an Agent never leases another Agent's private folder.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { openDatabase } from "./connection.ts";
import { applyMigrations } from "./migrations.ts";
import { SqliteTransactions } from "./transactions.ts";
import {
  PrivateScopeDeniedError,
  WorkspacePathError,
  WorkspaceNodeTypeError,
  type WorkspaceStorageActor,
} from "./workspace-files-repository.ts";
import {
  LeaseConflictError,
  LeaseExpiredError,
  LeaseNotHeldError,
  LeaseTtlInvalidError,
  WriteLeaseConflictError,
  WriteLeaseRequiredError,
  WriteLeasesRepository,
} from "./write-leases-repository.ts";

const tempDirs: string[] = [];

function newTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "shera-runtime-s17-write-leases-"));
  tempDirs.push(dir);
  return join(dir, "runtime.db");
}

function openMigratedDb(path: string) {
  const conn = openDatabase(path);
  applyMigrations(conn.db);
  return conn;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Injectable clock: frozen at start, advanced explicitly by expiry tests. */
function makeClock(startIso = "2026-10-28T10:00:00.000Z") {
  let currentMs = Date.parse(startIso);
  return {
    now: (): Date => new Date(currentMs),
    advance: (ms: number): void => {
      currentMs += ms;
    },
    iso: (): string => new Date(currentMs).toISOString(),
  };
}

function seedAgent(db: ReturnType<typeof openDatabase>["db"], agentId: string, displayName: string): void {  const now = "2026-10-28T09:00:00.000Z";
  db.prepare(
    `INSERT INTO agents (
       agent_id, workspace_id, display_name, role_description, avatar_hue,
       initial_glyph, default_provider_id, default_provider_model,
       user_instructions, capabilities_json, private_folder_path,
       is_seeded_from_pack, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, '{}', ?, 1, ?, ?)`,
  ).run(agentId, "ws_default", displayName, "test agent", 120, "A", "provider", "model", `agent://${agentId}`, now, now);
}

function makeLeases() {
  const conn = openMigratedDb(newTempDbPath());
  seedAgent(conn.db, "alice", "Alice");
  const clock = makeClock();
  const tx = new SqliteTransactions(conn.db);
  const leases = new WriteLeasesRepository(tx, {
    now: clock.now,
    agentNameResolver: (workspaceId, agentId) =>
      (
        conn.db
          .prepare(`SELECT display_name FROM agents WHERE workspace_id = ? AND agent_id = ?`)
          .get(workspaceId, agentId) as { display_name: string } | undefined
      )?.display_name ?? null,
  });
  return { conn, clock, leases };
}

const USER: WorkspaceStorageActor = { type: "user", id: "user-1" };
const ALICE: WorkspaceStorageActor = { type: "agent", id: "alice" };
const BOB: WorkspaceStorageActor = { type: "agent", id: "bob" };

const TTL = 60_000;

describe("acquireLease", () => {
  it("acquires an exclusive lease and returns holder, task, canonical path, and expiry", () => {
    const { conn, clock, leases } = makeLeases();
    try {
      const lease = leases.acquireLease("ws_default", "workspace://docs/plan.md", "task-4", ALICE, TTL);

      expect(lease.lease_id.startsWith("lease_")).toBe(true);
      expect(lease.workspace_id).toBe("ws_default");
      expect(lease.scope).toBe("workspace");
      expect(lease.agent_id).toBeNull();
      expect(lease.task_id).toBe("task-4");
      expect(lease.path).toBe("workspace://docs/plan.md");
      expect(lease.holder_type).toBe("agent");
      expect(lease.holder_id).toBe("alice");
      expect(lease.acquired_at).toBe(clock.iso());
      expect(lease.expires_at).toBe(new Date(Date.parse(clock.iso()) + TTL).toISOString());
      expect(lease.renewed_at).toBeNull();
      expect(lease.released_at).toBeNull();
    } finally {
      conn.close();
    }
  });

  it("refuses a second active lease on the same path with LEASE_CONFLICT naming the holder and task", () => {
    const { conn, leases } = makeLeases();
    try {
      leases.acquireLease("ws_default", "workspace://docs/plan.md", "task-4", ALICE, TTL);

      expect(() =>
        leases.acquireLease("ws_default", "workspace://docs/plan.md", "task-5", BOB, TTL),
      ).toThrow(LeaseConflictError);
      try {
        leases.acquireLease("ws_default", "workspace://docs/plan.md", "task-5", BOB, TTL);
        expect.unreachable();
      } catch (error) {
        const conflict = error as LeaseConflictError;
        expect(conflict.code).toBe("LEASE_CONFLICT");
        expect(conflict.holder_type).toBe("agent");
        expect(conflict.holder_id).toBe("alice");
        expect(conflict.task_id).toBe("task-4");
        expect(conflict.path).toBe("workspace://docs/plan.md");
      }
    } finally {
      conn.close();
    }
  });

  it("refuses re-acquire by the SAME task while its lease is active (a holder renews, it does not re-acquire)", () => {
    const { conn, leases } = makeLeases();
    try {
      leases.acquireLease("ws_default", "workspace://docs/plan.md", "task-4", ALICE, TTL);
      expect(() =>
        leases.acquireLease("ws_default", "workspace://docs/plan.md", "task-4", ALICE, TTL),
      ).toThrow(LeaseConflictError);
    } finally {
      conn.close();
    }
  });

  it("canonicalizes equivalent URI spellings to one lease path (percent-encoding, trailing slash)", () => {
    const { conn, leases } = makeLeases();
    try {
      leases.acquireLease("ws_default", "workspace://docs/plan.md", "task-4", ALICE, TTL);
      expect(() =>
        leases.acquireLease("ws_default", "workspace://docs/pl%61n.md", "task-5", BOB, TTL),
      ).toThrow(LeaseConflictError);
      expect(() =>
        leases.acquireLease("ws_default", "workspace://docs/plan.md/", "task-5", BOB, TTL),
      ).toThrow(LeaseConflictError);
    } finally {
      conn.close();
    }
  });

  it("scopes exclusivity to the exact path and to one workspace (E12)", () => {
    const { conn, leases } = makeLeases();
    try {
      // Different paths, same workspace: independent leases, one holder, one task.
      leases.acquireLease("ws_default", "workspace://a.md", "task-4", ALICE, TTL);
      leases.acquireLease("ws_default", "workspace://b.md", "task-4", ALICE, TTL);
      // Same path, different scopes are different paths.
      leases.acquireLease("ws_default", "agent://alice/x.md", "task-4", ALICE, TTL);
      leases.acquireLease("ws_default", "workspace://x.md", "task-4", ALICE, TTL);
      // Same path, different workspaces are independent trees (E12).
      leases.acquireLease("ws_other", "workspace://a.md", "task-5", BOB, TTL);
    } finally {
      conn.close();
    }
  });

  it("steal-by-expiry: an expired lease no longer blocks acquire; the new acquirer wins and the lapsed row is released", () => {
    const { conn, clock, leases } = makeLeases();
    try {
      const lapsed = leases.acquireLease("ws_default", "workspace://plan.md", "task-4", ALICE, 1_000);
      clock.advance(2_000);

      const winner = leases.acquireLease("ws_default", "workspace://plan.md", "task-5", BOB, TTL);
      expect(winner.task_id).toBe("task-5");
      expect(winner.holder_id).toBe("bob");

      const lapsedRow = conn.db
        .prepare(`SELECT released_at FROM write_leases WHERE workspace_id = ? AND lease_id = ?`)
        .get("ws_default", lapsed.lease_id) as { released_at: string | null };
      expect(lapsedRow.released_at).not.toBeNull();
    } finally {
      conn.close();
    }
  });

  it("refuses lease acquisition on a structural scope root with the kind error", () => {
    const { conn, leases } = makeLeases();
    try {
      expect(() => leases.acquireLease("ws_default", "workspace://", "task-4", ALICE, TTL)).toThrow(
        WorkspaceNodeTypeError,
      );
      expect(() => leases.acquireLease("ws_default", "agent://alice", "task-4", ALICE, TTL)).toThrow(
        WorkspaceNodeTypeError,
      );
      expect(() => leases.acquireLease("ws_default", "agent://alice/", "task-4", ALICE, TTL)).toThrow(
        WorkspaceNodeTypeError,
      );
    } finally {
      conn.close();
    }
  });

  it("refuses an agent holder leasing another Agent's private folder (D39)", () => {
    const { conn, leases } = makeLeases();
    try {
      expect(() =>
        leases.acquireLease("ws_default", "agent://bob/notes.txt", "task-4", ALICE, TTL),
      ).toThrow(PrivateScopeDeniedError);
    } finally {
      conn.close();
    }
  });

  it("rejects unsafe lease paths with WorkspacePathError and stores nothing", () => {
    const { conn, leases } = makeLeases();
    try {
      expect(() =>
        leases.acquireLease("ws_default", "workspace://../secret", "task-4", ALICE, TTL),
      ).toThrow(WorkspacePathError);
      expect(() =>
        leases.acquireLease("ws_default", "team://notes", "task-4", ALICE, TTL),
      ).toThrow(WorkspacePathError);

      const count = conn.db.prepare(`SELECT COUNT(*) AS n FROM write_leases`).get() as { n: number };
      expect(count.n).toBe(0);
    } finally {
      conn.close();
    }
  });

  it("rejects non-positive TTLs with a typed validation error", () => {
    const { conn, leases } = makeLeases();
    try {
      expect(() =>
        leases.acquireLease("ws_default", "workspace://plan.md", "task-4", ALICE, 0),
      ).toThrow(LeaseTtlInvalidError);
      expect(() =>
        leases.acquireLease("ws_default", "workspace://plan.md", "task-4", ALICE, -5),
      ).toThrow(LeaseTtlInvalidError);
    } finally {
      conn.close();
    }
  });
});

describe("renewLease", () => {
  it("lets only the holding task renew; expiry moves and renewed_at is stamped", () => {
    const { conn, clock, leases } = makeLeases();
    try {
      const lease = leases.acquireLease("ws_default", "workspace://plan.md", "task-4", ALICE, TTL);
      clock.advance(10_000);

      const renewed = leases.renewLease(lease.lease_id, "task-4", 120_000);
      expect(renewed.expires_at).toBe(new Date(Date.parse(clock.iso()) + 120_000).toISOString());
      expect(renewed.renewed_at).toBe(clock.iso());
      expect(renewed.lease_id).toBe(lease.lease_id);
    } finally {
      conn.close();
    }
  });

  it("refuses renewal by a non-holder task (LEASE_NOT_HELD) and leaves the lease active", () => {
    const { conn, leases } = makeLeases();
    try {
      const lease = leases.acquireLease("ws_default", "workspace://plan.md", "task-4", ALICE, TTL);

      expect(() => leases.renewLease(lease.lease_id, "task-9", TTL)).toThrow(LeaseNotHeldError);
      // The refused renewal did not free the path: the user write stays blocked.
      expect(() =>
        leases.assertWriteAllowed("ws_default", "workspace://plan.md", USER),
      ).toThrow(WriteLeaseConflictError);
    } finally {
      conn.close();
    }
  });

  it("refuses renewal after expiry with LEASE_EXPIRED; the path is then free for a new acquirer", () => {
    const { conn, clock, leases } = makeLeases();
    try {
      const lease = leases.acquireLease("ws_default", "workspace://plan.md", "task-4", ALICE, 1_000);
      clock.advance(2_000);

      expect(() => leases.renewLease(lease.lease_id, "task-4", TTL)).toThrow(LeaseExpiredError);
      const winner = leases.acquireLease("ws_default", "workspace://plan.md", "task-5", BOB, TTL);
      expect(winner.task_id).toBe("task-5");
    } finally {
      conn.close();
    }
  });

  it("refuses renewal of an already-released lease with LEASE_NOT_HELD", () => {
    const { conn, leases } = makeLeases();
    try {
      const lease = leases.acquireLease("ws_default", "workspace://plan.md", "task-4", ALICE, TTL);
      leases.releaseLease(lease.lease_id, "task-4");
      expect(() => leases.renewLease(lease.lease_id, "task-4", TTL)).toThrow(LeaseNotHeldError);
    } finally {
      conn.close();
    }
  });

  it("refuses renewal of an unknown lease with LEASE_NOT_HELD", () => {
    const { conn, leases } = makeLeases();
    try {
      expect(() => leases.renewLease("lease_missing", "task-4", TTL)).toThrow(LeaseNotHeldError);
    } finally {
      conn.close();
    }
  });

  it("rejects non-positive renewal TTLs with a typed validation error", () => {
    const { conn, leases } = makeLeases();
    try {
      const lease = leases.acquireLease("ws_default", "workspace://plan.md", "task-4", ALICE, TTL);
      expect(() => leases.renewLease(lease.lease_id, "task-4", 0)).toThrow(LeaseTtlInvalidError);
    } finally {
      conn.close();
    }
  });
});

describe("releaseLease", () => {
  it("lets the holding task release; a blocked user write succeeds afterwards", () => {
    const { conn, leases } = makeLeases();
    try {
      const lease = leases.acquireLease("ws_default", "workspace://plan.md", "task-4", ALICE, TTL);
      expect(() =>
        leases.assertWriteAllowed("ws_default", "workspace://plan.md", USER),
      ).toThrow(WriteLeaseConflictError);

      leases.releaseLease(lease.lease_id, "task-4");
      expect(leases.assertWriteAllowed("ws_default", "workspace://plan.md", USER)).toBeUndefined();
    } finally {
      conn.close();
    }
  });

  it("refuses release by a non-holder task (LEASE_NOT_HELD); the lease stays active", () => {
    const { conn, leases } = makeLeases();
    try {
      const lease = leases.acquireLease("ws_default", "workspace://plan.md", "task-4", ALICE, TTL);

      expect(() => leases.releaseLease(lease.lease_id, "task-9")).toThrow(LeaseNotHeldError);
      expect(() =>
        leases.assertWriteAllowed("ws_default", "workspace://plan.md", USER),
      ).toThrow(WriteLeaseConflictError);
    } finally {
      conn.close();
    }
  });

  it("is idempotent for the holding task", () => {
    const { conn, leases } = makeLeases();
    try {
      const lease = leases.acquireLease("ws_default", "workspace://plan.md", "task-4", ALICE, TTL);
      leases.releaseLease(lease.lease_id, "task-4");
      expect(() => leases.releaseLease(lease.lease_id, "task-4")).not.toThrow();
    } finally {
      conn.close();
    }
  });

  it("lets the holder release an expired lease (cleanup) without error", () => {
    const { conn, clock, leases } = makeLeases();
    try {
      const lease = leases.acquireLease("ws_default", "workspace://plan.md", "task-4", ALICE, 1_000);
      clock.advance(5_000);
      expect(() => leases.releaseLease(lease.lease_id, "task-4")).not.toThrow();
    } finally {
      conn.close();
    }
  });
});

describe("assertWriteAllowed — the D6 write gate", () => {
  it("blocks a user write with an active agent lease and carries the tooltip data (holder name/id + task)", () => {
    const { conn, leases } = makeLeases();
    try {
      leases.acquireLease("ws_default", "workspace://plan.md", "task-4", ALICE, TTL);

      expect(() =>
        leases.assertWriteAllowed("ws_default", "workspace://plan.md", USER),
      ).toThrow(WriteLeaseConflictError);
      try {
        leases.assertWriteAllowed("ws_default", "workspace://plan.md", USER);
        expect.unreachable();
      } catch (error) {
        const conflict = error as WriteLeaseConflictError;
        expect(conflict.code).toBe("WRITE_LEASE_CONFLICT");
        // The "Developer is editing this file · task #4" tooltip data:
        expect(conflict.holdingAgentId).toBe("alice");
        expect(conflict.holdingAgentName).toBe("Alice");
        expect(conflict.taskId).toBe("task-4");
        expect(conflict.path).toBe("workspace://plan.md");
      }
    } finally {
      conn.close();
    }
  });

  it("falls back to the agent id as the display name when the resolver has no row for the holder", () => {
    const { conn, leases } = makeLeases();
    try {
      leases.acquireLease("ws_default", "workspace://plan.md", "task-4", BOB, TTL);
      try {
        leases.assertWriteAllowed("ws_default", "workspace://plan.md", USER);
        expect.unreachable();
      } catch (error) {
        const conflict = error as WriteLeaseConflictError;
        expect(conflict.holdingAgentId).toBe("bob");
        expect(conflict.holdingAgentName).toBe("bob");
      }
    } finally {
      conn.close();
    }
  });

  it("never blocks a user write with a user-held lease (leases guard agent-vs-user contention)", () => {
    const { conn, leases } = makeLeases();
    try {
      leases.acquireLease("ws_default", "workspace://plan.md", "task-user", USER, TTL);
      expect(leases.assertWriteAllowed("ws_default", "workspace://plan.md", USER)).toBeUndefined();
    } finally {
      conn.close();
    }
  });

  it("stops blocking the user write once the lease is released OR expired", () => {
    const { conn, clock, leases } = makeLeases();
    try {
      const released = leases.acquireLease("ws_default", "workspace://a.md", "task-4", ALICE, TTL);
      leases.releaseLease(released.lease_id, "task-4");
      expect(leases.assertWriteAllowed("ws_default", "workspace://a.md", USER)).toBeUndefined();

      leases.acquireLease("ws_default", "workspace://b.md", "task-4", ALICE, 1_000);
      clock.advance(2_000);
      // An expired (but not yet released) lease no longer blocks the user.
      expect(leases.assertWriteAllowed("ws_default", "workspace://b.md", USER)).toBeUndefined();
    } finally {
      conn.close();
    }
  });

  it("refuses an agent write without any lease with WRITE_LEASE_REQUIRED", () => {
    const { conn, leases } = makeLeases();
    try {
      expect(() =>
        leases.assertWriteAllowed("ws_default", "workspace://plan.md", ALICE, "task-4"),
      ).toThrow(WriteLeaseRequiredError);
      const error = (() => {
        try {
          leases.assertWriteAllowed("ws_default", "workspace://plan.md", ALICE, "task-4");
        } catch (caught) {
          return caught as WriteLeaseRequiredError;
        }
        return expect.unreachable() as never;
      })();
      expect(error.code).toBe("WRITE_LEASE_REQUIRED");
      expect(error.conflictingTaskId).toBeNull();
    } finally {
      conn.close();
    }
  });

  it("refuses an agent write that carries no task id at all with WRITE_LEASE_REQUIRED", () => {
    const { conn, leases } = makeLeases();
    try {
      expect(() =>
        leases.assertWriteAllowed("ws_default", "workspace://plan.md", ALICE),
      ).toThrow(WriteLeaseRequiredError);
    } finally {
      conn.close();
    }
  });

  it("allows an agent write under its own task's active lease on the exact path", () => {
    const { conn, leases } = makeLeases();
    try {
      leases.acquireLease("ws_default", "workspace://plan.md", "task-4", ALICE, TTL);
      expect(
        leases.assertWriteAllowed("ws_default", "workspace://plan.md", ALICE, "task-4"),
      ).toBeUndefined();
    } finally {
      conn.close();
    }
  });

  it("refuses an agent write when ANOTHER task holds the active lease, naming the foreign holder (G5)", () => {
    const { conn, leases } = makeLeases();
    try {
      leases.acquireLease("ws_default", "workspace://plan.md", "task-4", ALICE, TTL);

      expect(() =>
        leases.assertWriteAllowed("ws_default", "workspace://plan.md", BOB, "task-5"),
      ).toThrow(WriteLeaseRequiredError);
      const error = (() => {
        try {
          leases.assertWriteAllowed("ws_default", "workspace://plan.md", BOB, "task-5");
        } catch (caught) {
          return caught as WriteLeaseRequiredError;
        }
        return expect.unreachable() as never;
      })();
      expect(error.conflictingTaskId).toBe("task-4");
      expect(error.conflictingHolderId).toBe("alice");
    } finally {
      conn.close();
    }
  });

  it("refuses an agent write after its own lease expired (it must re-acquire)", () => {
    const { conn, clock, leases } = makeLeases();
    try {
      leases.acquireLease("ws_default", "workspace://plan.md", "task-4", ALICE, 1_000);
      clock.advance(2_000);
      expect(() =>
        leases.assertWriteAllowed("ws_default", "workspace://plan.md", ALICE, "task-4"),
      ).toThrow(WriteLeaseRequiredError);
    } finally {
      conn.close();
    }
  });

  it("matches the exact path only: a lease neither authorizes sibling paths nor over-matches prefixes", () => {
    const { conn, leases } = makeLeases();
    try {
      leases.acquireLease("ws_default", "workspace://docs/plan.md", "task-4", ALICE, TTL);

      // Sibling path: no lease for task-4 there.
      expect(() =>
        leases.assertWriteAllowed("ws_default", "workspace://docs/other.md", ALICE, "task-4"),
      ).toThrow(WriteLeaseRequiredError);
      // Prefix must not over-match: plan.md.bak is a DIFFERENT path.
      expect(() =>
        leases.assertWriteAllowed("ws_default", "workspace://docs/plan.md.bak", ALICE, "task-4"),
      ).toThrow(WriteLeaseRequiredError);
    } finally {
      conn.close();
    }
  });
});

describe("releaseLeasesForTask — a lease cannot outlive its task", () => {
  it("releases every lease of the task and only its leases, returning the count", () => {
    const { conn, leases } = makeLeases();
    try {
      const first = leases.acquireLease("ws_default", "workspace://a.md", "task-4", ALICE, TTL);
      leases.acquireLease("ws_default", "workspace://b.md", "task-4", ALICE, TTL);
      const foreign = leases.acquireLease("ws_default", "workspace://c.md", "task-5", BOB, TTL);

      expect(leases.releaseLeasesForTask("task-4")).toBe(2);

      // task-4's paths are free for the user again.
      expect(leases.assertWriteAllowed("ws_default", "workspace://a.md", USER)).toBeUndefined();
      expect(leases.assertWriteAllowed("ws_default", "workspace://b.md", USER)).toBeUndefined();
      // task-5's lease survives, still blocking.
      expect(() =>
        leases.assertWriteAllowed("ws_default", "workspace://c.md", USER),
      ).toThrow(WriteLeaseConflictError);

      const released = conn.db
        .prepare(
          `SELECT lease_id, released_at FROM write_leases
           WHERE workspace_id = ? AND lease_id IN (?, ?)`,
        )
        .all("ws_default", first.lease_id, foreign.lease_id) as unknown as {
        lease_id: string;
        released_at: string | null;
      }[];
      const byId = new Map(released.map((row) => [row.lease_id, row.released_at]));
      expect(byId.get(first.lease_id)).not.toBeNull();
      expect(byId.get(foreign.lease_id)).toBeNull();
    } finally {
      conn.close();
    }
  });

  it("is a no-op for an unknown task (returns 0)", () => {
    const { conn, leases } = makeLeases();
    try {
      expect(leases.releaseLeasesForTask("task-missing")).toBe(0);
    } finally {
      conn.close();
    }
  });

  it("also releases expired-but-unreleased rows of the task (terminal cleanup is total)", () => {
    const { conn, clock, leases } = makeLeases();
    try {
      leases.acquireLease("ws_default", "workspace://a.md", "task-4", ALICE, 1_000);
      clock.advance(5_000);
      expect(leases.releaseLeasesForTask("task-4")).toBe(1);
    } finally {
      conn.close();
    }
  });
});
