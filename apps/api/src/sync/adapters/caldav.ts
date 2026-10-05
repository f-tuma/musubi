import { isIcloudRsvpDestination } from "@musubi/types";
import { isCaldavPersonalContentOperation, isIcloudPersonalContentDestination, type CaldavPersonalContentOperation } from "../caldav_personal_content";
import { caldavOrganizerTransport } from "./caldav_organizer_delivery";
import { caldavAlarmScope } from "@musubi/calendar";
import { recurrenceDateValues } from "./caldav_recurrence_dates";
import { editEventRdate, restoreEventExdates } from "./caldav_event_ical";
import { inspectCaldavAlarm, writeCaldavAlarm } from "./caldav_alarms";
import type { CaldavAlarmIntent } from "@musubi/db";
import { readCaldavRsvp, deliverCaldavRsvp } from "./caldav_rsvp_delivery";
import { caldavEventState } from "./provider_event_state";
import { caldavSeriesEvidence, caldavSeriesCreationEvidence, type CaldavSeriesSplit, caldavSeriesResolutionEvidence, caldavSeriesResourceURL, sameCaldavResource, type CaldavSeriesDeletion, type CaldavSeriesWrite, type CaldavSeriesEvidence, type CaldavSeriesIntent } from "./caldav_series";
import ICAL from "ical.js";
import { caldavRdateEdit, caldavExdateRestoration, finiteSeriesFootprint, planEventScope } from "@musubi/calendar";
import { randomUUID } from "crypto";
import type { DAVCalendar, DAVCalendarObject, DAVResponse } from "tsdav";
import {
  EventWriteError,
  EventScopeRequestSchema,
  EventSchema,
  EventTimeModelSchema,
  type EventTimeEdit,
  type OccurrenceStart,
  type Event,
  type Task,
  type TaskStatus,
} from "@musubi/types";
import { normalizeCaldavResource } from "./caldav_time";
import { config, logger } from "@musubi/config";
import {
  getExternalLinkForCalendar,
  getOrganizerTimeEventIDs,
  caldavSeriesDesired,
  sameCaldavRecurrence,
  sameCaldavScopeContext,
  getCaldavAccountById,
  getCaldavAccountsByUser,
  getUserExternalCalendars,
  type EventContentPatch,
} from "@musubi/db";
import type {
  CalendarAdapter,
  CalendarDiscoveryResult,
  ExternalEventRef,
  ExternalTaskRef,
  FetchChangesResult,
  NormalizedChange,
  NormalizedEvent,
  NormalizedTask,
  TaskProjection,
} from "../adapter";
import { assertTaskEtag, assertTaskMutationResponse, canonicalTaskProjection, ProviderTaskWriteError, requireTaskEtag } from "../task_write";
import { assertCompleteEventReadResponse, assertCreatedEventEvidence, caldavEventCreateIdentity } from "../event_create_identity";
import { createCaldavClient, createGuardedCaldavFetch } from "../caldav_client";
import { decryptSecret } from "../crypto";
import {
  assertEventWriteEvidence,
  assertEventWriteResponse,
  assertAcceptedEventEtag,
  assertProviderEventMutationResponse,
  ProviderEventWriteError,
  requireEventEtag,
  requireEventPatch,
  strongEventEtag,
} from "../event_write";
import { appendEventComponent, eventComponentBytes, removeEventComponents, replaceEventProperties } from "./caldav_event_ical";
import {
  caldavAllows,
  caldavEventPrivileges,
  caldavEventWritePermission,
  caldavReadAccess,
  caldavOrganizerAddresses,
} from "../caldav_privileges";

const TASK_STATUS_BY_ICAL: Record<string, TaskStatus> = {
  "NEEDS-ACTION": "needs-action",
  "IN-PROCESS": "in-process",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
};

async function clientForAccount(accountId: string) {
  const acc = await getCaldavAccountById(accountId);
  if (!acc) throw new Error("CalDAV account not found");
  return createCaldavClient(
    acc.serverUrl,
    acc.username,
    decryptSecret(acc.encryptedPassword),
  );
}

// Basic-auth header for calendar-level ops (MKCALENDAR / PROPPATCH / DELETE) —
// tsdav's typed client covers objects well, but raw WebDAV keeps the Apple
// color namespace and MKCALENDAR body under our control.
const caldavFetch = createGuardedCaldavFetch();

async function basicAuthForAccount(accountId: string) {
  const acc = await getCaldavAccountById(accountId);
  if (!acc) throw new Error("CalDAV account not found");
  return `Basic ${Buffer.from(`${acc.username}:${decryptSecret(acc.encryptedPassword)}`).toString("base64")}`;
}

const escapeXml = (s: string) =>
  s.replace(
    /[<>&'"]/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        "'": "&apos;",
        '"': "&quot;",
      })[c]!,
  );

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

function recurrenceDate(time: ICAL.Time) {
  const date = time.isDate ? utcMidnight(time) : time.toJSDate();
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function recurrenceFrom(component: ICAL.Component): string | null {
  const rrule = component.getFirstProperty("rrule")?.getFirstValue();
  if (!rrule) {
    if (component.name === "vevent" && ["rdate", "exdate"].some(name => component.hasProperty(name))) throw new EventWriteError("recurrence", "unsupported", "Dated recurrence requires a representable recurrence rule.");
    return null;
  }
  const lines = new Set<string>([`RRULE:${rrule.toString()}`]);
  for (const propertyName of ["exdate", "rdate"] as const) {
    for (const property of component.getAllProperties(propertyName)) {
      for (const time of property.getValues() as ICAL.Time[]) {
        if (component.name === "vevent" && time.isDate) {
          if (!(component.getFirstPropertyValue("dtstart") as ICAL.Time)?.isDate) throw new EventWriteError("recurrence", "unsupported", "DATE recurrence requires an all-day event.");
          const line = `${propertyName.toUpperCase()};VALUE=DATE:${time.toICALString()}`;
          recurrenceDateValues(line);
          lines.add(line);
        } else lines.add(`${propertyName.toUpperCase()}:${recurrenceDate(time)}`);
      }
    }
  }

  // A CalDAV resource may store detached instances beside its master. Musubi's
  // recurrence string can represent their schedule as EXDATE + RDATE while the
  // original components remain untouched on write.
  const uid = component.getFirstPropertyValue("uid");
  for (const exception of component.parent?.getAllSubcomponents(
    component.name,
  ) ?? []) {
    if (
      exception === component ||
      exception.getFirstPropertyValue("uid") !== uid
    )
      continue;
    const recurrenceId = componentTime(exception, "recurrence-id");
    if (!recurrenceId) continue;
    lines.add(`EXDATE:${recurrenceDate(recurrenceId)}`);
    if (componentString(exception, "status")?.toUpperCase() !== "CANCELLED") {
      const replacement = componentTime(exception, "dtstart");
      if (replacement) lines.add(`RDATE:${recurrenceDate(replacement)}`);
    }
  }
  return [...lines].join("\n");
}

function canonicalRecurrence(value: string | null) {
  return value
    ? [...new Set(value.split("\n").filter(Boolean))]
        .sort((left, right) => left.localeCompare(right))
        .join("\n")
    : null;
}

function addRecurrence(
  component: ICAL.Component,
  recurrence: string | null | undefined,
  isAllDay: boolean,
) {
  if (!recurrence) return;
  for (const line of recurrence.split("\n")) {
    if (/^(RRULE:)?FREQ=/.test(line)) {
      component.addPropertyWithValue(
        "rrule",
        ICAL.Recur.fromString(line.replace(/^RRULE:/, "")),
      );
    } else if (/^(EXDATE|RDATE);VALUE=DATE:/i.test(line)) {
      if (!isAllDay) throw new EventWriteError("recurrence", "unsupported", "DATE recurrence requires an all-day event.");
      recurrenceDateValues(line);
      component.addProperty(ICAL.Property.fromString(line));
    } else if (/^(EXDATE|RDATE):/.test(line)) {
      const [propertyName, values] = line.split(":", 2) as [
        "EXDATE" | "RDATE",
        string,
      ];
      for (const value of values.split(",")) {
        const match = value.match(
          /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/,
        );
        if (!match) throw new EventWriteError("recurrence", "unsupported", "Unsupported or invalid recurrence date.");
        const date = new Date(
          Date.UTC(
            +match[1],
            +match[2] - 1,
            +match[3],
            +match[4],
            +match[5],
            +match[6],
          ),
        );
        if (date.getUTCFullYear() !== +match[1] || date.getUTCMonth() + 1 !== +match[2] || date.getUTCDate() !== +match[3] || date.getUTCHours() !== +match[4] || date.getUTCMinutes() !== +match[5] || date.getUTCSeconds() !== +match[6]) throw new EventWriteError("recurrence", "unsupported", "Unsupported or invalid recurrence date.");
        component.addPropertyWithValue(
          propertyName.toLowerCase(),
          isAllDay ? allDayTime(date) : ICAL.Time.fromJSDate(date, true),
        );
      }
    } else if (/^(EXDATE|RDATE)[;:]/i.test(line)) {
      throw new EventWriteError("recurrence", "unsupported", "Unsupported or invalid recurrence date.");
    }
  }
}

// VEVENT component -> normalized event fields. Shared with .ics calendar import;
// null if the component is malformed (missing dates etc.).
export function veventToFields(vevent: ICAL.Component) {
  let ev: ICAL.Event;
  let isAllDay: boolean;
  let start: Date, end: Date;
  try {
    ev = new ICAL.Event(vevent);
    isAllDay = ev.startDate.isDate;
    start = isAllDay ? utcMidnight(ev.startDate) : ev.startDate.toJSDate();
    end = isAllDay
      ? new Date(utcMidnight(ev.endDate).getTime() - 86400000) // iCal DTEND all-day is exclusive
      : ev.endDate.toJSDate();
  } catch {
    return null;
  }

  const organizer = vevent.getFirstPropertyValue("organizer");
  const recurrence = recurrenceFrom(vevent);

  return {
    title: ev.summary ?? "(untitled)",
    start,
    end,
    isAllDay,
    description: ev.description ?? null,
    location: ev.location ?? null,
    organizer:
      typeof organizer === "string" ? organizer.replace(/^mailto:/i, "") : null,
    recurrence,
  };
}

// iCal VEVENT (one calendar object) -> NormalizedEvent
export function icalToNormalized(obj: {
  url: string;
  etag?: string;
  data?: string;
}): NormalizedEvent | null {
  if (!obj.data) return null;
  let vevent: ICAL.Component | null;
  try {
    const comp = new ICAL.Component(ICAL.parse(obj.data));
    vevent = comp.getFirstSubcomponent("vevent");
  } catch {
    return null;
  }
  if (!vevent) return null;

  const fields = veventToFields(vevent);
  if (!fields) return null;
  const uid = vevent.getFirstPropertyValue("uid");

  return {
    providerState: caldavEventState(vevent),
    externalId: obj.url, // CalDAV addresses events by resource URL, not UID
    status:
      componentString(vevent, "status")?.toUpperCase() === "CANCELLED"
        ? "cancelled"
        : "active",
    ...fields,
    url: null,
    etag: obj.etag ?? null,
    icalUid: typeof uid === "string" ? uid : null,
  };
}

function componentTime(
  component: ICAL.Component,
  propertyName: string,
): ICAL.Time | null {
  const value = component.getFirstPropertyValue(
    propertyName,
  ) as ICAL.Time | null;
  return value && typeof value.toJSDate === "function" ? value : null;
}

function componentDate(time: ICAL.Time | null): Date | null {
  if (!time) return null;
  return time.isDate ? utcMidnight(time) : time.toJSDate();
}

function componentString(
  component: ICAL.Component,
  propertyName: string,
): string | null {
  const value = component.getFirstPropertyValue(propertyName);
  return typeof value === "string" ? value : null;
}

function componentInteger(
  component: ICAL.Component,
  propertyName: string,
  minimum: number,
  maximum: number,
): number {
  const value = Number(component.getFirstPropertyValue(propertyName));
  return Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : minimum;
}

export function vtodoToFields(vtodo: ICAL.Component) {
  const startTime = componentTime(vtodo, "dtstart");
  const dueTime = componentTime(vtodo, "due");
  const rawStatus = componentString(vtodo, "status")?.toUpperCase();
  const status =
    (rawStatus ? TASK_STATUS_BY_ICAL[rawStatus] : undefined) ?? "needs-action";

  return {
    title: componentString(vtodo, "summary") ?? "(untitled)",
    description: componentString(vtodo, "description"),
    status,
    start: componentDate(startTime),
    due: componentDate(dueTime),
    isAllDay: Boolean(startTime?.isDate || dueTime?.isDate),
    completedAt: componentDate(componentTime(vtodo, "completed")),
    percentComplete: componentInteger(vtodo, "percent-complete", 0, 100),
    priority: componentInteger(vtodo, "priority", 0, 9),
    recurrence: recurrenceFrom(vtodo),
    relatedTo: componentString(vtodo, "related-to"),
    sequence: componentInteger(vtodo, "sequence", 0, Number.MAX_SAFE_INTEGER),
    url: componentString(vtodo, "url"),
  };
}

export function icalToNormalizedTask(obj: {
  url: string;
  etag?: string;
  data?: string;
}): NormalizedTask | null {
  if (!obj.data) return null;
  let vtodo: ICAL.Component | null;
  try {
    const component = new ICAL.Component(ICAL.parse(obj.data));
    vtodo = component.getFirstSubcomponent("vtodo");
  } catch {
    return null;
  }
  if (!vtodo) return null;

  const uid = vtodo.getFirstPropertyValue("uid");
  return {
    externalId: obj.url,
    ...vtodoToFields(vtodo),
    etag: obj.etag ?? null,
    icalUid: typeof uid === "string" ? uid : null,
  };
}

// Musubi Event -> VEVENT component. Shared with calendar export (one VCALENDAR,
// many VEVENTs) — keep it independent of the wrapping calendar.
export type IcalEventFields = Pick<
  Event,
  | "id"
  | "title"
  | "description"
  | "location"
  | "isAllDay"
  | "start"
  | "end"
  | "recurrence"
>;

export function toVevent(
  event: IcalEventFields,
  uid = event.id,
): ICAL.Component {
  const vevent = new ICAL.Component("vevent");
  const ev = new ICAL.Event(vevent);
  ev.uid = uid;
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
  // Recurrence must round-trip: omitting it here would strip it on update.
  addRecurrence(vevent, event.recurrence, event.isAllDay);

  return vevent;
}

export type IcalTaskFields = Pick<
  Task,
  | "id"
  | "title"
  | "description"
  | "status"
  | "start"
  | "due"
  | "isAllDay"
  | "completedAt"
  | "percentComplete"
  | "priority"
  | "recurrence"
  | "relatedTo"
  | "sequence"
  | "url"
>;

export function toVtodo(task: IcalTaskFields, uid = task.id): ICAL.Component {
  const vtodo = new ICAL.Component("vtodo");
  vtodo.addPropertyWithValue("uid", uid);
  vtodo.addPropertyWithValue("summary", task.title);
  vtodo.addPropertyWithValue("status", task.status.toUpperCase());
  if (task.description)
    vtodo.addPropertyWithValue("description", task.description);
  if (task.start)
    vtodo.addPropertyWithValue(
      "dtstart",
      task.isAllDay
        ? allDayTime(task.start)
        : ICAL.Time.fromJSDate(task.start, true),
    );
  if (task.due)
    vtodo.addPropertyWithValue(
      "due",
      task.isAllDay
        ? allDayTime(task.due)
        : ICAL.Time.fromJSDate(task.due, true),
    );
  if (task.completedAt)
    vtodo.addPropertyWithValue(
      "completed",
      ICAL.Time.fromJSDate(task.completedAt, true),
    );
  vtodo.addPropertyWithValue("percent-complete", task.percentComplete);
  vtodo.addPropertyWithValue("priority", task.priority);
  vtodo.addPropertyWithValue("sequence", task.sequence);
  if (task.relatedTo) vtodo.addPropertyWithValue("related-to", task.relatedTo);
  if (task.url) vtodo.addPropertyWithValue("url", task.url);
  addRecurrence(vtodo, task.recurrence, task.isAllDay);
  return vtodo;
}

function patchProperties(
  target: ICAL.Component,
  replacement: ICAL.Component,
  propertyNames: string[],
) {
  for (const name of propertyNames) {
    target.removeAllProperties(name);
    for (const property of replacement.getAllProperties(name)) {
      target.addProperty(new ICAL.Property(property.toJSON()));
    }
  }
}

function preserveTimezones(
  current: ICAL.Component,
  replacement: ICAL.Component,
  propertyNames: string[],
) {
  for (const name of propertyNames) {
    const currentProperty = current.getFirstProperty(name);
    const replacementProperty = replacement.getFirstProperty(name);
    if (!currentProperty || !replacementProperty) continue;
    const tzid = currentProperty.getParameter("tzid");
    const next = replacementProperty.getFirstValue() as ICAL.Time | undefined;
    const previous = currentProperty.getFirstValue() as ICAL.Time | undefined;
    if (!tzid || !next || !previous || next.isDate || previous.isDate) continue;
    replacementProperty.setValue(
      ICAL.Time.fromJSDate(next.toJSDate(), true).convertToZone(previous.zone),
    );
    replacementProperty.setParameter("tzid", tzid);
  }
}

function patchTaskCalendarData(
  data: string,
  componentName: "vtodo",
  uid: string,
  replacement: ICAL.Component,
  propertyNames: string[],
) {
  const calendar = new ICAL.Component(ICAL.parse(data));
  const component = calendar
    .getAllSubcomponents(componentName)
    .find(
      (candidate) =>
        !candidate.getFirstProperty("recurrence-id") &&
        candidate.getFirstPropertyValue("uid") === uid,
    );
  if (!component)
    throw new Error(`CalDAV ${componentName} master ${uid} not found`);

  preserveTimezones(component, replacement, ["dtstart", "dtend", "due"]);
  const recurrenceProperties = new Set(["rrule", "exdate", "rdate"]);
  const recurrenceChanged = propertyNames.some(name => recurrenceProperties.has(name)) &&
    canonicalRecurrence(recurrenceFrom(component)) !==
    canonicalRecurrence(recurrenceFrom(replacement));
  patchProperties(
    component,
    replacement,
    recurrenceChanged
      ? propertyNames
      : propertyNames.filter((name) => !recurrenceProperties.has(name)),
  );
  if (recurrenceChanged) {
    for (const candidate of calendar.getAllSubcomponents(componentName)) {
      if (
        candidate !== component &&
        candidate.getFirstProperty("recurrence-id") &&
        candidate.getFirstPropertyValue("uid") === uid
      )
        calendar.removeSubcomponent(candidate);
    }
  }
  return calendar.toString();
}

function eventMaster(data: string, uid?: string | null) {
  const calendar = new ICAL.Component(ICAL.parse(data));
  if (calendar.name !== "vcalendar")
    throw new ProviderEventWriteError("provider-write-failed");
  const events = calendar.getAllSubcomponents("vevent");
  const masters = events.filter(
    (component) =>
      !component.getFirstProperty("recurrence-id") &&
      (uid == null || component.getFirstPropertyValue("uid") === uid),
  );
  if (masters.length !== 1 || masters[0].getAllProperties("uid").length !== 1) {
    throw new ProviderEventWriteError("provider-write-failed");
  }
  const master = masters[0];
  const actualUid = componentString(master, "uid");
  if (!actualUid) throw new ProviderEventWriteError("provider-write-failed");
  return { calendar, master, uid: actualUid, index: events.indexOf(master) };
}

export function patchEventIcal(
  data: string,
  event: Event,
  uid: string,
  patch?: EventContentPatch,
) {
  const diff = requireEventPatch(patch);
  const { calendar, master, index } = eventMaster(data, uid);
  const replacement = toVevent({ ...event, ...diff }, uid);
  const names = new Set<string>();
  for (const [field, name] of [
    ["title", "summary"],
    ["description", "description"],
    ["location", "location"],
    ["start", "dtstart"],
    ["end", "dtend"],
  ] as const) {
    if (diff[field] !== undefined) names.add(name);
  }
  if (diff.isAllDay !== undefined) {
    names.add("dtstart");
    names.add("dtend");
  }
  // Materialize the intended end rather than keeping a DURATION that would
  // implicitly shift the end on a start-only edit (DTEND and DURATION exclude).
  if (
    (names.has("dtstart") || names.has("dtend")) &&
    master.hasProperty("duration")
  ) {
    names.add("dtend");
    names.add("duration");
  }
  const recurrenceChanged =
    (diff.recurrence !== undefined || diff.isAllDay !== undefined) &&
    (canonicalRecurrence(recurrenceFrom(master)) !==
      canonicalRecurrence(recurrenceFrom(replacement)) ||
      (diff.isAllDay !== undefined && master.hasProperty("rrule")));
  if (recurrenceChanged) {
    if (
      calendar
        .getAllSubcomponents("vevent")
        .some(
          (candidate) =>
            candidate.hasProperty("recurrence-id") &&
            candidate.getFirstPropertyValue("uid") === uid,
        )
    ) {
      throw new EventWriteError(
        "recurrence",
        "unsupported",
        "CalDAV recurrence changes with detached exceptions are not supported yet. No changes were saved.",
      );
    }
    for (const name of ["rrule", "exdate", "rdate"]) names.add(name);
  }
  preserveTimezones(
    master,
    replacement,
    [...names].filter((name) => name === "dtstart" || name === "dtend"),
  );
  return replaceEventProperties(
    data,
    index,
    new Map(
      [...names].map((name) => [name, replacement.getAllProperties(name)]),
    ),
  );
}

export function patchTaskIcal(data: string, task: Task, uid: string, patch?: TaskProjection) {
  const fields: Record<string, string[]> = { title: ["summary"], description: ["description"], status: ["status"], start: ["dtstart"], due: ["due"], isAllDay: ["dtstart", "due"], completedAt: ["completed"], percentComplete: ["percent-complete"], priority: ["priority"], sequence: ["sequence"], relatedTo: ["related-to"], url: ["url"], recurrence: ["rrule", "exdate", "rdate"] };
  if (patch && Object.keys(patch).some(key => !fields[key])) throw new ProviderTaskWriteError("task-projection-unavailable");
  return patchTaskCalendarData(data, "vtodo", uid, toVtodo(task, uid), patch ? [...new Set(Object.keys(patch).flatMap(key => fields[key]))] : [
    "summary",
    "description",
    "status",
    "dtstart",
    "due",
    "completed",
    "percent-complete",
    "priority",
    "sequence",
    "related-to",
    "url",
    "rrule",
    "exdate",
    "rdate",
  ]);
}

// Musubi Event -> iCal string (single-event VCALENDAR, for CalDAV PUTs)
function toIcal(event: Event, uid = event.id): string {
  const vcal = new ICAL.Component("vcalendar");
  vcal.updatePropertyWithValue("version", "2.0");
  vcal.updatePropertyWithValue("prodid", "-//Musubi//EN");
  vcal.addSubcomponent(toVevent(event, uid));
  return vcal.toString();
}

function toTaskIcal(task: Task, uid = task.id): string {
  const vcal = new ICAL.Component("vcalendar");
  vcal.updatePropertyWithValue("version", "2.0");
  vcal.updatePropertyWithValue("prodid", "-//Musubi//EN");
  const component = toVtodo(task, uid);
  component.addPropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
  vcal.addSubcomponent(component);
  return vcal.toString();
}

/** The projection describes the VTODO wire format, including its second/date
 * precision. Canonical Musubi timestamps retain their original precision. */
export function projectCaldavTask(task: Task): TaskProjection {
  return canonicalTaskProjection(vtodoToFields(toVtodo(task)));
}

export function toCaldavTaskObject(
  externalTaskId: string,
  task: Task,
  ref?: ExternalTaskRef,
) {
  if (!ref?.etag)
    throw new Error("CalDAV task has no ETag; refusing an unsafe update");
  return {
    url: externalTaskId,
    data: toTaskIcal(task, ref.icalUid ?? task.id),
    etag: ref.etag,
  };
}

async function taskCalendarObjectForUpdate(
  client: Awaited<ReturnType<typeof clientForAccount>>,
  externalCalendarId: string,
  externalObjectId: string,
  ref: { etag?: string | null; icalUid?: string | null } | undefined,
  value: Task,
  patch?: TaskProjection,
) {
  if (!ref?.etag)
    throw new Error("CalDAV task has no ETag; refusing an unsafe update");
  const [object] = await client.fetchCalendarObjects({
    calendar: { url: externalCalendarId } as DAVCalendar,
    objectUrls: [externalObjectId],
  });
  if (!object?.data)
    throw new Error("CalDAV task resource is missing; refusing an update");
  assertTaskEtag(ref.etag, object.etag);
  const uid = ref.icalUid ?? icalToNormalizedTask(object)?.icalUid;
  if (!uid)
    throw new Error("CalDAV task has no UID; refusing an unsafe update");
  return {
    calendarObject: {
      url: externalObjectId,
      data: patchTaskIcal(object.data, value, uid, patch),
      etag: ref.etag,
    },
    uid,
  };
}

function absoluteDavUrl(href: string, calendarUrl: string) {
  return new URL(href, calendarUrl).href;
}

function isIcalUrl(value: string, base?: string) {
  try {
    return new URL(value, base).pathname.toLowerCase().endsWith(".ics");
  } catch {
    return false;
  }
}

function deletedObjectChanges(externalId: string): NormalizedChange[] {
  return [
    {
      kind: "event",
      data: {
        description: null,
        end: new Date(0),
        externalId,
        isAllDay: false,
        location: null,
        organizer: null,
        recurrence: null,
        start: new Date(0),
        status: "cancelled",
        title: "",
        url: null,
      },
    },
    {
      kind: "task",
      data: {
        completedAt: null,
        deleted: true,
        description: null,
        due: null,
        externalId,
        isAllDay: false,
        percentComplete: 0,
        priority: 0,
        recurrence: null,
        relatedTo: null,
        sequence: 0,
        start: null,
        status: "needs-action",
        title: "",
        url: null,
      },
    },
  ];
}

function assertCompleteObjects(urls: string[], objects: DAVCalendarObject[]) {
  const received = new Set(objects.map(object => object.url));
  if (received.size !== objects.length || received.size !== new Set(urls).size || urls.some(url => !received.has(url)))
    throw new Error("CalDAV resource fetch was incomplete; cursor remains unchanged.");
}

export function normalizedObjectChanges(
  objects: DAVCalendarObject[],
  organizerEventIDs: ReadonlySet<string> = new Set(),
): NormalizedChange[] {
  const changes: NormalizedChange[] = [];
  for (const object of objects) {
    if (config.api.eventTimeEditsEnabled) {
      const events = normalizeCaldavResource(object);
      if (events.length) {
        if (events[0]!.status === "cancelled") changes.push({ kind: "event", data: events[0]! });
        else changes.push({ kind: "event-resource", externalId: object.url, events });
        continue;
      }
    }
    if (organizerEventIDs.has(object.url)) {
      const native = normalizeCaldavResource(object);
      if (native.length !== 1 || native[0]!.recurrence || native[0]!.originalStart)
        throw new ProviderEventWriteError("provider-conflict");
      changes.push({ kind: "event", data: native[0]! });
      continue;
    }
    const event = icalToNormalized(object);
    const task = icalToNormalizedTask(object);
    if (!event && !task) {
      try {
        const calendar = new ICAL.Component(ICAL.parse(object.data));
        if (
          calendar.getFirstSubcomponent("vevent") ||
          calendar.getFirstSubcomponent("vtodo")
        )
          throw new Error(`Invalid calendar resource: ${object.url}`);
      } catch (error) {
        throw error instanceof Error
          ? error
          : new Error(`Invalid calendar resource: ${object.url}`);
      }
    }
    if (event && config.api.providerRsvpEditsEnabled) {
      // RSVP-only import keeps the legacy read shape and enriches only an
      // isolated supported event; recurrence/unknown reads retain compatibility.
      try {
        const native = normalizeCaldavResource(object);
        if (native.length === 1 && !native[0]!.recurrence && !native[0]!.originalStart && ["zoned", "all-day"].includes(native[0]!.timeModel?.kind ?? "")) event.reminderTimeEvidence = { timeModel: native[0]!.timeModel!, start: native[0]!.start, end: native[0]!.end, isAllDay: native[0]!.isAllDay };
      } catch { /* No write-time evidence for an unsupported native resource. */ }
    }
    if (event) changes.push({ kind: "event", data: event });
    if (task) changes.push({ kind: "task", data: task });
  }
  return changes;
}

function syncTokenFrom(responses: DAVResponse[]) {
  const token = responses.find((response) => response.raw)?.raw?.multistatus
    ?.syncToken;
  return token == null ? null : String(token);
}

async function incrementalChanges(
  client: Awaited<ReturnType<typeof clientForAccount>>,
  calendar: DAVCalendar,
  cursor: string | null,
  organizerEventIDs: ReadonlySet<string>,
): Promise<FetchChangesResult> {
  const responses = await client.syncCollection({
    props: { "d:getetag": {} },
    syncLevel: 1,
    syncToken: cursor ?? undefined,
    url: calendar.url,
  });
  const failed = responses.find(
    (response) => response.status !== 404 && !response.ok,
  );
  if (failed) {
    throw new Error(
      `CalDAV sync-collection failed: ${failed.status} ${failed.statusText}`,
    );
  }

  const objectResponses = responses.filter((response) => {
    if (!response.href) return false;
    try {
      return new URL(response.href, calendar.url).pathname
        .toLowerCase()
        .endsWith(".ics");
    } catch {
      return false;
    }
  });
  const changedUrls = objectResponses.flatMap((response) =>
    response.status !== 404 && response.href
      ? [absoluteDavUrl(response.href, calendar.url)]
      : [],
  );
  const objects = changedUrls.length
    ? await client.fetchCalendarObjects({
        calendar,
        objectUrls: changedUrls,
      })
    : [];
  assertCompleteObjects(changedUrls, objects);
  const changes = normalizedObjectChanges(objects, organizerEventIDs);
  for (const response of objectResponses) {
    if (response.status === 404) {
      changes.push(
        ...deletedObjectChanges(absoluteDavUrl(response.href!, calendar.url)),
      );
    }
  }

  const nextCursor = syncTokenFrom(responses);
  if (!nextCursor) throw new Error("CalDAV sync-collection returned no token");
  return { changes, nextCursor, reset: cursor === null };
}

async function etagAfterWrite(
  client: Awaited<ReturnType<typeof clientForAccount>>,
  externalCalendarId: string,
  externalEventId: string,
  response: Response,
) {
  const responseEtag = response.headers.get("etag");
  if (responseEtag) return responseEtag;

  try {
    const [object] = await client.fetchCalendarObjects({
      calendar: { url: externalCalendarId } as any,
      objectUrls: [externalEventId],
    });
    return object?.etag ?? null;
  } catch (error) {
    logger.warn("caldav.event.etag_refresh_failed", {
      externalCalendarId,
      externalEventId,
      error,
    });
    return null;
  }
}

/** A complete GET and its own strong ETag, checked against the version already
 * accepted into the mapping. A newer GET must not silently rebase the edit.
 */
async function readEventResource(
  authorization: string,
  externalEventId: string,
  ref?: ExternalEventRef,
  signal?: AbortSignal,
  redirect: RequestRedirect = "follow",
  observeCurrent = false,
) {
  const acceptedEtag = requireEventEtag(ref?.etag);
  const response = await caldavFetch(externalEventId, {
    signal,
    redirect,
    headers: {
      authorization,
      accept: "text/calendar",
      "Cache-Control": "no-cache",
    },
  });
  assertEventWriteResponse(response);
  const etag = requireEventEtag(response.headers.get("etag"));
  if (!observeCurrent) assertAcceptedEventEtag(acceptedEtag, etag);
  if (response.status !== 200 || response.headers.has("content-range")) {
    throw new ProviderEventWriteError("provider-write-failed");
  }
  // UTF-8 decoding must not replace invalid bytes and then PUT lossy text.
  const data = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(await response.arrayBuffer());
  const { master, uid, index } = eventMaster(data, ref?.icalUid);
  replaceEventProperties(data, index, new Map()); // Validate full physical structure, including DELETE preflight.
  return { data, etag, master, uid };
}

function eventTimeProperties(input: Event) {
  const event = EventSchema.parse(input);
  const model = EventTimeModelSchema.parse(event.timeModel);
  if (model.kind === "legacy-unknown") throw new EventWriteError("event-write", "unsupported");
  function timeProperty(name: "dtstart" | "dtend", end: boolean) {
    const prop = new ICAL.Property(name);
    if (model.kind === "all-day") prop.setValue(allDayTime(end ? new Date(event.end.getTime() + 86400000) : event.start));
    else {
      if (model.kind === "legacy-unknown") throw new EventWriteError("event-write", "unsupported");
      const civil = end ? model.endLocal : model.startLocal;
      if (!civil.endsWith(".000")) throw new EventWriteError("event-write", "unsupported");
      const utc = model.kind === "zoned" && model.timeZone === "UTC";
      prop.setValue(ICAL.Time.fromDateTimeString(civil.slice(0, -4) + (utc ? "Z" : ""), prop));
      if (model.kind === "zoned" && !utc) prop.setParameter("tzid", model.timeZone);
    }
    return prop;
  }
  return { start: timeProperty("dtstart", false), end: timeProperty("dtend", true) };
}

function occurrenceIdentityProperty(master: Event, originalStart: OccurrenceStart, definitionID: string) {
  const definition = planEventScope(master, [], { operationID: definitionID, scope: "occurrence", action: "update", expectedRevision: master.revision, originalStart, expectedOccurrenceRevision: null, patch: {}, ensureDefinition: true }, () => definitionID).creates[0]!;
  const property = structuredClone(eventTimeProperties(definition).start.toJSON());
  property[0] = "recurrence-id";
  return new ICAL.Property(property);
}

/** Rebuild the permitted content/cancellation change from complete original bytes.
 * A persisted replacement cannot widen the scope or invent a recurrence member. */
export function prepareCaldavSeriesWrite(evidence: CaldavSeriesEvidence, baseline: CaldavSeriesIntent, patch: CaldavSeriesWrite["patch"], targetEventID?: string, cancelTarget?: true, newDefinition?: Event, time?: EventTimeEdit, followingDelete?: CaldavSeriesWrite["followingDelete"]): CaldavSeriesWrite {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some(key => !["title", "description", "location", "recurrence"].includes(key)))
    throw new EventWriteError("event-write", "unsupported");
  caldavSeriesEvidence(evidence.data, baseline);
  if (evidence.ref.externalEventId !== baseline.ref.externalEventId || evidence.ref.icalUid !== baseline.ref.icalUid || evidence.ref.etag !== baseline.ref.etag)
    throw new ProviderEventWriteError("provider-conflict");
  const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, item]) => item !== undefined));
  const restoredDates = typeof cleanPatch.recurrence === "string" && /(?:^|\n)EXDATE/.test(baseline.master.recurrence ?? "") ? caldavExdateRestoration(baseline.master, cleanPatch.recurrence) : undefined;
  const rdateEdit = typeof cleanPatch.recurrence === "string" && /(?:^|\n)RDATE/.test((baseline.master.recurrence ?? "") + "\n" + cleanPatch.recurrence) ? caldavRdateEdit(baseline.master, cleanPatch.recurrence) : undefined;
  if (typeof cleanPatch.recurrence === "string" && !restoredDates && !rdateEdit) {
    const canonical = "RRULE:" + ICAL.Recur.fromString(cleanPatch.recurrence.replace(/^RRULE:/i, "")).toString();
    if (!sameCaldavRecurrence(cleanPatch.recurrence, canonical)) throw new EventWriteError("event-write", "unsupported");
    cleanPatch.recurrence = canonical;
  }
  if (cleanPatch.recurrence === null) {
    const { master } = eventMaster(evidence.data, baseline.ref.icalUid);
    if (master.getAllProperties("rrule").length !== 1 || master.hasProperty("rdate") || master.hasProperty("exdate")) throw new EventWriteError("event-write", "unsupported");
  }
  const desired = caldavSeriesDesired({ baseline, patch: cleanPatch, targetEventID, cancelTarget, newDefinition, time, followingDelete });
  if (time?.kind === "zoned" && baseline.master.timeModel?.kind === "zoned" && time.timeZone !== baseline.master.timeModel.timeZone) {
    // Embedded native rules must agree with the complete accepted IANA footprint.
    // Keep the original VTIMEZONE bytes even though UTC no longer references it.
    const zoneID = baseline.master.timeModel.timeZone;
    const definitions = new ICAL.Component(ICAL.parse(evidence.data)).getAllSubcomponents("vtimezone").filter(component => component.getFirstPropertyValue("tzid") === zoneID);
    if (definitions.length > 1) throw new EventWriteError("event-write", "unsupported");
    if (definitions.length) {
      const zone = new ICAL.Timezone({ component: definitions[0]!, tzid: zoneID });
      for (const slot of finiteSeriesFootprint(EventSchema.parse(baseline.master))) {
        if (slot.timeModel.kind !== "zoned") throw new EventWriteError("event-write", "unsupported");
        for (const [civil, instant] of [[slot.timeModel.startLocal, slot.start], [slot.timeModel.endLocal, slot.end]] as const) {
          const native = ICAL.Time.fromDateTimeString(civil.slice(0, 19));
          native.zone = zone;
          if (native.toUnixTime() * 1000 !== instant.getTime()) throw new EventWriteError("event-write", "unsupported");
        }
      }
    }
  }
  let after: string;
  if (restoredDates) {
    const { index } = eventMaster(evidence.data, baseline.ref.icalUid);
    after = restoreEventExdates(evidence.data, index, restoredDates);
  } else if (rdateEdit) {
    const { index } = eventMaster(evidence.data, baseline.ref.icalUid);
    after = editEventRdate(evidence.data, index, { ...rdateEdit, rule: baseline.master.recurrence!.split("\n")[0]! });
  } else if (followingDelete) {
    const { master, index } = eventMaster(evidence.data, baseline.ref.icalUid);
    const rule = new ICAL.Property("rrule");
    rule.setValue(ICAL.Recur.fromString(desired.master.recurrence!.replace(/^RRULE:/i, "")));
    Object.assign(rule.toJSON()[1], structuredClone(master.getFirstProperty("rrule")!.toJSON()[1]));
    after = replaceEventProperties(evidence.data, index, new Map([["rrule", [rule]]]));
    const components = new ICAL.Component(ICAL.parse(evidence.data)).getAllSubcomponents("vevent");
    const exceptions = components.filter(item => item.hasProperty("recurrence-id"));
    const removed = baseline.children.filter(child => !desired.children.some(item => item.id === child.id)).map(child => {
      const ordinal = evidence.exceptions.findIndex(item => JSON.stringify(item.originalStart) === JSON.stringify(child.originalStart));
      return components.indexOf(exceptions[ordinal]!);
    });
    after = removeEventComponents(after, removed);
  } else if (newDefinition) {
    newDefinition = EventSchema.parse(newDefinition);
    const components = new ICAL.Component(ICAL.parse(evidence.data)).getAllSubcomponents("vevent");
    const masterIndex = components.findIndex(item => !item.hasProperty("recurrence-id"));
    const newline = evidence.data.includes("\r\n") ? "\r\n" : "\n";
    const template = `BEGIN:VCALENDAR${newline}${eventComponentBytes(evidence.data, masterIndex)}END:VCALENDAR${newline}`;
    const { start, end } = eventTimeProperties(newDefinition);
    // A moved generated definition keeps the old recurrence slot identity.
    const original = occurrenceIdentityProperty(baseline.master, newDefinition.originalStart!, newDefinition.id);
    const replacements = new Map<string, ICAL.Property[]>([["dtstart", [start]], ["dtend", [end]], ["duration", []], ["rrule", []], ["rdate", []], ["exdate", []], ["recurrence-id", [original]]]);
    for (const [field, name] of [["title", "summary"], ["description", "description"], ["location", "location"]] as const) {
      if (cleanPatch[field] === undefined) continue;
      const component = new ICAL.Component("vevent");
      if (cleanPatch[field] !== null) component.addPropertyWithValue(name, cleanPatch[field]);
      replacements.set(name, component.getAllProperties(name));
    }
    if (cancelTarget) { const status = new ICAL.Property("status"); status.setValue("CANCELLED"); replacements.set("status", [status]); }
    after = appendEventComponent(evidence.data, eventComponentBytes(replaceEventProperties(template, 0, replacements), 0));
  } else if (targetEventID) {
    const child = baseline.children.find(item => item.id === targetEventID)!;
    const original = JSON.stringify(child.originalStart);
    const ordinal = evidence.exceptions.findIndex(item => JSON.stringify(item.originalStart) === original);
    const components = new ICAL.Component(ICAL.parse(evidence.data)).getAllSubcomponents("vevent");
    const component = components.filter(item => item.hasProperty("recurrence-id"))[ordinal];
    if (!component) throw new ProviderEventWriteError("provider-conflict");
    const replacements = new Map<string, ICAL.Property[]>();
    for (const [field, name] of [["title", "summary"], ["description", "description"], ["location", "location"]] as const) {
      if (cleanPatch[field] === undefined) continue;
      const replacement = new ICAL.Component("vevent");
      if (cleanPatch[field] !== null) replacement.addPropertyWithValue(name, cleanPatch[field]);
      replacements.set(name, replacement.getAllProperties(name));
    }
    if (time) {
      const { start, end } = eventTimeProperties(desired.children.find(item => item.id === targetEventID)!);
      replacements.set("dtstart", [start]); replacements.set("dtend", [end]); replacements.set("duration", []);
    }
    if (cancelTarget || child.isCanceled) {
      const cancellation = new ICAL.Property("status"); cancellation.setValue(cancelTarget ? "CANCELLED" : "CONFIRMED");
      replacements.set("status", [cancellation]);
    }
    after = replaceEventProperties(evidence.data, components.indexOf(component), replacements);
  } else {
    const { recurrence: _recurrence, ...contentPatch } = cleanPatch;
    after = patchEventIcal(evidence.data, desired.master, baseline.ref.icalUid!, contentPatch);
    if (cleanPatch.recurrence !== undefined) {
      const { master, index } = eventMaster(after, baseline.ref.icalUid);
      const rules: ICAL.Property[] = [];
      if (desired.master.recurrence !== null) {
        const rule = new ICAL.Property("rrule");
        rule.setValue(ICAL.Recur.fromString(desired.master.recurrence!.replace(/^RRULE:/i, "")));
        Object.assign(rule.toJSON()[1], structuredClone(master.getFirstProperty("rrule")!.toJSON()[1]));
        rules.push(rule);
      }
      after = replaceEventProperties(after, index, new Map([["rrule", rules]]));
    }
    if (time) {
      const { index } = eventMaster(after, baseline.ref.icalUid);
      const { start, end } = eventTimeProperties(desired.master);
      after = replaceEventProperties(after, index, new Map([["dtstart", [start]], ["dtend", [end]], ["duration", []]]));
      const components = new ICAL.Component(ICAL.parse(evidence.data)).getAllSubcomponents("vevent");
      const exceptions = components.filter(item => item.hasProperty("recurrence-id"));
      for (const child of baseline.children) {
        const next = desired.children.find(item => item.id === child.id)!;
        if (JSON.stringify(child.originalStart) === JSON.stringify(next.originalStart)) continue;
        const ordinal = evidence.exceptions.findIndex(item => JSON.stringify(item.originalStart) === JSON.stringify(child.originalStart));
        const componentIndex = components.indexOf(exceptions[ordinal]!);
        after = replaceEventProperties(after, componentIndex, new Map([["recurrence-id", [occurrenceIdentityProperty(desired.master, next.originalStart!, child.id)]]]));
      }
    }
  }
  caldavSeriesEvidence(after, desired);
  return { baseline, patch: cleanPatch, ...(targetEventID ? { targetEventID } : {}), ...(cancelTarget ? { cancelTarget } : {}), ...(newDefinition ? { newDefinition } : {}), ...(time ? { time } : {}), ...(followingDelete ? { followingDelete } : {}), before: evidence.data, after };
}

/** Pure split preparation. It does not promise atomicity across two resources. */
export function prepareCaldavSeriesSplit(evidence: CaldavSeriesEvidence, baseline: CaldavSeriesIntent, input: unknown, newRootID: string = randomUUID()): CaldavSeriesSplit {
  const request = EventScopeRequestSchema.parse(input);
  if (request.scope !== "following" || request.action !== "update" || Object.keys(request.patch).some(key => !["title", "description", "location", "recurrence"].includes(key)) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(newRootID) || newRootID === baseline.ref.icalUid) throw new EventWriteError("event-write", "unsupported");
  caldavSeriesEvidence(evidence.data, baseline);
  if (evidence.ref.externalEventId !== baseline.ref.externalEventId || evidence.ref.icalUid !== baseline.ref.icalUid || evidence.ref.etag !== baseline.ref.etag) throw new ProviderEventWriteError("provider-conflict");
  let plannedRequest = request;
  if (typeof request.patch.recurrence === "string") {
    const recurrence = "RRULE:" + ICAL.Recur.fromString(request.patch.recurrence.replace(/^RRULE:/i, "")).toString();
    if (!sameCaldavRecurrence(request.patch.recurrence, recurrence)) throw new EventWriteError("event-write", "unsupported");
    plannedRequest = { ...request, patch: { ...request.patch, recurrence } };
  }
  const plan = planEventScope(baseline.master, baseline.children, plannedRequest, () => newRootID);
  if (plan.creates.length !== 1 || plan.deletes.length || plan.creates[0]!.seriesID || !plan.updates.some(item => item.id === baseline.master.id)) throw new EventWriteError("event-write", "unsupported", "A first-slot or unchanged edit does not require a split.");
  const master = plan.creates[0]!;
  if (master.timeModel?.kind !== baseline.master.timeModel?.kind || master.timeModel?.kind === "zoned" && (baseline.master.timeModel?.kind !== "zoned" || master.timeModel.timeZone !== baseline.master.timeModel.timeZone)) throw new EventWriteError("event-write", "unsupported");
  const children = plan.updates.filter(item => item.seriesID === newRootID);
  const parsed = new ICAL.Component(ICAL.parse(evidence.data));
  if (parsed.getAllSubcomponents().some(item => !["vevent", "vtimezone"].includes(item.name))) throw new EventWriteError("event-write", "unsupported");
  const components = parsed.getAllSubcomponents("vevent");
  const index = components.findIndex(item => !item.hasProperty("recurrence-id"));
  let data = removeEventComponents(evidence.data, components.flatMap((_, ordinal) => ordinal === index ? [] : [ordinal]));
  const uid = new ICAL.Property("uid"); uid.setValue(newRootID);
  const rule = new ICAL.Property("rrule"); rule.setValue(ICAL.Recur.fromString(master.recurrence!.replace(/^RRULE:/i, "")));
  Object.assign(rule.toJSON()[1], structuredClone(components[index]!.getFirstProperty("rrule")!.toJSON()[1]));
  const { start, end } = eventTimeProperties(master);
  const replacements = new Map<string, ICAL.Property[]>([["uid", [uid]], ["rrule", [rule]], ["dtstart", [start]], ["dtend", [end]], ["duration", []]]);
  for (const [field, name] of [["title", "summary"], ["description", "description"], ["location", "location"]] as const) {
    if (request.patch[field] === undefined) continue;
    const value = new ICAL.Component("vevent"); if (request.patch[field] !== null) value.addPropertyWithValue(name, request.patch[field]);
    replacements.set(name, value.getAllProperties(name));
  }
  data = replaceEventProperties(data, 0, replacements);
  const nativeChildren = components.filter(item => item.hasProperty("recurrence-id"));
  for (const [ordinal, observed] of evidence.exceptions.entries()) {
    const old = baseline.children.find(item => JSON.stringify(item.originalStart) === JSON.stringify(observed.originalStart))!;
    const next = children.find(item => item.id === old.id); if (!next) continue;
    const newline = evidence.data.includes("\r\n") ? "\r\n" : "\n";
    const wrapper = `BEGIN:VCALENDAR${newline}${eventComponentBytes(evidence.data, components.indexOf(nativeChildren[ordinal]!))}END:VCALENDAR${newline}`;
    const changes = new Map<string, ICAL.Property[]>([["uid", [uid]]]);
    if (JSON.stringify(old.originalStart) !== JSON.stringify(next.originalStart)) changes.set("recurrence-id", [occurrenceIdentityProperty({ ...master, revision: 1 }, next.originalStart!, next.id)]);
    data = appendEventComponent(data, eventComponentBytes(replaceEventProperties(wrapper, 0, changes), 0));
  }
  const creation = { ref: { externalEventId: new URL(`musubi-${newRootID}.ics`, baseline.ref.externalEventId).href, icalUid: newRootID }, master, children, data };
  caldavSeriesCreationEvidence(data, creation);
  const source = prepareCaldavSeriesWrite(evidence, baseline, {}, undefined, undefined, undefined, undefined, { originalStart: request.originalStart!, expectedOccurrenceRevision: request.expectedOccurrenceRevision! });
  return { source, request, creation };
}

function rebuildCaldavSplit(split: CaldavSeriesSplit): CaldavSeriesSplit {
  const rebuilt = prepareCaldavSeriesSplit(caldavSeriesEvidence(split.source.before, split.source.baseline), split.source.baseline, split.request, split.creation.master.id);
  if (!sameCaldavScopeContext(rebuilt, split)) throw new ProviderEventWriteError("provider-conflict");
  return rebuilt;
}

/** A complete desired resource can be recovered; another resource at the
 * reserved URL must stop the source write before it truncates anything. */
async function readCaldavSplitCreation(resource: URL, creation: CaldavSeriesSplit["creation"], authorization: string, signal?: AbortSignal) {
  const response = await caldavFetch(resource.href, { signal, redirect: "error", method: "GET", headers: { authorization, accept: "text/calendar", "Cache-Control": "no-cache" } });
  if (response.status === 404) { await response.body?.cancel().catch(() => {}); return null; }
  assertEventWriteResponse(response);
  if (response.status !== 200 || response.headers.has("content-range")) throw new ProviderEventWriteError("provider-write-failed");
  const etag = requireEventEtag(response.headers.get("etag"));
  const data = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await response.arrayBuffer());
  if (!sameCaldavResource(data, creation.data)) throw new ProviderEventWriteError("provider-conflict");
  return caldavSeriesEvidence(data, { ...creation, ref: { ...creation.ref, etag } });
}

/** The durable journal owns ordering; this step creates only its new resource. */
export async function createCaldavSplitResource(externalCalendarId: string, split: CaldavSeriesSplit, authorization: string, signal?: AbortSignal, beforeMutation?: () => Promise<void>): Promise<CaldavSeriesEvidence> {
  if (!config.api.eventTimeEditsEnabled) throw new EventWriteError("event-write", "unsupported");
  const rebuilt = rebuildCaldavSplit(split);
  const resource = caldavSeriesResourceURL(externalCalendarId, rebuilt.creation.ref.externalEventId);
  const read = () => readCaldavSplitCreation(resource, rebuilt.creation, authorization, signal);
  const existing = await read(); if (existing) return existing;
  await beforeMutation?.(); signal?.throwIfAborted();
  let accepted = false;
  try {
    const response = await caldavFetch(resource.href, { signal, redirect: "error", method: "PUT", headers: { authorization, "Content-Type": "text/calendar; charset=utf-8", "If-None-Match": "*" }, body: rebuilt.creation.data });
    assertProviderEventMutationResponse(response); accepted = true;
    const result = await read(); if (!result) throw new ProviderEventWriteError("provider-conflict", "unconfirmed");
    return result;
  } catch (error) {
    if (!accepted && error instanceof ProviderEventWriteError && error.providerStatus !== undefined) throw error;
    throw new ProviderEventWriteError("provider-write-failed", "unconfirmed", error instanceof ProviderEventWriteError ? error.providerStatus : undefined);
  }
}

async function rsvpAuthorization(userID: string, accountID: string, externalCalendarID: string) {
  if (!config.api.providerRsvpEditsEnabled) throw new EventWriteError("event-write", "unsupported");
  return schedulingAuthorization(userID, accountID, externalCalendarID);
}
async function schedulingAuthorization(userID: string, accountID: string, externalCalendarID: string) {
  const accounts = await getCaldavAccountsByUser(userID);
  const calendars = await getUserExternalCalendars("caldav", userID, accountID);
  if (!accounts.some(item => item.id === accountID) || !calendars.some(item => item.externalCalendarID === externalCalendarID && item.supportsEvents)) throw new EventWriteError("event-write", "denied");
  const selected = calendars.find(item => item.externalCalendarID === externalCalendarID)!;
  const link = await getExternalLinkForCalendar(selected.calendarID);
  if (!link || link.disabled || link.userID !== userID || link.accountID !== accountID || link.provider !== "caldav" || link.externalCalendarID !== externalCalendarID || !link.supportsEvents) throw new EventWriteError("event-write", "denied");
  return basicAuthForAccount(accountID);
}

/** Re-read the authenticated account and enabled link; persisted evidence cannot
 * grant compatibility after account, destination or feature policy changes. */
async function icloudRsvpEligibility(userID: string, accountID: string, calendar: string, resource: string): Promise<boolean> {
  if (!config.api.providerRsvpEditsEnabled || !config.api.icloudRsvpEditsEnabled) return false;
  await rsvpAuthorization(userID, accountID, calendar);
  const account = (await getCaldavAccountsByUser(userID)).find(item => item.id === accountID);
  return !!account && isIcloudRsvpDestination(account.serverUrl, calendar, resource);
}

async function seriesAuthorization(userID: string, accountId: string, externalCalendarId: string, intent: CaldavSeriesIntent, signal?: AbortSignal, action: "update" | "delete" | "create" = "update", operation?: CaldavPersonalContentOperation) {
  if (!config.api.eventTimeEditsEnabled)
    throw new EventWriteError("event-write", "unsupported");
  return resourceAuthorization(userID, accountId, externalCalendarId, intent, signal, action, operation);
}

async function resourceAuthorization(userID: string, accountId: string, externalCalendarId: string, intent: Pick<CaldavSeriesIntent, "master" | "ref">, signal?: AbortSignal, action: "update" | "delete" | "create" = "update", operation?: CaldavPersonalContentOperation) {
  const accounts = await getCaldavAccountsByUser(userID);
  if (!accounts.some(account => account.id === accountId))
    throw new EventWriteError("event-write", "denied");
  const links = await getUserExternalCalendars("caldav", userID, accountId);
  if (!links.some(link => link.supportsEvents && link.externalCalendarID === externalCalendarId && link.calendarID === intent.master.originCalendarID))
    throw new EventWriteError("event-write", "denied");
  const link = intent.master.originCalendarID ? await getExternalLinkForCalendar(intent.master.originCalendarID) : null;
  if (!link || link.disabled || !link.supportsEvents || link.userID !== userID || link.provider !== "caldav" || link.accountID !== accountId || link.externalCalendarID !== externalCalendarId)
    throw new EventWriteError("event-write", "denied");
  const resource = caldavSeriesResourceURL(externalCalendarId, intent.ref.externalEventId);
  const authorization = await basicAuthForAccount(accountId);
  const account = accounts.find(account => account.id === accountId)!;
  const eligible = config.api.icloudPersonalContentWritesEnabled && action === "update"
    && isCaldavPersonalContentOperation(operation)
    && isIcloudPersonalContentDestination(account.serverUrl, externalCalendarId, resource.href);
  const permission = await caldavEventWritePermission(action !== "update" ? externalCalendarId : resource.href, authorization, signal, "error");
  const allowed = caldavAllows(permission.privileges, action);
  // An explicit privilege set without write-content is always a denial. Only
  // narrowly identified missing-property evidence can use the iCloud fallback.
  assertEventWriteEvidence(allowed === undefined && eligible && permission.missing ? true : allowed, "event-write");
  return { resource, authorization };
}

export function prepareCaldavSeriesDeletion(evidence: CaldavSeriesEvidence, baseline: CaldavSeriesIntent): CaldavSeriesDeletion {
  caldavSeriesEvidence(evidence.data, baseline);
  if (evidence.ref.externalEventId !== baseline.ref.externalEventId || evidence.ref.icalUid !== baseline.ref.icalUid || evidence.ref.etag !== baseline.ref.etag) throw new ProviderEventWriteError("provider-conflict");
  return { baseline, before: evidence.data };
}

/** Absence after a conditional DELETE is evidence; a successful status alone is not. */
export async function deleteCaldavSeriesResource(externalCalendarId: string, deletion: CaldavSeriesDeletion, authorization: string, signal?: AbortSignal, beforeMutation?: () => Promise<void>): Promise<ExternalEventRef> {
  if (!config.api.eventTimeEditsEnabled) throw new EventWriteError("event-write", "unsupported");
  const { baseline, before } = deletion;
  caldavSeriesEvidence(before, baseline);
  const resource = caldavSeriesResourceURL(externalCalendarId, baseline.ref.externalEventId);
  const read = async () => {
    const response = await caldavFetch(resource.href, { signal, redirect: "error", method: "GET", headers: { authorization, accept: "text/calendar", "Cache-Control": "no-cache" } });
    if (response.status === 404) { await response.body?.cancel().catch(() => {}); return null; }
    assertEventWriteResponse(response);
    if (response.status !== 200 || response.headers.has("content-range")) throw new ProviderEventWriteError("provider-write-failed");
    const etag = requireEventEtag(response.headers.get("etag"));
    const data = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await response.arrayBuffer());
    return { data, etag };
  };
  const current = await read();
  if (!current) return baseline.ref;
  if (current.etag !== baseline.ref.etag || !sameCaldavResource(current.data, before)) throw new ProviderEventWriteError("provider-conflict");
  await beforeMutation?.();
  signal?.throwIfAborted();
  let accepted = false;
  try {
    const response = await caldavFetch(resource.href, { signal, redirect: "error", method: "DELETE", headers: { authorization, "If-Match": requireEventEtag(baseline.ref.etag) } });
    assertProviderEventMutationResponse(response);
    accepted = true;
    if (await read()) throw new ProviderEventWriteError("provider-conflict", "unconfirmed");
    return baseline.ref;
  } catch (error) {
    if (!accepted && error instanceof ProviderEventWriteError && error.providerStatus !== undefined) throw error;
    if (error instanceof ProviderEventWriteError && error.outcome === "unconfirmed") throw error;
    throw new ProviderEventWriteError("provider-write-failed", "unconfirmed", error instanceof ProviderEventWriteError ? error.providerStatus : undefined);
  }
}

export async function deliverCaldavSeriesResource(externalCalendarId: string, write: CaldavSeriesWrite, authorization: string, signal?: AbortSignal, beforeMutation?: () => Promise<void>): Promise<CaldavSeriesEvidence> {
  if (!config.api.eventTimeEditsEnabled) throw new EventWriteError("event-write", "unsupported");
  const { baseline } = write;
  const rebuilt = prepareCaldavSeriesWrite(caldavSeriesEvidence(write.before, baseline), baseline, write.patch, write.targetEventID, write.cancelTarget, write.newDefinition, write.time, write.followingDelete);
  if (rebuilt.after !== write.after) throw new ProviderEventWriteError("provider-conflict");
  const desired = caldavSeriesDesired(rebuilt);
  const resource = caldavSeriesResourceURL(externalCalendarId, baseline.ref.externalEventId);
  const read = () => readEventResource(authorization, resource.href, baseline.ref, signal, "error", true);
  const evidence = (current: Awaited<ReturnType<typeof read>>) => caldavSeriesEvidence(current.data, { ...desired, ref: { ...baseline.ref, etag: current.etag } });
  const current = await read();
  // Full desired resource proves a previous ambiguous PUT. Never repeat it,
  // and never treat a master-only match as evidence about detached children.
  if (sameCaldavResource(current.data, write.after)) return evidence(current);
  if (current.etag !== baseline.ref.etag || !sameCaldavResource(current.data, write.before))
    throw new ProviderEventWriteError("provider-conflict");
  await beforeMutation?.();
  signal?.throwIfAborted();
  let accepted = false;
  try {
    const response = await caldavFetch(resource.href, {
      signal, redirect: "error", method: "PUT",
      headers: { authorization, "Content-Type": "text/calendar; charset=utf-8", "If-Match": requireEventEtag(baseline.ref.etag) },
      body: write.after,
    });
    assertProviderEventMutationResponse(response);
    accepted = true;
    // A successful PUT alone cannot confirm content after server transforms.
    // Even a returned strong ETag is followed by a complete family GET.
    const confirmed = await read();
    if (!sameCaldavResource(confirmed.data, write.after))
      throw new ProviderEventWriteError("provider-conflict", "unconfirmed");
    return evidence(confirmed);
  } catch (error) {
    if (!accepted && error instanceof ProviderEventWriteError && error.providerStatus !== undefined) throw error;
    if (error instanceof ProviderEventWriteError && error.outcome === "unconfirmed") throw error;
    // Network errors, timeouts and failed post-write reads cannot prove that
    // the PUT did not happen. Reconcile the same durable input on retry.
    throw new ProviderEventWriteError("provider-write-failed", "unconfirmed", error instanceof ProviderEventWriteError ? error.providerStatus : undefined);
  }
}

export async function deliverCaldavAlarmResource(intent: CaldavAlarmIntent, authorization: string, signal?: AbortSignal, beforeMutation?: () => Promise<void>) {
  if (!config.api.caldavAlarmEditsEnabled) throw new EventWriteError("event-write", "unsupported");
  const { context } = intent, ref = context.mapping.ref;
  if (intent.request.scope !== caldavAlarmScope(context.event)) throw new ProviderEventWriteError("provider-conflict");
  const after = writeCaldavAlarm(intent.before, context.event, ref, intent.request.alarms);
  if (after !== intent.after || !sameCaldavScopeContext(inspectCaldavAlarm(after, context.event, ref).state, intent.desiredState)) throw new ProviderEventWriteError("provider-conflict");
  const resource = caldavSeriesResourceURL(context.link.externalCalendarID, ref.externalEventId);
  const read = () => readEventResource(authorization, resource.href, ref, signal, "error", true);
  const evidence = (current: Awaited<ReturnType<typeof read>>) => inspectCaldavAlarm(current.data, context.event, { ...ref, etag: current.etag });
  const current = await read();
  if (sameCaldavResource(current.data, after)) return evidence(current);
  if (current.etag !== ref.etag || !sameCaldavResource(current.data, intent.before)) throw new ProviderEventWriteError("provider-conflict");
  await beforeMutation?.();
  signal?.throwIfAborted();
  let accepted = false;
  try {
    const response = await caldavFetch(resource.href, { signal, redirect: "error", method: "PUT", headers: { authorization, "Content-Type": "text/calendar; charset=utf-8", "If-Match": ref.etag }, body: after });
    assertProviderEventMutationResponse(response);
    accepted = true;
    const confirmed = await read();
    if (!sameCaldavResource(confirmed.data, after)) throw new ProviderEventWriteError("provider-conflict", "unconfirmed");
    return evidence(confirmed);
  } catch (error) {
    if (!accepted && error instanceof ProviderEventWriteError && error.providerStatus !== undefined) throw error;
    throw new ProviderEventWriteError("provider-write-failed", "unconfirmed", error instanceof ProviderEventWriteError ? error.providerStatus : undefined);
  }
}

/** Final adapter classification consumes only explicit component evidence. */
export function classifyCaldavCalendars(cals: DAVCalendar[]) {
  if (cals.some(calendar => !calendar.components?.length)) throw new Error("CalDAV component classification is unknown.");
  return cals
      .filter(
        (c) =>
          !c.components ||
          c.components.includes("VEVENT") ||
          c.components.includes("VTODO"),
      )
      .map((c) => ({
        externalId: c.url,
        name: typeof c.displayName === "string" ? c.displayName : "Calendar",
        color: (typeof c.calendarColor === "string"
          ? c.calendarColor
          : "#4285F4"
        ).slice(0, 7),
        supportsEvents: c.components?.includes("VEVENT") ?? true,
        supportsTasks: c.components?.includes("VTODO") ?? false,
      }));
}

export const caldavAdapter: CalendarAdapter = {
  caldavOrganizer: caldavOrganizerTransport(async (userID, accountID) => { const accounts = await getCaldavAccountsByUser(userID); if (!accounts.some(account => account.id === accountID)) throw new EventWriteError("organizer", "denied"); return basicAuthForAccount(accountID); }, async (userID, accountID, collection, resource) => {
    if (!config.api.caldavOrganizerEditsEnabled || !config.api.icloudOrganizerCreateEnabled) return false;
    await schedulingAuthorization(userID, accountID, collection);
    const account = (await getCaldavAccountsByUser(userID)).find(item => item.id === accountID);
    return !!account && isIcloudPersonalContentDestination(account.serverUrl, collection, resource);
  }),
  async readCaldavAlarm(context, signal) {
    if (!config.api.caldavAlarmEditsEnabled) throw new EventWriteError("event-write", "unsupported");
    const { resource, authorization } = await resourceAuthorization(context.link.userID, context.link.accountID, context.link.externalCalendarID, { master: context.event, ref: context.mapping.ref }, signal);
    const current = await readEventResource(authorization, resource.href, context.mapping.ref, signal, "error", true);
    return inspectCaldavAlarm(current.data, context.event, { ...context.mapping.ref, etag: current.etag });
  },
  async writeCaldavAlarm(intent, signal, beforeMutation) {
    if (!config.api.caldavAlarmEditsEnabled) throw new EventWriteError("event-write", "unsupported");
    const context = intent.context;
    const { authorization } = await resourceAuthorization(context.link.userID, context.link.accountID, context.link.externalCalendarID, { master: context.event, ref: context.mapping.ref }, signal);
    return deliverCaldavAlarmResource(intent, authorization, signal, beforeMutation);
  },
  provider: "caldav",
  async readCaldavSeriesDeletionResolution(userID, accountId, externalCalendarId, intent, before, signal) {
    const { resource, authorization } = await seriesAuthorization(userID, accountId, externalCalendarId, intent, signal, "delete");
    const current = await readEventResource(authorization, resource.href, intent.ref, signal, "error", true);
    return caldavSeriesResolutionEvidence(current.data, intent, { ...intent.ref, etag: current.etag }, before, null);
  },
  async readCaldavSeriesResolution(userID, accountId, externalCalendarId, intent, before, signal, targetEventID, operation) {
    const { resource, authorization } = await seriesAuthorization(userID, accountId, externalCalendarId, intent, signal, "update", targetEventID === undefined ? operation : undefined);
    const current = await readEventResource(authorization, resource.href, intent.ref, signal, "error", true);
    return caldavSeriesResolutionEvidence(current.data, intent, { ...intent.ref, etag: current.etag }, before, targetEventID);
  },
  async readCaldavRsvp(userID, accountID, calendar, ref, response, signal) {
    if (!ref.icalUid) throw new EventWriteError("event-write", "unsupported");
    return readCaldavRsvp(calendar, { id: ref.externalEventId, etag: requireEventEtag(ref.etag), uid: ref.icalUid }, await rsvpAuthorization(userID, accountID, calendar), response, signal, () => icloudRsvpEligibility(userID, accountID, calendar, ref.externalEventId));
  },
  async writeCaldavRsvp(userID, accountID, calendar, evidence, signal, beforeWrite, readOnly = false) {
    const authorization = await rsvpAuthorization(userID, accountID, calendar);
    return deliverCaldavRsvp(calendar, evidence, authorization, signal, async () => {
      if (await rsvpAuthorization(userID, accountID, calendar) !== authorization) throw new ProviderEventWriteError("provider-conflict");
      await beforeWrite?.();
    }, readOnly, () => icloudRsvpEligibility(userID, accountID, calendar, evidence.id));
  },
  async readCaldavSeries(userID, accountId, externalCalendarId, intent, signal, operation) {
    const { resource, authorization } = await seriesAuthorization(userID, accountId, externalCalendarId, intent, signal, "update", operation);
    const current = await readEventResource(authorization, resource.href, intent.ref, signal, "error");
    return caldavSeriesEvidence(current.data, intent);
  },
  async readCaldavSeriesForDelete(userID, accountId, externalCalendarId, intent, signal) {
    const { resource, authorization } = await seriesAuthorization(userID, accountId, externalCalendarId, intent, signal, "delete");
    const current = await readEventResource(authorization, resource.href, intent.ref, signal, "error");
    return caldavSeriesEvidence(current.data, intent);
  },
  async deleteCaldavSeries(userID, accountId, externalCalendarId, deletion, signal, beforeMutation) {
    const { authorization } = await seriesAuthorization(userID, accountId, externalCalendarId, deletion.baseline, signal, "delete");
    return deleteCaldavSeriesResource(externalCalendarId, deletion, authorization, signal, beforeMutation);
  },
  async readCaldavSplitFuture(userID, accountId, externalCalendarId, split, signal) {
    const rebuilt = rebuildCaldavSplit(split);
    const creation = await seriesAuthorization(userID, accountId, externalCalendarId, rebuilt.creation, signal, "create");
    return readCaldavSplitCreation(creation.resource, rebuilt.creation, creation.authorization, signal);
  },
  async assertCaldavSplitCreation(userID, accountId, externalCalendarId, split, signal) {
    if (!config.api.eventTimeEditsEnabled) throw new EventWriteError("event-write", "unsupported");
    const rebuilt = rebuildCaldavSplit(split);
    const creation = await seriesAuthorization(userID, accountId, externalCalendarId, rebuilt.creation, signal, "create");
    await readCaldavSplitCreation(creation.resource, rebuilt.creation, creation.authorization, signal);
  },
  async writeCaldavSplitSource(userID, accountId, externalCalendarId, split, signal, beforeMutation) {
    if (!config.api.eventTimeEditsEnabled) throw new EventWriteError("event-write", "unsupported");
    const rebuilt = rebuildCaldavSplit(split);
    const creation = await seriesAuthorization(userID, accountId, externalCalendarId, rebuilt.creation, signal, "create");
    const source = await seriesAuthorization(userID, accountId, externalCalendarId, rebuilt.source.baseline, signal);
    await readCaldavSplitCreation(creation.resource, rebuilt.creation, creation.authorization, signal);
    return deliverCaldavSeriesResource(externalCalendarId, rebuilt.source, source.authorization, signal, beforeMutation);
  },
  async createCaldavSeries(userID, accountId, externalCalendarId, split, signal, beforeMutation) {
    const { authorization } = await seriesAuthorization(userID, accountId, externalCalendarId, split.creation, signal, "create");
    return createCaldavSplitResource(externalCalendarId, split, authorization, signal, beforeMutation);
  },
  async writeCaldavSeries(userID, accountId, externalCalendarId, write, signal, beforeMutation) {
    const { authorization } = await seriesAuthorization(userID, accountId, externalCalendarId, write.baseline, signal, "update", write);
    return deliverCaldavSeriesResource(externalCalendarId, write, authorization, signal, beforeMutation);
  },
  projectEvent(event) { return icalToNormalized({ url: event.id, data: toIcal(event) })!; },

  async listAccounts(userID: string): Promise<{ id: string; label: string }[]> {
    const accounts = await getCaldavAccountsByUser(userID);
    return accounts.map((a) => ({ id: a.id, label: a.username }));
  },

  async listCalendars(
    _userID: string,
    accountId: string,
  ): Promise<CalendarDiscoveryResult> {
    const client = await clientForAccount(accountId);
    const cals = await client.fetchCalendars();
    const calendars = classifyCaldavCalendars(cals);
    const authorization = await basicAuthForAccount(accountId);
    for (const calendar of calendars) {
      const privileges = await caldavEventPrivileges(
        calendar.externalId,
        authorization,
      );
      Object.assign(calendar, {
        caldavAccess: caldavReadAccess(privileges),
        readOnly: !["create", "update", "delete"].some(
          (action) =>
            caldavAllows(
              privileges,
              action as "create" | "update" | "delete",
            ) === true,
        ),
      });
    }
    return { calendars, taskListsComplete: true };
  },

  async fetchChanges(
    _userID,
    accountId,
    externalCalendarId,
    cursor,
  ): Promise<FetchChangesResult> {
    const organizerEventIDs = new Set(await getOrganizerTimeEventIDs(_userID, accountId, externalCalendarId, "caldav"));
    const client = await clientForAccount(accountId);
    const cals = await client.fetchCalendars();
    const cal = cals.find((c) => c.url === externalCalendarId);
    if (!cal) {
      logger.warn("caldav.calendar.not_found", {
        accountId,
        externalCalendarId,
        availableCalendars: cals.length,
      });
      logger.debug("caldav.calendar.not_found.details", {
        accountId,
        externalCalendarId,
        availableExternalCalendarIds: cals.map((c) => c.url),
      });
      throw new Error("CalDAV collection disappeared after discovery; retry discovery before importing.");
    }

    if (cal.reports?.includes("syncCollection")) {
      try {
        return await incrementalChanges(client, cal, cursor, organizerEventIDs);
      } catch (error) {
        // An expired/unsupported token must never leave stale objects behind.
        // A complete query is the compatibility fallback and resets both kinds.
        logger.warn("caldav.sync_collection_fallback", {
          accountId,
          externalCalendarId,
          error,
        });
      }
    }

    // PROPFIND lists the complete collection without iCloud's calendar-query
    // time-range requirement, so reset reconciliation never sweeps valid old or
    // far-future resources merely because they fell outside a query window.
    const listed = await client.propfind({
      depth: "1",
      props: { "d:getetag": {} },
      url: cal.url,
    });
    const failed = listed.find((response) => {
      if (!response.href || response.ok || response.status === 404)
        return false;
      try {
        return new URL(response.href, cal.url).pathname
          .toLowerCase()
          .endsWith(".ics");
      } catch {
        return false;
      }
    });
    if (failed)
      throw new Error(
        `CalDAV collection listing failed: ${failed.status} ${failed.statusText}`,
      );
    const objectUrls = listed.flatMap((response) => {
      if (!response.ok || !response.href) return [];
      const url = absoluteDavUrl(response.href, cal.url);
      return isIcalUrl(url) ? [url] : [];
    });
    const objects = objectUrls.length
      ? await client.fetchCalendarObjects({ calendar: cal, objectUrls })
      : [];
    assertCompleteObjects(objectUrls, objects);
    const changes = normalizedObjectChanges(objects, organizerEventIDs);
    logger.debug("caldav.objects.fetched", {
      accountId,
      externalCalendarId,
      objects: objects.length,
      parsedEvents: changes.filter((change) => change.kind === "event").length,
      parsedTasks: changes.filter((change) => change.kind === "task").length,
    });

    return { changes, nextCursor: cal.syncToken ?? null, reset: true };
  },

  async assertEventWrite(_userID, accountId, externalCalendarId, operation) {
    const authorization = await basicAuthForAccount(accountId);
    // DAV bind/unbind belong to the collection; write-content to the resource.
    const target =
      operation.action === "update" && operation.external
        ? operation.external.externalEventId
        : externalCalendarId;
    const privileges = await caldavEventPrivileges(target, authorization, operation.signal);
    assertEventWriteEvidence(
      caldavAllows(privileges, operation.action),
      "event-write",
    );
    if (operation.action !== "create" && operation.external) {
      {
        const { data, uid, master } = await readEventResource(
          authorization,
          operation.external.externalEventId,
          operation.external,
          operation.signal,
        );
        // Exercise the exact preserving path before any DB or provider mutation.
        if (operation.action === "update")
          patchEventIcal(data, operation.event, uid, operation.patch);
        if (
          operation.action === "update" &&
          (operation.patch?.recurrence !== undefined ||
            operation.patch?.isAllDay !== undefined) &&
          !operation.scopeEditValidated &&
          canonicalRecurrence(recurrenceFrom(master)) !==
            canonicalRecurrence(
              recurrenceFrom(
                toVevent(
                  { ...operation.event, ...requireEventPatch(operation.patch) },
                  uid,
                ),
              ),
            )
        ) {
          // A legacy recurrence PUT may be the first half of a split. Without a
          // complete intent, require the potential create right before changing it.
          const collectionPrivileges = await caldavEventPrivileges(
            externalCalendarId,
            authorization,
            operation.signal,
          );
          const canCreate = caldavAllows(collectionPrivileges, "create");
          if (canCreate !== true)
            throw new EventWriteError(
              "recurrence",
              canCreate === false ? "denied" : "unknown",
              "CalDAV recurrence changes without a complete scope edit intent require calendar create permission. No changes were saved.",
            );
        }
        const organizer = componentString(master, "organizer");
        if (organizer) {
          const addresses = await caldavOrganizerAddresses(
            externalCalendarId,
            authorization,
            operation.signal,
          );
          const self = addresses?.includes(
            organizer.replace(/^mailto:/i, "").toLowerCase(),
          );
          if (self && master.getAllProperties("attendee").length)
            throw new EventWriteError("organizer", "unsupported", "Organizer meetings require the explicit server notification action. No changes were saved.");
          // Nonmatch on a shared calendar does NOT prove an attendee copy: its
          // organizer may be the collection owner rather than this principal.
          assertEventWriteEvidence(
            operation.action === "delete" && self === false ? undefined : self,
            "organizer",
          );
        }
      }
    }
  },

  async readEvent(_userID, accountId, _externalCalendarId, ref, signal) {
    const response = await caldavFetch(ref.externalEventId, {
      headers: { authorization: await basicAuthForAccount(accountId), accept: "text/calendar", "Cache-Control": "no-cache" }, signal,
    });
    if (response.status === 404) return null;
    assertCompleteEventReadResponse(response);
    const data = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await response.arrayBuffer());
    const selected = eventMaster(data, ref.icalUid);
    replaceEventProperties(data, selected.index, new Map());
    if (componentString(selected.master, "status")?.toUpperCase() === "CANCELLED")
      throw new ProviderEventWriteError("provider-conflict");
    const fields = veventToFields(selected.master);
    if (!fields) throw new ProviderEventWriteError("provider-write-failed");
    const etag = strongEventEtag(response.headers.get("etag"));
    const event = assertCreatedEventEvidence({ ...fields, externalId: ref.externalEventId, etag, icalUid: selected.uid, url: null, status: "active" });
    return { ref: { externalEventId: ref.externalEventId, etag, icalUid: selected.uid }, event };
  },

  async findCreatedEvent(_userID, accountId, externalCalendarId, identity) {
    const { url, uid } = caldavEventCreateIdentity(
      externalCalendarId,
      identity,
    );
    const response = await caldavFetch(url, {
        signal: identity.signal,
      headers: {
        authorization: await basicAuthForAccount(accountId),
        accept: "text/calendar",
        "Cache-Control": "no-cache",
      },
    });
    if (response.status === 404) return null;
    assertCompleteEventReadResponse(response);
    const data = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(await response.arrayBuffer());
    const selected = eventMaster(data, uid);
    replaceEventProperties(data, selected.index, new Map());
    const fields = veventToFields(selected.master);
    if (!fields) throw new ProviderEventWriteError("provider-write-failed");
    const etag = strongEventEtag(response.headers.get("etag"));
    const event = assertCreatedEventEvidence({
      ...fields,
      externalId: url,
      etag,
      icalUid: uid,
      url: null,
      status:
        componentString(selected.master, "status")?.toUpperCase() ===
        "CANCELLED"
          ? "cancelled"
          : "active",
    });
    return { ref: { externalEventId: url, etag, icalUid: uid }, event };
  },

  async pushCreate(
    _userID,
    accountId,
    externalCalendarId,
    event: Event,
    identity,
  ) {
    if (identity) {
      const { url, uid } = caldavEventCreateIdentity(
        externalCalendarId,
        identity,
      );
      const response = await caldavFetch(url, {
        signal: identity.signal,
        method: "PUT",
        headers: {
          authorization: await basicAuthForAccount(accountId),
          "Content-Type": "text/calendar; charset=utf-8",
          "If-None-Match": "*",
        },
        body: toIcal(event, uid),
      });
      assertProviderEventMutationResponse(response);
      return {
        externalEventId: url,
        etag: strongEventEtag(response.headers.get("etag")),
        icalUid: uid,
      };
    }
    const client = await clientForAccount(accountId);
    const filename = `${event.id}.ics`;
    const res = await client.createCalendarObject({
      calendar: { url: externalCalendarId } as any,
      filename,
      iCalString: toIcal(event),
    });
    assertProviderEventMutationResponse(res);
    const base = externalCalendarId.endsWith("/")
      ? externalCalendarId
      : `${externalCalendarId}/`;
    const externalEventId = `${base}${filename}`;
    return {
      externalEventId,
      // RFC 4791 §5.3.4: transformed PUT cannot return a strong ETag. A
      // follow-up GET may include unseen edits; sync must accept its content.
      etag: strongEventEtag(res.headers.get("etag")),
      icalUid: event.id,
    };
  },

  async pushUpdate(
    _userID,
    accountId,
    _externalCalendarId,
    externalEventId,
    event: Event,
    ref,
    patch,
    signal,
  ) {
    requireEventPatch(patch);
    requireEventEtag(ref?.etag);
    const authorization = await basicAuthForAccount(accountId);
    const current = await readEventResource(
      authorization,
      externalEventId,
      ref,
      signal,
    );
    const data = patchEventIcal(current.data, event, current.uid, patch);
    if (data === current.data) return; // Known no-op; retain accepted validator.
    const res = await caldavFetch(externalEventId, {
      signal,
      method: "PUT",
      headers: {
        authorization,
        "Content-Type": "text/calendar; charset=utf-8",
        "If-Match": current.etag,
      },
      body: data,
    });
    assertProviderEventMutationResponse(res);
    return {
      etag: strongEventEtag(res.headers.get("etag")),
      icalUid: current.uid,
    };
  },

  async pushDelete(
    _userID,
    accountId,
    _externalCalendarId,
    externalEventId,
    ref,
    signal,
  ) {
    const etag = requireEventEtag(ref?.etag);
    const authorization = await basicAuthForAccount(accountId);
    const res = await caldavFetch(externalEventId, {
      signal,
      method: "DELETE",
      headers: { authorization, "If-Match": etag },
    });
    if (res.status !== 404) assertProviderEventMutationResponse(res);
  },

  projectTask: projectCaldavTask,

  async readTask(_userID, accountId, externalCalendarId, ref) {
    const address = caldavSeriesResourceURL(externalCalendarId, ref.externalTaskId);
    const response = await caldavFetch(address.href, { headers: { authorization: await basicAuthForAccount(accountId), "Cache-Control": "no-cache" }, redirect: "error" });
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new ProviderTaskWriteError("task-write-failed", "not-written", response.status);
    const parsed = icalToNormalizedTask({ url: address.href, etag: response.headers.get("etag") ?? undefined, data: await response.text() });
    if (!parsed?.icalUid || ref.icalUid && parsed.icalUid !== ref.icalUid) throw new ProviderTaskWriteError("task-projection-unavailable");
    return { ref: { externalTaskId: address.href, etag: requireTaskEtag(parsed.etag), icalUid: parsed.icalUid }, projection: canonicalTaskProjection(parsed) };
  },

  async assertTaskWrite(userID, accountId, externalCalendarId, operation) {
    if (!(await getCaldavAccountsByUser(userID)).some(account => account.id === accountId)) throw new ProviderTaskWriteError("task-source-read-only");
    const authorization = await basicAuthForAccount(accountId);
    const target = operation.action === "update" && operation.external ? caldavSeriesResourceURL(externalCalendarId, operation.external.externalTaskId).href : externalCalendarId;
    const permission = await caldavEventWritePermission(target, authorization, operation.signal, "error");
    if (caldavAllows(permission.privileges, operation.action) !== true || caldavReadAccess(permission.privileges).read !== true) throw new ProviderTaskWriteError("task-source-read-only");
    if (operation.action !== "create") {
      if (!operation.external) throw new ProviderTaskWriteError("task-version-unavailable");
      const current = await caldavAdapter.readTask!(userID, accountId, externalCalendarId, operation.external);
      if (!current && operation.action === "delete") return;
      if (!current) throw new ProviderTaskWriteError("task-provider-conflict");
      assertTaskEtag(operation.external.etag, current.ref.etag);
    }
  },

  async pushTaskCreate(_userID, accountId, externalCalendarId, task: Task, beforeMutation) {
    const client = await clientForAccount(accountId);
    const authorization = await basicAuthForAccount(accountId);
    const filename = `${task.id}.ics`;
    const base = externalCalendarId.endsWith("/")
      ? externalCalendarId
      : `${externalCalendarId}/`;
    const externalTaskId = `${base}${filename}`;
    const body = toTaskIcal(task);
    await beforeMutation?.();
    const res = await caldavFetch(externalTaskId, { method: "PUT", headers: { authorization, "Content-Type": "text/calendar; charset=utf-8", "If-None-Match": "*" }, body, redirect: "error" });
    assertTaskMutationResponse(res);
    return {
      externalTaskId,
      etag: await etagAfterWrite(
        client,
        externalCalendarId,
        externalTaskId,
        res,
      ),
      icalUid: task.id,
    };
  },

  async pushTaskUpdate(
    _userID,
    accountId,
    externalCalendarId,
    externalTaskId,
    task: Task,
    ref,
    patch,
  ) {
    const client = await clientForAccount(accountId);
    const { calendarObject, uid: icalUid } = await taskCalendarObjectForUpdate(
      client,
      externalCalendarId,
      externalTaskId,
      ref,
      task,
      patch,
    );
    await ref?.beforeMutation?.();
    const res = await client.updateCalendarObject({ calendarObject });
    assertTaskMutationResponse(res);
    return {
      etag: await etagAfterWrite(
        client,
        externalCalendarId,
        externalTaskId,
        res,
      ),
      icalUid,
    };
  },

  async pushTaskDelete(
    _userID,
    accountId,
    _externalCalendarId,
    externalTaskId,
    ref,
  ) {
    if (!ref?.etag)
      throw new Error("CalDAV task has no ETag; refusing an unsafe delete");
    const client = await clientForAccount(accountId);
    await ref.beforeMutation?.();
    const res = await client.deleteCalendarObject({
      calendarObject: { url: externalTaskId, etag: ref.etag },
    });
    if (res.status !== 404 && res.status !== 410) assertTaskMutationResponse(res);
  },

  async createCalendar(_userID, accountId, { name, color }) {
    // Calendar home = parent of an existing calendar's URL (every provisioned
    // account has at least one; discovery re-derives partition hosts on iCloud).
    const client = await clientForAccount(accountId);
    const cals = await client.fetchCalendars();
    if (cals.length === 0)
      throw new Error("CalDAV: no calendar home found on this account");
    const home = new URL("..", cals[0].url).href;
    const url = `${home}${randomUUID()}/`;

    const res = await caldavFetch(url, {
      method: "MKCALENDAR",
      headers: {
        Authorization: await basicAuthForAccount(accountId),
        "Content-Type": "application/xml; charset=utf-8",
      },
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

  async updateCalendar(
    _userID,
    accountId,
    externalCalendarId,
    { name, color },
  ) {
    const res = await caldavFetch(externalCalendarId, {
      method: "PROPPATCH",
      headers: {
        Authorization: await basicAuthForAccount(accountId),
        "Content-Type": "application/xml; charset=utf-8",
      },
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
    if (!res.ok && res.status !== 207)
      throw new Error(`CalDAV ${res.status} ${res.statusText}`);
  },

  async deleteCalendar(_userID, accountId, externalCalendarId) {
    const res = await caldavFetch(externalCalendarId, {
      method: "DELETE",
      headers: { Authorization: await basicAuthForAccount(accountId) },
    });
    if (!res.ok && res.status !== 404)
      throw new Error(`CalDAV ${res.status} ${res.statusText}`);
  },
};
