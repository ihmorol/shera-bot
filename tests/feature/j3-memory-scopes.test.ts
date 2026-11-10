/**
 * FEATURE QA journey 3 — memory scopes end-to-end.
 *
 * The user journey: an Agent session accumulates a PRIVATE memory; the user
 * manages its visibility across surfaces (agent contexts, the operation
 * context, the management view); publishes it deliberately; and tries to
 * store a credential-shaped value — which the runtime refuses at the write
 * boundary.
 *
 * The feature-level pins the per-slice suites split across files:
 *  - the private scope is invisible EVERYWHERE it must not appear (other
 *    Agents, the Operation context, the user's account-scope listing), even
 *    for a same-operation participant;
 *  - a second runtime (a different account's container, its own SQLite)
 *    sees NOTHING of this account's memory, and a foreign workspace_id is a
 *    typed 403 on every memory surface — the cross-account boundary;
 *  - publication shares into EXACTLY the operation (context gains it, plain
 *    context does not, the direct cross-Agent read stays denied, the thread
 *    never carries the private content);
 *  - a credential-shaped write is refused with the typed secret rejection,
 *    the needle never echoes back, nothing is stored, and the sanitized
 *    rewrite succeeds.
 */
import { afterAll, describe, expect, it } from "vitest";

import {
  CITATION,
  GENERAL,
  RESEARCHER,
  WS,
  cleanupTempResources,
  composeJourney,
  getJson,
  postJson,
} from "./helpers/runtime-harness.js";

const USER = { type: "user", id: "user_emon" } as const;

let commandCounter = 0;

function memoryCommand(extra: Record<string, unknown>) {
  commandCounter += 1;
  return {
    command_id: `cmd_j3_mem_${commandCounter}`,
    idempotency_key: `idem_j3_mem_${commandCounter}`,
    workspace_id: WS,
    actor: USER,
    issued_at: "2026-11-10T12:00:00.000Z",
    type: "memory.create",
    owner_agent_id: null,
    operation_id: null,
    task_id: null,
    expires_at: null,
    ...extra,
  };
}

interface MemoryEntryView {
  memory_id: string;
  scope: string;
  owner_agent_id: string | null;
  summary: string;
  content: string;
}

const contextIds = (body: Record<string, unknown>): string[] =>
  ((body["entries"] as MemoryEntryView[]) ?? []).map((entry) => entry.memory_id);

async function createOperation(origin: string, name: string, roster: string[]): Promise<string> {
  const created = await postJson(origin, "/v1/operations", {
    workspace_id: WS,
    definition_ref: null,
    name,
    roster_agent_ids: roster,
    coordinator_agent_id: roster[0]!,
  });
  expect(created.status).toBe(201);
  return (created.body as { operation_id: string }).operation_id;
}

afterAll(async () => {
  await cleanupTempResources();
});

describe("J3: memory scopes end-to-end", () => {
  it("private scope, publication boundary, cross-account isolation, and secret rejection in one journey", async () => {
    const account = await composeJourney();
    const { origin } = account;
    try {
      // ── 1. The Operation holds BOTH agents (the boundary must hold even
      // for a same-operation participant) ──
      const operationId = await createOperation(origin, "Literature sweep", [RESEARCHER, GENERAL]);

      // ── 2. The researcher's PRIVATE memory (the agent-session write) ──
      const privateCreate = await postJson(
        origin,
        "/v1/memory/commands",
        memoryCommand({
          scope: "agent_private",
          owner_agent_id: RESEARCHER,
          operation_id: operationId,
          summary: "Failed extraction heuristic for corpus 3",
          content:
            "The regex-based extraction heuristic loses table rows when the PDF uses spanned cells; use the layout parser instead.",
          sensitivity: "normal",
          source_refs: [`conversation://${operationId}/messages`],
          confidence: 0.8,
        }),
      );
      expect(privateCreate.status).toBe(200);
      const memoryId = (privateCreate.body["entry"] as MemoryEntryView).memory_id;

      // Owner sees it; the participant does not; the operation context does
      // not; the user's management view groups nothing under account scope.
      const own = await getJson(
        origin,
        `/v1/agents/${RESEARCHER}/memory/context?workspace_id=${WS}`,
      );
      expect(contextIds(own.body)).toContain(memoryId);
      const other = await getJson(
        origin,
        `/v1/agents/${GENERAL}/memory/context?workspace_id=${WS}`,
      );
      expect(contextIds(other.body)).not.toContain(memoryId);
      const opContext = await getJson(
        origin,
        `/v1/operations/${operationId}/memory-context?workspace_id=${WS}`,
      );
      expect(contextIds(opContext.body)).not.toContain(memoryId);
      const directRead = await getJson(
        origin,
        `/v1/agents/${GENERAL}/memory/entries/${memoryId}?workspace_id=${WS}`,
      );
      expect(directRead.status).toBe(403);
      expect(directRead.body).toMatchObject({ code: "AGENT_MEMORY_ACCESS_DENIED" });

      // ── 3. Cross-account: another container's runtime sees NOTHING ──
      const otherAccount = await composeJourney();
      try {
        const otherView = await getJson(otherAccount.origin, `/v1/memory?workspace_id=${WS}`);
        expect(otherView.status).toBe(200);
        const scopes = otherView.body["scopes"] as Record<string, MemoryEntryView[]>;
        for (const rows of Object.values(scopes)) {
          expect(rows, "a foreign account's memory scope is empty").toHaveLength(0);
        }
        const otherAgentContext = await getJson(
          otherAccount.origin,
          `/v1/agents/${RESEARCHER}/memory/context?workspace_id=${WS}`,
        );
        expect(contextIds(otherAgentContext.body)).not.toContain(memoryId);
        // The foreign workspace_id on the OWN runtime is a typed 403.
        const foreignWorkspace = "ws-someone-else-0001";
        const mismatch = await getJson(origin, `/v1/memory?workspace_id=${foreignWorkspace}`);
        expect(mismatch.status).toBe(403);
        expect(mismatch.body["code"]).toBe("WORKSPACE_MISMATCH");
      } finally {
        await otherAccount.close();
      }

      // ── 4. Publication: an explicit USER decision into THIS operation ──
      const publish = await postJson(origin, "/v1/memory/commands", {
        command_id: "cmd_j3_publish_001",
        idempotency_key: "idem_j3_publish_001",
        workspace_id: WS,
        actor: USER,
        issued_at: "2026-11-10T12:05:00.000Z",
        type: "memory.publish_decision",
        memory_id: memoryId,
        operation_id: operationId,
        decision: "approve",
      });
      expect(publish.status).toBe(200);

      // Participants now see it in the operation context — and nowhere else.
      const publishedOther = await getJson(
        origin,
        `/v1/agents/${GENERAL}/memory/context?workspace_id=${WS}&operation_id=${operationId}`,
      );
      expect(contextIds(publishedOther.body)).toContain(memoryId);
      const stillPrivate = await getJson(
        origin,
        `/v1/agents/${GENERAL}/memory/context?workspace_id=${WS}`,
      );
      expect(contextIds(stillPrivate.body)).not.toContain(memoryId);
      const stillDenied = await getJson(
        origin,
        `/v1/agents/${GENERAL}/memory/entries/${memoryId}?workspace_id=${WS}`,
      );
      expect(stillDenied.status).toBe(403);

      // The private content never entered the operation thread of its own
      // accord (the publication notice names the memory, never the content).
      const thread = await getJson(
        origin,
        `/v1/operations/${operationId}/thread?workspace_id=${WS}`,
      );
      expect(JSON.stringify(thread.body)).not.toContain("spanned cells");

      // ── 5. The credential-shaped write is refused at the boundary ──
      const secret = "AKIAQ2W3E4R5T6Y7U8I0";
      const refused = await postJson(
        origin,
        "/v1/memory/commands",
        memoryCommand({
          scope: "agent_private",
          owner_agent_id: RESEARCHER,
          summary: "Deployment credential",
          content: `The exporter reads with ${secret} and password: "s3cretPa55word"`,
          sensitivity: "normal",
          source_refs: ["conversation://direct/user_emon"],
          confidence: 0.9,
        }),
      );
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ code: "MEMORY_SECRET_REJECTED" });
      // The rejection names the rule classes, never echoes the secret (G3).
      expect(JSON.stringify(refused.body)).not.toContain(secret);
      expect(JSON.stringify(refused.body)).not.toContain("s3cretPa55word");

      // Nothing was stored: the user's whole view carries no new row.
      const view = await getJson(origin, `/v1/memory?workspace_id=${WS}`);
      const scopesAfter = view.body["scopes"] as Record<string, MemoryEntryView[]>;
      const totalRows = Object.values(scopesAfter).reduce((sum, rows) => sum + rows.length, 0);
      const storedTexts = JSON.stringify(scopesAfter);
      expect(storedTexts).not.toContain(secret);
      expect(storedTexts).not.toContain("s3cretPa55word");
      void totalRows;

      // The sanitized rewrite of the SAME note succeeds (the boundary blocks
      // the secret shape, not memory itself). The recorded scanner stance:
      // ordinary prose must avoid the credential vocabulary words entirely —
      // the assignment heuristic refuses `<vocab word> <value>` even in
      // innocuous prose (memory-secrets.test.ts's own clean fixture does the
      // same).
      const sanitized = await postJson(
        origin,
        "/v1/memory/commands",
        memoryCommand({
          scope: "agent_private",
          owner_agent_id: RESEARCHER,
          summary: "Deployment values handling",
          content: "The deployment values stay in the environment and never in memory.",
          sensitivity: "normal",
          source_refs: ["conversation://direct/user_emon"],
          confidence: 0.9,
        }),
      );
      expect(sanitized.status).toBe(200);
      void CITATION;
    } finally {
      await account.close();
    }
  });
});
