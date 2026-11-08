/**
 * S30 — the notification center's durable state (PRD §14, D16, E3). The
 * center's ROWS are derived from the runtime's own records; this repository
 * owns the two v24 tables: the per-workspace delivery toggles and the
 * per-notification read/mute stamps. Every method is workspace-scoped (E12).
 */
import type { DatabaseSync } from "node:sqlite";

import type { SqliteTransactions } from "./transactions.ts";

export interface NotificationSettingsRow {
  workspace_id: string;
  in_app_enabled: boolean;
  browser_enabled: boolean;
  updated_at: string;
}

export interface NotificationStateRow {
  workspace_id: string;
  notification_id: string;
  read_at: string | null;
  muted_at: string | null;
  updated_at: string;
}

export class NotificationsRepository {
  constructor(private readonly tx: SqliteTransactions) {}

  // -------------------------------------------------------------------------
  // Settings (the delivery toggles, PRD §14)
  // -------------------------------------------------------------------------

  getSettings(workspaceId: string, exec?: DatabaseSync): NotificationSettingsRow | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT workspace_id, in_app_enabled, browser_enabled, updated_at
         FROM notification_settings
         WHERE workspace_id = ?`,
      )
      .get(workspaceId) as
      | {
          workspace_id: string;
          in_app_enabled: number | bigint;
          browser_enabled: number | bigint;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      workspace_id: row.workspace_id,
      in_app_enabled: Number(row.in_app_enabled) === 1,
      browser_enabled: Number(row.browser_enabled) === 1,
      updated_at: row.updated_at,
    };
  }

  /** Upsert the toggles; the read-after-write row is the caller's truth. */
  putSettings(
    workspaceId: string,
    settings: { in_app_enabled: boolean; browser_enabled: boolean },
    updatedAt: string,
    exec?: DatabaseSync,
  ): NotificationSettingsRow {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `INSERT INTO notification_settings
         (workspace_id, in_app_enabled, browser_enabled, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (workspace_id) DO UPDATE SET
         in_app_enabled = excluded.in_app_enabled,
         browser_enabled = excluded.browser_enabled,
         updated_at = excluded.updated_at`,
    ).run(
      workspaceId,
      settings.in_app_enabled ? 1 : 0,
      settings.browser_enabled ? 1 : 0,
      updatedAt,
    );
    const row = this.getSettings(workspaceId, db);
    if (!row) {
      throw new Error("notification settings: put reported success but the row is absent");
    }
    return row;
  }

  // -------------------------------------------------------------------------
  // Per-notification state (read / mute stamps)
  // -------------------------------------------------------------------------

  getState(
    workspaceId: string,
    notificationId: string,
    exec?: DatabaseSync,
  ): NotificationStateRow | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT workspace_id, notification_id, read_at, muted_at, updated_at
         FROM notification_state
         WHERE workspace_id = ? AND notification_id = ?`,
      )
      .get(workspaceId, notificationId) as NotificationStateRow | undefined;
    return row ?? null;
  }

  listStates(workspaceId: string, exec?: DatabaseSync): NotificationStateRow[] {
    const db = exec ?? this.tx.connection();
    return db
      .prepare(
        `SELECT workspace_id, notification_id, read_at, muted_at, updated_at
         FROM notification_state
         WHERE workspace_id = ?`,
      )
      .all(workspaceId) as unknown as NotificationStateRow[];
  }

  /**
   * Stamp the read time (idempotent: an already-read row keeps its FIRST
   * read stamp — the moment the user actually read it, not a re-read).
   */
  stampRead(
    workspaceId: string,
    notificationId: string,
    readAt: string,
    exec?: DatabaseSync,
  ): NotificationStateRow {
    const db = exec ?? this.tx.connection();
    const existing = this.getState(workspaceId, notificationId, db);
    if (existing?.read_at) {
      return existing;
    }
    db.prepare(
      `INSERT INTO notification_state
         (workspace_id, notification_id, read_at, muted_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, notification_id) DO UPDATE SET
         read_at = COALESCE(notification_state.read_at, excluded.read_at),
         updated_at = excluded.updated_at`,
    ).run(workspaceId, notificationId, readAt, existing?.muted_at ?? null, readAt);
    const row = this.getState(workspaceId, notificationId, db);
    if (!row) {
      throw new Error("notification state: stampRead reported success but the row is absent");
    }
    return row;
  }

  /**
   * Stamp the mute (E3: delivery suppression only — the row stays listed and
   * its source record never changes). Idempotent on the same stamp rule.
   */
  stampMuted(
    workspaceId: string,
    notificationId: string,
    mutedAt: string,
    exec?: DatabaseSync,
  ): NotificationStateRow {
    const db = exec ?? this.tx.connection();
    const existing = this.getState(workspaceId, notificationId, db);
    if (existing?.muted_at) {
      return existing;
    }
    db.prepare(
      `INSERT INTO notification_state
         (workspace_id, notification_id, read_at, muted_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, notification_id) DO UPDATE SET
         muted_at = COALESCE(notification_state.muted_at, excluded.muted_at),
         updated_at = excluded.updated_at`,
    ).run(workspaceId, notificationId, existing?.read_at ?? null, mutedAt, mutedAt);
    const row = this.getState(workspaceId, notificationId, db);
    if (!row) {
      throw new Error("notification state: stampMuted reported success but the row is absent");
    }
    return row;
  }
}
