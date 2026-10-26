import { randomUUID } from "node:crypto";
/** Test allocation identity only; the parent owns this fresh namespace. */
export function referenceTestDatabaseName(prefix: string) {
  if (!/^reference_[a-z0-9_]+_$/.test(prefix) || prefix.length + 32 > 63) throw new Error("Invalid reference test database prefix");
  const namespace = process.env.SYNC_CONFORMANCE_DATABASE_NAMESPACE;
  if (namespace !== undefined && !/^reference_c10_[a-f0-9]{16}_$/.test(namespace)) throw new Error("Invalid parent-owned database namespace");
  return `${namespace ?? prefix}${randomUUID().replaceAll("-", "")}`;
}
