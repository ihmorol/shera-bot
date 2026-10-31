/**
 * The wake-manager tests (S28 chunk 5; AC5): chokidar wakes the scheduler on
 * agent-folder changes; the debounced wake coalesces a rapid-change flood
 * into ONE tick, and the signature machinery keeps the firing at exactly
 * once per real change. Real filesystem, real timers — the flood settles
 * within the test's own window.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { agentFolderDir } from "../../adapters/fs/agent-folder-store.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { TriggersRepository } from "../../adapters/sqlite/triggers-repository.ts";
import {
  WorkspaceFilesRepository,
} from "../../adapters/sqlite/workspace-files-repository.ts";
import { WriteLeasesRepository } from "../../adapters/sqlite/write-leases-repository.ts";
import { ArtifactsRepository } from "../../adapters/sqlite/artifacts-repository.ts";
import { ProjectsRepository } from "../../adapters/sqlite/projects-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventsService } from "../events/events.service.ts";
import { OperationsService } from "../operations/operations.service.ts";
import { SchedulesService } from "./schedules.service.ts";
import { SchedulerService } from "./scheduler.service.ts";
import { SchedulerWakeManager } from "./scheduler-wake-manager.ts";

const WS = "ws-wake";
const AGENT = "agent_wake_test";

const PACK_CATALOG = {
  pack_id: "pack_wake_test",
  pack_version: "1.0.0",
  agents: [
    {
      agent_id: AGENT,
      display_name: "Wake Test Agent",
      role_description: "wakes",
      default_provider: { provider_id: "fake", model: "fake-model" },
      skills: [],
      tools: [],
      connectors: [],
      ui_identity: { avatar_hue: 41, initial_glyph: "K" },
      home_operation_id: null,
    },
  ],
  locateAgentPack: (agentId: string) => (agentId === AGENT ? "pack_wake_test" : null),
  skills: [],
  connectors: [],
};

interface WakeHarness {
  dir: string;
  conn: SqliteConnection;
  tx: SqliteTransactions;
  ops: OperationsService;
  schedules: SchedulesService;
  scheduler: SchedulerService;
  wakeManager: SchedulerWakeManager;
  operationId: string;
  agentFilesRoot: string;
  ticks: { n: number };
}

const harnesses: WakeHarness[] = [];

function makeHarness(): WakeHarness {
  const dir = mkdtempSync(join(tmpdir(), "shera-s28-wake-"));
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const operationsRepo = new OperationsRepository(tx);
  const triggers = new TriggersRepository(tx);
  const files = new WorkspaceFilesRepository(tx, new WriteLeasesRepository(tx));
  const artifacts = new ArtifactsRepository(tx);
  const projects = new ProjectsRepository(tx);
  const ops = new OperationsService({
    operations: operationsRepo,
    tx,
    packCatalog: PACK_CATALOG,
  });
  const operationId = ops
    .createOperation(WS, {
      definition_ref: null,
      name: "Wake Operation",
      roster_agent_ids: [AGENT],
      coordinator_agent_id: AGENT,
    })
    .operation_id;
  const agentFilesRoot = join(dir, "agent-files");
  const ticks = { n: 0 };
  const scheduler = new SchedulerService({
    workspaceId: WS,
    triggers,
    operations: operationsRepo,
    ops,
    journal,
    events,
    tx,
    reservations: { reserveForRun: () => ({ ok: true, reservation_id: "res" }) },
    now: () => new Date().toISOString(),
    logFault: () => {},
    watcherSources: { files, artifacts, projects, agentFilesRoot, workspaceId: WS },
  });
  const wakeManager = new SchedulerWakeManager({
    triggers,
    workspaceId: WS,
    agentFilesRoot,
    onWake: () => {
      ticks.n += 1;
      scheduler.tick();
    },
    debounceMs: 150,
    logFault: () => {},
  });
  const harness: WakeHarness = {
    dir,
    conn,
    tx,
    ops,
    schedules: new SchedulesService({ triggers, operations: operationsRepo, tx }),
    scheduler,
    wakeManager,
    operationId,
    agentFilesRoot,
    ticks,
  };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.wakeManager.stop();
    try {
      harness.conn.close();
    } finally {
      rmSync(harness.dir, { recursive: true, force: true });
    }
  }
});

const USER_ACTOR = { type: "user" as const, id: "emon" };

describe("the agent-folder wake manager (chokidar wakes the tick)", () => {
  it("fires once per real change under a rapid-write flood, never per intermediate write (AC5)", async () => {
    const harness = makeHarness();
    harness.schedules.createTrigger(WS, {
      kind: "file_watch",
      name: "private flood watch",
      target_operation_id: harness.operationId,
      config: {
        scope: "agent",
        path_uri: `agent://${AGENT}/flood.md`,
        agent_id: AGENT,
        provider: { provider_id: "prov_fake", model: "fake-model" },
      },
      catch_up_policy: "skip",
      actor: USER_ACTOR,
    });
    // The baseline: the watcher adopts the observed state at start.
    harness.scheduler.tick();
    harness.wakeManager.sync();
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(0);

    // THE FLOOD: twenty rapid writes to the watched folder. Chokidar emits
    // per-write events; the debounced wake coalesces them and the signature
    // machinery fires exactly once for the net change.
    const folder = agentFolderDir(harness.agentFilesRoot, WS, AGENT);
    mkdirSync(folder, { recursive: true });
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(folder, "flood.md"), `flood write ${index}`, "utf8");
    }

    // The wake lands within the debounce window; give the machinery a
    // bounded real-time settle.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (harness.ops.listRuns(WS, harness.operationId).length >= 1) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    expect(harness.ticks.n).toBeGreaterThanOrEqual(1);
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(1);
    // A quiet second proves the flood produced exactly ONE firing (the
    // intermediate writes never became runs).
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 600));
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(1);
    void dirname;
  });
});
