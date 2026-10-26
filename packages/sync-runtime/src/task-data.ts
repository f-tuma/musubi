import { parseGoogleTaskProjection, parseGoogleTaskPatch, diffGoogleTaskProjection, sameGoogleTaskProjection, type GoogleTaskProjection } from "@musubi/provider-google";
import type { GoogleTaskSavedProjection } from "./google-task-update-ports";
import { copyNativeTaskEvidence } from "./task-native-data";

export function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Invalid task data.");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw new Error("Invalid task data.");
  return descriptor.value;
}
export function copy<T>(value: T, depth = 0): T {
  if (depth > 16) throw new Error("Invalid task data.");
  if (value === null || typeof value === "boolean" || typeof value === "string" && value.length <= 2_000_000 || typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") throw new Error("Invalid task data.");
  if (Array.isArray(value)) {
    if (value.length > 256 || Reflect.ownKeys(value).length !== value.length + 1) throw new Error("Invalid task data.");
    return Object.freeze(Array.from({ length: value.length }, (_, i) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error("Invalid task data.");
      return copy(descriptor.value, depth + 1);
    })) as T;
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length > 128) throw new Error("Invalid task data.");
  return Object.freeze(Object.fromEntries(Reflect.ownKeys(value).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Invalid task data.");
    return [key, copy(descriptor.value, depth + 1)];
  }))) as T;
}
export function identity(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048) throw new Error("Invalid task identity.");
  return value;
}
export function projection(value: unknown): GoogleTaskProjection {
  const parsed = parseGoogleTaskProjection(value);
  if (!parsed) throw new Error("Invalid task projection.");
  return copy(parsed);
}
export function baseline(value: unknown): Readonly<Record<string, unknown>> {
  const item = copyNativeTaskEvidence(value);
  if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).sort().join(",") !== "due,notes,status,title") throw new Error("Invalid task baseline.");
  return item as Readonly<Record<string, unknown>>;
}
export function savedProjection(value: unknown, target: GoogleTaskProjection): GoogleTaskSavedProjection {
  const item = copyNativeTaskEvidence(value);
  const admitted = projection(own(item, "projection")), before = baseline(own(item, "baseline")), patch = parseGoogleTaskPatch(own(item, "patch"));
  if (!patch || !sameTask(admitted, target) || !sameTask(patch, diffGoogleTaskProjection(before, target))) throw new Error("Invalid task saved mask.");
  return copyNativeTaskEvidence({ projection: admitted, baseline: before, patch });
}
export const sameTask = (left: object, right: object) => sameGoogleTaskProjection(left as Readonly<Record<string, unknown>>, right as Readonly<Record<string, unknown>>);
