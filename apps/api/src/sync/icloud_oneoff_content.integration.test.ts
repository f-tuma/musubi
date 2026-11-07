import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

// iCloud legacy-unknown-time one-off content update through the production
// handler, inline delivery, actual adapter, guarded transport and pinned leaf,
// and real PostgreSQL. Replaced boundaries: DNS lookup and globalThis.fetch at
// the pinned leaf (a synthetic in-memory iCloud-shaped DAV fixture), and the
// authenticated request user (synthetic Express req/res). No real provider.
async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  assert.ok(process.env.DATABASE_URL, "An explicit disposable test database is required");
  const originalLookup = dns.lookup, originalFetch = globalThis.fetch;
  dns.lookup = (async (hostname: string) => {
    assert.equal(hostname, "p123-caldav.icloud.com", "Synthetic iCloud-shaped host only");
    return [{ address: "93.184.216.34", family: 4 }];
  }) as unknown as typeof dns.lookup;

  type Remote = { data: string; etag: string | null };
  type Override = { method: string; url: string; skip: number; reply: (init: RequestInit) => Response | Promise<Response> };
  const remote = new Map<string, Remote>(), collectionAcl = new Map<string, string>(), requests: { method: string; url: string; ifMatch: string | null; body?: string }[] = [];
  let overrides: Override[] = [], rewriteOnPut: ((body: string) => string) | undefined, etagCounter = 1;
  const multistatus = (url: string, inner: string, code: string) => new Response(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${new URL(url).pathname}</d:href><d:propstat><d:prop>${inner}</d:prop><d:status>HTTP/1.1 ${code}</d:status></d:propstat></d:response></d:multistatus>`, { status: 207, headers: { "content-type": "application/xml" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input), method = init.method ?? "GET", headers = new Headers(init.headers);
    assert.ok(url.startsWith("https://p123-caldav.icloud.com/"), "No real provider request");
    assert.ok((init as { dispatcher?: unknown }).dispatcher, "Production pinned leaf");
    requests.push({ method, url, ifMatch: headers.get("if-match"), ...(typeof init.body === "string" ? { body: init.body } : {}) });
    const index = overrides.findIndex(item => item.method === method && item.url === url);
    if (index >= 0) {
      const item = overrides[index]!;
      if (item.skip > 0) item.skip--;
      else { overrides.splice(index, 1); return item.reply(init); }
    }
    if (method === "PROPFIND") {
      const acl = collectionAcl.get(url);
      if (acl === undefined) return multistatus(url, "<d:current-user-privilege-set/>", "404 Not Found"); // iCloud event resources
      if (acl === "missing") return multistatus(url, "<d:current-user-privilege-set/>", "404 Not Found");
      const names = acl === "read-only" ? ["read"] : ["read", "bind", "unbind"];
      return multistatus(url, `<d:current-user-privilege-set>${names.map(name => `<d:privilege><d:${name}/></d:privilege>`).join("")}</d:current-user-privilege-set>`, "200 OK");
    }
    const resource = remote.get(url);
    if (method === "GET") return resource ? new Response(resource.data, { status: 200, headers: { "content-type": "text/calendar", ...(resource.etag ? { etag: resource.etag } : {}) } }) : new Response(null, { status: 404 });
    assert.equal(method, "PUT", "Only PROPFIND, GET and conditional PUT");
    if (!resource || headers.get("if-match") !== resource.etag) return new Response(null, { status: 412 });
    resource.data = rewriteOnPut ? rewriteOnPut(String(init.body)) : String(init.body);
    resource.etag = `"v${++etagCounter}"`;
    return new Response(null, { status: 204 }); // iCloud PUT ETag is unobserved; never adopted anyway
  }) as typeof fetch;

  const { config } = await import("@musubi/config");
  const { db, user, events, calendarMembers, externalEvents, externalCalendars, eventOutbox, saveCaldavAccount, importExternalCalendar, createCalendar, createEvent, disableExternalCalendar } = await import("@musubi/db");
  const { EventSchema } = await import("@musubi/types");
  const { encryptSecret } = await import("./crypto");
  const { caldavAdapter } = await import("./adapters/caldav");
  const { deliverEventOutbox } = await import("./event_delivery");
  const { handlerUpdateEvent, handlerEventScope, handlerEditEventTime } = await import("../handlers/events");
  const { middlewareErrorHandler } = await import("../middleware/error_handler");
  const priorIcloud = config.api.icloudPersonalContentWritesEnabled, priorTime = config.api.eventTimeEditsEnabled;
  assert.equal(priorIcloud, false, "iCloud personal content writes default off");
  assert.equal(priorTime, false, "Explicit time edits default off");
  const owner = `icloud-oneoff-test-${randomUUID()}`;
  const ics = (summary: string, extra: string[] = []) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//fixture//EN", "BEGIN:VEVENT", "UID:fixture-uid", "DTSTAMP:20261106T224400Z",
    "DTSTART:20261130T210000Z", "DTEND:20261130T220000Z", `SUMMARY:${summary}`, "X-PRIVATE:keep", ...extra, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
  let fixtures = 0;
  async function fixture(kind: "mirror" | "origin") {
    const tag = `case-${++fixtures}`;
    const account = await saveCaldavAccount(owner, "https://caldav.icloud.com/", `fixture-${tag}`, encryptSecret("fixture"));
    const collection = `https://p123-caldav.icloud.com/123/calendars/${tag}/`, resource = collection + "fixture.ics";
    const icloud = await importExternalCalendar("caldav", owner, account.id, "Fixture", { externalId: collection, name: "Fixture", color: "#112233", supportsEvents: true });
    const local = kind === "mirror" ? await createCalendar({ creatorID: owner, name: "Local", color: "#112233" }) : null;
    const event = EventSchema.parse({ id: randomUUID(), creatorID: owner, organizer: owner, title: "Before", color: "#112233", description: null, location: null, recurrence: null,
      calendars: local ? [local.id, icloud.id] : [icloud.id], originCalendarID: local ? local.id : icloud.id,
      start: "2026-11-30T21:00:00.000Z", end: "2026-11-30T22:00:00.000Z", isAllDay: false, isCanceled: false });
    await createEvent(event, event.calendars, []);
    await db.insert(externalEvents).values({ provider: "caldav", eventID: event.id, calendarID: icloud.id, externalCalendarID: collection, externalEventID: resource, etag: '"v1"', icalUid: "fixture-uid" });
    remote.set(resource, { data: ics("Before"), etag: '"v1"' });
    collectionAcl.set(collection, "writable");
    return { account, collection, resource, icloud, local, event };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const call = async (handler: (req: never, res: never) => Promise<unknown>, body: unknown, params: Record<string, string> = {}) => {
    const req = { body, params, query: {}, user: { id: owner }, get: () => undefined, requestId: "fixture-request", method: "PATCH", route: { path: "/fixture" } };
    const out = { status: 200, body: undefined as any };
    const res = { status(code: number) { out.status = code; return res; }, json(value: unknown) { out.body = value; return res; }, setHeader() { return res; } };
    try { await handler(req as never, res as never); } catch (error) { middlewareErrorHandler(error as Error, req as never, res as never, () => undefined); }
    return out;
  };
  const revision = async (f: Fixture) => (await db.select().from(events).where(eq(events.id, f.event.id)))[0]!.revision;
  const patchTitle = async (f: Fixture, title: string) => call(handlerUpdateEvent, { id: f.event.id, expectedRevision: await revision(f), patch: { title } });
  const rows = (f: Fixture) => db.select().from(eventOutbox).where(eq(eventOutbox.eventID, f.event.id));
  const mappingEtag = async (f: Fixture) => (await db.select().from(externalEvents).where(and(eq(externalEvents.eventID, f.event.id), eq(externalEvents.calendarID, f.icloud.id))))[0]?.etag;
  const due = async (id: string) => { await db.update(eventOutbox).set({ nextAttemptAt: new Date(Date.now() - 1_000) }).where(eq(eventOutbox.id, id)); return deliverEventOutbox(id, () => caldavAdapter); };
  const since = (start: number) => requests.slice(start).map(item => `${item.method} ${new URL(item.url).pathname.split("/").pop() || "collection"}`);
  const reset = () => { overrides = []; rewriteOnPut = undefined; };
  const flags = (icloud: boolean, time = false) => { config.api.icloudPersonalContentWritesEnabled = icloud; config.api.eventTimeEditsEnabled = time; };
  const ELIGIBLE = ["PROPFIND fixture.ics", "PROPFIND collection", "GET fixture.ics"];
  const unconfirmedBody = (body: any) => { assert.equal(body.code, "event-delivery-unconfirmed"); assert.equal(body.localCommitted, true); assert.equal(body.delivery.status, "unconfirmed"); };
  await db.insert(user).values({ id: owner, name: "Fixture", email: `${owner}@example.test` });
  let checks = 0;
  try {
    // 1. Production default (ICLOUD=false, TIME=false): refused before commit exactly as in 0.2.18.
    {
      flags(false); const f = await fixture("mirror"), start = requests.length, before = await revision(f);
      const response = await patchTitle(f, "After");
      assert.equal(response.status, 403); assert.equal(response.body.capability, "event-write"); assert.equal(response.body.reason, "unknown"); assert.equal("localCommitted" in response.body, false);
      assert.deepEqual(since(start), ["PROPFIND fixture.ics"], "One resource PROPFIND, no GET or PUT");
      assert.equal((await rows(f)).length, 0); assert.equal(await revision(f), before); checks++;
    }
    flags(true, false);
    // 2. ICLOUD=true, TIME=false happy paths: mirror of a local-origin event and an origin iCloud one-off.
    for (const kind of ["mirror", "origin"] as const) {
      const f = await fixture(kind), start = requests.length;
      const response = await patchTitle(f, "After");
      assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.title, "After");
      assert.deepEqual(since(start), [...ELIGIBLE, ...ELIGIBLE, "GET fixture.ics", "PUT fixture.ics", "GET fixture.ics"], "Handler preflight, worker re-derivation, GET+conditional PUT+readback");
      const put = requests.slice(start).find(item => item.method === "PUT")!;
      assert.equal(put.ifMatch, '"v1"'); assert.match(put.body!, /SUMMARY:After/); assert.match(put.body!, /X-PRIVATE:keep/); assert.doesNotMatch(put.body!, /ORGANIZER|ATTENDEE/);
      const [row] = await rows(f); assert.equal(row!.status, "completed"); assert.equal(row!.attempts, 1); assert.equal(row!.uncertain, false);
      assert.equal(await mappingEtag(f), remote.get(f.resource)!.etag, "Mapping adopts the strong readback ETag"); assert.notEqual(await mappingEtag(f), '"v1"'); checks++;
    }
    // 3. TIME-gated routes stay gated: scope endpoint, explicit time edit and series delivery.
    {
      const f = await fixture("origin"), start = requests.length;
      const scope = await call(handlerEventScope, { operationID: randomUUID(), scope: "series", action: "update", expectedRevision: await revision(f), patch: { title: "Scope" } }, { eventId: f.event.id });
      assert.equal(scope.status, 403); assert.equal(scope.body.reason, "unsupported");
      const time = await call(handlerEditEventTime, { expectedRevision: await revision(f), time: { kind: "floating", start: "2026-11-30T21:00:00", end: "2026-11-30T22:00:00" } }, { eventId: f.event.id });
      assert.equal(time.status, 403); assert.equal(time.body.reason, "unsupported");
      const intent = { ref: { externalEventId: f.resource, etag: '"v1"', icalUid: "fixture-uid" }, master: f.event, children: [] };
      await assert.rejects(() => caldavAdapter.readCaldavSeries!(owner, f.account.id, f.collection, intent as never, undefined, { patch: { title: "Series" } } as never), (error: any) => error.reason === "unsupported");
      assert.deepEqual(since(start), [], "Time gates refuse before any provider request"); assert.equal((await rows(f)).length, 0); checks++;
    }
    // 4. Fresh collection and role refusals happen before commit (403, no outbox).
    for (const [label, setup, reason] of [
      ["collection read-only", (f: Fixture) => { collectionAcl.set(f.collection, "read-only"); }, "denied"],
      ["collection missing", (f: Fixture) => { collectionAcl.set(f.collection, "missing"); }, "unknown"],
      ["link owner viewer role", async (f: Fixture) => { await db.update(calendarMembers).set({ role: "viewer" }).where(and(eq(calendarMembers.calendarID, f.icloud.id), eq(calendarMembers.userID, owner))); }, "denied"],
      ["redirect on handler resource PROPFIND", (f: Fixture) => { overrides.push({ method: "PROPFIND", url: f.resource, skip: 0, reply: () => new Response(null, { status: 301, headers: { location: f.collection + "moved.ics" } }) }); }, "unknown"],
    ] as const) {
      const f = await fixture("mirror"); await setup(f); const before = await revision(f);
      const response = await patchTitle(f, "After");
      assert.equal(response.status, 403, label); assert.equal(response.body.reason, reason, label); assert.equal("localCommitted" in response.body, false, label);
      assert.equal((await rows(f)).length, 0, label); assert.equal(await revision(f), before, label); assert.equal(requests.filter(item => item.method === "PUT" && item.url === f.resource).length, 0); reset(); checks++;
    }
    // 5. ETag changed before handler preflight: 409, nothing committed.
    {
      const f = await fixture("origin"); remote.get(f.resource)!.etag = '"v-concurrent"';
      const response = await patchTitle(f, "After");
      assert.equal(response.status, 409); assert.equal(response.body.code, "provider-conflict"); assert.equal(response.body.localCommitted, false);
      assert.equal((await rows(f)).length, 0); checks++;
    }
    // 6. Post-commit phase-aware outcomes of the inline worker attempt.
    {
      const f = await fixture("mirror"); overrides.push({ method: "PUT", url: f.resource, skip: 0, reply: () => new Response(null, { status: 403 }) });
      const response = await patchTitle(f, "After");
      assert.equal(response.status, 502); unconfirmedBody(response.body);
      const [row] = await rows(f); assert.equal(row!.status, "blocked"); assert.equal(row!.errorCode, "provider-write-failed"); assert.equal(row!.uncertain, false);
      assert.equal(await mappingEtag(f), '"v1"'); assert.equal(remote.get(f.resource)!.data, ics("Before")); reset(); checks++;
    }
    {
      const f = await fixture("mirror"); overrides.push({ method: "PUT", url: f.resource, skip: 0, reply: () => new Response(null, { status: 412 }) });
      const response = await patchTitle(f, "After");
      assert.equal(response.status, 409); assert.equal(response.body.code, "provider-conflict"); assert.equal(response.body.localCommitted, true); assert.equal(response.body.delivery.status, "conflict");
      const [row] = await rows(f); assert.equal(row!.status, "conflict"); assert.equal(await mappingEtag(f), '"v1"'); reset(); checks++;
    }
    // 7. Accepted PUT whose readback differs (server byte rewrite): unconfirmed,
    // then reconciliation by read only; no blind duplicate PUT.
    {
      const f = await fixture("mirror"); rewriteOnPut = body => body.replace("X-PRIVATE:keep", "X-PRIVATE:keep\r\nX-SERVER-REWRITE:1");
      const response = await patchTitle(f, "After"); rewriteOnPut = undefined;
      assert.equal(response.status, 502); unconfirmedBody(response.body);
      let [row] = await rows(f); assert.equal(row!.status, "unconfirmed"); assert.equal(row!.errorCode, "provider-write-failed"); assert.equal(row!.uncertain, true); assert.equal(await mappingEtag(f), '"v1"');
      // (c) Desired content without a strong ETag is never ACKed (seam).
      const desired = remote.get(f.resource)!, strong = desired.etag;
      for (const etag of [null, `W/${strong}`]) {
        desired.etag = etag; let start = requests.length;
        await due(row!.id); [row] = await rows(f);
        assert.equal(row!.status, "unconfirmed"); assert.equal(row!.uncertain, true); assert.deepEqual(since(start), ["GET fixture.ics"]); assert.equal(await mappingEtag(f), '"v1"');
        start = requests.length;
      }
      desired.etag = strong;
      // (a) Desired projection with a strong ETag completes with 0 PUT and ACKs the observation.
      const start = requests.length; await due(row!.id); [row] = await rows(f);
      assert.equal(row!.status, "completed"); assert.deepEqual(since(start), ["GET fixture.ics"]); assert.equal(await mappingEtag(f), strong); checks++;
    }
    {
      // (b) Changed content and validator after an unconfirmed write: conflict, 0 PUT.
      const f = await fixture("origin"); rewriteOnPut = body => body.replace("X-PRIVATE:keep", "X-PRIVATE:keep\r\nX-SERVER-REWRITE:1");
      assert.equal((await patchTitle(f, "After")).status, 502); rewriteOnPut = undefined;
      remote.set(f.resource, { data: ics("Concurrent"), etag: '"v-concurrent"' });
      const [row] = await rows(f), start = requests.length; await due(row!.id);
      const [settled] = await rows(f); assert.equal(settled!.status, "conflict"); assert.equal(since(start).filter(item => item.startsWith("PUT")).length, 0); assert.equal(await mappingEtag(f), '"v1"'); checks++;
    }
    {
      // (d) Unconfirmed PUT 503 with the unchanged accepted validator: full
      // re-preflight, then exactly one conditional PUT on that validator.
      const f = await fixture("mirror"); overrides.push({ method: "PUT", url: f.resource, skip: 0, reply: () => new Response(null, { status: 503 }) });
      const response = await patchTitle(f, "After"); assert.equal(response.status, 502); unconfirmedBody(response.body);
      let [row] = await rows(f); assert.equal(row!.status, "unconfirmed"); assert.equal(row!.uncertain, true);
      const start = requests.length; await due(row!.id); [row] = await rows(f);
      assert.equal(row!.status, "completed"); assert.deepEqual(since(start), ["GET fixture.ics", ...ELIGIBLE, "GET fixture.ics", "PUT fixture.ics", "GET fixture.ics"]);
      assert.equal(requests.slice(start).find(item => item.method === "PUT")!.ifMatch, '"v1"'); assert.equal(await mappingEtag(f), remote.get(f.resource)!.etag); reset(); checks++;
    }
    // 8. Worker re-derivation after a staged transient preflight failure.
    const stagedRetry = async (kind: "mirror" | "origin" = "mirror") => {
      const f = await fixture(kind); overrides.push({ method: "PROPFIND", url: f.resource, skip: 1, reply: () => new Response(null, { status: 503 }) });
      const response = await patchTitle(f, "After"); assert.equal(response.status, 502); unconfirmedBody(response.body);
      const [row] = await rows(f); assert.equal(row!.status, "retry"); assert.equal(row!.uncertain, false); assert.equal(requests.filter(item => item.method === "PUT" && item.url === f.resource).length, 0);
      return { f, row: row! };
    };
    {
      const { f, row } = await stagedRetry(); const start = requests.length; await due(row.id);
      const [settled] = await rows(f); assert.equal(settled!.status, "completed"); assert.deepEqual(since(start), [...ELIGIBLE, "GET fixture.ics", "PUT fixture.ics", "GET fixture.ics"]); checks++;
    }
    {
      // Flag off after commit: Phase A ineligible, existing gate, blocked; no PUT, no ACK.
      const { f, row } = await stagedRetry(); flags(false); const start = requests.length; await due(row.id); flags(true);
      const [settled] = await rows(f); assert.equal(settled!.status, "blocked"); assert.equal(settled!.errorCode, "provider-permission-unknown");
      assert.deepEqual(since(start), ["PROPFIND fixture.ics"]); assert.equal(await mappingEtag(f), '"v1"'); assert.equal((await db.select().from(events).where(eq(events.id, f.event.id)))[0]!.title, "After", "Local revision stays committed"); checks++;
    }
    {
      // Link disabled through production disableExternalCalendar: the disable
      // transaction itself cancels non-final rows before any claim (C1).
      const { f, row } = await stagedRetry(); assert.ok(await disableExternalCalendar(owner, f.icloud.id));
      let [settled] = await rows(f); assert.equal(settled!.status, "cancelled"); assert.equal(settled!.errorCode, "destination-disconnected");
      const start = requests.length; await due(row.id); [settled] = await rows(f);
      assert.equal(settled!.status, "cancelled"); assert.deepEqual(since(start), [], "Nothing is claimed or requested");
      assert.equal(settled!.resultRef, null, "No ACK"); assert.equal(await mappingEtag(f), undefined, "The disabled mirror's mapping is removed with it, never advanced"); checks++;
    }
    {
      // A raw disabled toggle on this pinned row is caught by the pinned-source fence instead.
      const { f, row } = await stagedRetry(); await db.update(externalCalendars).set({ disabled: true }).where(eq(externalCalendars.calendarID, f.icloud.id));
      const start = requests.length; await due(row.id);
      const [settled] = await rows(f); assert.equal(settled!.status, "blocked"); assert.equal(settled!.errorCode, "delivery-source-changed"); assert.deepEqual(since(start), []); assert.equal(await mappingEtag(f), '"v1"'); checks++;
    }
    // 9. R1 in the delivery scope: worker-time redirect refusal is a typed
    // unknown (blocked); timeout and abort keep their existing retry class.
    for (const [label, reply, status, code] of [
      ["redirect", (f: Fixture) => () => new Response(null, { status: 301, headers: { location: f.collection + "moved.ics" } }), "blocked", "provider-permission-unknown"],
      ["timeout", () => () => { throw new DOMException("deadline", "TimeoutError"); }, "retry", "provider-write-failed"],
      ["abort", () => () => { throw new DOMException("aborted", "AbortError"); }, "retry", "provider-write-failed"],
    ] as const) {
      const f = await fixture("mirror"); overrides.push({ method: "PROPFIND", url: f.resource, skip: 1, reply: reply(f) });
      const response = await patchTitle(f, "After"); assert.equal(response.status, 502, label); unconfirmedBody(response.body);
      const [row] = await rows(f); assert.equal(row!.status, status, label); assert.equal(row!.errorCode, code, label); assert.equal(row!.uncertain, false, label);
      assert.equal(requests.filter(item => item.method === "PUT" && item.url === f.resource).length, 0, label); assert.equal(await mappingEtag(f), '"v1"'); reset(); checks++;
    }
    console.log(`iCloud legacy one-off integration: ${checks} handler/worker/PostgreSQL checks OK (synthetic iCloud-shaped DAV leaf; no real provider)`);
  } finally {
    await db.delete(user).where(eq(user.id, owner));
    globalThis.fetch = originalFetch; dns.lookup = originalLookup;
    config.api.icloudPersonalContentWritesEnabled = priorIcloud; config.api.eventTimeEditsEnabled = priorTime;
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
