import ICAL from "ical.js";
import { EventSchema, TaskSchema, type Event, type Task } from "@musubi/types";
import { allDayTime, addRecurrence, recurrenceFrom } from "./recurrence";
import { replaceComponentPropertiesV1 } from "./caldav_resource";
import { parseNativeWritePlanV1 } from "./native_plan";

export type SyncCodecProvider = "google" | "microsoft" | "caldav";
export type SyncCodecAction = "create" | "update" | "delete";
export type SyncCodecContextV1 = { action: SyncCodecAction; operationId: string; uid?: string; acceptedAt: string };
export type SyncCodecJsonValue = string | number | boolean | null | SyncCodecJsonValue[] | { [key: string]: SyncCodecJsonValue };
export type SyncCodecJsonObject = { [key: string]: SyncCodecJsonValue };
export type EventPatchV1 = Partial<Pick<Event, "title" | "description" | "location" | "start" | "end" | "isAllDay" | "recurrence" | "color" | "url">>;
export type JsonBodyPlanV1 = { planKind: "json-body"; body: SyncCodecJsonObject | null };
export type CaldavPropertyPlanV1 = {
  planKind: "caldav-properties"; component: "VEVENT" | "VTODO"; uid: string;
  createResource: string; replacementComponent: string; properties: string[];
};
export type NativeWritePlanV1 = JsonBodyPlanV1 | CaldavPropertyPlanV1;
export type NativePlanV1 = { kind: "codec-data"; data: NativeWritePlanV1 };
export { parseNativeWritePlanV1 } from "./native_plan";
export { matchesPinnedProjectionV1 } from "./projection";
export type EncodedSyncWriteV1 = {
  serializer: { id: string; version: 1 };
  admittedProjection: { data: SyncCodecJsonObject };
  nativePlan: { kind: "codec-data"; data: JsonBodyPlanV1 | CaldavPropertyPlanV1 };
};
export class SyncCodecError extends Error {
  constructor(readonly code: "unsupported-profile" | "invalid-input" | "invalid-resource" | "invalid-native-plan") {
    super("Sync codec v1: " + code);
    this.name = "SyncCodecError";
  }
}
const refuse = (code: SyncCodecError["code"] = "unsupported-profile"): never => { throw new SyncCodecError(code); };
const DAY = 86_400_000;
const EVENT_FIELDS = ["title", "description", "location", "start", "end", "isAllDay", "recurrence", "color", "url"];
const TASK_FIELDS: Record<string, string[]> = {
  title: ["summary"], description: ["description"], status: ["status"], start: ["dtstart"],
  due: ["due"], isAllDay: ["dtstart", "due"], completedAt: ["completed"],
  percentComplete: ["percent-complete"], priority: ["priority"], sequence: ["sequence"],
  relatedTo: ["related-to"], url: ["url"], recurrence: ["rrule", "rdate", "exdate"],
};
function json<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function finite(date: Date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime()) || !/^\d{4}-/.test(date.toISOString())) refuse("invalid-input");
  return date;
}
function iso(date: Date) { return finite(date).toISOString(); }
function secondIso(date: Date) { return iso(date).replace(/\.\d{3}Z$/, ".000Z"); }
function dateOnly(date: Date) { return iso(date).slice(0, 10); }
function exclusiveEnd(date: Date) {
  const value = new Date(finite(date).getTime() + DAY);
  finite(value);
  return value;
}
function operationId(context: SyncCodecContextV1) {
  if (!["create", "update", "delete"].includes(context.action) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(context.operationId) ||
    typeof context.acceptedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(context.acceptedAt) ||
    !Number.isFinite(new Date(context.acceptedAt).getTime()) || new Date(context.acceptedAt).toISOString().slice(0,19) !== context.acceptedAt.slice(0,19)) refuse("invalid-input");
  if (context.uid != null && (!context.uid || /[\r\n]/.test(context.uid))) refuse("invalid-input");
  return context.operationId.toLowerCase();
}
function provider(value: SyncCodecProvider) {
  if (!["google", "microsoft", "caldav"].includes(value)) refuse();
  return value;
}
function eventInput(value: Event, action: SyncCodecAction) {
  const event = EventSchema.parse(value);
  finite(event.start); finite(event.end);
  if (event.start > event.end) refuse("invalid-input");
  if (event.hasAttendees || event.isMeeting || (event.isCanceled && action !== "delete") || event.seriesID || event.originalStart) refuse();
  if (event.timeModel && !["legacy-unknown", "all-day"].includes(event.timeModel.kind)) refuse();
  if (event.timeModel?.kind === "all-day" && !event.isAllDay) refuse("invalid-input");
  if (event.isAllDay && ![event.start, event.end].every(date => iso(date).endsWith("T00:00:00.000Z"))) refuse("invalid-input");
  return event;
}
function eventPatch(patch: EventPatchV1 | undefined, context: SyncCodecContextV1) {
  if (context.action === "update" && (patch == null || typeof patch !== "object" || Array.isArray(patch))) refuse("invalid-input");
  const value = patch ?? {};
  if (Object.keys(value).some(key => !EVENT_FIELDS.includes(key))) refuse();
  return value;
}
function eventComponent(event: Event, uid: string) {
  const component = new ICAL.Component("vevent");
  const value = new ICAL.Event(component);
  value.uid = uid;
  value.summary = event.title;
  if (event.description) value.description = event.description;
  if (event.location) value.location = event.location;
  value.startDate = event.isAllDay ? allDayTime(event.start) : ICAL.Time.fromJSDate(event.start, true);
  value.endDate = event.isAllDay ? allDayTime(exclusiveEnd(event.end)) : ICAL.Time.fromJSDate(event.end, true);
  addRecurrence(component, event.recurrence, event.isAllDay);
  return component;
}
function taskComponent(task: Task, uid: string) {
  const value = new ICAL.Component("vtodo");
  value.addPropertyWithValue("uid", uid);
  value.addPropertyWithValue("summary", task.title);
  value.addPropertyWithValue("status", task.status.toUpperCase());
  if (task.description) value.addPropertyWithValue("description", task.description);
  for (const [field, property] of [["start", "dtstart"], ["due", "due"]] as const) {
    if (task[field]) value.addPropertyWithValue(property, task.isAllDay ? allDayTime(task[field]) : ICAL.Time.fromJSDate(task[field], true));
  }
  if (task.completedAt) value.addPropertyWithValue("completed", ICAL.Time.fromJSDate(task.completedAt, true));
  value.addPropertyWithValue("percent-complete", task.percentComplete);
  value.addPropertyWithValue("priority", task.priority);
  value.addPropertyWithValue("sequence", task.sequence);
  if (task.relatedTo) value.addPropertyWithValue("related-to", task.relatedTo);
  if (task.url) value.addPropertyWithValue("url", task.url);
  addRecurrence(value, task.recurrence, task.isAllDay);
  return value;
}
function resource(component: ICAL.Component) {
  const calendar = new ICAL.Component("vcalendar");
  calendar.updatePropertyWithValue("version", "2.0");
  calendar.updatePropertyWithValue("prodid", "-//Musubi//EN");
  calendar.addSubcomponent(component);
  return calendar.toString();
}
function googleRecurrence(value: string, allDay: boolean) {
  // This bounded profile validates dates with the existing DAV serializer first.
  return value.split("\n").filter(Boolean).map(raw => {
    let line = /^(RRULE|EXDATE|RDATE|EXRULE)/.test(raw) ? raw : "RRULE:" + raw;
    if (!allDay) return line;
    if (/^EXDATE:/.test(line)) return "EXDATE;VALUE=DATE:" + line.slice(7).split(",").map(date => date.slice(0, 8)).join(",");
    return line.replace(/UNTIL=(\d{8})T\d{6}Z?/, "UNTIL=$1");
  });
}
function googleEventBody(event: Event): SyncCodecJsonObject {
  return json({
    summary: event.title, description: event.description, location: event.location,
    recurrence: event.recurrence ? googleRecurrence(event.recurrence, event.isAllDay) : null,
    start: event.isAllDay ? { date: dateOnly(event.start) } : { dateTime: iso(event.start) },
    end: event.isAllDay ? { date: dateOnly(exclusiveEnd(event.end)) } : { dateTime: iso(event.end) },
  }) as unknown as SyncCodecJsonObject;
}
function graphEventBody(event: Event): SyncCodecJsonObject {
  if (event.recurrence) refuse();
  return {
    subject: event.title, body: { contentType: "text", content: event.description ?? "" },
    location: { displayName: event.location ?? "" }, isAllDay: event.isAllDay,
    start: { dateTime: event.isAllDay ? dateOnly(event.start) + "T00:00:00" : iso(event.start), timeZone: "UTC" },
    end: { dateTime: event.isAllDay ? dateOnly(exclusiveEnd(event.end)) + "T00:00:00" : iso(event.end), timeZone: "UTC" },
  };
}
function normalizedEvent(provider: SyncCodecProvider, event: Event, component: ICAL.Component): SyncCodecJsonObject {
  let recurrence: string | null = event.recurrence ?? null;
  if (provider === "google" && recurrence) {
    recurrence = googleRecurrence(recurrence, event.isAllDay).map(line => {
      if (/^(RRULE:)?FREQ=/.test(line) && /FREQ=YEARLY/.test(line) && /BYMONTHDAY=/.test(line) && !/BYMONTH=/.test(line))
        return line + ";BYMONTH=" + (event.start.getUTCMonth() + 1);
      return line;
    }).join("\n");
  }
  if (provider === "caldav") recurrence = recurrenceFrom(component);
  return {
    title: event.title,
    start: provider === "caldav" ? secondIso(event.start) : iso(event.start),
    end: provider === "caldav" ? secondIso(event.end) : iso(event.end),
    isAllDay: event.isAllDay,
    description: provider === "microsoft" ? event.description?.trim() || null : provider === "caldav" ? event.description || null : event.description ?? null,
    location: provider === "microsoft" ? event.location?.trim() || null : provider === "caldav" ? event.location || null : event.location ?? null,
    recurrence: provider === "microsoft" ? null : recurrence,
  };
}
function eventProperties(patch: EventPatchV1) {
  const properties = new Set<string>();
  for (const [field, name] of [["title", "summary"], ["description", "description"], ["location", "location"], ["start", "dtstart"], ["end", "dtend"]] as const)
    if (patch[field] !== undefined) properties.add(name);
  if (patch.isAllDay !== undefined) { properties.add("dtstart"); properties.add("dtend"); }
  if (patch.recurrence !== undefined || patch.isAllDay !== undefined) for (const name of ["rrule", "exdate", "rdate"]) properties.add(name);
  return [...properties];
}
export function encodeEventV1(providerValue: SyncCodecProvider, input: Event, patch: EventPatchV1 | undefined, context: SyncCodecContextV1): EncodedSyncWriteV1 {
  const targetProvider = provider(providerValue), id = operationId(context), diff = eventPatch(patch, context);
  const event = eventInput({ ...input, ...diff }, context.action);
  if (event.recurrence && event.recurrence.split("\n").filter(Boolean).some(line => !/^(?:RRULE:)?FREQ=|^(?:EXDATE|RDATE)(?:;VALUE=DATE)?:/.test(line))) refuse();
  const uid = context.uid ?? (context.action === "create" ? "musubi-" + id : event.id);
  const replacement = eventComponent(event, uid); // Validates supported recurrence dates before any plan exists.
  let plan: JsonBodyPlanV1 | CaldavPropertyPlanV1;
  if (targetProvider === "caldav") {
    plan = { planKind: "caldav-properties", component: "VEVENT", uid,
      replacementComponent: replacement.toString(), createResource: resource(replacement),
      properties: context.action === "update" ? eventProperties(diff) : [] };
  } else {
    const full = targetProvider === "google" ? googleEventBody(event) : graphEventBody(event);
    let body: SyncCodecJsonObject | null = context.action === "delete" ? null : full;
    if (context.action === "create") {
      if (targetProvider === "google") body = { ...full, id: "musubi" + id.replace(/-/g, ""), extendedProperties: { private: { musubiOperationID: id } } };
      else body = { ...full, transactionId: id };
    }
    if (context.action === "update") {
      body = {};
      if (targetProvider === "microsoft" && Object.keys(diff).some(key => !["title", "description", "location", "color"].includes(key))) refuse();
      for (const [field, property] of targetProvider === "google"
        ? [["title", "summary"], ["description", "description"], ["location", "location"], ["recurrence", "recurrence"], ["start", "start"], ["end", "end"]]
        : [["title", "subject"], ["description", "body"], ["location", "location"]]) {
        if (diff[field as keyof EventPatchV1] !== undefined) body[property] = full[property];
      }
      if (targetProvider === "google" && diff.isAllDay !== undefined) { body.start = full.start; body.end = full.end; if (event.recurrence) body.recurrence = full.recurrence; }
    }
    plan = { planKind: "json-body", body };
  }
  return json({ serializer: { id: targetProvider + "-personal-event", version: 1 }, admittedProjection: { data: normalizedEvent(targetProvider, event, replacement) }, nativePlan: { kind: "codec-data", data: plan } });
}
function taskProjection(provider: SyncCodecProvider, task: Task, component: ICAL.Component): SyncCodecJsonObject {
  if (provider === "google") return { due: task.due ? dateOnly(task.due) + "T00:00:00.000Z" : null, notes: task.description ?? null, status: task.status === "completed" ? "completed" : "needsAction", title: task.title };
  if (provider === "microsoft") {
    const endpoint = (date: Date | null | undefined) => date ? { dateTime: iso(date).replace(/Z$/, ""), timeZone: "UTC" } : null;
    return { body: { content: task.description ?? "", contentType: "text" }, dueDateTime: endpoint(task.due),
      importance: task.priority === 0 || task.priority === 5 ? "normal" : task.priority < 5 ? "high" : "low",
      startDateTime: endpoint(task.start), status: task.status === "completed" ? "completed" : task.status === "in-process" ? "inProgress" : "notStarted", title: task.title };
  }
  const dateValue = (date: Date | null | undefined) => date ? task.isAllDay ? dateOnly(date) + "T00:00:00.000Z" : secondIso(date) : null;
  return { title: task.title, description: task.description || null, status: task.status,
    start: dateValue(task.start), due: dateValue(task.due), isAllDay: Boolean(task.isAllDay && (task.start || task.due)),
    completedAt: task.completedAt ? secondIso(task.completedAt) : null, percentComplete: task.percentComplete,
    priority: task.priority, recurrence: recurrenceFrom(component), relatedTo: task.relatedTo || null, sequence: task.sequence, url: task.url || null };
}
export function encodeTaskV1(providerValue: SyncCodecProvider, input: Task, patch: Record<string, unknown> | undefined, context: SyncCodecContextV1): EncodedSyncWriteV1 {
  const targetProvider = provider(providerValue); operationId(context);
  const task = TaskSchema.parse(input);
  for (const date of [task.start, task.due, task.completedAt]) if (date) finite(date);
  const uid = context.uid ?? task.id;
  const replacement = taskComponent(task, uid);
  if (targetProvider !== "caldav" && task.recurrence) refuse();
  const projection = taskProjection(targetProvider, task, replacement);
  if (patch) JSON.stringify(patch, (_key, value) => { if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" || value === undefined || typeof value === "number" && !Number.isFinite(value)) refuse("invalid-input"); return value; });
  if (patch && Object.keys(patch).some(key => JSON.stringify(patch[key]) !== JSON.stringify(projection[key]))) refuse("invalid-input");
  if (patch != null && (typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some(key => !(key in projection)))) refuse("invalid-input");
  let plan: JsonBodyPlanV1 | CaldavPropertyPlanV1;
  if (targetProvider === "caldav") {
    if (context.action === "create") replacement.addPropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(context.acceptedAt), true));
    const properties = patch ? [...new Set(Object.keys(patch).flatMap(key => TASK_FIELDS[key] ?? []))] : [...new Set(Object.values(TASK_FIELDS).flat())];
    plan = { planKind: "caldav-properties", component: "VTODO", uid, replacementComponent: replacement.toString(), createResource: resource(replacement), properties };
  } else {
    // A supplied patch is already a provider-projection diff, never a canonical task patch.
    const body = context.action === "delete" ? null : context.action === "update" && patch ? patch : projection;
    plan = { planKind: "json-body", body: json(body) as SyncCodecJsonObject | null };
  }
  return json({ serializer: { id: targetProvider + "-task", version: 1 }, admittedProjection: { data: projection }, nativePlan: { kind: "codec-data", data: plan } });
}
function canonicalRecurrence(value: string | null) { return value ? [...new Set(value.split("\n").filter(Boolean))].sort().join("\n") : null; }
function applyCaldav(currentResource: string, plan: CaldavPropertyPlanV1, expected: "VEVENT" | "VTODO") {
  if (!parseNativeWritePlanV1({id:expected === "VEVENT" ? "caldav-personal-event" : "caldav-task",version:1}, "update", expected === "VEVENT" ? "event" : "task", plan)) refuse("invalid-native-plan");
  if (plan.planKind !== "caldav-properties" || plan.component !== expected || !plan.uid ||
    !Array.isArray(plan.properties) || new Set(plan.properties).size !== plan.properties.length) refuse("invalid-native-plan");
  const allowed = expected === "VEVENT" ? new Set(["summary", "description", "location", "dtstart", "dtend", "duration", "rrule", "rdate", "exdate"]) : new Set(Object.values(TASK_FIELDS).flat());
  if (plan.properties.some(name => !allowed.has(name))) refuse("invalid-native-plan");
  const calendar = new ICAL.Component(ICAL.parse(currentResource));
  const kind = expected.toLowerCase();
  if (calendar.name !== "vcalendar") refuse("invalid-resource");
  const components = calendar.getAllSubcomponents(kind);
  const masters = components.filter(component => !component.hasProperty("recurrence-id") && component.getFirstPropertyValue("uid") === plan.uid);
  if (masters.length !== 1 || masters[0].getAllProperties("uid").length !== 1) refuse("invalid-resource");
  const master = masters[0], replacement = new ICAL.Component(ICAL.parse(plan.replacementComponent));
  if (replacement.name !== kind || replacement.getFirstPropertyValue("uid") !== plan.uid || replacement.hasProperty("recurrence-id")) refuse("invalid-native-plan");
  const names = new Set(plan.properties);
  if (expected === "VEVENT" && (names.has("dtstart") || names.has("dtend")) && master.hasProperty("duration")) { names.add("dtend"); names.add("duration"); }
  const recurrenceNames = ["rrule", "exdate", "rdate"];
  if (recurrenceNames.some(name => names.has(name))) {
    const changed = canonicalRecurrence(recurrenceFrom(master)) !== canonicalRecurrence(recurrenceFrom(replacement));
    if (!changed) for (const name of recurrenceNames) names.delete(name);
    else if (components.some(component => component !== master && component.hasProperty("recurrence-id") && component.getFirstPropertyValue("uid") === plan.uid)) refuse();
  }
  for (const name of ["dtstart", "dtend", "due"]) {
    if (!names.has(name)) continue;
    const old = master.getFirstProperty(name), next = replacement.getFirstProperty(name);
    const tzid = old?.getParameter("tzid");
    const before = old?.getFirstValue() as ICAL.Time | undefined, after = next?.getFirstValue() as ICAL.Time | undefined;
    if (tzid && before && after && !before.isDate && !after.isDate) {
      next!.setValue(ICAL.Time.fromJSDate(after.toJSDate(), true).convertToZone(before.zone));
      next!.setParameter("tzid", tzid);
    }
  }
  const map = new Map([...names].map(name => [name, replacement.getAllProperties(name)]));
  return replaceComponentPropertiesV1(currentResource, components.indexOf(master), map, kind as "vevent" | "vtodo");
}
export function applyCaldavEventPlanV1(currentResource: string, plan: CaldavPropertyPlanV1): string { return applyCaldav(currentResource, plan, "VEVENT"); }
export function applyCaldavTaskPlanV1(currentResource: string, plan: CaldavPropertyPlanV1): string { return applyCaldav(currentResource, plan, "VTODO"); }


export function restrictCaldavTaskPlanV1(plan: CaldavPropertyPlanV1, patchKeys: readonly string[]): CaldavPropertyPlanV1 {
  if (plan.component !== "VTODO" || patchKeys.some(key => !Object.prototype.hasOwnProperty.call(TASK_FIELDS,key))) refuse("invalid-native-plan");
  const names=new Set(patchKeys.flatMap(key=>TASK_FIELDS[key]));
  return { ...plan, properties: plan.properties.filter(name=>names.has(name)) };
}
export function restrictJsonBodyPlanV1(plan: JsonBodyPlanV1, patchKeys: readonly string[]): JsonBodyPlanV1 {
  if (!plan.body || patchKeys.some(key=>!Object.prototype.hasOwnProperty.call(plan.body,key))) refuse("invalid-native-plan");
  return { planKind: "json-body", body: Object.fromEntries(patchKeys.map(key=>[key,plan.body![key]])) };
}
