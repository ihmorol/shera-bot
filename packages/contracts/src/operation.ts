/**
 * Operation contracts (S02 #4): the reusable OperationDefinition template and
 * the persistent Operation workspace/chat instance (D31, D41, D42, D49).
 *
 * - OperationDefinition — a versioned collaboration template in a Pack.
 * - Operation — a persistent user-visible collaborative chat created from a
 *   definition or ad hoc; holds multiple independently tracked task runs.
 */
import { z } from "zod";

import { Id, IsoDateTime, Sha256Hex, SemVer, WorkspaceId } from "./primitives.ts";

export const OperationDefinition = z.strictObject({
  operation_id: Id,
  version: SemVer,
  title: z.string().min(1).max(200),
  purpose: z.string().min(1).max(2000),
  /** Agents that participate; each specialist belongs to exactly one (D46). */
  roster: z.array(Id).min(1).max(50),
  /**
   * D42: `coordinator` names a coordinator Agent or "none". Absent means the
   * pack default coordinator (the General Assistant) coordinates. The
   * coordinator role is not a roster assignment (D46).
   */
  coordinator: z.union([Id, z.literal("none")]).optional(),
  skills: z.array(Id).max(200),
  connectors: z.array(Id).max(100),
  /** Content hash of the definition, recorded by the pack loader (D28/D29). */
  content_hash: Sha256Hex,
});
export type OperationDefinition = z.infer<typeof OperationDefinition>;

export const OPERATION_STATUSES = ["active", "archived"] as const;

/** The persistent Operation workspace/chat instance (D31, D41). */
export const Operation = z.strictObject({
  /** Instance id of the Operation chat (the definition id is in `definition`). */
  operation_id: Id,
  workspace_id: WorkspaceId,
  /** The Operation chat is a conversation; task runs hang off it (D31). */
  conversation_id: Id,
  /** Template reference with version pinning (D29: ad-hoc Operations omit this). */
  definition: z
    .strictObject({
      operation_id: Id,
      version: SemVer,
      hash: Sha256Hex,
    })
    .nullable(),
  title: z.string().min(1).max(200),
  /** Current roster; user-controlled, runtime-validated (D36). */
  roster: z.array(Id).min(1).max(50),
  /**
   * Current coordinator: an agent id, or null after removal (D49 — removal is
   * allowed at any time; work continues peer-to-peer through D7).
   */
  coordinator: Id.nullable(),
  status: z.enum(OPERATION_STATUSES),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type Operation = z.infer<typeof Operation>;
