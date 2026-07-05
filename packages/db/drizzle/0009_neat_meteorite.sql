CREATE TABLE "external_calendars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"user_id" text NOT NULL,
	"calendar_id" uuid NOT NULL,
	"external_calendar_id" text NOT NULL,
	"cursor" text,
	CONSTRAINT "external_calendars_provider_user_id_external_calendar_id_unique" UNIQUE("provider","user_id","external_calendar_id"),
	CONSTRAINT "external_calendars_calendar_id_unique" UNIQUE("calendar_id")
);
--> statement-breakpoint
CREATE TABLE "external_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"event_id" uuid NOT NULL,
	"external_calendar_id" text NOT NULL,
	"external_event_id" text NOT NULL,
	"etag" text,
	CONSTRAINT "external_events_provider_external_calendar_id_external_event_id_unique" UNIQUE("provider","external_calendar_id","external_event_id")
);
--> statement-breakpoint
ALTER TABLE "external_calendars" ADD CONSTRAINT "external_calendars_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_calendars" ADD CONSTRAINT "external_calendars_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_events" ADD CONSTRAINT "external_events_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;