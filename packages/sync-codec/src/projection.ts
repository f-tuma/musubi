import ICAL from "ical.js";
import { OccurrenceStartSchema } from "@musubi/types";
import { parseNativeWritePlanV1 } from "./native_plan";
import { recurrenceFrom } from "./recurrence";
import type { SyncCodecAction } from "./index";
const record = (value: unknown): value is Record<string, unknown> => value != null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === fields.length && fields.every(key => Object.prototype.hasOwnProperty.call(value,key));
}
function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value,index)=>same(value,right[index]));
  return record(left) && record(right) && Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every(key=>Object.prototype.hasOwnProperty.call(right,key)&&same(left[key],right[key]));
}
function instant(value: unknown): value is string {
  const parsed=OccurrenceStartSchema.safeParse({kind:"instant",value});
  return parsed.success && parsed.data.kind === "instant" && value === parsed.data.value;
}
const nullableText=(value:unknown)=>value === null || typeof value === "string";
const eventFields=["title","start","end","isAllDay","description","location","recurrence"] as const;
const todoFields=["title","description","status","start","due","isAllDay","completedAt","percentComplete","priority","recurrence","relatedTo","sequence","url"] as const;
function eventShape(value: unknown): value is Record<string,unknown> {
  return exact(value,eventFields)&&typeof value.title === "string"&&instant(value.start)&&instant(value.end)&&
    value.start<=value.end&&typeof value.isAllDay==="boolean"&&
    (!value.isAllDay || value.start.endsWith("T00:00:00.000Z") && value.end.endsWith("T00:00:00.000Z"))&&
    [value.description,value.location,value.recurrence].every(nullableText);
}
function todoShape(value: unknown): value is Record<string,unknown> {
  return exact(value,todoFields)&&typeof value.title==="string"&&nullableText(value.description)&&
    typeof value.status==="string"&&["needs-action","in-process","completed","cancelled"].includes(value.status)&&
    [value.start,value.due,value.completedAt].every(value=>value === null || instant(value))&&typeof value.isAllDay==="boolean"&&
    typeof value.percentComplete==="number"&&Number.isInteger(value.percentComplete)&&value.percentComplete>=0&&value.percentComplete<=100&&
    typeof value.priority==="number"&&Number.isInteger(value.priority)&&value.priority>=0&&value.priority<=9&&
    typeof value.sequence==="number"&&Number.isSafeInteger(value.sequence)&&value.sequence>=0&&
    [value.recurrence,value.relatedTo,value.url].every(nullableText);
}
function caldavTime(component: ICAL.Component, name: string): string|null {
  const value=component.getFirstPropertyValue(name) as ICAL.Time|null;
  if (!value) return null;
  if (!value.isDate) return value.toJSDate().toISOString();
  return String(value.year).padStart(4,"0")+"-"+String(value.month).padStart(2,"0")+"-"+String(value.day).padStart(2,"0")+"T00:00:00.000Z";
}
function caldavText(component: ICAL.Component,name:string):string|null {
  const value=component.getFirstPropertyValue(name);
  return typeof value === "string" ? value : null;
}
function savedCaldavEvent(component: ICAL.Component) {
  const start=component.getFirstPropertyValue("dtstart") as ICAL.Time;
  const end=caldavTime(component,"dtend")!;
  return {title:caldavText(component,"summary")??"(untitled)",start:caldavTime(component,"dtstart"),
    end:start.isDate?new Date(new Date(end).getTime()-86_400_000).toISOString():end,isAllDay:start.isDate,
    description:caldavText(component,"description"),location:caldavText(component,"location"),recurrence:recurrenceFrom(component)};
}
function savedCaldavTask(component: ICAL.Component) {
  const start=component.getFirstPropertyValue("dtstart") as ICAL.Time|null, due=component.getFirstPropertyValue("due") as ICAL.Time|null;
  const rawStatus=caldavText(component,"status")!;
  const statuses:Record<string,string>={"NEEDS-ACTION":"needs-action","IN-PROCESS":"in-process",COMPLETED:"completed",CANCELLED:"cancelled"};
  return {title:caldavText(component,"summary")??"(untitled)",description:caldavText(component,"description"),status:statuses[rawStatus],
    start:caldavTime(component,"dtstart"),due:caldavTime(component,"due"),isAllDay:Boolean(start?.isDate||due?.isDate),
    completedAt:caldavTime(component,"completed"),percentComplete:component.getFirstPropertyValue("percent-complete"),
    priority:component.getFirstPropertyValue("priority"),recurrence:recurrenceFrom(component),relatedTo:caldavText(component,"related-to"),
    sequence:component.getFirstPropertyValue("sequence"),url:caldavText(component,"url")};
}
function normalizedGoogleRecurrence(lines: unknown, start: string) {
  if (lines === null) return null;
  return (lines as string[]).map(line=>{
    if (/^(RRULE:)?FREQ=/.test(line)&&/FREQ=YEARLY/.test(line)&&/BYMONTHDAY=/.test(line)&&!/BYMONTH=/.test(line))
      return line+";BYMONTH="+(new Date(start).getUTCMonth()+1);
    return line;
  }).join("\n");
}
function googleTime(value:unknown,end=false) {
  const endpoint=value as {date?:string;dateTime?:string};
  if (endpoint.date) return new Date(new Date(endpoint.date+"T00:00:00.000Z").getTime()-(end?86_400_000:0)).toISOString();
  return new Date(endpoint.dateTime!).toISOString();
}
function graphTime(value:unknown,allDay:boolean,end=false) {
  const endpoint=value as {dateTime:string};
  const instant=new Date(endpoint.dateTime.endsWith("Z")?endpoint.dateTime:endpoint.dateTime+"Z");
  return new Date(instant.getTime()-(allDay&&end?86_400_000:0)).toISOString();
}
/** Agreement between TWO saved views. This decodes pinned native data and never
 * projects a current Event/Task or consults a canonical row/provider/clock.
 */
export function matchesPinnedProjectionV1(serializer:{id:string;version:number},action:SyncCodecAction,
  projection:unknown,nativeData:unknown):boolean {
  try {
    const kind=serializer.id.endsWith("-task")?"task":"event";
    const plan=parseNativeWritePlanV1(serializer,action,kind,nativeData);
    if(!plan||!record(projection))return false;
    const provider=serializer.id.split("-")[0];
    if(kind==="event"&&!eventShape(projection))return false;
    if(plan.planKind==="caldav-properties"){
      const component=new ICAL.Component(ICAL.parse(plan.replacementComponent));
      return kind==="event"?same(projection,savedCaldavEvent(component)):todoShape(projection)&&same(projection,savedCaldavTask(component));
    }
    if(kind==="task"){
      // The full native target stays pinned; late patch selection is separate.
      const expectedFields=provider==="google"?["due","notes","status","title"]:["body","dueDateTime","importance","startDateTime","status","title"];
      if(!exact(projection,expectedFields))return false;
      if(action==="delete")return parseNativeWritePlanV1(serializer,"create","task",{planKind:"json-body",body:projection})!==undefined;
      return same(projection,plan.body);
    }
    if(action==="delete")return true;
    const body=plan.body!;
    const fields:Record<string,unknown>={};
    if(provider==="google"){
      // Each saved endpoint defines DATE/dateTime semantics independently of
      // whether the sparse update also contains the other endpoint.
      for (const key of ["start", "end"]) {
        if (key in body && record(body[key]) && ("date" in body[key]) !== projection.isAllDay) return false;
      }
      if(action==="create"||"summary" in body)fields.title=body.summary;
      if(action==="create"||"description" in body)fields.description=body.description??null;
      if(action==="create"||"location" in body)fields.location=body.location??null;
      if("start" in body)fields.start=googleTime(body.start);
      if("end" in body)fields.end=googleTime(body.end,true);
      if(action==="create")fields.isAllDay=record(body.start)&&"date" in body.start;
      if("recurrence" in body)fields.recurrence=normalizedGoogleRecurrence(body.recurrence,String(fields.start??projection.start));
    }else{
      if(action==="create"||"subject" in body)fields.title=body.subject;
      if(action==="create"||"body" in body)fields.description=(body.body as {content:string}).content.trim()||null;
      if(action==="create"||"location" in body)fields.location=(body.location as {displayName:string}).displayName.trim()||null;
      if(action==="create"){
        fields.start=graphTime(body.start,body.isAllDay as boolean);fields.end=graphTime(body.end,body.isAllDay as boolean,true);
        fields.isAllDay=body.isAllDay;fields.recurrence=null;
      }
    }
    return Object.entries(fields).every(([key,value])=>same(projection[key],value));
  }catch{return false;}
}
