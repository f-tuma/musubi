# Project news

All Musubi servers read the same public [news.json](https://github.com/f-tuma/musubi/blob/main/news.json).
The API fetches its fixed raw GitHub URL; browsers and mobile apps use their own
Musubi API. There is no local news editor, admin allowlist or announcement-content
table. Account settings retain only read markers.

## Publishing

Edit the root `news.json` through the project's normal pull request and review.
Keep it newest first. For example:

```json
{
  "schemaVersion": 1,
  "items": [
    {
      "id": "2026-10-27",
      "title": "Musubi release available",
      "body": "A short plain-text summary of changes people will notice.\n\nhttps://github.com/f-tuma/musubi/releases"
    }
  ]
}
```

Run `pnpm news:check` before publishing. Normal checks run the same validator.
The feed is initially empty: this change does not invent a release announcement.

- A title has at most 200 characters; a body has at most 4000. The complete
  UTF-8 file is limited to 128 KiB and 100 items.
- Bodies use plain paragraphs and HTTP(S) links, with no HTML or Markdown.
- A new ID must sort lexically after every previously published ID. Use a real
  UTC date, optionally followed by a numeric suffix; IDs must be unique. For
  same-day messages, `-10` sorts before `-9`: extend the highest suffix at that
  boundary, such as `-9` to `-90`. Retain published IDs when correcting wording.
- News is informational for every installed version. Describe a release's
  version and link in its body; `minVersion` is rejected by the source schema.
  This prevents a newer generic item from hiding an older version-gated item
  behind a single read watermark. An available update does not imply that it
  is already installed or that a capability is enabled on a server.

Publishing a feed edit to main makes it available to all updated servers without
a database migration or product release. Each API process uses a shared
15-minute cache, conditional ETag refresh and one in-flight request. An existing
client checks news once per app load; it does not interrupt active work on focus.
GitHub is contacted without a token, user identity or cookies. Do not assume
anonymous conditional requests are exempt from GitHub's limits.

## Failure and read state

Fetches have a five-second deadline and a streaming size limit. Refresh errors
retain the last validated in-memory feed and delay retrying. A fresh process
without a valid feed returns 503; clients silently continue and no read baseline
is initialized. The memory cache is lost on restart. No SQL content cache or
bundled stale news snapshot is used.

The first successful read atomically baselines the account past existing history
(or to `0000-00-00` for a valid empty feed), so the first later item is shown.
The separate `lastSeenProjectNews` setting does not reuse old server-local read
markers, including unknown future-dated IDs. Confirmed reads advance
lexicographically and never regress through concurrent or old full settings saves.

The existing authenticated `/api/v1/announcements` shape remains compatible with
released clients, including required `isAdmin: false` and optional `markTo`.
Updated clients send both old and new read markers, so older servers still work.
Both legacy writes and explicit new-marker writes are accepted only after the
namespace is initialized and only for the empty sentinel or an ID in the
validated current feed. This also covers a new client holding an old server's
local message across an upgrade. An invalid or unverifiable new marker is
omitted while other submitted settings are retained. Exact
collisions between a historical local ID and a project ID cannot establish
provenance; this bridge rejects unknown IDs, not every possible collision.

## Upgrade and recovery

Migration `0087_project_news` removes the old `announcements` table and adds the
independent account read marker. Historical migrations remain unchanged. Existing
personal settings, old read markers and application data are preserved; custom
announcement content is intentionally removed.

This is a schema contraction: an API image that still queries that table cannot
be rolled back onto the new schema. For the later production rollout, keep one
API writer, stop the previous API first and verify the pre-upgrade database
backup/restore path. Recovery needs a compatible API build or a matching database
backup; removing an environment variable is not a schema rollback. This source
change does not itself publish a product release or deploy production.
