# Apple / iCloud & generic CalDAV sync

Adapter: `apps/api/src/sync/adapters/caldav.ts`. Covers Apple / iCloud and any
CalDAV server (Nextcloud, Radicale, Fastmail, …). Two-way. Multiple accounts per
user supported.

## Auth — not OAuth

CalDAV uses a server URL + username + password (Basic auth), **not** OAuth. For
Apple/iCloud that means an **app-specific password**, not the Apple ID password.

- Credentials live in their own table `caldav_accounts` (NOT Better Auth's
  `account` table), one row per (user, serverUrl, username).
- The password is stored **AES-GCM encrypted** at the app layer (same scheme/key
  as federated member tokens); the DB never sees plaintext.
- Because they aren't OAuth accounts, CalDAV connections have **no per-account
  sync status** — in metrics they always report `status="active"` (see
  [observability](../observability.md)).

### Apple vs generic

`providerFlavor()` treats a `serverUrl` containing `icloud.com` as **Apple**
(affects only display naming — "Apple Calendar"). The sync path is identical.

## Change tracking — full fetch every sync

Unlike Google/Microsoft, there's no delta cursor. Each sync **full-fetches** the
calendar within a rolling window and returns `reset: true`, so the engine
reconciles deletions by sweeping events absent from the fetch.

- Window: 1 year back, 3 years ahead.
- **iCloud quirk**: its `calendar-query` REPORT returns **nothing** without a
  `time-range` filter — the window bound is mandatory, not just an optimization.
- Change detection uses **etags** — an unchanged, still-alive event is a verified
  no-op (no write, no `updatedAt` bump), so a full re-fetch stays quiet when
  nothing moved.

Upgrade path: WebDAV `sync-collection` (cursor = `syncToken`) if calendars grow
large enough that full fetches hurt.

## Events

- Parsed from iCal (`ical.js`). Events are addressed by **resource URL**, not UID
  (`externalId` = the object URL).
- **All-day**: iCal DATE-typed `DTSTART` (`isDate`); `DTEND` is exclusive → minus
  one day. Anchored to UTC midnight.
- **Recurrence**: `RRULE` + `EXDATE` round-trip. EXDATE must survive because we
  push exceptions to the server and the full-refetch would otherwise overwrite
  them locally. All-day exceptions use DATE-typed EXDATE.

## Calendar-level operations

Object writes go through tsdav's typed client; calendar create/rename/recolor/
delete use **raw WebDAV** (`MKCALENDAR` / `PROPPATCH` / `DELETE`) to keep the
Apple color namespace (`http://apple.com/ns/ical/`) and the MKCALENDAR body under
our control.

- Create derives the calendar-home from the parent of an existing calendar's URL
  (every provisioned account has at least one).
- `PROPPATCH` returning `207 Multi-Status` counts as success; a server ignoring
  the Apple color prop is non-fatal — the display name is what matters.
