/**
 * S27 ST-02 — workspace boundary escape (threat model §5 ST-02; TM-3.3,
 * TM-1.4; D27 + D6 + D39 + E12). A task run (or an Agent) must never reach
 * another task's worktree paths, another Agent's private folder, or another
 * workspace's tree — and a refused cross-scope write must leave the target
 * content byte-identical (no silent mutation, G5).
 *
 * The controls fired here, on REAL repositories over a REAL migrated SQLite
 * store and the REAL sandbox policy:
 *   - D39 scope denial: Agent B's every operation against agent://agent_alpha/
 *     (read, resolve, list, write, delete) is PRIVATE_SCOPE_DENIED BEFORE any
 *     row is touched — the delete leg proves the ordering (the scope denial
 *     reads as the denial, not the agent-delete refusal) and D39 holds for
 *     LEASING too (a lease cannot launder the boundary);
 *   - E12 workspace scoping: the same URI in two workspaces is two
 *     independent trees — a secret written in A is invisible (not found)
 *     from B, and B writing the same URI in B never touches A's row;
 *   - D27 execution scope: an execution task in workspace A cannot set its
 *     workdir into workspace B's execution scope (SANDBOX_PATH_ESCAPE — the
 *     per-workspace roots are siblings, so `../` between them is traversal).
 *
 * Fixture discipline (the recorded D6 chain): an AGENT write requires an
 * active lease held by its own task — so the setup writes that simulate a
 * live agent edit acquire that lease first, exactly as the runtime composes
 * it; the hostile side arrives with NO lease (or a refused one).
 *
 * RED-FIRST evidence: the files repository's scope guard (assertScopeAccess)
 * was disabled, the suite FAILED (agent B read agent A's private folder),
 * the guard was restored, the suite PASSED — both outputs in
 * tests/security-evidence/2026-11-05-st02-{red,green}.txt.
 *
 * Governing records: THREAT_MODEL §5 ST-02, D6, D27, D39, E12, G5.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { openDatabase } from "../../apps/user-runtime/src/adapters/sqlite/connection.ts";
import { applyMigrations } from "../../apps/user-runtime/src/adapters/sqlite/migrations.ts";
import { SqliteTransactions } from "../../apps/user-runtime/src/adapters/sqlite/transactions.ts";
import {
  AgentDeleteRefusedError,
  PrivateScopeDeniedError,
  WorkspaceFilesRepository,
  WorkspaceNodeNotFoundError,
  type WorkspaceStorageActor,
} from "../../apps/user-runtime/src/adapters/sqlite/workspace-files-repository.ts";
import { WriteLeasesRepository } from "../../apps/user-runtime/src/adapters/sqlite/write-leases-repository.ts";
import {
  SandboxPolicyError,
  prepareDirectoryInsideScope,
} from "../../apps/user-runtime/src/modules/execution/sandbox-policy.ts";
import {
  makeTerminalExecutionBinding,
  type ExecutionToolDeps,
} from "../../apps/user-runtime/src/modules/execution/execution-tool-binding.ts";
import {
  makeExecutionAuthority,
  ToolBindingError,
  type ToolExecutionContext,
} from "../../apps/user-runtime/src/modules/tools/tool-binding.ts";

const WS_A = "ws_s27_alpha";
const WS_B = "ws_s27_beta";
const AGENT_A = "agent_alpha";
const AGENT_B = "agent_beta";
const TASK_A1 = "task_alpha_1";

const tempDirs: string[] = [];
const connections: Array<{ close: () => void }> = [];

function newStore(): {
  files: WorkspaceFilesRepository;
  leases: WriteLeasesRepository;
} {
  const dir = mkdtempSync(join(tmpdir(), "shera-s27-st02-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  connections.push(conn);
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const leases = new WriteLeasesRepository(tx);
  return { files: new WorkspaceFilesRepository(tx, leases), leases };
}

/** The recorded D6 chain for a live agent edit: the task holds the lease,
 * then the write passes the gate. Returns the written node. */
function agentEditWithLease(
  files: WorkspaceFilesRepository,
  leases: WriteLeasesRepository,
  workspaceId: string,
  uri: string,
  agent: WorkspaceStorageActor & { type: "agent" },
  taskId: string,
  content: string,
): ReturnType<WorkspaceFilesRepository["write"]> {
  leases.acquireLease(workspaceId, uri, taskId, { type: "agent", id: agent.id }, 60_000);
  return files.write(workspaceId, uri, agent, Buffer.from(content), "text/plain", {
    task_id: taskId,
  });
}

const agentA: WorkspaceStorageActor = { type: "agent", id: AGENT_A };
const agentB: WorkspaceStorageActor = { type: "agent", id: AGENT_B };
// User actors (the panel path): no lease needed for user writes — the
// fixture identity for setup legs where the writer's agent identity is
// not the subject under test.
const userA: WorkspaceStorageActor = { type: "user", id: "user_alice" };
const userB: WorkspaceStorageActor = { type: "user", id: "user_betty" };

describe("S27 ST-02 — D39 private-folder denial (Agent B vs agent://agent_alpha/)", () => {
  it("agent B cannot READ any node in agent A's private folder", () => {
    const { files, leases } = newStore();
    agentEditWithLease(
      files,
      leases,
      WS_A,
      `agent://${AGENT_A}/notes/private.md`,
      agentA,
      TASK_A1,
      "A's private plan",
    );
    expect(() => files.read(WS_A, `agent://${AGENT_A}/notes/private.md`, agentB)).toThrow(
      PrivateScopeDeniedError,
    );
    expect(() => files.resolve(WS_A, `agent://${AGENT_A}/notes/private.md`, agentB)).toThrow(
      PrivateScopeDeniedError,
    );
    expect(() => files.list(WS_A, `agent://${AGENT_A}/notes`, agentB)).toThrow(
      PrivateScopeDeniedError,
    );
  });

  it("agent B cannot WRITE into agent A's private folder; A's content stays byte-identical", () => {
    const { files, leases } = newStore();
    const original = agentEditWithLease(
      files,
      leases,
      WS_A,
      `agent://${AGENT_A}/notes/private.md`,
      agentA,
      TASK_A1,
      "A's original bytes",
    );
    expect(() =>
      files.write(
        WS_A,
        `agent://${AGENT_A}/notes/private.md`,
        agentB,
        Buffer.from("B's overwrite"),
        "text/plain",
      ),
    ).toThrow(PrivateScopeDeniedError);
    // No silent mutation (G5): A's row is byte-identical after the refusal.
    const after = files.read(WS_A, `agent://${AGENT_A}/notes/private.md`, agentA);
    expect(Buffer.from(after.content).toString("utf8")).toBe("A's original bytes");
    expect(after.id).toBe(original.id);
    expect(after.updated_at).toBe(original.updated_at);
  });

  it("agent B's DELETE attempt in agent A's folder reads as the SCOPE denial (checked before the agent-delete refusal)", () => {
    const { files, leases } = newStore();
    agentEditWithLease(
      files,
      leases,
      WS_A,
      `agent://${AGENT_A}/notes/private.md`,
      agentA,
      TASK_A1,
      "x",
    );
    expect(() => files.delete(WS_A, `agent://${AGENT_A}/notes/private.md`, agentB, {})).toThrow(
      PrivateScopeDeniedError,
    );
    // The file survived: the refusal was the scope, and nothing was deleted.
    expect(files.read(WS_A, `agent://${AGENT_A}/notes/private.md`, agentA).size).toBe(1);
    // Positive control: agent A's own delete is refused too — but by the
    // DIFFERENT, recorded G6 refusal (delete is never agent-triggered).
    expect(() => files.delete(WS_A, `agent://${AGENT_A}/notes/private.md`, agentA, {})).toThrow(
      AgentDeleteRefusedError,
    );
  });

  it("a lease cannot launder the boundary: D39 holds for leasing, and scope denial precedes the lease gate", () => {
    const { files, leases } = newStore();
    agentEditWithLease(
      files,
      leases,
      WS_A,
      `agent://${AGENT_A}/notes/private.md`,
      agentA,
      TASK_A1,
      "x",
    );
    // B's task cannot acquire a lease on A's private path at all.
    expect(() =>
      leases.acquireLease(
        WS_A,
        `agent://${AGENT_A}/notes/private.md`,
        "task_beta_1",
        { type: "agent", id: AGENT_B },
        60_000,
      ),
    ).toThrow(PrivateScopeDeniedError);
    // And even a write that carries a task id is the scope denial — the
    // scope guard runs BEFORE the lease gate (never a lease-scoped bypass).
    expect(() =>
      files.write(
        WS_A,
        `agent://${AGENT_A}/notes/private.md`,
        agentB,
        Buffer.from("y"),
        "text/plain",
        { task_id: "task_beta_1" },
      ),
    ).toThrow(PrivateScopeDeniedError);
  });
});

describe("S27 ST-02 — E12 workspace scoping (the same URI, two workspaces)", () => {
  it("a secret written in workspace A is invisible from workspace B", () => {
    const { files } = newStore();
    files.write(
      WS_A,
      "workspace://projects/alpha/secret.env",
      userA,
      Buffer.from("ALPHA-ONLY"),
      "text/plain",
    );
    // B's tree has no such node — not a content leak, an independent tree.
    expect(() => files.read(WS_B, "workspace://projects/alpha/secret.env", agentB)).toThrow(
      WorkspaceNodeNotFoundError,
    );
    // And B writing its OWN copy never touches A's row.
    const bCopy = files.write(
      WS_B,
      "workspace://projects/alpha/secret.env",
      userB,
      Buffer.from("BETA-ONLY"),
      "text/plain",
    );
    expect(Buffer.from(bCopy.content).toString("utf8")).toBe("BETA-ONLY");
    const aCopy = files.read(WS_A, "workspace://projects/alpha/secret.env", userA);
    expect(Buffer.from(aCopy.content).toString("utf8")).toBe("ALPHA-ONLY");
    expect(aCopy.id).not.toBe(bCopy.id);
  });

  it("an agent's private folder in two workspaces is two independent folders (E12, not a global agent folder)", () => {
    const { files } = newStore();
    files.write(WS_A, `agent://${AGENT_B}/scratch/a.txt`, userA, Buffer.from("wsA copy"), null);
    expect(() => files.read(WS_B, `agent://${AGENT_B}/scratch/a.txt`, agentB)).toThrow(
      WorkspaceNodeNotFoundError,
    );
  });

  it("a second workspace's URI cannot address the first workspace's row by id or content", () => {
    const { files } = newStore();
    const a = files.write(WS_A, "workspace://data.txt", userA, Buffer.from("alpha bytes"), null);
    // Addressing by the SAME node id from the other workspace is not a thing:
    // URIs are the only address, and they are workspace-scoped.
    expect(() => files.read(WS_B, "workspace://data.txt", agentB)).toThrow(
      WorkspaceNodeNotFoundError,
    );
    expect(a.workspace_id).toBe(WS_A);
  });
});

describe("S27 ST-02 — D27 execution scope (workspace A's task cannot reach workspace B's execution scope)", () => {
  it("the workdir traversal ../<ws-b-root> is a typed SANDBOX_PATH_ESCAPE and nothing spawns", async () => {
    const parent = mkdtempSync(join(tmpdir(), "shera-s27-st02-exec-"));
    tempDirs.push(parent);
    const rootA = join(parent, "exec-ws-a");
    const rootB = join(parent, "exec-ws-b");
    mkdirSync(rootA, { recursive: true });
    mkdirSync(join(rootB, "stolen"), { recursive: true });

    let spawnCalled = false;
    const deps: ExecutionToolDeps = {
      spawn: () => {
        spawnCalled = true;
        throw new Error("SPAWN REACHED — the policy must refuse first");
      },
      workspaceRoots: { [WS_A]: rootA, [WS_B]: rootB },
      terminalRecorder: null,
      artifacts: null,
      logFault: () => {},
    };
    const binding = makeTerminalExecutionBinding(deps);
    if (typeof binding.executeAsync !== "function") {
      throw new Error("the terminal-execution binding must dispatch through executeAsync");
    }
    const dispatch = binding.executeAsync.bind(binding);
    const ctx: ToolExecutionContext = {
      authority: makeExecutionAuthority(),
      deadline: Date.now() + 5_000,
      nowMs: () => Date.now(),
      maxResponseBytes: 4_096,
      resourceLimits: {
        max_memory_mb: 1024,
        max_cpu_seconds: 5,
        max_processes: 32,
        max_disk_mb: 64,
      },
      signal: new AbortController().signal,
      execution: {
        execution_id: "exe_s27_st02",
        workspace_id: WS_A,
        task_id: TASK_A1,
        conversation_id: "conv_a1",
        agent_id: AGENT_A,
        capability: "code.exec",
        approval_id: null,
        grant_id: null,
      },
    };

    await expect(
      dispatch({ command: "cat stolen/*", workdir: "../exec-ws-b" }, ctx),
    ).rejects.toThrow(ToolBindingError);
    await expect(
      dispatch({ command: "cat stolen/*", workdir: "../exec-ws-b" }, ctx),
    ).rejects.toThrow(/SANDBOX_PATH_ESCAPE/);
    expect(spawnCalled).toBe(false);
    // And the sandbox policy itself refuses the sibling-root walk.
    expect(() => prepareDirectoryInsideScope(rootA, "../exec-ws-b/stolen")).toThrow(
      SandboxPolicyError,
    );
  });
});

afterAll(() => {
  for (const conn of connections.splice(0)) {
    try {
      conn.close();
    } catch {
      // already closed
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
