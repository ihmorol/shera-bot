/**
 * Workspace pack pinning tests (S10; D19/D28/D29).
 *
 * loadWorkspacePack resolves a pack through the agent-pack-sdk, verifies its
 * runtime_compatibility against RUNTIME_VERSION (typed failure before any
 * task can use the pack — G4), and pins it on the workspace. The upgrade
 * test proves the D19 invariant at the journal level: a pack upgrade moves
 * the workspace pin forward and changes NEW tasks only — an existing task's
 * task.created payload keeps the exact snapshot it was created with.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { PackCompatibilityError } from "@shera-bot/agent-pack-sdk";

import { readFileSync } from "node:fs";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { WorkspacesRepository } from "../../adapters/sqlite/workspaces-repository.ts";
import { EventsService } from "../events/events.service.ts";
import { createTaskRunFromTypedEvent } from "../tasks/task-run-creator.ts";
import { RUNTIME_VERSION } from "../../version.ts";
import { loadWorkspacePack } from "./pack-pin.ts";

const tempDirs: string[] = [];
const WS = "ws-11111111-1111-4111-8111-111111111111";
const NOW = "2026-09-28T12:00:00.000Z";

/**
 * A minimal VALID manifest (mirrors the SDK's own test fixture shape — G3:
 * clean by construction, no credential-shaped values). `runtimeCompatibility`
 * defaults to THIS runtime's line so the happy-path tests load it.
 */
function minimalManifest(
  mutate?: (m: Record<string, unknown>) => void,
): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    pack_id: "student",
    version: "1.0.0",
    title: "Student Pack",
    runtime_compatibility: `^${RUNTIME_VERSION}`,
    default_coordinator_agent_id: "general_assistant",
    skills: [{ skill_id: "research_basics", version: "1.0.0", title: "Research basics" }],
    connectors: [],
    tool_allow_list: [{ tool_id: "web_search", version: "1.0.0" }],
    agents: [
      {
        agent_id: "general_assistant",
        display_name: "General Assistant",
        role_description: "Coordinates Operations and helps with everyday questions.",
        default_provider: { provider_id: "platform_default", model: "shera-default" },
        skills: [],
        tools: [],
        connectors: [],
        ui_identity: { avatar_hue: 210, initial_glyph: "G" },
        home_operation_id: null,
      },
      {
        agent_id: "researcher",
        display_name: "Researcher",
        role_description: "Finds and summarizes sources for research work.",
        default_provider: { provider_id: "platform_default", model: "shera-default" },
        skills: ["research_basics"],
        tools: [{ tool_id: "web_search", version: "1.0.0" }],
        connectors: [],
        ui_identity: { avatar_hue: 120, initial_glyph: "R" },
        home_operation_id: "research_paper",
      },
    ],
    operations: [
      {
        operation_id: "research_paper",
        version: "1.0.0",
        title: "Research Paper",
        purpose: "Plan, draft, and check a research paper.",
        roster: ["general_assistant", "researcher"],
        skills: ["research_basics"],
        connectors: [],
      },
    ],
  };
  mutate?.(manifest);
  return manifest;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "shera-pack-pin-"));
  tempDirs.push(root);
  return root;
}

function writePack(
  root: string,
  packId: string,
  dirName: string,
  manifest: Record<string, unknown>,
): void {
  const dir = join(root, packId, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function newDb(): { conn: SqliteConnection; tx: SqliteTransactions; journal: EventJournalRepository; workspaces: WorkspacesRepository } {
  const conn = openDatabase(join(tempRoot(), "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  return {
    conn,
    tx,
    journal: new EventJournalRepository(tx),
    workspaces: new WorkspacesRepository(tx),
  };
}

/** A minimal D34 trigger (typed protocol event — G2; nothing else creates runs). */
function trigger(eventId: string): Parameters<typeof createTaskRunFromTypedEvent>[0] {
  return {
    event_id: eventId,
    stream_id: "conversation:conv_001",
    sequence: 1,
    event_version: 1,
    actor: { type: "system", id: "scheduler" },
    task_id: `task_${eventId}`,
    conversation_id: "conv_001",
    occurred_at: NOW,
    redaction_class: "internal",
    event_type: "trigger.scheduled",
    payload: { schedule_id: "sch_001", due_at: NOW },
  } as Parameters<typeof createTaskRunFromTypedEvent>[0];
}

function creatorDeps(packSnapshot: { pack_id: string; pack_version: string; pack_hash: string }) {
  const db = newDb();
  const events = new EventsService(db.journal, db.tx);
  return {
    db,
    events,
    deps: {
      pinned_pack: packSnapshot,
      workspace_id: WS,
      clock: { now: NOW, next_sequence: 1 },
    },
  };
}

describe("RUNTIME_VERSION (S10 checkCompatibility seam)", () => {
  it("stays in sync with the runtime package version", () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../../package.json"), "utf8"),
    ) as { version: string };
    expect(RUNTIME_VERSION).toBe(pkg.version);
  });
});

describe("loadWorkspacePack (D19/D28)", () => {
  it("loads the real student pack from the repository tree and pins it on the workspace", () => {
    // The in-repo tree: agent-packs/ at the repository root (this test file
    // sits at apps/user-runtime/src/modules/runtime/ — five levels up).
    const packsRoot = join(import.meta.dirname, "../../../../../agent-packs");
    const db = newDb();
    const loaded = loadWorkspacePack({
      packsRoot,
      packId: "student",
      packVersion: "1.0.0",
      workspaceId: WS,
      workspaces: db.workspaces,
      now: NOW,
    });
    expect(loaded.manifest.pack_id).toBe("student");
    expect(loaded.manifest.version).toBe("1.0.0");
    expect(loaded.pin).toEqual({
      agent_pack_id: "student",
      agent_pack_version: "1.0.0",
      manifest_hash: loaded.manifest_hash,
      installed_at: NOW,
    });
    expect(db.workspaces.findPinnedPack(WS)).toEqual(loaded.pin);
  });

  it("refuses a pack built for another runtime line with the typed compatibility error (G4)", () => {
    const root = tempRoot();
    const manifest = minimalManifest((m) => {
      m.version = "9.0.0";
      m.runtime_compatibility = "^9.0.0";
    });
    writePack(root, "student", "v1", manifest);
    const db = newDb();
    expect(() =>
      loadWorkspacePack({
        packsRoot: root,
        packId: "student",
        packVersion: "9.0.0",
        workspaceId: WS,
        workspaces: db.workspaces,
      }),
    ).toThrow(PackCompatibilityError);
    // The failed load pins nothing.
    expect(db.workspaces.findPinnedPack(WS)).toBeNull();
  });
});

describe("pack upgrade affects NEW tasks only (D19 — the journal proves it)", () => {
  it("keeps an existing task's payload snapshot verbatim across an upgrade", () => {
    const root = tempRoot();
    writePack(
      root,
      "student",
      "v1",
      minimalManifest((m) => {
        m.version = "1.0.0";
      }),
    );
    writePack(
      root,
      "student",
      "v2",
      minimalManifest((m) => {
        m.version = "2.0.0";
      }),
    );
    const { db, events, deps } = creatorDeps({
      pack_id: "student",
      pack_version: "1.0.0",
      pack_hash: "a".repeat(64),
    });
    db.workspaces.ensureWorkspace(WS);

    // Task A is created under the v1 pin; its task.created payload records it.
    const workspaces = new WorkspacesRepository(db.tx);
    void workspaces;
    /** Map the built envelope onto the journal's AppendEventInput shape. */
    const appendCreated = (created: (typeof a.creation_event)) => {
      const payload = created.payload as Record<string, unknown> & { correlation_id: string };
      return events.appendEvent({
        event_id: created.event_id,
        stream_id: created.stream_id,
        type: created.event_type,
        // Task-event rows store the FULL envelope as their payload (S07 5a;
        // the envelope IS the durable D26 event).
        payload: created,
        workspace_id: WS,
        correlation_id: payload.correlation_id,
      });
    };
    const a = createTaskRunFromTypedEvent(trigger("evt_trig_a"), {
      ...deps,
      pinned_pack: { pack_id: "student", pack_version: "1.0.0", pack_hash: "a".repeat(64) },
      clock: { now: NOW, next_sequence: 1 },
    });
    if (!a.ok) throw new Error("task A creation failed");
    appendCreated(a.creation_event);

    // The workspace upgrades to v2.
    const v2 = loadWorkspacePack({
      packsRoot: root,
      packId: "student",
      packVersion: "2.0.0",
      workspaceId: WS,
      workspaces: db.workspaces,
      now: NOW,
    });
    expect(v2.pin.agent_pack_version).toBe("2.0.0");

    // Task B is created AFTER the upgrade; its payload records v2.
    const b = createTaskRunFromTypedEvent(trigger("evt_trig_b"), {
      ...deps,
      pinned_pack: {
        pack_id: v2.pin.agent_pack_id,
        pack_version: v2.pin.agent_pack_version,
        pack_hash: v2.pin.manifest_hash,
      },
      clock: { now: NOW, next_sequence: 2 },
    });
    if (!b.ok) throw new Error("task B creation failed");
    appendCreated(b.creation_event);

    // Read BOTH payloads back from the journal — the durable record (D26).
    // The row payload holds the FULL envelope (S07 5a); the pack snapshot
    // lives inside its .payload. Rows come back as an array; the stored
    // payload is JSON text.
    const streamOf = (taskId: string) => `task:${taskId}`;
    const snapOf = (taskId: string): { pack_snapshot?: { pack_version: string } } => {
      const rows = db.journal.readFrom(WS, streamOf(taskId), 0, 10);
      const stored = rows[0]?.payload;
      const envelope = typeof stored === "string" ? JSON.parse(stored) : stored;
      return (envelope as { payload: { pack_snapshot?: { pack_version: string } } }).payload;
    };
    expect(snapOf("task_evt_trig_a")?.pack_snapshot?.pack_version).toBe("1.0.0");
    expect(snapOf("task_evt_trig_b")?.pack_snapshot?.pack_version).toBe("2.0.0");
  });
});
