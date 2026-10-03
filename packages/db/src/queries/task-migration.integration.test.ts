import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Use only a disposable PostgreSQL database.");
  assert.ok(process.env.DATABASE_URL);
  const baseURL = new URL(process.env.DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(baseURL.hostname), "Migration fixture must use local disposable PostgreSQL");
  const name = `musubi_tasks_migration_${randomUUID().replace(/-/g, "")}`;
  const admin = new pg.Client({ connectionString: baseURL.toString() });
  const directory = await mkdtemp(resolve(tmpdir(), "musubi-tasks-migration-"));
  let pool: pg.Pool | undefined;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    baseURL.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: baseURL.toString() });
    const migrations = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");
    const journal = JSON.parse(await readFile(resolve(migrations, "meta/_journal.json"), "utf8"));
    const previous = journal.entries.filter((entry: { idx: number }) => entry.idx < 80);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(resolve(directory, "meta"));
    await writeFile(resolve(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries: previous }));
    for (const entry of previous) await copyFile(resolve(migrations, `${entry.tag}.sql`), resolve(directory, `${entry.tag}.sql`));
    await migrate(drizzle(pool), { migrationsFolder: directory });
    const owner = randomUUID(), calendar = randomUUID(), source = randomUUID(), liveID = randomUUID(), deletedID = randomUUID();
    await pool.query('insert into "user" (id,name,email) values ($1,$1,$2)', [owner, `${owner}@example.test`]);
    await pool.query('insert into calendars(id,creator_id,name,color) values ($1,$2,$3,$4)', [calendar, owner, "Home", "#112233"]);
    await pool.query('insert into external_calendars(id,provider,user_id,account_id,calendar_id,external_calendar_id,supports_tasks,provider_access_revision) values ($1,$2,$3,$4,$5,$6,true,7)', [source, "caldav", owner, "original-account", calendar, "collection-url"]);
    await pool.query('insert into tasks(id,creator_id,calendar_id,title,sequence) values ($1,$2,$3,$4,99)', [liveID, owner, calendar, "Live"]);
    await pool.query('insert into tasks(id,creator_id,calendar_id,title,sequence,deleted_at) values ($1,$2,$3,$4,45,$5)', [deletedID, owner, calendar, "Deleted", new Date("2026-01-01T00:00:00Z")]);
    for (const [id, resource] of [[liveID, "live.ics"], [deletedID, "deleted.ics"]])
      await pool.query('insert into external_tasks(provider,task_id,calendar_id,external_calendar_id,external_task_id,etag,ical_uid) values ($1,$2,$3,$4,$5,$6,$7)', ["caldav", id, calendar, "collection-url", resource, '"original-etag"', "same-foreign-uid"]);
    await migrate(drizzle(pool), { migrationsFolder: migrations });
    const { rows } = await pool.query('select id,origin_calendar_id,calendar_id,revision,sequence,deleted_at from tasks order by title');
    assert.equal(rows.length, 2, "Backfill never merges tasks by a duplicate provider UID");
    for (const row of rows) { assert.equal(row.origin_calendar_id, calendar); assert.equal(row.calendar_id, calendar); assert.equal(row.revision, 1); }
    assert.equal(rows.find((row) => row.id === liveID)?.sequence, 99, "SEQUENCE remains independent of CAS revision");
    assert.equal(rows.find((row) => row.id === deletedID)?.sequence, 45);
    assert.equal(rows.find((row) => row.id === deletedID)?.deleted_at.toISOString(), "2026-01-01T00:00:00.000Z");
    const memberships = (await pool.query('select task_id,calendar_id from calendar_tasks')).rows;
    assert.deepEqual(memberships.map((row) => row.task_id).sort(), [liveID, deletedID].sort(), "Backfill includes tombstone memberships");
    const mappings = (await pool.query('select task_id,external_task_id,etag,ical_uid,external_calendar_link_id,account_id,provider_access_revision,accepted_revision from external_tasks')).rows;
    assert.equal(mappings.length, 2);
    for (const map of mappings) {
      assert.equal(map.etag, '"original-etag"'); assert.equal(map.ical_uid, "same-foreign-uid");
      assert.equal(map.external_calendar_link_id, source); assert.equal(map.account_id, "original-account");
      assert.equal(map.provider_access_revision, 7); assert.equal(map.accepted_revision, 1);
    }
    await pool.query('delete from calendars where id = $1', [calendar]);
    assert.equal((await pool.query('select id from tasks')).rows.length, 2, "Calendar FK no longer destroys shared identities or tombstones");
    console.log("Shared task expand/backfill/cutover migration self-check: OK");
  } finally {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
}
main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
