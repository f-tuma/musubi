ALTER TABLE "account" ADD COLUMN "sync_status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "sync_error_code" text;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "sync_error_subtype" text;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "sync_disabled_at" timestamp;