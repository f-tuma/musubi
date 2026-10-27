-- Project content now comes from GitHub. Keep the historical client read marker
-- and initialize separate project-news read state without changing preferences.
DROP TABLE "announcements";--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "last_seen_project_news" text DEFAULT '' NOT NULL;
