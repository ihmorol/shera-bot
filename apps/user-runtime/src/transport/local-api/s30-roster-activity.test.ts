/**
 * S30 chunk 7 — the roster activity-preview lines (E43 idea 4; issue #31):
 * each sidebar Agent row carries WHAT THE AGENT LAST DID + WHEN, derived
 * from the runtime's own records — the LAST durable message event on the
 * Agent's direct-chat journal stream. Never invented: an Agent with no chat
 * history answers null, and the UI renders the honest quiet line (G4 — the
 * AC9 posture: every surface renders the runtime's own records).
 */
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

const WORKSPACE = DEFAULT_WORKSPACE_ID;

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

async function get(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The agents' direct-chat ids, created through the REAL detail reads. */
async function ensureDirectChat(origin: string, agentSlug: string): Promise<string> {
  const detail = await get(origin, `/v1/agents/${agentSlug}?workspace_id=${WORKSPACE}`);
  expect(detail.status).toBe(200);
  return (detail.body as { direct_chat_id: string }).direct_chat_id;
}

interface RosterEntry {
  agent_id: string;
  display_name: string;
  last_activity: { at: string; preview: string } | null;
}

afterAll(async () => {
  await cleanupTempResources();
});

describe("S30 roster activity lines (E43 idea 4)", () => {
  it("the roster answers each Agent's last durable message — and null where history is quiet", async () => {
    const running = await composeOn(join(makeTempDir("shera-s30-roster-"), "runtime.db"));
    const { origin, runtime } = running;

    // The Researcher's direct chat gets real history through the journal;
    // the other Agents stay quiet (fresh workspace, no chats yet).
    const chatId = await ensureDirectChat(origin, "agent_researcher");
    runtime.journal.append({
      stream_id: `conversation:${chatId}`,
      sequence: 2,
      event_id: "evt_roster_1",
      event_type: "message.appended",
      schema_version: 1,
      payload: JSON.stringify({
        conversation_id: chatId,
        workspace_id: WORKSPACE,
        message_id: "msg_roster_1",
        sender: { kind: "agent", agent_id: "agent_researcher" },
        text: "Drafted the methodology sweep — three candidate sources found.",
      }),
      workspace_id: WORKSPACE,
      occurred_at: "2026-11-08T09:15:00.000Z",
      correlation_id: "corr_roster_1",
    });

    const roster = await get(origin, `/v1/agents?workspace_id=${WORKSPACE}`);
    expect(roster.status).toBe(200);
    const agents = roster.body["agents"] as RosterEntry[];
    expect(agents.length).toBeGreaterThanOrEqual(2);

    const researcher = agents.find((entry) => entry.agent_id === "agent_researcher")!;
    expect(researcher.last_activity).toMatchObject({
      at: "2026-11-08T09:15:00.000Z",
      preview: "Drafted the methodology sweep — three candidate sources found.",
    });

    // A quiet Agent answers null — never an invented line (G4).
    const quiet = agents.find((entry) => entry.agent_id !== "agent_researcher")!;
    expect(quiet.last_activity).toBeNull();

    // The preview is bounded (the E43 line, not a transcript).
    expect(researcher.last_activity!.preview.length).toBeLessThanOrEqual(120);
  });

  it("the LAST message wins — the preview tracks the newest durable event", async () => {
    const running = await composeOn(join(makeTempDir("shera-s30-roster2-"), "runtime.db"));
    const { origin, runtime } = running;

    const chatId = await ensureDirectChat(origin, "agent_developer");
    runtime.journal.append({
      stream_id: `conversation:${chatId}`,
      sequence: 2,
      event_id: "evt_roster_a",
      event_type: "message.appended",
      schema_version: 1,
      payload: JSON.stringify({
        conversation_id: chatId,
        workspace_id: WORKSPACE,
        message_id: "msg_a",
        sender: { kind: "agent", agent_id: "agent_developer" },
        text: "First pass on the failing test.",
      }),
      workspace_id: WORKSPACE,
      occurred_at: "2026-11-08T09:00:00.000Z",
      correlation_id: "corr_roster_a",
    });
    runtime.journal.append({
      stream_id: `conversation:${chatId}`,
      sequence: 3,
      event_id: "evt_roster_b",
      event_type: "message.appended",
      schema_version: 1,
      payload: JSON.stringify({
        conversation_id: chatId,
        workspace_id: WORKSPACE,
        message_id: "msg_b",
        sender: { kind: "agent", agent_id: "agent_developer" },
        text: "Fixed the boundary condition — suite green.",
      }),
      workspace_id: WORKSPACE,
      occurred_at: "2026-11-08T09:20:00.000Z",
      correlation_id: "corr_roster_b",
    });

    const roster = await get(origin, `/v1/agents?workspace_id=${WORKSPACE}`);
    const developer = (roster.body["agents"] as RosterEntry[]).find(
      (entry) => entry.agent_id === "agent_developer",
    )!;
    expect(developer.last_activity).toMatchObject({
      at: "2026-11-08T09:20:00.000Z",
      preview: "Fixed the boundary condition — suite green.",
    });
  });
});
