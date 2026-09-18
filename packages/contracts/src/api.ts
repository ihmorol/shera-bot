/**
 * Contract-level HTTP surfaces (D25 lists "http" among contract areas). These
 * are the shapes the runtime gateway's typed local API (D11) will serve in S07;
 * defining them here keeps the generated OpenAPI document and typed clients
 * sourced from the same Zod schemas (D25 rule 10). No transport behavior lives
 * in this package (D23 rule 2).
 */
import { z } from "zod";

import { Id } from "./primitives.ts";
import { TaskCommandResult } from "./task-commands.ts";
import { TaskRun } from "./task-run.ts";
import { TypedExecutionEvent } from "./events.ts";

/** D26: replay from the client's last acknowledged cursor. */
export const ListTaskEventsQuery = z.strictObject({
  /** Opaque replay cursor; absent means "from the beginning of the stream". */
  cursor: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type ListTaskEventsQuery = z.infer<typeof ListTaskEventsQuery>;

export const EventPage = z.strictObject({
  stream_id: Id,
  events: z.array(TypedExecutionEvent).max(500),
  /** Null when the client is fully caught up (D26). */
  next_cursor: z.string().min(1).max(256).nullable(),
});
export type EventPage = z.infer<typeof EventPage>;

export const SUBMIT_TASK_COMMAND_PATH = "/v1/tasks/commands" as const;
export const GET_TASK_RUN_PATH = "/v1/tasks/{task_id}" as const;
export const LIST_TASK_EVENTS_PATH = "/v1/tasks/{task_id}/events" as const;

export const SUBMIT_TASK_COMMAND_RESPONSE = TaskCommandResult;
export const GET_TASK_RUN_RESPONSE = TaskRun;
export const LIST_TASK_EVENTS_RESPONSE = EventPage;
