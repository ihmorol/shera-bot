/**
 * S13 chunk 2 red-first tests — Operation chat persistence + service.
 *
 * Governing decisions: D31 (Operation = workspace/chat with multiple
 * independently tracked runs; per-run state/events/credits/artifacts — AC24),
 * D34 (runs are created only from typed triggers; delegation creates child
 * runs), D36 (user controls the roster; the runtime validates against the
 * pinned pack), D46 (delegation creates subordinate runs under the parent
 * task; not a new object type), D49 (coordinator removable at ANY time; the
 * run continues peer-to-peer; removal is recorded).
 *
 * The suite pins the service contract chunk 3 will expose over HTTP:
 * createOperation runtime-validates the roster against the PINNED pack
 * catalog (typed refusals), roster commands persist RosterRefusals so the UI
 * can show why, remove-roster commands replay through their command receipts
 * (D23 rule 6) and answer an absent member as an idempotent no-op, runs are
 * isolated per run, delegation is idempotent on the
 * TaskDelegated event_id, collaboration events enforce gapless per-stream
 * sequences with sender attribution, and malformed input is typed-rejected —
 * never silently dropped.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import {
  appliedMigrationVersions,
  applyMigrations,
  sqliteTableExists,
} from "../../adapters/sqlite/migrations.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { CommandReceiptsRepository } from "../../adapters/sqlite/command-receipts-repository.ts";
import { ConversationsRepository } from "../../adapters/sqlite/conversations-repository.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import {
  OperationRecordCorruptError,
  OperationsRepository,
} from "../../adapters/sqlite/operations-repository.ts";
import { EventsService } from "../events/events.service.ts";
import {
  OperationsService,
  OperationsServiceError,
  type OperationPackCatalog,
} from "./operations.service.ts";

const here = dirname(fileURLToPath(import.meta.url));
const studentManifestPath = resolve(here, "../../../../../agent-packs/student/v1/manifest.json");
const studentManifest = JSON.parse(readFileSync(studentManifestPath, "utf8")) as {
  pack_id: string;
  version: string;
  agents: Array<{
    agent_id: string;
    display_name: string;
    role_description: string;
    default_provider: { provider_id: string; model: string };
    skills: string[];
    tools: { tool_id: string; version: string }[];
    connectors: string[];
    ui_identity: { avatar_hue: number; initial_glyph: string };
    home_operation_id: string | null;
  }>;
};

const WORKSPACE = "ws-primary";
const GENERAL = "agent_general_assistant";
const RESEARCHER = "agent_researcher";
const CITATION = "agent_citation_manager";
/** An agent id NO installed pack claims — refused as agent-not-in-pack. */
const UNKNOWN_AGENT = "agent_ghost";
/** An agent id claimed by a DIFFERENT pack — refused as foreign-pack-refused. */
const FOREIGN_AGENT = "agent_external_statistician";
const FOREIGN_PACK = "statistics-external";

const tempDirs: string[] = [];

let conn: SqliteConnection;
let tx: SqliteTransactions;
let repo: OperationsRepository;
let service: OperationsService;

/**
 * The pack catalog dependency (chunk 3 wires the real loaded pack over this
 * interface): the pinned pack identity + its agent roster, plus a resolver
 * that lets the runtime tell a FOREIGN pack's agent (foreign-pack-refused)
 * from an id no pack knows (agent-not-in-pack).
 */
const catalog: OperationPackCatalog = {
  pack_id: studentManifest.pack_id,
  pack_version: studentManifest.version,
  agents: studentManifest.agents,
  locateAgentPack(agentId: string): string | null {
    if (studentManifest.agents.some((agent) => agent.agent_id === agentId)) {
      return studentManifest.pack_id;
    }
    if (agentId === FOREIGN_AGENT) {
      return FOREIGN_PACK;
    }
    return null;
  },
};

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "shera-runtime-s13-operations-"));
  tempDirs.push(dir);
  conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  tx = new SqliteTransactions(conn.db);
  repo = new OperationsRepository(tx);
  service = new OperationsService({
    operations: repo,
    packCatalog: catalog,
    tx,
  });
});

afterEach(() => {
  conn.close();
});

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Build an operation.roster add envelope. Kept RAW — the service parses. */
function addRosterCommand(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command_id: "cmd_add_001",
    idempotency_key: "idem_add_0001",
    workspace_id: WORKSPACE,
    operation_id: "op_under_test",
    actor: { type: "user", id: "user_emon" },
    issued_at: "2026-10-24T10:00:00.000Z",
    type: "operation.add_roster_agent",
    agent_id: CITATION,
    pack_id: studentManifest.pack_id,
    pack_version: studentManifest.version,
    risk: { same_pack: true, cost_or_access_increasing: false, requires_approval: false },
    ...extra,
  };
}

/** Build an operation.remove_roster_agent envelope (RAW). */
function removeRosterCommand(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command_id: "cmd_remove_001",
    idempotency_key: "idem_remove_0001",
    workspace_id: WORKSPACE,
    operation_id: "op_under_test",
    actor: { type: "user", id: "user_emon" },
    issued_at: "2026-10-24T10:00:00.000Z",
    type: "operation.remove_roster_agent",
    agent_id: CITATION,
    ...extra,
  };
}

/** Build a D7 collaboration event envelope (RAW — the service validates). */
function collaborationEvent(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: "evt_001",
    workspace_id: WORKSPACE,
    operation_id: "op_under_test",
    run_id: null,
    sender_agent_id: GENERAL,
    recipient_agent_ids: [],
    correlation_id: "corr_001",
    issued_at: "2026-10-24T10:00:00.000Z",
    type: "ProgressReported",
    payload: { progress_text: "sources gathered" },
    ...extra,
  };
}

function createDefaultOperation(): ReturnType<OperationsService["createOperation"]> {
  return service.createOperation(WORKSPACE, {
    definition_ref: null,
    name: "Research Paper",
    roster_agent_ids: [RESEARCHER],
    coordinator_agent_id: GENERAL,
  });
}

describe("S13 chunk 2 — v6 migration shape", () => {
  it("creates the operation-chat tables, workspace-scoped, recorded as version 6", () => {
    // Chunk 3 appended v7 (operation chat binding + addressing) after this
    // migration; the v6 tables below remain the chunk-2 surface under test.
    expect(appliedMigrationVersions(conn.db)).toContain(7);

    for (const table of [
      "operations",
      "operation_roster",
      "operation_roster_refusals",
      "operation_coordinator_events",
      "operation_runs",
      "operation_collaboration_events",
    ]) {
      expect(sqliteTableExists(conn.db, table), `table ${table} must exist`).toBe(true);
    }
  });
});

describe("S13 chunk 2 — createOperation (D31, D36, D29 pinning)", () => {
  it("creates the record, validates the roster against the pinned pack, and builds the pinning snapshot", () => {
    const record = createDefaultOperation();

    expect(record.workspace_id).toBe(WORKSPACE);
    expect(record.name).toBe("Research Paper");
    expect(record.status).toBe("active");
    expect(record.definition_ref).toBeNull();
    expect(record.coordinator_agent_id).toBe(GENERAL);
    expect(record.pinning.pack_id).toBe(studentManifest.pack_id);
    expect(record.pinning.pack_version).toBe(studentManifest.version);
    expect(record.pinning.roster_agent_ids).toEqual([RESEARCHER]);
    // D38 snapshot placeholder: the roster's reachable capabilities, capped
    // and de-duplicated; the layered intersection arrives with its slice.
    expect(record.pinning.capabilities).toContain("skill_research_core");
    expect(record.pinning.capabilities).toContain("tool_web_search@1.4.0");
    expect(record.pinning.capabilities).toContain("connector_scholar_library");
    expect(record.pinning.provider_snapshot).toEqual({});

    // Roster membership is queryable at the storage layer, not only in JSON.
    const roster = repo.listRoster(WORKSPACE, record.operation_id);
    expect(roster.map((member) => member.agent_id)).toEqual([RESEARCHER]);

    // Read-after-write through the repository resolves the same record.
    expect(repo.getOperation(WORKSPACE, record.operation_id)).toEqual(record);
  });

  it("refuses a not-in-pack roster id with the typed agent-not-in-pack refusal", () => {
    const failure = (() => {
      try {
        service.createOperation(WORKSPACE, {
          definition_ref: null,
          name: "Research Paper",
          roster_agent_ids: [UNKNOWN_AGENT],
          coordinator_agent_id: GENERAL,
        });
        return null;
      } catch (error) {
        return error;
      }
    })();

    expect(failure).toBeInstanceOf(OperationsServiceError);
    const typed = failure as OperationsServiceError;
    expect(typed.code).toBe("OPERATION_ROSTER_REFUSED");
    expect(typed.refusal?.refusal_code).toBe("agent-not-in-pack");
    expect(typed.refusal?.agent_id).toBe(UNKNOWN_AGENT);
    // The refused creation must not leave a half-built operation behind.
    expect(service.listOperations(WORKSPACE)).toEqual([]);
  });

  it("refuses a foreign-pack roster id with the typed foreign-pack-refused refusal", () => {
    try {
      service.createOperation(WORKSPACE, {
        definition_ref: null,
        name: "Research Paper",
        roster_agent_ids: [FOREIGN_AGENT],
        coordinator_agent_id: GENERAL,
      });
      expect.unreachable("foreign-pack roster id must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(OperationsServiceError);
      const typed = error as OperationsServiceError;
      expect(typed.code).toBe("OPERATION_ROSTER_REFUSED");
      expect(typed.refusal?.refusal_code).toBe("foreign-pack-refused");
      expect(typed.refusal?.pack_id).toBe(FOREIGN_PACK);
    }
  });

  it("answers an unknown coordinator agent with a typed 404-class rejection and accepts 'none'", () => {
    try {
      service.createOperation(WORKSPACE, {
        definition_ref: null,
        name: "Research Paper",
        roster_agent_ids: [RESEARCHER],
        coordinator_agent_id: UNKNOWN_AGENT,
      });
      expect.unreachable("unknown coordinator must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(OperationsServiceError);
      const typed = error as OperationsServiceError;
      expect(typed.code).toBe("OPERATION_COORDINATOR_NOT_FOUND");
      expect(typed.category).toBe("state");
    }

    const record = service.createOperation(WORKSPACE, {
      definition_ref: null,
      name: "Coordinatorless",
      roster_agent_ids: [RESEARCHER],
      coordinator_agent_id: "none",
    });
    expect(record.coordinator_agent_id).toBe("none");
  });

  it("rejects duplicate roster ids as malformed input", () => {
    try {
      service.createOperation(WORKSPACE, {
        definition_ref: null,
        name: "Research Paper",
        roster_agent_ids: [RESEARCHER, RESEARCHER],
        coordinator_agent_id: GENERAL,
      });
      expect.unreachable("duplicate roster ids must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(OperationsServiceError);
      expect((error as OperationsServiceError).code).toBe("OPERATION_COMMAND_INVALID");
    }
  });
});

describe("S13 chunk 2 — per-run isolation (D31 / AC24)", () => {
  it("keeps three runs in one operation independent: state, events, credits, artifacts", () => {
    const operation = createDefaultOperation();
    const runA = service.createRun(WORKSPACE, operation.operation_id, {});
    const runB = service.createRun(WORKSPACE, operation.operation_id, {});
    const runC = service.createRun(WORKSPACE, operation.operation_id, {});
    expect(runA.run_id).not.toBe(runB.run_id);
    expect(runA.state).toBe("CREATED");
    expect(runA.events_seq_cursor).toBe(0);
    expect(runA.credits).toEqual({});
    expect(runA.artifacts).toEqual([]);

    service.applyRunState(WORKSPACE, operation.operation_id, runA.run_id, "RUNNING");
    service.recordRunCredits(WORKSPACE, operation.operation_id, runB.run_id, {
      tokens_used: 512,
    });
    const artifactC = service.publishRunArtifact(
      WORKSPACE,
      operation.operation_id,
      runC.run_id,
      "artifact_chart_1",
    );
    service.appendCollaborationEvent(
      collaborationEvent({
        operation_id: operation.operation_id,
        run_id: runA.run_id,
        event_id: "evt_run_a_1",
        type: "ProgressReported",
        payload: { progress_text: "A is working" },
      }),
    );

    const runs = service.listRuns(WORKSPACE, operation.operation_id);
    expect(runs).toHaveLength(3);
    const byId = new Map(runs.map((run) => [run.run_id, run]));
    expect(byId.get(runA.run_id)?.state).toBe("RUNNING");
    expect(byId.get(runB.run_id)?.state).toBe("CREATED");
    expect(byId.get(runC.run_id)?.state).toBe("CREATED");
    expect(byId.get(runB.run_id)?.credits).toEqual({ tokens_used: 512 });
    expect(byId.get(runA.run_id)?.credits).toEqual({});
    expect(byId.get(runC.run_id)?.artifacts).toEqual(["artifact_chart_1"]);
    expect(artifactC.artifacts).toEqual(["artifact_chart_1"]);
    expect(byId.get(runA.run_id)?.events_seq_cursor).toBe(1);
    expect(byId.get(runB.run_id)?.events_seq_cursor).toBe(0);
    expect(byId.get(runC.run_id)?.events_seq_cursor).toBe(0);
    // Publishing an artifact twice stays idempotent.
    const again = service.publishRunArtifact(
      WORKSPACE,
      operation.operation_id,
      runC.run_id,
      "artifact_chart_1",
    );
    expect(again.artifacts).toEqual(["artifact_chart_1"]);
  });
});

describe("S13 chunk 2 — coordinator lifecycle (D42/D49)", () => {
  it("removes the coordinator mid-run, records the removal, and lets the run finish", () => {
    const operation = createDefaultOperation();
    const run = service.createRun(WORKSPACE, operation.operation_id, {});
    service.applyRunState(WORKSPACE, operation.operation_id, run.run_id, "RUNNING");

    const afterRemoval = service.setCoordinator(WORKSPACE, operation.operation_id, "none");
    expect(afterRemoval.coordinator_agent_id).toBe("none");

    // D49: removal is RECORDED as an event ...
    const events = service.listCoordinatorEvents(WORKSPACE, operation.operation_id);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe("CoordinatorRemoved");
    expect(events[0]?.agent_id).toBe(GENERAL);

    // ... and the in-flight run is NOT cancelled or paused: it still advances.
    const finished = service.applyRunState(
      WORKSPACE,
      operation.operation_id,
      run.run_id,
      "SUCCEEDED",
    );
    expect(finished.state).toBe("SUCCEEDED");

    // A coordinator can be (re)assigned at any time, recorded as CoordinatorSet.
    const reassigned = service.setCoordinator(WORKSPACE, operation.operation_id, RESEARCHER);
    expect(reassigned.coordinator_agent_id).toBe(RESEARCHER);
    const eventsAfter = service.listCoordinatorEvents(WORKSPACE, operation.operation_id);
    expect(eventsAfter).toHaveLength(2);
    expect(eventsAfter[1]?.event_type).toBe("CoordinatorSet");
    expect(eventsAfter[1]?.agent_id).toBe(RESEARCHER);

    // Setting the SAME coordinator again changes nothing and records nothing.
    const unchanged = service.setCoordinator(WORKSPACE, operation.operation_id, RESEARCHER);
    expect(unchanged.coordinator_agent_id).toBe(RESEARCHER);
    expect(service.listCoordinatorEvents(WORKSPACE, operation.operation_id)).toHaveLength(2);
  });
});

describe("S13 chunk 2 — roster commands (D36)", () => {
  it("applies a same-pack low-risk add, updates the pinning, and is idempotent on re-apply", () => {
    const operation = createDefaultOperation();

    const first = service.addRosterAgent(
      addRosterCommand({ operation_id: operation.operation_id }),
    );
    expect(first.outcome).toBe("applied");
    if (first.outcome === "applied") {
      expect(first.operation.pinning.roster_agent_ids).toEqual([RESEARCHER, CITATION]);
    }
    expect(
      repo.listRoster(WORKSPACE, operation.operation_id).map((member) => member.agent_id),
    ).toEqual([RESEARCHER, CITATION]);

    const second = service.addRosterAgent(
      addRosterCommand({ operation_id: operation.operation_id }),
    );
    expect(second.outcome).toBe("applied");
    expect(repo.listRoster(WORKSPACE, operation.operation_id)).toHaveLength(2);
  });

  it("refuses a cost-increasing add without approval and PERSISTS the RosterRefusal", () => {
    const operation = createDefaultOperation();

    const result = service.addRosterAgent(
      addRosterCommand({
        operation_id: operation.operation_id,
        agent_id: CITATION,
        risk: { same_pack: true, cost_or_access_increasing: true, requires_approval: false },
      }),
    );
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.refusal_code).toBe("cost-increase-needs-approval");
      expect(result.refusal.agent_id).toBe(CITATION);
    }

    const persisted = service.listRosterRefusals(WORKSPACE, operation.operation_id);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.refusal_code).toBe("cost-increase-needs-approval");
    // The refused change must not have touched the roster or the pinning.
    expect(
      repo.listRoster(WORKSPACE, operation.operation_id).map((member) => member.agent_id),
    ).toEqual([RESEARCHER]);
    expect(repo.getOperation(WORKSPACE, operation.operation_id)?.pinning.roster_agent_ids).toEqual([
      RESEARCHER,
    ]);
  });

  it("refuses a foreign-pack add at the RUNTIME even when the envelope parses, and persists the refusal", () => {
    const operation = createDefaultOperation();

    // The contract boundary cannot know packs: this envelope parses, claims
    // same_pack, and names a foreign pack. The runtime's pack-catalog check
    // is the line of defense this test pins.
    const result = service.addRosterAgent(
      addRosterCommand({
        operation_id: operation.operation_id,
        agent_id: FOREIGN_AGENT,
        pack_id: FOREIGN_PACK,
        risk: { same_pack: true, cost_or_access_increasing: false, requires_approval: false },
      }),
    );
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.refusal_code).toBe("foreign-pack-refused");
      expect(result.refusal.agent_id).toBe(FOREIGN_AGENT);
      expect(result.refusal.pack_id).toBe(FOREIGN_PACK);
    }
    expect(service.listRosterRefusals(WORKSPACE, operation.operation_id)).toHaveLength(1);
    expect(
      repo.listRoster(WORKSPACE, operation.operation_id).map((member) => member.agent_id),
    ).toEqual([RESEARCHER]);
  });

  it("refuses a same-pack claim for an agent no pack knows (agent-not-in-pack), persisted", () => {
    const operation = createDefaultOperation();

    const result = service.addRosterAgent(
      addRosterCommand({
        operation_id: operation.operation_id,
        agent_id: UNKNOWN_AGENT,
      }),
    );
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.refusal_code).toBe("agent-not-in-pack");
    }
    expect(service.listRosterRefusals(WORKSPACE, operation.operation_id)).toHaveLength(1);
  });

  it("removes a roster member, updates the pinning, and replays the SAME command through its receipt (D23 rule 6)", () => {
    const operation = createDefaultOperation();
    service.addRosterAgent(addRosterCommand({ operation_id: operation.operation_id }));

    const command = removeRosterCommand({ operation_id: operation.operation_id });
    const removed = service.removeRosterAgent(command);
    expect(removed.outcome).toBe("applied");
    if (removed.outcome === "applied") {
      expect(removed.operation.pinning.roster_agent_ids).toEqual([RESEARCHER]);
    }
    expect(
      repo.listRoster(WORKSPACE, operation.operation_id).map((member) => member.agent_id),
    ).toEqual([RESEARCHER]);

    // Replay: the SAME command answers the original applied outcome through
    // its receipt — a committed removal is never re-answered with a 404
    // (D23 rule 6, the same receipts seam applyDelegation and the message
    // send use). Exactly one removal, one receipt row.
    const replay = service.removeRosterAgent(command);
    expect(replay.outcome).toBe("applied");
    if (replay.outcome === "applied") {
      expect(replay.operation.pinning.roster_agent_ids).toEqual([RESEARCHER]);
    }
    expect(repo.listRoster(WORKSPACE, operation.operation_id)).toHaveLength(1);
    const receipts = new CommandReceiptsRepository(tx);
    expect(receipts.countInWorkspace(WORKSPACE)).toBe(1);
  });

  it("answers a remove whose member is already gone as an applied no-op, not a 404", () => {
    // Add/remove symmetry (D23 rule 6): the add is naturally idempotent (the
    // membership primary key's DO NOTHING returns the current record), so a
    // remove of an absent member is the same idempotent no-op — the CURRENT
    // record, never a replayed-remove 404.
    const operation = createDefaultOperation();
    const result = service.removeRosterAgent(
      removeRosterCommand({
        operation_id: operation.operation_id,
        command_id: "cmd_remove_fresh",
        idempotency_key: "idem_remove_fresh_1",
        agent_id: CITATION,
      }),
    );
    expect(result.outcome).toBe("applied");
    if (result.outcome === "applied") {
      expect(result.operation.pinning.roster_agent_ids).toEqual([RESEARCHER]);
    }
    expect(
      repo.listRoster(WORKSPACE, operation.operation_id).map((member) => member.agent_id),
    ).toEqual([RESEARCHER]);
  });

  it("caps the persisted refusals read at the 20 most recent, newest first", () => {
    const operation = createDefaultOperation();
    for (let index = 1; index <= 21; index += 1) {
      repo.recordRosterRefusal(WORKSPACE, {
        operation_id: operation.operation_id,
        agent_id: UNKNOWN_AGENT,
        pack_id: null,
        refusal_code: "agent-not-in-pack",
        message: `refusal ${index}`,
        command_json: "null",
        created_at: "2026-10-24T10:00:00.000Z",
      });
    }
    const refusals = service.listRosterRefusals(WORKSPACE, operation.operation_id);
    expect(refusals).toHaveLength(20);
    // Newest first: the latest refusals lead (the "recent" in the name is
    // honest, and the detail read model's most-recent pick is refusals[0]).
    expect(refusals[0]?.message).toBe("refusal 21");
    expect(refusals[19]?.message).toBe("refusal 2");
  });

  it("records requires_approval on the membership row for an approval-declared cost-increasing add (D36/AC3)", () => {
    const operation = createDefaultOperation();

    // Cost-increasing WITH the approval flag declared: the contract's
    // superRefine passes, the runtime applies the add, and the membership
    // row carries the declared approval (the approval-ARTIFACT gate is the
    // approvals slice's; the flag recording is THIS slice's contract).
    const result = service.addRosterAgent(
      addRosterCommand({
        operation_id: operation.operation_id,
        agent_id: CITATION,
        risk: { same_pack: true, cost_or_access_increasing: true, requires_approval: true },
      }),
    );
    expect(result.outcome).toBe("applied");
    if (result.outcome === "applied") {
      expect(result.operation.pinning.roster_agent_ids).toEqual([RESEARCHER, CITATION]);
    }

    const member = repo
      .listRoster(WORKSPACE, operation.operation_id)
      .find((row) => row.agent_id === CITATION);
    expect(member?.requires_approval).toBe(1);
    // The service's roster read (the read model's source) exposes it too.
    expect(
      service
        .listRoster(WORKSPACE, operation.operation_id)
        .find((row) => row.agent_id === CITATION)?.requires_approval,
    ).toBe(1);
    // A low-risk add records NO approval flag.
    service.addRosterAgent(
      addRosterCommand({
        operation_id: operation.operation_id,
        command_id: "cmd_add_lowrisk",
        idempotency_key: "idem_add_lowrisk_1",
        agent_id: GENERAL,
      }),
    );
    expect(
      repo
        .listRoster(WORKSPACE, operation.operation_id)
        .find((row) => row.agent_id === GENERAL)?.requires_approval,
    ).toBe(0);
  });

  it("answers an unknown operation for roster commands with a typed 404-class error", () => {
    try {
      service.addRosterAgent(addRosterCommand({ operation_id: "op_missing" }));
      expect.unreachable("unknown operation must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(OperationsServiceError);
      const typed = error as OperationsServiceError;
      expect(typed.code).toBe("OPERATION_NOT_FOUND");
      expect(typed.category).toBe("state");
    }
  });
});

describe("S13 chunk 2 — delegation (D34/D46)", () => {
  it("creates exactly one child run per TaskDelegated event, idempotent on event_id", () => {
    const operation = createDefaultOperation();
    const parent = service.createRun(WORKSPACE, operation.operation_id, {});
    service.applyRunState(WORKSPACE, operation.operation_id, parent.run_id, "RUNNING");

    const delegated = collaborationEvent({
      operation_id: operation.operation_id,
      run_id: parent.run_id,
      event_id: "evt_delegate_001",
      type: "TaskDelegated",
      payload: { task_description: "Check every citation for the draft" },
    });

    const first = service.applyDelegation(delegated);
    expect(first.created).toBe(true);
    expect(first.child_run.parent_task_id).toBe(parent.run_id);
    expect(first.child_run.operation_id).toBe(operation.operation_id);
    expect(first.child_run.state).toBe("CREATED");

    const replay = service.applyDelegation(delegated);
    expect(replay.created).toBe(false);
    expect(replay.child_run.run_id).toBe(first.child_run.run_id);

    const runs = service.listRuns(WORKSPACE, operation.operation_id);
    expect(runs).toHaveLength(2);
    expect(runs.filter((run) => run.parent_task_id === parent.run_id)).toHaveLength(1);

    // The TaskDelegated event itself is visible in the collaboration stream.
    const events = service.listCollaborationEvents(WORKSPACE, operation.operation_id, {
      run_id: parent.run_id,
    });
    expect(events.some((persisted) => persisted.event.event_id === "evt_delegate_001")).toBe(true);
  });

  it("rejects malformed delegation input with typed rejections", () => {
    const operation = createDefaultOperation();
    const parent = service.createRun(WORKSPACE, operation.operation_id, {});

    // A runless TaskDelegated cannot create a child run: the D34/D46 parent
    // link is mandatory for delegation.
    try {
      service.applyDelegation(
        collaborationEvent({
          operation_id: operation.operation_id,
          run_id: null,
          event_id: "evt_delegate_norun",
          type: "TaskDelegated",
          payload: { task_description: "orphan delegation" },
        }),
      );
      expect.unreachable("runless delegation must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(OperationsServiceError);
      expect((error as OperationsServiceError).code).toBe("OPERATION_EVENT_INVALID");
    }

    // Only TaskDelegated events create delegated runs.
    try {
      service.applyDelegation(
        collaborationEvent({
          operation_id: operation.operation_id,
          run_id: parent.run_id,
          event_id: "evt_not_delegation",
        }),
      );
      expect.unreachable("non-delegation events must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(OperationsServiceError);
      expect((error as OperationsServiceError).code).toBe("OPERATION_EVENT_INVALID");
    }

    // The parent run must exist.
    try {
      service.applyDelegation(
        collaborationEvent({
          operation_id: operation.operation_id,
          run_id: "run_missing_parent",
          event_id: "evt_delegate_orphan",
          type: "TaskDelegated",
          payload: { task_description: "no such parent" },
        }),
      );
      expect.unreachable("unknown parent run must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(OperationsServiceError);
      expect((error as OperationsServiceError).code).toBe("OPERATION_RUN_NOT_FOUND");
    }
  });

  it("keeps the parent run unaffected by its child's failure", () => {
    const operation = createDefaultOperation();
    const parent = service.createRun(WORKSPACE, operation.operation_id, {});
    service.applyRunState(WORKSPACE, operation.operation_id, parent.run_id, "RUNNING");

    const delegation = service.applyDelegation(
      collaborationEvent({
        operation_id: operation.operation_id,
        run_id: parent.run_id,
        event_id: "evt_delegate_fail",
        type: "TaskDelegated",
        payload: { task_description: "doomed subtask" },
      }),
    );
    service.applyRunState(WORKSPACE, operation.operation_id, delegation.child_run.run_id, "FAILED");

    const parentAfter = service.getRun(WORKSPACE, operation.operation_id, parent.run_id);
    expect(parentAfter.state).toBe("RUNNING");
    expect(
      service.getRun(WORKSPACE, operation.operation_id, delegation.child_run.run_id).state,
    ).toBe("FAILED");
  });
});

describe("S13 chunk 2 — collaboration events (D7, D26)", () => {
  it("appends with gapless per-stream sequences, sender attribution, cursor advance, and cursor reads", () => {
    const operation = createDefaultOperation();
    const runA = service.createRun(WORKSPACE, operation.operation_id, {});
    const runB = service.createRun(WORKSPACE, operation.operation_id, {});

    // Operation-chat stream (run_id null): sequences 1, 2 — gapless.
    const opEvent1 = service.appendCollaborationEvent(
      collaborationEvent({ operation_id: operation.operation_id, event_id: "evt_op_1" }),
    );
    expect(opEvent1.sequence).toBe(1);
    expect(opEvent1.created).toBe(true);
    const opEvent2 = service.appendCollaborationEvent(
      collaborationEvent({ operation_id: operation.operation_id, event_id: "evt_op_2" }),
    );
    expect(opEvent2.sequence).toBe(2);

    // Run streams are INDEPENDENT: each starts at 1 and advances the run's
    // D26 events_seq_cursor (0 = none yet).
    const runAEvent1 = service.appendCollaborationEvent(
      collaborationEvent({
        operation_id: operation.operation_id,
        run_id: runA.run_id,
        event_id: "evt_a_1",
        sender_agent_id: RESEARCHER,
        recipient_agent_ids: [GENERAL],
        type: "QuestionRaised",
        payload: { question_text: "Which citation style?" },
      }),
    );
    expect(runAEvent1.sequence).toBe(1);
    const runBEvent1 = service.appendCollaborationEvent(
      collaborationEvent({
        operation_id: operation.operation_id,
        run_id: runB.run_id,
        event_id: "evt_b_1",
      }),
    );
    expect(runBEvent1.sequence).toBe(1);
    const runAEvent2 = service.appendCollaborationEvent(
      collaborationEvent({
        operation_id: operation.operation_id,
        run_id: runA.run_id,
        event_id: "evt_a_2",
      }),
    );
    expect(runAEvent2.sequence).toBe(2);

    // Sender attribution and typed payload survive persistence (validated read).
    const rereadA = service.listCollaborationEvents(WORKSPACE, operation.operation_id, {
      run_id: runA.run_id,
    });
    expect(rereadA.map((persisted) => persisted.sequence)).toEqual([1, 2]);
    expect(rereadA[0]?.event.type).toBe("QuestionRaised");
    if (rereadA[0]?.event.type === "QuestionRaised") {
      expect(rereadA[0].event.payload.question_text).toBe("Which citation style?");
      expect(rereadA[0].event.sender_agent_id).toBe(RESEARCHER);
      expect(rereadA[0].event.recipient_agent_ids).toEqual([GENERAL]);
    }

    // Cursor reads: everything after a sequence, per stream.
    const afterFirst = service.listCollaborationEvents(WORKSPACE, operation.operation_id, {
      run_id: runA.run_id,
      after_sequence: 1,
    });
    expect(afterFirst.map((persisted) => persisted.sequence)).toEqual([2]);

    // The run rows carry the advanced D26 cursor; other runs stay untouched.
    expect(service.getRun(WORKSPACE, operation.operation_id, runA.run_id).events_seq_cursor).toBe(
      2,
    );
    expect(service.getRun(WORKSPACE, operation.operation_id, runB.run_id).events_seq_cursor).toBe(
      1,
    );

    // Duplicate event_id is an idempotent no-op returning the ORIGINAL event.
    const duplicate = service.appendCollaborationEvent(
      collaborationEvent({
        operation_id: operation.operation_id,
        run_id: runA.run_id,
        event_id: "evt_a_1",
      }),
    );
    expect(duplicate.created).toBe(false);
    expect(duplicate.sequence).toBe(1);
    expect(
      service.listCollaborationEvents(WORKSPACE, operation.operation_id, { run_id: runA.run_id }),
    ).toHaveLength(2);
  });

  it("refuses a bare TaskDelegated append — delegation goes only through applyDelegation (D34/D46)", () => {
    const operation = createDefaultOperation();
    const parent = service.createRun(WORKSPACE, operation.operation_id, {});

    try {
      service.appendCollaborationEvent(
        collaborationEvent({
          operation_id: operation.operation_id,
          run_id: parent.run_id,
          event_id: "evt_bare_delegate",
          type: "TaskDelegated",
          payload: { task_description: "in-process bypass" },
        }),
      );
      expect.unreachable("a bare TaskDelegated append must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(OperationsServiceError);
      const typed = error as OperationsServiceError;
      expect(typed.code).toBe("OPERATION_EVENT_INVALID");
      expect(typed.category).toBe("validation");
    }

    // Nothing persisted: no event row, no child run (exactly-one-child holds
    // — only applyDelegation may materialize a TaskDelegated's child run).
    expect(service.listCollaborationEvents(WORKSPACE, operation.operation_id, {})).toEqual([]);
    expect(service.listRuns(WORKSPACE, operation.operation_id)).toHaveLength(1);
    // The delegation path itself still works (exactly one child run).
    const delegated = service.applyDelegation(
      collaborationEvent({
        operation_id: operation.operation_id,
        run_id: parent.run_id,
        event_id: "evt_via_delegation",
        type: "TaskDelegated",
        payload: { task_description: "the sanctioned path" },
      }),
    );
    expect(delegated.created).toBe(true);
    expect(
      service
        .listRuns(WORKSPACE, operation.operation_id)
        .filter((run) => run.parent_task_id === parent.run_id),
    ).toHaveLength(1);
  });

  it("typed-rejects malformed collaboration events instead of silently dropping them", () => {
    const operation = createDefaultOperation();

    // Missing a required payload field.
    expect(() =>
      service.appendCollaborationEvent(
        collaborationEvent({ operation_id: operation.operation_id, payload: {} }),
      ),
    ).toThrow(OperationsServiceError);

    // Unknown event type.
    try {
      service.appendCollaborationEvent(
        collaborationEvent({
          operation_id: operation.operation_id,
          event_id: "evt_bad_type",
          type: "SingASong",
          payload: {},
        }),
      );
      expect.unreachable("unknown event type must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(OperationsServiceError);
      const typed = error as OperationsServiceError;
      expect(typed.code).toBe("OPERATION_EVENT_INVALID");
      expect(typed.category).toBe("validation");
    }

    // An extra envelope field violates the strict D7 envelope.
    expect(() =>
      service.appendCollaborationEvent(
        collaborationEvent({
          operation_id: operation.operation_id,
          event_id: "evt_extra_field",
          sneaky_field: "nope",
        }),
      ),
    ).toThrow(OperationsServiceError);

    // Nothing malformed was persisted.
    expect(service.listCollaborationEvents(WORKSPACE, operation.operation_id, {})).toEqual([]);
  });
});

describe("S13 chunk 3 — thread read model corruption defense (D41)", () => {
  it("typed-corrupts a thread read when a journaled message sender is malformed", () => {
    // The chat-composed service (the same wiring composeRuntime uses): a real
    // conversation row, real journal appends, real stream reads.
    const conversations = new ConversationsRepository(tx);
    const journal = new EventJournalRepository(tx);
    const chat = new OperationsService({
      operations: repo,
      packCatalog: catalog,
      tx,
      conversations,
      events: new EventsService(journal, tx),
      journal,
    });

    const operation = createDefaultOperation();
    const sent = chat.sendOperationMessage(WORKSPACE, operation.operation_id, {
      idempotency_key: "idem_corrupt_sender_1",
      sender: { kind: "user", display_name: "Emon" },
      text: "read me before the corruption",
    });
    expect(sent.kind).toBe("message_sent");

    // Corrupt the journaled sender behind the runtime's back: a payload that
    // no longer conforms to the MessageSender union must surface as typed
    // corruption on the thread read — never a silently cast thread item.
    const original = journal.findById(WORKSPACE, sent.event_id);
    expect(original).not.toBeNull();
    const payload = JSON.parse(original!.payload) as Record<string, unknown>;
    conn.db
      .prepare("UPDATE event_journal SET payload = ? WHERE workspace_id = ? AND event_id = ?")
      .run(
        JSON.stringify({ ...payload, sender: { kind: "telepathy", target: "everyone" } }),
        WORKSPACE,
        sent.event_id,
      );

    try {
      chat.getThread(WORKSPACE, operation.operation_id);
      expect.unreachable("a malformed journaled sender must surface as typed corruption");
    } catch (error) {
      expect(error).toBeInstanceOf(OperationRecordCorruptError);
    }
  });
});

describe("S13 chunk 2 — typed 404-class rejections and E12 scoping", () => {
  it("answers unknown operation/run ids with typed state-category errors", () => {
    const operation = createDefaultOperation();

    const attempts: Array<() => void> = [
      () => service.getOperation(WORKSPACE, "op_missing"),
      () => service.listRuns(WORKSPACE, "op_missing"),
      () => service.createRun(WORKSPACE, "op_missing", {}),
      () => service.applyRunState(WORKSPACE, operation.operation_id, "run_missing", "RUNNING"),
      () => service.recordRunCredits(WORKSPACE, operation.operation_id, "run_missing", {}),
      () => service.publishRunArtifact(WORKSPACE, operation.operation_id, "run_missing", "a1"),
      () => service.getRun(WORKSPACE, operation.operation_id, "run_missing"),
      () => service.listCoordinatorEvents(WORKSPACE, "op_missing"),
      () => service.listRosterRefusals(WORKSPACE, "op_missing"),
      () => service.listCollaborationEvents(WORKSPACE, "op_missing", {}),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
        expect.unreachable("expected a typed OPERATION_NOT_FOUND / OPERATION_RUN_NOT_FOUND");
      } catch (error) {
        expect(error).toBeInstanceOf(OperationsServiceError);
        const typed = error as OperationsServiceError;
        expect(["OPERATION_NOT_FOUND", "OPERATION_RUN_NOT_FOUND"]).toContain(typed.code);
        expect(typed.category).toBe("state");
      }
    }
  });

  it("keeps the same operation id in two workspaces independent (E12)", () => {
    const record = createDefaultOperation();
    const foreignCopy = {
      ...record,
      workspace_id: "ws-secondary",
      name: "Research Paper (other workspace)",
    };
    repo.createOperation("ws-secondary", foreignCopy);

    expect(repo.getOperation(WORKSPACE, record.operation_id)?.name).toBe("Research Paper");
    expect(repo.getOperation("ws-secondary", record.operation_id)?.name).toBe(
      "Research Paper (other workspace)",
    );
    // Runs created in one workspace never leak into the other's operation.
    service.createRun(WORKSPACE, record.operation_id, {});
    expect(service.listRuns("ws-secondary", record.operation_id)).toEqual([]);
  });
});
