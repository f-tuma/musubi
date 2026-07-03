import ICAL from "ical.js";
import { Event } from "@musubi/types";
import { getCaldavAccount } from "@musubi/db";
import { CalendarAdapter, ExternalCalendarInfo, FetchChangesResult, NormalizedEvent } from "../adapter";
import { createCaldavClient } from "../caldav_client";
import { decryptSecret } from "../crypto";

async function clientForUser(userID: string) {
  const acc = await getCaldavAccount(userID);
  if (!acc) throw new Error("No CalDAV account connected for this user");
  return createCaldavClient(acc.serverUrl, acc.username, decryptSecret(acc.encryptedPassword));
}

// All-day is a tz-less date; anchor to UTC midnight (consistent with the rest of Musubi).
function utcMidnight(t: { year: number; month: number; day: number }): Date {
  return new Date(Date.UTC(t.year, t.month - 1, t.day)); // ICAL.Time month is 1-based
}

function allDayTime(d: Date) {
  return ICAL.Time.fromData({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    isDate: true,
  });
}

// iCal VEVENT (one calendar object) -> NormalizedEvent
function icalToNormalized(obj: { url: string; etag?: string; data?: string }): NormalizedEvent | null {
  if (!obj.data) return null;
  let vevent: ICAL.Component | null;
  try {
    const comp = new ICAL.Component(ICAL.parse(obj.data));
    vevent = comp.getFirstSubcomponent("vevent");
  } catch {
    return null;
  }
  if (!vevent) return null;

  const ev = new ICAL.Event(vevent);
  const isAllDay = ev.startDate.isDate;

  const start = isAllDay ? utcMidnight(ev.startDate) : ev.startDate.toJSDate();
  const end = isAllDay
    ? new Date(utcMidnight(ev.endDate).getTime() - 86400000) // iCal DTEND all-day is exclusive
    : ev.endDate.toJSDate();

  const organizer = vevent.getFirstPropertyValue("organizer");
  const rruleValue = vevent.getFirstProperty("rrule")?.getFirstValue();

  return {
    externalId: obj.url, // CalDAV addresses events by resource URL, not UID
    status: "active",
    title: ev.summary ?? "(untitled)",
    start,
    end,
    isAllDay,
    description: ev.description ?? null,
    location: ev.location ?? null,
    organizer: typeof organizer === "string" ? organizer.replace(/^mailto:/i, "") : null,
    recurrence: rruleValue ? `RRULE:${rruleValue.toString()}` : null,
    url: null,
    etag: obj.etag ?? null,
  };
}

// Musubi Event -> iCal string
function toIcal(event: Event): string {
  const vcal = new ICAL.Component("vcalendar");
  vcal.updatePropertyWithValue("version", "2.0");
  vcal.updatePropertyWithValue("prodid", "-//Musubi//EN");

  const vevent = new ICAL.Component("vevent");
  const ev = new ICAL.Event(vevent);
  ev.uid = event.id;
  ev.summary = event.title;
  if (event.description) ev.description = event.description;
  if (event.location) ev.location = event.location;

  if (event.isAllDay) {
    ev.startDate = allDayTime(event.start);
    ev.endDate = allDayTime(new Date(event.end.getTime() + 86400000)); // DTEND exclusive
  } else {
    ev.startDate = ICAL.Time.fromJSDate(event.start, true);
    ev.endDate = ICAL.Time.fromJSDate(event.end, true);
  }
  // ponytail: recurrence write deferred (like Google push) — add RRULE mapping when needed

  vcal.addSubcomponent(vevent);
  return vcal.toString();
}

export const caldavAdapter: CalendarAdapter = {
  provider: "caldav",

  async listCalendars(userID: string): Promise<ExternalCalendarInfo[]> {
    const acc = await getCaldavAccount(userID);
    if (!acc) return []; // not connected → quiet no-op (avoids syncUser error spam)
    const client = createCaldavClient(acc.serverUrl, acc.username, decryptSecret(acc.encryptedPassword));
    const cals = await client.fetchCalendars();
    return cals
      .filter((c) => !c.components || c.components.includes("VEVENT"))
      .map((c) => ({
        externalId: c.url,
        name: typeof c.displayName === "string" ? c.displayName : "Calendar",
        color: (c.calendarColor ?? "#4285F4").slice(0, 7),
      }));
  },

  async fetchChanges(userID, externalCalendarId): Promise<FetchChangesResult> {
    const client = await clientForUser(userID);
    const cals = await client.fetchCalendars();
    const cal = cals.find((c) => c.url === externalCalendarId);
    if (!cal) return { changes: [], nextCursor: null };

    const objects = await client.fetchCalendarObjects({ calendar: cal });
    const changes = objects
      .map((o) => icalToNormalized(o))
      .filter((e): e is NormalizedEvent => e !== null);

    // ponytail: full fetch + reset every sync — simple and handles deletions.
    // Upgrade to WebDAV sync-collection (cursor = syncToken) if calendars grow.
    return { changes, nextCursor: cal.syncToken ?? null, reset: true };
  },

  async pushCreate(userID, externalCalendarId, event: Event) {
    const client = await clientForUser(userID);
    const filename = `${event.id}.ics`;
    const res = await client.createCalendarObject({
      calendar: { url: externalCalendarId } as any,
      filename,
      iCalString: toIcal(event),
    });
    if (!res.ok) throw new Error(`CalDAV ${res.status} ${res.statusText}`);
    const base = externalCalendarId.endsWith("/") ? externalCalendarId : `${externalCalendarId}/`;
    return { externalEventId: `${base}${filename}` };
  },

  async pushUpdate(userID, _externalCalendarId, externalEventId, event: Event) {
    const client = await clientForUser(userID);
    const res = await client.updateCalendarObject({
      calendarObject: { url: externalEventId, data: toIcal(event) },
    });
    if (!res.ok) throw new Error(`CalDAV ${res.status} ${res.statusText}`);
  },

  async pushDelete(userID, _externalCalendarId, externalEventId) {
    const client = await clientForUser(userID);
    const res = await client.deleteCalendarObject({
      calendarObject: { url: externalEventId },
    });
    if (!res.ok && res.status !== 404) throw new Error(`CalDAV ${res.status} ${res.statusText}`);
  },
};
