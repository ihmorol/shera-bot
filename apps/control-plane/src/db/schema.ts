/**
 * Central PostgreSQL schema (S05) — the control plane's identity layer.
 *
 * Scope discipline (D2, PRD §12): this database stores ONLY account identity,
 * Google OAuth identity, signup/administrator state, the user→container
 * mapping placeholder, provisioning/health summaries, backup metadata, and
 * the security events the control plane requires. It must never store
 * conversations, files, memories, provider keys, or task internals — those are
 * container-local (SQLite) records.
 *
 * Drizzle-first (D24): the generated SQL under drizzle/ is reviewed and
 * committed; schema push is never used. The Auth.js adapter tables are the
 * four-table Auth.js standard schema (accounts / OAuth identity / sessions),
 * renamed with the `control_` prefix and snake_case columns.
 */
import { relations, sql } from "drizzle-orm";

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { resourceTierEnum, signupStateEnum } from "./enums.ts";

/**
 * The Shera account. Auth.js maps its "user" model onto this table: the
 * adapter property names (id, name, email, emailVerified, image) are fixed by
 * @auth/drizzle-adapter, while the DATABASE columns carry product names
 * (display_name, avatar_url, email_verified). The Shera columns carry signup
 * state, the simulated tier, and the administrator flag.
 *
 * - PRD §3.2 / §15: administrator status is a manually managed database flag;
 *   no endpoint sets it (an AFTER UPDATE trigger records flag changes as
 *   security events because the only legitimate path is manual SQL).
 * - A disabled signup state still consumes a signup slot (PRD §15 admin
 *   capability "enable/disable accounts").
 */
export const controlAccounts = pgTable(
  "control_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Google profile display name (Auth.js "name"). */
    name: text("display_name"),
    email: text("email").unique(),
    /** Auth.js "emailVerified". */
    emailVerified: timestamp("email_verified", { withTimezone: true, mode: "date" }),
    /** Google avatar URL (Auth.js "image"). */
    image: text("avatar_url"),
    /** PRD §3.2: simulated tier; balanced is the default. */
    tier: resourceTierEnum("tier").notNull().default("balanced"),
    /** PRD §3.2: manually managed DB flag. Never settable via any endpoint. */
    isAdmin: boolean("is_admin").notNull().default(false),
    /** PRD §15: administrators enable/disable accounts. */
    signupState: signupStateEnum("signup_state").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("control_accounts_signup_state_idx").on(t.signupState)],
);

/**
 * Google OAuth identity (PRD §12, D2). Auth.js "account" table: one row per
 * linked (provider, provider_account_id). Property names follow the
 * @auth/drizzle-adapter account model (token columns are snake_case there);
 * database columns are snake_case. Token columns hold the Google OAuth tokens
 * issued at sign-in; redaction rules (G3, PRD §16) keep them out of logs,
 * events, and error payloads.
 */
export const controlOauthAccounts = pgTable(
  "control_oauth_accounts",
  {
    /** Auth.js "userId" — the owning Shera account. */
    userId: uuid("user_id")
      .notNull()
      .references(() => controlAccounts.id, { onDelete: "cascade" }),
    /** Auth.js "type" — "oidc" for Google. */
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    /** Stable Google subject identifier (`sub`) — the Session contract's google_sub. */
    providerAccountId: text("provider_account_id").notNull(),
    // Token columns: the adapter inserts AdapterAccount objects whose keys are
    // snake_case, so the table properties carry the same names.
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    /** Unix seconds, per Auth.js convention. */
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.providerAccountId] }),
    index("control_oauth_accounts_user_id_idx").on(t.userId),
  ],
);

/**
 * Auth.js database sessions (the session store; PRD §3.2 login persists
 * server-side). `session_token` is the bearer secret carried by the
 * authjs.session-token cookie; it is redacted from all logs and events.
 */
export const controlSessions = pgTable(
  "control_sessions",
  {
    sessionToken: text("session_token").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => controlAccounts.id, { onDelete: "cascade" }),
    expires: timestamp("expires", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [index("control_sessions_user_id_idx").on(t.userId)],
);

/**
 * S06 placeholder (out of S05 scope): the user→container mapping plus the
 * provisioning/health summary columns D2 assigns to the control plane. S06
 * fills container_ref/runtime_endpoint and drives the status machine; the
 * schema (and thus the migration history) is established here.
 */
export const controlContainerMappings = pgTable("control_container_mappings", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .unique()
    .references(() => controlAccounts.id, { onDelete: "cascade" }),
  /** Opaque container reference; assigned by S06 provisioning. */
  containerRef: text("container_ref"),
  tier: resourceTierEnum("tier").notNull().default("balanced"),
  provisioningStatus: text("provisioning_status").notNull().default("pending"),
  /** Bounded health summary (PRD §15 view), written by the S06+ channel. */
  healthSummary: jsonb("health_summary")
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  runtimeEndpoint: text("runtime_endpoint"),
  lastHealthCheckAt: timestamp("last_health_check_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Backup/snapshot metadata (D2; PRD §12 six-hour snapshots, retain seven).
 * Writers arrive with the backup slice; the metadata table is control-plane
 * schema and exists from S05.
 */
export const controlBackups = pgTable(
  "control_backups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => controlAccounts.id, { onDelete: "cascade" }),
    snapshotRef: text("snapshot_ref").notNull(),
    status: text("status").notNull().default("in_progress"),
    retainedIndex: text("retained_index"),
    restoredFrom: text("restored_from"),
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("control_backups_account_id_idx").on(t.accountId)],
);

/**
 * Operational security events (D2, PRD §15 "security-relevant actions are
 * logged internally", PRD §22.18). Append-only. `details` is always passed
 * through the redaction filter before insert (G3) — the redaction test
 * proves token/secret values never land here.
 */
export const controlSecurityEvents = pgTable(
  "control_security_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventType: text("event_type").notNull(),
    /** Null for events that precede account creation (e.g. signup refusals). */
    accountId: uuid("account_id").references(() => controlAccounts.id, {
      onDelete: "set null",
    }),
    /** D26 vocabulary: public | internal | restricted. */
    redactionClass: text("redaction_class").notNull().default("internal"),
    details: jsonb("details")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    correlationId: text("correlation_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("control_security_events_type_idx").on(t.eventType),
    index("control_security_events_occurred_at_idx").on(t.occurredAt),
  ],
);

export const controlAccountsRelations = relations(controlAccounts, ({ many }) => ({
  oauthAccounts: many(controlOauthAccounts),
  sessions: many(controlSessions),
}));

export const controlOauthAccountsRelations = relations(controlOauthAccounts, ({ one }) => ({
  account: one(controlAccounts, {
    fields: [controlOauthAccounts.userId],
    references: [controlAccounts.id],
  }),
}));

export const controlSessionsRelations = relations(controlSessions, ({ one }) => ({
  account: one(controlAccounts, {
    fields: [controlSessions.userId],
    references: [controlAccounts.id],
  }),
}));

/** Tables owned by the control plane, in the order migrations create them. */
export const CONTROL_PLANE_TABLES = [
  "control_accounts",
  "control_oauth_accounts",
  "control_sessions",
  "control_container_mappings",
  "control_backups",
  "control_security_events",
] as const;
