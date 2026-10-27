import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import type { Pool } from "pg";

// Test support only: no production store or scheduling behavior lives here.
export type ClosingSession = { pid: number; application_name: string; state: string; wait_event_type: string | null };
export async function dropOwnedTestDatabase(admin: Pool, name: string, ownedPrefix: "c09budget_" | "event_compat_",
  options: { timeoutMs?: number; onObservation?: (sessions: ClosingSession[]) => void } = {}) {
  assert.ok(["c09budget_", "event_compat_"].includes(ownedPrefix), "Only registered fixture prefixes may be dropped");
  const timeoutMs = options.timeoutMs ?? 2_000;
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10_000);
  assert.match(name, new RegExp(`^${ownedPrefix}[a-f0-9]{32}$`), "Cleanup only owns its unpredictable fixture database");
  const start = performance.now(), deadline = start + timeoutMs;
  let checks = 0, firstSessions: ClosingSession[] = [], sessions: ClosingSession[] = [];
  do {
    if (checks > 0 && performance.now() >= deadline) break;
    // Each query is a separate autocommit transaction: pg_stat_activity must
    // not reuse a transaction's earlier snapshot. Pool.end() can resolve before
    // its asynchronously disconnected PostgreSQL backends actually disappear.
    const query = { text: "select pid, application_name, state, wait_event_type from pg_stat_activity where datname=$1 order by pid",
      values: [name], query_timeout: 1_000 };
    sessions = (await admin.query<ClosingSession>(query)).rows;
    if (checks++ === 0) firstSessions = sessions;
    options.onObservation?.(sessions);
    if (sessions.length === 0) break;
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await pause(Math.min(20, remaining));
  } while (true);
  assert.equal(sessions.length, 0, `Only drop a nonce DB after every client closes: ${JSON.stringify({ database: name, checks, remainingSessions: sessions })}`);
  await admin.query(`DROP DATABASE "${name}"`);
  assert.equal((await admin.query("select 1 from pg_database where datname=$1", [name])).rowCount, 0);
  return { database: name, sessionsBeforeDrop: 0, plainDrop: true, databaseAbsent: true,
    checks, waitMs: Math.ceil(performance.now() - start), firstSessions };
}

