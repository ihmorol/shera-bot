import { z } from "zod";

import { RuntimeApiError } from "@/lib/runtime-client";
import type { TerminalExecutionView } from "@/lib/terminal-live";
import { UNREACHABLE_ERROR, typedErrorFromPayload } from "@/lib/typed-error";

/**
 * Typed browser client for the S18 read-only live views (issue #19), reached
 * through the same-origin runtime proxy exactly like the conversation, agent,
 * operation, and workspace clients (the shared transport idiom and typed
 * failures). The routes are the chunk-1/2 GET-only surface on the container's
 * local API:
 *
 *   GET /v1/terminals/events       the durable replay of one Agent's terminal
 *                                  journal stream (cursor-paged, D26)
 *   GET /v1/terminals/state        one Agent's current terminal state
 *                                  (latest execution + recent history)
 *   GET /v1/terminals/:terminal_id one execution's assembled durable record
 *   GET /v1/browser/view           the shared browser's ACTUAL current page
 *   GET /v1/browser/state          the browser's lifecycle + ownership readout
 *
 * There are deliberately NO write paths here: the surface is read-only
 * (G6 — the no-takeover criterion is the route inventory itself, enforced by
 * the contracts allowlist and the runtime's route contract test). Everything
 * this client can parse was redacted before persistence (G3), so no
 * credential-shaped field exists in any response to display or drop.
 *
 * The browser payloads are the chunk-2 service readouts verbatim: the view is
 * a discriminated union on the TRUE lifecycle — a stopped/crashed browser
 * answers with NO image and NO url, never a placeholder (G4).
 */

// ---------------------------------------------------------------------------
// Terminal shapes (mirroring the runtime's TerminalRecord read model)
// ---------------------------------------------------------------------------

export const TerminalApprovalStateSchema = z.enum([
  "not_required",
  "pending",
  "approved",
  "rejected",
]);
export type TerminalApprovalState = z.infer<typeof TerminalApprovalStateSchema>;

const TerminalOutputStreamSchema = z.enum(["stdout", "stderr"]);

export const TerminalOutputChunkSchema = z.strictObject({
  sequence: z.number().int().min(0),
  stream: TerminalOutputStreamSchema,
  text: z.string(),
  recorded_at: z.string().min(1),
});

/** One execution's assembled durable record (GET /v1/terminals/:id). */
export const TerminalRecordSchema = z.strictObject({
  workspace_id: z.string().min(1),
  terminal_id: z.string().min(1),
  agent_id: z.string().min(1),
  session_id: z.string().nullable(),
  command: z.string(),
  workdir: z.string(),
  resource_policy: z.record(z.string(), z.unknown()),
  approval_state: TerminalApprovalStateSchema,
  state: z.enum(["running", "exited"]),
  started_at: z.string().min(1),
  exited_at: z.string().nullable(),
  exit_code: z.number().int().nullable(),
  exit_signal: z.string().nullable(),
  output: z.array(TerminalOutputChunkSchema),
});
export type TerminalRecordView = z.infer<typeof TerminalRecordSchema>;

/**
 * The HTTP record → the WS reducer's shared view shape, so the state route's
 * readers and the live stream render one execution shape (D35 fields
 * verbatim; the record's chunks carry their own storage sequence).
 */
export function terminalExecutionFromRecord(record: TerminalRecordView): TerminalExecutionView {
  return {
    terminalId: record.terminal_id,
    sessionId: record.session_id,
    command: record.command,
    workdir: record.workdir,
    resourcePolicy: record.resource_policy,
    approvalState: record.approval_state,
    status: record.state,
    startedAt: record.started_at,
    exitedAt: record.exited_at,
    exitCode: record.exit_code,
    exitSignal: record.exit_signal,
    chunks: record.output.map((chunk) => ({ stream: chunk.stream, text: chunk.text })),
  };
}

const TerminalStateResponse = z.strictObject({
  agent_id: z.string().min(1),
  current: TerminalRecordSchema.nullable(),
  recent: z.array(TerminalRecordSchema),
});

/** One journal envelope on the terminal stream (the replay page's rows). */
export const TerminalEventEnvelopeSchema = z.strictObject({
  event_id: z.string().min(1),
  sequence: z.number().int().min(0),
  type: z.string().min(1),
  occurred_at: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});
export type TerminalEventEnvelope = z.infer<typeof TerminalEventEnvelopeSchema>;

const TerminalEventsPageSchema = z.strictObject({
  events: z.array(TerminalEventEnvelopeSchema),
  next_after_sequence: z.number().int().min(0),
});

/** The replay page, mapped to the client's camelCase surface. */
export interface TerminalEventsPage {
  events: TerminalEventEnvelope[];
  nextAfterSequence: number;
}

export interface TerminalEventsQuery {
  afterSequence?: number;
  limit?: number;
  terminalId?: string;
}

// ---------------------------------------------------------------------------
// Browser shapes (the chunk-2 service readouts verbatim)
// ---------------------------------------------------------------------------

export const BrowserLifecycleStateSchema = z.enum(["stopped", "starting", "running", "crashed"]);
export type BrowserLifecycleState = z.infer<typeof BrowserLifecycleStateSchema>;

export const BrowserStatePayloadSchema = z.discriminatedUnion("configured", [
  z.strictObject({ configured: z.literal(false), workspace_id: z.string().min(1) }),
  z.strictObject({
    configured: z.literal(true),
    workspace_id: z.string().min(1),
    lifecycle_state: BrowserLifecycleStateSchema,
    owner: z
      .strictObject({
        workspace_id: z.string().min(1),
        owner_id: z.string().min(1),
        claimed_at: z.string().min(1),
      })
      .nullable(),
    idle_timeout_ms: z.number().int().min(0),
    inbound_listen: z.literal("none"),
    profile_dir: z.string().min(1),
    required_capability: z.string().min(1),
  }),
]);
export type BrowserStatePayload = z.infer<typeof BrowserStatePayloadSchema>;

/**
 * The view route's payload, verbatim: a plain union (the unconfigured arm
 * carries NO lifecycle key at all — a discriminated union on `state` cannot
 * express it). The running arm carries the ACTUAL page; every other arm
 * carries NO image and NO url (G4).
 */
export const BrowserViewPayloadSchema = z.union([
  z.strictObject({
    configured: z.literal(true),
    workspace_id: z.string().min(1),
    state: z.literal("running"),
    url: z.string().min(1),
    title: z.string(),
    screenshot_base64: z.string().min(1),
    screenshot_format: z.literal("jpeg"),
    captured_at: z.string().min(1),
  }),
  z.strictObject({
    configured: z.literal(false),
    workspace_id: z.string().min(1),
  }),
  z.strictObject({
    configured: z.literal(true),
    workspace_id: z.string().min(1),
    state: BrowserLifecycleStateSchema.exclude(["running"]),
    captured_at: z.string().min(1),
  }),
]);
export type BrowserViewPayload = z.infer<typeof BrowserViewPayloadSchema>;

// ---------------------------------------------------------------------------
// The panel state union — folding the two browser reads into one view state
// ---------------------------------------------------------------------------

/**
 * What the Browser tab renders. `live` carries the ACTUAL page; every other
 * kind is the honest answer of the lifecycle or the composition (G4).
 */
export type BrowserTabState =
  | { kind: "loading" }
  | { kind: "unconfigured" }
  | { kind: "error"; message: string; retryable: boolean }
  | {
      kind: "live";
      url: string;
      title: string;
      screenshotBase64: string;
      capturedAt: string;
    }
  | { kind: "browser-state"; lifecycle: Exclude<BrowserLifecycleState, "running"> };

/**
 * Fold the view + state readouts into the tab's state union. The view's own
 * lifecycle arm wins (it is captured atomically with the screenshot); before
 * any view read has landed, the state readout's lifecycle fills the same
 * honest answer where it can — the unconfigured composition and the
 * non-running arms carry no image to wait for (G4). A running browser whose
 * first capture is still in flight stays on the loading skeleton.
 */
export function browserTabState(
  view: BrowserViewPayload | null,
  state: BrowserStatePayload | null,
): BrowserTabState {
  if (view === null) {
    if (state?.configured === false) {
      return { kind: "unconfigured" };
    }
    if (state?.configured === true && state.lifecycle_state !== "running") {
      return { kind: "browser-state", lifecycle: state.lifecycle_state };
    }
    return { kind: "loading" };
  }
  if (view.configured === false) {
    return { kind: "unconfigured" };
  }
  if (view.state === "running") {
    return {
      kind: "live",
      url: view.url,
      title: view.title,
      screenshotBase64: view.screenshot_base64,
      capturedAt: view.captured_at,
    };
  }
  return { kind: "browser-state", lifecycle: view.state };
}

// ---------------------------------------------------------------------------
// Transport — the shared runtime idiom (lib/runtime-client.ts)
// ---------------------------------------------------------------------------

async function requestLiveViews<T>(path: string, parse: (payload: unknown) => T): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path);
  } catch {
    throw new RuntimeApiError(UNREACHABLE_ERROR);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw typedErrorFromPayload(payload);
  }
  try {
    return parse(payload);
  } catch (error) {
    if (error instanceof RuntimeApiError) {
      throw error;
    }
    // A 2xx body that fails its contract is a server drift, not user error.
    throw typedErrorFromPayload(null);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function fetchTerminalEvents(
  workspaceId: string,
  agentId: string,
  query: TerminalEventsQuery = {},
): Promise<TerminalEventsPage> {
  const params = new URLSearchParams({
    workspace_id: workspaceId,
    agent_id: agentId,
    after_sequence: String(query.afterSequence ?? 0),
    limit: String(query.limit ?? 200),
  });
  if (query.terminalId !== undefined) {
    params.set("terminal_id", query.terminalId);
  }
  return requestLiveViews(`/api/runtime/v1/terminals/events?${params.toString()}`, (payload) => {
    const parsed = TerminalEventsPageSchema.parse(payload);
    return { events: parsed.events, nextAfterSequence: parsed.next_after_sequence };
  });
}

export function fetchTerminalState(
  workspaceId: string,
  agentId: string,
): Promise<{
  agentId: string;
  current: TerminalExecutionView | null;
  recent: TerminalExecutionView[];
}> {
  // The state route answers `{agent_id, current, recent}` — mapped to the
  // shared execution view shape.
  const params = new URLSearchParams({ workspace_id: workspaceId, agent_id: agentId });
  return requestLiveViews(`/api/runtime/v1/terminals/state?${params.toString()}`, (payload) => {
    const parsed = TerminalStateResponse.parse(payload);
    return {
      agentId: parsed.agent_id,
      current: parsed.current === null ? null : terminalExecutionFromRecord(parsed.current),
      recent: parsed.recent.map(terminalExecutionFromRecord),
    };
  });
}

export function fetchBrowserState(workspaceId: string): Promise<BrowserStatePayload> {
  const params = new URLSearchParams({ workspace_id: workspaceId });
  return requestLiveViews(`/api/runtime/v1/browser/state?${params.toString()}`, (payload) =>
    BrowserStatePayloadSchema.parse(payload),
  );
}

export function fetchBrowserView(workspaceId: string): Promise<BrowserViewPayload> {
  const params = new URLSearchParams({ workspace_id: workspaceId });
  return requestLiveViews(`/api/runtime/v1/browser/view?${params.toString()}`, (payload) =>
    BrowserViewPayloadSchema.parse(payload),
  );
}
