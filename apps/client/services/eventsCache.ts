import { eq, inArray } from "drizzle-orm";
import { Calendar, Event, Settings } from "@musubi/types";
import { db, sqlite } from "./db";
import { eventsTable, syncMetaTable } from "@/db/schema";

// Event <-> SQLite row. Dates as ISO text (new Date() accepts Date or string),
// calendars as JSON. Read back as real Date objects.
function toRow(e: Event) {
  // expo-sqlite on iOS throws on an `undefined` bind (Android coerces to null),
  // so EVERY column must get a concrete value. NOT NULL columns get a default,
  // nullable ones get null. (External/imported events often miss creatorID.)
  return {
    id: e.id,
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
  };
}

function fromRow(r: typeof eventsTable.$inferSelect): Event {
  return {
    id: r.id,
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
    calendars: JSON.parse(r.calendars),
    originCalendarID: r.originCalendarID,
  } as Event;
}

export async function cacheGetAllEvents(): Promise<Event[]> {
  const rows = await db.select().from(eventsTable);
  return rows.map(fromRow);
}

function hasValidDates(e: Event): boolean {
  return !isNaN(new Date(e.start).getTime()) && !isNaN(new Date(e.end).getTime());
}

export async function cacheUpsertEvents(events: Event[]) {
  // Skip events with malformed dates so one bad import can't crash the whole sync.
  const valid = events.filter((e) => {
    if (!e.id) { console.warn("Skipping event with no id"); return false; }
    if (hasValidDates(e)) return true;
    console.warn("Skipping event with invalid date:", e.id, e.start, e.end);
    return false;
  });
  if (!valid.length) return;
  // delete-then-insert = upsert without excluded gymnastics
  await db.delete(eventsTable).where(inArray(eventsTable.id, valid.map((e) => e.id)));
  const rows = valid.map(toRow);
  // chunk to stay under SQLite's bound-variable limit on big first syncs
  for (let i = 0; i < rows.length; i += 200) {
    await db.insert(eventsTable).values(rows.slice(i, i + 200));
  }
}

export async function cacheDeleteEvents(ids: string[]) {
  if (!ids.length) return;
  await db.delete(eventsTable).where(inArray(eventsTable.id, ids));
}

// Full sync is authoritative: replace the whole cache so any local drift
// (e.g. stale ids accumulated from past resets) is dropped.
export async function cacheReplaceAllEvents(events: Event[]) {
  await db.delete(eventsTable);
  const valid = events.filter((e) => e.id && hasValidDates(e));
  const rows = valid.map(toRow);
  for (let i = 0; i < rows.length; i += 200) {
    await db.insert(eventsTable).values(rows.slice(i, i + 200));
  }
}

// Upsert one sync_meta row. drizzle's onConflictDoUpdate emits a bind that
// expo-sqlite on iOS rejects (InvalidConvertibleException, aborting the whole
// refresh); a delete-then-insert on the PK is the driver-agnostic equivalent.
async function setMeta(key: string, value: string) {
  await db.delete(syncMetaTable).where(eq(syncMetaTable.key, key));
  await db.insert(syncMetaTable).values({ key, value });
}

// Calendars are few and have no Date fields → stored as one JSON blob. Cached so
// the boot hydrate has calendars too (activeCals derives from them; without it,
// cached events render but get filtered out until calendars arrive over the network).
export async function cacheSetCalendars(calendars: Calendar[]) {
  await setMeta("calendars", JSON.stringify(calendars));
}

export async function cacheGetCalendars(): Promise<Calendar[]> {
  const [row] = await db.select().from(syncMetaTable).where(eq(syncMetaTable.key, "calendars"));
  return row ? JSON.parse(row.value) : [];
}

export async function getLastSync(): Promise<string | null> {
  const [row] = await db.select().from(syncMetaTable).where(eq(syncMetaTable.key, "lastSync"));
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
      "SELECT value FROM sync_meta WHERE key = 'settings'");
    return row ? JSON.parse(row.value) : null;
  } catch {
    return null; // fresh install: the table appears once migrations run
  }
}

// Wipe the whole local mirror — events, cached calendars and the sync cursor.
// Called on sign-out so the next account (or the same one on another device)
// starts from a clean full sync instead of inheriting stale data.
export async function cacheClearAll() {
  await db.delete(eventsTable);
  await db.delete(syncMetaTable);
}
