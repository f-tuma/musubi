import { eq, inArray } from "drizzle-orm";
import {
  Calendar,
  Event,
  RemindersDocument,
  Settings,
  EventTimeModelSchema,
  OccurrenceIdentitySchema,
  type EventTimeModel,
  type OccurrenceStart,
} from "@musubi/types";
import { db, sqlite } from "./db";
import { eventsTable, syncMetaTable } from "@/db/schema";

// Storage can preserve the additive fields before production EventSchema admits
// them. This does not activate metadata in transports or writable requests.
export type CachedEvent = Event & {
  timeModel?: EventTimeModel | null;
  seriesID?: string | null;
  originalStart?: OccurrenceStart | null;
};

function timeMetadata(
  e: Pick<CachedEvent, "id" | "timeModel" | "seriesID" | "originalStart">,
) {
  const timeModel =
    e.timeModel == null ? undefined : EventTimeModelSchema.parse(e.timeModel);
  const identity =
    e.seriesID == null && e.originalStart == null
      ? undefined
      : OccurrenceIdentitySchema.parse({
          seriesId: e.seriesID,
          originalStart: e.originalStart,
        });
  if (identity?.seriesId === e.id.toLowerCase())
    throw new Error("An event cannot be its own series.");
  return {
    ...(timeModel ? { timeModel } : {}),
    ...(identity
      ? { seriesID: identity.seriesId, originalStart: identity.originalStart }
      : {}),
  };
}

// Event <-> SQLite row. Dates as ISO text (new Date() accepts Date or string),
// calendars as JSON. Read back as real Date objects.
function toRow(e: CachedEvent) {
  const metadata = timeMetadata(e);
  // expo-sqlite on iOS throws on an `undefined` bind (Android coerces to null),
  // so EVERY column must get a concrete value. NOT NULL columns get a default,
  // nullable ones get null. (External/imported events often miss creatorID.)
  return {
    id: e.id,
    revision: e.revision ?? null,
    creatorID: e.creatorID ?? "",
    title: e.title ?? "",
    color: e.color ?? "",
    start: new Date(e.start).toISOString(),
    end: new Date(e.end).toISOString(),
    isAllDay: e.isAllDay ?? false,
    description: e.description ?? null,
    location: e.location ?? null,
    isCanceled: e.isCanceled ?? false,
    hasAttendees: e.hasAttendees ?? false,
    organizer: e.organizer ?? "",
    recurrence: e.recurrence ?? null,
    url: e.url ?? null,
    calendars: JSON.stringify(e.calendars ?? []),
    originCalendarID: e.originCalendarID ?? null,
    timeModel: metadata.timeModel ? JSON.stringify(metadata.timeModel) : null,
    seriesID: metadata.seriesID ?? null,
    originalStart: metadata.originalStart
      ? JSON.stringify(metadata.originalStart)
      : null,
  };
}

function parseArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function fromRow(r: typeof eventsTable.$inferSelect): CachedEvent {
  return {
    id: r.id,
    revision: r.revision ?? undefined,
    creatorID: r.creatorID,
    title: r.title,
    color: r.color,
    start: new Date(r.start),
    end: new Date(r.end),
    isAllDay: r.isAllDay,
    description: r.description,
    location: r.location,
    isCanceled: r.isCanceled,
    hasAttendees: r.hasAttendees,
    organizer: r.organizer,
    recurrence: r.recurrence,
    url: r.url,
    calendars: parseArray<string>(r.calendars),
    originCalendarID: r.originCalendarID,
    ...timeMetadata({
      id: r.id,
      timeModel: r.timeModel == null ? undefined : JSON.parse(r.timeModel),
      seriesID: r.seriesID,
      originalStart:
        r.originalStart == null ? undefined : JSON.parse(r.originalStart),
    }),
  };
}

export async function cacheGetAllEvents(): Promise<CachedEvent[]> {
  const rows = await db.select().from(eventsTable);
  return rows.map(fromRow);
}

function hasValidDates(e: Event): boolean {
  return (
    !Number.isNaN(new Date(e.start).getTime()) &&
    !Number.isNaN(new Date(e.end).getTime())
  );
}

export async function cacheUpsertEvents(events: CachedEvent[]) {
  // Skip events with malformed dates so one bad import can't crash the whole sync.
  const valid = events.filter((e) => {
    if (!e.id) {
      console.warn("Skipping event with no id");
      return false;
    }
    if (hasValidDates(e)) return true;
    console.warn("Skipping event with invalid date:", e.id, e.start, e.end);
    return false;
  });
  if (!valid.length) return;
  writeEventRows(valid, false);
}

// Expo's drizzle driver is synchronous: execute inside a synchronous transaction
// (an async callback commits before its first await). Never erase a proven newer
// row with an older or revisionless cache write, including a full snapshot.
function writeEventRows(events: CachedEvent[], replace: boolean) {
  db.transaction((tx) => {
    const saved = new Map(
      tx
        .select()
        .from(eventsTable)
        .all()
        .map((row) => [row.id, row]),
    );
    const incomingRows = new Map<string, typeof eventsTable.$inferSelect>();
    for (const event of events) {
      const incoming = toRow(event);
      const current = incomingRows.get(event.id) ?? saved.get(event.id);
      // A legacy projection at the same proven revision cannot erase metadata
      // already stored with that revision. Keep the complete consistent row.
      const losesTimeMetadata =
        current &&
        (current.revision ?? 0) > 0 &&
        current.revision === incoming.revision &&
        ((current.timeModel !== null && incoming.timeModel === null) ||
          (current.seriesID !== null && incoming.seriesID === null) ||
          (current.originalStart !== null && incoming.originalStart === null));
      incomingRows.set(
        event.id,
        current &&
          ((current.revision ?? 0) > (incoming.revision ?? 0) ||
            losesTimeMetadata)
          ? current
          : incoming,
      );
    }
    const rows = [...incomingRows.values()];
    if (replace) tx.delete(eventsTable).run();
    else if (rows.length)
      tx.delete(eventsTable)
        .where(
          inArray(
            eventsTable.id,
            rows.map((row) => row.id),
          ),
        )
        .run();
    for (let i = 0; i < rows.length; i += 200) {
      tx.insert(eventsTable)
        .values(rows.slice(i, i + 200))
        .run();
    }
  });
}

export async function cacheDeleteEvents(ids: string[]) {
  if (!ids.length) return;
  db.delete(eventsTable).where(inArray(eventsTable.id, ids)).run();
}

// Full sync is authoritative: replace the whole cache so any local drift
// (e.g. stale ids accumulated from past resets) is dropped.
export async function cacheReplaceAllEvents(events: CachedEvent[]) {
  writeEventRows(
    events.filter((e) => e.id && hasValidDates(e)),
    true,
  );
}

// Upsert one sync_meta row. drizzle's onConflictDoUpdate emits a bind that
// expo-sqlite on iOS rejects (InvalidConvertibleException, aborting the whole
// refresh); a delete-then-insert on the PK is the driver-agnostic equivalent.
async function setMeta(key: string, value: string) {
  db.transaction((tx) => {
    tx.delete(syncMetaTable).where(eq(syncMetaTable.key, key)).run();
    tx.insert(syncMetaTable).values({ key, value }).run();
  });
}

// Calendars are few and have no Date fields → stored as one JSON blob. Cached so
// the boot hydrate has calendars too (activeCals derives from them; without it,
// cached events render but get filtered out until calendars arrive over the network).
export async function cacheSetCalendars(calendars: Calendar[]) {
  await setMeta("calendars", JSON.stringify(calendars));
}

export async function cacheGetCalendars(): Promise<Calendar[]> {
  const [row] = await db
    .select()
    .from(syncMetaTable)
    .where(eq(syncMetaTable.key, "calendars"));
  // A broken membership cache is unknown, rather than a successful empty list.
  // Widget hydration must retain its last valid content until a fresh read.
  if (!row) return [];
  const calendars = JSON.parse(row.value);
  // The legacy mirror also holds local/federated metadata and may lack current
  // wire-only fields. Validate display/membership keys without stripping or
  // rejecting those compatible cached records.
  if (!Array.isArray(calendars) || calendars.some(calendar => calendar == null
    || typeof calendar.id !== "string" || !calendar.id
    || typeof calendar.name !== "string" || typeof calendar.color !== "string"))
    throw new Error("The saved calendar membership could not be read.");
  return calendars;
}

export async function getLastSync(): Promise<string | null> {
  const [row] = await db
    .select()
    .from(syncMetaTable)
    .where(eq(syncMetaTable.key, "lastSync"));
  return row?.value ?? null;
}

export async function setLastSync(iso: string) {
  // Better Auth's fetch revives ISO fields to Date objects, so `iso` can actually
  // arrive as a Date. Normalize to an ISO string — expo-sqlite (iOS) can't bind a
  // Date and throws InvalidConvertibleException, which aborted the whole refresh.
  const d = new Date(iso);
  if (isNaN(d.getTime())) return; // never persist a garbage cursor
  await setMeta("lastSync", d.toISOString());
}

// Settings snapshot (same blob pattern as calendars). Read back SYNCHRONOUSLY
// at store creation so the very first frame renders in the last-known theme —
// any async gap here shows as a flash (system theme, or worse a white window).
export async function cacheSetSettings(settings: Settings) {
  await setMeta("settings", JSON.stringify(settings));
}

export function cacheGetSettingsSync(): Settings | null {
  try {
    const row = sqlite.getFirstSync<{ value: string }>(
      "SELECT value FROM sync_meta WHERE key = 'settings'",
    );
    return row ? JSON.parse(row.value) : null;
  } catch {
    return null; // fresh install: the table appears once migrations run
  }
}

// Reminder rules (same blob pattern). Cached so a cold, offline start can still
// reschedule from the local event mirror — a reminder that only works once the
// network answers is not a reminder.
export async function cacheSetReminders(document: RemindersDocument) {
  await setMeta("reminders", JSON.stringify(document));
}

export async function cacheGetReminders(): Promise<RemindersDocument | null> {
  const [row] = await db
    .select()
    .from(syncMetaTable)
    .where(eq(syncMetaTable.key, "reminders"));
  if (!row) return null;
  try {
    return JSON.parse(row.value) as RemindersDocument;
  } catch {
    return null;
  }
}

// Wipe the whole local mirror — events, cached calendars and the sync cursor.
// Called on sign-out so the next account (or the same one on another device)
// starts from a clean full sync instead of inheriting stale data.
export async function cacheClearAll() {
  db.transaction((tx) => {
    tx.delete(eventsTable).run();
    tx.delete(syncMetaTable).run();
  });
}
