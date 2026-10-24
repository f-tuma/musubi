import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import {
  account,
  CALENDAR_SCOPE,
  db,
  saveCaldavAccount,
  user,
  createCalendar, createEvent, externalCalendars, eventOutbox, externalEvents,
  claimEventOutbox, upsertExternalEvent, getEvent,
} from "@musubi/db";
import { EventSchema } from "@musubi/types";
import { encryptSecret } from "../crypto";
import { googleAdapter } from "./google";
import { microsoftAdapter } from "./microsoft";
import { caldavAdapter } from "./caldav";
import {
  caldavEventCreateIdentity,
  googleEventCreateID,
} from "../event_create_identity";
import { ProviderEventWriteError } from "../event_write";
import { deliverEventOutbox } from "../event_delivery";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const owner = `create-recovery-${randomUUID()}`;
  const objects = new Map<
    string,
    { json?: any; data?: string; etag: string }
  >();
  const requests: {
    method: string;
    path: string;
    body: string;
    ifNoneMatch?: string;
  }[] = [];
  let loseResponse = false;
  let graphMode: "normal" | "duplicate" | "foreign" | "page-failure" | "empty" =
    "normal";
  let writes = 0;
  let partialRead = false;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const url = new URL(req.url!, "http://fixture.test");
      const auth = req.headers.authorization ?? "";
      const key = `${auth}:${url.pathname}`;
      const stored = objects.get(key);
      requests.push({
        method: req.method!,
        path: url.pathname,
        body,
        ifNoneMatch: req.headers["if-none-match"] as string | undefined,
      });
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.method === "GET" && url.pathname.includes("/users/me/calendarList/"))
        return json({ id: decodeURIComponent(url.pathname.split("/calendarList/")[1]!), accessRole: "owner" });
      if (
        req.method === "GET" &&
        url.pathname.startsWith("/v1.0/") &&
        url.pathname.endsWith("/events")
      ) {
        const values = [...objects.entries()]
          .filter(([id]) => id.startsWith(`${key}/`))
          .map(([, value]) => {
            const selected = url.searchParams.get("$select")?.split(",");
            return selected
              ? Object.fromEntries(
                  Object.entries(value.json).filter(
                    ([name]) =>
                      selected.includes(name) || name === "@odata.etag",
                  ),
                )
              : value.json;
          });
        if (url.searchParams.has("$skiptoken")) {
          if (graphMode === "page-failure") return json({}, 503);
          return json({
            value:
              graphMode === "duplicate" && values[0]
                ? [{ ...values[0], id: "other-id" }]
                : [],
          });
        }
        return json({
          value: values,
          "@odata.nextLink":
            graphMode === "empty"
              ? ""
              : graphMode === "foreign"
                ? "https://attacker.invalid/events"
                : `https://graph.microsoft.com${url.pathname}?$skiptoken=next`,
        });
      }
      if (req.method === "GET") {
        if (partialRead) return json({}, 206);
        if (!stored) return json({}, 404);
        if (stored.data !== undefined) {
          res.writeHead(200, {
            "content-type": "text/calendar",
            etag: stored.etag,
          });
          return res.end(stored.data);
        }
        return json({ ...stored.json, etag: stored.etag });
      }
      if (req.method === "PUT") {
        if (req.headers["if-none-match"] !== "*")
          return json({ error: "conditional create required" }, 400);
        if (stored) return json({}, 412);
        const etag = `"dav-${++writes}"`;
        objects.set(key, { data: body, etag });
        if (loseResponse) {
          loseResponse = false;
          return req.socket.destroy();
        }
        res.writeHead(201, { etag });
        return res.end();
      }
      if (req.method === "POST") {
        const data = JSON.parse(body);
        const google = url.pathname.startsWith("/calendar/");
        const id = google ? data.id : `graph-${writes + 1}`;
        if (
          google &&
          (typeof id !== "string" || !/^[a-v0-9]{5,1024}$/.test(id))
        )
          return json({}, 400);
        if (objects.has(`${key}/${id}`)) return json({}, 409);
        const etag = `"json-${++writes}"`;
        const value = {
          ...data,
          id,
          ...(google
            ? { etag }
            : {
                "@odata.etag": etag,
                onlineMeeting: { joinUrl: "https://meeting.example.test/join" },
              }),
        };
        objects.set(`${key}/${id}`, { json: value, etag });
        if (loseResponse) {
          loseResponse = false;
          return req.socket.destroy();
        }
        return json(value, 201);
      }
      return json({}, 405);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.origin === origin) return realFetch(input, init);
    assert.ok(
      ["https://www.googleapis.com", "https://graph.microsoft.com"].includes(
        url.origin,
      ),
      "no live or untrusted destination",
    );
    return realFetch(`${origin}${url.pathname}${url.search}`, init).then(response => {
      // Loopback routing is a fixture transport, not a provider redirect.
      Object.defineProperty(response, "url", { value: url.href });
      return response;
    });
  };
  await db
    .insert(user)
    .values({ id: owner, name: owner, email: `${owner}@example.test` });
  try {
    await db.insert(account).values(
      ["google", "microsoft"].flatMap((provider) =>
        ["primary", "sibling"].map((id) => ({
          id: randomUUID(),
          userId: owner,
          providerId: provider,
          accountId: id,
          scope: CALENDAR_SCOPE[provider as "google" | "microsoft"],
          accessToken: `${provider}-${id}`,
          refreshToken: "fixture",
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        })),
      ),
    );
    const event = EventSchema.parse({
      id: randomUUID(),
      creatorID: owner,
      organizer: owner,
      title: "Recovered",
      color: "#112233",
      start: "2026-01-01T09:00:00Z",
      end: "2026-01-01T10:00:00Z",
      isAllDay: false,
      isCanceled: false,
      calendars: [randomUUID()],
      description: "Preserve",
      location: "Room",
    });
    const conflict = (error: unknown) =>
      error instanceof ProviderEventWriteError &&
      error.code === "provider-conflict";
    const identity = { operationID: randomUUID().toUpperCase() };
    loseResponse = true;
    await assert.rejects(() =>
      googleAdapter.pushCreate(owner, "primary", "remote", event, identity),
    );
    const googleFound = await googleAdapter.findCreatedEvent!(
      owner,
      "primary",
      "remote",
      identity,
    );
    assert.equal(
      googleFound?.ref.externalEventId,
      googleEventCreateID(identity),
    );
    assert.equal(googleFound?.event.title, event.title);
    assert.equal(
      await googleAdapter.findCreatedEvent!(
        owner,
        "sibling",
        "remote",
        identity,
      ),
      null,
    );
    const before = writes;
    await assert.rejects(() =>
      googleAdapter.pushCreate(owner, "primary", "remote", event, identity),
    );
    assert.equal(
      writes,
      before,
      "replayed Google create cannot create a second resource",
    );
    partialRead = true;
    await assert.rejects(() =>
      googleAdapter.findCreatedEvent!(owner, "primary", "remote", identity),
    );
    partialRead = false;
    const googleStored = objects.get(
      `Bearer google-primary:/calendar/v3/calendars/remote/events/${googleEventCreateID(identity)}`,
    )!;
    googleStored.json.extendedProperties.private.musubiOperationID =
      randomUUID();
    await assert.rejects(
      () =>
        googleAdapter.findCreatedEvent!(owner, "primary", "remote", identity),
      conflict,
    );

    const graphIdentity = { operationID: randomUUID() };
    loseResponse = true;
    await assert.rejects(() =>
      microsoftAdapter.pushCreate(
        owner,
        "primary",
        "remote",
        event,
        graphIdentity,
      ),
    );
    const graphFound = await microsoftAdapter.findCreatedEvent!(
      owner,
      "primary",
      "remote",
      graphIdentity,
    );
    assert.equal(graphFound?.event.title, event.title);
    assert.ok(graphFound?.ref.externalEventId);
    assert.equal(graphFound?.event.url, "https://meeting.example.test/join");
    assert.equal(
      await microsoftAdapter.findCreatedEvent!(owner, "primary", "remote", {
        operationID: randomUUID(),
      }),
      null,
    );
    assert.equal(
      await microsoftAdapter.findCreatedEvent!(
        owner,
        "sibling",
        "remote",
        graphIdentity,
      ),
      null,
    );
    graphMode = "empty";
    await assert.rejects(() =>
      microsoftAdapter.findCreatedEvent!(
        owner,
        "primary",
        "remote",
        graphIdentity,
      ),
    );
    graphMode = "page-failure";
    await assert.rejects(() =>
      microsoftAdapter.findCreatedEvent!(
        owner,
        "primary",
        "remote",
        graphIdentity,
      ),
    );
    graphMode = "duplicate";
    await assert.rejects(
      () =>
        microsoftAdapter.findCreatedEvent!(
          owner,
          "primary",
          "remote",
          graphIdentity,
        ),
      conflict,
    );
    graphMode = "foreign";
    await assert.rejects(() =>
      microsoftAdapter.findCreatedEvent!(
        owner,
        "primary",
        "remote",
        graphIdentity,
      ),
    );
    graphMode = "normal";

    const dav = await saveCaldavAccount(
      owner,
      `${origin}/dav/`,
      "owner",
      encryptSecret("fixture"),
    );
    const calendar = `${origin}/dav/calendar/`;
    const davIdentity = { operationID: randomUUID() };
    loseResponse = true;
    await assert.rejects(() =>
      caldavAdapter.pushCreate(owner, dav.id, calendar, event, davIdentity),
    );
    const davFound = await caldavAdapter.findCreatedEvent!(
      owner,
      dav.id,
      calendar,
      davIdentity,
    );
    const destination = caldavEventCreateIdentity(calendar, davIdentity);
    assert.equal(davFound?.ref.externalEventId, destination.url);
    assert.equal(davFound?.ref.icalUid, destination.uid);
    assert.equal(davFound?.event.title, event.title);
    const davWrites = writes;
    await assert.rejects(
      () =>
        caldavAdapter.pushCreate(owner, dav.id, calendar, event, davIdentity),
      conflict,
    );
    assert.equal(writes, davWrites);
    assert.equal(
      await caldavAdapter.findCreatedEvent!(owner, dav.id, calendar, {
        operationID: randomUUID(),
      }),
      null,
    );
    const put = requests.find((req) => req.method === "PUT")!;
    assert.equal(put.ifNoneMatch, "*");
    assert.ok(put.body.includes(`UID:${destination.uid}`));
    const davStored = objects.get(
      `Basic ${Buffer.from("owner:fixture").toString("base64")}:${new URL(destination.url).pathname}`,
    )!;
    davStored.data = davStored.data!.replace(
      `UID:${destination.uid}`,
      "UID:foreign-object",
    );
    await assert.rejects(() =>
      caldavAdapter.findCreatedEvent!(owner, dav.id, calendar, davIdentity),
    );
    assert.equal(
      requests.filter(
        (req) => req.method === "POST" && req.path.startsWith("/v1.0/"),
      ).length,
      1,
      "Graph recovery is read-only; no assumed unlimited transactionId replay window",
    );
    for (const adapter of [googleAdapter, microsoftAdapter, caldavAdapter]) {
      for (const isAllDay of [false, true]) {
      const local = await createCalendar({ creatorID: owner, name: "Worker recovery", color: "#112233" });
      const remoteCalendar = adapter.provider === "caldav" ? `${origin}/worker-${local.id}/` : `worker-${local.id}`;
      const accountID = adapter.provider === "caldav" ? dav.id : "primary";
      const [link] = await db.insert(externalCalendars).values({
        provider: adapter.provider, userID: owner, accountID, calendarID: local.id, externalCalendarID: remoteCalendar,
      }).returning();
      const value = { ...event, isAllDay, start: new Date("2026-01-01T09:00:00.123Z"), end: new Date("2026-01-01T10:00:00.456Z"), description: "  Preserve whitespace  ", id: randomUUID(), originCalendarID: local.id, calendars: [local.id] };
      const operationID = randomUUID();
      await createEvent(value, [local.id], [{
        id: operationID, actorID: owner, mutationID: randomUUID(), position: 0,
        eventID: value.id, calendarID: local.id, externalCalendarLinkID: link.id,
        provider: adapter.provider, userID: owner, accountID, externalCalendarID: remoteCalendar,
        action: "create", payload: { event: value, createIdentityVersion: 1 },
      }]);
      await claimEventOutbox(operationID);
      loseResponse = true;
      await assert.rejects(() => adapter.pushCreate(owner, accountID, remoteCalendar, value, { operationID }));
      const remote = await adapter.findCreatedEvent!(owner, accountID, remoteCalendar, { operationID });
      assert.ok(remote);
      // Pull races the lost ACK. It must not import a second local event.
      await upsertExternalEvent(adapter.provider, owner, local.id, remoteCalendar, remote.ref.externalEventId, {
        ...remote.event, color: "#112233", organizer: remote.event.organizer ?? "",
      }, remote.ref.etag ?? null, remote.ref.icalUid ?? null, operationID);
      assert.equal((await getEvent(value.id)).revision, 1);
      assert.equal((await db.select().from(externalEvents).where(eq(externalEvents.calendarID, local.id))).length, 0);
      await db.update(eventOutbox).set({ leaseUntil: new Date(0) }).where(eq(eventOutbox.id, operationID));
      const writesBeforeRecovery = writes;
      const results = await Promise.all([
        deliverEventOutbox(operationID, () => adapter), deliverEventOutbox(operationID, () => adapter),
      ]);
      assert.ok(results.some((result) => result?.status === "completed"));
      assert.equal(writes, writesBeforeRecovery, "restart reconciliation never sends a second create");
      const [mapping] = await db.select().from(externalEvents).where(eq(externalEvents.eventID, value.id));
      assert.equal(mapping.externalEventID, remote.ref.externalEventId);
      assert.equal(mapping.etag, remote.ref.etag);
      }
    }
    console.log(
      "K08a provider create identity and lost-response recovery: Google, Graph paging, CalDAV conditional resource OK",
    );
  } finally {
    globalThis.fetch = realFetch;
    await db.delete(user).where(eq(user.id, owner));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
