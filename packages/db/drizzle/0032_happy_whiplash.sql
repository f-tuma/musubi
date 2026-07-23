ALTER TABLE "external_calendars" ALTER COLUMN "calendar_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "external_calendars" ADD COLUMN "disabled" boolean DEFAULT false NOT NULL;