import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(
      new URL(process.env.DATABASE_URL!).hostname,
    ),
  );
  const { default: express } = await import("express");
  const { eq, and, sql } = await import("drizzle-orm");
  const { config } = await import("@musubi/config");
  const {
    db,
    user,
    memberTokens,
    caldavAccounts,
    externalCalendars,
    syncReadWork,
    events,
  } = await import("@musubi/db");
  const previousPrivate = config.security.federationAllowPrivateHosts;
  config.security.federationAllowPrivateHosts = true;
  const { initializeSyncEngine } = await import("./engine");
  const { stopSyncWorkCoordinator } = await import("./work_coordinator");
  const { handlerConnectCaldav } = await import("../handlers/caldav");
  const { requireAuth } = await import("../middleware/require_auth");
  const { middlewareErrorHandler } =
    await import("../middleware/error_handler");
  const { issueMemberToken } = await import("../federation_tokens");
  const { CLIENT_VERSION_HEADER, PRODUCT_VERSION } =
    await import("@musubi/types");
  const owner = `dav-initial-${randomUUID()}`,
    token = issueMemberToken();
  let origin = "",
    invalidResource = false,
    fixtureFailure: unknown;
  const nativeMethods: string[] = [];
  const description = "<!DOCTYPE html><html>Preserved fixture notes</html>";
  const document = (rows: string) =>
    `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${rows}</d:multistatus>`;
  const row = (href: string, props: string) =>
    `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  const fixture = createServer(async (req, res) => {
    try {
      nativeMethods.push(req.method!);
      assert.ok(
        ["GET", "PROPFIND", "REPORT"].includes(req.method!),
        "No native writes",
      );
      if (
        req.headers.authorization !==
        `Basic ${Buffer.from("fixture:password").toString("base64")}`
      ) {
        res.writeHead(401);
        res.end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      if (req.method === "GET") {
        assert.equal(req.url, "/.well-known/caldav");
        res.writeHead(204);
        res.end();
        return;
      }
      const href = origin + req.url,
        index = Number(/calendar-(\d+)/.exec(req.url!)?.[1] ?? 0);
      let rows: string;
      if (body.includes("current-user-principal"))
        rows = row(
          href,
          "<d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal>",
        );
      else if (body.includes("calendar-home-set"))
        rows = row(
          href,
          "<c:calendar-home-set><d:href>/home/</d:href></c:calendar-home-set>",
        );
      else if (body.includes("current-user-privilege-set"))
        rows = row(
          href,
          "<d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>",
        );
      else if (body.includes("supported-report-set"))
        rows = row(href, "<d:supported-report-set/>");
      else if (body.includes("calendar-multiget")) {
        const data = [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "BEGIN:VEVENT",
          `UID:event-${index}`,
          "DTSTART:20261101T090000Z",
          "DTEND:20261101T100000Z",
          `SUMMARY:Calendar ${index}`,
          `DESCRIPTION:${description}`,
          "END:VEVENT",
          "END:VCALENDAR",
          "",
        ].join("\r\n");
        rows = row(
          `${origin}/home/calendar-${index}/event.ics`,
          `<d:getetag>"event-${index}"</d:getetag><c:calendar-data><![CDATA[${data}]]></c:calendar-data>`,
        );
        if (invalidResource && index === 0) {
          res.writeHead(207, { "content-type": "application/xml" });
          res.end("<!DOCTYPE d:multistatus>" + document(rows));
          return;
        }
      } else if (body.includes("resourcetype")) {
        rows =
          row(href, "<d:resourcetype><d:collection/></d:resourcetype>") +
          (req.url === "/home/"
            ? Array.from({ length: 9 }, (_, n) =>
                row(
                  `${origin}/home/calendar-${n}/`,
                  `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Calendar ${n}</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>`,
                ),
              ).join("")
            : "");
      } else
        rows =
          row(href, '<d:getetag>"collection"</d:getetag>') +
          row(href + "event.ics", `<d:getetag>"event-${index}"</d:getetag>`);
      res.writeHead(207, { "content-type": "application/xml" });
      res.end(document(rows));
    } catch (error) {
      fixtureFailure = error;
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const app = express();
  app.use(express.json());
  app.post(
    "/api/v1/users/connections/caldav",
    requireAuth,
    handlerConnectCaldav,
  );
  app.use(middlewareErrorHandler);
  const api = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => api.once("listening", resolve));
  const apiOrigin = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  const connect = (password = "password", authenticated = true) =>
    fetch(`${apiOrigin}/api/v1/users/connections/caldav`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CLIENT_VERSION_HEADER]: PRODUCT_VERSION,
        ...(authenticated ? { authorization: `Bearer ${token.raw}` } : {}),
      },
      body: JSON.stringify({
        serverUrl: origin,
        username: "fixture",
        password,
      }),
      signal: AbortSignal.timeout(45_000),
    });
  await db
    .insert(user)
    .values({
      id: owner,
      name: "Owned initial sync fixture",
      email: `${owner}@example.test`,
      isExternal: true,
    });
  await db
    .insert(memberTokens)
    .values({ userID: owner, tokenHash: token.tokenHash });
  initializeSyncEngine(["pull"]);
  try {
    assert.equal((await connect("password", false)).status, 401);
    assert.equal(nativeMethods.length, 0);
    assert.equal((await connect("wrong-password")).status, 400);
    assert.equal(
      (
        await db
          .select()
          .from(caldavAccounts)
          .where(eq(caldavAccounts.userID, owner))
      ).length,
      0,
    );
    const first = await connect();
    assert.equal(first.status, 200, await first.text());
    const sources = await db
      .select()
      .from(externalCalendars)
      .where(eq(externalCalendars.userID, owner));
    assert.equal(sources.length, 9);
    const imported = await db
      .select()
      .from(events)
      .where(eq(events.creatorID, owner));
    assert.equal(imported.length, 9);
    assert.ok(imported.every((event) => event.description === description));
    const work = await db
      .select()
      .from(syncReadWork)
      .where(eq(syncReadWork.userID, owner));
    assert.equal(work.length, 10);
    for (const item of work) {
      assert.equal(item.requestedGeneration, item.completedGeneration);
      assert.equal(item.claimToken, null);
      assert.equal(item.leaseUntil, null);
    }
    const discovery = work.find((item) => item.stream === "discovery")!;
    const retryAt = new Date(Date.now() + 600_000);
    await db
      .update(syncReadWork)
      .set({ notBefore: retryAt, lastDeferralKind: "budget" })
      .where(eq(syncReadWork.id, discovery.id));
    const pending = await connect();
    assert.equal(pending.status, 202);
    assert.deepEqual(await pending.json(), {
      status: "pending",
      retryAt: retryAt.toISOString(),
    });
    const [waiting] = await db
      .select()
      .from(syncReadWork)
      .where(eq(syncReadWork.id, discovery.id));
    assert.equal(waiting!.completedGeneration, discovery.completedGeneration);
    assert.ok(
      waiting!.requestedGeneration > waiting!.completedGeneration,
      "202 is never a successful ACK",
    );
    assert.equal(
      (await db.select().from(events).where(eq(events.creatorID, owner)))
        .length,
      9,
    );

    await db
      .update(syncReadWork)
      .set({ notBefore: sql`clock_timestamp()-interval '1 millisecond'` })
      .where(eq(syncReadWork.id, discovery.id));
    stopSyncWorkCoordinator();
    initializeSyncEngine(["pull"]);
    invalidResource = true;
    const failed = await connect();
    assert.equal(
      failed.status,
      400,
      "Real native rejection must not become pending or success",
    );
    const brokenSource = sources.find((item) =>
      item.externalCalendarID.endsWith("calendar-0/"),
    )!;
    const [broken] = await db
      .select()
      .from(syncReadWork)
      .where(
        and(
          eq(syncReadWork.userID, owner),
          eq(syncReadWork.sourceID, brokenSource.id),
        ),
      );
    assert.ok(broken!.requestedGeneration > broken!.completedGeneration);
    assert.equal(broken!.lastDeferralKind, "failure");
    assert.equal(
      (await db.select().from(events).where(eq(events.creatorID, owner)))
        .length,
      9,
      "No partial response sweep",
    );
    assert.equal(fixtureFailure, undefined);
    console.log(
      JSON.stringify({
        boundary: "authenticated-http-postgres-real-engine-loopback-dav",
        collections: 9,
        initialStatus: 200,
        allTenWorkRowsAcknowledged: true,
        pendingStatus: 202,
        nativeFailureStatus: 400,
        preservedNotes: true,
        providerWrites: false,
      }),
    );
  } finally {
    stopSyncWorkCoordinator();
    config.security.federationAllowPrivateHosts = previousPrivate;
    await db.delete(user).where(eq(user.id, owner));
    fixture.closeAllConnections();
    api.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => fixture.close(() => resolve())),
      new Promise<void>((resolve) => api.close(() => resolve())),
    ]);
  }
}
main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
