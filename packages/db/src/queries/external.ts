import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  caldavAccounts,
  account,
  calendarEvents,
  calendarMembers,
  calendars,
  db,
  events,
  externalCalendars,
  externalEvents,
  type NewEvent,
} from "..";
import { type DbTransaction, removeCalendarInTransaction } from "./calendars";

// Column values written to the `events` row for a synced event.
type EventValues = {
  title: string;
  color: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  description: string | null;
  location: string | null;
  organizer: string;
  recurrence: string | null;
  url: string | null;
};

// --- calendars ---

export async function getUserExternalCalendars(provider: string, userID: string, accountID: string) {
  return db
    .select({
      // From the joined calendars row so the type is non-null — the inner join
      // already excludes disabled tombstones (calendarID null).
      calendarID: calendars.id,
      externalCalendarID: externalCalendars.externalCalendarID,
      cursor: externalCalendars.cursor,
      calColor: calendars.color,
    })
    .from(externalCalendars)
    .innerJoin(calendars, eq(externalCalendars.calendarID, calendars.id))
    .where(and(
      eq(externalCalendars.provider, provider),
      eq(externalCalendars.userID, userID),
      eq(externalCalendars.accountID, accountID),
    ));
}

export async function importExternalCalendar(
  provider: string,
  userID: string,
  accountID: string,
  accountLabel: string,
  cal: { externalId: string; name: string; color: string },
  role: string = "owner", // "viewer" for provider-side read-only calendars (holidays, …)
) {
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(calendars)
      .values({ creatorID: userID, name: cal.name, color: cal.color })
      .returning();
    await tx.insert(externalCalendars).values({
      provider,
      userID,
      accountID,
      accountLabel,
      calendarID: created.id,
      externalCalendarID: cal.externalId,
      cursor: null,
    });
    await tx.insert(calendarMembers).values({ userID, calendarID: created.id, role });
    return created;
  });
}

// External calendars the user opted OUT of syncing (mirror deleted, tombstone
// kept). Discovery consults this to avoid re-importing them on the next sync.
export async function getDisabledExternalCalendarIDs(provider: string, userID: string, accountID: string) {
  const rows = await db
    .select({ externalCalendarID: externalCalendars.externalCalendarID })
    .from(externalCalendars)
    .where(and(
      eq(externalCalendars.provider, provider),
      eq(externalCalendars.userID, userID),
      eq(externalCalendars.accountID, accountID),
      eq(externalCalendars.disabled, true),
    ));
  return rows.map((r) => r.externalCalendarID);
}

// Opt a single external calendar out of sync without disconnecting the whole
// account. Detaches the FK BEFORE deleting the mirror so the cascade can't take
// the tombstone row with it; returns null if the calendar isn't an external
// mirror owned by this user.
export async function disableExternalCalendar(userID: string, calendarID: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx.update(externalCalendars)
      .set({ disabled: true, calendarID: null, cursor: null })
      .where(and(
        eq(externalCalendars.calendarID, calendarID),
        eq(externalCalendars.userID, userID),
      ))
      .returning({ id: externalCalendars.id });
    if (!row) return null;
    await removeCalendarInTransaction(tx, calendarID);
    return row;
  });
}

// Remove every local mirror for one provider account as a single database unit.
// OAuth unlink/revocation still happens outside PostgreSQL; CalDAV credentials
// are local, so they can be deleted in this transaction too.
export async function removeExternalAccountData(
  provider: string,
  userID: string,
  accountID: string,
) {
  return db.transaction(async (tx) => {
    const links = await tx
      .select({ calendarID: calendars.id })
      .from(externalCalendars)
      .innerJoin(calendars, eq(externalCalendars.calendarID, calendars.id))
      .where(and(
        eq(externalCalendars.provider, provider),
        eq(externalCalendars.userID, userID),
        eq(externalCalendars.accountID, accountID),
      ));

    for (const link of links) {
      await removeCalendarInTransaction(tx, link.calendarID);
    }

    // Live rows cascade with their calendars; this also removes disabled
    // tombstones so reconnecting the account starts from a clean slate.
    await tx.delete(externalCalendars).where(and(
      eq(externalCalendars.provider, provider),
      eq(externalCalendars.userID, userID),
      eq(externalCalendars.accountID, accountID),
    ));

    if (provider === "caldav") {
      await tx.delete(caldavAccounts).where(and(
        eq(caldavAccounts.id, accountID),
        eq(caldavAccounts.userID, userID),
      ));
    }

    return links.map((link) => link.calendarID);
  });
}

// Keep the account label fresh across all of an account's calendars.
export async function setAccountLabel(provider: string, userID: string, accountID: string, accountLabel: string) {
  await db.update(externalCalendars)
    .set({ accountLabel })
    .where(and(
      eq(externalCalendars.provider, provider),
      eq(externalCalendars.userID, userID),
      eq(externalCalendars.accountID, accountID),
    ));
}

export async function setCursor(calendarID: string, cursor: string | null) {
  await db.update(externalCalendars).set({ cursor }).where(eq(externalCalendars.calendarID, calendarID));
}

// For push: given a Musubi calendar, which provider/external calendar/user backs it.
// serverUrl (caldav only) lets the client tell Apple/iCloud apart from generic CalDAV.
export async function getExternalLinkForCalendar(calendarID: string) {
  const [res] = await db
    .select({
      provider: externalCalendars.provider,
      externalCalendarID: externalCalendars.externalCalendarID,
      userID: externalCalendars.userID,
      accountID: externalCalendars.accountID,
      accountLabel: externalCalendars.accountLabel,
      serverUrl: caldavAccounts.serverUrl,
      syncStatus: account.syncStatus,
      syncErrorCode: account.syncErrorCode,
    })
    .from(externalCalendars)
    .leftJoin(caldavAccounts, eq(externalCalendars.accountID, sql`${caldavAccounts.id}::text`))
    .leftJoin(account, and(
      eq(externalCalendars.provider, account.providerId),
      eq(externalCalendars.userID, account.userId),
      eq(externalCalendars.accountID, account.accountId),
    ))
    .where(eq(externalCalendars.calendarID, calendarID));
  return res ?? null;
}

// --- events ---

export async function clearCalendarEvents(calendarID: string) {
  // Soft-delete (tombstone) so the delta tells clients to drop them, and keep
  // the external_events mapping — a following upsert revives still-present events
  // with the SAME id (no churn); genuinely-gone ones stay tombstoned.
  await db.update(events).set({ deletedAt: new Date() }).where(inArray(events.id,
    db.select({ id: calendarEvents.eventID }).from(calendarEvents).where(eq(calendarEvents.calendarID, calendarID))));
}

async function linkEventToCalendarsInTransaction(
  tx: DbTransaction,
  eventID: string,
  calendarIDs: string[],
) {
  if (calendarIDs.length === 0) return;
  await tx.insert(calendarEvents).values(calendarIDs.map(c => ({ eventID, calendarID: c })));
}

// Delta sync filters on events.updatedAt, so link/unlink must bump the event row —
// otherwise offline members never learn the event's calendar membership changed.
async function touchEvent(tx: DbTransaction, eventID: string) {
  await tx.update(events).set({ updatedAt: new Date() }).where(eq(events.id, eventID));
}

// Link an event into calendars (calendar_events rows). Caller guarantees these are
// new links (the "added" diff), so no conflict handling needed. The link set and
// delta timestamp move together.
export async function linkEventToCalendars(eventID: string, calendarIDs: string[]) {
  if (calendarIDs.length === 0) return;
  await db.transaction(async (tx) => {
    await linkEventToCalendarsInTransaction(tx, eventID, calendarIDs);
    await touchEvent(tx, eventID);
  });
}

// Unlink an event from calendars: drop the calendar_events rows AND any external
// mapping for those calendars, so re-adding later pushes a fresh external event
// instead of updating a stale (possibly deleted) one.
async function unlinkEventFromCalendarsInTransaction(
  tx: DbTransaction,
  eventID: string,
  calendarIDs: string[],
) {
  if (calendarIDs.length === 0) return;
  await tx.delete(calendarEvents)
    .where(and(eq(calendarEvents.eventID, eventID), inArray(calendarEvents.calendarID, calendarIDs)));

  const extCals = await tx.select({ ext: externalCalendars.externalCalendarID })
    .from(externalCalendars).where(inArray(externalCalendars.calendarID, calendarIDs));
  const extIDs = extCals.map(e => e.ext);
  if (extIDs.length) {
    await tx.delete(externalEvents)
      .where(and(eq(externalEvents.eventID, eventID), inArray(externalEvents.externalCalendarID, extIDs)));
  }
}

export async function unlinkEventFromCalendars(eventID: string, calendarIDs: string[]) {
  if (calendarIDs.length === 0) return;
  await db.transaction(async (tx) => {
    await unlinkEventFromCalendarsInTransaction(tx, eventID, calendarIDs);
    await touchEvent(tx, eventID);
  });
}

// Persist an event edit and reconcile every local link/mapping as one unit.
// Provider deletes happen before this call while their mapping is still present;
// provider creates/updates happen afterwards and remain best-effort.
export async function updateEventAndCalendarLinks(
  event: Partial<NewEvent> & { id: string },
  addedCalendarIDs: string[],
  removedCalendarIDs: string[],
) {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(events)
      .set(event)
      .where(eq(events.id, event.id))
      .returning();
    if (!updated) return undefined;

    await unlinkEventFromCalendarsInTransaction(tx, event.id, removedCalendarIDs);
    await linkEventToCalendarsInTransaction(tx, event.id, addedCalendarIDs);
    return updated;
  });
}

// Delete a selected set of links and tombstone the event iff that leaves it
// orphaned. The returned link set is from the same transaction.
export async function unlinkEventAndTombstoneIfOrphaned(
  eventID: string,
  calendarIDs: string[],
) {
  return db.transaction(async (tx) => {
    await unlinkEventFromCalendarsInTransaction(tx, eventID, calendarIDs);

    const rows = await tx
      .select({ calendarID: calendarEvents.calendarID })
      .from(calendarEvents)
      .where(eq(calendarEvents.eventID, eventID));
    const remaining = rows.map((row) => row.calendarID);
    const removed = remaining.length === 0;

    if (removed) {
      await tx.update(events)
        .set({ deletedAt: new Date() })
        .where(eq(events.id, eventID));
    } else {
      await touchEvent(tx, eventID);
    }

    return { remaining, removed };
  });
}

/**
 * Upsert a provider event. Returns TRUE when it actually wrote something —
 * the scheduled sync uses this to decide whether to wake connected clients.
 * With an etag (CalDAV) an unchanged, alive event is a verified no-op: no
 * write, no updatedAt bump, so the delta stays quiet too.
 */
export async function upsertExternalEvent(
  provider: string,
  userID: string,
  calendarID: string,
  externalCalendarID: string,
  externalEventID: string,
  values: EventValues,
  etag: string | null = null,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [map] = await tx
      .select({ eventID: externalEvents.eventID, etag: externalEvents.etag, deletedAt: events.deletedAt })
      .from(externalEvents)
      .innerJoin(events, eq(externalEvents.eventID, events.id))
      .where(and(
        eq(externalEvents.provider, provider),
        // scope to THIS mirror — global calendars (Google holidays) share
        // externalCalendarID across every user's account
        eq(externalEvents.calendarID, calendarID),
        eq(externalEvents.externalEventID, externalEventID),
      ));

    if (map) {
      // etag match on a live event = nothing changed (CalDAV full-fetches
      // everything every sync; without this check every poll looks "changed")
      if (etag !== null && map.etag === etag && map.deletedAt === null) return false;
      // revive if it was tombstoned by a reset
      await tx.update(events).set({ ...values, deletedAt: null }).where(eq(events.id, map.eventID));
      await tx.update(externalEvents).set({ etag }).where(eq(externalEvents.eventID, map.eventID));
    } else {
      const [ev] = await tx
        .insert(events)
        // Home calendar = the mirror it was imported into (matches createEvent's
        // rule) — drives the origin star + edit-permission gating.
        .values({ id: crypto.randomUUID(), ...values, creatorID: userID, originCalendarID: calendarID })
        .returning();
      await tx.insert(calendarEvents).values({ eventID: ev.id, calendarID });
      await tx.insert(externalEvents).values({ provider, eventID: ev.id, calendarID, externalCalendarID, externalEventID, etag });
    }
    return true;
  });
}

/**
 * Provider says an event is gone. TOMBSTONE it (deletedAt) rather than hard
 * delete — the delta sync's `deletedIds` needs the tombstone to tell offline
 * clients to drop it (a hard delete just vanished and stale caches kept it).
 * Returns TRUE when a live event was actually tombstoned.
 */
export async function deleteExternalEvent(provider: string, calendarID: string, externalEventID: string): Promise<boolean> {
  const rows = await db.update(events).set({ deletedAt: new Date() }).where(and(
    isNull(events.deletedAt),
    inArray(events.id,
      db.select({ id: externalEvents.eventID }).from(externalEvents).where(and(
        eq(externalEvents.provider, provider),
        // scoped to the caller's mirror — never reach into another user's mirror
        eq(externalEvents.calendarID, calendarID),
        eq(externalEvents.externalEventID, externalEventID),
      ))))).returning({ id: events.id });
  return rows.length > 0;
}

/**
 * Full-fetch reconciliation (CalDAV every sync, Google after a 410 reset):
 * tombstone the mirror's events whose external id was NOT in the fetched set —
 * they were deleted on the provider. Replaces the old tombstone-everything-
 * then-revive approach, which churned every event on every sync and made
 * "did anything change" undetectable. Returns the number tombstoned.
 */
export async function sweepExternalEvents(provider: string, calendarID: string, seenExternalEventIDs: string[]): Promise<number> {
  const mappings = await db
    .select({ eventID: externalEvents.eventID, externalEventID: externalEvents.externalEventID })
    .from(externalEvents)
    .innerJoin(events, eq(externalEvents.eventID, events.id))
    .where(and(
      eq(externalEvents.provider, provider),
      eq(externalEvents.calendarID, calendarID),
      isNull(events.deletedAt),
    ));
  const seen = new Set(seenExternalEventIDs);
  const gone = mappings.filter(m => !seen.has(m.externalEventID)).map(m => m.eventID);
  if (gone.length === 0) return 0;
  await db.update(events).set({ deletedAt: new Date() }).where(inArray(events.id, gone));
  return gone.length;
}

/** Users with at least one provider mirror — the scheduled sync's work list. */
export async function getExternalSyncUserIDs(): Promise<string[]> {
  const rows = await db.selectDistinct({ userID: externalCalendars.userID }).from(externalCalendars);
  return rows.map(r => r.userID);
}

// For push update/delete: find the external id of an already-synced Musubi event.
export async function getExternalEventID(provider: string, eventID: string, externalCalendarID: string) {
  const [res] = await db
    .select({ externalEventID: externalEvents.externalEventID })
    .from(externalEvents)
    .where(and(
      eq(externalEvents.provider, provider),
      eq(externalEvents.eventID, eventID),
      eq(externalEvents.externalCalendarID, externalCalendarID),
    ));
  return res?.externalEventID ?? null;
}

// For push create: store the mapping after the provider returns the new id.
export async function importExternalEvent(
  provider: string,
  eventID: string,
  calendarID: string,
  externalCalendarID: string,
  externalEventID: string,
  etag: string | null = null,
) {
  await db.insert(externalEvents).values({ provider, eventID, calendarID, externalCalendarID, externalEventID, etag });
}
