/**
 * S28 chunk 6 — the schedules HTTP surface (issue #29; PRD §8, E5, G2, G3).
 *
 * Every trigger route is workspace-scoped (E12) and typed: the create/edit
 * bodies carry the per-kind configuration the SCHEDULES SERVICE validates
 * against its Zod schemas — a prose-only body is a typed validation
 * refusal, never a trigger and never a run (G2). Pause/resume are the AC10
 * user controls; resume clears a D48 credit pause too (the operator top-up
 * seam flows through the same route family).
 *
 * The webhook receiver (`POST /v1/webhooks/:trigger_id`) is a plain Express
 * route (the recorded transport): the optional shared secret is
 * digest-compared in constant time (the plaintext exists only in the
 * request frame — G3), the dedup key is the delivery-id header or the body
 * digest (D23 rule 6 — the key is DATA), and the delivery body NEVER enters
 * the journal, the ledger, or a log: only the bounded derived summary the
 * typed payload carries. A duplicate delivery answers 200 `deduplicated`
 * (webhook receivers acknowledge replays; exactly one run exists — AC2).
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import type { Express } from "express";
import { z } from "zod";

import { WorkspaceId } from "@shera-bot/contracts";

import type {
  SchedulesService,
  SchedulesServiceError,
} from "../../modules/schedules/schedules.service.ts";
import type { SchedulerService } from "../../modules/schedules/scheduler.service.ts";
import type { TriggerRecordRow, TriggersRepository } from "../../adapters/sqlite/triggers-repository.ts";

export const LIST_SCHEDULES_PATH = "/v1/schedules" as const;
export const CREATE_SCHEDULE_PATH = "/v1/schedules" as const;
export const SCHEDULE_TRIGGER_PATH = "/v1/schedules/:trigger_id" as const;
export const SCHEDULE_PAUSE_PATH = "/v1/schedules/:trigger_id/pause" as const;
export const SCHEDULE_RESUME_PATH = "/v1/schedules/:trigger_id/resume" as const;
export const SCHEDULE_FIRINGS_PATH = "/v1/schedules/:trigger_id/firings" as const;
export const WEBHOOK_RECEIVER_PATH = "/v1/webhooks/:trigger_id" as const;

export interface SchedulesApiHandle {
  schedules: SchedulesService;
  scheduler: SchedulerService;
  triggers: TriggersRepository;
  /** E12: the container's workspace. */
  workspaceId: string;
  /** The wake manager's re-sync after create/pause/resume/edit. */
  onTriggerMutation?: (() => void) | undefined;
}

const WorkspaceQuery = z.strictObject({ workspace_id: WorkspaceId });

const ActorBody = z.strictObject({ type: z.string().min(1).max(32), id: z.string().min(1).max(256) });

const CreateTriggerBody = z.strictObject({
  workspace_id: WorkspaceId,
  kind: z.enum([
    "schedule",
    "file_watch",
    "git_watch",
    "webhook",
    "task_completion",
    "condition",
    "external_event",
  ]),
  name: z.string().min(1).max(200),
  target_operation_id: z.string().min(1).max(256),
  config: z.record(z.string(), z.unknown()),
  catch_up_policy: z.enum(["catch_up", "skip"]),
  actor: ActorBody,
});

const EditTriggerBody = z.strictObject({
  workspace_id: WorkspaceId,
  name: z.string().min(1).max(200).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  catch_up_policy: z.enum(["catch_up", "skip"]).optional(),
  actor: ActorBody,
});

const TriggerMutationBody = z.strictObject({
  workspace_id: WorkspaceId,
  actor: ActorBody,
});

/** The delivery's bounded, content-free summary (G3 — the body itself never
 * leaves the request frame). */
function deliverySummary(contentType: string | undefined, byteLength: number): string {
  const type = typeof contentType === "string" ? contentType.split(";", 1)[0] ?? "unknown" : "unknown";
  return `${type} ${byteLength}b delivery`;
}

function errorResponse(
  status: number,
  code: string,
  message: string,
): { status: number; body: Record<string, unknown> } {
  return {
    status,
    body: {
      code,
      category: status === 404 ? "state" : status === 401 ? "security" : "validation",
      safe_message: message,
      retryable: false,
      user_action: null,
      internal_details: null,
      correlation_id: randomUUID(),
    },
  };
}

function validationResponse(message: string): { status: number; body: Record<string, unknown> } {
  return errorResponse(400, "CONTRACT_VALIDATION_FAILED", message);
}

function schedulesErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } | null {
  const code = (error as { code?: string } | null)?.code;
  if (typeof code !== "string") return null;
  if (code === "TRIGGER_NOT_FOUND" || code === "TRIGGER_TARGET_OPERATION_NOT_FOUND") {
    return errorResponse(404, code, "That trigger or target does not exist in this workspace.");
  }
  if (code === "TRIGGER_ALREADY_EXISTS") {
    return errorResponse(409, code, "That trigger id already exists in this workspace.");
  }
  if (code === "SCHEDULE_CRON_INVALID" || code === "TRIGGER_CONFIG_INVALID") {
    return errorResponse(400, code, "The trigger configuration is not valid. Check the fields and try again.");
  }
  return null;
}

/** Register the schedules routes on the local API. */
export function registerSchedulesRoutes(app: Express, deps: SchedulesApiHandle): void {
  const afterMutation = (): void => {
    try {
      deps.onTriggerMutation?.();
    } catch {
      // A wake-manager sync failure never breaks the route (contained).
    }
  };

  // GET /v1/schedules — the truthful list (AC9).
  app.get(LIST_SCHEDULES_PATH, (req, res) => {
    const query = WorkspaceQuery.safeParse(req.query);
    if (!query.success) {
      const mapped = validationResponse("The schedules request is not valid: a workspace_id is required.");
      res.status(mapped.status).json(mapped.body);
      return;
    }
    res.status(200).json({ triggers: deps.schedules.listTriggers(query.data.workspace_id) });
  });

  // POST /v1/schedules — the typed create (G2: the service owns the
  // per-kind validation; a prose-only body dies here).
  app.post(CREATE_SCHEDULE_PATH, (req, res) => {
    const parsed = CreateTriggerBody.safeParse(req.body);
    if (!parsed.success) {
      const mapped = validationResponse(
        "The trigger request is not valid: kind, name, target operation, and the kind's typed configuration are required.",
      );
      res.status(mapped.status).json(mapped.body);
      return;
    }
    try {
      const created = deps.schedules.createTrigger(parsed.data.workspace_id, {
        kind: parsed.data.kind,
        name: parsed.data.name,
        target_operation_id: parsed.data.target_operation_id,
        config: parsed.data.config as never,
        catch_up_policy: parsed.data.catch_up_policy,
        actor: parsed.data.actor,
      });
      afterMutation();
      res.status(201).json(created);
    } catch (error) {
      const mapped = schedulesErrorResponse(error);
      if (mapped) {
        res.status(mapped.status).json(mapped.body);
        return;
      }
      throw error;
    }
  });

  // PATCH /v1/schedules/:trigger_id — the AC10 edit.
  app.patch(SCHEDULE_TRIGGER_PATH, (req, res) => {
    const parsed = EditTriggerBody.safeParse(req.body);
    if (!parsed.success) {
      const mapped = validationResponse("The trigger edit is not valid.");
      res.status(mapped.status).json(mapped.body);
      return;
    }
    try {
      const edited = deps.schedules.editTrigger(parsed.data.workspace_id, req.params.trigger_id, {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.config !== undefined ? { config: parsed.data.config as never } : {}),
        ...(parsed.data.catch_up_policy !== undefined
          ? { catch_up_policy: parsed.data.catch_up_policy }
          : {}),
        actor: parsed.data.actor,
      });
      afterMutation();
      res.status(200).json(edited);
    } catch (error) {
      const mapped = schedulesErrorResponse(error);
      if (mapped) {
        res.status(mapped.status).json(mapped.body);
        return;
      }
      throw error;
    }
  });

  // POST .../pause and .../resume — the AC10 controls (resume is also the
  // operator's after-top-up seam for a D48 credit pause).
  for (const [path, action] of [
    [SCHEDULE_PAUSE_PATH, "pauseTrigger"],
    [SCHEDULE_RESUME_PATH, "resumeTrigger"],
  ] as const) {
    app.post(path, (req, res) => {
      const parsed = TriggerMutationBody.safeParse(req.body);
      if (!parsed.success) {
        const mapped = validationResponse("The trigger mutation is not valid: a workspace_id is required.");
        res.status(mapped.status).json(mapped.body);
        return;
      }
      try {
        deps.schedules[action](parsed.data.workspace_id, req.params.trigger_id, parsed.data.actor);
        afterMutation();
        res.status(200).json({ trigger_id: req.params.trigger_id, state: action === "pauseTrigger" ? "paused" : "active" });
      } catch (error) {
        const mapped = schedulesErrorResponse(error);
        if (mapped) {
          res.status(mapped.status).json(mapped.body);
          return;
        }
        throw error;
      }
    });
  }

  // GET .../firings — the recent ledger rows (the run cards' data source).
  app.get(SCHEDULE_FIRINGS_PATH, (req, res) => {
    const query = WorkspaceQuery.safeParse(req.query);
    if (!query.success) {
      const mapped = validationResponse("A workspace_id is required.");
      res.status(mapped.status).json(mapped.body);
      return;
    }
    const view = deps.schedules.getTriggerView(query.data.workspace_id, req.params.trigger_id);
    if (view === null) {
      const mapped = errorResponse(404, "TRIGGER_NOT_FOUND", "That trigger does not exist in this workspace.");
      res.status(mapped.status).json(mapped.body);
      return;
    }
    res.status(200).json({ firings: view.recent_firings });
  });

  // POST /v1/webhooks/:trigger_id — the receiver (AC2).
  app.post(WEBHOOK_RECEIVER_PATH, (req, res) => {
    const triggerId = req.params.trigger_id;
    const trigger: TriggerRecordRow | null = deps.triggers.getTrigger(deps.workspaceId, triggerId);
    if (trigger === null) {
      const mapped = errorResponse(404, "TRIGGER_NOT_FOUND", "No such webhook endpoint.");
      res.status(mapped.status).json(mapped.body);
      return;
    }
    if (trigger.kind !== "webhook" && trigger.kind !== "external_event") {
      const mapped = errorResponse(409, "TRIGGER_KIND_MISMATCH", "This endpoint does not accept deliveries.");
      res.status(mapped.status).json(mapped.body);
      return;
    }
    // The digest-compared shared secret (G3: the plaintext exists only in
    // the request frame; the constant-time compare never leaks timing).
    const config = JSON.parse(trigger.config_json) as { secret_digest?: string };
    if (config.secret_digest !== undefined) {
      const presented = req.headers["x-shera-secret"];
      const presentedDigest = createHash("sha256")
        .update(typeof presented === "string" ? presented : "")
        .digest();
      const storedDigest = Buffer.from(config.secret_digest.slice("sha256:".length), "hex");
      const matches =
        presentedDigest.length === storedDigest.length && timingSafeEqual(presentedDigest, storedDigest);
      if (!matches) {
        const mapped = errorResponse(401, "WEBHOOK_SECRET_MISMATCH", "The delivery's secret did not match.");
        res.status(mapped.status).json(mapped.body);
        return;
      }
    }
    // The dedup key: the delivery id header, else the digest of the parsed
    // body's stable encoding (D23 rule 6 — the key is DATA). The delivery
    // CONTENT never persists: the fired payload carries the bounded,
    // content-free summary only (G3). (express.json has already consumed
    // and bounded the stream — the 64 kb cap is the transport bound.)
    const encodedBody = JSON.stringify(req.body ?? null) ?? "";
    const bodyDigest = `sha256:${createHash("sha256").update(encodedBody).digest("hex")}`;
    const headerDelivery = req.headers["x-shera-delivery-id"];
    const deliveryKey =
      typeof headerDelivery === "string" && headerDelivery.length >= 1 && headerDelivery.length <= 200
        ? `delivery:${headerDelivery}`
        : `digest:${bodyDigest}`;
    const source =
      trigger.kind === "external_event" && typeof req.headers["x-shera-source"] === "string"
        ? String(req.headers["x-shera-source"]).slice(0, 128)
        : undefined;
    const outcome = deps.scheduler.fireOccurrence(deps.workspaceId, triggerId, {
      idempotencyKey: `${trigger.kind}:${triggerId}:${deliveryKey}`,
      dueAt: new Date().toISOString(),
      detail: {
        body_summary: deliverySummary(
          typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : undefined,
          Buffer.byteLength(encodedBody, "utf8"),
        ),
        delivery_digest: bodyDigest,
        occurred_at: new Date().toISOString(),
        ...(source !== undefined ? { source } : {}),
      },
    });
    res.status(200).json(
      outcome.outcome === "fired"
        ? { status: "fired", run_id: outcome.runId }
        : {
            status: outcome.outcome,
            ...(outcome.outcome === "refused_provider" ? { code: outcome.code } : {}),
          },
    );
  });
}

export type { SchedulesServiceError };
