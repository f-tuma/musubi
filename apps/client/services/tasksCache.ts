import { TaskSchema, type Task } from "@musubi/types";
import { sqlite } from "./db";

export type CachedTasks = { tasks: Task[]; lastSyncedAt: number | null };
const key = (scope: string) => `task-collection:${scope}`;

/** Account-scoped data shares sync_meta so the existing account reset wipes it. */
export function cacheGetTasks(scope: string): CachedTasks | null {
  const row = sqlite.getFirstSync<{ value: string }>(
    "SELECT value FROM sync_meta WHERE key = ?", key(scope),
  );
  if (!row) return null;
  const cached = JSON.parse(row.value);
  if (cached.version !== 1 || (cached.lastSyncedAt !== null &&
    (typeof cached.lastSyncedAt !== "number" || !Number.isFinite(cached.lastSyncedAt)))) {
    throw new Error("The saved task collection could not be read.");
  }
  return { tasks: TaskSchema.array().parse(cached.tasks), lastSyncedAt: cached.lastSyncedAt };
}

export function cacheSetTasks(scope: string, tasks: Task[], lastSyncedAt: number | null) {
  const value = JSON.stringify({ version: 1, tasks, lastSyncedAt });
  // Synchronous transaction: no delayed private write can run after account reset.
  sqlite.withTransactionSync(() => {
    sqlite.runSync("DELETE FROM sync_meta WHERE key = ?", key(scope));
    sqlite.runSync("INSERT INTO sync_meta (key, value) VALUES (?, ?)", key(scope), value);
  });
}

export function cacheDeleteTasks(scope: string) {
  sqlite.runSync("DELETE FROM sync_meta WHERE key = ?", key(scope));
}
