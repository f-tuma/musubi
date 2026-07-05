ALTER TABLE "calendars" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "onboarded" boolean DEFAULT false NOT NULL;