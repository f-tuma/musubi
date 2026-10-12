import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import {
  account, db, events, getUserExternalCalendars, importExternalCalendar,
  reconcileMicrosoftCalendarAccess, upsertExternalEvent, user,
} from "@musubi/db";
import { microsoftAdapter } from "./adapters/microsoft";
import { syncProvider } from "./engine";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const userID = `graph-hydration-${randomUUID()}`;
  const calendar = "shared calendar/+?";
  const masterID = "master/+?";
  let failure: number | "network" | "json" | "null" = 503;
  let removed = false;
  let prime = true;
  const deltaPath = `/v1.0/me/calendars/${encodeURIComponent(calendar)}/calendarView/delta`;
  const deltaLink = (token: string) => `https://graph.microsoft.com${deltaPath}?$deltatoken=${token}`;
  const masterPaths: string[] = [];
  const deltaPaths: string[] = [];
  const stub = (id: string) => ({ id, type: "occurrence", seriesMasterId: masterID,
    start: { dateTime: "2026-09-10T00:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-09-11T00:00:00.0000000", timeZone: "UTC" },
  });
  const fixture = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture.test");
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, "Bearer fixture-access");
    res.setHeader("content-type", "application/json");
    const json = (body: unknown) => res.end(JSON.stringify(body));
    if (url.pathname === "/v1.0/me/calendars") return json({ value: [{ id: calendar, name: "Shared", canEdit: false, canViewPrivateItems: true }] });
    if (url.pathname === "/v1.0/me/todo/lists") return json({ value: [] });
    if (url.pathname === `/v1.0/me/calendars/${encodeURIComponent(calendar)}`) return json({ id: calendar, canViewPrivateItems: true });
    if (url.pathname.endsWith("/events/old-removed") || removed && url.pathname.endsWith("/events/occurrence-1")) {
      res.statusCode = 404; return json({ error: { code: "ErrorItemNotFound" } });
    }
    if (url.pathname === deltaPath) {
      deltaPaths.push(url.pathname);
      if (prime) return json({ value: [], "@odata.deltaLink": deltaLink("original") });
      return json({ value: removed
        ? [{ id: "occurrence-1", seriesMasterId: masterID, "@removed": { reason: "deleted" } }]
        : [
          { ...stub("ordinary"), seriesMasterId: undefined, type: "singleInstance", subject: "Precedes failure" },
          { id: "old-removed", "@removed": { reason: "deleted" } },
          stub("occurrence-1"), stub("occurrence-2"),
        ], "@odata.deltaLink": deltaLink("next") });
    }
    if (url.pathname.endsWith(`/events/${encodeURIComponent(masterID)}`)) {
      masterPaths.push(url.pathname);
      assert.match(String(req.headers.prefer), /outlook.timezone="UTC"/);
      if (failure === "network") return req.socket.destroy();
      if (failure === "json") return res.end("not JSON");
      if (failure === "null") return json(null);
      res.statusCode = failure;
      return json(failure === 200
        ? { ...stub(masterID), type: "seriesMaster", subject: "Hydrated all-day series", isAllDay: true, body: { content: "Inherited body" } }
        : { error: { message: "Master unavailable" } });
    }
    res.statusCode = 500;
    return json({ error: { message: `Unexpected fixture route ${url.pathname}` } });
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://graph.microsoft.com", "No real provider calls");
    return realFetch(`${origin}${url.pathname}${url.search}`, init);
  };
  await db.insert(user).values({ id: userID, name: "Hydration", email: `${userID}@example.test` });
  try {
    await db.insert(account).values({ id: randomUUID(), userId: userID, providerId: "microsoft", accountId: "account",
      scope: "Calendars.ReadWrite Tasks.ReadWrite", refreshToken: "fixture-refresh", accessToken: "fixture-access",
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    });
    const { id: calendarID } = await importExternalCalendar("microsoft", userID, "account", "Fixture", { externalId: calendar, name: "Shared", color: "#7A8BA3" });
    await reconcileMicrosoftCalendarAccess(userID, "account", calendarID, { canEdit: false, canViewPrivateItems: true });
    const sync = () => syncProvider(microsoftAdapter, userID, { id: "account", label: "Fixture" });
    await sync(); prime = false;
    const oldCursor = (await getUserExternalCalendars("microsoft", userID, "account"))[0].cursor!;
    assert.equal(JSON.parse(oldCursor).version, 2);
    assert.equal(JSON.parse(oldCursor).link, deltaLink("original"));
    for (const id of ["occurrence-1", "old-removed"]) await upsertExternalEvent("microsoft", userID, calendarID, calendar, id, {
      title: "Original", color: "#7A8BA3", start: new Date("2026-09-10T00:00:00Z"), end: new Date("2026-09-11T00:00:00Z"),
      isAllDay: false, description: null, location: null, organizer: "", recurrence: null, url: null,
    });
    const eventsBefore = await db.select().from(events).where(eq(events.creatorID, userID));
    const cursor = async () => (await getUserExternalCalendars("microsoft", userID, "account"))[0].cursor;
    for (const status of [503, 429, 500, 403, 404, 410, "network", "json", "null"] as const) {
      failure = status;
      await assert.rejects(sync(), typeof status === "number" ? new RegExp(`Outlook ${status}`) : Error);
      assert.equal(await cursor(), oldCursor, `${status}: incomplete hydration cannot advance cursor`);
      assert.deepEqual(await db.select().from(events).where(eq(events.creatorID, userID)), eventsBefore, `${status}: no partial imports or fabricated tombstones`);
    }
    assert.ok(deltaPaths.every((path) => path === deltaPath));
    assert.ok(masterPaths.every((path) => path === `/v1.0/me/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(masterID)}`), "Master lookup must remain in the shared calendar's scope");
    failure = 200;
    masterPaths.length = 0;
    await sync();
    assert.equal(masterPaths.length, 1, "Successful master cache is per delta attempt");
    assert.equal(JSON.parse((await cursor())!).link, deltaLink("next"));
    const stored = await db.select().from(events).where(eq(events.creatorID, userID));
    const hydrated = stored.filter((event) => event.title === "Hydrated all-day series");
    assert.equal(hydrated.length, 2, "Retry updates the known occurrence and imports the missing one");
    assert.ok(hydrated.every((event) => event.isAllDay && event.description === "Inherited body" && event.end.toISOString() === "2026-09-10T00:00:00.000Z"));
    assert.equal(stored.filter((event) => event.deletedAt).length, 1);
    await sync();
    assert.equal((await db.select().from(events).where(eq(events.creatorID, userID))).length, stored.length, "Replay creates no duplicate occurrences");
    // A known removal with two exact 404s and current private-read authority is
    // complete without a series master, even when that master is gone.
    removed = true;
    failure = 404;
    masterPaths.length = 0;
    await sync();
    assert.equal(masterPaths.length, 0);
    assert.equal((await db.select().from(events).where(eq(events.creatorID, userID))).filter((event) => event.deletedAt).length, 2);
    console.log("K02 Graph hydration: 503/429/5xx/403/404/410/network/invalid payload preserve cursor and DB; scoped retry imports; explicit removal skips hydration OK");
  } finally {
    globalThis.fetch = realFetch;
    await db.delete(user).where(eq(user.id, userID));
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
