CREATE TABLE "control_admin_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_sha256" text NOT NULL,
	"token_digest_hint" text NOT NULL,
	"created_by" text DEFAULT 'cli' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "control_admin_tokens_token_sha256_unique" UNIQUE("token_sha256")
);
--> statement-breakpoint
CREATE TABLE "control_credit_topups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"reason" text,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "control_credit_topups_amount_check" CHECK ("control_credit_topups"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "control_credit_topups" ADD CONSTRAINT "control_credit_topups_account_id_control_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."control_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "control_admin_tokens_revoked_idx" ON "control_admin_tokens" USING btree ("revoked_at");--> statement-breakpoint
CREATE INDEX "control_credit_topups_account_idx" ON "control_credit_topups" USING btree ("account_id");