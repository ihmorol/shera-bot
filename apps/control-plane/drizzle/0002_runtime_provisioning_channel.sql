ALTER TABLE "control_container_mappings" ADD COLUMN "runtime_handle" text;--> statement-breakpoint
ALTER TABLE "control_container_mappings" ADD COLUMN "internal_channel_token_hash" text;--> statement-breakpoint
ALTER TABLE "control_container_mappings" ADD COLUMN "token_rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "control_container_mappings" ADD CONSTRAINT "control_container_mappings_runtime_handle_unique" UNIQUE("runtime_handle");--> statement-breakpoint
ALTER TABLE "control_container_mappings" ADD CONSTRAINT "control_container_mappings_status_check" CHECK ("control_container_mappings"."provisioning_status" in ('pending', 'provisioning', 'running', 'stopped', 'failed'));