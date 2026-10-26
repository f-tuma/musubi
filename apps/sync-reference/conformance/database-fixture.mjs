import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { Pool } from "pg";
import { parseAllocationJournal, ownedDatabaseName } from "./db-journal.mjs";
async function zeroSessions(admin, names) {
  const deadline = Date.now() + 2000;
  do { if ((await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=ANY($1::text[])", [names])).rows[0].count === 0) return true; await pause(20); } while (Date.now() < deadline);
  return false;
}
export async function referenceFixture(env, directory) {
  if (env.ENVIRONMENT !== "test" || !env.REFERENCE_DATABASE_URL) throw new Error("An explicit disposable reference admin URL is required");
  const admin = new Pool({ connectionString: env.REFERENCE_DATABASE_URL, max: 1, connectionTimeoutMillis: 2000, query_timeout: 2000 });
  const name = `reference_c10_outer_${randomUUID().replaceAll("-", "")}`, namespace = `reference_c10_${randomUUID().replaceAll("-", "").slice(0, 16)}_`;
  const url = new URL(env.REFERENCE_DATABASE_URL); url.pathname = `/${name}`; const journal = join(directory, "allocations.jsonl");
  try {
    if ((await admin.query("SELECT 1 FROM pg_database WHERE left(datname,length($1))=$1", [namespace])).rowCount !== 0) throw new Error("Owned namespace is not empty");
    await admin.query(`CREATE DATABASE "${name}"`);
  } catch (error) { await admin.end(); throw error; }
  return { env: { REFERENCE_DATABASE_URL: url.href, ENVIRONMENT: "test", SYNC_CONFORMANCE_DATABASE_NAMESPACE: namespace, SYNC_CONFORMANCE_DB_JOURNAL: journal }, async cleanup() {
    const facts = { namespace, outer: name, issuerSessionsZero: false, journalValid: false, intents: [], databases: [], outerPlainDrop: false, outerAbsent: false, recovered: false };
    let complete = true;
    try {
      // All supported CREATE issuers connect to the outer DB. Until those
      // sessions end, an absent catalog row cannot resolve a pending CREATE.
      facts.issuerSessionsZero = await zeroSessions(admin, [name]); if (!facts.issuerSessionsZero) return { required: true, completed: false };
      let text; try { text = await readFile(journal, "utf8"); } catch { text = ""; }
      const parsed = parseAllocationJournal(text, namespace); facts.journalValid = parsed.valid; complete = parsed.valid;
      facts.intents = [...parsed.states].map(([name, state]) => ({ name, state }));
      const catalog = (await admin.query("SELECT datname FROM pg_database WHERE left(datname,length($1))=$1 ORDER BY datname", [namespace])).rows.map(r => r.datname);
      const names = new Set([...parsed.states.keys(), ...catalog]);
      for (const child of names) {
        if (!ownedDatabaseName(child, namespace)) { complete = false; continue; } // A journal never grants authority outside the parent's exact nonce namespace.
        const exists = catalog.includes(child), state = parsed.states.get(child); let absent = !exists, plainDrop = false, sessionsZero = absent;
        if (!state || !["dropped", "refused"].includes(state)) complete = false;
        if (exists) {
          facts.recovered = true; complete = false; sessionsZero = await zeroSessions(admin, [child]);
          if (sessionsZero) { await admin.query(`DROP DATABASE "${child}"`); plainDrop = true; absent = (await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [child])).rowCount === 0; }
        }
        if (!absent) complete = false; facts.databases.push({ name: child, state: state ?? "unrecorded", sessionsZero, plainDrop, absent });
      }
      if (!await zeroSessions(admin, [name])) return { required: true, completed: false };
      await admin.query(`DROP DATABASE "${name}"`); facts.outerPlainDrop = true; facts.outerAbsent = (await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])).rowCount === 0;
      if (!facts.outerAbsent || (await admin.query("SELECT 1 FROM pg_database WHERE left(datname,length($1))=$1", [namespace])).rowCount !== 0) complete = false;
      return { required: true, completed: complete };
    } finally { await writeFile(join(directory, "cleanup-facts.json"), `${JSON.stringify(facts)}\n`, { mode: 0o600 }); await admin.end(); }
  } };
}
