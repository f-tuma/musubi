# External calendar sync

Musubi does two-way sync with external calendar providers (Google, Microsoft /
Outlook, Apple / iCloud, and generic CalDAV). This directory documents the
shared model and the per-provider specifics.

- [Google Calendar](./google.md)
- [Microsoft / Outlook](./microsoft.md)
- [Apple / iCloud & generic CalDAV](./caldav.md)

## Architecture

The core sync engine is **provider-agnostic**. It never talks to Google/Graph/
CalDAV directly — only through a `CalendarAdapter` (`apps/api/src/sync/adapter.ts`).
Adapters translate the provider's format to/from a `NormalizedEvent`. The engine
lives in `apps/api/src/sync/engine.ts`; adapters in `apps/api/src/sync/adapters/`.

To add a provider: implement `CalendarAdapter` and register it in the `adapters`
map in `engine.ts`. Nothing else in the engine changes.

### Adapter contract

```
listAccounts(userID)                          → connected accounts [{id, label}]
listCalendars(userID, accountId)              → calendars [{externalId, name, color, readOnly}]
fetchChanges(userID, accountId, calId, cursor)→ { changes, nextCursor, reset }
pushCreate / pushUpdate / pushDelete(...)     → write one event to the provider
createCalendar / updateCalendar / deleteCalendar(...)
```

- **`cursor`** — opaque per-calendar sync state (delta token). `null` = full sync.
- **`reset: true`** — the returned set is the FULL set; the engine tombstones any
  local events not present in it (handles provider-side deletions).
- **`readOnly`** — provider says the user can't write (holidays, subscribed
  calendars, viewer invites). The local mirror becomes read-only even for its
  owner (`calendar_members.role = "viewer"`).

### NormalizedEvent

The common shape every adapter maps to (`adapter.ts`):

```
externalId, status (active|cancelled), title, start, end, isAllDay,
description, location, organizer, recurrence (RRULE text|null), url, etag?
```

## The mirror model

Each external calendar is mirrored to a **local `calendars` row**; its events
land in the normal `events` table. Mapping tables tie them together:

- `external_calendars` — one row per (provider, account, external calendar) →
  local mirror `calendarID`. Holds the sync `cursor` and the `disabled` flag.
- `external_events` — maps each provider event → local event, scoped to the
  mirror (so global calendars like holidays can be mirrored by many users).

A synced event's **home calendar** (`originCalendarID`) is its mirror — that
drives the origin star and edit-permission gating.

## Sync flow (per account)

`syncProvider()` in `engine.ts`:

1. `listCalendars` → reconcile the mirror set: import new calendars, drop mirrors
   whose remote calendar disappeared, refresh the read-only role.
2. For each mirror, `fetchChanges(cursor)` → upsert events, tombstone cancelled
   ones, and (when `reset`) sweep events that vanished from a full fetch.
3. Persist the new cursor. If anything changed, SSE-nudge the calendars' members
   so connected clients silently refresh.

Scheduling is controlled by `EXTERNAL_SYNC_INTERVAL_MIN` (0 = disabled;
connect flows still trigger an immediate sync). Failures increment
`musubi_external_sync_failures_total` — see [observability](../observability.md).

## Deletes are tombstones

Provider "event gone" → the local event is **tombstoned** (`deletedAt`), not hard
deleted, so the delta sync tells offline clients to drop it. A hard delete would
just vanish and stale client caches would keep showing it.

## Per-calendar disconnect

A user can disconnect a **single** external calendar without disconnecting the
whole account (e.g. drop "Czech holidays" but keep the rest of Outlook). This is
the only way to remove a read-only mirror (holidays, viewer invites), which
can't be deleted and isn't the user's to delete on the provider.

Mechanism (`disableExternalCalendar` in `packages/db/src/queries/external.ts`):

- The mirror + its events are deleted; the `external_calendars` row survives as a
  **tombstone** (`disabled = true`, `calendarID = null`).
- Discovery skips re-importing a disabled calendar (`engine.ts` consults
  `getDisabledExternalCalendarIDs`). Without this, the next sync would just
  re-add it.
- Disconnecting the **whole account** clears these tombstones, so a later
  reconnect starts fresh.

The calendar is never touched on the provider.

## All-day events

All providers represent all-day dates differently; adapters normalize to **UTC
midnight**, with an inclusive end (single-day all-day → `start == end`). Provider
"end" is exclusive (next midnight), so adapters subtract one day on the way in
and add one on the way out. See each provider page for its date format.
