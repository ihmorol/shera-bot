/**
 * S15 chunk 1 — Operation launch preview READ MODEL (backend): the
 * definitions list, the eight-group launch preview, and THE ZERO-SIDE-
 * EFFECT PROOF. The preview is a safety boundary where NOTHING may execute
 * before confirmation (D30), so these tests call the preview routes over
 * the REAL composed stack (real SQLite, real migrations, real HTTP) and
 * assert the database is left byte-identical: no model/provider activity,
 * no operation rows, no task-run rows, no Operation-chat rows, no journal
 * writes — nothing beyond the boot baseline.
 *
 * RED-FIRST commit: this file was written before the implementation
 * exists. It fails because the preview routes do not exist yet; green
 * commits must make it pass WITHOUT weakening the zero-side-effect proof.
 *
 * Governing decisions: D30 (launch preview gate — eight groups, nothing
 * executes before confirmation), D38 (skills/connectors surfaced from the
 * pinned pack; connectors never auto-install), D20 (credits estimate is a
 * RANGE with a settlement note, not a promise), D35 (approval/risk classes
 * named without promising outcomes), D29 (runtime gateway is the only
 * writer; the preview is a read-only computation), D23 rule 4 (typed
 * failures only), E12 (workspace scoping), PRD §19 AC6/AC23.
 *
 * Route-shape note: S13/S14 own /v1/operations and /v1/operations/
 * :operation_id — a /v1/operations/definitions path would let the
 * :operation_id segment capture the literal "definitions". The preview read
 * model therefore uses DISTINCT paths:
 *   GET /v1/operation-definitions
 *   GET /v1/operation-definitions/:operation_definition_id/preview
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_WORKSPACE_ID, composeRuntime, type RuntimeHandle } from "./compose.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PACKS_ROOT = resolve(here, "../../../../../agent-packs");
const STUDENT_MANIFEST = JSON.parse(
  readFileSync(resolve(PACKS_ROOT, "student/v1/manifest.json"), "utf8"),
) as {
  pack_id: string;
  version: string;
  agents: Array<{ agent_id: string; display_name: string }>;
};

const WORKSPACE = DEFAULT_WORKSPACE_ID;
const RESEARCHER = "agent_researcher";
const CITATION = "agent_citation_manager";

interface RunningRuntime {
  runtime: RuntimeHandle;
  origin: string;
  dbPath: string;
  close(): Promise<void>;
}

const running: RunningRuntime[] = [];

async function composeOn(dbPath: string): Promise<RunningRuntime> {
  const runtime = composeRuntime({ dbPath, packsRoot: PACKS_ROOT, workspaceId: WORKSPACE });
  await new Promise<void>((resolveListen) => runtime.httpServer.listen(0, "127.0.0.1", resolveListen));
  const address = runtime.httpServer.address() as { port: number };
  const handle: RunningRuntime = {
    runtime,
    origin: `http://127.0.0.1:${address.port}`,
    dbPath,
    close: () => runtime.close(),
  };
  running.push(handle);
  return handle;
}

async function fetchAny(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

/** Row counts for every user table in the SQLite database. */
function tableCounts(dbPath: string): Record<string, number> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number | bigint };
      counts[name] = Number(row.n);
    }
    return counts;
  } finally {
    db.close();
  }
}

/**
 * Content fingerprint of every user table: the strongest read-only proof —
 * if ANY row anywhere changes (operations, runs, chats, conversations,
 * sessions, journal/events, workers), the fingerprint changes.
 */
function dbFingerprint(dbPath: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const parts: string[] = [];
    for (const { name } of tables) {
      const rows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
      const hash = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
      parts.push(`${name}=${hash}`);
    }
    return parts.join("|");
  } finally {
    db.close();
  }
}

function expectNoOutcomePromises(preview: Record<string, unknown>) {
  const serialized = JSON.stringify(preview);
  expect(serialized).not.toMatch(
    /\bwill (merge|send|post|submit|publish|execute|commit|install|connect|run)\b/i,
  );
}

afterAll(async () => {
  for (const handle of running) {
    await handle.close();
  }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

let tempDir: string | undefined;

function makeDbPath(): string {
  tempDir ??= mkdtempSync(join(tmpdir(), "s15-preview-"));
  return join(tempDir, `runtime-${running.length + 1}.sqlite`);
}

describe("S15 operation launch preview (chunk 1: read model)", () => {
  it("lists the pinned pack's operation definitions", async () => {
    const { origin } = await composeOn(makeDbPath());
    const list = await fetchAny(origin, "/v1/operation-definitions");
    expect(list.status).toBe(200);
    expect(list.json).not.toBeNull();
    const definitions = (list.json?.definitions ?? list.json) as Array<Record<string, unknown>>;
    expect(Array.isArray(definitions)).toBe(true);
    expect(definitions.length).toBeGreaterThanOrEqual(1);
    for (const definition of definitions) {
      expect(typeof definition.operation_definition_id).toBe("string");
      expect(typeof definition.title).toBe("string");
      expect(typeof definition.purpose_summary).toBe("string");
    }
    const researchPaper = definitions.find(
      (definition) => definition.operation_definition_id === "research-paper",
    );
    expect(researchPaper).toBeDefined();
  });

  it("builds the eight-group launch preview with truthful values", async () => {
    const { origin } = await composeOn(makeDbPath());
    const list = await fetchAny(origin, "/v1/operation-definitions");
    expect(list.status).toBe(200);
    const definitions = (list.json?.definitions ?? list.json) as Array<{
      operation_definition_id: string;
    }>;
    const definitionId = definitions[0]!.operation_definition_id;

    const preview = await fetchAny(
      origin,
      `/v1/operation-definitions/${definitionId}/preview`,
    );
    expect(preview.status).toBe(200);
    expect(preview.json).not.toBeNull();
    const body = preview.json as Record<string, unknown>;

    // All eight groups (D30) plus the pinned pack identity.
    expect(typeof body.definition_ref).toBe("string");
    expect(body.definition_ref).toContain("@");
    const pack = body.pack as Record<string, unknown>;
    expect(pack.pack_id).toBe(STUDENT_MANIFEST.pack_id);
    expect(pack.version).toBe(STUDENT_MANIFEST.version);
    for (const group of [
      "definition",
      "roster",
      "skills",
      "connectors",
      "providers",
      "estimated_credits",
      "approval_requirements",
      "expected_outputs",
    ]) {
      expect(body[group], `preview group ${group} missing`).toBeDefined();
    }

    // Group 1 — purpose comes from the definition.
    const definition = body.definition as Record<string, unknown>;
    expect(typeof definition.purpose).toBe("string");
    expect((definition.purpose as string).length).toBeGreaterThan(0);

    // Group 2 — recommended roster with per-Agent roles and a marked coordinator.
    const roster = body.roster as Record<string, unknown>;
    const agents = roster.agents as Array<Record<string, unknown>>;
    expect(agents.length).toBeGreaterThanOrEqual(1);
    const coordinatorCount = agents.filter((agent) => agent.is_coordinator === true).length;
    expect(coordinatorCount).toBe(1);
    expect(typeof roster.coordinator_agent_id).toBe("string");
    for (const agent of agents) {
      expect(typeof agent.agent_id).toBe("string");
      expect(typeof agent.display_name).toBe("string");
      expect(typeof agent.role).toBe("string");
    }

    // Group 3 — skills per Agent from the pinned pack (D38).
    const skills = body.skills as Record<string, unknown>;
    const skillEntries = skills.agents as Array<Record<string, unknown>>;
    for (const agent of agents) {
      const entry = skillEntries.find((candidate) => candidate.agent_id === agent.agent_id);
      expect(entry, `skills entry for ${String(agent.agent_id)}`).toBeDefined();
      expect(Array.isArray(entry?.skills)).toBe(true);
    }

    // Group 4 — connectors are ALWAYS not connected in the prototype (D38):
    // the preview shows configuration, never auto-installs.
    const connectors = body.connectors as Record<string, unknown>;
    const connectorItems = connectors.items as Array<Record<string, unknown>>;
    expect(Array.isArray(connectorItems)).toBe(true);
    for (const connector of connectorItems) {
      expect(connector.connected).toBe(false);
      expect(typeof connector.connector_id).toBe("string");
      expect(String(connector.status)).toMatch(/not_connected|not_configured/);
    }

    // Group 5 — provider/model per Agent, honest about "not configured"
    // (S23 owns real providers; the prototype carries placeholders).
    const providers = body.providers as Record<string, unknown>;
    const providerEntries = providers.agents as Array<Record<string, unknown>>;
    expect(providerEntries.length).toBe(agents.length);
    for (const entry of providerEntries) {
      expect(agents.some((agent) => agent.agent_id === entry.agent_id)).toBe(true);
      if (entry.configured !== true) {
        expect(String(entry.note ?? "")).toMatch(/not configured/i);
      }
    }

    // Group 6 — credits are a RANGE with the settlement note (D20).
    const credits = body.estimated_credits as Record<string, unknown>;
    expect(typeof credits.min_credits).toBe("number");
    expect(typeof credits.max_credits).toBe("number");
    expect(credits.min_credits as number).toBeLessThanOrEqual(credits.max_credits as number);
    expect(
      String(credits.settlement_note ?? credits.note ?? ""),
    ).toMatch(/settle/i);

    // Group 7 — approval requirements name risk classes without promising
    // outcomes (D35).
    const approvals = body.approval_requirements as Record<string, unknown>;
    const riskClasses = approvals.risk_classes as unknown[];
    expect(Array.isArray(riskClasses)).toBe(true);
    expect(riskClasses.length).toBeGreaterThanOrEqual(1);
    for (const riskClass of riskClasses) {
      expect(typeof riskClass).toBe("string");
    }
    expect(String(approvals.mapping_note ?? "")).toMatch(/risk|ladder|approval/i);
    expectNoOutcomePromises(body);

    // Group 8 — expected outputs are honest: from the definition, or a
    // purpose-derived statement explicitly marked as such.
    const outputs = body.expected_outputs as Record<string, unknown> | null;
    if (outputs !== null && outputs !== undefined) {
      const source = outputs.source;
      expect(source === "definition" || source === "purpose_derived").toBe(true);
      if (typeof outputs.statement === "string") {
        expect(outputs.statement.length).toBeGreaterThan(0);
      }
    }
  });

  it("answers an unknown definition with a typed 404-class failure", async () => {
    const { origin } = await composeOn(makeDbPath());
    const preview = await fetchAny(
      origin,
      "/v1/operation-definitions/operation_does_not_exist/preview",
    );
    expect(preview.status).toBe(404);
    expect(preview.json).not.toBeNull();
    const error = preview.json?.error as Record<string, unknown> | undefined;
    expect(error).toBeDefined();
    expect(typeof error?.code).toBe("string");
  });

  it("recomputes the preview for a roster override WITHOUT persisting anything", async () => {
    const { origin, dbPath } = await composeOn(makeDbPath());
    const list = await fetchAny(origin, "/v1/operation-definitions");
    const definitions = (list.json?.definitions ?? list.json) as Array<{
      operation_definition_id: string;
    }>;
    const definitionId = definitions[0]!.operation_definition_id;

    const before = dbFingerprint(dbPath);
    const overridden = await fetchAny(
      origin,
      `/v1/operation-definitions/${definitionId}/preview?roster_agent_ids=${RESEARCHER},${CITATION}&coordinator_agent_id=${CITATION}`,
    );
    expect(overridden.status).toBe(200);
    const roster = (overridden.json as Record<string, unknown>).roster as Record<
      string,
      unknown
    >;
    expect(roster.coordinator_agent_id).toBe(CITATION);
    expect(roster.source).toBe("request_override");
    const agents = roster.agents as Array<Record<string, unknown>>;
    expect(agents.map((agent) => agent.agent_id).sort()).toEqual(
      [RESEARCHER, CITATION].sort(),
    );
    expect(dbFingerprint(dbPath)).toBe(before);
  });

  it("THE ZERO-SIDE-EFFECT PROOF: preview routes leave the database byte-identical", async () => {
    const { origin, dbPath } = await composeOn(makeDbPath());

    const beforeCounts = tableCounts(dbPath);
    const before = dbFingerprint(dbPath);

    // Both routes, several calls, roster overrides included.
    const list1 = await fetchAny(origin, "/v1/operation-definitions");
    const list2 = await fetchAny(origin, "/v1/operation-definitions");
    expect(list1.status).toBe(200);
    expect(list2.status).toBe(200);
    const definitions = (list1.json?.definitions ?? list1.json) as Array<{
      operation_definition_id: string;
    }>;
    const definitionId = definitions[0]!.operation_definition_id;
    for (const path of [
      `/v1/operation-definitions/${definitionId}/preview`,
      `/v1/operation-definitions/${definitionId}/preview?roster_agent_ids=${RESEARCHER}&coordinator_agent_id=${RESEARCHER}`,
      `/v1/operation-definitions/${definitionId}/preview?roster_agent_ids=${CITATION},${RESEARCHER}&coordinator_agent_id=${CITATION}`,
      "/v1/operation-definitions/operation_does_not_exist/preview",
    ]) {
      const response = await fetchAny(origin, path);
      expect([200, 404]).toContain(response.status);
    }

    const afterCounts = tableCounts(dbPath);
    const after = dbFingerprint(dbPath);

    // No table appeared or disappeared, and no table's ROW COUNT changed.
    expect(Object.keys(afterCounts).sort()).toEqual(Object.keys(beforeCounts).sort());
    for (const [table, count] of Object.entries(afterCounts)) {
      expect(count, `table ${table} row count changed`).toBe(beforeCounts[table]);
    }
    // And no CONTENT changed anywhere — the whole database is byte-identical.
    expect(after).toBe(before);

    // Named proof points (D30): zero operation rows, zero task-run rows,
    // zero Operation-chat rows, zero conversations created.
    for (const [table, count] of Object.entries(afterCounts)) {
      if (/operation|conversation|chat|task_run|runs/i.test(table)) {
        expect(count, `table ${table} must stay empty for a preview-only call`).toBe(0);
      }
    }
  });
});
