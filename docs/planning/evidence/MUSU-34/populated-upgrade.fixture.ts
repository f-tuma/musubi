import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import dotenv from "dotenv";

const BASELINE = "be267b2a960c768c60bd0f91de1106f8878e7999";
let db: typeof import("../../../../packages/db/src/index").db;
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sortWire = (value: any[]) => json(value).sort((a: any, b: any) => `${a.event.id}/${a.calendarID}`.localeCompare(`${b.event.id}/${b.calendarID}`));
const query = async (sql: string, parameters: unknown[] = []) => (await db.$client.query(sql, parameters)).rows;
async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
  assert.equal(url.pathname, "/musubi_c03_upgrade", "Only the isolated populated-upgrade database is permitted");
  const baselinePath = resolve(process.argv[2] ?? "");
  assert.equal(execFileSync("git", ["-C", baselinePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), BASELINE);
  // Fixture processes never load either checkout's real .env. Stub only the
  // dotenv file loader before importing application modules; retain explicit
  // disposable DATABASE_URL/ENVIRONMENT/BETTER_AUTH_URL supplied by the caller.
  const originalDotenvConfig = dotenv.config;
  const baselineDotenv = createRequire(resolve(baselinePath, "package.json"))("dotenv") as typeof dotenv;
  const originalBaselineDotenvConfig = baselineDotenv.config;
  dotenv.config = baselineDotenv.config = () => ({ parsed: {} });
  process.env.BETTER_AUTH_SECRET = "musubi-disposable-upgrade-fixture-secret-20261012";
  process.env.MICROSOFT_CLIENT_ID = "fixture-only"; process.env.MICROSOFT_CLIENT_SECRET = "fixture-only";
  const { config } = await import("../../../../packages/config/src/index");
  const currentDB = await import("../../../../packages/db/src/index"); db = currentDB.db;
  const { getUsersEvents } = currentDB;
  const { migrateDatabase } = await import("../../../../packages/db/src/migrate");
  const { microsoftAdapter } = await import("../../../../apps/api/src/sync/adapters/microsoft");
  const { syncProvider } = await import("../../../../apps/api/src/sync/engine");
  const baseline = await import(`${baselinePath}/packages/db/src/index.ts`);
  assert.deepEqual(await query("select column_name from information_schema.columns where table_name = 'external_calendars' and column_name = 'source_generation'"), [], "Seed must precede the new schema migration");
  assert.deepEqual(await query("select column_name from information_schema.columns where table_name = 'account' and column_name = 'sync_read_generation'"), []);
  const oldJournal = await query("select id, hash, created_at from drizzle.__drizzle_migrations order by created_at");
  assert.equal(oldJournal.length, 85, "Baseline runtime migrator must have applied exactly 0000–0084");
  const owner = `upgrade-owner-${randomUUID()}`, viewer = `upgrade-viewer-${randomUUID()}`;
  const connectionID = randomUUID(), accountID = `upgrade-account-${randomUUID()}`, googleAccount = `upgrade-google-${randomUUID()}`;
  const googleCalendar = randomUUID(), googleSource = randomUUID(), sharedCalendar = randomUUID();
  const cases = ["plain", "v1"].map(kind => ({ kind, calendarID: randomUUID(), sourceID: randomUUID(), nativeCalendarID: `upgrade-${kind}-${randomUUID()}`, eventID: randomUUID(), nativeEventID: `native-${kind}-${randomUUID()}`, sourceMappingID: randomUUID(), destinationMappingID: randomUUID(), sourceOperationID: randomUUID(), destinationOperationID: randomUUID() }));
  const oldStart = new Date("2024-01-15T09:00:00.000Z"), oldEnd = new Date("2024-01-15T10:00:00.000Z");
  const requests: { kind: "engine" | "native-fixture-probe"; method: string; path: string; query: string }[] = [];
  const beforeFlags = { time: config.api.eventTimeEditsEnabled, rsvp: config.api.providerRsvpEditsEnabled };
  config.api.eventTimeEditsEnabled = config.api.providerRsvpEditsEnabled = false;
  let server: ReturnType<typeof createServer> | undefined;
  const originalFetch = globalThis.fetch;
  let seeded = false;
  let completedEvidence: Record<string, unknown> | undefined;
  const output = resolve(process.env.UPGRADE_EVIDENCE_PATH ?? "docs/planning/evidence/MUSU-34/populated-upgrade.json");
  const snapshot = async () => json({
    accounts: await query("select * from account where user_id = $1 order by id", [owner]),
    calendars: await query("select * from calendars where creator_id = $1 order by id", [owner]),
    sources: await query("select * from external_calendars where user_id = $1 order by id", [owner]),
    events: await query("select * from events where creator_id = $1 order by id", [owner]),
    memberships: await query("select * from calendar_members where calendar_id in (select id from calendars where creator_id = $1) order by calendar_id, user_id", [owner]),
    links: await query("select * from calendar_events where event_id in (select id from events where creator_id = $1) order by calendar_id, event_id", [owner]),
    mappings: await query("select * from external_events where event_id in (select id from events where creator_id = $1) order by id", [owner]),
    outbox: await query("select * from event_outbox where user_id = $1 order by id", [owner]),
    tombstones: await query("select * from external_event_tombstones where external_calendar_link_id in (select id from external_calendars where user_id = $1) order by id", [owner]),
  });
  try {
    // All seed SQL names only columns available in the pinned old schema.
    // Pin the transaction to a dedicated client, never a pool-level BEGIN.
    const client = await db.$client.connect();
    try {
      await client.query("begin");
      await client.query('insert into "user" (id,name,email) values ($1,$2,$3),($4,$5,$6)', [owner, "Synthetic upgrade owner", `${owner}@example.test`, viewer, "Synthetic upgrade viewer", `${viewer}@example.test`]);
      await client.query("insert into account (id,user_id,provider_id,account_id,scope,access_token,refresh_token,access_token_expires_at,updated_at) values ($1,$2,'microsoft',$3,'Calendars.ReadWrite','fixture-only','fixture-only','2035-01-01',clock_timestamp())", [connectionID, owner, accountID]);
      for (const [id, name] of [[googleCalendar, "Synthetic Google target"], [sharedCalendar, "Synthetic shared calendar"], ...cases.map(c => [c.calendarID, `Synthetic ${c.kind} source`])] as [string, string][]) {
        await client.query("insert into calendars (id,name,color,creator_id) values ($1,$2,'red',$3)", [id, name, owner]);
        await client.query("insert into calendar_members (calendar_id,user_id,role) values ($1,$2,'owner'),($1,$3,'viewer')", [id, owner, viewer]);
      }
      await client.query("insert into external_calendars (id,provider,user_id,account_id,account_label,calendar_id,external_calendar_id,provider_access_role,provider_access_revision) values ($1,'google',$2,$3,'Synthetic Google target',$4,'synthetic-google','owner',5)", [googleSource, owner, googleAccount, googleCalendar]);
      for (const c of cases) {
        const link = `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(c.nativeCalendarID)}/calendarView/delta?$deltatoken=old-${c.kind}`;
        const oldCursor = c.kind === "plain" ? link : JSON.stringify({ link, windowEnd: Date.parse("2026-10-20T00:00:00.000Z") });
        await client.query("insert into external_calendars (id,provider,user_id,account_id,account_label,calendar_id,external_calendar_id,cursor,provider_access_role,provider_access_revision) values ($1,'microsoft',$2,$3,'Synthetic Graph account',$4,$5,$6,'microsoft:private=yes;edit=yes',7)", [c.sourceID, owner, accountID, c.calendarID, c.nativeCalendarID, oldCursor]);
        await client.query("insert into events (id,creator_id,origin_calendar_id,name,color,start_at,end_at,is_all_day,description,organizer) values ($1,$2,$3,$4,'red',$5,$6,false,'Synthetic retained notes','')", [c.eventID, owner, c.calendarID, `Old ${c.kind} canonical event`, oldStart, oldEnd]);
        await client.query("insert into calendar_events (event_id,calendar_id) values ($1,$2),($1,$3),($1,$4)", [c.eventID, c.calendarID, googleCalendar, sharedCalendar]);
        await client.query("insert into external_events (id,provider,event_id,calendar_id,external_calendar_id,external_event_id,etag,ical_uid) values ($1,'microsoft',$2,$3,$4,$5,'W/\"old-native\"',$6),($7,'google',$2,$8,'synthetic-google',$9,'\"old-google\"',$6)", [c.sourceMappingID, c.eventID, c.calendarID, c.nativeCalendarID, c.nativeEventID, `synthetic-uid-${c.kind}`, c.destinationMappingID, googleCalendar, `google-copy-${c.kind}`]);
      }
      await client.query("commit"); seeded = true;
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
    for (const c of cases) {
      const event = await baseline.getEventSnapshot(c.eventID);
      for (const [operationID, provider, calendarID, sourceID, nativeAccountID, nativeCalendarID, nativeEventID, status, attempts, uncertain] of [
        [c.sourceOperationID, "microsoft", c.calendarID, c.sourceID, accountID, c.nativeCalendarID, c.nativeEventID, "unconfirmed", 1, true],
        [c.destinationOperationID, "google", googleCalendar, googleSource, googleAccount, "synthetic-google", `google-copy-${c.kind}`, "pending", 0, false],
      ] as [string, string, string, string, string, string, string, string, number, boolean][]) {
        await query("insert into event_outbox (id,actor_id,mutation_id,position,event_id,revision,calendar_id,external_calendar_link_id,provider,user_id,account_id,external_calendar_id,external_event_id,action,payload,status,attempts,uncertain) values ($1,$2,$3,0,$4,1,$5,$6,$7,$2,$8,$9,$10,'update',$11::jsonb,$12,$13,$14)", [operationID, owner, randomUUID(), c.eventID, calendarID, sourceID, provider, nativeAccountID, nativeCalendarID, nativeEventID, JSON.stringify({ event, patch: { title: `Immutable accepted ${provider} intent` }, createIdentityVersion: 1 }), status, attempts, uncertain]);
      }
    }
    const range = { start: new Date("2024-01-01Z"), end: new Date("2024-02-01Z") };
    const delta = { since: new Date(0) };
    const before = await snapshot();
    const beforeWire = { range: sortWire(await baseline.getUsersEvents(owner, range)), delta: sortWire(await baseline.getUsersEvents(owner, delta)) };
    assert.equal(before.events.length, 2); assert.equal(before.mappings.length, 4); assert.equal(before.outbox.length, 4); assert.equal(before.links.length, 6);
    await baseline.db.$client.end();
    // Same populated database, current runtime migrator: actual ALTER TABLE,
    // journal acceptance, account generation trigger and existing rows together.
    await migrateDatabase();
    const afterMigration = await snapshot();
    for (const source of afterMigration.sources) {
      assert.equal(source.source_generation, 0); assert.equal(source.checkpoint_revision, 0);
      assert.equal(source.read_configuration_fingerprint, null); assert.equal(source.read_coverage, null);
    }
    assert.equal(afterMigration.accounts[0].sync_read_generation, 0);
    const legacyShape = (s: typeof afterMigration) => ({ ...s,
      accounts: s.accounts.map(({ sync_read_generation: _generation, ...row }: any) => row),
      sources: s.sources.map(({ source_generation: _source, checkpoint_revision: _checkpoint, read_configuration_fingerprint: _configuration, read_coverage: _coverage, ...row }: any) => row),
    });
    assert.deepEqual(legacyShape(afterMigration), before, "Every pre-existing column, UUID, permission revision, timestamp and intent payload survives real migration unchanged");
    const afterMigrationWire = { range: sortWire(await getUsersEvents(owner, range)), delta: sortWire(await getUsersEvents(owner, delta)) };
    assert.deepEqual(afterMigrationWire, beforeWire, "Old and new range/delta reads have exact wire parity after upgrade");
    server = createServer((req, res) => {
      const url = new URL(req.url!, "http://fixture.test"); requests.push({ kind: req.headers["x-musubi-fixture-probe"] ? "native-fixture-probe" : "engine", method: req.method ?? "", path: url.pathname, query: url.search });
      assert.equal(req.method, "GET", "No delivery worker or provider mutation is permitted");
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/v1.0/me/calendars") return res.end(JSON.stringify({ value: cases.map(c => ({ id: c.nativeCalendarID, name: `Synthetic ${c.kind} source`, canEdit: true, canViewPrivateItems: true })) }));
      const present = cases.find(c => url.pathname === `/v1.0/me/calendars/${encodeURIComponent(c.nativeCalendarID)}/events/${encodeURIComponent(c.nativeEventID)}`);
      if (present) return res.end(JSON.stringify({ id: present.nativeEventID, type: "singleInstance", subject: `Old ${present.kind} canonical event`, iCalUId: `synthetic-uid-${present.kind}`, isAllDay: false, start: { dateTime: oldStart.toISOString(), timeZone: "UTC" }, end: { dateTime: oldEnd.toISOString(), timeZone: "UTC" } }));
      const c = cases.find(value => url.pathname === `/v1.0/me/calendars/${encodeURIComponent(value.nativeCalendarID)}/calendarView/delta`);
      assert.ok(c, "Only scoped Graph discovery/window reads are permitted");
      assert.ok(url.searchParams.has("startDateTime")); assert.ok(url.searchParams.has("endDateTime"));
      assert.ok(Date.parse(url.searchParams.get("startDateTime")!) > oldEnd.getTime(), "Native event remains real but outside the new bounded window");
      return res.end(JSON.stringify({ value: [], "@odata.deltaLink": `https://graph.microsoft.com${url.pathname}?$deltatoken=new-${c.kind}` }));
    });
    await new Promise<void>(done => server!.listen(0, "127.0.0.1", done));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    globalThis.fetch = (input, init) => {
      const url = new URL(String(input)); assert.equal(url.origin, "https://graph.microsoft.com", "No live provider accounts");
      return originalFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
    };
    await syncProvider(microsoftAdapter, owner, { id: accountID, label: "Synthetic Graph account" });
    for (const c of cases) {
      const response = await originalFetch(`http://127.0.0.1:${address.port}/v1.0/me/calendars/${encodeURIComponent(c.nativeCalendarID)}/events/${encodeURIComponent(c.nativeEventID)}`, { headers: { "x-musubi-fixture-probe": "true" } });
      assert.equal(response.status, 200); assert.equal((await response.json()).id, c.nativeEventID, "Fake native event still exists outside renewed view");
    }
    const afterRead = await snapshot();
    for (const key of ["events", "mappings", "links", "memberships", "outbox", "tombstones"] as const) assert.deepEqual(afterRead[key], before[key], `${key} must retain exact old identities/content during first renewed window`);
    for (const c of cases) {
      const source = afterRead.sources.find((row: any) => row.id === c.sourceID)!;
      assert.equal(source.provider_access_revision, 7);
      assert.equal(source.source_generation, 1); assert.equal(source.checkpoint_revision, 2);
      assert.equal(source.read_coverage.kind, "window"); assert.equal(source.read_coverage.complete, true);
      assert.equal(JSON.parse(source.cursor).version, 2);
    }
    const afterReadWire = { range: sortWire(await getUsersEvents(owner, range)), delta: sortWire(await getUsersEvents(owner, delta)) };
    assert.deepEqual(afterReadWire, beforeWire, "Historical event remains available through shared range/delta reads after the first safe window");
    const currentJournal = await query("select id, hash, created_at from drizzle.__drizzle_migrations order by created_at");
    assert.equal(currentJournal.length, oldJournal.length + 1);
    const migrationSHA256 = createHash("sha256").update(await readFile(resolve("packages/db/drizzle/0085_graph_read_coverage.sql"))).digest("hex");
    const stableKeys = ["events", "mappings", "links", "memberships", "outbox", "tombstones"] as const;
    completedEvidence = { kind: "musubi-populated-graph-upgrade", baselineCommit: BASELINE, migration: "0085_graph_read_coverage", migrationSHA256, databaseName: "musubi_c03_upgrade", executedAt: new Date().toISOString(),
      journals: { beforeCount: oldJournal.length, afterCount: currentJournal.length, beforeLast: oldJournal.at(-1), afterLast: currentJournal.at(-1) }, cases,
      // Full historical rows/payloads are preserved once. Independent digest
      // pairs keep redundant post-upgrade copies out of the witness artifact.
      before,
      migrationParity: { beforeLegacyColumnsSHA256: digest(before), afterLegacyColumnsSHA256: digest(legacyShape(afterMigration)), defaults: afterMigration.sources.map((row: any) => ({ id: row.id, sourceGeneration: row.source_generation, checkpointRevision: row.checkpoint_revision, configurationFingerprint: row.read_configuration_fingerprint, coverage: row.read_coverage })), connectionGeneration: afterMigration.accounts[0].sync_read_generation },
      retainedTableParity: Object.fromEntries(stableKeys.map(key => [key, { beforeSHA256: digest(before[key]), afterReadSHA256: digest(afterRead[key]) }])),
      sourceAfterRead: afterRead.sources,
      wireParity: { rangeRows: beforeWire.range.length, deltaRows: beforeWire.delta.length, before: { rangeSHA256: digest(beforeWire.range), deltaSHA256: digest(beforeWire.delta) }, afterMigration: { rangeSHA256: digest(afterMigrationWire.range), deltaSHA256: digest(afterMigrationWire.delta) }, afterRead: { rangeSHA256: digest(afterReadWire.range), deltaSHA256: digest(afterReadWire.delta) } },
      providerRequests: requests, providerMutationRequests: requests.filter(request => request.method !== "GET").length, outboxDeliveryExecutions: 0,
      assertions: { realOldSchemaBeforeSeed: true, realPopulatedMigration: true, oldColumnByteParity: true, newDefaults: true, rangeAndDeltaParity: true, emptyWindowRetention: true, legacyPlainAndV1CursorUpgrade: true, pendingAndUnconfirmedPayloadParity: true },
    };
  } finally {
    globalThis.fetch = originalFetch; config.api.eventTimeEditsEnabled = beforeFlags.time; config.api.providerRsvpEditsEnabled = beforeFlags.rsvp;
    if (server) { server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done())); }
    if (seeded) {
      await query('delete from "user" where id = any($1::text[])', [[owner, viewer]]);
      assert.deepEqual(await query('select id from "user" where id = any($1::text[])', [[owner, viewer]]), []);
      assert.deepEqual(await query("select id from events where creator_id = $1", [owner]), []);
      assert.deepEqual(await query("select id from event_outbox where user_id = $1", [owner]), []);
    }
    await baseline.db.$client.end().catch(() => {});
    dotenv.config = originalDotenvConfig; baselineDotenv.config = originalBaselineDotenvConfig;
    if (completedEvidence) {
      await writeFile(output, JSON.stringify({ ...completedEvidence, fixtureCleanupVerified: true }, null, 2) + "\n");
      console.log(`Populated old-schema upgrade and plain/v1 cursor read parity: OK; evidence ${output}`);
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db?.$client.end());
