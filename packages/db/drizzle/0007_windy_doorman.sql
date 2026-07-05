CREATE TABLE "google_calendars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"calendar_id" uuid NOT NULL,
	"google_calendar_id" text NOT NULL,
	"sync_token" text,
	CONSTRAINT "google_calendars_calendar_id_unique" UNIQUE("calendar_id")
);
--> statement-breakpoint
CREATE TABLE "google_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"event_id" uuid NOT NULL,
	"google_calendar_id" text NOT NULL,
	"google_event_id" text NOT NULL,
	CONSTRAINT "google_events_google_calendar_id_google_event_id_unique" UNIQUE("google_calendar_id","google_event_id")
);
--> statement-breakpoint
ALTER TABLE "google_calendars" ADD CONSTRAINT "google_calendars_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_events" ADD CONSTRAINT "google_events_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;