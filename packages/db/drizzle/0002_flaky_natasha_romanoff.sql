ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "is_all_day" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "location" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "is_canceled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "organizer" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "organizer" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "recurrence" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "url" text;