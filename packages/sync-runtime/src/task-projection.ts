import type { TaskCompatibilityProjection } from "./task-compatibility-ports";

/** Existing host-native projection semantics. This is deliberately independent
 * of a v1 admission schema or any provider's narrower portable projection. */
export function jsonTaskProjection(value: TaskCompatibilityProjection): TaskCompatibilityProjection {
  return JSON.parse(JSON.stringify(value));
}
export function diffTaskProjection(before: TaskCompatibilityProjection, after: TaskCompatibilityProjection): TaskCompatibilityProjection {
  return Object.fromEntries(Object.entries(after).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key])));
}
export function sameTaskProjection(before: TaskCompatibilityProjection, after: TaskCompatibilityProjection) {
  return Object.keys(diffTaskProjection(before, after)).length === 0 && Object.keys(diffTaskProjection(after, before)).length === 0;
}
