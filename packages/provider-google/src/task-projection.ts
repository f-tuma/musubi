import type { GoogleNativeTask, GoogleTaskObservedProjection, GoogleTaskProjection, GoogleTaskUpdateBody } from "./task-types";
import { strongGoogleEtag } from "./etag";

/** Read own data fields only; a bad snapshot never evaluates a getter/toJSON. */
export function googleTaskDataRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) return null;
      Object.defineProperty(result, key, { value: descriptor.value, enumerable: true, writable: true, configurable: true });
    }
    return result;
  } catch { return null; }
}
const FIELDS = ["title", "notes", "status", "due"];
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 2_000_000;
function dueDay(value: unknown): boolean {
  return value === null || typeof value === "string" && /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function parseGoogleTaskPatch(value: unknown): GoogleTaskUpdateBody | null {
  const item = googleTaskDataRecord(value);
  if (!item || Object.keys(item).some(key => !FIELDS.includes(key))) return null;
  for (const [key, field] of Object.entries(item)) {
    if (key === "title" ? !text(field) : key === "notes" ? field !== null && !text(field) :
      key === "status" ? field !== "needsAction" && field !== "completed" : !dueDay(field)) return null;
  }
  return Object.freeze(item) as GoogleTaskUpdateBody;
}
export function parseGoogleTaskProjection(value: unknown): GoogleTaskProjection | null {
  const patch = parseGoogleTaskPatch(value);
  return patch && FIELDS.every(key => Object.prototype.hasOwnProperty.call(patch, key)) ? patch as GoogleTaskProjection : null;
}
/** This is the actual Google native four-field normalization, including its
 * existing permissive notes and scheduled-day String conversion. */
export function googleTaskProjectionFromNative(task: GoogleNativeTask): GoogleTaskObservedProjection {
  return Object.freeze({ title: task.title, notes: task.notes ?? null, status: task.status,
    due: task.due ? `${String(task.due).slice(0, 10)}T00:00:00.000Z` : null });
}
/** Late baseline resolution chooses only field names; target values stay saved. */
export function diffGoogleTaskProjection(baseline: Readonly<Record<string, unknown>>, target: GoogleTaskProjection): GoogleTaskUpdateBody {
  return Object.freeze(Object.fromEntries(Object.entries(target).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(baseline[key]))));
}
export function sameGoogleTaskProjection(before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(after).every(([key, value]) => JSON.stringify(value) === JSON.stringify(before[key])) &&
    Object.entries(before).every(([key, value]) => JSON.stringify(value) === JSON.stringify(after[key]));
}
export function achievesGoogleTaskPatch(current: Readonly<Record<string, unknown>>, patch: GoogleTaskUpdateBody): boolean {
  return Object.entries(patch).every(([key, value]) => JSON.stringify(current[key]) === JSON.stringify(value));
}

function strictJsonData(value: unknown, active: Set<object>, budget: { nodes: number; text: number }, depth = 0): boolean {
  if (++budget.nodes > 10_000 || depth > 32) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") { budget.text += value.length; return budget.text <= 2_000_000; }
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || active.has(value)) return false;
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return false;
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor) || !strictJsonData(descriptor.value, active, budget, depth + 1)) return false;
      }
      return true;
    }
    const item = googleTaskDataRecord(value);
    if (!item) return false;
    for (const [key, field] of Object.entries(item)) {
      budget.text += key.length;
      if (budget.text > 2_000_000 || !strictJsonData(field, active, budget, depth + 1)) return false;
    }
    return true;
  } finally { active.delete(value); }
}
function strictNativeDue(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  return !!match && Number(match[2]) < 24 && Number(match[3]) < 60 && Number(match[4]) < 60 &&
    (match[5] === undefined || Number(match[5]) < 24 && Number(match[6]) < 60) && Number.isFinite(Date.parse(value)) &&
    new Date(`${match[1]}T00:00:00.000Z`).toISOString().slice(0, 10) === match[1];
}
/** Package-internal diagnostic form lets the native reader preserve its
 * action-specific errors while the independent ACK consumes one boolean proof. */
export function strictGoogleTaskNativeError(value: unknown, taskId: string, etag: string):
  "task-projection-unavailable" | "task-source-read-only" | "task-version-unavailable" | "task-provider-conflict" | null {
  try {
    const item = googleTaskDataRecord(value);
    if (!item || !strictJsonData(value, new Set(), { nodes: 0, text: 0 }) || typeof item.id !== "string" || !item.id || item.id !== taskId || typeof item.title !== "string" ||
        !["needsAction", "completed"].includes(item.status as string)) return "task-projection-unavailable";
    if (item.assignmentInfo) return "task-source-read-only";
    if (strongGoogleEtag(item.etag) === null || strongGoogleEtag(etag) === null) return "task-version-unavailable";
    if (item.etag !== etag) return "task-provider-conflict";
    const notes = item.notes, due = item.due;
    if (item.deleted !== undefined && typeof item.deleted !== "boolean" || notes != null && typeof notes !== "string" || !strictNativeDue(due) ||
        !parseGoogleTaskProjection(googleTaskProjectionFromNative(item as GoogleNativeTask))) return "task-projection-unavailable";
    return item.deleted === true ? "task-provider-conflict" : null;
  } catch { return "task-projection-unavailable"; }
}
/** Pure complete strict native-body proof for both the provider and an
 * independent host's final locked ACK. It never evaluates nested accessors. */
export function isStrictGoogleNativeTask(value: unknown, taskId: string, etag: string): value is GoogleNativeTask {
  return strictGoogleTaskNativeError(value, taskId, etag) === null;
}
