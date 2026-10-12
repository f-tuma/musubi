import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import { EventSchema, TaskSchema } from "@musubi/types";
import { encodeEventV1, encodeTaskV1 } from "@musubi/sync-codec";
import { db, user, account, saveCaldavAccount } from "@musubi/db";
import { googleAdapter, createGoogleTask, updateGoogleTask } from "./adapters/google";
import { microsoftAdapter, createMicrosoftTask, updateMicrosoftTask } from "./adapters/microsoft";
import { caldavAdapter } from "./adapters/caldav";
import { caldavEventCreateIdentity } from "./event_create_identity";
import { encryptSecret } from "./crypto";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Use a disposable test database");
  const owner = `pinned-body-${randomUUID()}`;
  const acceptedAt = "2026-10-12T10:00:00.000Z";
  const requests: { method: string; path: string; body: string }[] = [];
  const davObjects = new Map<string, string>();
  const events = new Map<string, Record<string, unknown>>();
  let loseReply = false;
  const beforeEvent = { id: "native", subject: "Before", summary: "Before", etag: '"accepted"',
    "@odata.etag": 'W/"accepted"', type: "singleInstance", isCancelled: false, isOrganizer: true,
    isDraft: false, recurrence: null, seriesMasterId: null, attendees: [], isOnlineMeeting: false,
    onlineMeeting: null, onlineMeetingUrl: null, organizer: { self: true, emailAddress: { address: "self@example.test" } },
    body: { contentType: "text", content: "Before" }, location: { displayName: "Before" },
    start: { dateTime: "2026-10-01T09:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-10-01T10:00:00Z", timeZone: "UTC" } };
  const xmlEscape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const fixture = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://fixture.test"), method = req.method!;
      let body = ""; for await (const chunk of req) body += chunk;
      requests.push({ method, path: url.pathname, body });
      const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      const xml = (value: string) => { res.writeHead(207, { "content-type": "application/xml" }); res.end(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${value}</d:multistatus>`); };
      const row = (href: string, props: string) => `<d:response><d:href>${xmlEscape(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
      if (method === "PROPFIND") {
        const props = body.includes("current-user-principal")
          ? "<d:current-user-principal><d:href>/dav/principal/</d:href></d:current-user-principal>"
          : body.includes("calendar-home-set") ? "<c:calendar-home-set><d:href>/dav/home/</d:href></c:calendar-home-set>"
          : body.includes("current-user-privilege-set") ? "<d:current-user-privilege-set><d:privilege><d:all/></d:privilege></d:current-user-privilege-set>"
          : "<d:resourcetype><d:collection/></d:resourcetype>";
        return xml(row(url.pathname, props));
      }
      if (method === "REPORT") {
        const href = /<(?:\w+:)?href[^>]*>([^<]+)<\/(?:\w+:)?href>/.exec(body)?.[1];
        assert.ok(href, "multiget must identify the accepted resource");
        const path = new URL(href!, origin).pathname;
        const resource = davObjects.get(path); assert.ok(resource);
        return xml(row(path, `<d:getetag>"accepted"</d:getetag><c:calendar-data>${xmlEscape(resource!)}</c:calendar-data>`));
      }
      if (method === "GET") {
        if (url.pathname.startsWith("/dav/")) {
          const resource = davObjects.get(url.pathname);
          if (!resource) { res.writeHead(404); return res.end(); }
          res.writeHead(200, { "content-type": "text/calendar", etag: '"accepted"' }); return res.end(resource);
        }
        if (url.pathname === "/v1.0/me") return json({ id: "me", mail: "self@example.test" });
        if (url.pathname === "/v1.0/me/calendars/calendar") return json({ id: "calendar", canEdit: true, owner: { address: "self@example.test" } });
        if (url.pathname.includes("calendarList")) return json({ accessRole: "owner" });
        if (url.pathname.endsWith("/events/native")) return json(beforeEvent);
        if (url.pathname.endsWith("/events")) return json({ value: [...events.values()] });
        const stored = events.get(url.pathname); if (stored) return json(stored);
        if (url.pathname.includes("/tasks/")) return json({ id: "task", title: "Before", status: "needsAction", etag: '"accepted"' });
        return json({}, 404);
      }
      if (method === "PUT") {
        davObjects.set(url.pathname, body);
        if (loseReply) { loseReply = false; return res.destroy(); }
        res.writeHead(201, { etag: '"written"' }); return res.end();
      }
      if (method === "POST") {
        const value = JSON.parse(body);
        if (url.pathname.endsWith("/events")) {
          const google = url.pathname.startsWith("/calendar/");
          const id = google ? value.id : `native-${value.transactionId}`;
          const stored = { ...value, id, etag: '"created"', "@odata.etag": 'W/"created"', status: "confirmed", isCancelled: false };
          events.set(`${url.pathname}/${id}`, stored);
          if (loseReply) { loseReply = false; return res.destroy(); }
          return json(stored, 201);
        }
        return json({ id: "task", etag: '"created"', "@odata.etag": 'W/"created"' }, 201);
      }
      assert.equal(method, "PATCH");
      return json({ id: url.pathname.endsWith("/native") ? "native" : "task", etag: '"written"', "@odata.etag": 'W/"written"' });
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    assert.ok([origin, "https://www.googleapis.com", "https://tasks.googleapis.com", "https://graph.microsoft.com"].includes(url.origin), "no live provider or token endpoint");
    return originalFetch(url.origin === origin ? input : `${origin}${url.pathname}${url.search}`, init);
  };
  const mutations = () => requests.filter(value => ["POST", "PATCH", "PUT", "DELETE"].includes(value.method));
  const lastMutation = () => { const values = mutations(); return values[values.length - 1]!; };
  await db.insert(user).values({ id: owner, name: "Pinned body", email: `${owner}@example.test` });
  try {
    await db.insert(account).values(["google", "microsoft"].map(provider => ({ id: randomUUID(), userId: owner,
      providerId: provider, accountId: "fixture", scope: provider === "google" ? "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks" : "Calendars.ReadWrite Tasks.ReadWrite",
      accessToken: "pinned.fixture", refreshToken: "fixture", accessTokenExpiresAt: new Date(Date.now() + 3_600_000) })));
    const dav = await saveCaldavAccount(owner, `${origin}/dav/`, "fixture", encryptSecret("fixture"));
    const calendar = `${origin}/dav/home/calendar/`;
    const eventA = EventSchema.parse({ id: randomUUID(), creatorID: owner, calendars: [randomUUID()], title: "Admitted A",
      description: "Notes A", location: "Location A", color: "#112233", organizer: owner,
      start: "2026-10-01T09:00:00Z", end: "2026-10-01T10:00:00Z", isAllDay: false, isCanceled: false });
    const eventB = { ...eventA, title: "Mapper B", description: "Notes B", location: "Location B" };
    for (const provider of ["google", "microsoft", "caldav"] as const) {
      const operationID = randomUUID(), identity = { operationID };
      const uid = provider === "caldav" ? caldavEventCreateIdentity(calendar, identity).uid : undefined;
      const plan = encodeEventV1(provider, eventA, undefined, { action: "create", operationId: operationID, uid, acceptedAt }).nativePlan.data;
      const adapter = provider === "google" ? googleAdapter : provider === "microsoft" ? microsoftAdapter : caldavAdapter;
      const accountID = provider === "caldav" ? dav.id : "fixture", collection = provider === "caldav" ? calendar : "calendar";
      loseReply = true;
      const start = mutations().length;
      await assert.rejects(() => adapter.pushCreate(owner, accountID, collection, eventB, identity, plan));
      const write = mutations()[start]; assert.ok(write);
      if (plan.planKind === "json-body") assert.deepEqual(JSON.parse(write.body), plan.body);
      else assert.equal(write.body, plan.createResource);
      assert.equal(write.body.includes("Mapper B"), false);
      const observed = await adapter.findCreatedEvent!(owner, accountID, collection, identity);
      assert.equal(observed?.event.title, "Admitted A");
      assert.equal(mutations().length, start + 1, "lost reply recovery only observes the accepted A body");
      const update = encodeEventV1(provider, eventA, { title: eventA.title, description: eventA.description },
        { action: "update", operationId: randomUUID(), uid: provider === "caldav" ? "native-uid" : undefined, acceptedAt }).nativePlan.data;
      const ref = { externalEventId: provider === "caldav" ? `${calendar}native.ics` : "native",
        etag: provider === "microsoft" ? 'W/"accepted"' : '"accepted"', icalUid: provider === "caldav" ? "native-uid" : undefined };
      davObjects.set(new URL(`${calendar}native.ics`).pathname, "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:native-uid\r\nSUMMARY:Before\r\nDESCRIPTION:Before\r\nDTSTART:20261001T090000Z\r\nDTEND:20261001T100000Z\r\nX-PROVIDER-PRIVATE:keep\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
      await adapter.pushUpdate(owner, accountID, collection, ref.externalEventId, eventB, ref,
        { title: eventB.title, description: eventB.description }, undefined, update);
      const updated = lastMutation();
      assert.equal(updated.body.includes("Mapper B"), false);
      if (update.planKind === "json-body") assert.deepEqual(JSON.parse(updated.body), update.body);
      else { assert.match(updated.body, /SUMMARY:Admitted A/); assert.match(updated.body, /X-PROVIDER-PRIVATE:keep/); }
    }
    const taskA = TaskSchema.parse({ id: randomUUID(), creatorID: owner, calendarID: randomUUID(), title: "Task A",
      description: "Task notes A", due: "2026-10-01T12:00:00Z", sequence: 3 });
    const taskB = { ...taskA, title: "Task mapper B", description: "Task notes B", due: new Date("2026-10-02T15:00:00Z"), sequence: 42 };
    for (const provider of ["google", "microsoft", "caldav"] as const) {
      const create = encodeTaskV1(provider, taskA, undefined, { action: "create", operationId: randomUUID(), uid: taskA.id, acceptedAt }).nativePlan.data;
      if (provider === "google") await createGoogleTask("fixture", "list", taskB, { baseUrl: `${origin}/tasks/v1`, nativePlan: create });
      else if (provider === "microsoft") await createMicrosoftTask("fixture", "list", taskB, { graphBase: `${origin}/v1.0`, nativePlan: create });
      else await caldavAdapter.pushTaskCreate!(owner, dav.id, calendar, taskB, async () => {}, undefined, create);
      const created = lastMutation();
      if (create.planKind === "json-body") assert.deepEqual(JSON.parse(created.body), create.body);
      else { assert.equal(created.body, create.createResource); assert.match(created.body, /DTSTAMP:20261012T100000Z/); }
      assert.equal(created.body.includes("Task mapper B"), false);
      const update = encodeTaskV1(provider, taskA, undefined, { action: "update", operationId: randomUUID(), uid: "task-native", acceptedAt }).nativePlan.data;
      if (provider === "google") await updateGoogleTask("fixture", "list", "task", taskB, '"accepted"', { baseUrl: `${origin}/tasks/v1`, nativePlan: update, patch: { title: taskA.title } });
      else if (provider === "microsoft") await updateMicrosoftTask("fixture", "list", "task", taskB, 'W/"accepted"', { graphBase: `${origin}/v1.0`, nativePlan: update, patch: { title: taskA.title } });
      else {
        const target = `${calendar}task.ics`;
        davObjects.set(new URL(target).pathname, "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:task-native\r\nSUMMARY:Before\r\nDTSTAMP:20260901T000000Z\r\nDUE:20261003T120000Z\r\nX-PROVIDER-PRIVATE:keep\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nDESCRIPTION:Keep\r\nEND:VALARM\r\nEND:VTODO\r\nEND:VCALENDAR\r\n");
        await caldavAdapter.pushTaskUpdate!(owner, dav.id, calendar, target, taskB,
          { externalTaskId: target, etag: '"accepted"', icalUid: "task-native", beforeMutation: async () => {} }, { title: taskA.title }, undefined, update);
      }
      const updated = lastMutation();
      if (update.planKind === "json-body") assert.deepEqual(JSON.parse(updated.body), { title: "Task A" }, "late baseline chooses fields from admitted target only");
      else { assert.match(updated.body, /SUMMARY:Task A/); assert.match(updated.body, /DUE:20261003T120000Z/); assert.match(updated.body, /BEGIN:VALARM/); assert.match(updated.body, /X-PROVIDER-PRIVATE:keep/); }
      assert.equal(updated.body.includes("Task mapper B"), false);
    }
    console.log("Pinned transports: actual HTTP A bodies, lost-reply observation, late task patches and DAV native-property preservation passed");
  } finally {
    globalThis.fetch = originalFetch;
    await db.delete(user).where(eq(user.id, owner));
    await new Promise<void>(resolve => fixture.close(() => resolve()));
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
