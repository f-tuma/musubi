import { Event } from "@musubi/types";

// A calendar event reduced to what Musubi stores, provider-agnostic.
// Adapters translate their own format (Google JSON / Graph JSON / iCal) <-> this.
export type NormalizedEvent = {
  externalId: string;
  status: "active" | "cancelled";   // cancelled => delete locally
  title: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  description: string | null;
  location: string | null;
  organizer: string | null;
  recurrence: string | null;        // RRULE text, or null
  url: string | null;
  etag?: string | null;             // used by CalDAV; null for OAuth providers
};

export type ExternalCalendarInfo = {
  externalId: string;
  name: string;
  color: string;
  // Provider says the user can't write (holidays, subscribed calendars, …) →
  // mirror becomes read-only even for its owner.
  readOnly?: boolean;
};

export type FetchChangesResult = {
  changes: NormalizedEvent[];
  nextCursor: string | null;
  reset?: boolean;                  // true => wipe local events for this calendar, then apply (e.g. Google 410)
};

// Everything provider-specific lives behind this. The generic core (sync engine)
// never talks to Google/Graph/CalDAV directly — only through an adapter.
export type CalendarAdapter = {
  provider: string;

  // Connected accounts for this provider (id = Better Auth account.accountId for
  // OAuth / caldav_accounts.id for CalDAV; label = human name e.g. email/username).
  // Empty = provider not connected.
  listAccounts(userID: string): Promise<{ id: string; label: string }[]>;

  // Which calendars can this account sync?
  listCalendars(userID: string, accountId: string): Promise<ExternalCalendarInfo[]>;

  // Pull changes since `cursor` (null = full sync). Adapter paginates internally
  // and returns the complete change set + the new cursor to persist.
  fetchChanges(
    userID: string,
    accountId: string,
    externalCalendarId: string,
    cursor: string | null,
  ): Promise<FetchChangesResult>;

  // Push a Musubi event out. Adapter maps Event -> its own format.
  pushCreate(userID: string, accountId: string, externalCalendarId: string, event: Event): Promise<{ externalEventId: string }>;
  pushUpdate(userID: string, accountId: string, externalCalendarId: string, externalEventId: string, event: Event): Promise<void>;
  pushDelete(userID: string, accountId: string, externalCalendarId: string, externalEventId: string): Promise<void>;
};
