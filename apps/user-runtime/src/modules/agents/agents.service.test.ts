/**
 * Agents service tests for the D16 typed settings surface (S11 chunk 3).
 *
 * getSettings composes the read model from three sources — the agents row
 * (pack-owned fields + the user-owned columns), the validated overrides blob
 * (tool defaults), and the pinned pack's seeds (the recommended provider
 * default). applySettingsCommand applies the contracts' command union and
 * returns the read-after-write snapshot, so onboarding (S30) can reuse the
 * exact same call path. Reset-to-default restores the PACK's recommendation,
 * never a hardcoded value, and pack-owned entries are never command targets.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AgentSettingsCommand,
  type AgentSettingsSnapshot,
} from "@shera-bot/contracts";

import {
  AgentsRepository,
  AgentNotFoundError,
  AgentSettingsValidationError,
} from "../../adapters/sqlite/agents-repository.ts";
import { ConversationsRepository } from "../../adapters/sqlite/conversations-repository.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventsService } from "../events/events.service.ts";
import { AgentsService, AgentSettingsResetUnavailableError } from "./agents.service.ts";

const here = dirname(fileURLToPath(import.meta.url));
const studentManifestPath = resolve(
  here,
  "../../../../../agent-packs/student/v1/manifest.json",
);
const studentManifest = JSON.parse(readFileSync(studentManifestPath, "utf8")) as {
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

const GENERAL = "agent_general_assistant";
const generalManifest = studentManifest.agents.find((agent) => agent.agent_id === GENERAL)!;
const RESEARCHER = "agent_researcher";
const researcherManifest = studentManifest.agents.find(
  (agent) => agent.agent_id === RESEARCHER,
)!;

const tempDirs: string[] = [];

let conn: SqliteConnection;
let tx: SqliteTransactions;
let service: AgentsService;
let repo: AgentsRepository;

function command(
  extra: Record<string, unknown> & { type: string },
  agentId: string = GENERAL,
): AgentSettingsCommand {
  return AgentSettingsCommand.parse({
    command_id: "cmd_test_001",
    idempotency_key: "idem_test_0001",
    workspace_id: "ws-primary",
    agent_id: agentId,
    actor: { type: "user", id: "user_emon" },
    issued_at: "2026-10-07T10:00:00.000Z",
    ...extra,
  });
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "shera-runtime-s11-agents-service-"));
  tempDirs.push(dir);
  conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  tx = new SqliteTransactions(conn.db);
  repo = new AgentsRepository(tx);
  repo.upsertFromPack("ws-primary", studentManifest.agents);
  service = new AgentsService({
    agents: repo,
    conversations: new ConversationsRepository(tx),
    journal: new EventsService(new EventJournalRepository(tx), tx),
    tx,
    packAgents: studentManifest.agents,
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

function entry(snapshot: AgentSettingsSnapshot, key: string) {
  const found = snapshot.entries.find((candidate) => candidate.key === key);
  expect(found, `entry ${key} must exist`).toBeDefined();
  return found!;
}

describe("AgentsService.getSettings (D16 read model)", () => {
  it("composes every D16 entry with recommended default, current value, and metadata", () => {
    const snapshot = service.getSettings("ws-primary", GENERAL);

    expect(snapshot).toMatchObject({ workspace_id: "ws-primary", agent_id: GENERAL });
    expect(snapshot.entries.map((entry) => entry.key)).toEqual([
      "role",
      "user_instructions",
      "memory_link",
      "default_provider",
      "tool_defaults",
      "capabilities",
      "ui_identity",
    ]);

    // Pack-owned: read-only, never resettable, pack value IS the current value.
    expect(entry(snapshot, "role")).toMatchObject({
      editable: false,
      resettable: false,
      reset_command: null,
      value: generalManifest.role_description,
      recommended_default: null,
      display_label: expect.any(String),
      description: expect.stringMatching(/\S/),
    });
    expect(entry(snapshot, "capabilities")).toMatchObject({
      editable: false,
      value: {
        skills: generalManifest.skills,
        tools: generalManifest.tools,
        connectors: generalManifest.connectors,
      },
    });
    expect(entry(snapshot, "ui_identity")).toMatchObject({
      editable: false,
      value: generalManifest.ui_identity,
    });
    expect(entry(snapshot, "memory_link")).toMatchObject({
      editable: false,
      value: `agent://${GENERAL}/`,
    });

    // User-owned: editable and resettable; instructions default to null.
    expect(entry(snapshot, "user_instructions")).toMatchObject({
      editable: true,
      resettable: true,
      reset_command: "agent_settings.reset_setting",
      value: null,
      recommended_default: null,
    });
    expect(entry(snapshot, "tool_defaults")).toMatchObject({
      editable: true,
      value: [],
      recommended_default: [],
    });

    // The provider recommendation comes from the pack seed, not a hardcode.
    expect(entry(snapshot, "default_provider")).toMatchObject({
      editable: true,
      value: generalManifest.default_provider,
      recommended_default: generalManifest.default_provider,
      risk_note: expect.stringMatching(/\S/),
    });
  });

  it("reflects stored overrides and keeps current and recommended apart", () => {
    repo.updateSettings("ws-primary", GENERAL, {
      tool_defaults: [{ tool_id: "tool_file_read", config: { max_bytes: 1024 } }],
    });

    const snapshot = service.getSettings("ws-primary", GENERAL);
    expect(entry(snapshot, "tool_defaults").value).toEqual([
      { tool_id: "tool_file_read", config: { max_bytes: 1024 } },
    ]);

    // After the user changes the provider, the pack recommendation is still
    // the recommended default (current != recommended — D16's reset anchor).
    repo.updateDefaultProvider("ws-primary", GENERAL, "provider_local", "qwen3-8b");
    const after = service.getSettings("ws-primary", GENERAL);
    expect(entry(after, "default_provider").value).toEqual({
      provider_id: "provider_local",
      model: "qwen3-8b",
    });
    expect(entry(after, "default_provider").recommended_default).toEqual(
      generalManifest.default_provider,
    );
  });

  it("scopes the snapshot to its workspace (E12)", () => {
    repo.upsertFromPack("ws-other", studentManifest.agents);
    repo.updateUserInstructions("ws-other", GENERAL, "other-workspace rules");

    const primary = service.getSettings("ws-primary", GENERAL);
    const other = service.getSettings("ws-other", GENERAL);
    expect(entry(primary, "user_instructions").value).toBeNull();
    expect(entry(other, "user_instructions").value).toBe("other-workspace rules");
  });

  it("answers unknown agents with the typed 404-class rejection", () => {
    expect(() => service.getSettings("ws-primary", "agent_nobody")).toThrow(AgentNotFoundError);
  });
});

describe("AgentsService.applySettingsCommand (D16 write path)", () => {
  it("applies update commands and returns the read-after-write snapshot", () => {
    const applied = service.applySettingsCommand(
      command({ type: "agent_settings.update_instructions", user_instructions: "Cite every source." }),
    );
    expect(entry(applied, "user_instructions").value).toBe("Cite every source.");
    expect(repo.getAgent("ws-primary", GENERAL)?.user_instructions).toBe("Cite every source.");

    const provider = service.applySettingsCommand(
      command({
        type: "agent_settings.update_default_provider",
        default_provider: { provider_id: "provider_local", model: "qwen3-8b" },
      }),
    );
    expect(entry(provider, "default_provider").value).toEqual({
      provider_id: "provider_local",
      model: "qwen3-8b",
    });

    const tools = service.applySettingsCommand(
      command({
        type: "agent_settings.update_tool_defaults",
        tool_defaults: [{ tool_id: "tool_web_search", config: { depth: "deep" } }],
      }),
    );
    expect(entry(tools, "tool_defaults").value).toEqual([
      { tool_id: "tool_web_search", config: { depth: "deep" } },
    ]);
  });

  it("resets one setting to the pack's recommended default and clears user instructions", () => {
    service.applySettingsCommand(
      command({ type: "agent_settings.update_instructions", user_instructions: "Temp rule." }),
    );
    service.applySettingsCommand(
      command({
        type: "agent_settings.update_default_provider",
        default_provider: { provider_id: "provider_local", model: "qwen3-8b" },
      }),
    );
    service.applySettingsCommand(
      command({
        type: "agent_settings.update_tool_defaults",
        tool_defaults: [{ tool_id: "tool_web_search", config: { depth: "deep" } }],
      }),
    );

    const cleared = service.applySettingsCommand(
      command({ type: "agent_settings.reset_setting", setting_key: "user_instructions" }),
    );
    expect(entry(cleared, "user_instructions").value).toBeNull();

    const providerReset = service.applySettingsCommand(
      command({ type: "agent_settings.reset_setting", setting_key: "default_provider" }),
    );
    expect(entry(providerReset, "default_provider").value).toEqual(
      generalManifest.default_provider,
    );

    const toolsReset = service.applySettingsCommand(
      command({ type: "agent_settings.reset_setting", setting_key: "tool_defaults" }),
    );
    expect(entry(toolsReset, "tool_defaults").value).toEqual([]);
  });

  it("resets all user-owned settings at once, per agent and per workspace", () => {
    repo.upsertFromPack("ws-other", studentManifest.agents);
    // A different agent in the same workspace must not be touched by reset_all.
    service.applySettingsCommand(
      command(
        { type: "agent_settings.update_instructions", user_instructions: "General-only rule." },
        RESEARCHER,
      ),
    );

    const applied = service.applySettingsCommand(command({ type: "agent_settings.reset_all" }));
    expect(entry(applied, "user_instructions").value).toBeNull();
    expect(entry(applied, "default_provider").value).toEqual(generalManifest.default_provider);
    expect(entry(applied, "tool_defaults").value).toEqual([]);
    // The researcher's instructions survive — reset_all targets ONE agent.
    expect(
      entry(service.getSettings("ws-primary", RESEARCHER), "user_instructions").value,
    ).toBe("General-only rule.");
  });

  it("keeps commands workspace-scoped (E12)", () => {
    repo.upsertFromPack("ws-other", studentManifest.agents);
    service.applySettingsCommand(
      command({ type: "agent_settings.update_instructions", user_instructions: "primary rule" }),
    );
    const other = service.getSettings("ws-other", GENERAL);
    expect(entry(other, "user_instructions").value).toBeNull();
  });

  it("answers unknown agents with the typed 404-class rejection", () => {
    expect(() =>
      service.applySettingsCommand(
        command({ type: "agent_settings.update_instructions", user_instructions: "x" }, "agent_nobody"),
      ),
    ).toThrow(AgentNotFoundError);
  });
});

describe("reset without a pack recommendation (documented module default boundary)", () => {
  it("rejects a provider reset when no pack seed carries the recommended default", () => {
    const seedless = new AgentsService({
      agents: repo,
      conversations: new ConversationsRepository(tx),
      journal: new EventsService(new EventJournalRepository(tx), tx),
      tx,
    });
    expect(() =>
      seedless.applySettingsCommand(
        command({ type: "agent_settings.reset_setting", setting_key: "default_provider" }),
      ),
    ).toThrow(AgentSettingsResetUnavailableError);
    // The rejection is typed and carries the stable code for the transport.
    try {
      seedless.applySettingsCommand(
        command({ type: "agent_settings.reset_setting", setting_key: "default_provider" }),
      );
    } catch (error) {
      expect((error as AgentSettingsResetUnavailableError).code).toBe(
        "AGENT_SETTINGS_RESET_UNAVAILABLE",
      );
    }
  });

  it("still composes the read model without seeds, with the recommendation null", () => {
    const seedless = new AgentsService({
      agents: repo,
      conversations: new ConversationsRepository(tx),
      journal: new EventsService(new EventJournalRepository(tx), tx),
      tx,
    });
    const snapshot = seedless.getSettings("ws-primary", GENERAL);
    expect(entry(snapshot, "default_provider").recommended_default).toBeNull();
    expect(entry(snapshot, "default_provider").value).toEqual(generalManifest.default_provider);
  });
});

describe("read-model integrity against corrupted pack-owned data", () => {
  it("answers non-conforming stored capabilities with the typed validation failure", () => {
    repo.upsertFromPack("ws-primary", studentManifest.agents);
    conn.db
      .prepare(`UPDATE agents SET capabilities_json = '{"skills": 42}' WHERE workspace_id = ? AND agent_id = ?`)
      .run("ws-primary", GENERAL);
    expect(() => service.getSettings("ws-primary", GENERAL)).toThrow(
      AgentSettingsValidationError,
    );
  });
});
