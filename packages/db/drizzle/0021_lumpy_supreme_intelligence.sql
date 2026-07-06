ALTER TABLE "external_events" DROP CONSTRAINT "external_events_provider_external_calendar_id_external_event_id_unique";--> statement-breakpoint
ALTER TABLE "external_events" ADD COLUMN "calendar_id" uuid;--> statement-breakpoint
-- backfill: the mirror is the calendar the event is linked to that also carries
-- the matching external_calendars mapping (one per user/account)
UPDATE "external_events" ee SET "calendar_id" = ce."calendar_id"
FROM "calendar_events" ce
JOIN "external_calendars" ec
  ON ec."calendar_id" = ce."calendar_id"
 AND ec."external_calendar_id" = ee."external_calendar_id"
WHERE ce."event_id" = ee."event_id";--> statement-breakpoint
DELETE FROM "external_events" WHERE "calendar_id" IS NULL;--> statement-breakpoint
ALTER TABLE "external_events" ALTER COLUMN "calendar_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "external_events" ADD CONSTRAINT "external_events_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_events" ADD CONSTRAINT "external_events_provider_calendar_id_external_event_id_unique" UNIQUE("provider","calendar_id","external_event_id");--> statement-breakpoint
-- mirrors that lost the import race before this fix are empty but their cursor
-- is already advanced — null it so the next sync does a full re-import
UPDATE "external_calendars" ec SET "cursor" = NULL
WHERE NOT EXISTS (SELECT 1 FROM "external_events" ee WHERE ee."calendar_id" = ec."calendar_id");