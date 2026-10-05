import { isCancelledGraphMeeting } from "./graph-meeting-cancel";
import { hasFullProviderReadAccess, microsoftPrivateAccess } from "./microsoft-access";
import { googlePersonalReadRecovery, finishGooglePersonalReadRecovery } from "./google-personal-read-recovery";
import { assertExternalCalendarAccess, type ExternalCalendarAccessContext } from "./external-access";
import { assertNoPendingGraphSeriesCreate } from "./graph-series-create";
import { caldavSeriesDesired } from "./caldav-series-scope";
import { expandRecurringEvents } from "@musubi/calendar";
import { TaskSchema, ProviderReminderEditSchema, ProviderEventStateSchema, type ProviderEventState, type ProviderSettingTimeEvidence, hasKnownEventTime, BadRequestError, EventTimeModelSchema, OccurrenceStartSchema, type EventTimeModel, type OccurrenceStart } from "@musubi/types";
import { randomUUID } from "node:crypto";
import { appendTaskOutbox, prepareTaskOutboxInTransaction, finishTaskOutboxInTransaction, assertTaskOutboxSourceInTransaction, taskOutboxLeaseGuard, type TaskOutboxRow } from "./task-outbox";
import { assertLegacyEventTimePatch } from "./event-time-write";
import { appendEventOutbox, reserveEventMutation, type EventOutboxIntent } from "./event-outbox";
import { retainPendingEventPull, retainUnmappedCreatePull } from "./event-outbox-pull";
import { appendInboundEventFanout } from "./event-outbox-fanout";
import { retainUnmappedEventDeletion, lockExternalEventAddress } from "./event-outbox-deletions";
import { lockCalendarLifecycle, lockUserLifecycle } from "./calendar-lifecycle";
import { and, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { logger } from "@musubi/config";
import {
  availabilityAccounts,
  caldavAccounts,
  account,
  calendarEvents,
  calendarTasks,
  calendarMembers,
  calendars,
  db,
  events,
  externalCalendars,
  externalEvents,
  eventOutbox,
  externalTasks,
  tasks,
  taskOutbox,
  type NewEvent,
  type NewTask,
} from "..";
import { hasProviderSyncScopes } from "./oauth";
import { type DbTransaction, removeCalendarInTransaction, lockCalendarRemovalEvents } from "./calendars";
import {
  createEventInTransaction,
  diffEventContent, type EventContentPatch,
} from "./events";

// Column values written to the `events` row for a synced event.
function sameTimeMetadata(a: unknown, b: unknown) {
  const stable = (value: unknown) => JSON.stringify(value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value ?? null);
  return stable(a) === stable(b);
}

type ProviderOccurrence = { externalSeriesID: string; originalStart: OccurrenceStart };
type ProviderTime = { timeModel: EventTimeModel; externalSeriesID?: string | null; originalStart?: OccurrenceStart | null; isCanceled?: boolean };

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

type TaskValues = {
  title: string;
  description: string | null;
  status: NonNullable<NewTask["status"]>;
  start: Date | null;
  due: Date | null;
  isAllDay: boolean;
  completedAt: Date | null;
  percentComplete: number;
  priority: number;
  recurrence: string | null;
  relatedTo: string | null;
  sequence: number;
  url: string | null;
};

// --- calendars ---

export async function getUserExternalCalendars(
  provider: string,
  userID: string,
  accountID: string,
) {
  return db
    .select({
      // From the joined calendars row so the type is non-null — the inner join
      // already excludes disabled tombstones (calendarID null).
      calendarID: calendars.id,
      externalCalendarID: externalCalendars.externalCalendarID,
      cursor: externalCalendars.cursor,
      sourceID: externalCalendars.id,
      providerAccessRole: externalCalendars.providerAccessRole,
      providerAccessRevision: externalCalendars.providerAccessRevision,
      supportsEvents: externalCalendars.supportsEvents,
      supportsTasks: externalCalendars.supportsTasks,
      providerDefaultCalendar: externalCalendars.providerDefaultCalendar,
      calColor: calendars.color,
    })
    .from(externalCalendars)
    .innerJoin(calendars, eq(externalCalendars.calendarID, calendars.id))
    .where(
      and(
        eq(externalCalendars.provider, provider),
        eq(externalCalendars.userID, userID),
        eq(externalCalendars.accountID, accountID),
      ),
    );
}

export async function importExternalCalendar(
  provider: string,
  userID: string,
  accountID: string,
  accountLabel: string,
  cal: {
    externalId: string;
    name: string;
    color: string;
    supportsEvents?: boolean;
    supportsTasks?: boolean;
    providerDefaultCalendar?: boolean | null;
  },
  role: string = "owner", // "viewer" for provider-side read-only calendars (holidays, …)
) {
  return db.transaction(async (tx) => {
    await lockUserLifecycle(tx, [userID], "shared");
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
      supportsEvents: cal.supportsEvents ?? true,
      supportsTasks: cal.supportsTasks ?? false,
      providerDefaultCalendar: cal.providerDefaultCalendar ?? null,
    });
    await tx
      .insert(calendarMembers)
      .values({ userID, calendarID: created.id, role });
    return created;
  });
}

// External calendars the user opted OUT of syncing (mirror deleted, tombstone
// kept). Discovery consults this to avoid re-importing them on the next sync.
export async function getDisabledExternalCalendarIDs(
  provider: string,
  userID: string,
  accountID: string,
) {
  const rows = await db
    .select({ externalCalendarID: externalCalendars.externalCalendarID })
    .from(externalCalendars)
    .where(
      and(
        eq(externalCalendars.provider, provider),
        eq(externalCalendars.userID, userID),
        eq(externalCalendars.accountID, accountID),
        eq(externalCalendars.disabled, true),
      ),
    );
  return rows.map((r) => r.externalCalendarID);
}

// Opt a single external calendar out of sync without disconnecting the whole
// account. Detaches the FK BEFORE deleting the mirror so the cascade can't take
// the tombstone row with it; returns null if the calendar isn't an external
// mirror owned by this user.
export async function disableExternalCalendar(
  userID: string,
  calendarID: string,
) {
  return db.transaction(async (tx) => {
    await lockCalendarLifecycle(tx, [calendarID], "exclusive");
    const [row] = await tx
      .update(externalCalendars)
      .set({ disabled: true, calendarID: null, cursor: null })
      .where(
        and(
          eq(externalCalendars.calendarID, calendarID),
          eq(externalCalendars.userID, userID),
        ),
      )
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
    if (provider === "google") await tx.delete(availabilityAccounts).where(inArray(availabilityAccounts.accountID, tx.select({ id: account.id }).from(account).where(and(eq(account.userId, userID), eq(account.providerId, provider), eq(account.accountId, accountID)))));
    const links = await tx
      .select({ calendarID: calendars.id })
      .from(externalCalendars)
      .innerJoin(calendars, eq(externalCalendars.calendarID, calendars.id))
      .where(
        and(
          eq(externalCalendars.provider, provider),
          eq(externalCalendars.userID, userID),
          eq(externalCalendars.accountID, accountID),
        ),
      );

    await lockCalendarLifecycle(tx, links.map((link) => link.calendarID), "exclusive");
    await lockCalendarRemovalEvents(tx, links.map((link) => link.calendarID));
    for (const link of links) {
      await removeCalendarInTransaction(tx, link.calendarID);
    }

    // Live rows cascade with their calendars; this also removes disabled
    // tombstones so reconnecting the account starts from a clean slate.
    await tx
      .delete(externalCalendars)
      .where(
        and(
          eq(externalCalendars.provider, provider),
          eq(externalCalendars.userID, userID),
          eq(externalCalendars.accountID, accountID),
        ),
      );

    if (provider === "caldav") {
      await tx
        .delete(caldavAccounts)
        .where(
          and(
            eq(caldavAccounts.id, accountID),
            eq(caldavAccounts.userID, userID),
          ),
        );
    }

    return links.map((link) => link.calendarID);
  });
}

// Keep the account label fresh across all of an account's calendars.
export async function setAccountLabel(
  provider: string,
  userID: string,
  accountID: string,
  accountLabel: string,
) {
  await db
    .update(externalCalendars)
    .set({ accountLabel })
    .where(
      and(
        eq(externalCalendars.provider, provider),
        eq(externalCalendars.userID, userID),
        eq(externalCalendars.accountID, accountID),
      ),
    );
}

export async function setExternalCalendarCapabilities(
  provider: string,
  userID: string,
  accountID: string,
  externalCalendarID: string,
  capabilities: { supportsEvents: boolean; supportsTasks: boolean; providerDefaultCalendar?: boolean | null },
) {
  await db
    .update(externalCalendars)
    .set(capabilities)
    .where(
      and(
        eq(externalCalendars.provider, provider),
        eq(externalCalendars.userID, userID),
        eq(externalCalendars.accountID, accountID),
        eq(externalCalendars.externalCalendarID, externalCalendarID),
      ),
    );
}

export async function setCursor(calendarID: string, cursor: string | null, context?: ExternalCalendarAccessContext) {
  if (context) return db.transaction(async tx => {
    await lockCalendarLifecycle(tx, [calendarID], "shared");
    await assertExternalCalendarAccess(tx, context.provider ?? "google", calendarID, context);
    await tx.update(externalCalendars).set({ cursor }).where(eq(externalCalendars.calendarID, calendarID));
  });
  await db
    .update(externalCalendars)
    .set({ cursor })
    .where(eq(externalCalendars.calendarID, calendarID));
}

// For push: given a Musubi calendar, which provider/external calendar/user backs it.
// serverUrl (caldav only) lets the client tell Apple/iCloud apart from generic CalDAV.
export async function getExternalLinkForCalendar(calendarID: string) {
  const [res] = await db
    .select({
      id: externalCalendars.id,
      disabled: externalCalendars.disabled,
      providerAccessRevision: externalCalendars.providerAccessRevision,
      provider: externalCalendars.provider,
      externalCalendarID: externalCalendars.externalCalendarID,
      supportsEvents: externalCalendars.supportsEvents,
      supportsTasks: externalCalendars.supportsTasks,
      providerDefaultCalendar: externalCalendars.providerDefaultCalendar,
      userID: externalCalendars.userID,
      accountID: externalCalendars.accountID,
      accountLabel: externalCalendars.accountLabel,
      serverUrl: caldavAccounts.serverUrl,
      syncStatus: account.syncStatus,
      syncErrorCode: account.syncErrorCode,
    })
    .from(externalCalendars)
    .leftJoin(
      caldavAccounts,
      eq(externalCalendars.accountID, sql`${caldavAccounts.id}::text`),
    )
    .leftJoin(
      account,
      and(
        eq(externalCalendars.provider, account.providerId),
        eq(externalCalendars.userID, account.userId),
        eq(externalCalendars.accountID, account.accountId),
      ),
    )
    .where(eq(externalCalendars.calendarID, calendarID));
  return res ?? null;
}

// --- events ---

export async function clearCalendarEvents(calendarID: string) {
  // Legacy reset helper: only the home calendar can tombstone shared content.
  // Keep links/mappings so authoritative upserts revive the SAME local ID.
  await db
    .update(events)
    .set({ deletedAt: new Date(), revision: sql`${events.revision} + 1` })
    .where(
      and(eq(events.originCalendarID, calendarID), isNull(events.deletedAt)),
    );
}

async function linkEventToCalendarsInTransaction(
  tx: DbTransaction,
  eventID: string,
  calendarIDs: string[],
) {
  if (calendarIDs.length === 0) return;
  await tx
    .insert(calendarEvents)
    .values(calendarIDs.map((c) => ({ eventID, calendarID: c })))
    .onConflictDoNothing({
      target: [calendarEvents.eventID, calendarEvents.calendarID],
    });
}

// Administrative/import link writer: lock and diff, so repeated links are no-ops.
export async function linkEventToCalendars(
  eventID: string,
  calendarIDs: string[],
) {
  await reconcileEventLinks(eventID, calendarIDs, [], false);
}

async function reconcileEventLinks(
  eventID: string,
  add: string[],
  remove: string[],
  tombstone: boolean,
) {
  return db.transaction(async (tx) => {
    await lockCalendarLifecycle(tx, add, "shared");
    const [row] = await tx
      .select()
      .from(events)
      .where(eq(events.id, eventID))
      .for("update");
    if (!row) return { remaining: [] as string[], removed: true };
    const links = await tx
      .select({ id: calendarEvents.calendarID })
      .from(calendarEvents)
      .where(eq(calendarEvents.eventID, eventID));
    const calendars = [
      ...new Set([
        ...links.map((link) => link.id).filter((id) => !remove.includes(id)),
        ...add,
      ]),
    ];
    if (row.deletedAt) return { remaining: calendars, removed: true };
    const result = await patchEventAndCalendarLinksInTransaction(
      tx,
      eventID,
      row.revision,
      { calendars },
      tombstone,
    );
    if (result.status !== "saved")
      throw new Error("Locked event revision changed unexpectedly");
    return {
      remaining: result.event.calendars,
      removed: result.event.deletedAt !== null,
    };
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
  await tx
    .delete(calendarEvents)
    .where(
      and(
        eq(calendarEvents.eventID, eventID),
        inArray(calendarEvents.calendarID, calendarIDs),
      ),
    );

  // Remote collection IDs can be shared across accounts/providers. Scope the
  // removal to the actual local mirrors, just like calendar_events above.
  await tx
    .delete(externalEvents)
    .where(
      and(
        eq(externalEvents.eventID, eventID),
        inArray(externalEvents.calendarID, calendarIDs),
      ),
    );
}

export async function unlinkEventFromCalendars(
  eventID: string,
  calendarIDs: string[],
) {
  await reconcileEventLinks(eventID, [], calendarIDs, false);
}

export type EventRevisionMutationResult =
  | { status: "not_found" }
  | {
      status: "conflict";
      current: typeof events.$inferSelect & { calendars: string[] };
    }
  | {
      status: "saved";
      changed: boolean;
      previous: typeof events.$inferSelect & { calendars: string[] };
      event: typeof events.$inferSelect & { calendars: string[] };
      patch: EventContentPatch;
      addedCalendarIDs: string[];
      removedCalendarIDs: string[];
    };

/** Event-before-link lock order matches inbound reconciliation. The revision
 * check, actual diff and every event/link/mapping write share this transaction.
 * Callers authorize/preflight first and deliver only after a saved result.
 */
export async function patchEventAndCalendarLinks(
  eventID: string,
  expectedRevision: number,
  input: EventContentPatch & { calendars?: string[] },
  tombstoneIfOrphaned = false,
  outbox: readonly EventOutboxIntent[] = [],
): Promise<EventRevisionMutationResult> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new TypeError("A positive expected event revision is required");
  }
  return db.transaction(async (tx) => {
    await lockCalendarLifecycle(tx, input.calendars ?? [], "shared");
    await reserveEventMutation(tx, eventID, outbox);
    const result = await patchEventAndCalendarLinksInTransaction(
      tx,
      eventID,
      expectedRevision,
      input,
      tombstoneIfOrphaned,
    );
    if (result.status === "saved" && result.changed)
      await appendEventOutbox(tx, result.event, outbox);
    return result;
  });
}

async function patchEventAndCalendarLinksInTransaction(
  tx: DbTransaction,
  eventID: string,
  expectedRevision: number,
  input: EventContentPatch & { calendars?: string[] },
  tombstoneIfOrphaned = false,
): Promise<EventRevisionMutationResult> {
  const [current] = await tx
    .select()
    .from(events)
    .where(eq(events.id, eventID))
    .for("update");
  if (!current) return { status: "not_found" };
  const links = await tx
    .select({ id: calendarEvents.calendarID })
    .from(calendarEvents)
    .where(eq(calendarEvents.eventID, eventID));
  const existing = links.map((link) => link.id);
  const previous = { ...current, calendars: existing };
  // Even a stale patch that looks empty against newer content is a conflict.
  if (current.revision !== expectedRevision || current.deletedAt !== null) {
    return { status: "conflict", current: previous };
  }
  const incoming =
    input.calendars === undefined ? existing : [...new Set(input.calendars.map((id) => id.toLowerCase()))];
  const addedCalendarIDs = incoming.filter((id) => !existing.includes(id));
  const removedCalendarIDs = existing.filter((id) => !incoming.includes(id));
  const patch = diffEventContent(current, input);
  assertLegacyEventTimePatch(current, patch);
  // Legacy unlink/delete must not remove an exception definition (resurrecting
  // its original slot) or strand children after removing a master. K12 owns
  // atomic family scope operations; even tombstoned children require that path.
  if (removedCalendarIDs.length || (tombstoneIfOrphaned && incoming.length === 0)) {
    const [child] = await tx.select({ id: events.id }).from(events)
      .where(eq(events.seriesID, eventID)).limit(1);
    if (current.seriesID || current.originalStart || child)
      throw new BadRequestError("This removal requires an occurrence-aware scope operation. No changes were saved.");
  }
  const deletedAt =
    tombstoneIfOrphaned && incoming.length === 0 ? new Date() : null;
  const changed =
    Object.keys(patch).length > 0 ||
    addedCalendarIDs.length > 0 ||
    removedCalendarIDs.length > 0 ||
    deletedAt !== null;
  if (!changed)
    return {
      status: "saved",
      changed,
      previous,
      event: previous,
      patch,
      addedCalendarIDs,
      removedCalendarIDs,
    };
  const [updated] = await tx
    .update(events)
    .set({
      ...patch,
      deletedAt,
      revision: sql`${events.revision} + 1`,
    })
    .where(and(eq(events.id, eventID), eq(events.revision, expectedRevision)))
    .returning();
  if (!updated) throw new Error("Locked event revision changed unexpectedly");
  await unlinkEventFromCalendarsInTransaction(tx, eventID, removedCalendarIDs);
  await linkEventToCalendarsInTransaction(tx, eventID, addedCalendarIDs);
  return {
    status: "saved",
    changed,
    previous,
    event: { ...updated, calendars: incoming },
    patch,
    addedCalendarIDs,
    removedCalendarIDs,
  };
}

/** Fork checks the source under the event lock in the same transaction that
 * creates the independent identity. It never copies the source revision. */
export async function forkEventAtRevision(
  sourceID: string,
  expectedRevision: number,
  event: NewEvent,
  calendarIDs: string[],
  outbox: readonly EventOutboxIntent[] = [],
) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    throw new TypeError("A positive expected event revision is required");
  return db.transaction(async (tx) => {
    await lockCalendarLifecycle(tx, [...calendarIDs, ...(event.originCalendarID ? [event.originCalendarID] : [])], "shared");
    await reserveEventMutation(tx, event.id!, outbox);
    const checked = await patchEventAndCalendarLinksInTransaction(
      tx,
      sourceID,
      expectedRevision,
      {},
    );
    if (checked.status !== "saved") return checked;
    if (hasKnownEventTime(checked.event))
      throw new BadRequestError("This event requires a time-model-aware copy. No changes were saved.");
    const created = await createEventInTransaction(tx, event, calendarIDs);
    await appendEventOutbox(tx, { ...created, calendars: calendarIDs }, outbox);
    return {
      status: "saved" as const,
      event: { ...created, calendars: calendarIDs },
    };
  });
}

// Delete a selected set of links and tombstone the event iff that leaves it
// orphaned. The returned link set is from the same transaction.
export async function unlinkEventAndTombstoneIfOrphaned(
  eventID: string,
  calendarIDs: string[],
) {
  return reconcileEventLinks(eventID, [], calendarIDs, true);
}

// Lock shared content before mapping/link rows, just like local mutations.
// Re-read the mapping after waiting: another unlink may have removed it while
// the first SELECT's snapshot still contained it.
async function mappedEventForUpdate(
  tx: DbTransaction,
  provider: string,
  calendarID: string,
  externalEventID: string,
) {
  const [mapped] = await tx
    .select({ id: externalEvents.id, event: events })
    .from(externalEvents)
    .innerJoin(events, eq(externalEvents.eventID, events.id))
    .where(
      and(
        eq(externalEvents.provider, provider),
        eq(externalEvents.calendarID, calendarID),
        eq(externalEvents.externalEventID, externalEventID),
      ),
    )
    .for("update", { of: events });
  if (!mapped) return undefined;
  const [mapping] = await tx
    .select()
    .from(externalEvents)
    .where(eq(externalEvents.id, mapped.id))
    .for("update");
  return mapping ? { ...mapping, event: mapped.event } : undefined;
}

/** Caller holds the calendar lifecycle lock. Complete Graph replacement uses
 * its exclusive mode, so a stale per-event delta/reset cannot race this check
 * and tombstone or partially overwrite a newly accepted canonical family. */
async function isTrackedGraphMapping(tx: DbTransaction, provider: string, mapped: NonNullable<Awaited<ReturnType<typeof mappedEventForUpdate>>>) {
  if (provider !== "microsoft") return false;
  const root = (value: typeof events.$inferSelect) => !value.seriesID && !!value.recurrence && ["zoned", "all-day"].includes(value.timeModel?.kind ?? "");
  if (root(mapped.event)) return true;
  if (!mapped.event.seriesID) return false;
  const [parent] = await tx.select().from(events).where(eq(events.id, mapped.event.seriesID));
  return !!parent && root(parent);
}

/**
 * Upsert a provider event. Returns TRUE when it actually wrote something —
 * the scheduled sync uses this to decide whether to wake connected clients.
 * With an etag (CalDAV) an unchanged, alive event is a verified no-op: no
 * write, no updatedAt bump, so the delta stays quiet too.
 */
export async function upsertExternalEvent(
  ...args: Parameters<typeof upsertExternalEventInTransaction> extends [DbTransaction, boolean, ...infer Rest] ? Rest : never
): Promise<boolean> {
  return db.transaction(tx => upsertExternalEventInTransaction(tx, false, ...args))
    .catch(() => { throw new Error("External event observation could not be persisted."); });
}

export type ExternalEventResourceObservation = {
  externalId: string;
  values: EventValues;
  etag: string | null;
  icalUid: string;
  time: ProviderTime;
  providerState?: ProviderEventState;
};

/** A private split owns both addresses until specialized full-resource ACK.
 * A component projection is never enough to adopt an unmapped new family. */
async function assertNoPendingCaldavResourceWrite(tx: DbTransaction, provider: string, userID: string, calendarID: string, externalCalendarID: string, resourceID: string) {
  if (provider !== "caldav") return false;
    const [splitPending] = await tx.select({ id: eventOutbox.id, split: sql<boolean>`${eventOutbox.payload}->'caldavSplit' is not null` }).from(eventOutbox).where(and(
      eq(eventOutbox.provider, provider), eq(eventOutbox.userID, userID), eq(eventOutbox.calendarID, calendarID),
      eq(eventOutbox.externalCalendarID, externalCalendarID), eq(eventOutbox.externalEventID, resourceID),
      sql`(${eventOutbox.payload}->'caldavSplit' is not null or ${eventOutbox.payload}->'caldavAlarm' is not null) and ${eventOutbox.status} not in ('completed', 'not-needed')`,
    )).limit(1);
    if (splitPending?.split) throw new Error("CalDAV split resource has pending local writes.");
    return !!splitPending;
}

/** A CalDAV GET replaces one whole resource, including omitted overrides. */
async function isRetiredCaldavRecurrence(tx: DbTransaction, provider: string, userID: string, calendarID: string, externalCalendarID: string, resourceID: string, etag?: string | null): Promise<boolean> {
  if (provider !== "caldav") return false;
  const [retired] = await tx.select({ id: eventOutbox.id }).from(eventOutbox)
    .innerJoin(externalCalendars, eq(externalCalendars.id, eventOutbox.externalCalendarLinkID))
    .where(and(eq(eventOutbox.provider, provider), eq(eventOutbox.userID, userID), eq(eventOutbox.calendarID, calendarID),
      eq(eventOutbox.externalCalendarID, externalCalendarID), eq(eventOutbox.externalEventID, resourceID),
      eq(eventOutbox.status, "completed"), eq(eventOutbox.action, "update"),
      sql`${eventOutbox.payload}->'caldavSeries'->'write'->'patch'->'recurrence' = 'null'::jsonb`,
      ...(etag ? [eq(eventOutbox.expectedEtag, etag)] : []))).limit(1);
  return !!retired;
}

export async function replaceExternalEventResource(
  provider: string, userID: string, calendarID: string, externalCalendarID: string,
  resourceID: string, observations: ExternalEventResourceObservation[], accessContext?: ExternalCalendarAccessContext,
): Promise<boolean> {
  return db.transaction(async tx => {
    await lockCalendarLifecycle(tx, [calendarID], "shared");
    await assertExternalCalendarAccess(tx, provider, calendarID, accessContext);
    await lockExternalEventAddress(tx, provider, calendarID, resourceID);
    const master = observations.find(item => item.externalId === resourceID && !item.time.externalSeriesID);
    if (!master || observations.filter(item => !item.time.externalSeriesID).length !== 1 || new Set(observations.map(item => item.externalId)).size !== observations.length)
      throw new Error("Invalid complete event resource.");
    if (observations.some(item => item.icalUid !== master.icalUid || (item !== master && item.time.externalSeriesID !== resourceID)))
      throw new Error("Inconsistent event resource identity.");
    if (await isRetiredCaldavRecurrence(tx, provider, userID, calendarID, externalCalendarID, resourceID, master.etag)) return false;
    // A snapshot fetched before a confirmed local DELETE must not resurrect
    // the same accepted resource version after its mappings have been removed.
    const [deletedVersion] = await tx.select({ id: eventOutbox.id }).from(eventOutbox).where(and(
      eq(eventOutbox.provider, provider), eq(eventOutbox.userID, userID), eq(eventOutbox.calendarID, calendarID), eq(eventOutbox.externalEventID, resourceID),
      eq(eventOutbox.status, "completed"), sql`((${eventOutbox.action} = 'delete' and ${eventOutbox.payload}->'caldavSeriesDeletion' is not null) or (${eventOutbox.action} = 'update' and (${eventOutbox.payload}->'caldavSeries'->'write'->'followingDelete' is not null or ${eventOutbox.payload}->'caldavSplit' is not null)))`,
      ...(master.etag ? [eq(eventOutbox.expectedEtag, master.etag)] : []),
    )).limit(1);
    if (deletedVersion) return false;
    if (master.etag) {
      const [resolvedVersion] = await tx.select({ id: eventOutbox.id }).from(eventOutbox).where(and(
        eq(eventOutbox.provider, provider), eq(eventOutbox.userID, userID), eq(eventOutbox.calendarID, calendarID),
        eq(eventOutbox.externalCalendarID, externalCalendarID), eq(eventOutbox.externalEventID, resourceID),
        eq(eventOutbox.status, "completed"), sql`((${eventOutbox.action} = 'delete' and ${eventOutbox.payload}->'caldavSeriesDeletion' is not null) or (${eventOutbox.action} = 'update' and (${eventOutbox.payload}->'caldavSeries'->'write'->'followingDelete' is not null or ${eventOutbox.payload}->'caldavSplit' is not null)))`,
        sql`exists (select 1 from jsonb_array_elements_text(coalesce(${eventOutbox.payload}->'resolution'->'replacedOperationIDs', '[]'::jsonb)) replaced(id)
          join event_outbox ancestor on ancestor.id = replaced.id::uuid
          where ancestor.expected_etag = ${master.etag}
            and ancestor.status = 'not-needed' and ancestor.error_code = 'superseded-by-resolution'
            and ancestor.provider = ${eventOutbox.provider} and ancestor.user_id = ${eventOutbox.userID}
            and ancestor.calendar_id = ${eventOutbox.calendarID} and ancestor.external_calendar_id = ${eventOutbox.externalCalendarID}
            and ancestor.external_calendar_link_id = ${eventOutbox.externalCalendarLinkID}
            and ancestor.external_event_id = ${eventOutbox.externalEventID} and ancestor.event_id = ${eventOutbox.eventID}
            and ((ancestor.action = 'update' and (ancestor.payload->'caldavSeries'->'write'->'followingDelete' is not null or ancestor.payload->'caldavSplit' is not null)) or (ancestor.action = 'delete' and ancestor.payload->'caldavSeriesDeletion' is not null)))`,
      )).limit(1);
      if (resolvedVersion) return false;
    }
    if (await assertNoPendingCaldavResourceWrite(tx, provider, userID, calendarID, externalCalendarID, resourceID)) return false;
    const mappings = await tx.select().from(externalEvents).where(and(
      eq(externalEvents.provider, provider), eq(externalEvents.calendarID, calendarID),
      sql`(${externalEvents.externalEventID} = ${resourceID} or ${externalEvents.externalSeriesID} = ${resourceID})`,
    ));
    const addresses = [...new Set([...mappings.map(item => item.externalEventID), ...observations.map(item => item.externalId)])].sort();
    for (const address of addresses) await lockExternalEventAddress(tx, provider, calendarID, address);
    // Lock the complete family before checking pending writes; a concurrent CAS
    // must not slip a new operation between this check and component updates.
    await mappedEventForUpdate(tx, provider, calendarID, resourceID);
    for (const mapping of [...mappings].sort((a, b) => a.eventID.localeCompare(b.eventID))) {
      const current = await mappedEventForUpdate(tx, provider, calendarID, mapping.externalEventID);
      if (current && (current.event.originCalendarID !== calendarID || current.event.creatorID !== userID)) throw new Error("Resource component is not authoritative.");
    }
    for (const mapping of mappings) {
      if (mapping.icalUid && mapping.icalUid !== master.icalUid) throw new Error("CalDAV resource UID replacement requires explicit reconciliation.");
      const pending = await tx.select({ id: eventOutbox.id }).from(eventOutbox).where(and(eq(eventOutbox.eventID, mapping.eventID), eq(eventOutbox.calendarID, calendarID), eq(eventOutbox.provider, provider), sql`${eventOutbox.status} not in ('completed', 'not-needed', 'cancelled')`)).limit(1);
      if (pending.length) throw new Error("CalDAV resource has pending local writes.");
    }
    let changed = false;
    for (const item of [master, ...observations.filter(item => item !== master)]) {
      changed = await upsertExternalEventInTransaction(tx, true, provider, userID, calendarID, externalCalendarID, item.externalId, item.values, item.etag, item.icalUid, undefined, item.time, undefined, item.providerState, undefined, undefined, accessContext) || changed;
    }
    const seen = new Set(observations.map(item => item.externalId));
    for (const mapping of mappings.filter(item => !seen.has(item.externalEventID))) {
      const current = await mappedEventForUpdate(tx, provider, calendarID, mapping.externalEventID);
      if (!current || current.event.deletedAt) continue;
      if (current.event.originCalendarID !== calendarID || current.event.creatorID !== userID) throw new Error("Resource override is not authoritative.");
      await tx.update(events).set({ deletedAt: new Date(), revision: sql`${events.revision} + 1` }).where(eq(events.id, current.event.id));
      await appendInboundEventFanout(tx, current.event.id, calendarID, "delete");
      changed = true;
    }
    const parent = await mappedEventForUpdate(tx, provider, calendarID, resourceID);
    if (!parent || parent.event.originCalendarID !== calendarID || parent.event.creatorID !== userID) throw new Error("Resource master is not authoritative.");
    const children = await tx.select().from(events).where(and(eq(events.seriesID, parent.event.id), isNull(events.deletedAt))).orderBy(events.id).for("share");
    expandRecurringEvents([parent.event, ...children].map(event => ({ ...event, calendars: [calendarID], isCanceled: false })), parent.event.start, parent.event.end, { consumerTimeZone: "UTC" });
    return changed;
  }).catch(() => { throw new Error("Complete external event resource could not be persisted."); });
}

async function upsertExternalEventInTransaction(
  tx: DbTransaction,
  deferFamilyValidation: boolean,
  provider: string,
  userID: string,
  calendarID: string,
  externalCalendarID: string,
  externalEventID: string,
  values: EventValues,
  etag: string | null = null,
  icalUid: string | null = null,
  creationOperationID?: string,
  time?: ProviderTime,
  providerOccurrence?: ProviderOccurrence,
  providerState?: ProviderEventState,
  reminderTimeEvidence?: ProviderSettingTimeEvidence,
  sourceSeriesID?: string,
  accessContext?: ExternalCalendarAccessContext,
): Promise<boolean> {
    const state = providerState === undefined ? undefined : ProviderEventStateSchema.parse(providerState);
    if (state && state.provider !== provider) throw new Error("Provider state does not match its destination.");
    await lockCalendarLifecycle(tx, [calendarID], "shared");
    const access = await assertExternalCalendarAccess(tx, provider, calendarID, accessContext);
    if (provider === "microsoft") await assertNoPendingGraphSeriesCreate(tx, calendarID);
    await lockExternalEventAddress(tx, provider, calendarID, externalEventID);
    if (provider === "microsoft") {
      const [link] = await tx.select({ id: externalCalendars.id }).from(externalCalendars).where(eq(externalCalendars.calendarID, calendarID));
      if (link && await isCancelledGraphMeeting(tx, link.id, externalEventID, sourceSeriesID ?? providerOccurrence?.externalSeriesID ?? time?.externalSeriesID ?? undefined)) return false;
    }
    // Google retains cancelled exceptions as active-shaped projections. Their
    // reconstructed master content is not an edit of the stored exception.
    // Retain only an exact cancellation observation for the immutable intent;
    // acceptance still requires the worker's native read and accepted marker.
    if (provider === "google" && time?.isCanceled === true && time.externalSeriesID && time.originalStart) {
      const [candidate] = await tx.select().from(eventOutbox).where(and(
        eq(eventOutbox.provider, provider), eq(eventOutbox.actorID, userID), eq(eventOutbox.userID, userID),
        eq(eventOutbox.calendarID, calendarID), eq(eventOutbox.externalCalendarID, externalCalendarID),
        eq(eventOutbox.externalEventID, externalEventID), eq(eventOutbox.action, "delete"),
        sql`${eventOutbox.status} not in ('cancelled', 'not-needed')`,
        sql`${eventOutbox.payload}->'organizer'->'instance' is not null`,
      )).orderBy(sql`${eventOutbox.revision} desc`).limit(1);
      const intent = candidate?.payload.organizer;
      if (candidate && intent?.instance) {
        const map = await mappedEventForUpdate(tx, provider, calendarID, externalEventID);
        const [link] = await tx.select().from(externalCalendars).where(and(
          eq(externalCalendars.id, candidate.externalCalendarLinkID), eq(externalCalendars.userID, userID),
          eq(externalCalendars.provider, provider), eq(externalCalendars.accountID, candidate.accountID),
          eq(externalCalendars.calendarID, calendarID), eq(externalCalendars.externalCalendarID, externalCalendarID), eq(externalCalendars.disabled, false),
        )).for("share");
        const original = OccurrenceStartSchema.parse(time.originalStart);
        const tombstone = intent.dispatch?.cancellationTombstone;
        const sameRevision = map?.event.revision === candidate.revision && map.event.deletedAt === null ||
          !!intent.dispatch?.acceptedAt && !!tombstone && map?.event.revision === candidate.revision + 1 && map.event.revision === tombstone.revision && map.event.deletedAt?.toISOString() === tombstone.deletedAt;
        if (link && map && sameRevision && map.event.isCanceled && map.event.creatorID === userID && map.event.originCalendarID === calendarID &&
          map.id === intent.mappingID && map.event.id === candidate.eventID && map.etag === candidate.expectedEtag &&
          map.event.seriesID === intent.instance.seriesID && map.externalSeriesID === intent.instance.externalSeriesID &&
          sameTimeMetadata(map.originalStart, intent.instance.originalStart) && sameTimeMetadata(map.event.originalStart, intent.instance.originalStart)) {
          const matches = time.externalSeriesID === intent.instance.externalSeriesID && sameTimeMetadata(original, intent.instance.originalStart);
          await tx.update(eventOutbox).set({
            ...(!matches && candidate.status === "completed" ? { status: "conflict" as const, errorCode: "provider-conflict" } : {}),
            remoteSnapshot: { externalEventId: externalEventID, etag, icalUid, deleted: matches, observedAt: new Date().toISOString() },
          }).where(and(eq(eventOutbox.id, candidate.id), eq(eventOutbox.revision, candidate.revision)));
          // This branch already holds the child. A mismatched slot must never
          // fall through to general ingestion, which locks its parent first.
          return false;
        }
        throw new Error("Organizer cancellation source changed. Reconcile before applying.");
      }
    }
    // A completed organizer cancellation must not be silently resurrected by
    // an active late pull. Retain it for read-only reconciliation of the same
    // permanently marked action; never recreate or send another cancellation.
    if (provider === "google" || provider === "caldav") {
      const [cancelled] = await tx.select({ id: eventOutbox.id, eventID: eventOutbox.eventID }).from(eventOutbox).where(and(eq(eventOutbox.provider, provider), eq(eventOutbox.userID, userID), eq(eventOutbox.calendarID, calendarID), eq(eventOutbox.externalCalendarID, externalCalendarID), eq(eventOutbox.externalEventID, externalEventID), eq(eventOutbox.action, "delete"), eq(eventOutbox.status, "completed"), sql`${eventOutbox.payload}->'organizer'->'dispatch' is not null`)).limit(1);
      if (cancelled) { await tx.select({ id: events.id }).from(events).where(eq(events.id, cancelled.eventID)).for("update"); await tx.update(eventOutbox).set({ status: "conflict", errorCode: "provider-conflict", remoteSnapshot: { externalEventId: externalEventID, etag, icalUid, deleted: false, observedAt: new Date().toISOString(), values: JSON.parse(JSON.stringify(values)), ...(state ? { providerState: state } : {}) } }).where(eq(eventOutbox.id, cancelled.id)); return false; }
    }

    if (sourceSeriesID !== undefined) {
      if (provider !== "microsoft" || !sourceSeriesID.trim() || sourceSeriesID.trim() !== sourceSeriesID || sourceSeriesID === externalEventID)
        throw new Error("Invalid source series address.");
      const [tracked] = await tx.select({ id: events.id }).from(externalEvents)
        .innerJoin(events, eq(events.id, externalEvents.eventID))
        .where(and(eq(externalEvents.provider, provider), eq(externalEvents.calendarID, calendarID), eq(externalEvents.externalCalendarID, externalCalendarID), eq(externalEvents.externalEventID, sourceSeriesID),
          sql`${events.seriesID} is null and ${events.recurrence} is not null and ${events.recurrence} <> '' and ${events.timeModel}->>'kind' in ('zoned', 'all-day')`)).limit(1);
      // The calendar shared lifecycle lock serializes this check with complete
      // family acceptance. Do not create a standalone echo of its native child.
      if (tracked) return false;
    }

    if (!deferFamilyValidation && await isRetiredCaldavRecurrence(tx, provider, userID, calendarID, externalCalendarID, time?.externalSeriesID ?? externalEventID, etag)) return false;
    if (!deferFamilyValidation && await assertNoPendingCaldavResourceWrite(tx, provider, userID, calendarID, externalCalendarID, time?.externalSeriesID ?? externalEventID)) return false;
    const expandedIdentity = providerOccurrence ? {
      externalSeriesID: providerOccurrence.externalSeriesID,
      originalStart: OccurrenceStartSchema.parse(providerOccurrence.originalStart),
    } : undefined;
    if (expandedIdentity && (provider !== "microsoft" || !expandedIdentity.externalSeriesID || expandedIdentity.externalSeriesID === externalEventID || time?.externalSeriesID || values.recurrence))
      throw new Error("Invalid provider-expanded occurrence identity.");
    let temporal: { timeModel: EventTimeModel; seriesID: string | null; originalStart: OccurrenceStart | null; isCanceled: boolean } | undefined;
    if (time) {
      const model = EventTimeModelSchema.parse(time.timeModel);
      const original = time.originalStart == null ? null : OccurrenceStartSchema.parse(time.originalStart);
      if (!!time.externalSeriesID !== !!original || time.externalSeriesID === externalEventID)
        throw new Error("Invalid provider occurrence identity.");
      let parent;
      if (time.externalSeriesID) {
        parent = await mappedEventForUpdate(tx, provider, calendarID, time.externalSeriesID);
        if (!parent || parent.event.deletedAt || parent.event.seriesID || !parent.event.recurrence || parent.event.originCalendarID !== calendarID || parent.event.creatorID !== userID)
          throw new Error("Provider occurrence requires an authoritative local master.");
        const pending = await tx.select({ id: eventOutbox.id }).from(eventOutbox).where(and(eq(eventOutbox.eventID, parent.event.id), eq(eventOutbox.calendarID, calendarID), eq(eventOutbox.provider, provider), sql`${eventOutbox.status} not in ('completed', 'not-needed', 'cancelled')`)).limit(1);
        if (pending.length) throw new Error("Provider series has a pending local operation. Retry after reconciliation.");
      }
      temporal = { timeModel: model, seriesID: parent?.event.id ?? null, originalStart: original, isCanceled: time.isCanceled ?? false };
      const candidate = { ...values, ...temporal, id: crypto.randomUUID(), creatorID: userID, calendars: [calendarID], hasAttendees: false, isCanceled: false };
      expandRecurringEvents(parent ? [{ ...parent.event, calendars: [calendarID], isCanceled: false }, candidate] : [candidate], values.start, values.end, { consumerTimeZone: "UTC" });
    }
    const nativeSettingTime = reminderTimeEvidence && "timeModel" in reminderTimeEvidence ? reminderTimeEvidence : undefined;
    if (nativeSettingTime && (!(nativeSettingTime.start instanceof Date) || !Number.isFinite(nativeSettingTime.start.getTime()) || !(nativeSettingTime.end instanceof Date) || !Number.isFinite(nativeSettingTime.end.getTime()) || typeof nativeSettingTime.isAllDay !== "boolean")) throw new Error("Invalid setting time evidence.");
    const pendingTemporal = temporal ?? (nativeSettingTime ? { timeModel: EventTimeModelSchema.parse(nativeSettingTime.timeModel), start: nativeSettingTime.start, end: nativeSettingTime.end, isAllDay: nativeSettingTime.isAllDay } : reminderTimeEvidence ? { timeModel: EventTimeModelSchema.parse(reminderTimeEvidence) } : undefined);
    let map = await mappedEventForUpdate(
      tx,
      provider,
      calendarID,
      externalEventID,
    );

    if (!map && provider === "caldav" && temporal?.seriesID && temporal.originalStart) {
      const [historical] = await tx.select().from(events).where(and(eq(events.seriesID, temporal.seriesID), sql`${events.originalStart} = ${JSON.stringify(temporal.originalStart)}::jsonb`, isNotNull(events.deletedAt))).for("update");
      if (historical) {
        const [receipt] = await tx.select({ id: eventOutbox.id }).from(eventOutbox).where(and(
          eq(eventOutbox.provider, provider), eq(eventOutbox.userID, userID), eq(eventOutbox.calendarID, calendarID), eq(eventOutbox.externalEventID, time!.externalSeriesID!),
          eq(eventOutbox.status, "completed"), eq(eventOutbox.action, "update"), sql`${eventOutbox.payload}->'caldavSeries'->'write'->'followingDelete' is not null`,
          sql`${eventOutbox.payload}->'caldavSeries'->'context'->'mappings' @> ${JSON.stringify([{ eventID: historical.id, externalEventID }])}::jsonb`,
        )).limit(1);
        const oldMaps = await tx.select({ id: externalEvents.id }).from(externalEvents).where(eq(externalEvents.eventID, historical.id));
        const memberships = await tx.select().from(calendarEvents).where(eq(calendarEvents.eventID, historical.id));
        const pending = await tx.select({ id: eventOutbox.id }).from(eventOutbox).where(and(eq(eventOutbox.eventID, historical.id), sql`${eventOutbox.status} not in ('completed', 'not-needed')`)).limit(1);
        if (!receipt || historical.creatorID !== userID || historical.originCalendarID !== calendarID || oldMaps.length || pending.length || memberships.length !== 1 || memberships[0]!.calendarID !== calendarID) throw new Error("Historical occurrence requires explicit reconciliation.");
        // Reuse the tombstone's unique original identity. The normal mapped
        // inbound path below performs revival, revision increment and fanout.
        await tx.insert(externalEvents).values({ provider, eventID: historical.id, calendarID, externalCalendarID, externalEventID, etag: null, icalUid, externalSeriesID: time!.externalSeriesID!, originalStart: temporal.originalStart });
        map = await mappedEventForUpdate(tx, provider, calendarID, externalEventID);
      }
    }
    if (map) {
      if (await isTrackedGraphMapping(tx, provider, map)) return false;
      const stateChanged = state !== undefined && JSON.stringify(map.providerState == null ? null : ProviderEventStateSchema.parse(map.providerState)) !== JSON.stringify(state);
      if (expandedIdentity && map.externalSeriesID && (map.externalSeriesID !== expandedIdentity.externalSeriesID || !sameTimeMetadata(map.originalStart, expandedIdentity.originalStart)))
        throw new Error("Provider-expanded occurrence identity cannot change.");
      if (expandedIdentity && !map.externalSeriesID) {
        const pending = await tx.select({ id: eventOutbox.id }).from(eventOutbox).where(and(eq(eventOutbox.eventID, map.event.id), eq(eventOutbox.calendarID, calendarID), eq(eventOutbox.provider, provider), sql`${eventOutbox.status} not in ('completed', 'not-needed', 'cancelled')`)).limit(1);
        if (pending.length) throw new Error("Occurrence identity adoption must wait for the pending source operation.");
      }
      if (temporal && !temporal.seriesID && !deferFamilyValidation) {
        const children = await tx.select().from(events).where(eq(events.seriesID, map.event.id)).orderBy(events.id).for("share");
        if (children.length) expandRecurringEvents([
          { ...map.event, ...values, ...temporal, calendars: [calendarID], isCanceled: false },
          ...children.map(child => ({ ...child, calendars: [calendarID], isCanceled: false })),
        ], values.start, values.end, { consumerTimeZone: "UTC" });
      }

      if (map.readRedactionRevision !== null && !accessContext) throw new Error("Redacted mirror requires fresh access context.");
      if (map.readRedactionRevision !== null && provider === "microsoft" && microsoftPrivateAccess(access?.role ?? null) === null) throw new Error("Microsoft private-read evidence is unknown.");
      const restoringRead = map.readRedactionRevision !== null && (["microsoft", "caldav"].includes(provider) || map.readRedactionRevision === map.event.revision);
      // A limited-grant marker survives accepted reads so a later fuller read
      // can restore same-ETag details. Only the first post-redaction observation
      // and full-grant restoration suppress fanout; subsequent native changes
      // under the same limited grant remain ordinary inbound updates.
      const privacyRestoration = restoringRead && (map.etag === null || !!access && hasFullProviderReadAccess(provider, access.role));
      const readRecovery = provider === "google" && state && accessContext ? await googlePersonalReadRecovery(tx, map.event, map, accessContext) : undefined;
      if (!restoringRead && !readRecovery && !stateChanged && (!expandedIdentity || (map.externalSeriesID === expandedIdentity.externalSeriesID && sameTimeMetadata(map.originalStart, expandedIdentity.originalStart))) && etag !== null && map.etag === etag && map.event.deletedAt === null && (!temporal || (sameTimeMetadata(map.event.timeModel, temporal.timeModel) && map.event.seriesID === temporal.seriesID && sameTimeMetadata(map.event.originalStart, temporal.originalStart) && map.event.isCanceled === temporal.isCanceled)))
      {
        // Older Graph one-off imports omitted UID. Enrich only this accepted
        // source mapping; no canonical revision, event delta or fanout changes.
        if (provider === "microsoft" && !map.icalUid && icalUid && map.event.originCalendarID === calendarID && !map.event.seriesID && !map.event.originalStart && !map.event.recurrence && !map.event.isCanceled && !map.externalSeriesID && !map.originalStart && map.externalCalendarID === externalCalendarID && state?.eventType === "singleInstance")
          await tx.update(externalEvents).set({ icalUid }).where(and(eq(externalEvents.id, map.id), isNull(externalEvents.icalUid)));
        // An unchanged baseline is not a conflict with a queued local write.
        // It can still supersede a previously retained personal observation.
        if (state !== undefined) await retainPendingEventPull(tx, map.event.id, calendarID, provider, externalEventID, { ...values, ...pendingTemporal, ...expandedIdentity }, etag, icalUid, state, true);
        return false;
      }
      const retained = await retainPendingEventPull(tx, map.event.id, calendarID, provider, externalEventID, { ...values, ...pendingTemporal, ...expandedIdentity }, etag, icalUid, state);
      if (retained && !readRecovery) return false;
      if (map.event.originCalendarID !== calendarID) {
        const changedFields = (
          Object.keys(values) as (keyof EventValues)[]
        ).filter((key) => {
          // Mirror color is presentation, not provider event content.
          if (key === "color") return false;
          const incoming = values[key];
          const current = map.event[key];
          return incoming instanceof Date && current instanceof Date
            ? incoming.getTime() !== current.getTime()
            : incoming !== current;
        });
        // A linked copy is not a second writer, even when the same user owns
        // both calendars. Unknown legacy origins must also fail closed. Leave
        // its old ETag intact: rejecting content must not acknowledge it for a
        // later conditional write. Log field names only, never provider data.
        if (changedFields.length || map.event.deletedAt !== null) {
          logger.warn("sync.event.non_origin_update_rejected", {
            provider,
            calendarId: calendarID,
            eventId: map.event.id,
            originCalendarId: map.event.originCalendarID,
            changedFields,
          });
        }
        return false;
      }
      // Provider version changes are not necessarily content changes. Persist
      // the accepted validator without waking delta readers for identical polls.
      const patch = diffEventContent(map.event, values);
      const contentChanged = map.event.deletedAt !== null || Object.keys(patch).length > 0 || !!(temporal && map.event.isCanceled !== temporal.isCanceled);
      if (!temporal) assertLegacyEventTimePatch(map.event, patch);
      else {
        if (map.event.seriesID && (map.event.seriesID !== temporal.seriesID || !sameTimeMetadata(map.event.originalStart, temporal.originalStart)))
          throw new Error("Provider occurrence identity cannot change.");
        for (const key of ["timeModel", "seriesID", "originalStart", "isCanceled"] as const)
          if (!sameTimeMetadata(map.event[key], temporal[key])) Object.assign(patch, { [key]: temporal[key] });
      }
      const changed =
        Object.keys(patch).length > 0 || map.event.deletedAt !== null;
      if (changed) {
        await tx
          .update(events)
          .set({
            ...patch,
            deletedAt: null,
            revision: sql`${events.revision} + 1`,
          })
          .where(eq(events.id, map.event.id));
      }
      await tx
        .update(externalEvents)
        .set({ etag, ...(restoringRead ? { readRedactionRevision: access && hasFullProviderReadAccess(provider, access.role) ? null : map.event.revision + Number(changed) } : {}), ...(state !== undefined ? { providerState: state, providerStateObservedAt: new Date() } : {}), icalUid: icalUid ?? map.icalUid, ...(time ? { externalSeriesID: time.externalSeriesID ?? null, originalStart: temporal!.originalStart } : {}), ...expandedIdentity })
        .where(eq(externalEvents.id, map.id));
      if (readRecovery) await finishGooglePersonalReadRecovery(tx, readRecovery, map.event.revision + Number(changed));
      if (changed && contentChanged && !readRecovery && !privacyRestoration) await appendInboundEventFanout(tx, map.event.id, calendarID, "update", patch);
      return changed || stateChanged;
    } else {
      if (await retainUnmappedCreatePull(tx, provider, userID, calendarID, externalCalendarID, externalEventID, { ...values, ...temporal }, etag, icalUid, creationOperationID, state)) return false;
      const [ev] = await tx
        .insert(events)
        // Home calendar = the mirror it was imported into (matches createEvent's
        // rule) — drives the origin star + edit-permission gating.
        .values({
          id: crypto.randomUUID(),
          ...values,
          ...temporal,
          creatorID: userID,
          originCalendarID: calendarID,
        })
        .returning();
      await tx.insert(calendarEvents).values({ eventID: ev.id, calendarID });
      await tx.insert(externalEvents).values({
        readRedactionRevision: provider === "microsoft" && microsoftPrivateAccess(access?.role ?? null) === false ? ev.revision : null,
        provider,
        eventID: ev.id,
        calendarID,
        externalCalendarID,
        externalEventID,
        etag,
        icalUid,
        ...(time ? { externalSeriesID: time.externalSeriesID ?? null, originalStart: temporal!.originalStart } : {}),
        ...expandedIdentity,
        ...(state !== undefined ? { providerState: state, providerStateObservedAt: new Date() } : {}),
      });
    }
    return true;
}

/**
 * A provider deletion is authoritative only in the event's home calendar.
 * Other copies lose their own link/mapping, never the shared event. Returns
 * TRUE for an actual unlink or tombstone; repeated deletions are no-ops.
 */
export async function deleteExternalEvent(
  provider: string,
  calendarID: string,
  externalEventID: string,
  onUnlink?: (eventID: string, revision: number) => void,
  accessContext?: ExternalCalendarAccessContext,
): Promise<boolean> {
  let unlinked: { id: string; revision: number } | undefined;
  const changed = await db.transaction(async (tx) => {
    await lockCalendarLifecycle(tx, [calendarID], "shared");
    await assertExternalCalendarAccess(tx, provider, calendarID, accessContext);
    // Resource writers lock the root before components. A missing child from a
    // reset must use the same fence even after a split reparents it locally.
    const [address] = provider === "caldav" ? await tx.select({ resource: externalEvents.externalSeriesID }).from(externalEvents).where(and(eq(externalEvents.provider, provider), eq(externalEvents.calendarID, calendarID), eq(externalEvents.externalEventID, externalEventID))) : [];
    if (address?.resource) await lockExternalEventAddress(tx, provider, calendarID, address.resource);
    if (provider === "microsoft") await assertNoPendingGraphSeriesCreate(tx, calendarID);
    await lockExternalEventAddress(tx, provider, calendarID, externalEventID);
    const mapped = await mappedEventForUpdate(
      tx,
      provider,
      calendarID,
      externalEventID,
    );
    if (!mapped) {
      await retainUnmappedEventDeletion(tx, provider, calendarID, externalEventID);
      return false;
    }
    if (await isTrackedGraphMapping(tx, provider, mapped)) return false;
    if (provider === "caldav") {
      if ((mapped.externalSeriesID ?? null) !== (address?.resource ?? null)) throw new Error("CalDAV resource address changed during deletion.");
      const [family] = await tx.select().from(eventOutbox).where(and(
        eq(eventOutbox.provider, provider), eq(eventOutbox.userID, mapped.event.creatorID), eq(eventOutbox.calendarID, calendarID),
        eq(eventOutbox.externalEventID, mapped.externalSeriesID ?? externalEventID),
        sql`${eventOutbox.status} not in ('completed', 'not-needed')`,
        sql`(${eventOutbox.status} <> 'cancelled' or ${eventOutbox.errorCode} is distinct from 'superseded-by-resolution')`,
        sql`coalesce(${eventOutbox.payload}->'caldavSplit'->'prepared'->'context'->'mappings', ${eventOutbox.payload}->'caldavSeries'->'context'->'mappings', ${eventOutbox.payload}->'caldavSeriesDeletion'->'context'->'mappings') @> ${JSON.stringify([{ eventID: mapped.event.id, externalEventID }])}::jsonb`,
      )).for("update");
      if (family) {
        const removedByIntent = !!family.payload.caldavSeriesDeletion ||
          !!family.payload.caldavSplit?.after.moved.some(child => child.id === mapped.event.id) ||
          !!(family.payload.caldavSeries?.write.followingDelete && mapped.event.id !== family.eventID && !caldavSeriesDesired(family.payload.caldavSeries.write).children.some(child => child.id === mapped.event.id));
        if (removedByIntent && family.attempts > 0) {
          // An expected component removal is only a candidate echo. The full
          // native readback and lease/family ACK still have to establish success.
          if (!family.remoteSnapshot || family.remoteSnapshot.isEcho) await tx.update(eventOutbox).set({ remoteSnapshot: { isEcho: true, externalEventId: externalEventID, etag: null, icalUid: mapped.icalUid, deleted: true, observedAt: new Date().toISOString() } }).where(eq(eventOutbox.id, family.id));
          return false;
        }
        await tx.update(eventOutbox).set({ status: family.status === "cancelled" ? "cancelled" : "conflict", errorCode: family.status === "cancelled" ? family.errorCode : "provider-conflict", leaseToken: null, leaseUntil: null, updatedAt: new Date(), remoteSnapshot: { externalEventId: externalEventID, etag: null, icalUid: mapped.icalUid, deleted: true, observedAt: new Date().toISOString() } }).where(eq(eventOutbox.id, family.id));
        return false;
      }
    }
    if (await retainPendingEventPull(tx, mapped.event.id, calendarID, provider, externalEventID, null, null, mapped.icalUid)) return false;

    if (mapped.event.originCalendarID !== calendarID) {
      await unlinkEventFromCalendarsInTransaction(tx, mapped.event.id, [
        calendarID,
      ]);
      await tx
        .update(events)
        .set({ revision: sql`${events.revision} + 1` })
        .where(eq(events.id, mapped.event.id));
      unlinked = { id: mapped.event.id, revision: mapped.event.revision + 1 };
      return true;
    }
    // Deleting a provider master must not strand its visible exceptions. Keep
    // mappings for stable revival; unresolved child work normally blocks removal.
    const children = await tx.select().from(events).where(eq(events.seriesID, mapped.event.id)).orderBy(events.id).for("update");
    for (const child of children) {
      if (child.originCalendarID !== calendarID || child.creatorID !== mapped.event.creatorID)
        throw new Error("Provider family removal crosses event authority.");
      const pending = await tx.select().from(eventOutbox).where(and(eq(eventOutbox.eventID, child.id), eq(eventOutbox.calendarID, calendarID), eq(eventOutbox.provider, provider), sql`${eventOutbox.status} not in ('completed', 'not-needed', 'cancelled')`)).orderBy(eventOutbox.id).for("update");
      if (pending.length) {
        // An authoritative Google master deletion makes an unsupported instance
        // defaults intent obsolete. Retain its history as cancelled, never as
        // delivered; all other pending work still requires explicit reconciliation.
        const [source] = await tx.select().from(externalCalendars).where(and(eq(externalCalendars.calendarID, calendarID), eq(externalCalendars.provider, provider), eq(externalCalendars.userID, child.creatorID), eq(externalCalendars.disabled, false))).for("share");
        const childMappings = await tx.select().from(externalEvents).where(and(eq(externalEvents.eventID, child.id), eq(externalEvents.calendarID, calendarID), eq(externalEvents.provider, provider))).for("update");
        const childMapping = childMappings.length === 1 ? childMappings[0] : undefined;
        const canRetire = provider === "google" && !!mapped.event.recurrence && !mapped.event.seriesID && !mapped.externalSeriesID && !mapped.originalStart && source && childMapping && pending.every(row => {
          const intent = row.payload.reminderInstance;
          const request = ProviderReminderEditSchema.safeParse(intent?.request);
          return !!intent && request.success && request.data.reminders.useDefault &&
            ["conflict", "blocked"].includes(row.status) && !row.leaseToken && !row.leaseUntil &&
            row.action === "update" && row.actorID === child.creatorID && row.userID === child.creatorID &&
            row.externalCalendarLinkID === source.id && row.accountID === source.accountID &&
            row.externalCalendarID === source.externalCalendarID && childMapping.externalCalendarID === source.externalCalendarID &&
            row.externalEventID === childMapping.externalEventID && intent.mappingID === childMapping.id &&
            row.revision === child.revision && row.payload.event.id === child.id && row.payload.event.originCalendarID === calendarID &&
            intent.instance.seriesID === mapped.event.id && intent.instance.parentRevision === mapped.event.revision &&
            intent.instance.parentMappingID === mapped.id && intent.instance.externalSeriesID === externalEventID &&
            childMapping.externalSeriesID === externalEventID && !!child.originalStart &&
            sameTimeMetadata(intent.instance.originalStart, child.originalStart) && sameTimeMetadata(childMapping.originalStart, child.originalStart) &&
            !row.payload.rsvp && !row.payload.organizer && !row.payload.reminderEdit;
        });
        if (!canRetire) throw new Error("Provider family removal has a pending child. Retry after reconciliation.");
        for (const row of pending) await tx.update(eventOutbox).set({ status: "cancelled", errorCode: "source-deleted-unsupported-reminders", updatedAt: new Date(), remoteSnapshot: { externalEventId: row.externalEventID!, etag: null, deleted: true, observedAt: new Date().toISOString() } }).where(eq(eventOutbox.id, row.id));
      }
    }
    for (const child of children) if (child.deletedAt === null) {
      await tx.update(events).set({ deletedAt: new Date(), revision: sql`${events.revision} + 1` }).where(eq(events.id, child.id));
      await appendInboundEventFanout(tx, child.id, calendarID, "delete");
    }
    if (mapped.event.deletedAt !== null) return children.some(child => child.deletedAt === null);
    // Record only this exact accepted cancellation's ordinary deletion transition.
    // Later reconciliation may accept this tombstone, never unrelated edits/deletes.
    const deletedAt = new Date();
    if ((provider === "google" || provider === "caldav") && mapped.event.isCanceled) {
      const cancellations = await tx.select().from(eventOutbox).where(and(eq(eventOutbox.eventID, mapped.event.id), eq(eventOutbox.calendarID, calendarID), eq(eventOutbox.provider, provider), eq(eventOutbox.externalEventID, externalEventID), eq(eventOutbox.revision, mapped.event.revision), eq(eventOutbox.status, "completed"), eq(eventOutbox.action, "delete"))).for("update");
      for (const row of cancellations) {
        const intent = row.payload.organizer;
        if (!intent?.dispatch?.acceptedAt || intent.mappingID !== mapped.id || row.actorID !== row.userID || row.payload.event.originCalendarID !== calendarID || intent.sourceEvent.id !== mapped.event.id || intent.sourceEvent.creatorID !== mapped.event.creatorID) continue;
        await tx.update(eventOutbox).set({ payload: { ...row.payload, organizer: { ...intent, dispatch: { ...intent.dispatch, cancellationTombstone: { revision: mapped.event.revision + 1, deletedAt: deletedAt.toISOString() } } } } }).where(eq(eventOutbox.id, row.id));
      }
    }
    // Retain authoritative mappings/links for tombstone deltas and revival.
    await tx
      .update(events)
      .set({ deletedAt, revision: sql`${events.revision} + 1` })
      .where(eq(events.id, mapped.event.id));
    await appendInboundEventFanout(tx, mapped.event.id, calendarID, "delete");
    return true;
  }).catch(() => { throw new Error("External event deletion could not be persisted."); });
  // Emit receipts only after commit, never for rolled-back link changes.
  if (unlinked) onUnlink?.(unlinked.id, unlinked.revision);
  return changed;
}

/** Reconcile a complete snapshot using the same authority rules as delta deletes. */
export async function sweepExternalEvents(
  provider: string,
  calendarID: string,
  seenExternalEventIDs: string[],
  onUnlink?: (eventID: string, revision: number) => void,
  accessContext?: ExternalCalendarAccessContext,
): Promise<number> {
  if (accessContext) await db.transaction(async tx => {
    await lockCalendarLifecycle(tx, [calendarID], "shared");
    await assertExternalCalendarAccess(tx, provider, calendarID, accessContext);
  });
  const mappings = await db
    .select({
      externalEventID: externalEvents.externalEventID,
    })
    .from(externalEvents)
    .where(
      and(
        eq(externalEvents.provider, provider),
        eq(externalEvents.calendarID, calendarID),
      ),
    );
  const seen = new Set(seenExternalEventIDs);
  let changed = 0;
  // ponytail: one transaction per missing resource; batch only if large reset
  // sweeps are measurably slow. Delta and reset must share deletion semantics.
  for (const mapping of mappings) {
    if (
      !seen.has(mapping.externalEventID) &&
      (await deleteExternalEvent(
        provider,
        calendarID,
        mapping.externalEventID,
        onUnlink,
        accessContext,
      ))
    )
      changed++;
  }
  return changed;
}

/** Include connected accounts before their first mirror exists. */
export async function getExternalSyncUserIDs(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userID: externalCalendars.userID })
    .from(externalCalendars);
  const caldav = await db
    .selectDistinct({ userID: caldavAccounts.userID })
    .from(caldavAccounts);
  const oauth = await db
    .select({
      userID: account.userId,
      provider: account.providerId,
      scope: account.scope,
      refreshToken: account.refreshToken,
      syncStatus: account.syncStatus,
      syncErrorCode: account.syncErrorCode,
    })
    .from(account)
    .where(inArray(account.providerId, ["google", "microsoft"]));
  const eligible = oauth.filter(
    (row) =>
      row.refreshToken &&
      hasProviderSyncScopes(row.provider, row.scope ?? "") &&
      (row.syncStatus === "active" ||
        (row.syncStatus === "reconnect_required" &&
          row.syncErrorCode === "insufficient_scope")),
  );
  return [
    ...new Set([...rows, ...caldav, ...eligible].map((row) => row.userID)),
  ];
}

// For push update/delete: find the external id of an already-synced Musubi event.
export type TaskSyncScope = { sourceID: string; accountID: string; providerAccessRevision: number; readStartedAt?: Date };

export async function getTaskMirrorReadCalendars(calendarID: string) {
  const links = await db.selectDistinct({ calendarID: calendarTasks.calendarID }).from(calendarTasks).innerJoin(tasks, eq(calendarTasks.taskID, tasks.id)).where(eq(tasks.originCalendarID, calendarID));
  return [...new Set([calendarID, ...links.map(link => link.calendarID)])];
}

async function assertTaskSyncScope(tx: DbTransaction, provider: string, calendarID: string, externalCalendarID: string | undefined, scope?: TaskSyncScope) {
  if (!scope) return;
  const [source] = await tx.select().from(externalCalendars).where(and(eq(externalCalendars.id, scope.sourceID), eq(externalCalendars.calendarID, calendarID), eq(externalCalendars.provider, provider), eq(externalCalendars.accountID, scope.accountID), externalCalendarID ? eq(externalCalendars.externalCalendarID, externalCalendarID) : undefined, eq(externalCalendars.providerAccessRevision, scope.providerAccessRevision), eq(externalCalendars.supportsTasks, true), eq(externalCalendars.disabled, false))).for("share");
  if (!source || source.providerAccessRole?.startsWith("caldav:read=no;")) throw new Error("Task source access changed during sync.");
}

function taskOriginPullPatch(provider: string, values: TaskValues, before: Record<string, unknown> | null, after: Record<string, unknown> | undefined): Partial<TaskValues> {
  if (provider === "caldav" || !after) return values;
  const fieldKeys: Partial<Record<keyof TaskValues, string>> = provider === "google"
    ? { title: "title", description: "notes", status: "status", due: "due" }
    : { title: "title", description: "body", status: "status", start: "startDateTime", due: "dueDateTime", priority: "importance" };
  const changed = (key: string) => !before || JSON.stringify(before[key]) !== JSON.stringify(after[key]);
  const patch = Object.fromEntries(Object.entries(fieldKeys).filter(([, key]) => changed(key)).map(([field]) => [field, values[field as keyof TaskValues]])) as Partial<TaskValues>;
  if (changed("status")) {
    patch.completedAt = values.completedAt;
    patch.percentComplete = values.percentComplete;
  }
  // A date-only projection's unchanged calendar day cannot discard a canonical
  // time. A real provider day change is authoritative only at the task's home.
  if (provider === "google" && changed("due")) patch.isAllDay = values.isAllDay;
  return patch;
}

async function appendImportedTaskFanout(tx: DbTransaction, row: typeof tasks.$inferSelect, sourceCalendarID: string, action: "update" | "delete") {
  const links = await tx.select({ calendarID: calendarTasks.calendarID }).from(calendarTasks).where(eq(calendarTasks.taskID, row.id));
  const snapshot = TaskSchema.parse({ ...row, calendarID: row.calendarID ?? sourceCalendarID, calendarIDs: links.map(link => link.calendarID) });
  const actions = links.filter(link => link.calendarID !== sourceCalendarID).map(link => ({ calendarID: link.calendarID, action }));
  await appendTaskOutbox(tx, snapshot, await prepareTaskOutboxInTransaction(tx, snapshot, actions, { actorID: row.creatorID, mutationID: randomUUID() }));
}

export async function upsertExternalTask(
  provider: string,
  userID: string,
  calendarID: string,
  externalCalendarID: string,
  externalTaskID: string,
  values: TaskValues,
  etag: string | null = null,
  icalUid: string | null = null,
  accessContext?: ExternalCalendarAccessContext,
  scope?: TaskSyncScope,
  projection?: Record<string, unknown>,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockCalendarLifecycle(tx, [calendarID], "shared");
    await assertExternalCalendarAccess(tx, provider, calendarID, accessContext);
    await assertTaskSyncScope(tx, provider, calendarID, externalCalendarID, scope);
    const [retainedDelete] = await tx.select({ id: taskOutbox.id }).from(taskOutbox).where(and(eq(taskOutbox.provider, provider), eq(taskOutbox.calendarID, calendarID), eq(taskOutbox.externalCalendarID, externalCalendarID), scope ? eq(taskOutbox.externalCalendarLinkID, scope.sourceID) : undefined, scope ? eq(taskOutbox.accountID, scope.accountID) : undefined, eq(taskOutbox.action, "delete"), sql`(${taskOutbox.externalTaskID} = ${externalTaskID} or ${taskOutbox.resultRef}->>'externalTaskId' = ${externalTaskID} or exists (
      with recursive previous as (
        select id, predecessor_id, external_task_id, result_ref from task_outbox where id = ${taskOutbox.predecessorID}
        union
        select p.id, p.predecessor_id, p.external_task_id, p.result_ref from task_outbox p inner join previous q on p.id = q.predecessor_id
      ) select 1 from previous where external_task_id = ${externalTaskID} or result_ref->>'externalTaskId' = ${externalTaskID}
    ))`)).limit(1);
    if (retainedDelete) return false;
    const [mapping] = await tx
      .select({
        id: externalTasks.id,
        taskID: externalTasks.taskID,
        etag: externalTasks.etag,
        icalUid: externalTasks.icalUid,
        deletedAt: tasks.deletedAt,
        originCalendarID: tasks.originCalendarID,
        projectionBaseline: externalTasks.projectionBaseline,
        providerAccessRevision: externalTasks.providerAccessRevision,
      })
      .from(externalTasks)
      .innerJoin(tasks, eq(externalTasks.taskID, tasks.id))
      .where(
        and(
          eq(externalTasks.provider, provider),
          eq(externalTasks.calendarID, calendarID),
          eq(externalTasks.externalTaskID, externalTaskID),
          scope ? eq(externalTasks.externalCalendarLinkID, scope.sourceID) : undefined,
          scope ? eq(externalTasks.accountID, scope.accountID) : undefined,
        ),
      );

    if (mapping) {
      if (etag !== null && mapping.etag === etag && mapping.deletedAt === null && (!scope || mapping.originCalendarID !== calendarID || mapping.providerAccessRevision === scope.providerAccessRevision))
        return false;
      const [current] = await tx.select().from(tasks).where(eq(tasks.id, mapping.taskID)).for("update");
      const [accepted] = await tx.select().from(externalTasks).where(eq(externalTasks.id, mapping.id)).for("update");
      if (!current || !accepted) return false;
      const [lateRead] = scope?.readStartedAt ? await tx.select({ id: taskOutbox.id }).from(taskOutbox).where(and(eq(taskOutbox.taskID, mapping.taskID), eq(taskOutbox.calendarID, calendarID), eq(taskOutbox.status, "completed"), sql`${taskOutbox.updatedAt} >= ${scope.readStartedAt.toISOString()}::timestamp`)).limit(1) : [];
      if (lateRead) return false;
      let acceptedOriginRevision: number | undefined;
      // A secondary native copy is observation, never the task authority.
      if (current.originCalendarID === calendarID) {
        const patch = taskOriginPullPatch(provider, values, accepted.projectionBaseline, projection);
        const [pending] = await tx.select({ id: taskOutbox.id }).from(taskOutbox).where(and(eq(taskOutbox.taskID, mapping.taskID), eq(taskOutbox.calendarID, calendarID), scope ? eq(taskOutbox.externalCalendarLinkID, scope.sourceID) : undefined, scope ? eq(taskOutbox.providerAccessRevision, scope.providerAccessRevision) : undefined, eq(taskOutbox.retiredGeneration, current.providerReadRetiredGeneration ?? 0), sql`${taskOutbox.status} not in ('completed', 'not-needed', 'cancelled')`)).limit(1);
        const [localDeletion] = await tx.select({ id: taskOutbox.id }).from(taskOutbox).where(and(eq(taskOutbox.taskID, mapping.taskID), eq(taskOutbox.calendarID, calendarID), eq(taskOutbox.action, "delete"))).limit(1);
        if (!pending && !(current.deletedAt && localDeletion)) {
          acceptedOriginRevision = current.revision;
          const changed = Object.fromEntries(Object.entries(patch).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(current[key as keyof typeof current])));
          if (Object.keys(changed).length || current.deletedAt !== null) {
            const [updated] = await tx.update(tasks).set({ ...changed, deletedAt: null, revision: sql`${tasks.revision} + 1` }).where(eq(tasks.id, mapping.taskID)).returning();
            if (updated) {
              acceptedOriginRevision = updated.revision;
              await appendImportedTaskFanout(tx, updated, calendarID, "update");
            }
          }
        }
      }
      await tx
        .update(externalTasks)
        .set({ etag, icalUid: icalUid ?? accepted.icalUid, projectionBaseline: projection ?? accepted.projectionBaseline,
          ...(acceptedOriginRevision !== undefined ? { acceptedRevision: acceptedOriginRevision, ...(scope ? { providerAccessRevision: scope.providerAccessRevision } : {}) } : {}),
        })
        .where(eq(externalTasks.id, mapping.id));
    } else {
      // A lost CREATE response has no trustworthy identity on Google/Graph.
      // Do not import an unacknowledged copy as a second canonical task.
      const [unresolvedCreate] = await tx.select({ id: taskOutbox.id }).from(taskOutbox).innerJoin(tasks, eq(tasks.id, taskOutbox.taskID)).where(and(eq(taskOutbox.calendarID, calendarID), scope ? eq(taskOutbox.externalCalendarLinkID, scope.sourceID) : undefined, scope ? eq(taskOutbox.providerAccessRevision, scope.providerAccessRevision) : undefined, sql`${taskOutbox.retiredGeneration} = coalesce(${tasks.providerReadRetiredGeneration}, 0)`, eq(taskOutbox.action, "create"), eq(taskOutbox.uncertain, true), sql`${taskOutbox.status} not in ('completed', 'not-needed', 'cancelled')`)).limit(1);
      if (unresolvedCreate) return false;
      const [task] = await tx
        .insert(tasks)
        .values({
          id: crypto.randomUUID(),
          creatorID: userID,
          calendarID,
          originCalendarID: calendarID,
          ...values,
        })
        .returning({ id: tasks.id });
      await tx.insert(calendarTasks).values({ taskID: task.id, calendarID });
      await tx.insert(externalTasks).values({
        provider,
        taskID: task.id,
        calendarID,
        externalCalendarID,
        externalTaskID,
        etag,
        icalUid,
        externalCalendarLinkID: scope?.sourceID ?? null,
        accountID: scope?.accountID ?? null,
        providerAccessRevision: scope?.providerAccessRevision ?? 0,
        projectionBaseline: projection ?? null,
      });
    }
    return true;
  });
}

async function retireTaskProjection(tx: DbTransaction, provider: string, calendarID: string, externalTaskID: string, scope?: TaskSyncScope): Promise<boolean> {
  const rows = await tx.select({ mapping: externalTasks, task: tasks }).from(externalTasks).innerJoin(tasks, eq(externalTasks.taskID, tasks.id)).where(and(eq(externalTasks.provider, provider), eq(externalTasks.calendarID, calendarID), eq(externalTasks.externalTaskID, externalTaskID), scope ? eq(externalTasks.externalCalendarLinkID, scope.sourceID) : undefined, scope ? eq(externalTasks.accountID, scope.accountID) : undefined));
  let changed = false;
  for (const row of rows) {
    const [current] = await tx.select().from(tasks).where(eq(tasks.id, row.task.id)).for("update");
    if (!current) continue;
    const [lateRead] = scope?.readStartedAt ? await tx.select({ id: taskOutbox.id }).from(taskOutbox).where(and(eq(taskOutbox.taskID, row.task.id), eq(taskOutbox.calendarID, calendarID), eq(taskOutbox.status, "completed"), sql`${taskOutbox.updatedAt} >= ${scope.readStartedAt.toISOString()}::timestamp`)).limit(1) : [];
    if (lateRead) continue;
    const [pending] = await tx.select({ id: taskOutbox.id }).from(taskOutbox).where(and(eq(taskOutbox.taskID, row.task.id), eq(taskOutbox.calendarID, calendarID), scope ? eq(taskOutbox.externalCalendarLinkID, scope.sourceID) : undefined, scope ? eq(taskOutbox.providerAccessRevision, scope.providerAccessRevision) : undefined, eq(taskOutbox.retiredGeneration, current.providerReadRetiredGeneration ?? 0), sql`${taskOutbox.status} not in ('completed', 'not-needed', 'cancelled')`)).limit(1);
    if (pending) continue;
    await tx.select({ id: externalTasks.id }).from(externalTasks).where(eq(externalTasks.id, row.mapping.id)).for("update");
    if (current.originCalendarID === calendarID && current.deletedAt === null) {
      const [deleted] = await tx.update(tasks).set({ deletedAt: new Date(), revision: sql`${tasks.revision} + 1` }).where(eq(tasks.id, row.task.id)).returning();
      if (deleted) await appendImportedTaskFanout(tx, deleted, calendarID, "delete");
      changed = true;
    } else if (row.mapping.etag !== null || row.mapping.projectionBaseline !== null) changed = true;
    // Keep the captured address: a later update must not silently recreate a
    // copy which somebody removed outside Musubi.
    await tx.update(externalTasks).set({ etag: null, projectionBaseline: null }).where(eq(externalTasks.id, row.mapping.id));
  }
  return changed;
}

export async function deleteExternalTask(provider: string, calendarID: string, externalTaskID: string, accessContext?: ExternalCalendarAccessContext, scope?: TaskSyncScope): Promise<boolean> {
  return db.transaction(async tx => {
    await lockCalendarLifecycle(tx, [calendarID], "shared");
    await assertExternalCalendarAccess(tx, provider, calendarID, accessContext);
    await assertTaskSyncScope(tx, provider, calendarID, undefined, scope);
    return retireTaskProjection(tx, provider, calendarID, externalTaskID, scope);
  });
}

export async function sweepExternalTasks(provider: string, calendarID: string, seenExternalTaskIDs: string[], accessContext?: ExternalCalendarAccessContext, scope?: TaskSyncScope): Promise<number> {
  return db.transaction(async tx => {
    await lockCalendarLifecycle(tx, [calendarID], "shared");
    await assertExternalCalendarAccess(tx, provider, calendarID, accessContext);
    await assertTaskSyncScope(tx, provider, calendarID, undefined, scope);
    const mappings = await tx.select({ externalTaskID: externalTasks.externalTaskID }).from(externalTasks).where(and(eq(externalTasks.provider, provider), eq(externalTasks.calendarID, calendarID), scope ? eq(externalTasks.externalCalendarLinkID, scope.sourceID) : undefined, scope ? eq(externalTasks.accountID, scope.accountID) : undefined));
    const seen = new Set(seenExternalTaskIDs);
    let changed = 0;
    for (const mapping of mappings) if (!seen.has(mapping.externalTaskID) && await retireTaskProjection(tx, provider, calendarID, mapping.externalTaskID, scope)) changed++;
    return changed;
  });
}

export async function getExternalEvent(
  provider: string,
  eventID: string,
  externalCalendarID: string,
  calendarID?: string,
) {
  const [res] = await db
    .select({
      externalEventId: externalEvents.externalEventID,
      etag: externalEvents.etag,
      icalUid: externalEvents.icalUid,
    })
    .from(externalEvents)
    .where(
      and(
        eq(externalEvents.provider, provider),
        eq(externalEvents.eventID, eventID),
        eq(externalEvents.externalCalendarID, externalCalendarID),
        calendarID ? eq(externalEvents.calendarID, calendarID) : undefined,
      ),
    );
  return res ?? null;
}

export async function setExternalEventSyncData(
  provider: string,
  eventID: string,
  externalCalendarID: string,
  data: { etag: string | null; icalUid: string | null },
  calendarID?: string,
  guard?: { revision: number; etag: string | null; externalEventID: string },
) {
  return db.transaction(async (tx) => {
    const [event] = await tx
      .select()
      .from(events)
      .where(eq(events.id, eventID))
      .for("update");
    if (
      !event ||
      (guard && (event.revision !== guard.revision || event.deletedAt))
    )
      return false;
    const rows = await tx
      .update(externalEvents)
      .set(data)
      .where(
        and(
          eq(externalEvents.provider, provider),
          eq(externalEvents.eventID, eventID),
          eq(externalEvents.externalCalendarID, externalCalendarID),
          calendarID ? eq(externalEvents.calendarID, calendarID) : undefined,
          guard
            ? eq(externalEvents.externalEventID, guard.externalEventID)
            : undefined,
          guard
            ? guard.etag === null
              ? isNull(externalEvents.etag)
              : eq(externalEvents.etag, guard.etag)
            : undefined,
        ),
      )
      .returning({ id: externalEvents.id });
    return rows.length > 0;
  });
}

// A delayed create response cannot restore a mapping after an inbound edit/unlink.
export async function importExternalEvent(
  provider: string,
  eventID: string,
  calendarID: string,
  externalCalendarID: string,
  externalEventID: string,
  etag: string | null = null,
  icalUid: string | null = null,
  expectedRevision?: number,
) {
  return db.transaction(async (tx) => {
    const [event] = await tx
      .select()
      .from(events)
      .where(eq(events.id, eventID))
      .for("update");
    if (
      !event ||
      (expectedRevision !== undefined &&
        (event.revision !== expectedRevision || event.deletedAt))
    )
      return false;
    const [link] = await tx
      .select()
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.eventID, eventID),
          eq(calendarEvents.calendarID, calendarID),
        ),
      );
    if (expectedRevision !== undefined && !link) return false;
    await tx
      .insert(externalEvents)
      .values({
        provider,
        eventID,
        calendarID,
        externalCalendarID,
        externalEventID,
        etag,
        icalUid,
      });
    return true;
  });
}

export async function getExternalTask(
  provider: string,
  taskID: string,
  externalCalendarID: string,
  calendarID?: string,
  scope?: TaskSyncScope,
) {
  const results = await db
    .select({
      externalTaskId: externalTasks.externalTaskID,
      etag: externalTasks.etag,
      icalUid: externalTasks.icalUid,
      projectionBaseline: externalTasks.projectionBaseline,
    })
    .from(externalTasks)
    .where(
      and(
        eq(externalTasks.provider, provider),
        eq(externalTasks.taskID, taskID),
        eq(externalTasks.externalCalendarID, externalCalendarID),
        calendarID ? eq(externalTasks.calendarID, calendarID) : undefined,
        scope ? eq(externalTasks.externalCalendarLinkID, scope.sourceID) : undefined,
        scope ? eq(externalTasks.accountID, scope.accountID) : undefined,
      ),
    );
  if (results.length > 1) throw new Error("Ambiguous provider task address. Supply its local source scope.");
  return results[0] ?? null;
}

type TaskPushSnapshot = Pick<typeof tasks.$inferSelect, "id" | "calendarID" | "sequence"> & { providerReadRetiredGeneration?: number | null };
type TaskPushAdmission = { task: TaskPushSnapshot; context: ExternalCalendarAccessContext };

async function assertTaskPushInTransaction(tx: DbTransaction, { task, context }: TaskPushAdmission) {
  if (!task.calendarID) throw new Error("Task source is unavailable.");
  await lockCalendarLifecycle(tx, [task.calendarID], "shared");
  const access = await assertExternalCalendarAccess(tx, context.provider ?? "caldav", task.calendarID, context);
  if (access?.role?.startsWith("caldav:read=no;")) throw new Error("Task source read access is unavailable.");
  const [current] = await tx.select().from(tasks).where(eq(tasks.id, task.id)).for("share");
  if (!current || current.calendarID !== task.calendarID || current.sequence !== task.sequence || (current.providerReadRetiredGeneration ?? 0) !== (task.providerReadRetiredGeneration ?? 0)) throw new Error("Task changed during provider delivery.");
}

export async function setExternalTaskSyncData(
  provider: string,
  taskID: string,
  externalCalendarID: string,
  data: { etag: string | null; icalUid: string | null },
  admission?: TaskPushAdmission,
  calendarID?: string,
  scope?: TaskSyncScope,
) {
  await db.transaction(async tx => {
    if (admission) await assertTaskPushInTransaction(tx, admission);
    await tx.update(externalTasks).set(data).where(and(
      eq(externalTasks.provider, provider),
      eq(externalTasks.taskID, taskID),
      eq(externalTasks.externalCalendarID, externalCalendarID),
      calendarID ? eq(externalTasks.calendarID, calendarID) : undefined,
      scope ? eq(externalTasks.externalCalendarLinkID, scope.sourceID) : undefined,
      scope ? eq(externalTasks.accountID, scope.accountID) : undefined,
    ));
  });
}

export async function importExternalTask(
  provider: string,
  taskID: string,
  calendarID: string,
  externalCalendarID: string,
  externalTaskID: string,
  etag: string | null = null,
  icalUid: string | null = null,
  admission?: TaskPushAdmission,
) {
  await db.transaction(async tx => {
    if (admission) await assertTaskPushInTransaction(tx, admission);
    const [source] = await tx.select().from(externalCalendars).where(and(eq(externalCalendars.calendarID, calendarID), eq(externalCalendars.provider, provider), eq(externalCalendars.externalCalendarID, externalCalendarID)));
    await tx.insert(externalTasks).values({ provider, taskID, calendarID, externalCalendarID, externalTaskID, etag, icalUid, externalCalendarLinkID: source?.id ?? null, accountID: source?.accountID ?? null, providerAccessRevision: source?.providerAccessRevision ?? 0 });
  });
}

/** The validated lease, captured source and mapping ACK commit together. A
 * removed attachment can retain delivery proof without resurrecting a mirror. */
export async function acceptTaskOutboxDelivery(row: TaskOutboxRow, leaseToken: string, evidence: { ref: { externalTaskId: string; etag?: string | null; icalUid?: string | null }; projection: Record<string, unknown> } | null, deletionRef?: { externalTaskId: string; etag?: string | null; icalUid?: string | null }) {
  return db.transaction(async tx => {
    await lockCalendarLifecycle(tx, [row.calendarID], "shared");
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, row.taskID)).for("update");
    const [claim] = await tx.select({ id: taskOutbox.id }).from(taskOutbox).where(taskOutboxLeaseGuard(row.id, leaseToken)).for("update");
    if (!claim) return false;
    if (!await assertTaskOutboxSourceInTransaction(tx, row, { allowDeletedTask: true })) {
      await finishTaskOutboxInTransaction(tx, row.id, leaseToken, "blocked", "task-source-changed", { uncertain: !evidence && row.uncertain, resultRef: evidence?.ref ?? deletionRef ?? row.resultRef, remoteSnapshot: evidence?.projection ?? null });
      return false;
    }
    const [attached] = await tx.select({ taskID: calendarTasks.taskID }).from(calendarTasks).where(and(eq(calendarTasks.taskID, row.taskID), eq(calendarTasks.calendarID, row.calendarID)));
    const address = and(eq(externalTasks.taskID, row.taskID), eq(externalTasks.calendarID, row.calendarID), eq(externalTasks.provider, row.provider), eq(externalTasks.externalCalendarLinkID, row.externalCalendarLinkID), eq(externalTasks.accountID, row.accountID));
    if (row.action === "delete") await tx.delete(externalTasks).where(address);
    else if (evidence && task?.deletedAt === null && attached) {
      const [mapping] = await tx.select({ id: externalTasks.id }).from(externalTasks).where(address).for("update");
      const data = { externalCalendarID: row.externalCalendarID, externalTaskID: evidence.ref.externalTaskId, etag: evidence.ref.etag ?? null, icalUid: evidence.ref.icalUid ?? null, providerAccessRevision: row.providerAccessRevision, projectionBaseline: evidence.projection, acceptedRevision: row.revision };
      if (mapping) await tx.update(externalTasks).set(data).where(eq(externalTasks.id, mapping.id));
      else await tx.insert(externalTasks).values({ taskID: row.taskID, calendarID: row.calendarID, provider: row.provider, externalCalendarLinkID: row.externalCalendarLinkID, accountID: row.accountID, ...data });
    }
    return finishTaskOutboxInTransaction(tx, row.id, leaseToken, "completed", null, { resultRef: evidence?.ref ?? deletionRef ?? (row.externalTaskID ? { externalTaskId: row.externalTaskID, etag: row.expectedEtag, icalUid: row.icalUid } : null), remoteSnapshot: evidence?.projection ?? null });
  });
}

export async function assertTaskOutboxDeliverySource(row: TaskOutboxRow, allowDeletedTask = false) {
  return db.transaction(async tx => {
    await lockCalendarLifecycle(tx, [row.calendarID], "shared");
    await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, row.taskID)).for("share");
    return assertTaskOutboxSourceInTransaction(tx, row, { allowDeletedTask });
  });
}

/** Immediate task writes keep their captured source and retirement admission. */
export async function assertExternalTaskPush(task: TaskPushSnapshot, context: ExternalCalendarAccessContext) {
  return db.transaction(tx => assertTaskPushInTransaction(tx, { task, context }));
}
