ALTER TABLE "calendar_invites" ADD COLUMN "uses" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Dedup before the unique constraint: addCalendarMember's onConflictDoNothing never
-- fired (no unique existed), so re-joins piled up duplicate rows. Keep the best-role
-- (owner > editor > viewer), oldest row per (user, calendar).
DELETE FROM "calendar_members" a
USING "calendar_members" b
WHERE a."user_id" = b."user_id" AND a."calendar_id" = b."calendar_id"
  AND a."id" <> b."id"
  AND (CASE a."role" WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, a."created_at", a."id")
    > (CASE b."role" WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, b."created_at", b."id");--> statement-breakpoint
ALTER TABLE "calendar_members" ADD CONSTRAINT "calendar_members_user_id_calendar_id_unique" UNIQUE("user_id","calendar_id");