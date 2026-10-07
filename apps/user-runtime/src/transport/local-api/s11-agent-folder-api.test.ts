/**
 * S11 — the private-folder isolation guard proven end-to-end through the
 * typed local API (GET /v1/agents/:agent_id/folder).
 *
 * The route is the DECISION surface only (no storage is touched): the path
 * identity is the ACTING Agent, the query's `path` is the target
 * `agent://<agent_id>/<path>` URI. An Agent's own subtree answers 200 with
 * the resolved decision; any other Agent's private subtree is the typed 403;
 * traversal-shaped or non-agent:// URIs are the typed 400 (they never resolve
 * into an escape); unknown actor/owner/workspace are the typed 404 (E12:
 * resolution is workspace-scoped). The tests run the REAL composed stack —
 * real SQLite, real pack seeding, real HTTP — per house convention.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_WORKSPACE_ID, composeRuntime, type RuntimeHandle } from "./compose.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PACKS_ROOT = resolve(here, "../../../../../agent-packs");

const GENERAL = "agent_general_assistant";
const RESEARCHER = "agent_researcher";

interface RunningRuntime {
  runtime: RuntimeHandle;
  origin: string;
  close(): Promise<void>;
}

async function composeOn(dbPath: string): Promise<RunningRuntime> {
  const runtime = composeRuntime({ dbPath, packsRoot: PACKS_ROOT });
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

async function folderAccess(
  origin: string,
  actingAgentId: string,
  query: string,
) {
  const response = await fetch(
    `${origin}/v1/agents/${actingAgentId}/folder?workspace_id=${DEFAULT_WORKSPACE_ID}&${query}`,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

afterAll(async () => {
  await cleanupTempResources();
});

describe("S11 agent folder access API (private-folder isolation guard)", () => {
  it("resolves an Agent's OWN subtree — root and nested, both verbs granted", async () => {
    const dir = makeTempDir("shera-runtime-s11-folder-own-");
    const running = await composeOn(join(dir, "runtime.db"));
    try {
      const root = await folderAccess(running.origin, GENERAL, `path=agent://${GENERAL}/`);
      expect(root.status).toBe(200);
      expect(root.body).toEqual({
        workspace_id: DEFAULT_WORKSPACE_ID,
        actor_agent_id: GENERAL,
        agent_id: GENERAL,
        path: "",
        access: { read: true, write: true },
      });

      const nested = await folderAccess(
        running.origin,
        GENERAL,
        `path=agent://${GENERAL}/notes/ideas.txt`,
      );
      expect(nested.status).toBe(200);
      expect(nested.body).toMatchObject({
        agent_id: GENERAL,
        path: "notes/ideas.txt",
        access: { read: true, write: true },
      });
    } finally {
      await running.close();
    }
  });

  it("denies ANY other Agent's private subtree — root and nested, with the typed 403", async () => {
    const dir = makeTempDir("shera-runtime-s11-folder-deny-");
    const running = await composeOn(join(dir, "runtime.db"));
    try {
      for (const path of [
        `agent://${RESEARCHER}/`,
        `agent://${RESEARCHER}/notes/private.txt`,
      ]) {
        const denied = await folderAccess(running.origin, GENERAL, `path=${path}`);
        expect(denied.status).toBe(403);
        expect(denied.body).toMatchObject({
          code: "AGENT_FOLDER_ACCESS_DENIED",
          category: "unauthorized",
          retryable: false,
        });
        // G3: the safe message carries no internal shape, and every response
        // carries a correlation id.
        expect(denied.body["safe_message"]).not.toContain(RESEARCHER);
        expect(typeof denied.body["correlation_id"]).toBe("string");
      }
    } finally {
      await running.close();
    }
  });

  it("rejects traversal-shaped URIs with the typed 400 — no percent-encoding escape", async () => {
    const dir = makeTempDir("shera-runtime-s11-folder-traversal-");
    const running = await composeOn(join(dir, "runtime.db"));
    try {
      // Raw `..` segments...
      const raw = await folderAccess(
        running.origin,
        GENERAL,
        `path=agent://${GENERAL}/../${RESEARCHER}/notes.txt`,
      );
      expect(raw.status).toBe(400);
      expect(raw.body).toMatchObject({
        code: "AGENT_FOLDER_URI_INVALID",
        category: "validation",
      });

      // ...and the double-encoded variant: the query decoder unwraps the
      // first layer, and the guard's parse decodes the second — `%2e%2e`
      // cannot get past a raw-string OR a decode-then-check rejection.
      const smuggled = await folderAccess(
        running.origin,
        GENERAL,
        `path=agent://${GENERAL}/%252e%252e/${RESEARCHER}/notes.txt`,
      );
      expect(smuggled.status).toBe(400);
      expect(smuggled.body).toMatchObject({ code: "AGENT_FOLDER_URI_INVALID" });
    } finally {
      await running.close();
    }
  });

  it("rejects non-agent:// schemes and malformed folder URIs — shared paths are S17's model", async () => {
    const dir = makeTempDir("shera-runtime-s11-folder-scheme-");
    const running = await composeOn(join(dir, "runtime.db"));
    try {
      // A shared workspace path has NO permission model here yet: the honest
      // answer is the typed rejection, not a guessed grant (S17 owns it).
      const shared = await folderAccess(
        running.origin,
        GENERAL,
        "path=workspace://ws-local-default/shared/a.txt",
      );
      expect(shared.status).toBe(400);
      expect(shared.body).toMatchObject({ code: "AGENT_FOLDER_URI_INVALID" });

      // Host outside the AgentFolderUri charset.
      const badHost = await folderAccess(
        running.origin,
        GENERAL,
        "path=agent://Agent_X/notes.txt",
      );
      expect(badHost.status).toBe(400);
      expect(badHost.body).toMatchObject({ code: "AGENT_FOLDER_URI_INVALID" });

      // Missing path query → the route-level contract 400.
      const missing = await fetch(
        `${running.origin}/v1/agents/${GENERAL}/folder?workspace_id=${DEFAULT_WORKSPACE_ID}`,
      );
      expect(missing.status).toBe(400);
      expect(((await missing.json()) as Record<string, unknown>)["code"]).toBe(
        "CONTRACT_VALIDATION_FAILED",
      );
    } finally {
      await running.close();
    }
  });

  it("answers the typed 404 for unknown owner, unknown actor, and foreign workspace (E12)", async () => {
    const dir = makeTempDir("shera-runtime-s11-folder-scope-");
    const running = await composeOn(join(dir, "runtime.db"));
    try {
      // Unknown folder owner.
      const nobody = await folderAccess(
        running.origin,
        GENERAL,
        "path=agent://agent_nobody/notes.txt",
      );
      expect(nobody.status).toBe(404);
      expect(nobody.body).toMatchObject({ code: "AGENT_NOT_FOUND", category: "state" });

      // Unknown ACTOR: an access decision needs a seeded acting Agent.
      const stranger = await folderAccess(
        running.origin,
        "agent_nobody",
        `path=agent://${GENERAL}/notes.txt`,
      );
      expect(stranger.status).toBe(404);
      expect(stranger.body).toMatchObject({ code: "AGENT_NOT_FOUND" });

      // A foreign workspace resolves nothing — the same scoping every other
      // agent route applies.
      const foreign = await fetch(
        `${running.origin}/v1/agents/${GENERAL}/folder?workspace_id=ws-s11-foreign&path=agent://${GENERAL}/`,
      );
      expect(foreign.status).toBe(404);
      expect(((await foreign.json()) as Record<string, unknown>)["code"]).toBe(
        "AGENT_NOT_FOUND",
      );
    } finally {
      await running.close();
    }
  });
});
