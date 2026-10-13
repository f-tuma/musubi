import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import { config } from "@musubi/config";
import { EventSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import {
  account, createCalendar, createEvent, db, eventOutbox, events,
  externalCalendars, externalEvents, patchEventAndCalendarLinks, user,
  type EventOutboxIntent,
} from "@musubi/db";
import { googleAdapter } from "./adapters/google";
import { deliverEventOutbox } from "./event_delivery";
import { providerHttpMetricsRegistry } from "./provider_http_metrics";

const writeScope = "https://www.googleapis.com/auth/calendar.events";
const readScope = "https://www.googleapis.com/auth/calendar.readonly";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const cases = [
  "success", "412", "lost-reply", "wrong-patch-id", "partial-206", "partial-header", "malformed-json",
  "missing-etag", "wrong-id", "invalid-time", "absent-404", "cancelled-read",
  "invited-copy", "organizer-guests", "before-source", "before-privacy",
  "before-connection", "before-scope", "credential-source", "credential-privacy",
  "credential-connection", "credential-narrowing", "after-source", "after-privacy",
  "after-connection", "legacy-long-id", "legacy-large-body",
] as const;
type Scenario = typeof cases[number];
type RequestEvidence = { method: string; path: string; body: string; ifMatch?: string };

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Use a disposable test database");
  const originalEncoder = config.api.syncOperationV1EncoderEnabled;
  const originalFetch = globalThis.fetch;
  const metrics = providerHttpMetricsRegistry.getSingleMetric("musubi_provider_http_requests_total")!;
  const metricCount = async () => (await metrics.get()).values
    .filter(({ labels }) => labels.provider === "google" && labels.family === "event")
    .reduce((total, { value }) => total + value, 0);
  let scenario: Scenario = "success";
  let requests: RequestEvidence[] = [];
  let fixtureFailures: unknown[] = [];
  let remote = nativeEvent("native-event");
  let calendarID = "", oauthID = "", sourceID = "", eventID = "";
  let preflightHook = false, credentialHook = false, patchApplied = false;
  const readFailure = () => ["partial-206", "partial-header", "malformed-json", "missing-etag", "wrong-id", "invalid-time", "absent-404", "cancelled-read"].includes(scenario);
  const loseReply = () => scenario === "lost-reply" || readFailure();
  const race = async (kind: string) => {
    if (kind === "source") {
      await db.update(externalCalendars).set({ providerAccessRevision: 2 }).where(eq(externalCalendars.id, sourceID));
    } else if (kind === "privacy") {
      await db.update(events).set({ providerReadRetiredRevision: 2 }).where(eq(events.id, eventID));
    } else if (kind === "connection") {
      // Restore identical token/scope/status strings. Only the grant generation
      // distinguishes this retired connection from the admitted incarnation.
      await db.update(account).set({ syncStatus: "disabled" }).where(eq(account.id, oauthID));
      await db.update(account).set({ syncStatus: "active", accessTokenExpiresAt: new Date(Date.now() + 3_600_000) }).where(eq(account.id, oauthID));
    } else if (kind === "scope") {
      await db.update(account).set({ scope: readScope }).where(eq(account.id, oauthID));
    }
  };
  const fixture = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://fixture.test");
      const method = req.method!;
      let body = ""; for await (const chunk of req) body += chunk;
      requests.push({ method, path: url.pathname, body, ifMatch: typeof req.headers["if-match"] === "string" ? req.headers["if-match"] : undefined });
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value));
      };
      if (url.pathname === "/token") {
        assert.equal(method, "POST");
        assert.equal(new URLSearchParams(body).get("grant_type"), "refresh_token");
        if (!credentialHook) {
          credentialHook = true;
          if (scenario.startsWith("credential-")) await race(scenario.slice("credential-".length));
        }
        return json({ access_token: "bridge.refreshed", expires_in: 3600,
          ...(scenario === "credential-narrowing" ? { scope: readScope } : {}) });
      }
      assert.ok(["Bearer bridge.access", "Bearer bridge.refreshed"].includes(String(req.headers.authorization)));
      const calendarPath = `/calendar/v3/users/me/calendarList/${encodeURIComponent(calendarID)}`;
      const eventPath = `/calendar/v3/calendars/${encodeURIComponent(calendarID)}/events/${encodeURIComponent(remote.id)}`;
      if (method === "GET" && url.pathname === calendarPath) return json({ id: calendarID, accessRole: "owner" });
      assert.equal(url.pathname, eventPath, "every event request uses the exact scoped accepted address");
      assert.equal(url.search, "", "personal content does not acquire a notification policy or other route");
      if (method === "GET") {
        if (patchApplied && readFailure()) {
          assert.equal(req.headers["cache-control"], "no-cache", "recovery must make a fresh exact native read");
          if (scenario === "partial-206") return json(remote, 206);
          if (scenario === "partial-header") { res.setHeader("content-range", "items 0-0/1"); return json(remote); }
          if (scenario === "malformed-json") { res.writeHead(200, { "content-type": "application/json" }); return res.end("{"); }
          if (scenario === "missing-etag") { const { etag: _etag, ...value } = remote; return json(value); }
          if (scenario === "wrong-id") return json({ ...remote, id: "another-native-object" });
          if (scenario === "absent-404") return json({ error: "Not found" }, 404);
          if (scenario === "cancelled-read") return json({ ...remote, status: "cancelled" });
          return json({ ...remote, start: { dateTime: "not-a-date" } });
        }
        if (!preflightHook) {
          preflightHook = true;
          if (scenario.startsWith("before-")) await race(scenario.slice("before-".length));
          if (scenario.startsWith("credential-")) {
            // Force refresh only in pushUpdate, after preflight and the host's
            // initial destination check. No incarnation changes yet.
            await db.update(account).set({ accessTokenExpiresAt: new Date(0) }).where(eq(account.id, oauthID));
          }
        }
        return json(remote);
      }
      assert.equal(method, "PATCH", "a personal UPDATE never uses POST/DELETE");
      assert.equal(req.headers["if-match"], '"accepted"', "write uses the exact admitted strong ETag");
      const patch = JSON.parse(body) as Record<string, unknown>;
      assert.deepEqual(Object.keys(patch).sort(), ["description", "location", "summary"]);
      if (scenario === "412") return json({ error: "Precondition failed" }, 412);
      assert.equal(typeof patch.summary, "string");
      assert.ok(patch.description === null || typeof patch.description === "string");
      assert.ok(patch.location === null || typeof patch.location === "string");
      remote = { ...remote, summary: patch.summary as string, description: patch.description as string | null,
        location: patch.location as string | null, etag: '"written"' };
      patchApplied = true;
      if (scenario.startsWith("after-")) await race(scenario.slice("after-".length));
      if (loseReply()) return res.destroy();
      if (scenario === "wrong-patch-id") return json({ ...remote, id: "another-native-object" });
      return json(remote);
    } catch (error) {
      fixtureFailures.push(error);
      res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    assert.ok(["https://www.googleapis.com", "https://oauth2.googleapis.com"].includes(url.origin), "no live provider or unrecognized endpoint");
    if (url.origin === "https://www.googleapis.com" && !scenario.startsWith("legacy-"))
      assert.equal(init?.redirect, "error", "the portable provider route refuses redirecting the accepted scope");
    return originalFetch(`${origin}${url.pathname}${url.search}`, init);
  };
  config.api.syncOperationV1EncoderEnabled = true;
  try {
    for (scenario of cases) {
      const owner = `bridge-${randomUUID()}`, accountID = `opaque-${randomUUID()}`;
      oauthID = randomUUID();
      requests = []; fixtureFailures = []; preflightHook = credentialHook = patchApplied = false;
      const legacy = scenario.startsWith("legacy-");
      calendarID = `source+${randomUUID()}@example.test`;
      const nativeID = scenario === "legacy-long-id" ? `native-${"z".repeat(2100)}` : `native+${randomUUID()}`;
      remote = nativeEvent(nativeID);
      if (scenario === "invited-copy") remote.organizer.self = false;
      if (scenario === "organizer-guests") remote.attendees = [{ email: "another@example.test" }];
      const nativeBefore = structuredClone(remote);
      const beforeMetrics = await metricCount();
      await db.insert(user).values({ id: owner, name: "Provider bridge", email: `${owner}@example.test` });
      try {
        await db.insert(account).values({ id: oauthID, userId: owner, providerId: "google", accountId: accountID,
          scope: writeScope, accessToken: "bridge.access", refreshToken: "bridge.refresh",
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000) });
        const calendar = await createCalendar({ creatorID: owner, name: "Bridge fixture", color: "#112233" });
        const [source] = await db.insert(externalCalendars).values({ calendarID: calendar.id, provider: "google",
          userID: owner, accountID, externalCalendarID: calendarID, providerAccessRole: "owner", providerAccessRevision: 1 }).returning();
        sourceID = source!.id;
        const event = EventSchema.parse({ id: randomUUID(), creatorID: owner, organizer: owner,
          calendars: [calendar.id], originCalendarID: calendar.id, title: remote.summary,
          description: remote.description, location: remote.location, color: "#112233",
          start: "2026-10-01T09:00:00Z", end: "2026-10-01T10:00:00Z", isAllDay: false, isCanceled: false });
        eventID = event.id;
        await createEvent(event, event.calendars);
        const [mapping] = await db.insert(externalEvents).values({ provider: "google", eventID,
          calendarID: calendar.id, externalCalendarID: calendarID, externalEventID: nativeID, etag: remote.etag }).returning();
        const patch = { title: scenario === "legacy-large-body" ? "L".repeat(2_000_001) : "Accepted content A",
          description: "Accepted notes A", location: "Accepted location A" };
        const operationID = randomUUID();
        const intent: EventOutboxIntent = { id: operationID, actorID: owner, mutationID: randomUUID(), position: 0,
          eventID, calendarID: calendar.id, externalCalendarLinkID: sourceID, provider: "google", userID: owner,
          accountID, externalCalendarID: calendarID, externalEventID: nativeID, expectedEtag: remote.etag,
          action: "update", payload: { event, patch } };
        assert.equal((await patchEventAndCalendarLinks(eventID, 1, patch, false, [intent])).status, "saved");
        const readRow = async () => (await db.select().from(eventOutbox).where(eq(eventOutbox.id, operationID)))[0]!;
        const saved = await readRow();
        assert.equal(own(saved.payload, "operationEnvelope"), !legacy, "only the bounded admitted profile enters the new provider route");
        if (!legacy) {
          const envelope = SyncOperationEnvelopeSchema.parse(saved.payload.operationEnvelope);
          assert.equal(envelope.serializer.id, "google-personal-event");
          assert.equal(envelope.admittedProjection.data.title, "Accepted content A");
          // Current mappers/preview must not supply a new B payload at dispatch.
          await db.update(eventOutbox).set({ payload: { ...saved.payload,
            providerProjection: { ...event, title: "Unaccepted mapper B" } } }).where(eq(eventOutbox.id, operationID));
        }
        const dispatchHash = hash((await readRow()).payload);
        let result = await deliverEventOutbox(operationID, () => googleAdapter);
        assert.ok(result);
        const mutations = () => requests.filter(value => value.method === "PATCH");
        const mapped = async () => (await db.select().from(externalEvents).where(eq(externalEvents.id, mapping!.id)))[0]!;
        if (scenario.startsWith("before-") || scenario.startsWith("credential-") || ["invited-copy", "organizer-guests"].includes(scenario)) {
          assert.notEqual(result.status, "completed");
          assert.equal(result.uncertain, false, "a retired source/grant proved before dispatch has no possible write effect");
          assert.equal(mutations().length, 0, "authority is rechecked after asynchronous credential resolution");
          assert.equal((await mapped()).etag, '"accepted"');
          assert.deepEqual(remote, nativeBefore);
        } else if (scenario === "412") {
          assert.equal(result.status, "conflict"); assert.equal(result.uncertain, false);
          assert.equal(mutations().length, 1, "412 is never retried unconditionally");
          assert.equal((await mapped()).etag, '"accepted"');
          assert.deepEqual(remote, nativeBefore);
        } else if (scenario.startsWith("after-")) {
          assert.equal(result.status, "blocked"); assert.equal(result.uncertain, true);
          assert.equal(mutations().length, 1);
          assert.equal((await mapped()).etag, '"accepted"', "local mapping ACK remains atomic with current source/grant/privacy fences");
          assert.equal(result.resultRef?.etag, '"written"', "native effect evidence survives a refused local ACK");
          assert.equal(remote.summary, patch.title);
        } else if (loseReply() || scenario === "wrong-patch-id") {
          assert.equal(result.status, "unconfirmed"); assert.equal(result.uncertain, true);
          assert.equal(mutations().length, 1); assert.equal((await mapped()).etag, '"accepted"');
          await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, operationID));
          result = await deliverEventOutbox(operationID, () => googleAdapter); assert.ok(result);
          assert.equal(mutations().length, 1, "lost-reply recovery only observes the admitted native effect");
          if (scenario === "lost-reply" || scenario === "wrong-patch-id") {
            assert.equal(result.status, "completed"); assert.equal(result.uncertain, false);
            assert.equal((await mapped()).etag, '"written"');
          } else {
            assert.notEqual(result.status, "completed", "partial/malformed/identity-unproven native evidence cannot authorize ACK");
            assert.equal(result.uncertain, true); assert.equal((await mapped()).etag, '"accepted"');
          }
        } else {
          assert.equal(result.status, "completed"); assert.equal(result.uncertain, false);
          assert.equal(mutations().length, 1); assert.equal((await mapped()).etag, '"written"');
        }
        if (!legacy) assert.equal(hash((await readRow()).payload), dispatchHash, "delivery never rewrites the admitted envelope or saved preview");
        else assert.equal(own((await readRow()).payload, "operationEnvelope"), false, "legacy delivery does not rewrite a historic intent into v1");
        for (const write of mutations()) {
          assert.deepEqual(JSON.parse(write.body), { summary: patch.title, description: patch.description, location: patch.location }, "wire bytes derive from accepted A values only");
          assert.equal(write.ifMatch, '"accepted"');
        }
        if (patchApplied) {
          assert.deepEqual(remote.start, nativeBefore.start); assert.deepEqual(remote.end, nativeBefore.end);
          assert.deepEqual(remote.reminders, nativeBefore.reminders);
          assert.deepEqual(remote.extendedProperties, nativeBefore.extendedProperties);
        }
        assert.deepEqual(fixtureFailures, [], "fake-provider assertions must not be mistaken for a valid delivery refusal");
        if (scenario.startsWith("credential-")) assert.equal(credentialHook, true, "the race actually runs inside asynchronous refresh");
        assert.equal(await metricCount() - beforeMetrics, requests.length, "each actual provider/token HTTP dispatch is counted exactly once");
        console.log(`Google provider bridge: ${scenario}: OK`);
      } finally {
        // These journals intentionally outlive canonical objects; purge this
        // owned fixture explicitly before deleting its user.
        await db.delete(eventOutbox).where(eq(eventOutbox.userID, owner));
        await db.delete(user).where(eq(user.id, owner));
      }
    }
    const exported = await providerHttpMetricsRegistry.metrics();
    assert.ok(!/bridge\.|native\+|source\+|example\.test|127\.0\.0\.1|Bearer/.test(exported), "private credentials and scoped native identifiers never become telemetry labels");
    console.log(`Google provider bridge PostgreSQL/HTTP: ${cases.length} scenarios passed`);
  } finally {
    config.api.syncOperationV1EncoderEnabled = originalEncoder;
    globalThis.fetch = originalFetch;
    fixture.closeAllConnections();
    await new Promise<void>((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
  }
}

function nativeEvent(id: string) {
  return { id, etag: '"accepted"', status: "confirmed", summary: "Before content",
    description: "Before notes" as string | null, location: "Before location" as string | null,
    start: { dateTime: "2026-10-01T09:00:00Z" }, end: { dateTime: "2026-10-01T10:00:00Z" },
    organizer: { email: "owner@example.test", self: true }, attendees: [] as { email?: string; self?: boolean; organizer?: boolean }[],
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
    extendedProperties: { private: { nativeProperty: "preserve" } } };
}

main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
