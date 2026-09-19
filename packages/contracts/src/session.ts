/**
 * Session contract (S02 #1): Google OAuth identity, resource tier, and the
 * workspace scope (E12). The control plane owns account identity (D2); this
 * schema is the shared shape for that record's session/account projection.
 */
import { z } from "zod";

import { IsoDateTime, ResourceTier, WorkspaceId } from "./primitives.ts";

export const Session = z.strictObject({
  workspace_id: WorkspaceId,
  /** Google OAuth subject identifier (stable across the account's lifetime). */
  google_sub: z.string().min(1).max(256),
  email: z.email().max(320),
  display_name: z.string().min(1).max(200),
  avatar_url: z.url().max(2048).optional(),
  /** PRD §3.2: tiers are simulated; balanced is the prototype default. */
  tier: ResourceTier,
  /** PRD §3.2: administrator status is a manually managed database flag. */
  is_admin: z.boolean(),
  created_at: IsoDateTime,
  last_active_at: IsoDateTime,
});
export type Session = z.infer<typeof Session>;
