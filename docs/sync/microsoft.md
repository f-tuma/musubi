# Microsoft / Outlook sync

Adapter: `apps/api/src/sync/adapters/microsoft.ts`. Uses Microsoft Graph
(`graph.microsoft.com/v1.0`). Two-way. Multiple accounts per user supported.

## Auth (Entra ID)

- OAuth via Better Auth. Requires an Entra app registration:
  `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, and optionally
  `MICROSOFT_TENANT_ID` (default `common` = any account incl. personal; set a
  tenant id only to restrict to one organization).
- **Redirect URI** must be registered under the **Web** platform (not SPA/Mobile —
  Musubi does a server-side code exchange with the client secret):

  ```
  {BETTER_AUTH_URL}/api/auth/callback/microsoft
  ```

- Scopes: `openid User.Read Calendars.ReadWrite offline_access`. Microsoft
  requires the scope again on refresh and **rotates the refresh token** (the
  shared OAuth helper persists the new one).

### Troubleshooting

- **`AADSTS90023: redirect_uri is not valid`** — the callback URI isn't
  registered, or is registered under the wrong platform (SPA instead of Web).
  Fix it in Entra → Authentication → add a **Web** platform with the exact URI
  above (no trailing slash). Portal changes can take a minute to propagate.
- **`AADSTS7000215: invalid client secret`** — wrong or expired secret. In Entra,
  copy the secret **Value** (not its ID), and note secrets expire.
- The real `AADSTS…` code is logged server-side; the OAuth error page only shows
  a generic `invalid_code`.

## Change tracking — fixed window

Graph's v1.0 event delta only works on a **`calendarView`** — a FIXED date range
baked into the delta token at the initial sync. Musubi uses a rolling window:

- past 180 days, future 730 days;
- when the future edge gets within 90 days, the adapter forces a fresh full
  window (`reset: true`);
- `410` (expired delta token) → same full-resync path.

Events outside the window are invisible to the mirror. (Upgrade path: beta
`/events/delta`, unbounded, once it reaches v1.0.)

Requests send `Prefer: outlook.timezone="UTC", outlook.body-content-type="text"`
so times come back in UTC and bodies as plain text.

## Events

- **All-day**: `end.dateTime` is exclusive (next midnight) → adapter subtracts one
  day. Stored at UTC midnight.
- **Recurring series** arrive **pre-expanded** by `calendarView` (occurrences +
  exceptions as individual events), so `recurrence` is always `null` on pull — no
  RRULE conversion.

### Gotcha: recurring occurrences are lightweight stubs

`calendarView/delta` returns recurring **occurrences** with only instance fields
— `id`, `start`, `end`, `seriesMasterId`, `type` — and **no `subject`, `isAllDay`,
`body`, etc.** Those live on the series **master**, whose own start is the
first-ever instance and is usually **outside the sync window**, so it isn't in
the delta stream.

Left unhandled, every recurring occurrence syncs as `"(untitled)"` and as a timed
event (missing `isAllDay` → not collapsed to all-day). The adapter fixes this by
fetching each series master by id (`/me/events/{seriesMasterId}`, cached per sync
run) and backfilling the missing fields onto the occurrence — the occurrence's
own `start`/`end`/`id` win. Exceptions (a modified single instance) keep their own
overrides on top of the master.

Cost: one extra GET per unique series on a full sync.

## Colours

Graph calendars accept only a **preset color enum** (`hexColor` is read-only). On
create/update the adapter maps the chosen hex to the nearest preset
(`nearestMicrosoftCalendarColor`). The client offers exactly these presets for
Outlook calendars, so it's normally an exact match.

## Push limitations

Musubi-native **recurring** events can't be pushed to Outlook yet — Graph models
recurrence as structured patterns + per-occurrence exceptions, with no iCal
RRULE/EXDATE round-trip. Pushing a recurring event throws rather than silently
dropping the recurrence.
