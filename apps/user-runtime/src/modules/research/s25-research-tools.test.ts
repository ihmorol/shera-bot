/**
 * S25 research and data tools (issue #26; PRD §5.1–5.3, §7; D15/D23-rule-8,
 * D27, D35, E13, G2/G3/G4/G6/G7).
 *
 * Chunk 1 pins the INVENTORY declarations and the D35 read-only posture:
 *
 *   1. AC7 — each research tool declares the full contracts shape: version,
 *      input/output schema, capabilities, risk_class READ_ONLY, timeout,
 *      resource limits, redaction policy — and the E13 recovery class is
 *      DATA: the tools that declare one carry it; the one that omits it
 *      carries the stored default needs_human. Nothing is inferred (G2).
 *   2. AC8 — a READ_ONLY research tool executes AUTOMATICALLY through the
 *      executor with the real S20 machinery wired and creates NO approval
 *      row and NO grant (D35: read-only runs execute automatically; G6).
 *
 * The default-CI network posture is a LOCAL deterministic fixture server
 * speaking the SearXNG JSON API shape — no live network in default CI (G7).
 * The SearXNG base URL is configuration; the real-container integration is
 * the recorded NOT-VERIFIED owner item.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TaskRun } from "@shera-bot/contracts";

import { openDatabase } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { ApprovalsRepository } from "../../adapters/sqlite/approvals-repository.ts";
import { ToolsRepository } from "../../adapters/sqlite/tools-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { EventsService } from "../events/events.service.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { ApprovalsService } from "../approvals/approvals.service.ts";
import { ToolExecutor } from "../tools/tool-executor.service.ts";
import { ToolRegistry } from "../tools/tool-registry.ts";
import { canonicalArgsDigest } from "../tools/tool-executor.service.ts";
import { registerResearchTools } from "../../transport/local-api/s25-research-api.ts";

const WS = "ws_default_01";
const TASK = "task_s25_01";
const CONV = "conv_s25_01";
const AGENT = "agent_researcher";
const USER = "user_owner";
const NOW = "2026-11-02T12:00:00.000Z";
const HASH = "a".repeat(64);

const tempDirs: string[] = [];

/** The local deterministic SearXNG-shaped fixture (G7: no live network). */
let fixture: Server;
let fixtureOrigin = "";

beforeAll(async () => {
  fixture = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    req.resume();
    req.on("end", () => {
      if (url.pathname !== "/search") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      if (url.searchParams.get("format") !== "json") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "format must be json" }));
        return;
      }
      const query = url.searchParams.get("q") ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          query,
          number_of_results: 2,
          results: [
            {
              title: "Attention Is All You Need",
              url: "https://arxiv.org/abs/1706.03762",
              content: "The dominant sequence transduction models are based on attention.",
              engine: "arxiv",
              score: 3.1,
            },
            {
              title: "SearXNG documentation",
              url: "https://docs.searxng.org/",
              content: "SearXNG is a privacy-respecting metasearch engine.",
              engine: "duckduckgo",
              score: 1.4,
            },
          ],
          answers: [],
          infoboxes: [],
          unresponsive_engines: [],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  fixtureOrigin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    task_id: TASK,
    workspace_id: WS,
    conversation_id: CONV,
    created_from: { trigger_event_type: "tool.proposed", trigger_event_id: "evt_s25_001" },
    pack_snapshot: { pack_id: "pack_student", pack_version: "1.0.0", pack_hash: HASH },
    roster: [AGENT],
    state: "RUNNING",
    version: 7,
    retry_count: 0,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

interface ResearchRuntime {
  executor: ToolExecutor;
  registry: ToolRegistry;
  tools: ToolsRepository;
  approvalsRepo: ApprovalsRepository;
}

function buildRuntime(): ResearchRuntime {
  const dir = mkdtempSync(join(tmpdir(), "shera-s25-research-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const approvalsRepo = new ApprovalsRepository(tx);
  const approvals = new ApprovalsService({
    tx,
    journal,
    events,
    approvals: approvalsRepo,
    operations: new OperationsRepository(tx),
    clock: () => NOW,
  });
  const tools = new ToolsRepository(conn.db);
  const registry = new ToolRegistry();
  registerResearchTools(registry, WS, {
    searxng: { baseUrl: fixtureOrigin },
    artifacts: null,
  });
  const executor = new ToolExecutor({
    registry,
    tools,
    tx,
    approvals,
    nowMs: () => 1_000,
    now: () => NOW,
  });
  return { executor, registry, tools, approvalsRepo };
}

const SEARCH_ARGS = { query: "transformer architecture literature" };

function searchProposal(rt: ResearchRuntime, rawArgs: Record<string, unknown> = SEARCH_ARGS) {
  return rt.executor.executeProposal({
    proposal: {
      workspace_id: WS,
      task_id: TASK,
      conversation_id: CONV,
      tool_id: "tool_web_search",
      tool_version: "1.0.0",
      capability: "research.search",
      args_digest: canonicalArgsDigest(rawArgs),
      proposal_summary: "search the web for transformer architecture literature",
    },
    run: makeRun(),
    agent_id: AGENT,
    rawArgs,
  });
}

describe("research tool inventory declarations (S25 chunk 1, AC7)", () => {
  it("declares the full contracts shape for the web-search built-in", () => {
    const rt = buildRuntime();
    const record = rt.registry.resolve(WS, "tool_web_search", "1.0.0");
    expect(record).not.toBeNull();
    const definition = record!.definition;
    expect(definition.tool_id).toBe("tool_web_search");
    expect(definition.version).toBe("1.0.0");
    expect(definition.name).toBe("Web search");
    expect(definition.owner).toEqual({ kind: "platform" });
    expect(definition.input_schema.type).toBe("object");
    expect((definition.input_schema as Record<string, unknown>).required).toContain("query");
    expect(definition.output_schema.type).toBe("object");
    expect(definition.capabilities).toEqual(["research.search"]);
    // The D35 read-only class is DATA on the record — read-only runs auto-execute.
    expect(definition.risk_class).toBe("READ_ONLY");
    expect(definition.timeout_ms).toBeGreaterThan(0);
    expect(definition.timeout_ms).toBeLessThanOrEqual(600_000);
    expect(definition.resource_limits.max_memory_mb).toBeGreaterThan(0);
    expect(definition.redaction_policy).toBe("standard");
    expect(definition.approval_policy).toBe("auto_read_only");
    // G4: the tool exists only where its network configuration exists.
    expect(definition.purpose).toContain("SearXNG");
  });

  it("applies the E13 recovery default needs_human when a tool omits the class", () => {
    const rt = buildRuntime();
    const record = rt.registry.resolve(WS, "tool_web_search", "1.0.0");
    // The web-search registration declares NO recovery field; the stored
    // default (the contracts schema default, E13) must be the value on the
    // record — never prose inference (G2).
    expect("recovery" in record!.definition).toBe(true);
    expect(record!.definition.recovery).toBe("needs_human");
  });

  it("does not register the search tool when no SearXNG endpoint is configured (G4)", () => {
    const dir = mkdtempSync(join(tmpdir(), "shera-s25-research-"));
    tempDirs.push(dir);
    const registry = new ToolRegistry();
    registerResearchTools(registry, WS, { searxng: null, artifacts: null });
    expect(registry.resolve(WS, "tool_web_search", "1.0.0")).toBeNull();
  });
});

describe("read-only research tools execute automatically (S25 chunk 1, AC8)", () => {
  it("executes a search through the executor with NO approval row and NO grant", async () => {
    const rt = buildRuntime();
    const outcome = searchProposal(rt);
    expect(outcome.outcome).toBe("executed");
    if (outcome.outcome !== "executed") {
      throw new Error("expected executed");
    }
    // AC8/D35/G6: the automatic path created NO approval request and NO grant.
    expect(rt.approvalsRepo.listRequestsByTask(WS, TASK)).toHaveLength(0);
    expect(rt.approvalsRepo.listGrants(WS)).toHaveLength(0);
    // The history row records the honest terminal state: the executor's
    // redacted, bounded result summary and the E13 recovery class from the
    // record.
    const rows = rt.tools.listExecutionsByTask(WS, TASK);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.status).toBe("succeeded");
    expect(row.risk_class).toBe("READ_ONLY");
    expect(row.recovery).toBe("needs_human");
    expect(row.approval_id).toBeNull();
    expect(row.grant_id).toBeNull();
    expect(row.result_summary).toContain("Attention Is All You Need");
    expect(row.result_summary).toContain("https://arxiv.org/abs/1706.03762");
    // G3: the arguments surface is the redacted bounded summary, never raw.
    expect(row.args_summary).toContain("transformer");
    expect(row.args_summary.length).toBeLessThanOrEqual(600);
    // The result text itself stays bounded (the tool's response budget).
    expect(outcome.result_summary.length).toBeLessThanOrEqual(65_536);
  });

  it("keeps the search results in the tool's declared order with engines named", async () => {
    const rt = buildRuntime();
    const outcome = searchProposal(rt);
    if (outcome.outcome !== "executed") {
      throw new Error("expected executed");
    }
    const arxivAt = outcome.result_summary.indexOf("Attention Is All You Need");
    const docsAt = outcome.result_summary.indexOf("SearXNG documentation");
    expect(arxivAt).toBeGreaterThanOrEqual(0);
    expect(docsAt).toBeGreaterThan(arxivAt);
    expect(outcome.result_summary).toContain("arxiv");
    expect(outcome.result_summary).toContain("duckduckgo");
  });
});
