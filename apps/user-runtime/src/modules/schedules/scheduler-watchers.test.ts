/**
 * Scheduler watcher tests (S28 chunk 5; PRD §8, E5, AC4, AC5, AC6, D6): the
 * event-driven trigger kinds — workspace/agent file watches, Git watches,
 * agent-evaluated conditions (the typed-predicate evaluator port), and the
 * task-completion cascade — all through the SAME fireOccurrence pipeline,
 * so every watcher inherits the ledger claim (a duplicate never fires
 * twice) and the signature is the dedup authority.
 *
 * The flood (AC5): a rapid series of writes between two ticks coalesces to
 * ONE firing per changed path — never per intermediate write. The restart
 * (AC4): the persisted signature means a fresh scheduler re-fires nothing
 * for the observed state.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { simpleGit } from "simple-git";

import { agentFolderDir } from "../../adapters/fs/agent-folder-store.ts";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { ProjectsRepository } from "../../adapters/sqlite/projects-repository.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import {
  TriggersRepository,
  type TriggerRecordRow,
} from "../../adapters/sqlite/triggers-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { WorkspaceFilesRepository } from "../../adapters/sqlite/workspace-files-repository.ts";
import type { WorkspaceWriteLeaseGate } from "../../adapters/sqlite/workspace-files-repository.ts";
import { WriteLeasesRepository } from "../../adapters/sqlite/write-leases-repository.ts";
import { ArtifactsRepository } from "../../adapters/sqlite/artifacts-repository.ts";
import { EventsService } from "../events/events.service.ts";
import { OperationsService } from "../operations/operations.service.ts";
import { SchedulesService } from "./schedules.service.ts";
import { SchedulerService, type ReservationPort } from "./scheduler.service.ts";
import type { EventEnvelope } from "../events/events.types.ts";

const WS = "ws-watchers";
const AGENT = "agent_watcher_test";

const PACK_CATALOG = {
  pack_id: "pack_watcher_test",
  pack_version: "1.0.0",
  agents: [
    {
      agent_id: AGENT,
      display_name: "Watcher Test Agent",
      role_description: "watches",
      default_provider: { provider_id: "fake", model: "fake-model" },
      skills: [],
      tools: [],
      connectors: [],
      ui_identity: { avatar_hue: 31, initial_glyph: "W" },
      home_operation_id: null,
    },
  ],
  locateAgentPack: (agentId: string) => (agentId === AGENT ? "pack_watcher_test" : null),
  skills: [],
  connectors: [],
};

interface WatcherHarness {
  dir: string;
  conn: SqliteConnection;
  tx: SqliteTransactions;
  journal: EventJournalRepository;
  ops: OperationsService;
  schedules: SchedulesService;
  scheduler: SchedulerService;
  operationId: string;
  files: WorkspaceFilesRepository;
  artifacts: ArtifactsRepository;
  projects: ProjectsRepository;
  agentFilesRoot: string;
  gitRoot: string;
  clock: { value: string };
}

const harnesses: WatcherHarness[] = [];

function makeHarness(now = "2026-10-31T12:00:00.000Z"): WatcherHarness {
  const dir = mkdtempSync(join(tmpdir(), "shera-s28-watchers-"));
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const operationsRepo = new OperationsRepository(tx);
  const triggers = new TriggersRepository(tx);
  const writeLeases = new WriteLeasesRepository(tx);
  const files = new WorkspaceFilesRepository(tx, writeLeases);
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
      name: "Watcher Operation",
      roster_agent_ids: [AGENT],
      coordinator_agent_id: AGENT,
    })
    .operation_id;
  const agentFilesRoot = join(dir, "agent-files");
  const gitRoot = join(dir, "repos");
  mkdirSync(gitRoot, { recursive: true });
  const clock = { value: now };
  const reservations: ReservationPort = {
    reserveForRun: () => ({ ok: true, reservation_id: "res" }),
  };
  const scheduler = new SchedulerService({
    workspaceId: WS,
    triggers,
    operations: operationsRepo,
    ops,
    journal,
    events,
    tx,
    reservations,
    now: () => clock.value,
    logFault: () => {},
    watcherSources: {
      files,
      artifacts,
      projects,
      agentFilesRoot,
      workspaceId: WS,
    },
  });
  const harness: WatcherHarness = {
    dir,
    conn,
    tx,
    journal,
    ops,
    schedules: new SchedulesService({
      triggers,
      operations: operationsRepo,
      tx,
      now: () => clock.value,
    }),
    scheduler,
    operationId,
    files,
    artifacts,
    projects,
    agentFilesRoot,
    gitRoot,
    clock,
  };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    try {
      harness.conn.close();
    } finally {
      rmSync(harness.dir, { recursive: true, force: true });
    }
  }
});

const RUNTIME_ACTOR = { type: "runtime" as const, id: "scheduler" };
const USER_ACTOR = { type: "user" as const, id: "emon" };

describe("file watchers (AC5: once per real change, never per intermediate write)", () => {
  it("fires once for a workspace file change and not again for the same content", async () => {
    const harness = makeHarness();
    const created = harness.schedules.createTrigger(WS, {
      kind: "file_watch",
      name: "dataset watch",
      target_operation_id: harness.operationId,
      config: {
        scope: "workspace",
        path_uri: "workspace://datasets/report.md",
        provider: { provider_id: "prov_fake", model: "fake-model" },
      },
      catch_up_policy: "skip",
      actor: USER_ACTOR,
    });
    await harness.scheduler.tick();
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(0); // nothing yet

    harness.files.write(
      WS,
      "workspace://datasets/report.md",
      USER_ACTOR,
      Buffer.from("v1"),
      "text/markdown",
    );
    await harness.scheduler.tick();
    let runs = harness.ops.listRuns(WS, harness.operationId);
    expect(runs).toHaveLength(1);
    const stream = harness.journal.readFrom(WS, `task:${runs[0]?.run_id}`, 0, 10);
    expect(stream[0]?.event_type).toBe("trigger.file_event");

    // A second tick over the SAME state fires nothing (the signature holds).
    await harness.scheduler.tick();
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(1);

    // A content change fires once more.
    harness.files.write(
      WS,
      "workspace://datasets/report.md",
      USER_ACTOR,
      Buffer.from("v2"),
      "text/markdown",
    );
    await harness.scheduler.tick();
    runs = harness.ops.listRuns(WS, harness.operationId);
    expect(runs).toHaveLength(2);
    void created;
  });

  it("coalesces a rapid-change flood into ONE firing with the net signature", async () => {
    const harness = makeHarness();
    harness.schedules.createTrigger(WS, {
      kind: "file_watch",
      name: "flood watch",
      target_operation_id: harness.operationId,
      config: {
        scope: "workspace",
        path_uri: "workspace://flood.log",
        provider: { provider_id: "prov_fake", model: "fake-model" },
      },
      catch_up_policy: "skip",
      actor: USER_ACTOR,
    });
    // The baseline: the watcher adopts the observed state at start (a boot
    // never replays history — AC4).
    await harness.scheduler.tick();
    // The flood: twenty writes between two ticks — the tick observes only
    // the net signature, so exactly ONE run exists afterwards.
    for (let index = 0; index < 20; index += 1) {
      harness.files.write(
        WS,
        "workspace://flood.log",
        USER_ACTOR,
        Buffer.from(`write-${index}`),
        "text/plain",
      );
    }
    await harness.scheduler.tick();
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(1);
  });

  it("watches the agent's own private folder and restarts without double-firing (AC4)", async () => {
    const harness = makeHarness();
    harness.schedules.createTrigger(WS, {
      kind: "file_watch",
      name: "private notes watch",
      target_operation_id: harness.operationId,
      config: {
        scope: "agent",
        path_uri: `agent://${AGENT}/notes`,
        agent_id: AGENT,
        provider: { provider_id: "prov_fake", model: "fake-model" },
      },
      catch_up_policy: "skip",
      actor: USER_ACTOR,
    });
    await harness.scheduler.tick(); // the baseline adoption
    const privateFile = join(agentFolderDir(harness.agentFilesRoot, WS, AGENT), "notes.md");
    mkdirSync(dirname(privateFile), { recursive: true });
    writeFileSync(privateFile, "private thought v1", "utf8");
    await harness.scheduler.tick();
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(1);

    // RESTART: a fresh scheduler over the same database observes the SAME
    // state and re-fires nothing (the persisted signature is the truth).
    const restarted = new SchedulerService({
      workspaceId: WS,
      triggers: new TriggersRepository(harness.tx),
      operations: new OperationsRepository(harness.tx),
      ops: harness.ops,
      journal: harness.journal,
      events: new EventsService(harness.journal, harness.tx),
      tx: harness.tx,
      reservations: { reserveForRun: () => ({ ok: true, reservation_id: "res" }) },
      now: () => harness.clock.value,
      logFault: () => {},
      watcherSources: {
        files: harness.files,
        artifacts: harness.artifacts,
        projects: harness.projects,
        agentFilesRoot: harness.agentFilesRoot,
        workspaceId: WS,
      },
    });
    await restarted.tick();
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(1);
  });
});

describe("git watchers (the sha is the signature)", () => {
  it("fires once per new commit on the watched branch", async () => {
    const harness = makeHarness();
    const repoDir = join(harness.gitRoot, "thesis");
    mkdirSync(repoDir, { recursive: true });
    const git = simpleGit({ baseDir: repoDir });
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.email", "t@example.com");
    await git.addConfig("user.name", "T");
    writeFileSync(join(repoDir, "chapter.md"), "draft", "utf8");
    await git.add("./*");
    await git.commit("first");
    const projectId = `proj_${"0".repeat(8)}_${Math.random().toString(36).slice(2, 8)}`;
    harness.projects.insertProject({
      workspace_id: WS,
      project_id: projectId,
      name: "Thesis",
      source_kind: "directory",
      source_url: repoDir,
      repo_path: repoDir,
      default_branch: "main",
      access_mode: "shared",
      created_by_type: "user",
      created_by_id: "emon",
      created_at: harness.clock.value,
      updated_at: harness.clock.value,
    });
    const created = { project_id: projectId };
    harness.schedules.createTrigger(WS, {
      kind: "git_watch",
      name: "thesis main watch",
      target_operation_id: harness.operationId,
      config: {
        project_id: created.project_id,
        branch: "main",
        provider: { provider_id: "prov_fake", model: "fake-model" },
      },
      catch_up_policy: "skip",
      actor: USER_ACTOR,
    });
    // The FIRST tick after creation adopts the current sha as the baseline
    // without firing (the watcher starts from the observed state — a boot
    // never replays history).
    await harness.scheduler.tick();
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(0);

    // A new commit fires once.
    writeFileSync(join(repoDir, "chapter.md"), "draft v2", "utf8");
    await git.add("./*");
    await git.commit("second");
    await harness.scheduler.tick();
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(1);
    // No change, no firing.
    await harness.scheduler.tick();
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(1);
  });
});

describe("condition triggers (the typed-predicate evaluator, edge-triggered)", () => {
  it("fires once on the false→true edge and not again while true", async () => {
    const harness = makeHarness();
    harness.schedules.createTrigger(WS, {
      kind: "condition",
      name: "dataset ready",
      target_operation_id: harness.operationId,
      config: {
        predicate: { kind: "workspace_file_exists", path_uri: "workspace://ready.flag" },
        provider: { provider_id: "prov_fake", model: "fake-model" },
      },
      catch_up_policy: "skip",
      actor: USER_ACTOR,
    });
    await harness.scheduler.tick();
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(0);
    harness.files.write(
      WS,
      "workspace://ready.flag",
      USER_ACTOR,
      Buffer.from("go"),
      "text/plain",
    );
    await harness.scheduler.tick();
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(1);
    // Still true: no second firing (edge-triggered).
    await harness.scheduler.tick();
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(1);
  });

  it("evaluates the artifact-count predicate against real artifacts", async () => {
    const harness = makeHarness();
    harness.schedules.createTrigger(WS, {
      kind: "condition",
      name: "two artifacts ready",
      target_operation_id: harness.operationId,
      config: {
        predicate: { kind: "artifact_count_at_least", count: 2 },
        provider: { provider_id: "prov_fake", model: "fake-model" },
      },
      catch_up_policy: "skip",
      actor: USER_ACTOR,
    });
    harness.artifacts.insertArtifact({
      workspace_id: WS,
      name: "a.md",
      artifact_type: "document",
      mime_type: "text/markdown",
      content: Buffer.from("a"),
      producer_agent_id: null,
      producer_task_id: "run_x",
    });
    await harness.scheduler.tick();
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(0);
    harness.artifacts.insertArtifact({
      workspace_id: WS,
      name: "b.md",
      artifact_type: "document",
      mime_type: "text/markdown",
      content: Buffer.from("b"),
      producer_agent_id: null,
      producer_task_id: "run_x",
    });
    await harness.scheduler.tick();
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(1);
  });
});

describe("the task-completion cascade (AC6 parent linkage)", () => {
  it("fires a follow-up run with parent_task_id when a watched run settles", async () => {
    const harness = makeHarness();
    harness.schedules.createTrigger(WS, {
      kind: "task_completion",
      name: "follow-up after sweep",
      target_operation_id: harness.operationId,
      config: {
        outcomes: ["succeeded"],
        provider: { provider_id: "prov_fake", model: "fake-model" },
      },
      catch_up_policy: "skip",
      actor: USER_ACTOR,
    });
    // The watched run completes through the runtime's own machinery: the
    // terminal envelope flows through the post-commit fanout the scheduler
    // listens on.
    harness.ops.createRun(WS, harness.operationId, { run_id: "run_sweep" });
    harness.ops.applyRunState(WS, harness.operationId, "run_sweep", "QUEUED");
    harness.ops.applyRunState(WS, harness.operationId, "run_sweep", "RUNNING");
    harness.ops.applyRunState(WS, harness.operationId, "run_sweep", "SUCCEEDED");
    harness.scheduler.handleCommittedEvent({
      event_id: "evt_succeeded_1",
      stream_id: "run_sweep",
      sequence: 3,
      type: "task.succeeded",
      schema_version: 1,
      payload: {
        event_id: "evt_succeeded_1",
        stream_id: "task:run_sweep",
        sequence: 3,
        event_version: 1,
        actor: { type: "runtime", id: "test" },
        task_id: "run_sweep",
        conversation_id: harness.operationId,
        occurred_at: harness.clock.value,
        redaction_class: "internal",
        payload: {
          from_state: "RUNNING",
          to_state: "SUCCEEDED",
          reason: "run_completed",
          correlation_id: "cmd_complete_run_sweep",
        },
      },
      workspace_id: WS,
      occurred_at: harness.clock.value,
      correlation_id: "cmd_complete_run_sweep",
    } as unknown as EventEnvelope);

    const runs = harness.ops.listRuns(WS, harness.operationId);
    const followUp = runs.find((run) => run.run_id !== "run_sweep");
    expect(followUp).toBeTruthy();
    expect(followUp?.parent_task_id).toBe("run_sweep");
    const stream = harness.journal.readFrom(WS, `task:${followUp?.run_id}`, 0, 10);
    expect(stream[0]?.event_type).toBe("trigger.task_completed");
  });

  it("does not fire when the outcome is outside the configured vocabulary", async () => {
    const harness = makeHarness();
    harness.schedules.createTrigger(WS, {
      kind: "task_completion",
      name: "only on success",
      target_operation_id: harness.operationId,
      config: {
        outcomes: ["succeeded"],
        provider: { provider_id: "prov_fake", model: "fake-model" },
      },
      catch_up_policy: "skip",
      actor: USER_ACTOR,
    });
    harness.ops.createRun(WS, harness.operationId, { run_id: "run_failed" });
    harness.ops.applyRunState(WS, harness.operationId, "run_failed", "QUEUED");
    harness.ops.applyRunState(WS, harness.operationId, "run_failed", "RUNNING");
    harness.ops.applyRunState(WS, harness.operationId, "run_failed", "FAILED");
    harness.scheduler.handleCommittedEvent({
      event_id: "evt_failed_1",
      stream_id: "run_failed",
      sequence: 3,
      type: "task.failed",
      schema_version: 1,
      payload: {
        event_id: "evt_failed_1",
        stream_id: "task:run_failed",
        sequence: 3,
        event_version: 1,
        actor: { type: "runtime", id: "test" },
        task_id: "run_failed",
        conversation_id: harness.operationId,
        occurred_at: harness.clock.value,
        redaction_class: "internal",
        payload: {
          from_state: "RUNNING",
          to_state: "FAILED",
          reason: "run_failed",
          correlation_id: "cmd_fail_run_failed",
        },
      },
      workspace_id: WS,
      occurred_at: harness.clock.value,
      correlation_id: "cmd_fail_run_failed",
    } as unknown as EventEnvelope);
    expect(harness.ops.listRuns(WS, harness.operationId)).toHaveLength(1); // only the failed run itself
  });
});

type TriggerRowAlias = TriggerRecordRow;
void (0 as unknown as TriggerRowAlias | undefined);
