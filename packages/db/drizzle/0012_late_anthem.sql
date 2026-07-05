ALTER TABLE "caldav_accounts" DROP CONSTRAINT "caldav_accounts_user_id_unique";--> statement-breakpoint
ALTER TABLE "external_calendars" DROP CONSTRAINT "external_calendars_provider_user_id_external_calendar_id_unique";--> statement-breakpoint
ALTER TABLE "external_calendars" ADD COLUMN "account_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "caldav_accounts" ADD CONSTRAINT "caldav_accounts_user_id_server_url_username_unique" UNIQUE("user_id","server_url","username");--> statement-breakpoint
ALTER TABLE "external_calendars" ADD CONSTRAINT "external_calendars_provider_account_id_external_calendar_id_unique" UNIQUE("provider","account_id","external_calendar_id");