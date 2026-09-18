import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createClient, operations } from "@shera-bot/clients";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const openapiPath = join(repoRoot, "packages", "clients", "openapi.json");
const clientPath = join(repoRoot, "packages", "clients", "src", "generated", "client.ts");

/**
 * D25 rule 10: generated files have one source of truth. The generator
 * (scripts/generate-clients.ts, zod-to-openapi) emits the OpenAPI document and
 * the typed client from the Zod contracts. Reproducibility is enforced by the
 * --check mode: regenerate in memory and compare bytes with the committed
 * output — same input must produce the same output, so CI can run the same
 * check without writing files.
 */
function runGenerator(flags: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, ["scripts/generate-clients.ts", ...flags], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("S02 codegen (D25, zod-to-openapi)", () => {
  it("documents one deterministic command and ships its committed output", () => {
    expect(existsSync(openapiPath)).toBe(true);
    expect(existsSync(clientPath)).toBe(true);
  });

  it("passes --check against the committed output (reproducible: same input, same output)", () => {
    const first = runGenerator(["--check"]);
    expect(first.stderr || first.stdout, "generator diagnostics on failure").toBeDefined();
    expect(first.status, `--check failed: ${first.stderr || first.stdout}`).toBe(0);

    // Running it twice must be equally clean — no hidden nondeterminism.
    const second = runGenerator(["--check"]);
    expect(second.status).toBe(0);
  });

  it("renders every registered contract into the OpenAPI document", () => {
    const doc = JSON.parse(readFileSync(openapiPath, "utf8")) as {
      openapi: string;
      info: { title: string };
      components?: { schemas?: Record<string, unknown> };
      paths?: Record<string, unknown>;
    };

    expect(doc.openapi).toMatch(/^3\.1\./);
    expect(doc.info.title).toContain("Shera Bot");

    const schemas = doc.components?.schemas ?? {};
    for (const name of [
      "Session",
      "Pack",
      "Agent",
      "OperationDefinition",
      "Operation",
      "TaskRun",
      "TypedExecutionEvent",
      "ApprovalRequest",
      "ApprovalGrant",
      "ArtifactRef",
      "CreditReservation",
      "CreditSettlement",
      "CreditRelease",
      "MemoryEntry",
      "ToolDefinition",
      "CollaborationMessage",
      "SheraError",
      "TaskCommand",
    ]) {
      expect(schemas[name], `${name} in OpenAPI components`).toBeDefined();
    }

    expect(Object.keys(doc.paths ?? {}).sort()).toEqual([
      "/v1/tasks/commands",
      "/v1/tasks/{task_id}",
      "/v1/tasks/{task_id}/events",
    ]);
  });

  it("exposes a typed client generated from the same contracts", () => {
    const names = Object.keys(operations).sort();
    expect(names).toEqual(["getTaskRun", "listTaskEvents", "submitTaskCommand"]);

    for (const op of Object.values(operations)) {
      expect(typeof op.method).toBe("string");
      expect(op.path.startsWith("/v1/")).toBe(true);
      expect(typeof op.responseSchema.parse).toBe("function");
    }

    // The client is callable and typed; the fetch seam is injectable so the
    // contract tier can exercise it without a transport.
    let captured = "";
    const client = createClient({
      baseUrl: "http://runtime.invalid",
      fetchImpl: (async (_input: string | URL, init?: RequestInit) => {
        captured = String(init?.method ?? "GET");
        return new Response(
          JSON.stringify({
            outcome: "accepted",
            task_id: "task_001",
            from_state: "RUNNING",
            to_state: "CANCELLING",
            version: 4,
            event_id: "evt_cmd_codegen",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });

    return client
      .submitTaskCommand({
        type: "cancel_task",
        command_id: "cmd_codegen",
        idempotency_key: "idem_codegen",
        workspace_id: "ws_default_01",
        task_id: "task_001",
        actor: { type: "user", id: "user_emon" },
        expected_version: 1,
        issued_at: "2026-09-18T10:00:00.000Z",
      })
      .then((result: unknown) => {
        expect(captured).toBe("POST");
        expect(result).toMatchObject({ outcome: "accepted", task_id: "task_001", version: 4 });
      });
  });
});
