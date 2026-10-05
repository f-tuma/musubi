-- Preserve admin messages and read markers. New same-day IDs must sort after
-- existing IDs, including suffix 9, under the clients' lexical comparison.
WITH "latest" AS (
    SELECT max("id" COLLATE "C") AS "id"
    FROM "announcements"
    WHERE "id" ~ '^2026-10-05(-[0-9]+)?$'
), "suffix" AS (
    SELECT "id", substring("id" FROM 12) AS "value"
    FROM "latest"
), "candidate" AS (
    SELECT CASE
        WHEN "id" IS NULL THEN '2026-10-05'
        WHEN "id" = '2026-10-05' THEN '2026-10-05-2'
        WHEN (("value"::numeric + 1)::text COLLATE "C") > ("value" COLLATE "C")
            THEN '2026-10-05-' || ("value"::numeric + 1)::text
        ELSE '2026-10-05-' || "value" || '0'
    END AS "id"
    FROM "suffix"
)
INSERT INTO "announcements" ("id", "title", "body", "min_version")
SELECT "id", 'Musubi 0.2.2',
    'Share a task across calendars while keeping one task and one progress state. Editing and completion follow the permissions of its home calendar. Update the mobile app to 0.2.2 to create, edit or complete tasks; older mobile versions can still read tasks, and the updated web app is available in the meantime.

The refreshed web app brings consistent settings, editors and calendar controls, with notifications for changes and delivery problems in the top bar.

This release also improves Google authentication recovery and CalDAV discovery. Event operations remain subject to provider support and the features enabled on your server.',
    '0.2.2'
FROM "candidate";
