/**
 * Security-event recording for the internal channel (S06; PRD §16 "rejected
 * requests are recorded"; D2 "operational security events").
 *
 * Prototype posture: the runtime gateway keeps an in-memory, bounded,
 * structured record; S07 moves it onto the container-local SQLite journal
 * when persistence lands. Entries carry the rejection reason and path only —
 * never credential material, never request bodies (G3).
 */

export const INTERNAL_CHANNEL_EVENT_TYPES = [
  "internal_channel_rejected",
  // S32: an authenticated channel request that named another runtime's
  // workspace (the tenant check refused the admin command before execution).
  "internal_admin_command_refused",
] as const;

export type InternalChannelEventType = (typeof INTERNAL_CHANNEL_EVENT_TYPES)[number];

export interface InternalChannelSecurityEvent {
  event: InternalChannelEventType;
  /** Bounded reason vocabulary; admin-command refusals name their reason. */
  reason:
    "missing_bearer" | "malformed_bearer" | "invalid_credential" | "workspace_tenant_mismatch";
  path: string;
  occurred_at: string;
}

export interface InternalSecurityEventRecorder {
  record(event: InternalChannelSecurityEvent): void;
}

const MAX_RECORDED_EVENTS = 1000;

/** Bounded in-memory recorder; the S07 SQLite journal subsumes this. */
export class InMemorySecurityEventRecorder implements InternalSecurityEventRecorder {
  private readonly events: InternalChannelSecurityEvent[] = [];

  record(event: InternalChannelSecurityEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_RECORDED_EVENTS) {
      this.events.shift();
    }
  }

  list(event: InternalChannelEventType): InternalChannelSecurityEvent[] {
    return this.events.filter((entry) => entry.event === event);
  }

  get size(): number {
    return this.events.length;
  }
}
