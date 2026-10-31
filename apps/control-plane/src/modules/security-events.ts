/**
 * Security events service (D2: "operational security events required by the
 * control plane"; PRD §15, §22.18). Append-only writes; details are always
 * scrubbed through the secret registry before insert (G3). Recording must
 * never break the auth flow — failures are logged, never thrown.
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray } from "drizzle-orm";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { controlSecurityEvents } from "../db/schema.ts";
import { scrubObject, type SecretRegistry } from "../redaction.ts";
import type { ControlPlaneLogger } from "../logger.ts";

export const SECURITY_EVENT_TYPES = [
  "login_succeeded",
  "logout",
  "signup_cap_refused",
  "admin_flag_changed",
  "session_validation_failed",
  // S06 (runtime provisioning + internal channel; D2, PRD §16).
  "runtime_provisioned",
  "runtime_provision_failed",
  "runtime_operation_failed",
  "runtime_channel_auth_failed",
  "runtime_channel_token_rotated",
  // S32 (admin API/CLI; D47, PRD §15 "security-relevant actions are logged").
  "admin_token_created",
  "admin_token_rotated",
  "admin_auth_rejected",
  "admin_action",
  "admin_action_failed",
] as const;

export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

export interface SecurityEventInput {
  eventType: SecurityEventType;
  accountId?: string | null;
  details?: Record<string, unknown>;
  correlationId?: string | undefined;
  redactionClass?: "public" | "internal" | "restricted";
}

export class SecurityEventService {
  constructor(
    private readonly db: NodePgDatabase,
    private readonly registry: SecretRegistry,
    private readonly logger: ControlPlaneLogger,
  ) {}

  async record(input: SecurityEventInput): Promise<void> {
    try {
      const details = scrubObject(input.details ?? {}, this.registry);
      await this.db.insert(controlSecurityEvents).values({
        eventType: input.eventType,
        accountId: input.accountId ?? null,
        redactionClass: input.redactionClass ?? "internal",
        details,
        correlationId: input.correlationId ?? randomUUID(),
      });
    } catch (error) {
      // Recording must never break the flow it is auditing (G5: surfaced, not
      // silent — the failure is logged, redacted, and observable).
      this.logger.error("security_event_write_failed", {
        event_type: input.eventType,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * S32 (PRD §15 failures view): the account's recent events of the given
   * types, newest first, bounded. Read-only; the redaction guarantee is the
   * write-time one (details were scrubbed before insert).
   */
  async listForAccount(
    accountId: string,
    eventTypes: readonly string[],
    limit: number,
  ): Promise<
    Array<{
      id: string;
      eventType: string;
      accountId: string | null;
      details: Record<string, unknown>;
      occurredAt: Date;
    }>
  > {
    const rows = await this.db
      .select()
      .from(controlSecurityEvents)
      .where(
        and(
          eq(controlSecurityEvents.accountId, accountId),
          inArray(controlSecurityEvents.eventType, [...eventTypes]),
        ),
      )
      .orderBy(desc(controlSecurityEvents.occurredAt))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      eventType: row.eventType,
      accountId: row.accountId,
      details: row.details,
      occurredAt: row.occurredAt,
    }));
  }

  async listByType(eventType: SecurityEventType): Promise<
    Array<{
      id: string;
      eventType: string;
      accountId: string | null;
      details: Record<string, unknown>;
      occurredAt: Date;
    }>
  > {
    const rows = await this.db
      .select()
      .from(controlSecurityEvents)
      .where(eq(controlSecurityEvents.eventType, eventType));
    return rows.map((row) => ({
      id: row.id,
      eventType: row.eventType,
      accountId: row.accountId,
      details: row.details,
      occurredAt: row.occurredAt,
    }));
  }
}
