import ICAL from "ical.js";
import { CivilDateTimeSchema, OccurrenceStartSchema } from "@musubi/types";
import type { NativeWritePlanV1, SyncCodecAction } from "./index";
const record = (value: unknown): value is Record<string, unknown> => value != null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value: unknown, fields: string[], required = fields): value is Record<string, unknown> =>
  record(value) && Object.keys(value).every(key => fields.includes(key)) && required.every(key => Object.prototype.hasOwnProperty.call(value, key));
const text = (value: unknown) => typeof value === "string";
const nullableText = (value: unknown) => value === null || text(value);
const uuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const instant = (value: unknown) => OccurrenceStartSchema.safeParse({ kind: "instant", value }).success;
const date = (value: unknown) => OccurrenceStartSchema.safeParse({ kind: "date", value }).success;
function graphEndpoint(value: unknown, allowZ = false) {
  return exact(value, ["dateTime", "timeZone"]) && value.timeZone === "UTC" &&
    (CivilDateTimeSchema.safeParse(value.dateTime).success || allowZ && instant(value.dateTime));
}
function googleEndpoint(value: unknown) {
  return exact(value, ["date"]) && date(value.date) || exact(value, ["dateTime"]) && instant(value.dateTime);
}
function recurrence(value: unknown) {
  if (value === null) return true;
  if (!Array.isArray(value) || !value.length || value.length > 1000) return false;
  return value.every(line => {
    if (typeof line !== "string" || line.length > 8192 || !/^(RRULE:|(?:EXDATE|RDATE)(?:;VALUE=DATE)?:)/.test(line)) return false;
    const property = ICAL.Property.fromString(line);
    return ["rrule", "exdate", "rdate"].includes(property.name);
  });
}
function bodyFor(provider: string, kind: "event" | "task", action: SyncCodecAction, value: unknown) {
  if (action === "delete") return value === null;
  if (!record(value)) return false;
  let rules: Record<string, (value: unknown) => boolean>;
  let required: string[];
  if (kind === "event" && provider === "google") {
    rules = { summary: text, description: nullableText, location: nullableText, recurrence,
      start: googleEndpoint, end: googleEndpoint };
    required = ["summary", "recurrence", "start", "end"];
    if (action === "create") {
      rules.id = value => typeof value === "string" && /^musubi[0-9a-f]{32}$/.test(value);
      rules.extendedProperties = value => exact(value, ["private"]) && exact(value.private, ["musubiOperationID"]) && uuid(value.private.musubiOperationID);
      required.push("id", "extendedProperties");
      if (typeof value.id !== "string" || !record(value.extendedProperties) || !record(value.extendedProperties.private) ||
        value.id !== "musubi" + String(value.extendedProperties.private.musubiOperationID).replace(/-/g, "")) return false;
    }
  } else if (kind === "event" && provider === "microsoft") {
    rules = { subject: text,
      body: value => exact(value, ["contentType", "content"]) && value.contentType === "text" && text(value.content),
      location: value => exact(value, ["displayName"]) && text(value.displayName) };
    required = ["subject", "body", "location"];
    if (action === "create") {
      rules.isAllDay = value => typeof value === "boolean";
      rules.start = value => graphEndpoint(value, true);
      rules.end = value => graphEndpoint(value, true);
      rules.transactionId = uuid;
      required.push("isAllDay", "start", "end", "transactionId");
    }
  } else if (kind === "task" && provider === "google") {
    rules = { title: text, notes: nullableText, status: value => typeof value === "string" && ["completed", "needsAction"].includes(value),
      due: value => value === null || typeof value === "string" && instant(value) && value.endsWith("T00:00:00.000Z") };
    required = Object.keys(rules);
  } else if (kind === "task" && provider === "microsoft") {
    rules = { title: text,
      body: value => exact(value, ["content", "contentType"]) && value.contentType === "text" && text(value.content),
      dueDateTime: value => value === null || graphEndpoint(value),
      startDateTime: value => value === null || graphEndpoint(value),
      importance: value => typeof value === "string" && ["normal", "high", "low"].includes(value),
      status: value => typeof value === "string" && ["completed", "inProgress", "notStarted"].includes(value) };
    required = Object.keys(rules);
  } else return false;
  if (!exact(value, Object.keys(rules), action === "create" ? required : []) ||
    !Object.entries(value).every(([key, item]) => rules[key](item))) return false;
  if (kind === "event" && record(value.start) && record(value.end)) {
    if (provider === "google") {
      const dateMode = Object.prototype.hasOwnProperty.call(value.start,"date");
      if (dateMode !== Object.prototype.hasOwnProperty.call(value.end,"date")) return false;
      const start = dateMode ? value.start.date : value.start.dateTime;
      const end = dateMode ? value.end.date : value.end.dateTime;
      if (typeof start !== "string" || typeof end !== "string" || (dateMode ? start >= end : new Date(start).getTime() > new Date(end).getTime())) return false;
    } else if (provider === "microsoft" && action === "create") {
      const start=String(value.start.dateTime), end=String(value.end.dateTime);
      if (value.isAllDay && (!start.endsWith("T00:00:00") || !end.endsWith("T00:00:00") || start >= end)) return false;
      const toInstant=(input:string)=>new Date(input.endsWith("Z")?input:input+"Z").getTime();
      if (toInstant(start)>toInstant(end)) return false;
    }
  }
  return true;
}
const eventProperties = ["summary", "description", "location", "dtstart", "dtend", "duration", "rrule", "rdate", "exdate"];
const taskProperties = ["summary", "description", "status", "dtstart", "due", "completed", "percent-complete", "priority", "sequence", "related-to", "url", "rrule", "rdate", "exdate"];
function caldav(kind: "event" | "task", data: Record<string, unknown>) {
  if (!exact(data, ["planKind", "component", "uid", "createResource", "replacementComponent", "properties"]) ||
    data.planKind !== "caldav-properties" || data.component !== (kind === "event" ? "VEVENT" : "VTODO") ||
    typeof data.uid !== "string" || !data.uid || /[\r\n]/.test(data.uid) ||
    typeof data.createResource !== "string" || typeof data.replacementComponent !== "string" ||
    !Array.isArray(data.properties) || new Set(data.properties).size !== data.properties.length) return false;
  const allowed = kind === "event" ? eventProperties : taskProperties;
  if (data.properties.some(name => typeof name !== "string" || !allowed.includes(name))) return false;
  const component = new ICAL.Component(ICAL.parse(data.replacementComponent));
  const calendar = new ICAL.Component(ICAL.parse(data.createResource));
  const name = kind === "event" ? "vevent" : "vtodo";
  if (component.name !== name || component.getAllSubcomponents().length || component.getAllProperties("uid").length !== 1 ||
    component.getFirstPropertyValue("uid") !== data.uid ||
    component.getAllProperties().some(property => !["uid", ...allowed, ...(kind === "task" ? ["dtstamp"] : [])].includes(property.name))) return false;
  const children = calendar.getAllSubcomponents();
  if (calendar.name !== "vcalendar" || children.length !== 1 || children[0].name !== name ||
    calendar.getAllProperties().some(property => !["version", "prodid"].includes(property.name)) ||
    calendar.getFirstPropertyValue("version") !== "2.0" ||
    JSON.stringify(children[0].toJSON()) !== JSON.stringify(component.toJSON())) return false;
  for (const name of ["uid","summary","description","location","dtstart","dtend","status","due","completed","percent-complete","priority","sequence","related-to","url","dtstamp","rrule"])
    if (component.getAllProperties(name).length > 1) return false;
  const time = (name:string) => component.getFirstPropertyValue(name) as ICAL.Time | null;
  for (const name of ["dtstart","dtend","due","completed","dtstamp"]) {
    const value=time(name);
    if (!value) continue;
    if (!(value instanceof ICAL.Time) || !value.isDate && value.zone.tzid !== "UTC") return false;
    const compact=value.toICALString();
    const iso=compact.slice(0,4)+"-"+compact.slice(4,6)+"-"+compact.slice(6,8);
    if (value.isDate ? !date(iso) : !instant(iso+"T"+compact.slice(9,11)+":"+compact.slice(11,13)+":"+compact.slice(13,15)+"Z")) return false;
    if (["completed","dtstamp"].includes(name) && value.isDate) return false;
  }
  if (kind === "event") {
    const start=time("dtstart"),end=time("dtend");
    if (!start || !end || component.hasProperty("duration") || start.isDate !== end.isDate ||
      (start.isDate ? start.compare(end)>=0 : start.compare(end)>0)) return false;
  } else {
    for (const [name,min,max] of [["percent-complete",0,100],["priority",0,9],["sequence",0,Number.MAX_SAFE_INTEGER]] as const) {
      const value=component.getFirstPropertyValue(name);
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value<min || value>max) return false;
    }
    if (!["NEEDS-ACTION","IN-PROCESS","COMPLETED","CANCELLED"].includes(String(component.getFirstPropertyValue("status")))) return false;
    if (time("dtstart") && time("due") && time("dtstart")!.isDate !== time("due")!.isDate) return false;
  }
  return true;
}
/** Pinned semantic decoder only; never invokes a current Event/Task projector. */
export function parseNativeWritePlanV1(serializer: { id: string; version: number }, action: SyncCodecAction,
  kind: "event" | "task", data: unknown): NativeWritePlanV1 | undefined {
  try {
    if (serializer.version !== 1 || !["create", "update", "delete"].includes(action) || !["event", "task"].includes(kind) || !record(data)) return undefined;
    const ids: Record<string,string> = kind === "event"
      ? { "google-personal-event": "google", "microsoft-personal-event": "microsoft", "caldav-personal-event": "caldav" }
      : { "google-task": "google", "microsoft-task": "microsoft", "caldav-task": "caldav" };
    const provider = Object.prototype.hasOwnProperty.call(ids,serializer.id) ? ids[serializer.id] : undefined;
    if (!provider) return undefined;
    if (provider === "caldav") return caldav(kind, data) ? data as NativeWritePlanV1 : undefined;
    return exact(data, ["planKind", "body"]) && data.planKind === "json-body" && bodyFor(provider, kind, action, data.body)
      ? data as NativeWritePlanV1 : undefined;
  } catch { return undefined; }
}
