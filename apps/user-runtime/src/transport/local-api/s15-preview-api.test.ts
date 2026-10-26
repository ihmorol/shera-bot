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
 * The preview payload is asserted against the PINNED PACK MANIFEST itself
 * (the same file the runtime loads), so every group is checked for
 * TRUTHFULNESS, not just presence: roster/skills/connectors must equal what
 * the pack declares, providers must be honest "not configured" placeholders,
 * credits must be the documented bounded range, and the approval classes
 * must follow the documented D35 ladder without promising outcomes.
 *
 * Committed RED-FIRST before the implementation existed (the routes 404ed);
 * the green commits make it pass WITHOUT weakening the zero-side-effect
 * proof.
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
 * :operation_id segment capture the literal "definitions" (Express matches
 * in registration order). The preview read model therefore uses DISTINCT
 * paths:
 *   GET /v1/operation-definitions
 *   GET /v1/operation-definitions/:operation_definition_id/preview
 * and chunk 3's confirm step rides the same distinct namespace:
 *   POST /v1/operations/launch
 * (a POST, so the GET :operation_id capture cannot swallow it either).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

// The zero-side-effect probe lives in the sqlite adapter — the ONLY place
// the sqlite driver and SQL may appear (D23 rule 2; the boundary contract
// enforces it).
import { sqliteSideEffectProbe } from "../../adapters/sqlite/operations-repository.ts";
import { DEFAULT_WORKSPACE_ID, composeRuntime, type RuntimeHandle } from "./compose.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PACKS_ROOT = resolve(here, "../../../../../agent-packs");
const STUDENT_MANIFEST = JSON.parse(
  readFileSync(resolve(PACKS_ROOT, "student/v1/manifest.json"), "utf8"),
) as {
  pack_id: string;
  version: string;
  default_coordinator_agent_id: string;
  skills: Array<{ skill_id: string; title: string }>;
  agents: Array<{
    agent_id: string;
    display_name: string;
    role_description: string;
    default_provider: { provider_id: string; model: string };
    skills: string[];
    tools: Array<{ tool_id: string; version: string }>;
  }>;
  operations: Array<{
    operation_id: string;
    version: string;
    title: string;
    purpose: string;
    roster: string[];
    coordinator?: string;
    skills: string[];
    connectors: string[];
  }>;
};
const RESEARCH_PAPER = STUDENT_MANIFEST.operations.find(
  (operation) => operation.operation_id === "operation_research_paper",
);
const EXAM_PREP = STUDENT_MANIFEST.operations.find(
  (operation) => operation.operation_id === "operation_exam_preparation",
);
expect(RESEARCH_PAPER).toBeDefined();
expect(EXAM_PREP).toBeDefined();

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
  await new Promise<void>((resolveListen) =>
    runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
  );
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

/** Chunk 3: POST a JSON body and read back the typed answer. */
async function postAny(origin: string, path: string, body: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

const LIST_DEFINITIONS = `/v1/operation-definitions?workspace_id=${WORKSPACE}`;
const previewPath = (definitionId: string, query = "") =>
  `/v1/operation-definitions/${definitionId}/preview?workspace_id=${WORKSPACE}${query}`;

async function listDefinitions(origin: string) {
  const list = await fetchAny(origin, LIST_DEFINITIONS);
  expect(list.status).toBe(200);
  expect(list.json).not.toBeNull();
  return (list.json?.definitions ?? null) as Array<Record<string, unknown>> | null;
}

/**
 * The zero-side-effect probe (the sqlite adapter's read-only helper): row
 * counts AND a content fingerprint for every user table. If ANY row anywhere
 * changes (operations, runs, chats, conversations, sessions, journal,
 * receipts), the fingerprint changes.
 */
function tableCounts(dbPath: string): Record<string, number> {
  return sqliteSideEffectProbe(dbPath).tableCounts;
}

function dbFingerprint(dbPath: string): string {
  return sqliteSideEffectProbe(dbPath).fingerprint;
}

/** D30/D35: classes are NAMED; nothing promises an executed outcome. */
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
  it("lists the pinned pack's operation definitions verbatim from the manifest", async () => {
    const { origin } = await composeOn(makeDbPath());
    const definitions = await listDefinitions(origin);
    expect(definitions).not.toBeNull();
    expect(definitions!.length).toBe(STUDENT_MANIFEST.operations.length);
    for (const operation of STUDENT_MANIFEST.operations) {
      const listed = definitions!.find(
        (definition) => definition.operation_definition_id === operation.operation_id,
      );
      expect(listed, `${operation.operation_id} in the list`).toBeDefined();
      expect(listed!.title).toBe(operation.title);
      expect(listed!.purpose_summary).toBe(operation.purpose);
      expect(listed!.version).toBe(operation.version);
    }
  });

  it("builds the eight-group launch preview with values TRUE to the pinned manifest", async () => {
    const { origin } = await composeOn(makeDbPath());
    const preview = await fetchAny(origin, previewPath(RESEARCH_PAPER!.operation_id));
    expect(preview.status).toBe(200);
    expect(preview.json).not.toBeNull();
    const body = preview.json as Record<string, unknown>;

    // All eight groups (D30) plus the pinned pack identity (D29).
    expect(body.definition_ref).toBe(
      `agent-packs/${STUDENT_MANIFEST.pack_id}/v${STUDENT_MANIFEST.version}/operations/${RESEARCH_PAPER!.operation_id}@${RESEARCH_PAPER!.version}`,
    );
    const pack = body.pack as Record<string, unknown>;
    expect(pack.pack_id).toBe(STUDENT_MANIFEST.pack_id);
    expect(pack.pack_version).toBe(STUDENT_MANIFEST.version);
    expect(pack.pinned).toBe(true);
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

    // Group 1 — purpose comes verbatim from the definition.
    const definition = body.definition as Record<string, unknown>;
    expect(definition.purpose).toBe(RESEARCH_PAPER!.purpose);
    expect(definition.title).toBe(RESEARCH_PAPER!.title);

    // Group 2 — the manifest roster, per-Agent roles, coordinator marked.
    const roster = body.roster as Record<string, unknown>;
    const agents = roster.agents as Array<Record<string, unknown>>;
    expect(agents.map((agent) => agent.agent_id)).toEqual(RESEARCH_PAPER!.roster);
    expect(roster.coordinator_agent_id).toBe(STUDENT_MANIFEST.default_coordinator_agent_id);
    expect(roster.source).toBe("pack_default");
    for (const agent of agents) {
      const manifestAgent = STUDENT_MANIFEST.agents.find(
        (candidate) => candidate.agent_id === agent.agent_id,
      );
      expect(manifestAgent).toBeDefined();
      expect(agent.display_name).toBe(manifestAgent!.display_name);
      expect(agent.role).toBe(manifestAgent!.role_description);
    }
    expect(agents.filter((agent) => agent.is_coordinator === true).length).toBe(1);
    expect(agents.find((agent) => agent.is_coordinator === true)!.agent_id).toBe(
      STUDENT_MANIFEST.default_coordinator_agent_id,
    );

    // Group 3 — skills per Agent equal the pack's agent declarations (D38).
    const skills = body.skills as Record<string, unknown>;
    expect(skills.source).toBe("pack");
    expect(skills.operation_skill_ids).toEqual(RESEARCH_PAPER!.skills);
    const skillEntries = skills.agents as Array<Record<string, unknown>>;
    for (const agent of agents) {
      const entry = skillEntries.find((candidate) => candidate.agent_id === agent.agent_id);
      const manifestAgent = STUDENT_MANIFEST.agents.find(
        (candidate) => candidate.agent_id === agent.agent_id,
      );
      expect(entry, `skills entry for ${String(agent.agent_id)}`).toBeDefined();
      expect(
        (entry!.skills as Array<{ skill_id: string; title: string | null }>).map(
          (skill) => skill.skill_id,
        ),
      ).toEqual(manifestAgent!.skills);
      // Titles resolve from the pack's skill catalog (null when omitted).
      for (const skill of entry!.skills as Array<{ skill_id: string; title: string | null }>) {
        const declared = STUDENT_MANIFEST.skills.find(
          (candidate) => candidate.skill_id === skill.skill_id,
        );
        expect(skill.title).toBe(declared?.title ?? null);
      }
    }

    // Group 4 — the definition's declared connectors, ALWAYS not connected
    // (D38: recommended, never auto-installed).
    const connectors = body.connectors as Record<string, unknown>;
    const connectorItems = connectors.items as Array<Record<string, unknown>>;
    expect(connectorItems.map((connector) => connector.connector_id)).toEqual(
      RESEARCH_PAPER!.connectors,
    );
    for (const connector of connectorItems) {
      expect(connector.connected).toBe(false);
      expect(connector.status).toBe("not_connected");
      expect(String(connector.note).length).toBeGreaterThan(0);
    }

    // Group 5 — provider/model per Agent, honest about "not configured"
    // (S23 owns real providers; the prototype carries placeholders).
    const providers = body.providers as Record<string, unknown>;
    const providerEntries = providers.agents as Array<Record<string, unknown>>;
    expect(providerEntries.length).toBe(agents.length);
    for (const entry of providerEntries) {
      const manifestAgent = STUDENT_MANIFEST.agents.find(
        (candidate) => candidate.agent_id === entry.agent_id,
      );
      // The seeded Agent rows carry the pack default pair as their saved
      // settings — surfaced with configured:false (never a live provider).
      expect(entry.provider_id).toBe(manifestAgent!.default_provider.provider_id);
      expect(entry.model).toBe(manifestAgent!.default_provider.model);
      expect(entry.configured).toBe(false);
      expect(String(entry.note)).toMatch(/not configured/i);
    }

    // Group 6 — credits are a RANGE with the settlement note (D20). The
    // documented placeholder formula: min 1 / max 5 credits per
    // platform-provider Agent (the whole research-paper roster here).
    const credits = body.estimated_credits as Record<string, unknown>;
    expect(credits.currency).toBe("shera_credits");
    expect(credits.min_credits).toBe(RESEARCH_PAPER!.roster.length * 1);
    expect(credits.max_credits).toBe(RESEARCH_PAPER!.roster.length * 5);
    expect(credits.min_credits as number).toBeLessThanOrEqual(credits.max_credits as number);
    expect(String(credits.settlement_note)).toMatch(/settle/i);
    expect(credits.custom_provider_agents).toEqual([]);

    // Group 7 — the D35 ladder over the roster's tool references, honestly
    // mapped: every research-paper tool is read-only, so nothing pauses.
    const approvals = body.approval_requirements as Record<string, unknown>;
    const rosterToolIds = [
      ...new Set(
        RESEARCH_PAPER!.roster.flatMap((agentId) =>
          STUDENT_MANIFEST.agents
            .find((candidate) => candidate.agent_id === agentId)!
            .tools.map((tool) => tool.tool_id),
        ),
      ),
    ];
    const expectedReadonly = rosterToolIds.filter((toolId) =>
      ["tool_web_search", "tool_file_read"].includes(toolId),
    );
    expect(approvals.risk_classes).toEqual(["read-only"]);
    expect(approvals.classes_requiring_approval).toEqual([]);
    expect(approvals.mapping).toEqual([
      { risk_class: "read-only", tool_ids: expectedReadonly, behavior: "auto_execute" },
    ]);
    expect(String(approvals.mapping_note)).toMatch(/risk|ladder|approval/i);
    expectNoOutcomePromises(body);

    // Group 8 — expected outputs are HONEST: purpose-derived, with the
    // reason, because the manifest declares no outputs field.
    const outputs = body.expected_outputs as Record<string, unknown> | null;
    expect(outputs).not.toBeNull();
    expect(outputs!.source).toBe("purpose_derived");
    expect(String(outputs!.statement)).toContain(RESEARCH_PAPER!.purpose);
    expect(typeof outputs!.reason).toBe("string");
  });

  it("honors the definition's coordinator override, empty connector set, and approval pauses", async () => {
    const { origin } = await composeOn(makeDbPath());
    const preview = await fetchAny(origin, previewPath(EXAM_PREP!.operation_id));
    expect(preview.status).toBe(200);
    const body = preview.json as Record<string, unknown>;
    const roster = body.roster as Record<string, unknown>;
    // operation_exam_preparation overrides the coordinator in the manifest.
    expect(roster.coordinator_agent_id).toBe(EXAM_PREP!.coordinator);
    expect(roster.source).toBe("definition_override");
    const agents = roster.agents as Array<Record<string, unknown>>;
    expect(agents.find((agent) => agent.is_coordinator === true)!.agent_id).toBe(
      EXAM_PREP!.coordinator,
    );
    // No connectors declared for this definition — an empty, honest list.
    const connectors = body.connectors as Record<string, unknown>;
    expect(connectors.items).toEqual([]);
    // The exam-prep roster reaches only read-only tools: no approval pause.
    const approvals = body.approval_requirements as Record<string, unknown>;
    expect(approvals.risk_classes).toEqual(["read-only"]);
    expect(approvals.classes_requiring_approval).toEqual([]);
    expectNoOutcomePromises(body);

    // operation_programming_assignment rosters the Developer (tool_code_exec
    // + tool_file_read): the ladder names code-execution and its pause.
    const programming = await fetchAny(origin, previewPath("operation_programming_assignment"));
    expect(programming.status).toBe(200);
    const programmingBody = programming.json as Record<string, unknown>;
    const programmingRoster = programmingBody.roster as Record<string, unknown>;
    expect(programmingRoster.coordinator_agent_id).toBe(
      STUDENT_MANIFEST.default_coordinator_agent_id,
    );
    const programmingApprovals = programmingBody.approval_requirements as Record<string, unknown>;
    expect(programmingApprovals.risk_classes).toEqual(["read-only", "code-execution"]);
    expect(programmingApprovals.classes_requiring_approval).toEqual(["code-execution"]);
    expect(programmingApprovals.mapping).toEqual([
      {
        risk_class: "read-only",
        tool_ids: ["tool_web_search", "tool_file_read"],
        behavior: "auto_execute",
      },
      { risk_class: "code-execution", tool_ids: ["tool_code_exec"], behavior: "approval_required" },
    ]);
    expectNoOutcomePromises(programmingBody);
  });

  it("answers an unknown definition with the typed 404-class failure", async () => {
    const { origin } = await composeOn(makeDbPath());
    const preview = await fetchAny(origin, previewPath("operation_does_not_exist"));
    expect(preview.status).toBe(404);
    expect(preview.json).not.toBeNull();
    const body = preview.json as Record<string, unknown>;
    expect(body.code).toBe("OPERATION_DEFINITION_NOT_FOUND");
    expect(body.category).toBe("state");
    expect(typeof body.correlation_id).toBe("string");
  });

  it("recomputes the preview for a roster override WITHOUT persisting anything", async () => {
    const { origin, dbPath } = await composeOn(makeDbPath());
    const before = dbFingerprint(dbPath);

    const overridden = await fetchAny(
      origin,
      previewPath(
        RESEARCH_PAPER!.operation_id,
        `&roster_agent_ids=${RESEARCHER},${CITATION}&coordinator_agent_id=${CITATION}`,
      ),
    );
    expect(overridden.status).toBe(200);
    const roster = (overridden.json as Record<string, unknown>).roster as Record<string, unknown>;
    expect(roster.coordinator_agent_id).toBe(CITATION);
    expect(roster.source).toBe("request_override");
    const agents = roster.agents as Array<Record<string, unknown>>;
    expect(agents.map((agent) => agent.agent_id)).toEqual([RESEARCHER, CITATION]);
    expect(agents.find((agent) => agent.is_coordinator === true)!.agent_id).toBe(CITATION);
    // The groups recompute: two platform Agents shrink the estimate range.
    const credits = (overridden.json as Record<string, unknown>).estimated_credits as Record<
      string,
      unknown
    >;
    expect(credits.min_credits).toBe(2);
    expect(credits.max_credits).toBe(10);

    // "none" is a legal coordinator override (D42) — no Agent is marked.
    const noneCoordinator = await fetchAny(
      origin,
      previewPath(RESEARCH_PAPER!.operation_id, "&coordinator_agent_id=none"),
    );
    expect(noneCoordinator.status).toBe(200);
    const noneRoster = (noneCoordinator.json as Record<string, unknown>).roster as Record<
      string,
      unknown
    >;
    expect(noneRoster.coordinator_agent_id).toBe("none");
    expect(
      (noneRoster.agents as Array<Record<string, unknown>>).filter(
        (agent) => agent.is_coordinator === true,
      ).length,
    ).toBe(0);

    // Typed refusals: an override Agent outside the pinned pack, and an
    // effectively empty override roster.
    const foreign = await fetchAny(
      origin,
      previewPath(RESEARCH_PAPER!.operation_id, "&roster_agent_ids=agent_not_in_any_pack"),
    );
    expect(foreign.status).toBe(400);
    expect((foreign.json as Record<string, unknown>).code).toBe("OPERATION_COMMAND_INVALID");
    const empty = await fetchAny(
      origin,
      previewPath(RESEARCH_PAPER!.operation_id, "&roster_agent_ids=,"),
    );
    expect(empty.status).toBe(400);
    expect((empty.json as Record<string, unknown>).code).toBe("OPERATION_ROSTER_EMPTY");

    expect(dbFingerprint(dbPath)).toBe(before);
  });

  it("THE ZERO-SIDE-EFFECT PROOF: preview routes leave the database byte-identical", async () => {
    const { origin, dbPath } = await composeOn(makeDbPath());

    const beforeCounts = tableCounts(dbPath);
    const before = dbFingerprint(dbPath);

    // Both routes, several calls, roster overrides included, plus the typed
    // 404 path — nothing anywhere may write.
    const list1 = await fetchAny(origin, LIST_DEFINITIONS);
    const list2 = await fetchAny(origin, LIST_DEFINITIONS);
    expect(list1.status).toBe(200);
    expect(list2.status).toBe(200);
    for (const path of [
      previewPath(RESEARCH_PAPER!.operation_id),
      previewPath(EXAM_PREP!.operation_id),
      previewPath(
        RESEARCH_PAPER!.operation_id,
        `&roster_agent_ids=${RESEARCHER}&coordinator_agent_id=${RESEARCHER}`,
      ),
      previewPath(
        RESEARCH_PAPER!.operation_id,
        `&roster_agent_ids=${CITATION},${RESEARCHER}&coordinator_agent_id=${CITATION}`,
      ),
      previewPath(RESEARCH_PAPER!.operation_id, "&coordinator_agent_id=none"),
      previewPath("operation_does_not_exist"),
      previewPath(RESEARCH_PAPER!.operation_id, "&roster_agent_ids=agent_not_in_any_pack"),
    ]) {
      const response = await fetchAny(origin, path);
      expect([200, 400, 404]).toContain(response.status);
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

/**
 * S15 chunk 3 — THE CONFIRM STEP: POST /v1/operations/launch. The route lives
 * under the operation-definitions namespace's sibling (a DISTINCT path from
 * /v1/operations/:operation_id — the same capture argument as chunk 1's
 * route-shape note), and it is the ONLY path in this slice that creates
 * anything: one Operation (through the SAME createOperation machinery with
 * the definition_ref + pinning snapshot), its chat binding, and THE FIRST RUN
 * (D30/AC23: confirm creates exactly one chat and one first run).
 *
 * The launch NEVER trusts the preview: the confirmed envelope is RE-RESOLVED
 * from the pinned pack (an unknown definition is the typed 404) and the
 * roster/coordinator are RE-VALIDATED against the pack catalog (D36) by the
 * same createOperation validation the ad-hoc flow uses. Idempotency rides the
 * command receipts seam (D23 rule 6): a replayed (workspace_id,
 * idempotency_key) returns the ORIGINAL operation/run/chat without creating
 * duplicates; a key already spent on a different command family is the typed
 * conflict.
 */
describe("S15 chunk 3 — the launch confirm flow (POST /v1/operations/launch)", () => {
  const LAUNCH_PATH = "/v1/operations/launch";
  const ACTOR = { type: "user", id: "user_emon" } as const;

  let launchCounter = 0;
  function launchBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    launchCounter += 1;
    return {
      workspace_id: WORKSPACE,
      operation_definition_id: RESEARCH_PAPER!.operation_id,
      roster_agent_ids: [RESEARCHER, CITATION],
      coordinator_agent_id: CITATION,
      idempotency_key: `idem_launch_${launchCounter.toString().padStart(4, "0")}`,
      actor: ACTOR,
      issued_at: "2026-10-25T12:00:00.000Z",
      ...overrides,
    };
  }

  /** The row count of one user table (the probe's counts view). */
  function countOf(dbPath: string, table: string): number {
    const counts = tableCounts(dbPath);
    expect(counts, `table ${table} exists`).toHaveProperty(table);
    return counts[table]!;
  }

  it("confirm creates EXACTLY one Operation chat and one first run (D30/AC23) with the confirmed overrides persisted", async () => {
    const { origin, dbPath } = await composeOn(makeDbPath());

    // The user saw the preview (the modal's read) before confirming.
    const preview = await fetchAny(origin, previewPath(RESEARCH_PAPER!.operation_id));
    expect(preview.status).toBe(200);
    const previewBody = preview.json as Record<string, unknown>;

    const response = await postAny(origin, LAUNCH_PATH, launchBody());
    expect(response.status).toBe(201);
    expect(response.json).not.toBeNull();
    const result = response.json as Record<string, unknown>;
    expect(typeof result.operation_id).toBe("string");
    expect(typeof result.run_id).toBe("string");
    expect(typeof result.chat_conversation_id).toBe("string");

    // The Operation record: definition_ref + pinning snapshot from the PINNED
    // pack, the definition's title as the name, the CONFIRMED roster and
    // coordinator (the preview's effective overrides are what launch persists).
    const detail = await fetchAny(
      origin,
      `/v1/operations/${String(result.operation_id)}?workspace_id=${WORKSPACE}`,
    );
    expect(detail.status).toBe(200);
    const detailBody = detail.json as Record<string, unknown>;
    const operation = detailBody.operation as Record<string, unknown>;
    expect(operation.definition_ref).toBe(previewBody.definition_ref);
    expect(operation.name).toBe(RESEARCH_PAPER!.title);
    expect(operation.coordinator_agent_id).toBe(CITATION);
    const pinning = operation.pinning as Record<string, unknown>;
    expect(pinning.pack_id).toBe(STUDENT_MANIFEST.pack_id);
    expect(pinning.pack_version).toBe(STUDENT_MANIFEST.version);
    // The pinning roster is DERIVED from the membership table (the v6
    // normalization — the JSON snapshot stores no roster), so it is pinned as
    // a set: the same Agents the user confirmed, whatever the table order.
    expect([...(pinning.roster_agent_ids as string[])].sort()).toEqual(
      [CITATION, RESEARCHER].sort(),
    );
    const roster = detailBody.roster as Array<Record<string, unknown>>;
    expect(roster.map((member) => member.agent_id).sort()).toEqual([CITATION, RESEARCHER].sort());

    // THE FIRST RUN (D30/AC23): exactly one, D8 CREATED, cursor 0.
    const runs = await fetchAny(
      origin,
      `/v1/operations/${String(result.operation_id)}/runs?workspace_id=${WORKSPACE}`,
    );
    expect(runs.status).toBe(200);
    const runRows = (runs.json as Record<string, unknown>).runs as Array<Record<string, unknown>>;
    expect(runRows).toHaveLength(1);
    expect(runRows[0]!.run_id).toBe(result.run_id);
    expect(runRows[0]!.state).toBe("CREATED");
    expect(runRows[0]!.events_seq_cursor).toBe(0);

    // The chat binding: the response's conversation id IS the Operation's
    // bound chat (created by the confirm, not lazily by a thread read).
    expect(detailBody.chat_conversation_id).toBe(result.chat_conversation_id);

    // And the database holds EXACTLY one of each — no more.
    expect(countOf(dbPath, "operations")).toBe(1);
    expect(countOf(dbPath, "operation_runs")).toBe(1);
    expect(countOf(dbPath, "operation_chats")).toBe(1);
    expect(countOf(dbPath, "conversations")).toBe(1);
  });

  it("the launch RE-RESOLVES the definition and RE-VALIDATES the roster against the pinned pack — preview edits are never trusted (D36)", async () => {
    const { origin, dbPath } = await composeOn(makeDbPath());
    const before = dbFingerprint(dbPath);

    // An unknown definition: the typed 404-class state failure, nothing created.
    const unknown = await postAny(
      origin,
      LAUNCH_PATH,
      launchBody({ operation_definition_id: "operation_does_not_exist" }),
    );
    expect(unknown.status).toBe(404);
    expect((unknown.json as Record<string, unknown>).code).toBe("OPERATION_DEFINITION_NOT_FOUND");

    // A roster naming an Agent outside the pinned pack: the SAME D36 refusal
    // the ad-hoc creation path answers (the launch shares createOperation's
    // validation, no fork) — the 403 policy class, nothing left behind.
    const foreign = await postAny(
      origin,
      LAUNCH_PATH,
      launchBody({ roster_agent_ids: [RESEARCHER, "agent_not_in_any_pack"] }),
    );
    expect(foreign.status).toBe(403);
    expect((foreign.json as Record<string, unknown>).code).toBe("OPERATION_ROSTER_REFUSED");

    // A coordinator outside the pinned pack: the same re-validation, answered
    // by the shared coordinator rule (the 404 state class).
    const foreignCoordinator = await postAny(
      origin,
      LAUNCH_PATH,
      launchBody({ coordinator_agent_id: "agent_not_in_any_pack" }),
    );
    expect(foreignCoordinator.status).toBe(404);
    expect((foreignCoordinator.json as Record<string, unknown>).code).toBe(
      "OPERATION_COORDINATOR_NOT_FOUND",
    );

    // An empty roster: the launch envelope requires at least one Agent.
    const empty = await postAny(origin, LAUNCH_PATH, launchBody({ roster_agent_ids: [] }));
    expect(empty.status).toBe(400);

    // A malformed envelope (missing fields, unknown fields): the typed 400.
    const malformed = await postAny(origin, LAUNCH_PATH, { workspace_id: WORKSPACE });
    expect(malformed.status).toBe(400);
    expect((malformed.json as Record<string, unknown>).code).toBe("CONTRACT_VALIDATION_FAILED");
    const extra = await postAny(origin, LAUNCH_PATH, launchBody({ surprise: true }));
    expect(extra.status).toBe(400);

    // NOTHING above persisted anything — the refusals leave no trace.
    expect(dbFingerprint(dbPath)).toBe(before);
    expect(countOf(dbPath, "operations")).toBe(0);
  });

  it("idempotency: a replayed (workspace_id, idempotency_key) returns the ORIGINAL operation/run/chat — no duplicates (D23 rule 6)", async () => {
    const { origin, dbPath } = await composeOn(makeDbPath());

    const body = launchBody({ idempotency_key: "idem_launch_replay_0001" });
    const first = await postAny(origin, LAUNCH_PATH, body);
    expect(first.status).toBe(201);
    const firstResult = first.json as Record<string, unknown>;

    const replay = await postAny(origin, LAUNCH_PATH, {
      ...body,
      issued_at: "2026-10-25T12:00:01.000Z",
    });
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual(firstResult);

    // Still exactly one of each — the replay created nothing.
    expect(countOf(dbPath, "operations")).toBe(1);
    expect(countOf(dbPath, "operation_runs")).toBe(1);
    expect(countOf(dbPath, "operation_chats")).toBe(1);
    expect(countOf(dbPath, "conversations")).toBe(1);

    // A DIFFERENT key is a different launch decision: a second Operation.
    const second = await postAny(
      origin,
      LAUNCH_PATH,
      launchBody({ idempotency_key: "idem_launch_replay_0002" }),
    );
    expect(second.status).toBe(201);
    expect((second.json as Record<string, unknown>).operation_id).not.toBe(
      firstResult.operation_id,
    );
    expect(countOf(dbPath, "operations")).toBe(2);
    expect(countOf(dbPath, "operation_runs")).toBe(2);
    expect(countOf(dbPath, "operation_chats")).toBe(2);
  });

  it("an idempotency_key already spent on a DIFFERENT command family is the typed conflict (D23 rule 6)", async () => {
    const { origin } = await composeOn(makeDbPath());
    const launched = await postAny(origin, LAUNCH_PATH, launchBody());
    expect(launched.status).toBe(201);
    const result = launched.json as Record<string, unknown>;

    // Spend the key on the message-send family inside the launched Operation.
    const message = await postAny(
      origin,
      `/v1/operations/${String(result.operation_id)}/thread/messages`,
      {
        workspace_id: WORKSPACE,
        idempotency_key: "idem_launch_cross_family_key",
        sender: { kind: "user", display_name: "Emon" },
        text: "before the cross-family attempt",
      },
    );
    expect(message.status).toBe(201);

    // Reusing THAT key for a launch is the typed conflict — never a duplicated
    // effect, never a silent retarget of the earlier command.
    const conflict = await postAny(
      origin,
      LAUNCH_PATH,
      launchBody({ idempotency_key: "idem_launch_cross_family_key" }),
    );
    expect(conflict.status).toBe(400);
    expect((conflict.json as Record<string, unknown>).code).toBe("OPERATION_COMMAND_INVALID");
    expect((conflict.json as Record<string, unknown>).category).toBe("conflict");
  });

  it("THE GATE THROUGH THE CONFIRM LENS: modal open (reads) + close leaves the database byte-identical; LAUNCH creates exactly one of each", async () => {
    const { origin, dbPath } = await composeOn(makeDbPath());
    const bootFingerprint = dbFingerprint(dbPath);

    // "Open the modal": the definitions read + the preview read with the
    // user's edits (the override refetches) — all GETs, all read-only.
    const definitions = await fetchAny(origin, LIST_DEFINITIONS);
    expect(definitions.status).toBe(200);
    const edited = await fetchAny(
      origin,
      previewPath(
        RESEARCH_PAPER!.operation_id,
        `&roster_agent_ids=${RESEARCHER},${CITATION}&coordinator_agent_id=${CITATION}`,
      ),
    );
    expect(edited.status).toBe(200);

    // "Close the modal": NO request exists for cancel — the close is a pure
    // client-side state change. Nothing was written by the open+edit+close.
    const beforeCounts = tableCounts(dbPath);
    expect(dbFingerprint(dbPath)).toBe(bootFingerprint);
    for (const [table, count] of Object.entries(beforeCounts)) {
      if (/operation|conversation|chat|task_run|runs/i.test(table)) {
        expect(count, `table ${table} stays empty before confirmation`).toBe(0);
      }
    }

    // "Confirm": exactly one Operation, one chat, one run — no more.
    const launched = await postAny(origin, LAUNCH_PATH, launchBody());
    expect(launched.status).toBe(201);
    expect(countOf(dbPath, "operations")).toBe(1);
    expect(countOf(dbPath, "operation_runs")).toBe(1);
    expect(countOf(dbPath, "operation_chats")).toBe(1);
    expect(countOf(dbPath, "conversations")).toBe(1);
  });
});
