import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";
import { logger } from "@musubi/config";
import { CLIENT_VERSION_HEADER, PRODUCT_VERSION } from "@musubi/types";
import { account, calendarEvents, calendarMembers, createCalendar, db, events, eventOutbox, externalCalendars,
  getOAuthCredentials, replaceMemberToken, updateOAuthTokens, user } from "@musubi/db";
import { issueMemberToken } from "../federation_tokens";
import { requireAuth } from "../middleware/require_auth";
import { middlewareErrorHandler } from "../middleware/error_handler";
import { bootstrapProviderBudget, stopProviderBudget } from "../sync/provider_budget";
import { stopSyncWorkCoordinator } from "../sync/work_coordinator";
import { initializeSyncEngine } from "../sync/engine";
import { handlerCreateEvent } from "./events";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const owner = `create-refresh-${randomUUID()}`, member = `shared-member-${randomUUID()}`, token = issueMemberToken();
  const scopes = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist"];
  const originalScope = scopes.join(",");
  const realFetch = globalThis.fetch, trace: string[] = [];
  let failPreflight = false;
  const diagnosticRows: unknown[] = [], originalWarn = logger.warn;
  let calendarRole = "owner", posted: Record<string, unknown> | undefined;
  const app = express(); app.use(express.json()); app.post("/events", requireAuth, handlerCreateEvent); app.use(middlewareErrorHandler);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const id of [owner, member]) await db.insert(user).values({ id, name: "Fixture", email: `${id}@example.test`, isExternal: true });
    await replaceMemberToken(owner, token.tokenHash);
    await db.insert(account).values({ id: owner, userId: owner, accountId: owner, providerId: "google", scope: originalScope,
      refreshToken: "fixture.refresh-token", accessToken: "fixture.expired-token", accessTokenExpiresAt: new Date(0) });
    const shared = await createCalendar({ creatorID: owner, name: "Shared fixture", color: "red" });
    await db.insert(calendarMembers).values({ calendarID: shared.id, userID: member, role: "editor" });
    const google = await createCalendar({ creatorID: owner, name: "Google fixture", color: "red" });
    await db.insert(externalCalendars).values({ calendarID: google.id, provider: "google", userID: owner, accountID: owner,
      externalCalendarID: "fixture-native", cursor: "fixture-cursor", providerAccessRole: "owner", providerAccessRevision: 1 });
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input)), method = init?.method ?? "GET";
      if (url.origin === origin) return realFetch(input, init);
      trace.push(`${method} ${url.pathname}`);
      if (url.href === "https://oauth2.googleapis.com/token") {
        assert.equal(method, "POST");
        return Response.json({ access_token: "fixture.renewed-token", expires_in: 3600, scope: scopes.slice().reverse().join(" ") });
      }
      assert.equal(url.origin, "https://www.googleapis.com", "No real provider HTTP in this test");
      if (method === "GET" && url.pathname === "/calendar/v3/users/me/calendarList/fixture-native") {
        if (failPreflight) throw Object.assign(new Error("SENTINEL_private_provider_payload"), { code: "ETIMEDOUT" });
        return Response.json({ id: "fixture-native", accessRole: calendarRole });
      }
      if (method === "POST" && url.pathname === "/calendar/v3/calendars/fixture-native/events") {
        assert.equal(posted, undefined, "Exactly one Google create");
        posted = JSON.parse(String(init?.body));
        return Response.json({ ...posted, etag: '"fixture-created"' }, { status: 201 });
      }
      if (method === "GET" && url.pathname.startsWith("/calendar/v3/calendars/fixture-native/events/"))
        return posted ? Response.json({ ...posted, etag: '"fixture-created"' }) : Response.json({}, { status: 404 });
      throw new Error(`Unexpected fixture request: ${method} ${url.pathname}`);
    };
    logger.warn = ((message: string, fields: Parameters<typeof logger.warn>[1]) => {
      if (message === "sync.event.preflight_failed") diagnosticRows.push(fields);
      else originalWarn.call(logger, message, fields);
    }) as typeof logger.warn;
    initializeSyncEngine([]);
    await bootstrapProviderBudget();
    const before = (await getOAuthCredentials(owner, "google", owner))!;
    const source = async () => (await db.select().from(externalCalendars).where(eq(externalCalendars.calendarID, google.id)))[0]!;
    const sourceBefore = await source();
    const content = () => ({ id: randomUUID(), creatorID: owner, organizer: owner, title: "Shared and Google", color: "red",
      calendars: [shared.id, google.id], originCalendarID: shared.id, start: "2026-11-06T09:00:00Z", end: "2026-11-06T10:00:00Z", isAllDay: false, isCanceled: false });
    const send = async (body: unknown) => {
      const response = await realFetch(origin + "/events", { method: "POST", headers: { "content-type": "application/json",
        [CLIENT_VERSION_HEADER]: PRODUCT_VERSION, authorization: `Bearer ${token.raw}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      return { status: response.status, body: await response.json() };
    };
    const event = content(), result = await send(event);
    assert.equal(result.status, 201, JSON.stringify(result.body));
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
    const nativeCreates = trace.filter(row => row.startsWith("POST /calendar/")); assert.equal(nativeCreates.length, 1);
    const retry = await send(event); assert.equal(retry.status, 202); // completed receipt, no second provider write
    assert.deepEqual(trace.filter(row => row.startsWith("POST /calendar/")), nativeCreates);

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
    console.log("Shared + Google CREATE: authenticated HTTP, real DB/OAuth/scheduler/budget, equivalent grant refresh, completed native fixture write, retry, reader rejection, changed-grant/stale-CAS guards and bounded preflight diagnostics: OK");
  } finally {
    stopSyncWorkCoordinator(); stopProviderBudget(); globalThis.fetch = realFetch; logger.warn = originalWarn;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await db.delete(user).where(eq(user.id, owner));
    await db.delete(user).where(eq(user.id, member));
    await db.$client.end();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
