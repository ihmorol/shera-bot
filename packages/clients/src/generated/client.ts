/**
 * GENERATED FILE — do not edit. Regenerate with `pnpm gen:clients` (repo root).
 * Source of truth: the Zod contracts in packages/contracts (D25 rule 10).
 */
import { z } from "zod";
import {
  TaskCommand,
  TaskCommandResult,
  TaskRun,
  EventPage,
  ListTaskEventsQuery,
} from "@shera-bot/contracts";

export const operations = {
  submitTaskCommand: {
    method: "POST",
    path: "/v1/tasks/commands",
    responseSchema: TaskCommandResult,
    requestSchema: TaskCommand,
  },
  getTaskRun: {
    method: "GET",
    path: "/v1/tasks/{task_id}",
    responseSchema: TaskRun,
  },
  listTaskEvents: {
    method: "GET",
    path: "/v1/tasks/{task_id}/events",
    responseSchema: EventPage,
    querySchema: ListTaskEventsQuery,
  },
} as const;

export type OperationName = keyof typeof operations;

// Types are inferred from the same Zod schemas — no hand-written duplicates (D25).
export type SubmitTaskCommandRequest = z.infer<typeof TaskCommand>;
export type SubmitTaskCommandResponse = z.infer<typeof TaskCommandResult>;
export type GetTaskRunResponse = z.infer<typeof TaskRun>;
export type ListTaskEventsResponse = z.infer<typeof EventPage>;

export interface ClientOptions {
  baseUrl: string;
  /** Injectable fetch seam so contract tests need no transport (E8). */
  fetchImpl?: typeof fetch;
}

async function parseResponse<T>(schema: { parse(input: unknown): T }, response: Response): Promise<T> {
  const body: unknown = await response.json();
  return schema.parse(body);
}

function joinPath(path: string, params: Record<string, string>): string {
  return path.replace(/\{([a-z_]+)\}/g, (_match, name: string) => encodeURIComponent(params[name] ?? ""));
}

function toQuery(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export function createClient(options: ClientOptions) {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/$/, "");
  return {
    async submitTaskCommand(command: SubmitTaskCommandRequest): Promise<SubmitTaskCommandResponse> {
      const response = await doFetch(`${base}${joinPath(operations.submitTaskCommand.path, {})}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      return parseResponse(operations.submitTaskCommand.responseSchema, response);
    },
    async getTaskRun(taskId: string): Promise<GetTaskRunResponse> {
      const response = await doFetch(`${base}${joinPath(operations.getTaskRun.path, { task_id: taskId })}`);
      return parseResponse(operations.getTaskRun.responseSchema, response);
    },
    async listTaskEvents(taskId: string, query: ListTaskEventsQuery = {}): Promise<ListTaskEventsResponse> {
      const qs = toQuery({ cursor: query.cursor, limit: query.limit });
      const response = await doFetch(`${base}${joinPath(operations.listTaskEvents.path, { task_id: taskId })}${qs}`);
      return parseResponse(operations.listTaskEvents.responseSchema, response);
    },
  };
}
