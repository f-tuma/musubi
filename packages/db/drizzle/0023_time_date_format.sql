ALTER TABLE "user_settings" ADD COLUMN "time_format" text DEFAULT '24h' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "date_format" text DEFAULT 'dmy' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" DROP COLUMN "time_locale";
