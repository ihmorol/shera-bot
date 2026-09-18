/**
 * S02 codegen (D25 rule 10: generated files have one source of truth).
 *
 * ONE documented command regenerates the OpenAPI document and the typed client
 * from the Zod contracts in packages/contracts (zod-to-openapi, MIT):
 *
 *     pnpm gen:clients            # regenerate packages/clients output
 *     pnpm gen:clients -- --check # compare against committed output, exit 1 on drift
 *
 * Reproducible by construction: the same contract input produces byte-identical
 * output (sorted schema registration, stable JSON indentation), so the
 * contract-tier test runs `--check` as the CI-comparable gate. Never edit the
 * generated files by hand.
 *
 * Run with plain Node (type stripping): node scripts/generate-clients.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

// zod v4 copies prototype methods onto schema instances at construction, so
// the OpenAPI extension MUST be applied before the contracts module builds its
// schemas — hence the dynamic import below, not a static one.
extendZodWithOpenApi(z);

const contracts = await import("../packages/contracts/src/index.ts");
const {
  GET_TASK_RUN_PATH,
  GET_TASK_RUN_RESPONSE,
  LIST_TASK_EVENTS_PATH,
  LIST_TASK_EVENTS_RESPONSE,
  ListTaskEventsQuery,
  SUBMIT_TASK_COMMAND_PATH,
  SUBMIT_TASK_COMMAND_RESPONSE,
  TaskCommand,
  CONTRACT_REGISTRY,
} = contracts;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const openapiOutPath = join(repoRoot, "packages", "clients", "openapi.json");
const clientOutPath = join(repoRoot, "packages", "clients", "src", "generated", "client.ts");

/**
 * The typed-client operation list. This same list drives the OpenAPI path
 * registration below — one source of truth for both artifacts.
 */
const OPERATIONS = [
  {
    name: "submitTaskCommand",
    method: "post" as const,
    path: SUBMIT_TASK_COMMAND_PATH,
    description:
      "Submit a task command to the runtime gateway (typed, idempotent, version-checked).",
    requestSchema: TaskCommand,
    requestTypeName: "SubmitTaskCommandRequest",
    responseSchema: SUBMIT_TASK_COMMAND_RESPONSE,
    responseTypeName: "SubmitTaskCommandResponse",
  },
  {
    name: "getTaskRun",
    method: "get" as const,
    path: GET_TASK_RUN_PATH,
    description: "Fetch the current-state projection of one task run (D5).",
    responseSchema: GET_TASK_RUN_RESPONSE,
    responseTypeName: "GetTaskRunResponse",
  },
  {
    name: "listTaskEvents",
    method: "get" as const,
    path: LIST_TASK_EVENTS_PATH,
    description: "Replay the durable event stream of one task run from a cursor (D26).",
    querySchema: ListTaskEventsQuery,
    responseSchema: LIST_TASK_EVENTS_RESPONSE,
    responseTypeName: "ListTaskEventsResponse",
  },
];

// Sorted registration keeps the generated document byte-stable across runs.
const SCHEMA_NAMES = Object.keys(CONTRACT_REGISTRY).sort();

function buildOpenApiDocument(): string {
  const registry = new OpenAPIRegistry();

  for (const name of SCHEMA_NAMES) {
    registry.register(name, CONTRACT_REGISTRY[name as keyof typeof CONTRACT_REGISTRY]);
  }

  for (const operation of OPERATIONS) {
    const pathItem: Record<string, unknown> = {
      operationId: operation.name,
      description: operation.description,
      responses: {
        200: {
          description: "Contract-valid response.",
          content: { "application/json": { schema: operation.responseSchema } },
        },
      },
    };
    if ("requestSchema" in operation) {
      pathItem["requestBody"] = {
        required: true,
        content: { "application/json": { schema: operation.requestSchema } },
      };
    }
    if ("querySchema" in operation) {
      pathItem["request"] = { query: operation.querySchema };
    }
    registry.registerPath({
      method: operation.method,
      path: operation.path,
      ...pathItem,
    } as Parameters<typeof registry.registerPath>[0]);
  }

  // OpenAPI 3.1: the JSON Schema values on tool/error contracts are
  // self-referential (z.json()), which only the 3.1 generator renders
  // without unbounded recursion.
  const generator = new OpenApiGeneratorV31(registry.definitions);
  const document = generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Shera Bot runtime contracts",
      version: "0.2.0",
      description:
        "Generated from the Zod contracts in packages/contracts (D25). Do not edit by hand.",
    },
    servers: [{ url: "http://runtime.local", description: "Runtime gateway local API (D11)" }],
  });

  return `${JSON.stringify(document, null, 2)}\n`;
}

function renderClient(): string {
  const lines: string[] = [];
  lines.push("/**");
  lines.push(" * GENERATED FILE — do not edit. Regenerate with `pnpm gen:clients` (repo root).");
  lines.push(" * Source of truth: the Zod contracts in packages/contracts (D25 rule 10).");
  lines.push(" */");
  lines.push('import { z } from "zod";');
  lines.push("import {");
  lines.push("  TaskCommand,");
  lines.push("  TaskCommandResult,");
  lines.push("  TaskRun,");
  lines.push("  EventPage,");
  lines.push("  ListTaskEventsQuery,");
  lines.push('} from "@shera-bot/contracts";');
  lines.push("");
  lines.push("export const operations = {");
  for (const operation of OPERATIONS) {
    const schemaFields: string[] = [
      `method: ${JSON.stringify(operation.method.toUpperCase())}`,
      `path: ${JSON.stringify(operation.path)}`,
      `responseSchema: ${responseSchemaBinding(operation.name)}`,
    ];
    if ("requestSchema" in operation) schemaFields.push(`requestSchema: TaskCommand`);
    if ("querySchema" in operation) schemaFields.push(`querySchema: ListTaskEventsQuery`);
    lines.push(`  ${operation.name}: {`);
    for (const field of schemaFields) {
      lines.push(`    ${field},`);
    }
    lines.push("  },");
  }
  lines.push("} as const;");
  lines.push("");
  lines.push("export type OperationName = keyof typeof operations;");
  lines.push("");
  lines.push("// Types are inferred from the same Zod schemas — no hand-written duplicates (D25).");
  lines.push("export type SubmitTaskCommandRequest = z.infer<typeof TaskCommand>;");
  lines.push("export type SubmitTaskCommandResponse = z.infer<typeof TaskCommandResult>;");
  lines.push("export type GetTaskRunResponse = z.infer<typeof TaskRun>;");
  lines.push("export type ListTaskEventsResponse = z.infer<typeof EventPage>;");
  lines.push("");
  lines.push("export interface ClientOptions {");
  lines.push("  baseUrl: string;");
  lines.push("  /** Injectable fetch seam so contract tests need no transport (E8). */");
  lines.push("  fetchImpl?: typeof fetch;");
  lines.push("}");
  lines.push("");
  lines.push(
    "async function parseResponse<T>(schema: { parse(input: unknown): T }, response: Response): Promise<T> {",
  );
  lines.push("  const body: unknown = await response.json();");
  lines.push("  return schema.parse(body);");
  lines.push("}");
  lines.push("");
  lines.push("function joinPath(path: string, params: Record<string, string>): string {");
  lines.push(
    '  return path.replace(/\\{([a-z_]+)\\}/g, (_match, name: string) => encodeURIComponent(params[name] ?? ""));',
  );
  lines.push("}");
  lines.push("");
  lines.push("function toQuery(query: Record<string, string | number | undefined>): string {");
  lines.push("  const params = new URLSearchParams();");
  lines.push("  for (const [key, value] of Object.entries(query)) {");
  lines.push("    if (value !== undefined) params.set(key, String(value));");
  lines.push("  }");
  lines.push("  const encoded = params.toString();");
  lines.push('  return encoded ? `?${encoded}` : "";');
  lines.push("}");
  lines.push("");
  lines.push("export function createClient(options: ClientOptions) {");
  lines.push("  const doFetch = options.fetchImpl ?? fetch;");
  lines.push('  const base = options.baseUrl.replace(/\\/$/, "");');
  lines.push("  return {");
  lines.push(
    "    async submitTaskCommand(command: SubmitTaskCommandRequest): Promise<SubmitTaskCommandResponse> {",
  );
  lines.push(
    "      const response = await doFetch(`${base}${joinPath(operations.submitTaskCommand.path, {})}`, {",
  );
  lines.push('        method: "POST",');
  lines.push('        headers: { "content-type": "application/json" },');
  lines.push("        body: JSON.stringify(command),");
  lines.push("      });");
  lines.push("      return parseResponse(operations.submitTaskCommand.responseSchema, response);");
  lines.push("    },");
  lines.push("    async getTaskRun(taskId: string): Promise<GetTaskRunResponse> {");
  lines.push(
    "      const response = await doFetch(`${base}${joinPath(operations.getTaskRun.path, { task_id: taskId })}`);",
  );
  lines.push("      return parseResponse(operations.getTaskRun.responseSchema, response);");
  lines.push("    },");
  lines.push(
    "    async listTaskEvents(taskId: string, query: ListTaskEventsQuery = {}): Promise<ListTaskEventsResponse> {",
  );
  lines.push("      const qs = toQuery({ cursor: query.cursor, limit: query.limit });");
  lines.push(
    "      const response = await doFetch(`${base}${joinPath(operations.listTaskEvents.path, { task_id: taskId })}${qs}`);",
  );
  lines.push("      return parseResponse(operations.listTaskEvents.responseSchema, response);");
  lines.push("    },");
  lines.push("  };");
  lines.push("}");
  lines.push("");
  return lines.join("\n");

  function responseSchemaBinding(name: string): string {
    switch (name) {
      case "submitTaskCommand":
        return "TaskCommandResult";
      case "getTaskRun":
        return "TaskRun";
      case "listTaskEvents":
        return "EventPage";
      default:
        throw new Error(`unmapped response schema for operation ${name}`);
    }
  }
}

function main(): number {
  if (process.argv.includes("--check")) {
    const openapi = buildOpenApiDocument();
    const client = renderClient();
    const committedOpenapi = readFileSync(openapiOutPath, "utf8");
    const committedClient = readFileSync(clientOutPath, "utf8");
    let drifted = false;
    if (openapi !== committedOpenapi) {
      drifted = true;
      console.error(`DRIFT: ${openapiOutPath} differs from the generated output.`);
    }
    if (client !== committedClient) {
      drifted = true;
      console.error(`DRIFT: ${clientOutPath} differs from the generated output.`);
    }
    if (drifted) {
      console.error("Run `pnpm gen:clients` and commit the regenerated files.");
      return 1;
    }
    console.log("generated clients are up to date");
    return 0;
  }

  mkdirSync(dirname(clientOutPath), { recursive: true });
  writeFileSync(openapiOutPath, buildOpenApiDocument());
  writeFileSync(clientOutPath, renderClient());
  console.log(`wrote ${openapiOutPath}`);
  console.log(`wrote ${clientOutPath}`);
  return 0;
}

process.exit(main());
