import ICAL from "ical.js";
import { randomUUID } from "crypto";
import { Event } from "@musubi/types";
import { getCaldavAccountById, getCaldavAccountsByUser } from "@musubi/db";
import { CalendarAdapter, ExternalCalendarInfo, FetchChangesResult, NormalizedEvent } from "../adapter";
import { createCaldavClient } from "../caldav_client";
import { decryptSecret } from "../crypto";

async function clientForAccount(accountId: string) {
  const acc = await getCaldavAccountById(accountId);
  if (!acc) throw new Error("CalDAV account not found");
  return createCaldavClient(acc.serverUrl, acc.username, decryptSecret(acc.encryptedPassword));
}

// Basic-auth header for calendar-level ops (MKCALENDAR / PROPPATCH / DELETE) —
// tsdav's typed client covers objects well, but raw WebDAV keeps the Apple
// color namespace and MKCALENDAR body under our control.
async function basicAuthForAccount(accountId: string) {
  const acc = await getCaldavAccountById(accountId);
  if (!acc) throw new Error("CalDAV account not found");
  return `Basic ${Buffer.from(`${acc.username}:${decryptSecret(acc.encryptedPassword)}`).toString("base64")}`;
}

const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!));

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

  // EXDATE must survive the round-trip: we push exceptions to the server, and
  // the full-refetch sync would otherwise overwrite them away locally.
  const exdates = vevent.getAllProperties("exdate")
    .map((p) => {
      const t = p.getFirstValue() as ICAL.Time | null;
      if (!t) return null;
      const d = t.isDate ? utcMidnight(t) : t.toJSDate();
      return `EXDATE:${d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
    })
    .filter((l): l is string => l !== null);

  const recurrence = rruleValue
    ? [`RRULE:${rruleValue.toString()}`, ...exdates].join("\n")
    : null;

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
    recurrence,
    url: null,
    etag: obj.etag ?? null,
  };
}

// Musubi Event -> VEVENT component. Shared with calendar export (one VCALENDAR,
// many VEVENTs) — keep it independent of the wrapping calendar.
export type IcalEventFields = Pick<Event, "id" | "title" | "description" | "location" | "isAllDay" | "start" | "end" | "recurrence">;

export function toVevent(event: IcalEventFields): ICAL.Component {
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
  // Recurrence must round-trip: omitting it here would STRIP the RRULE off the
  // server copy on every update of a recurring event.
  if (event.recurrence) {
    for (const line of event.recurrence.split("\n")) {
      if (/^(RRULE:)?FREQ=/.test(line)) {
        vevent.addPropertyWithValue("rrule", ICAL.Recur.fromString(line.replace(/^RRULE:/, "")));
      } else if (line.startsWith("EXDATE:")) {
        // Native exception stamps are always UTC (see excludeOccurrence).
        for (const v of line.slice("EXDATE:".length).split(",")) {
          const t = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
          if (!t) continue;
          const d = new Date(Date.UTC(+t[1], +t[2] - 1, +t[3], +t[4], +t[5], +t[6]));
          vevent.addPropertyWithValue("exdate", event.isAllDay ? allDayTime(d) : ICAL.Time.fromJSDate(d, true));
        }
      }
    }
  }

  return vevent;
}

// Musubi Event -> iCal string (single-event VCALENDAR, for CalDAV PUTs)
function toIcal(event: Event): string {
  const vcal = new ICAL.Component("vcalendar");
  vcal.updatePropertyWithValue("version", "2.0");
  vcal.updatePropertyWithValue("prodid", "-//Musubi//EN");
  vcal.addSubcomponent(toVevent(event));
  return vcal.toString();
}

export const caldavAdapter: CalendarAdapter = {
  provider: "caldav",

  async listAccounts(userID: string): Promise<{ id: string; label: string }[]> {
    const accounts = await getCaldavAccountsByUser(userID);
    return accounts.map((a) => ({ id: a.id, label: a.username }));
  },

  async listCalendars(_userID: string, accountId: string): Promise<ExternalCalendarInfo[]> {
    const client = await clientForAccount(accountId);
    const cals = await client.fetchCalendars();
    return cals
      .filter((c) => !c.components || c.components.includes("VEVENT"))
      .map((c) => ({
        externalId: c.url,
        name: typeof c.displayName === "string" ? c.displayName : "Calendar",
        color: (typeof c.calendarColor === "string" ? c.calendarColor : "#4285F4").slice(0, 7),
      }));
  },

  async fetchChanges(_userID, accountId, externalCalendarId): Promise<FetchChangesResult> {
    const client = await clientForAccount(accountId);
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

  async pushCreate(_userID, accountId, externalCalendarId, event: Event) {
    const client = await clientForAccount(accountId);
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

  async pushUpdate(_userID, accountId, _externalCalendarId, externalEventId, event: Event) {
    const client = await clientForAccount(accountId);
    const res = await client.updateCalendarObject({
      calendarObject: { url: externalEventId, data: toIcal(event) },
    });
    if (!res.ok) throw new Error(`CalDAV ${res.status} ${res.statusText}`);
  },

  async pushDelete(_userID, accountId, _externalCalendarId, externalEventId) {
    const client = await clientForAccount(accountId);
    const res = await client.deleteCalendarObject({
      calendarObject: { url: externalEventId },
    });
    if (!res.ok && res.status !== 404) throw new Error(`CalDAV ${res.status} ${res.statusText}`);
  },

  async createCalendar(_userID, accountId, { name, color }) {
    // Calendar home = parent of an existing calendar's URL (every provisioned
    // account has at least one; discovery re-derives partition hosts on iCloud).
    const client = await clientForAccount(accountId);
    const cals = await client.fetchCalendars();
    if (cals.length === 0) throw new Error("CalDAV: no calendar home found on this account");
    const home = new URL("..", cals[0].url).href;
    const url = `${home}${randomUUID()}/`;

    const res = await fetch(url, {
      method: "MKCALENDAR",
      headers: { Authorization: await basicAuthForAccount(accountId), "Content-Type": "application/xml; charset=utf-8" },
      body: `<?xml version="1.0" encoding="utf-8"?>
<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">
  <D:set><D:prop>
    <D:displayname>${escapeXml(name)}</D:displayname>
    <A:calendar-color>${escapeXml(color)}</A:calendar-color>
    <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
  </D:prop></D:set>
</C:mkcalendar>`,
    });
    if (!res.ok) throw new Error(`CalDAV ${res.status} ${res.statusText}`);
    return { externalId: url };
  },

  async updateCalendar(_userID, accountId, externalCalendarId, { name, color }) {
    const res = await fetch(externalCalendarId, {
      method: "PROPPATCH",
      headers: { Authorization: await basicAuthForAccount(accountId), "Content-Type": "application/xml; charset=utf-8" },
      body: `<?xml version="1.0" encoding="utf-8"?>
<D:propertyupdate xmlns:D="DAV:" xmlns:A="http://apple.com/ns/ical/">
  <D:set><D:prop>
    <D:displayname>${escapeXml(name)}</D:displayname>
    <A:calendar-color>${escapeXml(color)}</A:calendar-color>
  </D:prop></D:set>
</D:propertyupdate>`,
    });
    // 207 multistatus counts as ok; per-prop failures (e.g. a server ignoring
    // the Apple color prop) are non-fatal — displayname is the one that matters.
    if (!res.ok && res.status !== 207) throw new Error(`CalDAV ${res.status} ${res.statusText}`);
  },

  async deleteCalendar(_userID, accountId, externalCalendarId) {
    const res = await fetch(externalCalendarId, {
      method: "DELETE",
      headers: { Authorization: await basicAuthForAccount(accountId) },
    });
    if (!res.ok && res.status !== 404) throw new Error(`CalDAV ${res.status} ${res.statusText}`);
  },
};
