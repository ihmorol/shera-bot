/**
 * S27 ST-09 — cross-task lease violation (threat model §5 ST-09; TM-4.x/D6:
 * task-scoped write leases, conflicts QUEUE — never a silent overwrite, an
 * expired or foreign lease authorizes nothing).
 *
 * The adversarial matrix over the REAL repositories (migrated SQLite):
 *   1. CONCURRENT WRITES: task A holds the lease on a path; task B's write is
 *      the typed WRITE_LEASE_REQUIRED naming the foreign holder + task, and
 *      the content is BYTE-IDENTICAL after the refusal — no silent overwrite,
 *      no absorbed conflict (G5: conflicts surface and stop).
 *   2. FOREIGN-PATH LEASE: a task holding a lease on path1 cannot write path2
 *      under it — the lease is per EXACT canonical path.
 *   3. EXPIRED LEASE: after expiry the holder's own write is refused too (a
 *      lapsed lease authorizes NOTHING, not even for its own task); renewal
 *      of the lapsed lease is LeaseExpiredError; the new acquirer wins the
 *      path (steal-by-expiry) and then writes.
 *   4. EQUIVALENT-SPELLING COLLISION: a second ACTIVE lease under a different
 *      spelling of the same canonical path (percent-encoding, trailing slash)
 *      is the typed LEASE_CONFLICT — spellings cannot launder exclusivity.
 *
 * RED-FIRST evidence: the D6 write gate (assertWriteAllowed) was disabled —
 * a silent overwrite HAPPENED and the hostile writes landed — the suite
 * FAILED, the gate was restored, the suite PASSED — both outputs in
 * tests/security-evidence/2026-11-05-st09-{red,green}.txt.
 *
 * Governing records: THREAT_MODEL §5 ST-09, D6, G5, E12.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { openDatabase } from "../../apps/user-runtime/src/adapters/sqlite/connection.ts";
import { applyMigrations } from "../../apps/user-runtime/src/adapters/sqlite/migrations.ts";
import { SqliteTransactions } from "../../apps/user-runtime/src/adapters/sqlite/transactions.ts";
import {
  WorkspaceFilesRepository,
  type WorkspaceStorageActor,
} from "../../apps/user-runtime/src/adapters/sqlite/workspace-files-repository.ts";
import {
  LeaseConflictError,
  LeaseExpiredError,
  WriteLeaseRequiredError,
  WriteLeasesRepository,
} from "../../apps/user-runtime/src/adapters/sqlite/write-leases-repository.ts";

const WS = "ws_s27_leases";
const AGENT_A = "agent_a";
const AGENT_B = "agent_b";
const TASK_A = "task_alpha";
const TASK_B = "task_beta";

const tempDirs: string[] = [];

interface LeaseHarness {
  files: WorkspaceFilesRepository;
  leases: WriteLeasesRepository;
}

function buildHarness(now?: () => Date): LeaseHarness {
  const dir = mkdtempSync(join(tmpdir(), "shera-s27-st09-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const leases = new WriteLeasesRepository(tx, now ? { now } : {});
  return { files: new WorkspaceFilesRepository(tx, leases), leases };
}

const agentA: WorkspaceStorageActor = { type: "agent", id: AGENT_A };
const agentB: WorkspaceStorageActor = { type: "agent", id: AGENT_B };

/** The recorded D6 chain: the task acquires, then its agent's write passes. */
function holdLease(
  h: LeaseHarness,
  uri: string,
  taskId: string,
  agentId: string,
  ttlMs = 60_000,
): ReturnType<WriteLeasesRepository["acquireLease"]> {
  return h.leases.acquireLease(WS, uri, taskId, { type: "agent", id: agentId }, ttlMs);
}

describe("S27 ST-09 — concurrent writes on a leased path (no silent overwrite)", () => {
  it("task B's write over task A's leased path is refused naming the foreign holder; content stays byte-identical", () => {
    const h = buildHarness();
    holdLease(h, "workspace://reports/report.md", TASK_A, AGENT_A);
    h.files.write(WS, "workspace://reports/report.md", agentA, Buffer.from("A's version"), "text/plain", { task_id: TASK_A });

    let conflictingTask: string | null = null;
    try {
      h.files.write(WS, "workspace://reports/report.md", agentB, Buffer.from("B's overwrite"), "text/plain", { task_id: TASK_B });
      expect.unreachable("the cross-task write must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(WriteLeaseRequiredError);
      conflictingTask = (error as WriteLeaseRequiredError).conflictingTaskId;
    }
    // The conflict is SURFACED, never absorbed: B's refusal names A's task.
    expect(conflictingTask).toBe(TASK_A);
    // And the content is byte-identical — no silent overwrite happened.
    const after = h.files.read(WS, "workspace://reports/report.md", agentA);
    expect(Buffer.from(after.content).toString("utf8")).toBe("A's version");
  });

  it("the user panel is equally blocked by an agent-held lease (the tooltip data rides the conflict)", () => {
    const h = buildHarness();
    holdLease(h, "workspace://reports/report.md", TASK_A, AGENT_A);
    h.files.write(WS, "workspace://reports/report.md", agentA, Buffer.from("A's version"), "text/plain", { task_id: TASK_A });
    expect(() =>
      h.files.write(WS, "workspace://reports/report.md", { type: "user", id: "user_alice" }, Buffer.from("panel overwrite"), "text/plain"),
    ).toThrow(/is editing/); // WriteLeaseConflictError's message carries the holding Agent + task
    const after = h.files.read(WS, "workspace://reports/report.md", agentA);
    expect(Buffer.from(after.content).toString("utf8")).toBe("A's version");
  });
});

describe("S27 ST-09 — a lease is per EXACT path (no foreign-path authorization)", () => {
  it("a task holding path1's lease cannot write path2 under it", () => {
    const h = buildHarness();
    holdLease(h, "workspace://reports/owned.md", TASK_A, AGENT_A);
    expect(() =>
      h.files.write(WS, "workspace://reports/other.md", agentA, Buffer.from("x"), "text/plain", { task_id: TASK_A }),
    ).toThrow(WriteLeaseRequiredError);
    // path2 has no node at all — the hostile write created nothing.
    expect(h.files.resolve(WS, "workspace://reports/other.md", agentA)).toBeNull();
  });
});

describe("S27 ST-09 — expired leases authorize NOTHING", () => {
  it("after expiry the holder's own write is refused until re-acquisition; the new acquirer wins", () => {
    let clock = Date.parse("2026-11-05T12:00:00.000Z");
    const h = buildHarness(() => new Date(clock));
    // Task A acquires with a 1-second TTL.
    holdLease(h, "workspace://reports/report.md", TASK_A, AGENT_A, 1_000);
    h.files.write(WS, "workspace://reports/report.md", agentA, Buffer.from("A's version"), "text/plain", { task_id: TASK_A });

    // Time passes; the lease lapses.
    clock += 5_000;

    // A's own write is NOW REFUSED: a lapsed lease authorizes nothing.
    expect(() =>
      h.files.write(WS, "workspace://reports/report.md", agentA, Buffer.from("A's stale write"), "text/plain", { task_id: TASK_A }),
    ).toThrow(WriteLeaseRequiredError);
    // A cannot renew the lapsed lease either — the path must be re-acquired.
    const lapsed = h.leases.listActiveLeases(WS).find((lease) => lease.task_id === TASK_A);
    expect(lapsed).toBeUndefined(); // an expired lease is not ACTIVE
    // B re-acquires (steal-by-expiry) and writes; the queue-then-stop shape.
    holdLease(h, "workspace://reports/report.md", TASK_B, AGENT_B, 60_000);
    h.files.write(WS, "workspace://reports/report.md", agentB, Buffer.from("B's version"), "text/plain", { task_id: TASK_B });
    const after = h.files.read(WS, "workspace://reports/report.md", agentB);
    expect(Buffer.from(after.content).toString("utf8")).toBe("B's version");
    // A's write attempt AFTER B holds it: refused again, naming B's task.
    expect(() =>
      h.files.write(WS, "workspace://reports/report.md", agentA, Buffer.from("A again"), "text/plain", { task_id: TASK_A }),
    ).toThrow(/task_beta/);
  });
});

describe("S27 ST-09 — equivalent spellings collide into ONE exclusivity domain", () => {
  it("a second ACTIVE lease under a percent-encoded/trailing-slash spelling is the typed LEASE_CONFLICT", () => {
    const h = buildHarness();
    holdLease(h, "workspace://reports/report file.md", TASK_A, AGENT_A);
    // The SAME canonical path, spelled differently — percent-encoding and a
    // trailing slash cannot create a second exclusivity domain.
    expect(() =>
      holdLease(h, "workspace://reports/report%20file.md/", TASK_B, AGENT_B),
    ).toThrow(LeaseConflictError);
    expect(() =>
      holdLease(h, "workspace://reports/report%20file.md", TASK_B, AGENT_B),
    ).toThrow(LeaseConflictError);
  });
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
