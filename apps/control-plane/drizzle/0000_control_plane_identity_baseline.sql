-- S05 baseline (v1): the control-plane identity schema (D2, PRD §12).
-- NOTE (2026-09-19): the CREATE TYPE statements below were missing from the
-- originally generated SQL (the drizzle-kit generation was interrupted
-- mid-write; the table DDL referenced the enums without creating them —
-- caught by the schema/migration test on first run). This file is the v1
-- baseline and has never shipped, so it is repaired in place rather than
-- patched by a new migration.
CREATE TYPE "resource_tier" AS ENUM('light', 'balanced', 'heavy');
CREATE TYPE "signup_state" AS ENUM('active', 'disabled');
--> statement-breakpoint
CREATE TABLE "control_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text,
	"email" text,
	"email_verified" timestamp with time zone,
	"avatar_url" text,
	"tier" "resource_tier" DEFAULT 'balanced' NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"signup_state" "signup_state" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "control_accounts_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "control_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"snapshot_ref" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"retained_index" text,
	"restored_from" text,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_container_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"container_ref" text,
	"tier" "resource_tier" DEFAULT 'balanced' NOT NULL,
	"provisioning_status" text DEFAULT 'pending' NOT NULL,
	"health_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"runtime_endpoint" text,
	"last_health_check_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "control_container_mappings_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE "control_oauth_accounts" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "control_oauth_accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "control_security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"account_id" uuid,
	"redaction_class" text DEFAULT 'internal' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"correlation_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "control_backups" ADD CONSTRAINT "control_backups_account_id_control_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."control_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_container_mappings" ADD CONSTRAINT "control_container_mappings_account_id_control_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."control_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_oauth_accounts" ADD CONSTRAINT "control_oauth_accounts_user_id_control_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."control_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_security_events" ADD CONSTRAINT "control_security_events_account_id_control_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."control_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_sessions" ADD CONSTRAINT "control_sessions_user_id_control_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."control_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "control_accounts_signup_state_idx" ON "control_accounts" USING btree ("signup_state");--> statement-breakpoint
CREATE INDEX "control_backups_account_id_idx" ON "control_backups" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "control_oauth_accounts_user_id_idx" ON "control_oauth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "control_security_events_type_idx" ON "control_security_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "control_security_events_occurred_at_idx" ON "control_security_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "control_sessions_user_id_idx" ON "control_sessions" USING btree ("user_id");