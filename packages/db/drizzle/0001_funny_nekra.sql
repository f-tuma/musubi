CREATE TABLE "user_settings" (
	"id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"show_kanji" boolean DEFAULT true NOT NULL,
	"default_calendar_view" text DEFAULT 'week' NOT NULL,
	"week_starts_on" text DEFAULT 'monday' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_id_user_id_fk" FOREIGN KEY ("id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;