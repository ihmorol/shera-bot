/**
 * S11 chunk 2 — startup composition, direct-chat binding, and the agent API.
 *
 * Vocabulary: Pack → Operations → Agents; "Agent" only, never "Expert". One
 * identity everywhere (D39): a direct chat references the SAME agent_id as
 * the Agent record — never a duplicate identity per Operation.
 *
 * The tests run the REAL composed stack (real SQLite, real migrations, real
 * HTTP): the runtime boots, loads the pinned student pack, and seeds the
 * workspace's Agents idempotently. Re-seeding on every startup must never
 * clobber the user-owned fields (user_instructions, default provider).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { openDatabase } from "../../adapters/sqlite/connection.ts";
import { AgentsRepository } from "../../adapters/sqlite/agents-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { DEFAULT_WORKSPACE_ID, composeRuntime, type RuntimeHandle } from "./compose.ts";
import { SUBMIT_CONVERSATION_COMMAND_PATH } from "./app.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";

const here = dirname(fileURLToPath(import.meta.url));
// The in-repo pack tree: agent-packs/ at the repository root (five levels up).
const PACKS_ROOT = resolve(here, "../../../../../agent-packs");
const STUDENT_MANIFEST = JSON.parse(
  readFileSync(resolve(PACKS_ROOT, "student/v1/manifest.json"), "utf8"),
) as {
  agents: Array<{
    agent_id: string;
    display_name: string;
    role_description: string;
    default_provider: { provider_id: string; model: string };
    ui_identity: { avatar_hue: number; initial_glyph: string };
  }>;
};

const GENERAL = "agent_general_assistant";
const generalManifest = STUDENT_MANIFEST.agents.find((agent) => agent.agent_id === GENERAL)!;

interface RunningRuntime {
  runtime: RuntimeHandle;
  origin: string;
  close(): Promise<void>;
}

async function composeOn(
  dbPath: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<RunningRuntime> {
  const runtime = composeRuntime({ dbPath, packsRoot: PACKS_ROOT, workspaceId });
  trackConnection(runtime);
  await new Promise<void>((resolveListen) =>
    runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
  );
  const address = runtime.httpServer.address() as { port: number };
  return {
    runtime,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => runtime.close(),
  };
}

async function getJson(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function patchJson(origin: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function postJson(origin: string, path: string, body: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

interface SettingsEntry {
  key: string;
  display_label: string;
  description: string;
  risk_note: string;
  editable: boolean;
  resettable: boolean;
  reset_command: string | null;
  value: unknown;
  recommended_default: unknown;
}

function entryOf(snapshot: Record<string, unknown>, key: string): SettingsEntry {
  const entries = snapshot["entries"] as SettingsEntry[];
  const found = entries.find((candidate) => candidate.key === key);
  expect(found, `entry ${key} must exist`).toBeDefined();
  return found!;
}

/** A valid D16 command body against the composed default workspace. */
function commandBody(extra: Record<string, unknown>, agentId: string = GENERAL) {
  return {
    command_id: "cmd_route_001",
    idempotency_key: "idem_route_0001",
    workspace_id: DEFAULT_WORKSPACE_ID,
    agent_id: agentId,
    actor: { type: "user", id: "user_emon" },
    issued_at: "2026-10-07T10:00:00.000Z",
    ...extra,
  };
}

afterAll(async () => {
  await cleanupTempResources();
});

describe("S11 startup composition (Agents seed from the pinned pack)", () => {
  it("seeds the six student-pack Agents at startup without any manual seed call", async () => {
    const dir = makeTempDir("shera-runtime-s11-compose-");
    const dbPath = join(dir, "runtime.db");
    const running = await composeOn(dbPath);
    await running.close(); // the rows must already exist — no test seeding anywhere

    const conn = openDatabase(dbPath);
    try {
      const agents = new AgentsRepository(new SqliteTransactions(conn.db)).listAgents(
        DEFAULT_WORKSPACE_ID,
      );
      expect(agents.map((agent) => agent.agent_id).sort()).toEqual(
        STUDENT_MANIFEST.agents.map((agent) => agent.agent_id).sort(),
      );
      const general = agents.find((agent) => agent.agent_id === GENERAL);
      expect(general).toMatchObject({
        agent_id: GENERAL,
        workspace_id: DEFAULT_WORKSPACE_ID,
        display_name: generalManifest.display_name,
        user_instructions: null,
        default_provider_id: generalManifest.default_provider.provider_id,
        default_provider_model: generalManifest.default_provider.model,
        is_seeded_from_pack: 1,
      });
    } finally {
      conn.close();
    }
  });
});

describe("S11 agent API (typed local API routes)", () => {
  it("lists and details the workspace's Agents with the direct chat binding", async () => {
    const dir = makeTempDir("shera-runtime-s11-api-");
    const running = await composeOn(join(dir, "runtime.db"));
    try {
      const list = await getJson(running.origin, `/v1/agents?workspace_id=${DEFAULT_WORKSPACE_ID}`);
      expect(list.status).toBe(200);
      const agents = list.body["agents"] as Array<Record<string, unknown>>;
      expect(agents.map((agent) => agent["agent_id"]).sort()).toEqual(
        STUDENT_MANIFEST.agents.map((agent) => agent.agent_id).sort(),
      );
      // Summary payloads are exactly the allowlisted fields — no capabilities,
      // no memory, no provider internals, nothing beyond one Agent's identity
      // plus the S12 session-presence read (supervisor disabled here → "none").
      for (const agent of agents) {
        expect(Object.keys(agent).sort()).toEqual([
          "agent_id",
          "avatar_hue",
          "display_name",
          "has_user_instructions",
          "initial_glyph",
          "role_description",
          "session",
        ]);
        expect(agent["has_user_instructions"]).toBe(false);
        expect(agent["session"]).toEqual({ presence: "none" });
      }

      const detail = await getJson(
        running.origin,
        `/v1/agents/${GENERAL}?workspace_id=${DEFAULT_WORKSPACE_ID}`,
      );
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({
        agent_id: GENERAL,
        display_name: generalManifest.display_name,
        role_description: expect.any(String),
        has_user_instructions: false,
        user_instructions: null,
        default_provider: {
          provider_id: generalManifest.default_provider.provider_id,
          model: generalManifest.default_provider.model,
        },
      });
      // The UI opens the chat from this id — get-or-create semantics.
      expect(typeof detail.body["direct_chat_id"]).toBe("string");
    } finally {
      await running.close();
    }
  });

  it("patches user instructions and the default provider, with typed failures", async () => {
    const dir = makeTempDir("shera-runtime-s11-patch-");
    const running = await composeOn(join(dir, "runtime.db"));
    try {
      const instructions = await patchJson(running.origin, `/v1/agents/${GENERAL}/instructions`, {
        workspace_id: DEFAULT_WORKSPACE_ID,
        user_instructions: "Always answer in Bangla.",
      });
      expect(instructions.status).toBe(200);
      expect(instructions.body).toMatchObject({
        agent_id: GENERAL,
        has_user_instructions: true,
      });

      const provider = await patchJson(running.origin, `/v1/agents/${GENERAL}/provider`, {
        workspace_id: DEFAULT_WORKSPACE_ID,
        default_provider: { provider_id: "provider_local", model: "qwen3-8b" },
      });
      expect(provider.status).toBe(200);

      const detail = await getJson(
        running.origin,
        `/v1/agents/${GENERAL}?workspace_id=${DEFAULT_WORKSPACE_ID}`,
      );
      expect(detail.body).toMatchObject({
        agent_id: GENERAL,
        has_user_instructions: true,
        user_instructions: "Always answer in Bangla.",
        default_provider: { provider_id: "provider_local", model: "qwen3-8b" },
      });

      // The list reflects the user-owned edit.
      const list = await getJson(running.origin, `/v1/agents?workspace_id=${DEFAULT_WORKSPACE_ID}`);
      const agents = list.body["agents"] as Array<Record<string, unknown>>;
      const general = agents.find((agent) => agent["agent_id"] === GENERAL);
      expect(general).toMatchObject({
        display_name: generalManifest.display_name,
        avatar_hue: expect.any(Number),
        initial_glyph: expect.any(String),
        has_user_instructions: true,
      });

      // Unknown Agent → the typed 404-style rejection, never a raw fault.
      const missing = await getJson(
        running.origin,
        `/v1/agents/agent_nobody?workspace_id=${DEFAULT_WORKSPACE_ID}`,
      );
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({ code: "AGENT_NOT_FOUND", category: "state" });
      const missingPatch = await patchJson(running.origin, "/v1/agents/agent_nobody/instructions", {
        workspace_id: DEFAULT_WORKSPACE_ID,
        user_instructions: "x",
      });
      expect(missingPatch.status).toBe(404);
      expect(missingPatch.body).toMatchObject({ code: "AGENT_NOT_FOUND" });

      // Workspace scoping: another workspace sees no Agents and cannot reach
      // this workspace's rows through any route.
      const foreignList = await getJson(running.origin, "/v1/agents?workspace_id=ws-s11-foreign");
      expect(foreignList.status).toBe(200);
      expect(foreignList.body["agents"]).toEqual([]);
      const foreignDetail = await getJson(
        running.origin,
        `/v1/agents/${GENERAL}?workspace_id=ws-s11-foreign`,
      );
      expect(foreignDetail.status).toBe(404);
      const foreignPatch = await patchJson(running.origin, `/v1/agents/${GENERAL}/instructions`, {
        workspace_id: "ws-s11-foreign",
        user_instructions: "x",
      });
      expect(foreignPatch.status).toBe(404);

      // Malformed body → the contract's typed 400.
      const bad = await patchJson(running.origin, `/v1/agents/${GENERAL}/instructions`, {
        workspace_id: DEFAULT_WORKSPACE_ID,
        user_instructions: 42,
      });
      expect(bad.status).toBe(400);
      expect(bad.body).toMatchObject({ code: "CONTRACT_VALIDATION_FAILED" });
    } finally {
      await running.close();
    }
  });

  it("re-seeds on every startup without clobbering user-owned fields", async () => {
    const dir = makeTempDir("shera-runtime-s11-reseed-");
    const dbPath = join(dir, "runtime.db");
    const first = await composeOn(dbPath);
    try {
      const patched = await patchJson(first.origin, `/v1/agents/${GENERAL}/instructions`, {
        workspace_id: DEFAULT_WORKSPACE_ID,
        user_instructions: "Cite every source.",
      });
      expect(patched.status).toBe(200);
    } finally {
      await first.close();
    }

    // The SECOND boot re-runs the composition (and with it the seed) against
    // the same database — the user's edit must survive.
    const second = await composeOn(dbPath);
    try {
      const list = await getJson(second.origin, `/v1/agents?workspace_id=${DEFAULT_WORKSPACE_ID}`);
      const agents = list.body["agents"] as Array<Record<string, unknown>>;
      expect(agents).toHaveLength(6); // re-seed is idempotent — no duplicates
      const detail = await getJson(
        second.origin,
        `/v1/agents/${GENERAL}?workspace_id=${DEFAULT_WORKSPACE_ID}`,
      );
      expect(detail.body).toMatchObject({
        has_user_instructions: true,
        user_instructions: "Cite every source.",
      });
    } finally {
      await second.close();
    }
  });
});

describe("S11 agent settings API (D16 read model + command surface)", () => {
  it("serves the settings snapshot with the pack's recommended defaults", async () => {
    const dir = makeTempDir("shera-runtime-s11-settings-read-");
    const running = await composeOn(join(dir, "runtime.db"));
    try {
      const response = await getJson(
        running.origin,
        `/v1/agents/${GENERAL}/settings?workspace_id=${DEFAULT_WORKSPACE_ID}`,
      );
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        workspace_id: DEFAULT_WORKSPACE_ID,
        agent_id: GENERAL,
      });

      const entries = response.body["entries"] as SettingsEntry[];
      expect(entries.map((entry) => entry.key)).toEqual([
        "role",
        "user_instructions",
        "memory_link",
        "default_provider",
        "tool_defaults",
        "capabilities",
        "ui_identity",
      ]);

      // Pack-owned entries are read-only and never resettable (D16: they are
      // never command targets).
      for (const key of ["role", "memory_link", "capabilities", "ui_identity"]) {
        expect(entryOf(response.body, key)).toMatchObject({
          editable: false,
          resettable: false,
          reset_command: null,
        });
      }
      expect(entryOf(response.body, "role").value).toBe(generalManifest.role_description);
      expect(entryOf(response.body, "memory_link").value).toBe(`agent://${GENERAL}/`);

      // Editable entries carry the D16 metadata and the reset command.
      expect(entryOf(response.body, "user_instructions")).toMatchObject({
        editable: true,
        resettable: true,
        reset_command: "agent_settings.reset_setting",
        value: null,
      });
      expect(entryOf(response.body, "tool_defaults")).toMatchObject({
        editable: true,
        value: [],
        recommended_default: [],
      });

      // The recommended provider default comes from the pinned pack via the
      // composition — not a hardcoded value (D16).
      expect(entryOf(response.body, "default_provider")).toMatchObject({
        editable: true,
        value: generalManifest.default_provider,
        recommended_default: generalManifest.default_provider,
      });
      expect(entryOf(response.body, "default_provider").risk_note).toMatch(/\S/);
    } finally {
      await running.close();
    }
  });

  it("applies settings commands and resets to the pack defaults through the API", async () => {
    const dir = makeTempDir("shera-runtime-s11-settings-commands-");
    const running = await composeOn(join(dir, "runtime.db"));
    try {
      const commandPath = `/v1/agents/${GENERAL}/settings/commands`;

      const instructions = await postJson(running.origin, commandPath, {
        ...commandBody({ type: "agent_settings.update_instructions" }),
        user_instructions: "Always answer in Bangla.",
      });
      expect(instructions.status).toBe(200);
      expect(entryOf(instructions.body, "user_instructions").value).toBe(
        "Always answer in Bangla.",
      );

      const provider = await postJson(running.origin, commandPath, {
        ...commandBody({ type: "agent_settings.update_default_provider" }),
        default_provider: { provider_id: "provider_local", model: "qwen3-8b" },
      });
      expect(provider.status).toBe(200);
      // Current moves; the pack recommendation stays the reset anchor (D16).
      expect(entryOf(provider.body, "default_provider").value).toEqual({
        provider_id: "provider_local",
        model: "qwen3-8b",
      });
      expect(entryOf(provider.body, "default_provider").recommended_default).toEqual(
        generalManifest.default_provider,
      );

      const tools = await postJson(running.origin, commandPath, {
        ...commandBody({ type: "agent_settings.update_tool_defaults" }),
        tool_defaults: [{ tool_id: "tool_web_search", config: { depth: "deep" } }],
      });
      expect(tools.status).toBe(200);
      expect(entryOf(tools.body, "tool_defaults").value).toEqual([
        { tool_id: "tool_web_search", config: { depth: "deep" } },
      ]);

      // The read model persists across reads (round-trip through storage).
      const reread = await getJson(
        running.origin,
        `/v1/agents/${GENERAL}/settings?workspace_id=${DEFAULT_WORKSPACE_ID}`,
      );
      expect(entryOf(reread.body, "user_instructions").value).toBe("Always answer in Bangla.");

      // Reset one setting to the pack default...
      const cleared = await postJson(running.origin, commandPath, {
        ...commandBody({ type: "agent_settings.reset_setting" }),
        setting_key: "user_instructions",
      });
      expect(cleared.status).toBe(200);
      expect(entryOf(cleared.body, "user_instructions").value).toBeNull();

      // ...and everything at once: the provider returns to the pack's pick.
      const resetAll = await postJson(running.origin, commandPath, {
        ...commandBody({ type: "agent_settings.reset_all" }),
      });
      expect(resetAll.status).toBe(200);
      expect(entryOf(resetAll.body, "default_provider").value).toEqual(
        generalManifest.default_provider,
      );
      expect(entryOf(resetAll.body, "tool_defaults").value).toEqual([]);
      expect(entryOf(resetAll.body, "user_instructions").value).toBeNull();
    } finally {
      await running.close();
    }
  });

  it("answers typed failures: unknown agent, malformed body, path mismatch, non-resettable key", async () => {
    const dir = makeTempDir("shera-runtime-s11-settings-failures-");
    const running = await composeOn(join(dir, "runtime.db"));
    try {
      const missingRead = await getJson(
        running.origin,
        `/v1/agents/agent_nobody/settings?workspace_id=${DEFAULT_WORKSPACE_ID}`,
      );
      expect(missingRead.status).toBe(404);
      expect(missingRead.body).toMatchObject({ code: "AGENT_NOT_FOUND", category: "state" });

      const missingCommand = await postJson(
        running.origin,
        "/v1/agents/agent_nobody/settings/commands",
        commandBody(
          {
            type: "agent_settings.update_instructions",
            user_instructions: "x",
          },
          "agent_nobody",
        ),
      );
      expect(missingCommand.status).toBe(404);
      expect(missingCommand.body).toMatchObject({ code: "AGENT_NOT_FOUND" });

      // Not a settings command at all → the contract's typed 400.
      const malformed = await postJson(
        running.origin,
        `/v1/agents/${GENERAL}/settings/commands`,
        commandBody({ type: "agent_settings.set_temperature", temperature: 0.2 }),
      );
      expect(malformed.status).toBe(400);
      expect(malformed.body).toMatchObject({ code: "CONTRACT_VALIDATION_FAILED" });

      // Incomplete envelope (no idempotency key) → typed 400.
      const noKey = commandBody({
        type: "agent_settings.update_instructions",
        user_instructions: "x",
      });
      delete (noKey as Record<string, unknown>)["idempotency_key"];
      const missingKey = await postJson(
        running.origin,
        `/v1/agents/${GENERAL}/settings/commands`,
        noKey,
      );
      expect(missingKey.status).toBe(400);

      // The body's agent_id must agree with the path — never a silent
      // retarget of one Agent's command onto another.
      const mismatch = await postJson(
        running.origin,
        `/v1/agents/${GENERAL}/settings/commands`,
        commandBody(
          { type: "agent_settings.update_instructions", user_instructions: "x" },
          "agent_researcher",
        ),
      );
      expect(mismatch.status).toBe(400);
      expect(mismatch.body).toMatchObject({ code: "CONTRACT_VALIDATION_FAILED" });

      // Pack-owned fields are read-only entries, never reset targets.
      const resetRole = await postJson(
        running.origin,
        `/v1/agents/${GENERAL}/settings/commands`,
        commandBody({ type: "agent_settings.reset_setting", setting_key: "role" }),
      );
      expect(resetRole.status).toBe(400);
      expect(resetRole.body).toMatchObject({ code: "CONTRACT_VALIDATION_FAILED" });
    } finally {
      await running.close();
    }
  });
});

describe("S11 restart persistence (issue #12 AC: history and identity survive a restart)", () => {
  /**
   * The AC3 persistence leg end-to-end: everything the user produced in the
   * first session — the direct-chat binding, the conversation history, the
   * settings edit, and the seeded Agent identities themselves (hue and role
   * are PACK-owned fields, so a re-seed must restore them unchanged) — must
   * resolve identically after closing the runtime and re-composing on the
   * SAME data directory. No test seeding: the second boot is the composition,
   * exactly like production startup.
   */
  it("preserves agents, chat binding, history, and settings across a full close and re-open", async () => {
    const dir = makeTempDir("shera-runtime-s11-restart-persist-");
    const dbPath = join(dir, "runtime.db");

    // --- First session: seed, open the chat, talk, edit settings. ---
    const first = await composeOn(dbPath);
    let chatId: string;
    let hue: number;
    let glyph: string;
    try {
      const detail = await getJson(
        first.origin,
        `/v1/agents/${GENERAL}?workspace_id=${DEFAULT_WORKSPACE_ID}`,
      );
      expect(detail.status).toBe(200);
      chatId = detail.body["direct_chat_id"] as string;
      hue = detail.body["avatar_hue"] as number;
      glyph = detail.body["initial_glyph"] as string;
      expect(hue).toBe(generalManifest.ui_identity.avatar_hue);
      expect(glyph).toBe(generalManifest.ui_identity.initial_glyph);

      // Real conversation history: two durable user messages through the
      // command path (the only mutation path, D26).
      const turns = ["First turn before the restart.", "Second turn before the restart."];
      for (const [index, text] of turns.entries()) {
        const sent = await postJson(first.origin, SUBMIT_CONVERSATION_COMMAND_PATH, {
          type: "message.send",
          workspace_id: DEFAULT_WORKSPACE_ID,
          idempotency_key: `idem-restart-${index + 1}`,
          payload: {
            conversation_id: chatId,
            text,
            sender: { kind: "user", display_name: "Emon" },
          },
        });
        expect(sent.status).toBe(200);
        expect(sent.body).toMatchObject({ kind: "message_sent", conversation_id: chatId });
      }

      // One settings edit through the D16 command surface.
      const edited = await postJson(
        first.origin,
        `/v1/agents/${GENERAL}/settings/commands`,
        commandBody({
          type: "agent_settings.update_instructions",
          user_instructions: "Survive the restart verbatim.",
        }),
      );
      expect(edited.status).toBe(200);
      expect(entryOf(edited.body, "user_instructions").value).toBe("Survive the restart verbatim.");
    } finally {
      await first.close(); // EVERYTHING closes — server, gateway, SQLite.
    }

    // --- Second session: a FRESH compose on the same data directory. ---
    const second = await composeOn(dbPath);
    try {
      // The six Agents re-seed idempotently, with pack-owned identity intact.
      const list = await getJson(second.origin, `/v1/agents?workspace_id=${DEFAULT_WORKSPACE_ID}`);
      expect(list.status).toBe(200);
      const agents = list.body["agents"] as Array<Record<string, unknown>>;
      expect(agents.map((agent) => agent["agent_id"]).sort()).toEqual(
        STUDENT_MANIFEST.agents.map((agent) => agent.agent_id).sort(),
      );
      const general = agents.find((agent) => agent["agent_id"] === GENERAL)!;
      expect(general).toMatchObject({
        display_name: generalManifest.display_name,
        role_description: generalManifest.role_description,
        avatar_hue: hue,
        initial_glyph: glyph,
      });

      // The user_instructions edit survived the restart.
      const detail = await getJson(
        second.origin,
        `/v1/agents/${GENERAL}?workspace_id=${DEFAULT_WORKSPACE_ID}`,
      );
      expect(detail.body).toMatchObject({
        user_instructions: "Survive the restart verbatim.",
        has_user_instructions: true,
      });

      // The direct-chat binding resolves to the SAME conversation (D39:
      // one identity everywhere — never a new chat per boot).
      expect(detail.body["direct_chat_id"]).toBe(chatId);

      // The history is intact: the journal replays the creation AND both
      // messages, in order, from sequence 0.
      const events = await getJson(
        second.origin,
        `/v1/conversations/${chatId}/events?workspace_id=${DEFAULT_WORKSPACE_ID}&last_acknowledged_sequence=0`,
      );
      expect(events.status).toBe(200);
      const replayed = events.body["events"] as Array<{
        type: string;
        payload: Record<string, unknown>;
      }>;
      expect(replayed.filter((event) => event.type === "conversation.created")).toHaveLength(1);
      const appended = replayed.filter((event) => event.type === "message.appended");
      expect(appended.map((event) => event.payload["text"])).toEqual([
        "First turn before the restart.",
        "Second turn before the restart.",
      ]);
      for (const event of appended) {
        expect(event.payload).toMatchObject({
          conversation_id: chatId,
          workspace_id: DEFAULT_WORKSPACE_ID,
          sender: { kind: "user", display_name: "Emon" },
        });
      }

      // The settings snapshot reads back from storage, not from memory.
      const settings = await getJson(
        second.origin,
        `/v1/agents/${GENERAL}/settings?workspace_id=${DEFAULT_WORKSPACE_ID}`,
      );
      expect(settings.status).toBe(200);
      expect(entryOf(settings.body, "user_instructions").value).toBe(
        "Survive the restart verbatim.",
      );
      // And the pack recommendation for the provider is still anchored (D16).
      expect(entryOf(settings.body, "default_provider").recommended_default).toEqual(
        generalManifest.default_provider,
      );
    } finally {
      await second.close();
    }
  });
});

describe("S11 direct-chat binding (one chat per workspace+agent, journaled)", () => {
  it("get-or-create returns the same conversation per Agent and journals the creation", async () => {
    const dir = makeTempDir("shera-runtime-s11-direct-");
    const dbPath = join(dir, "runtime.db");
    const WS_ONE = "ws-s11-direct-one";
    const WS_TWO = "ws-s11-direct-two";

    const first = await composeOn(dbPath, WS_ONE);
    let firstChatId: string;
    try {
      const chat = first.runtime.agents.getOrCreateDirectChat(WS_ONE, GENERAL);
      expect(chat.created).toBe(true);
      firstChatId = chat.conversation_id;
      // The SAME (workspace, agent) resolves to the SAME conversation, forever.
      const again = first.runtime.agents.getOrCreateDirectChat(WS_ONE, GENERAL);
      expect(again.created).toBe(false);
      expect(again.conversation_id).toBe(firstChatId);
    } finally {
      await first.close();
    }

    const second = await composeOn(dbPath, WS_TWO);
    try {
      // The same agent_id in a different workspace binds an independent chat
      // (E12) — and the first workspace's binding is untouched.
      const chatTwo = second.runtime.agents.getOrCreateDirectChat(WS_TWO, GENERAL);
      expect(chatTwo.conversation_id).not.toBe(firstChatId);
      const oneAgain = second.runtime.agents.getOrCreateDirectChat(WS_ONE, GENERAL);
      expect(oneAgain.conversation_id).toBe(firstChatId);

      // An unknown Agent is a typed failure, not a chat.
      expect(() => second.runtime.agents.getOrCreateDirectChat(WS_TWO, "agent_nobody")).toThrow(
        /not found/,
      );

      // Direct-chat creation is journaled like every other conversation
      // creation — the S07 replay route reads the durable event back.
      const events = await getJson(
        second.origin,
        `/v1/conversations/${chatTwo.conversation_id}/events?workspace_id=${WS_TWO}&last_acknowledged_sequence=0`,
      );
      expect(events.status).toBe(200);
      const list = events.body["events"] as Array<{
        type: string;
        payload: Record<string, unknown>;
      }>;
      const created = list.filter((event) => event.type === "conversation.created");
      expect(created).toHaveLength(1);
      expect(created[0]!.payload).toMatchObject({
        conversation_id: chatTwo.conversation_id,
        workspace_id: WS_TWO,
        title: generalManifest.display_name,
      });
    } finally {
      await second.close();
    }
  });
});
