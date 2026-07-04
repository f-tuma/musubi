ALTER TABLE "calendar_members" ALTER COLUMN "role" SET DEFAULT 'viewer';--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "theme" text DEFAULT 'system' NOT NULL;