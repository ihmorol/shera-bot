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
    default_provider: { provider_id: string; model: string };
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
      // no memory, no provider internals, nothing beyond one Agent's identity.
      for (const agent of agents) {
        expect(Object.keys(agent).sort()).toEqual([
          "agent_id",
          "avatar_hue",
          "display_name",
          "has_user_instructions",
          "initial_glyph",
          "role_description",
        ]);
        expect(agent["has_user_instructions"]).toBe(false);
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
      const instructions = await patchJson(
        running.origin,
        `/v1/agents/${GENERAL}/instructions`,
        { workspace_id: DEFAULT_WORKSPACE_ID, user_instructions: "Always answer in Bangla." },
      );
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
      const missingPatch = await patchJson(
        running.origin,
        "/v1/agents/agent_nobody/instructions",
        { workspace_id: DEFAULT_WORKSPACE_ID, user_instructions: "x" },
      );
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
      const foreignPatch = await patchJson(
        running.origin,
        `/v1/agents/${GENERAL}/instructions`,
        { workspace_id: "ws-s11-foreign", user_instructions: "x" },
      );
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
      expect(() =>
        second.runtime.agents.getOrCreateDirectChat(WS_TWO, "agent_nobody"),
      ).toThrow(/not found/);

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
