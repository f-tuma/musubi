import ICAL from "ical.js";
import { caldavRecurrenceFromV1, replaceComponentPropertiesV1, SyncCodecError } from "@musubi/sync-codec";
import { CaldavProviderError } from "./types";

const failed = () => new CaldavProviderError("provider-write-failed");
export function caldavComponentString(component: ICAL.Component, propertyName: string): string | null {
  const value = component.getFirstPropertyValue(propertyName);
  return typeof value === "string" ? value : null;
}
/** Exact legacy UID/master selection. Raw ICAL syntax exceptions remain distinct
 * from explicit invalid-resource errors for the existing host retry policy. */
export function selectCaldavEventMaster(data: string, uid?: string | null) {
  const calendar = new ICAL.Component(ICAL.parse(data));
  if (calendar.name !== "vcalendar") throw failed();
  const events = calendar.getAllSubcomponents("vevent");
  const masters = events.filter(component => !component.getFirstProperty("recurrence-id") &&
    (uid == null || component.getFirstPropertyValue("uid") === uid));
  if (masters.length !== 1 || masters[0]!.getAllProperties("uid").length !== 1) throw failed();
  const master = masters[0]!, actualUid = caldavComponentString(master, "uid");
  if (!actualUid) throw failed();
  return { calendar, master, uid: actualUid, index: events.indexOf(master) };
}
export function validateCaldavPhysicalResource(data: string, index: number): void {
  try { replaceComponentPropertiesV1(data, index, new Map(), "vevent"); }
  catch (error) { if (error instanceof SyncCodecError) throw failed(); throw error; }
}
/** Existing read normalization floor without producing a canonical Event. */
export function validateCaldavObservation(master: ICAL.Component): void {
  try {
    const event = new ICAL.Event(master), start = event.startDate, end = event.endDate;
    const date = (value: ICAL.Time) => value.isDate ? new Date(Date.UTC(value.year, value.month - 1, value.day)) : value.toJSDate();
    const startsAt = date(start), endsAt = new Date(date(end).getTime() - (start.isDate ? 86_400_000 : 0));
    if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) throw failed();
  } catch { throw failed(); }
  try { caldavRecurrenceFromV1(master); }
  catch (error) {
    // The existing codec's typed recurrence refusal is safe metadata. Its raw
    // parser exceptions must retain their distinct legacy retry classification.
    if (error && typeof error === "object" && "capability" in error && error.capability === "recurrence")
      throw new CaldavProviderError("capability-evidence", "not-written", undefined, undefined, "recurrence", "unsupported");
    throw error;
  }
  if (!master.getFirstProperty("rrule")?.getFirstValue()) return;
  const uid = master.getFirstPropertyValue("uid");
  for (const exception of master.parent?.getAllSubcomponents("vevent") ?? []) {
    if (exception === master || exception.getFirstPropertyValue("uid") !== uid) continue;
    for (const name of ["recurrence-id", ...(caldavComponentString(exception, "status")?.toUpperCase() === "CANCELLED" ? [] : ["dtstart"])]) {
      const time = exception.getFirstPropertyValue(name) as ICAL.Time | null;
      if (time && typeof time.toJSDate === "function") {
        const date = time.isDate ? new Date(Date.UTC(time.year, time.month - 1, time.day)) : time.toJSDate();
        date.toISOString(); // Preserve the old detached-date failure floor.
      }
    }
  }
}
export function strictCaldavResourceURL(calendarUrl: string, resourceUrl: string): URL {
  const collection = new URL(calendarUrl), resource = new URL(resourceUrl);
  const safePath = (url: URL) => url.pathname.split("/").every(segment => {
    try { const decoded = decodeURIComponent(segment); return decoded !== "." && decoded !== ".." && !/[\/\\%\u0000-\u001f\u007f]/.test(decoded); }
    catch { return false; }
  });
  if (!["http:", "https:"].includes(resource.protocol) || resource.origin !== collection.origin || collection.username || collection.password ||
      resource.username || resource.password || collection.search || collection.hash || resource.search || resource.hash || !safePath(collection) || !safePath(resource) ||
      !collection.pathname.endsWith("/") || !resource.pathname.startsWith(collection.pathname) || !resource.pathname.slice(collection.pathname.length) ||
      resource.pathname.slice(collection.pathname.length).includes("/")) throw new CaldavProviderError("provider-conflict");
  return resource;
}
export function assertStrictCaldavPersonalResource(selected: ReturnType<typeof selectCaldavEventMaster>): void {
  const { calendar, master } = selected;
  const unsupported = () => { throw new CaldavProviderError("capability-evidence", "not-written", undefined, undefined, "event-write", "unsupported"); };
  if (calendar.getAllSubcomponents("vevent").length !== 1 || calendar.getAllSubcomponents().some(child => !["vevent", "vtimezone"].includes(child.name)) ||
      calendar.hasProperty("method") || master.getAllProperties("attendee").length ||
      ["rrule", "rdate", "exdate", "exrule", "recurrence-id"].some(name => master.hasProperty(name))) unsupported();
  // A direct-child count does not prove a single event resource: ICAL accepts
  // nested components, including a second VEVENT hidden inside the master or
  // an alarm. Traverse every permitted branch without rewriting native bytes.
  const oneValue = (component: ICAL.Component, name: string) => {
    const properties = component.getAllProperties(name);
    return properties.length === 1 && properties[0]!.getFirstValue() != null;
  };
  for (const alarm of master.getAllSubcomponents()) {
    if (alarm.name !== "valarm" || alarm.getAllSubcomponents().length || !oneValue(alarm, "action") || !oneValue(alarm, "trigger")) unsupported();
  }
  for (const zone of calendar.getAllSubcomponents("vtimezone")) {
    const tzid = caldavComponentString(zone, "tzid"), observances = zone.getAllSubcomponents();
    if (!tzid || zone.getAllProperties("tzid").length !== 1 || !observances.length) unsupported();
    for (const observance of observances) {
      if (!["standard", "daylight"].includes(observance.name) || observance.getAllSubcomponents().length ||
          !["dtstart", "tzoffsetfrom", "tzoffsetto"].every(name => oneValue(observance, name))) unsupported();
    }
  }
  const event = new ICAL.Event(master);
  if (event.startDate.isDate || event.endDate.isDate || event.startDate.toJSDate() > event.endDate.toJSDate()) unsupported();
}
