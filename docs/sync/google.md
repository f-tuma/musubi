# Google Calendar sync

Adapter: `apps/api/src/sync/adapters/google.ts`. Two-way. Multiple accounts per
user supported.

## Auth

- OAuth via Better Auth (`packages/auth`), `accessType: "offline"` (refresh
  token), `prompt: "select_account consent"`.
- Access tokens are refreshed on demand and stored encrypted at rest.
- Scope must include Calendar read/write. A revoked refresh token flips the
  account's `syncStatus` to require reconnect.

## Calendars

- Listed from `users/me/calendarList`.
- `readOnly` = `accessRole` is neither `owner` nor `writer` (holidays,
  subscribed, or calendars shared to you as reader).
- Color comes from the per-user `calendarList` entry (`backgroundColor`), not the
  calendar itself — pushing a color patches the calendarList entry.

## Change tracking

- Delta via Google's **`syncToken`** (cursor). Full history, no fixed window.
- A `410 Gone` means the sync token expired → the adapter restarts as a full
  sync and returns `reset: true` (engine wipes the mirror's events first).
- Pagination via `nextPageToken`; the final page carries `nextSyncToken`.

## Events

- **All-day**: identified by `start.date` (no `start.dateTime`). `end.date` is
  exclusive, so the adapter subtracts one day. Stored at UTC midnight.
- **Recurrence**: RRULE text is passed through. `sanitizeRecurrence()` patches a
  Google quirk (adds `BYMONTH` where needed). All-day series need DATE-typed
  `EXDATE`/`UNTIL` — handled on push (`toGoogleRecurrence`).
- Recurring events sync as the master + RRULE (not pre-expanded), unlike
  Microsoft.

## Notes

- `url` is the online-meeting link when present, never `htmlLink` (that's just
  "open in Google Calendar" noise).
