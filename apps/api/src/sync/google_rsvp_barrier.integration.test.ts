import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { mock } from "node:test";
import { Client } from "pg";
import { eq, and, sql } from "drizzle-orm";
import { config } from "@musubi/config";
import { db, user, account, events, eventOutbox, externalCalendars, externalEvents, calendarMembers, createCalendar, upsertExternalEvent, getOwnProviderEventObservation, getEventSnapshot, claimEventOutbox, markGoogleRsvpDispatched, requestEventDeliveryRetry, getEventDeliveryStatus } from "@musubi/db";
import { googleRsvpDeliveryPolicy } from "@musubi/types";
import { queueGoogleRsvp } from "./provider_rsvp";
import { googleEventState } from "./adapters/provider_event_state";
import { googleAdapter } from "./adapters/google";
import { deliverEventOutbox } from "./event_delivery";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const runID = `google-rsvp-barrier-${randomUUID()}`;
  db.$client.options.application_name = runID;
  const oldFlag = config.api.providerRsvpEditsEnabled; config.api.providerRsvpEditsEnabled = true;
  let mode: string = "normal", remote: any, baseline: any, patches = 0, requests: string[] = [], failures: string[] = [], readGate: (() => Promise<void>) | undefined;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, "Bearer synthetic-rsvp-access");
      requests.push(req.method!); res.setHeader("Content-Type", "application/json");
      if (req.url === "/calendar/v3/users/me/calendarList/primary") { res.end(JSON.stringify({ id: "guest@example.test", primary: true, accessRole: "owner" })); return; }
      const expected = `/calendar/v3/calendars/guest%40example.test/events/${remote.id}`;
      if (req.method === "GET") { assert.equal(req.url, expected); if (readGate) { const gate = readGate; readGate = undefined; await gate(); } res.end(JSON.stringify(remote)); return; }
      patches++; assert.equal(req.method, "PATCH"); assert.equal(req.url, expected + "?sendUpdates=all&conferenceDataVersion=1"); assert.equal(req.headers["if-match"], baseline.etag);
      let bytes = ""; for await (const part of req) bytes += part;
      assert.deepEqual(JSON.parse(bytes), { attendeesOmitted: true, attendees: [{ email: "guest@example.test", responseStatus: "accepted" }] });
      if (/^raw-/.test(mode)) { res.writeHead(Number(mode.slice(4))); res.end(); return; }
      remote.attendees[0].responseStatus = "accepted"; remote.etag = '"v2"';
      if (mode === "lost") { req.socket.destroy(); return; }
      if (mode === "applied-503") { res.writeHead(503); res.end(); return; }
      if (mode === "delayed") await pause(150);
      res.end(JSON.stringify({ id: remote.id, attendeesOmitted: true }));
    } catch (error) { failures.push(error instanceof Error ? error.message : "Native receipt mismatch"); res.writeHead(500); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string"); const origin = `http://127.0.0.1:${address.port}`;
  const actualFetch = globalThis.fetch;
  globalThis.fetch = (request, init) => { const url = new URL(String(request)); assert.equal(url.origin, "https://www.googleapis.com"); return actualFetch(`${origin}${url.pathname}${url.search}`, init); };
  let cases = 0;
  async function seed() {
    const owner = `${runID}-${randomUUID()}`, accountID = randomUUID();
    baseline = { id: `meeting-${randomUUID()}`, etag: '"v1"', status: "confirmed", summary: "Private source meeting", start: { date: "2026-10-26" }, end: { date: "2026-10-27" }, organizer: { email: "host@example.test" }, attendees: [{ email: "guest@example.test", self: true, responseStatus: "needsAction", comment: "private-comment" }, { email: "other@example.test", responseStatus: "accepted" }], conferenceData: { conferenceId: "keep" }, reminders: { useDefault: true } };
    remote = structuredClone(baseline); mode = "normal"; patches = 0; requests = []; failures = [];
    await db.insert(user).values({ id: owner, name: owner, email: `${randomUUID()}@example.test`, isExternal: true });
    await db.insert(account).values({ id: randomUUID(), userId: owner, providerId: "google", accountId: accountID, scope: "https://www.googleapis.com/auth/calendar.events", accessToken: "synthetic-rsvp-access", refreshToken: "synthetic-rsvp-refresh", accessTokenExpiresAt: new Date(Date.now() + 3600000) });
    const calendar = await createCalendar({ creatorID: owner, name: "Google RSVP gate", color: "red" });
    const [source] = await db.insert(externalCalendars).values({ provider: "google", userID: owner, accountID, calendarID: calendar.id, externalCalendarID: "guest@example.test", providerAccessRole: "owner" }).returning();
    await upsertExternalEvent("google", owner, calendar.id, source!.externalCalendarID, remote.id, { title: remote.summary, color: "red", start: new Date("2026-10-26T00:00:00Z"), end: new Date("2026-10-26T00:00:00Z"), isAllDay: true, description: null, location: null, organizer: remote.organizer.email, recurrence: null, url: null }, remote.etag, null, undefined, undefined, undefined, googleEventState(remote));
    const [mapping] = await db.select().from(externalEvents).where(eq(externalEvents.calendarID, calendar.id));
    const original = (await getEventSnapshot(mapping!.eventID))!, observation = await getOwnProviderEventObservation(owner, original.id);
    const receipt = await queueGoogleRsvp(owner, original.id, { provider: "google", operationID: randomUUID(), expectedRevision: original.revision, expectedStateVersion: observation.version, response: "accepted", sendUpdates: "all" });
    const row = async () => (await db.select().from(eventOutbox).where(eq(eventOutbox.id, receipt.operationID)))[0]!;
    const retry = async () => { await requestEventDeliveryRetry(owner, original.id, receipt.operationID); await db.update(eventOutbox).set({ nextAttemptAt: new Date(0), leaseUntil: new Date(0) }).where(eq(eventOutbox.id, receipt.operationID)); };
    requests = [];
    return { owner, accountID, calendar, source: source!, mapping: mapping!, original, id: receipt.operationID, row, retry };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  async function fixture(label: string, body: (f: Fixture) => Promise<void>) {
    const f = await seed();
    try { await body(f); assert.deepEqual(failures, []); cases++; console.log(`Google RSVP barrier: ${label}: PASS`); }
    finally { readGate = undefined; await db.delete(eventOutbox).where(eq(eventOutbox.userID, f.owner)); await db.delete(user).where(eq(user.id, f.owner)); }
  }
  async function lockWait(blockerID: number) {
    for (let count = 0; count < 300; count++) {
      const value = await db.$client.query("select 1 from pg_stat_activity where application_name=$1 and pid<>$2 and wait_event_type='Lock'", [runID, blockerID]);
      if (value.rows.length) return;
      await pause(10);
    }
    throw new Error("Google RSVP marker did not reach a real PostgreSQL lock wait");
  }
  const child = (operationId: string, at?: string) => {
    const proc = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./google_rsvp_process.fixture.ts", import.meta.url))], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
    let output = "", stderr = "", entered!: () => void, rejectEntered!: (reason: Error) => void;
    const checkpoint = new Promise<void>((resolve, reject) => { entered = resolve; rejectEntered = reject; }); void checkpoint.catch(() => undefined);
    proc.stdout.on("data", bytes => { output += String(bytes); if (output.includes('"kind":"checkpoint"')) entered(); });
    proc.stderr.on("data", bytes => { stderr = (stderr + String(bytes)).slice(-4000); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string; stderr: string }>((resolve, reject) => {
      proc.once("error", error => { clearTimeout(timer); rejectEntered(error); reject(error); });
      proc.once("close", (code, signal) => { clearTimeout(timer); rejectEntered(new Error("Worker exited before checkpoint: " + stderr)); resolve({ code, signal, output, stderr }); });
    });
    proc.stdin.end(JSON.stringify({ operationId, fixtureOrigin: origin, pause: at }));
    return { proc, checkpoint, exited };
  };
  try {
    for (const status of [429, 408, 400, 401, 403, 404, 409, 412, 500, 503]) await fixture(`raw ${status} and manual retry never resend`, async f => {
      mode = `raw-${status}`;
      const first = await deliverEventOutbox(f.id, () => googleAdapter); assert.equal(patches, 1); assert.equal(first!.uncertain, true);
      const started = (await f.row()).payload.rsvp!.googleDelivery!.startedAt; assert(started);
      await f.retry(); mode = "normal";
      const second = await deliverEventOutbox(f.id, () => googleAdapter); assert.equal(second!.status, "unconfirmed"); assert.equal(patches, 1); assert.equal((await f.row()).payload.rsvp!.googleDelivery!.startedAt, started);
      remote.attendees[0].responseStatus = "accepted"; remote.etag = '"v2"'; await f.retry();
      assert.equal((await deliverEventOutbox(f.id, () => googleAdapter))!.status, status === 412 ? "conflict" : "completed"); assert.equal(patches, 1);
      // A retained 412 snapshot is host authority; native observation cannot
      // erase a differing pulled version merely because its clock is newer.
      const publicState = JSON.stringify(await getEventDeliveryStatus(f.owner, f.original.id)); assert(!publicState.includes("private-comment")); assert(!publicState.includes(started));
      assert.deepEqual(await getEventSnapshot(f.original.id), f.original);
    });
    for (const value of ["lost", "applied-503", "delayed"]) await fixture(`${value} only observes after possible dispatch`, async f => {
      mode = value; const first = await deliverEventOutbox(f.id, () => googleAdapter); assert.equal(patches, 1);
      if (value === "delayed") assert.equal(first!.status, "completed");
      else { assert.equal(first!.status, "unconfirmed"); await f.retry(); mode = "normal"; assert.equal((await deliverEventOutbox(f.id, () => googleAdapter))!.status, "completed"); }
      assert.equal(patches, 1);
    });
    for (const legacy of ["pending", "retried", "uncertain"]) await fixture(`legacy markerless ${legacy} holds until desired observation`, async f => {
      const row = await f.row(); const { googleDelivery: _old, ...intent } = row.payload.rsvp!;
      await db.update(eventOutbox).set({ payload: { ...row.payload, rsvp: intent }, ...(legacy === "retried" ? { attempts: 1, status: "retry" as const } : legacy === "uncertain" ? { attempts: 1, status: "unconfirmed" as const, uncertain: true } : {}) }).where(eq(eventOutbox.id, f.id));
      assert.equal((await deliverEventOutbox(f.id, () => googleAdapter))!.status, "unconfirmed"); assert.equal(patches, 0);
      await f.retry(); remote.attendees[0].responseStatus = "accepted"; remote.etag = '"v2"';
      assert.equal((await deliverEventOutbox(f.id, () => googleAdapter))!.status, "completed"); assert.equal(patches, 0);
    });
    for (const malformed of [null, {}, { kind: "wrong", version: 1 }, { kind: "google-rsvp-at-most-once", version: 2 }, { kind: "google-rsvp-at-most-once", version: 1, startedAt: "invalid" }, { kind: "google-rsvp-at-most-once", version: 1, acceptedAt: "2026-10-26T12:00:00.000Z" }]) await fixture("invalid persisted policy fails before native credentials", async f => {
      const row = await f.row();
      await db.update(eventOutbox).set({ payload: { ...row.payload, rsvp: { ...row.payload.rsvp!, googleDelivery: malformed as any } } }).where(eq(eventOutbox.id, f.id));
      let nativeCalls = 0;
      const adapter = { ...googleAdapter, async writeRsvp(...args: Parameters<NonNullable<typeof googleAdapter.writeRsvp>>) { nativeCalls++; return googleAdapter.writeRsvp!(...args); } };
      assert.equal((await deliverEventOutbox(f.id, () => adapter))!.status, "blocked"); assert.equal(nativeCalls, 0); assert.deepEqual(requests, []); assert.equal(patches, 0);
    });
    await fixture("new typed unstarted survives pre-send OAuth retry", async f => {
      await db.update(account).set({ scope: "openid email" }).where(and(eq(account.userId, f.owner), eq(account.accountId, f.accountID)));
      assert.equal((await deliverEventOutbox(f.id, () => googleAdapter))!.status, "blocked"); assert.equal(patches, 0); assert.equal(googleRsvpDeliveryPolicy((await f.row()).payload.rsvp).observeOnly, false);
      await db.update(account).set({ scope: "https://www.googleapis.com/auth/calendar.events" }).where(and(eq(account.userId, f.owner), eq(account.accountId, f.accountID))); await f.retry();
      assert.equal((await deliverEventOutbox(f.id, () => googleAdapter))!.status, "completed"); assert.equal(patches, 1);
    });
    for (const change of ["payload", "actorID", "mutationID", "position", "expectedEtag", "externalEventID", "calendarID", "predecessorID", "personalReadRecovery", "leaseToken", "attempts", "status"]) await fixture(`original claim rejects substituted ${change}`, async f => {
      const claimed = (await claimEventOutbox(f.id))!;
      const altered = structuredClone(claimed) as any;
      if (change === "payload") altered.payload.rsvp.baseline.summary = "Substituted caller native baseline";
      else if (change === "position" || change === "attempts") altered[change]++;
      else if (change === "personalReadRecovery") altered.personalReadRecovery = { substituted: true };
      else altered[change] = randomUUID();
      assert.equal(await markGoogleRsvpDispatched(altered), false); assert.equal((await f.row()).payload.rsvp!.googleDelivery!.startedAt, undefined); assert.equal(patches, 0);
    });
    await fixture("conclusive fresh marker refusal records no possible send", async f => {
      readGate = async () => { await db.update(calendarMembers).set({ role: "viewer" }).where(and(eq(calendarMembers.calendarID, f.calendar.id), eq(calendarMembers.userID, f.owner))); };
      const result = await deliverEventOutbox(f.id, () => googleAdapter);
      assert.equal(result!.status, "conflict"); assert.equal(result!.uncertain, false); assert.equal(patches, 0);
      assert.equal((await f.row()).payload.rsvp!.googleDelivery!.startedAt, undefined);
    });
    for (const boundary of ["source-role", "member-role", "scope", "grant-status", "event-revision", "mapping-etag", "privacy-redaction", "deleted"]) await fixture(`locked authority rejects ${boundary}`, async f => {
      const claimed = (await claimEventOutbox(f.id))!;
      if (boundary === "source-role") await db.update(externalCalendars).set({ providerAccessRole: "reader" }).where(eq(externalCalendars.id, f.source.id));
      if (boundary === "member-role") await db.update(calendarMembers).set({ role: "viewer" }).where(and(eq(calendarMembers.calendarID, f.calendar.id), eq(calendarMembers.userID, f.owner)));
      if (boundary === "scope") await db.update(account).set({ scope: "openid email" }).where(and(eq(account.userId, f.owner), eq(account.accountId, f.accountID)));
      if (boundary === "grant-status") await db.update(account).set({ syncStatus: "paused" }).where(and(eq(account.userId, f.owner), eq(account.accountId, f.accountID)));
      if (boundary === "event-revision" || boundary === "privacy-redaction") await db.update(events).set({ revision: f.original.revision + 1, ...(boundary === "privacy-redaction" ? { title: "Busy" } : {}) }).where(eq(events.id, f.original.id));
      if (boundary === "mapping-etag") await db.update(externalEvents).set({ etag: '"changed"' }).where(eq(externalEvents.id, f.mapping.id));
      if (boundary === "deleted") await db.update(events).set({ deletedAt: new Date() }).where(eq(events.id, f.original.id));
      assert.equal(await markGoogleRsvpDispatched(claimed), false); assert.equal((await f.row()).payload.rsvp!.googleDelivery!.startedAt, undefined);
    });
    for (const lock of ["event", "outbox", "member", "grant"]) await fixture(`abort during real ${lock} lock wait rolls marker back`, async f => {
      const claimed = (await claimEventOutbox(f.id))!, controller = new AbortController(), blocker = await db.$client.connect();
      let pending: Promise<boolean> | undefined;
      try {
        await blocker.query("BEGIN");
        const table = { event: "events", outbox: "event_outbox", member: "calendar_members", grant: "account" }[lock]!;
        const column = lock === "member" ? "calendar_id" : lock === "grant" ? "user_id" : "id";
        const id = lock === "event" ? f.original.id : lock === "outbox" ? f.id : lock === "member" ? f.calendar.id : f.owner;
        await blocker.query(`select 1 from ${table} where ${column}=$1 for update`, [id]);
        pending = markGoogleRsvpDispatched(claimed, controller.signal); const rejected = assert.rejects(pending);
        await lockWait((await blocker.query("select pg_backend_pid() as id")).rows[0].id); controller.abort(); await blocker.query("COMMIT"); await rejected;
        assert.equal((await f.row()).payload.rsvp!.googleDelivery!.startedAt, undefined); assert.equal(patches, 0);
      } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending?.catch(() => undefined); }
    });
    await fixture("lease expiring during real lock wait uses database clock", async f => {
      await db.update(eventOutbox).set({ leaseUntil: new Date() }).where(eq(eventOutbox.id, f.id));
      const claimed = (await claimEventOutbox(f.id))!, blocker = await db.$client.connect();
      await db.update(eventOutbox).set({ leaseUntil: new Date(Date.now() + 100) }).where(eq(eventOutbox.id, f.id));
      let pending: Promise<boolean> | undefined;
      try { await blocker.query("BEGIN"); await blocker.query("select 1 from events where id=$1 for update", [f.original.id]); pending = markGoogleRsvpDispatched(claimed); await lockWait((await blocker.query("select pg_backend_pid() as id")).rows[0].id); await pause(150); await blocker.query("COMMIT"); assert.equal(await pending, false); assert.equal((await f.row()).payload.rsvp!.googleDelivery!.startedAt, undefined); }
      finally { await blocker.query("ROLLBACK"); blocker.release(); await pending?.catch(() => undefined); }
    });
    await fixture("immutable snapshot precedes blocked first query", async f => {
      const claimed = (await claimEventOutbox(f.id))!, originalPayload = structuredClone(claimed.payload), blocker = await db.$client.connect();
      let pending: Promise<boolean> | undefined;
      try { await blocker.query("BEGIN"); await blocker.query("select 1 from events where id=$1 for update", [f.original.id]); pending = markGoogleRsvpDispatched(claimed); await lockWait((await blocker.query("select pg_backend_pid() as id")).rows[0].id); claimed.payload.rsvp!.baseline.summary = "Late caller mutation"; await blocker.query("COMMIT"); assert.equal(await pending, true); assert.deepEqual((await f.row()).payload.rsvp!.baseline, originalPayload.rsvp!.baseline); assert((await f.row()).payload.rsvp!.googleDelivery!.startedAt); }
      finally { await blocker.query("ROLLBACK"); blocker.release(); await pending?.catch(() => undefined); }
    });
    await fixture("locked refetch cannot bless a substituted durable intent", async f => {
      const claimed = (await claimEventOutbox(f.id))!, blocker = await db.$client.connect();
      let pending: Promise<boolean> | undefined;
      try {
        await blocker.query("BEGIN"); await blocker.query("select 1 from events where id=$1 for update", [f.original.id]);
        pending = markGoogleRsvpDispatched(claimed); await lockWait((await blocker.query("select pg_backend_pid() as id")).rows[0].id);
        const replacement = structuredClone(claimed.payload); replacement.rsvp!.baseline.summary = "Changed durable intent while waiting";
        await db.update(eventOutbox).set({ payload: replacement }).where(eq(eventOutbox.id, f.id));
        await blocker.query("COMMIT"); assert.equal(await pending, false); assert.equal((await f.row()).payload.rsvp!.googleDelivery!.startedAt, undefined); assert.equal(patches, 0);
      } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending?.catch(() => undefined); }
    });
    for (const markerReply of ["cancelled", "lost"]) await fixture(`marker committed before ${markerReply} reply never PATCHes`, async f => {
      const deadlineMs = 173_431; let expire!: () => void, committed!: () => void, release!: () => void;
      const didCommit = new Promise<void>(resolve => { committed = resolve; }), reply = new Promise<void>(resolve => { release = resolve; });
      const realTimer = globalThis.setTimeout, timer = mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => { if (delay === deadlineMs) { expire = () => callback(...args); return realTimer(callback, 30_000, ...args); } return realTimer(callback, delay, ...args); });
      const pending = new WeakSet<Client>(), originalQuery = Client.prototype.query;
      const query = mock.method(Client.prototype, "query", function (this: Client, ...args: any[]): any {
        const text = typeof args[0] === "string" ? args[0] : args[0]?.text, values = args[0]?.values ?? args[1];
        if (typeof text === "string" && /^update "event_outbox"/i.test(text) && Array.isArray(values) && values.includes(f.id) && values.some(value => typeof value === "string" && value.includes('"google-rsvp-at-most-once"') && value.includes('"startedAt"'))) pending.add(this);
        const actual = Reflect.apply(originalQuery, this, args);
        if (typeof text === "string" && text.trim().toLowerCase() === "commit" && pending.has(this)) { pending.delete(this); return Promise.resolve(actual).then(async value => { committed(); if (markerReply === "lost") throw new Error("Synthetic lost COMMIT acknowledgement"); await reply; return value; }); }
        return actual;
      });
      let delivery: ReturnType<typeof deliverEventOutbox> | undefined;
      try { delivery = deliverEventOutbox(f.id, () => googleAdapter, { timeoutMs: deadlineMs }); await Promise.race([didCommit, pause(10_000, undefined, { ref: false }).then(() => { throw new Error("Actual marker COMMIT was not observed"); })]); assert((await f.row()).payload.rsvp!.googleDelivery!.startedAt); if (markerReply === "cancelled") expire(); const result = await delivery; assert.equal(result!.uncertain, true); assert.equal(result!.status, "unconfirmed"); assert.equal(patches, 0); release(); await pause(30); assert.equal(patches, 0); await f.retry(); assert.equal((await deliverEventOutbox(f.id, () => googleAdapter))!.status, "unconfirmed"); assert.equal(patches, 0); }
      finally { release(); query.mock.restore(); timer.mock.restore(); await delivery?.catch(() => undefined); }
    });
    for (const phase of ["before-marker", "after-marker", "raw-response", "readback", "ack-commit"]) await fixture(`SIGKILL ${phase} preserves one irreversible send permission`, async f => {
      const worker = child(f.id, phase); try { await worker.checkpoint; } finally { worker.proc.kill("SIGKILL"); }
      assert.equal((await worker.exited).signal, "SIGKILL");
      const stopped = await f.row(); assert.equal(patches, ["before-marker", "after-marker"].includes(phase) ? 0 : 1);
      assert.equal(!!stopped.payload.rsvp!.googleDelivery!.startedAt, phase !== "before-marker");
      if (phase === "ack-commit") assert.equal(stopped.status, "completed");
      else await db.update(eventOutbox).set({ leaseUntil: new Date(0), nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, f.id));
      const restart = await child(f.id).exited; assert.equal(restart.code, 0, restart.stderr);
      assert.equal((await f.row()).status, phase === "after-marker" ? "unconfirmed" : "completed");
      assert.equal(patches, phase === "after-marker" ? 0 : 1);
      if (phase === "after-marker") { await f.retry(); assert.equal((await deliverEventOutbox(f.id, () => googleAdapter))!.status, "unconfirmed"); assert.equal(patches, 0); }
    });
    console.log(`Google RSVP barrier actual PostgreSQL/native/process: ${cases} cases passed; notification delivery remains unknown.`);
    const remaining = await db.$client.query("select 1 from \"user\" where id like $1", [runID + "%"]); assert.equal(remaining.rows.length, 0);
  } finally { await db.delete(eventOutbox).where(sql`${eventOutbox.userID} like ${runID + "%"}`); await db.delete(user).where(sql`${user.id} like ${runID + "%"}`); config.api.providerRsvpEditsEnabled = oldFlag; globalThis.fetch = actualFetch; await new Promise<void>(resolve => server.close(() => resolve())); await db.$client.end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
