DELETE FROM "user_settings"
WHERE ctid IN (
  SELECT ctid
  FROM (
    SELECT
      ctid,
      row_number() OVER (
        PARTITION BY "id"
        ORDER BY "updated_at" DESC, "created_at" DESC, ctid DESC
      ) AS duplicate_rank
    FROM "user_settings"
  ) ranked_settings
  WHERE duplicate_rank > 1
);--> statement-breakpoint
DELETE FROM "calendar_events"
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT
      "id",
      row_number() OVER (
        PARTITION BY "event_id", "calendar_id"
        ORDER BY "created_at" ASC, "id" ASC
      ) AS duplicate_rank
    FROM "calendar_events"
  ) ranked_links
  WHERE duplicate_rank > 1
);--> statement-breakpoint
ALTER TABLE "user_settings" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_event_id_calendar_id_unique" UNIQUE("event_id","calendar_id");
