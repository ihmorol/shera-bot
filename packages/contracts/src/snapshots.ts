/**
 * Creation-time snapshots (S10; D19, D28, D29) — the versioned pins a task
 * records about the pack/Operation/Agent configuration it was created with.
 *
 * Own module (not task-run.ts) so the D26 event payloads (events.ts) can
 * embed the same schemas WITHOUT an events.ts ↔ task-run.ts import cycle —
 * task-run.ts consumes the trigger vocabulary from events.ts. task-run.ts
 * re-exports these schemas, so the existing public surface is unchanged.
 *
 * D29 reproducibility: every task stores pack_id, pack_version, pack_hash,
 * operation_id, operation_version, operation_hash, roster, skill_snapshot,
 * connector_snapshot, provider_snapshot. The task.created journal payload is
 * the durable record (D26) — a pack upgrade affects NEW tasks only (D19).
 */
import { z } from "zod";

import { Id, Sha256Hex, SemVer } from "./primitives.ts";

/** Pack pinning per D28: a task keeps the pack version that created it. */
export const PackSnapshot = z.strictObject({
  pack_id: Id,
  pack_version: SemVer,
  pack_hash: Sha256Hex,
});
export type PackSnapshot = z.infer<typeof PackSnapshot>;

/** Operation pinning per D29 (present when the run belongs to an Operation). */
export const OperationSnapshot = z.strictObject({
  operation_id: Id,
  version: SemVer,
  hash: Sha256Hex,
});
export type OperationSnapshot = z.infer<typeof OperationSnapshot>;

/** Provider/model snapshot per D20/D22 (existing tasks keep their snapshot). */
export const ProviderSnapshot = z.strictObject({
  provider_id: Id,
  model: z.string().min(1).max(256),
});
export type ProviderSnapshot = z.infer<typeof ProviderSnapshot>;
