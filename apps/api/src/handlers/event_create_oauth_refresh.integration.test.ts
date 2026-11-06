import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "@musubi/config";
import { CLIENT_VERSION_HEADER, PRODUCT_VERSION } from "@musubi/types";
import { account, calendarEvents, calendarMembers, createCalendar, db, events, eventOutbox, externalCalendars, externalEvents,
  getOAuthCredentials, replaceMemberToken, requestSyncReadWork, syncReadWork, updateOAuthTokens, user } from "@musubi/db";
import { issueMemberToken } from "../federation_tokens";
import { requireAuth } from "../middleware/require_auth";
import { middlewareErrorHandler } from "../middleware/error_handler";
import { bootstrapProviderBudget, stopProviderBudget } from "../sync/provider_budget";
import { kickSyncWork, stopSyncWorkCoordinator } from "../sync/work_coordinator";
import { initializeSyncEngine } from "../sync/engine";
import { DELIVERY_ATTEMPT_TIMEOUT_MS } from "../sync/delivery_policy";
import { handlerCreateEvent } from "./events";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const owner = `create-refresh-${randomUUID()}`, member = `shared-member-${randomUUID()}`, token = issueMemberToken();
  const scopes = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist"];
  const originalScope = scopes.join(",");
  const realFetch = globalThis.fetch, trace: string[] = [];
  let releaseBackground!: () => void, backgroundParked!: () => void, releaseToken!: () => void, requestAtScheduler!: () => void;
  const tokenDependency = new Promise<void>(resolve => { releaseToken = resolve; });
  const requestScheduled = new Promise<void>(resolve => { requestAtScheduler = resolve; });
  let watchAdmission = false, holdToken = true, nativeWriteBeforeBackgroundRead = false, backgroundReadStarted = false;
  const originalQuery = db.$client.query;
  let pendingCreate: Promise<unknown> | undefined;
  let admissionTimer: ReturnType<typeof setTimeout> | undefined;
  const backgroundDependency = new Promise<void>(resolve => { releaseBackground = resolve; });
  const parked = new Promise<void>(resolve => { backgroundParked = resolve; });
  let holdBackground = true, backgroundFinished = false;
  let parkTimer: ReturnType<typeof setTimeout> | undefined;
  let failPreflight = false, hangPreflight = false, cooldownPreflight = false;
  const diagnosticRows: unknown[] = [], originalWarn = logger.warn;
  let calendarRole = "owner";
  const posted = new Map<string, Record<string, unknown>>();
  // Other-account readers: offered together, held at their native HTTP port.
  const others = [0, 1, 2, 3].map(index => ({ id: `other-reader-${index}-${randomUUID()}`, native: `other-native-${index}` }));
  let releaseOthers!: () => void, holdOthers = true, otherReadsStarted = 0, otherReadsFinished = 0;
  const othersDependency = new Promise<void>(resolve => { releaseOthers = resolve; });
  const app = express(); app.use(express.json()); app.post("/events", requireAuth, handlerCreateEvent); app.use(middlewareErrorHandler);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    // Observe the real physical-key DB port; the result still comes from PostgreSQL.
    db.$client.query = ((...args: unknown[]) => {
      const result = Reflect.apply(originalQuery, db.$client, args);
      const query = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text ?? "";
      if (watchAdmission && /select md5\(jsonb_build_array/.test(query))
        return Promise.resolve(result).then(value => { requestAtScheduler(); return value; });
      return result;
    }) as typeof db.$client.query;
    for (const id of [owner, member]) await db.insert(user).values({ id, name: "Fixture", email: `${id}@example.test`, isExternal: true });
    await replaceMemberToken(owner, token.tokenHash);
    await db.insert(account).values({ id: owner, userId: owner, accountId: owner, providerId: "google", scope: originalScope,
      refreshToken: "fixture.refresh-token", accessToken: "fixture.expired-token", accessTokenExpiresAt: new Date(0) });
    const shared = await createCalendar({ creatorID: owner, name: "Shared fixture", color: "red" });
    await db.insert(calendarMembers).values({ calendarID: shared.id, userID: member, role: "editor" });
    const google = await createCalendar({ creatorID: owner, name: "Google fixture", color: "red" });
    const [googleSource] = await db.insert(externalCalendars).values({ calendarID: google.id, provider: "google", userID: owner, accountID: owner,
      externalCalendarID: "fixture-native", cursor: "fixture-cursor", providerAccessRole: "owner", providerAccessRevision: 1 }).returning();
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input)), method = init?.method ?? "GET";
      if (url.origin === origin) return realFetch(input, init);
      trace.push(`${method} ${url.pathname}`);
      if (url.href === "https://oauth2.googleapis.com/token") {
        assert.equal(method, "POST");
        if (holdToken) { holdToken = false; backgroundParked(); await tokenDependency; }
        return Response.json({ access_token: "fixture.renewed-token", expires_in: 3600, scope: scopes.slice().reverse().join(" ") });
      }
      assert.equal(url.origin, "https://www.googleapis.com", "No real provider HTTP in this test");
      if (method === "GET" && url.pathname === "/calendar/v3/users/me/calendarList/fixture-native") {
        if (failPreflight) throw Object.assign(new Error("SENTINEL_private_provider_payload"), { code: "ETIMEDOUT" });
        if (hangPreflight) {
          // A provider that never answers: only the actual bounded attempt deadline ends this request.
          hangPreflight = false;
          await new Promise<never>((_resolve, reject) => {
            const signal = init?.signal; assert.ok(signal, "Preflight HTTP carries the attempt signal");
            if (signal.aborted) reject(signal.reason); else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        if (cooldownPreflight) { cooldownPreflight = false; return new Response(null, { status: 429, headers: { "retry-after": "30" } }); }
        return Response.json({ id: "fixture-native", accessRole: calendarRole });
      }
      const other = others.find(entry => url.pathname === `/calendar/v3/calendars/${entry.native}/events`);
      if (method === "GET" && other) {
        otherReadsStarted++;
        if (holdOthers) await othersDependency;
        otherReadsFinished++;
        return Response.json({ items: [], timeZone: "UTC", nextSyncToken: "fixture-other-checkpoint" });
      }
      if (method === "GET" && url.pathname === "/calendar/v3/calendars/fixture-native/events") {
        // A read claimed before the write may return a stale empty provider listing.
        const items = holdBackground ? [] : [...posted.values()].map(item => ({ ...item, etag: '"fixture-created"' }));
        backgroundReadStarted = true;
        if (holdBackground) {
          holdBackground = false;
          await backgroundDependency; backgroundFinished = true;
        }
        return Response.json({ items, timeZone: "UTC", nextSyncToken: "fixture-read-checkpoint" });
      }
      if (method === "POST" && url.pathname === "/calendar/v3/calendars/fixture-native/events") {
        if (!posted.size) nativeWriteBeforeBackgroundRead = !backgroundReadStarted;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(posted.has(String(body.id)), false, "Exactly one Google create per event");
        posted.set(String(body.id), body);
        return Response.json({ ...body, etag: '"fixture-created"' }, { status: 201 });
      }
      if (method === "GET" && url.pathname.startsWith("/calendar/v3/calendars/fixture-native/events/")) {
        const item = posted.get(decodeURIComponent(url.pathname.slice("/calendar/v3/calendars/fixture-native/events/".length)));
        return item ? Response.json({ ...item, etag: '"fixture-created"' }) : Response.json({}, { status: 404 });
      }
      throw new Error(`Unexpected fixture request: ${method} ${url.pathname}`);
    };
    logger.warn = ((message: string, fields: Parameters<typeof logger.warn>[1]) => {
      if (message === "sync.event.preflight_failed") diagnosticRows.push(fields);
      else originalWarn.call(logger, message, fields);
    }) as typeof logger.warn;
    await bootstrapProviderBudget();
    initializeSyncEngine(["pull"]);
    // Let the engine derive its own current read configuration and policy.
    await requestSyncReadWork({ userID: owner, provider: "google", accountID: owner, sourceID: googleSource!.id,
      stream: "events", configurationFingerprint: "fixture-requires-current-configuration", policyFingerprint: "fixture-requires-current-policy" });
    kickSyncWork();
    await Promise.race([parked, new Promise<never>((_resolve, reject) => {
      parkTimer = setTimeout(() => reject(new Error("Actual background reader did not reach its HTTP port")), 8_000);
    })]);
    clearTimeout(parkTimer);
    const before = (await getOAuthCredentials(owner, "google", owner))!;
    const source = async () => (await db.select().from(externalCalendars).where(eq(externalCalendars.calendarID, google.id)))[0]!;
    const sourceBefore = await source();
    const content = () => ({ id: randomUUID(), creatorID: owner, organizer: owner, title: "Shared and Google", color: "red",
      calendars: [shared.id, google.id], originCalendarID: shared.id, start: "2026-11-06T09:00:00Z", end: "2026-11-06T10:00:00Z", isAllDay: false, isCanceled: false });
    const send = async (body: unknown, timeoutMs = 15_000) => {
      const response = await realFetch(origin + "/events", { method: "POST", headers: { "content-type": "application/json",
        [CLIENT_VERSION_HEADER]: PRODUCT_VERSION, authorization: `Bearer ${token.raw}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      return { status: response.status, retryAfter: response.headers.get("retry-after"), body: await response.json() };
    };
    const rowsFor = async (eventID: string) => ({
      events: (await db.select().from(events).where(eq(events.id, eventID))).length,
      outbox: (await db.select().from(eventOutbox).where(eq(eventOutbox.eventID, eventID))).length,
    });
    const waitFor = async (condition: () => boolean, what: string, limitMs = 8_000) => {
      const startedAt = Date.now();
      while (!condition()) { if (Date.now() - startedAt > limitMs) throw new Error(what); await new Promise(resolve => setTimeout(resolve, 10)); }
    };
    const event = content(); watchAdmission = true;
    const creating = send(event); pendingCreate = creating; void creating.catch(() => {});
    await Promise.race([requestScheduled, new Promise<never>((_resolve, reject) => {
      admissionTimer = setTimeout(() => reject(new Error("Create did not reach the production scheduling port")), 8_000);
    })]);
    clearTimeout(admissionTimer);
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    releaseToken();
    const result = await creating;
    assert.equal(nativeWriteBeforeBackgroundRead, true, "Foreground create finishes before the parked reader resumes native HTTP");
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(backgroundFinished, false, "Cold OAuth refresh, preflight and durable delivery complete while the actual same-account reader is parked");
    assert.equal(result.body.id, event.id);
    const after = (await getOAuthCredentials(owner, "google", owner))!;
    assert.equal(after.syncReadGeneration, before.syncReadGeneration);
    assert.equal(after.scope, originalScope, "Equivalent refresh preserves the exact persisted authority");
    const sourceAfter = await source();
    assert.equal(sourceAfter.sourceGeneration, sourceBefore.sourceGeneration);
    assert.equal(sourceAfter.checkpointRevision, sourceBefore.checkpointRevision);
    assert.equal(sourceAfter.cursor, sourceBefore.cursor);
    assert.equal((await db.select().from(events).where(eq(events.id, event.id))).length, 1);
    assert.deepEqual((await db.select().from(calendarEvents).where(eq(calendarEvents.eventID, event.id))).map(row => row.calendarID).sort(), [shared.id, google.id].sort());
    const rows = await db.select().from(eventOutbox).where(eq(eventOutbox.eventID, event.id));
    assert.equal(rows.length, 1); assert.equal(rows[0]!.status, "completed"); assert.equal(rows[0]!.uncertain, false);
    releaseBackground();
    let backgroundSettled = false;
    for (let turn = 0; turn < 500; turn++) {
      const active = await db.select({ id: syncReadWork.id }).from(syncReadWork).where(and(eq(syncReadWork.userID, owner), isNull(syncReadWork.retiredAt), isNull(syncReadWork.claimToken)));
      if (backgroundFinished && active.length) { backgroundSettled = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(backgroundFinished, true);
    assert.equal(backgroundSettled, true, "Wait for the actual read claim to settle before checking concurrent-write preservation");
    assert.equal((await db.select().from(events).where(and(eq(events.id, event.id), isNull(events.deletedAt)))).length, 1,
      "A stale empty read cannot delete the event accepted during its wait");
    assert.deepEqual((await db.select().from(calendarEvents).where(eq(calendarEvents.eventID, event.id))).map(row => row.calendarID).sort(), [shared.id, google.id].sort(),
      "The stale read preserves both calendar links");
    assert.equal((await db.select().from(externalEvents).where(eq(externalEvents.eventID, event.id))).length, 1,
      "The stale read preserves the newly acknowledged provider mapping");
    const nativeCreates = trace.filter(row => row.startsWith("POST /calendar/")); assert.equal(nativeCreates.length, 1);
    const retry = await send(event); assert.equal(retry.status, 202); // completed receipt, no second provider write
    assert.deepEqual(trace.filter(row => row.startsWith("POST /calendar/")), nativeCreates);

    // Other-account saturation: four other users' pulls are offered to the actual
    // scheduler and held inside native HTTP. The foreground reserve admits at
    // most three background pulls, so the fourth stays pending and this
    // account's preflight and durable delivery are admitted without any release.
    for (const other of others) {
      await db.insert(user).values({ id: other.id, name: "Fixture", email: `${other.id}@example.test`, isExternal: true });
      await db.insert(account).values({ id: other.id, userId: other.id, accountId: other.id, providerId: "google", scope: originalScope,
        refreshToken: "fixture.other-refresh", accessToken: "fixture.other-token", accessTokenExpiresAt: new Date(Date.now() + 3_600_000) });
      const calendar = await createCalendar({ creatorID: other.id, name: "Other Google fixture", color: "red" });
      const [otherSource] = await db.insert(externalCalendars).values({ calendarID: calendar.id, provider: "google", userID: other.id, accountID: other.id,
        externalCalendarID: other.native, cursor: "fixture-cursor", providerAccessRole: "owner", providerAccessRevision: 1 }).returning();
      await requestSyncReadWork({ userID: other.id, provider: "google", accountID: other.id, sourceID: otherSource!.id,
        stream: "events", configurationFingerprint: "fixture-requires-current-configuration", policyFingerprint: "fixture-requires-current-policy" });
    }
    kickSyncWork();
    await waitFor(() => otherReadsStarted >= 3, "Three other-account readers did not reach their HTTP port");
    await new Promise(resolve => setTimeout(resolve, 300)); kickSyncWork(); await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(otherReadsStarted, 3, "The reserve admits three background pulls; the fourth offered pull stays pending");
    const saturated = content(), saturatedResult = await send(saturated);
    assert.equal(saturatedResult.status, 201, JSON.stringify(saturatedResult.body));
    assert.equal(otherReadsFinished, 0, "CREATE answered 201 before any other-account reader released");
    assert.equal(otherReadsStarted, 3);
    const saturatedRows = await db.select().from(eventOutbox).where(eq(eventOutbox.eventID, saturated.id));
    assert.equal(saturatedRows.length, 1); assert.equal(saturatedRows[0]!.status, "completed"); assert.equal(saturatedRows[0]!.uncertain, false);
    assert.equal(trace.filter(row => row.startsWith("POST /calendar/")).length, 2);
    holdOthers = false; releaseOthers(); kickSyncWork();
    await waitFor(() => otherReadsFinished === 4, "All four other-account readers did not complete after release");
    for (const other of others) {
      let settled = false;
      for (let turn = 0; turn < 500 && !settled; turn++) {
        const claimed = await db.select({ id: syncReadWork.id }).from(syncReadWork).where(and(eq(syncReadWork.userID, other.id), isNull(syncReadWork.retiredAt), isNull(syncReadWork.claimToken)));
        settled = claimed.length > 0; if (!settled) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(settled, true, "Other-account read claims settle after release");
    }

    calendarRole = "reader";
    const denied = content(), rejection = await send(denied);
    assert.equal(rejection.status, 403); assert.equal(rejection.body.reason, "denied");
    assert.equal((await db.select().from(events).where(eq(events.id, denied.id))).length, 0);
    assert.equal((await db.select().from(eventOutbox).where(eq(eventOutbox.eventID, denied.id))).length, 0);

    calendarRole = "owner"; failPreflight = true;
    const unavailable = content(), unknown = await send(unavailable);
    assert.equal(unknown.status, 403); assert.equal(unknown.body.reason, "unknown");
    assert.equal((await db.select().from(events).where(eq(events.id, unavailable.id))).length, 0);
    assert.equal((await db.select().from(eventOutbox).where(eq(eventOutbox.eventID, unavailable.id))).length, 0);
    assert.deepEqual(diagnosticRows, [{ code: "sync-work-unavailable", phase: "execute", family: "event-delivery",
      reason: "network-error", networkCode: "ETIMEDOUT", provider: "google", action: "create" }]);
    assert.equal(JSON.stringify(diagnosticRows).includes("SENTINEL_private"), false);
    failPreflight = false;

    // The actual bounded attempt deadline (no shortened timer): the provider never
    // answers, so the typed timeout maps to a retryable 503, not a 403 refusal.
    diagnosticRows.length = 0; hangPreflight = true;
    const timedOut = content(), timeoutStartedAt = Date.now();
    const timeoutResult = await send(timedOut, DELIVERY_ATTEMPT_TIMEOUT_MS + 15_000), timeoutAnsweredAt = Date.now();
    assert.ok(timeoutAnsweredAt - timeoutStartedAt >= DELIVERY_ATTEMPT_TIMEOUT_MS - 500, `Deadline elapsed: ${timeoutAnsweredAt - timeoutStartedAt} ms`);
    assert.equal(timeoutResult.status, 503, JSON.stringify(timeoutResult.body));
    assert.equal(timeoutResult.retryAfter, "5");
    assert.deepEqual({ ...timeoutResult.body, retryAt: undefined, requestId: undefined },
      { error: "Calendar writing is temporarily unavailable. No changes were saved. Try again shortly.", code: "provider-busy", localCommitted: false, retryAt: undefined, requestId: undefined });
    const timeoutRetryAt = Date.parse(timeoutResult.body.retryAt);
    assert.ok(timeoutRetryAt >= timeoutAnsweredAt + 4_000 && timeoutRetryAt <= timeoutAnsweredAt + 5_500, timeoutResult.body.retryAt);
    assert.deepEqual(await rowsFor(timedOut.id), { events: 0, outbox: 0 });
    assert.deepEqual(diagnosticRows, [{ code: "sync-work-unavailable", phase: "execute", family: "event-delivery", reason: "deadline", provider: "google", action: "create" }]);
    // The same identity later takes the normal create path: a fresh commit and one provider write.
    const afterTimeout = await send(timedOut);
    assert.equal(afterTimeout.status, 201, JSON.stringify(afterTimeout.body)); assert.equal(afterTimeout.body.id, timedOut.id);
    assert.equal(trace.filter(row => row.startsWith("POST /calendar/")).length, 3);
    assert.deepEqual(await rowsFor(timedOut.id), { events: 1, outbox: 1 });

    // An actual provider budget cooldown (observed from a 429 Retry-After beyond the
    // continuation window) is a typed pre-dispatch deferral: 503 with the exact retryAt.
    diagnosticRows.length = 0; cooldownPreflight = true;
    const throttledAt = Date.now(), throttled = await send(content());
    assert.equal(throttled.status, 409); assert.equal(throttled.body.code, "provider-write-failed");
    const deferredEvent = content(), deferredResult = await send(deferredEvent), deferredAnsweredAt = Date.now();
    assert.equal(deferredResult.status, 503, JSON.stringify(deferredResult.body));
    assert.equal(deferredResult.body.code, "provider-busy"); assert.equal(deferredResult.body.localCommitted, false);
    const deferredRetryAt = Date.parse(deferredResult.body.retryAt);
    assert.ok(deferredRetryAt >= throttledAt + 29_000 && deferredRetryAt <= deferredAnsweredAt + 30_000, deferredResult.body.retryAt);
    assert.equal(Number(deferredResult.retryAfter), Math.ceil((deferredRetryAt - deferredAnsweredAt) / 1000));
    assert.deepEqual(await rowsFor(deferredEvent.id), { events: 0, outbox: 0 });
    assert.deepEqual(diagnosticRows.map(row => (row as { reason: string; deferralReason?: string })), [
      { code: "sync-work-unavailable", phase: "execute", family: "event-delivery", reason: "deferred", deferralReason: "cooldown", provider: "google", action: "create" }]);
    assert.equal(trace.filter(row => row.startsWith("POST /calendar/")).length, 3, "No provider write during a deferred preflight");

    // Grant changes still retire authority; stale refresh results still lose CAS.
    for (const scope of [scopes[0]!, originalScope, ""]) {
      const snapshot = (await getOAuthCredentials(owner, "google", owner))!;
      const previousSource = await source();
      assert.equal(await updateOAuthTokens(owner, "google", owner, { accessToken: "fixture.changed", accessTokenExpiresAt: new Date(Date.now() + 3600000), scope }, snapshot), true);
      const changed = (await getOAuthCredentials(owner, "google", owner))!;
      assert.equal(changed.syncReadGeneration, snapshot.syncReadGeneration + 1);
      assert.equal(changed.scope, scope);
      assert.equal((await source()).sourceGeneration, previousSource.sourceGeneration + 1);
      assert.equal((await source()).cursor, null);
      assert.equal(await updateOAuthTokens(owner, "google", owner, { accessToken: "fixture.stale", accessTokenExpiresAt: new Date(), scope: snapshot.scope! }, snapshot), false);
    }
    // The non-CAS entry point also preserves equivalent scope representations.
    await db.update(account).set({ scope: originalScope }).where(eq(account.id, owner));
    const unguardedBefore = (await getOAuthCredentials(owner, "google", owner))!;
    await updateOAuthTokens(owner, "google", owner, { accessToken: "fixture.unguarded", accessTokenExpiresAt: new Date(Date.now() + 3600000), scope: scopes.slice().reverse().join(" ") });
    assert.equal((await getOAuthCredentials(owner, "google", owner))!.syncReadGeneration, unguardedBefore.syncReadGeneration);
    console.log("Shared + Google CREATE during an actual parked read: authenticated HTTP, real DB/OAuth/scheduler/budget, equivalent grant refresh, completed native fixture write, retry, reader rejection, changed-grant/stale-CAS guards, bounded preflight diagnostics, other-account saturation with the foreground reserve, actual deadline and cooldown deferral 503 mappings: OK");
  } finally {
    clearTimeout(parkTimer); clearTimeout(admissionTimer); releaseToken(); releaseBackground(); holdOthers = false; releaseOthers();
    db.$client.query = originalQuery;
    stopSyncWorkCoordinator(); stopProviderBudget(); globalThis.fetch = realFetch; logger.warn = originalWarn;
    server.closeAllConnections(); await pendingCreate?.catch(() => {}); await new Promise<void>(resolve => server.close(() => resolve()));
    await db.delete(user).where(eq(user.id, owner));
    await db.delete(user).where(eq(user.id, member));
    for (const other of others) await db.delete(user).where(eq(user.id, other.id));
    await db.$client.end();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
