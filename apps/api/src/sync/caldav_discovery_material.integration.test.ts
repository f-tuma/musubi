import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Use an owned disposable database.");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL!).hostname));
  const { and, eq, sql } = await import("drizzle-orm");
  const { config } = await import("@musubi/config");
  const { db, user, caldavAccounts, externalCalendars, syncReadWork, requestSyncReadWork, saveCaldavAccount, getOwnedCaldavAccountBinding, events, tasks } = await import("@musubi/db");
  const { encryptSecret } = await import("./crypto");
  const priorPrivate = config.security.federationAllowPrivateHosts;
  config.security.federationAllowPrivateHosts = true;
  const { caldavAdapter } = await import("./adapters/caldav");
  const { syncProvider, initializeSyncEngine, SyncWorkDeferred } = await import("./engine");
  const { stopSyncWorkCoordinator, submitSyncWork } = await import("./work_coordinator");
  const owner = `dav-material-${randomUUID()}`;
  const otherOwner = `dav-material-other-${randomUUID()}`;
  let origin = "", password = "first-password", read = true, absent = false, listingFailure = false, fixtureFailure: unknown;
  let hold: { entered(): void; wait: Promise<void> } | undefined;
  let allowedInFlightReportPassword: string | undefined;
  const calls: string[] = [];
  const accountCalls: Array<{ other: boolean; kind: string }> = [];
  const collection = () => origin + "/home/calendar/";
  const document = (rows: string) => `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${rows}</d:multistatus>`;
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const row = (href: string, properties: string) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${properties}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  const eventData = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:private-event", "DTSTART:20261026T090000Z", "DTEND:20261026T100000Z", "SUMMARY:Private event", "DESCRIPTION:Private event notes", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
  const taskData = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTODO", "UID:private-task", "SUMMARY:Private task details", "DESCRIPTION:Private task notes", "STATUS:NEEDS-ACTION", "END:VTODO", "END:VCALENDAR", ""].join("\r\n");
  const fixture = createServer(async (req, res) => {
    try {
      assert.ok(["PROPFIND", "GET", "REPORT"].includes(req.method!), "No provider writes.");
      let body = ""; for await (const chunk of req) body += chunk;
      const kind = req.url === "/.well-known/caldav" ? "service" : body.includes("current-user-principal") ? "principal" : body.includes("calendar-home-set") ? "home" : body.includes("current-user-privilege-set") ? "acl" : body.includes("supported-report-set") ? "reports" : body.includes("calendar-multiget") ? "multiget" : body.includes("resourcetype") ? "discovery" : "objects";
      const other = req.headers.authorization === `Basic ${Buffer.from("fixture-b:steady-password").toString("base64")}`;
      const oldReport = kind === "reports" && allowedInFlightReportPassword !== undefined && req.headers.authorization === `Basic ${Buffer.from(`fixture:${allowedInFlightReportPassword}`).toString("base64")}`;
      if (oldReport) allowedInFlightReportPassword = undefined;
      else if (!other) assert.equal(req.headers.authorization, `Basic ${Buffer.from(`fixture:${password}`).toString("base64")}`);
      calls.push(kind);
      accountCalls.push({ other, kind });
      if (req.method === "GET") { assert.equal(req.url, "/.well-known/caldav"); res.writeHead(204); res.end(); return; }
      const href = origin + req.url;
      let rows: string;
      if (kind === "principal") rows = row(href, "<d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal>");
      else if (kind === "home") rows = row(href, "<c:calendar-home-set><d:href>/home/</d:href></c:calendar-home-set>");
      else if (kind === "acl") rows = row(href, `<d:current-user-privilege-set>${read ? "<d:privilege><d:read/></d:privilege>" : ""}<d:privilege><c:read-free-busy/></d:privilege><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>`);
      else if (kind === "reports") rows = row(href, "<d:supported-report-set/>");
      else if (kind === "multiget") rows = row(collection() + "event.ics", `<d:getetag>"event-v1"</d:getetag><c:calendar-data>${escape(eventData)}</c:calendar-data>`) + row(collection() + "task.ics", `<d:getetag>"task-v1"</d:getetag><c:calendar-data>${escape(taskData)}</c:calendar-data>`);
      else if (kind === "objects") rows = row(collection(), '<d:getetag>"collection-v1"</d:getetag>') + row(collection() + "event.ics", '<d:getetag>"event-v1"</d:getetag>') + row(collection() + "task.ics", '<d:getetag>"task-v1"</d:getetag>');
      else {
        rows = row(href, "<d:resourcetype><d:collection/></d:resourcetype>") + (req.url === "/home/" && !absent
          ? row(collection(), '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Material fixture</d:displayname><d:sync-token>urn:fixture-material-cursor</d:sync-token><c:supported-calendar-component-set><c:comp name="VEVENT"/><c:comp name="VTODO"/></c:supported-calendar-component-set>') : "");
        if (req.url === "/home/" && hold && !other) { const active = hold; hold = undefined; active.entered(); await active.wait; }
      }
      res.writeHead(kind === "discovery" && listingFailure ? 503 : 207, { "content-type": "application/xml" });
      res.end(document(rows));
    } catch (error) { fixtureFailure = error; res.writeHead(500); res.end(); }
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  await db.insert(user).values({ id: owner, name: "Material fixture", email: `${owner}@example.test` });
  const account = await saveCaldavAccount(owner, origin, "fixture", encryptSecret(password));
  assert.ok(account);
  const accountID = account.id;
  const source = async () => (await db.select().from(externalCalendars).where(and(eq(externalCalendars.provider, "caldav"), eq(externalCalendars.userID, owner), eq(externalCalendars.accountID, accountID))))[0]!;
  const event = async () => (await db.select().from(events).where(eq(events.creatorID, owner)))[0]!;
  const task = async () => (await db.select().from(tasks).where(eq(tasks.creatorID, owner)))[0]!;
  const measure = async (run: () => Promise<unknown>) => { const before = calls.length; await run(); assert.equal(fixtureFailure, undefined); return calls.slice(before); };
  const fetch = () => caldavAdapter.fetchChanges(owner, accountID, collection(), null);
  const sync = () => syncProvider(caldavAdapter, owner, { id: accountID, label: "Fixture" });
  try {
    await db.execute(sql`update ${caldavAccounts} set updated_at='2026-10-26T12:00:00.000001'::timestamp where id=${accountID}`);
    const initialBinding = await getOwnedCaldavAccountBinding(owner, accountID);
    assert.equal(initialBinding!.credentialRevision, "2026-10-26T12:00:00.000001");
    assert.equal(await getOwnedCaldavAccountBinding("wrong-owner", accountID), null);
    const discovery = await measure(async () => { assert.equal((await caldavAdapter.listCalendars(owner, accountID)).calendars.length, 1); });
    assert.deepEqual(discovery, ["service", "service", "principal", "home", "discovery", "reports", "acl"]);
    const warm = await measure(async () => { assert.equal((await fetch()).changes.length, 2); });
    assert.deepEqual(warm, ["discovery", "reports", "objects", "multiget"]);
    const beforeWrongOwner = calls.length;
    await assert.rejects(caldavAdapter.fetchChanges("wrong-owner", accountID, collection(), null), /account not found/);
    assert.equal(calls.length, beforeWrongOwner);

    // An exact credential change at an equal SQL timestamp invalidates the cache.
    password = "rotated-password";
    await db.execute(sql`update ${caldavAccounts} set encrypted_password=${encryptSecret(password)} where id=${accountID}`);
    const rotatedBinding = await getOwnedCaldavAccountBinding(owner, accountID);
    assert.equal(rotatedBinding!.credentialRevision, initialBinding!.credentialRevision);
    assert.notEqual(rotatedBinding!.credentialFingerprint, initialBinding!.credentialFingerprint);
    const rotated = await measure(fetch);
    assert.equal(rotated.length, 8);
    await db.execute(sql`update ${caldavAccounts} set updated_at='2026-10-26T12:00:00.000002'::timestamp where id=${accountID}`);
    const precise = await measure(fetch);
    assert.equal(precise.length, 8);

    // Re-read the actual credential row before publishing discovery material.
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    hold = { entered, wait: new Promise<void>(resolve => { release = resolve; }) };
    const stale = fetch().then(() => null, error => error);
    await reached;
    // This already-started client's report may complete with its captured
    // credential. The cache's promise is refusal before publishing/returning
    // discovery, not cancellation of every earlier native HTTP continuation.
    allowedInFlightReportPassword = password;
    password = "raced-password";
    await db.execute(sql`update ${caldavAccounts} set encrypted_password=${encryptSecret(password)} where id=${accountID}`);
    release();
    assert.match(String(await stale), /account changed during discovery/);
    assert.equal(allowedInFlightReportPassword, undefined);
    const afterRace = await measure(fetch);
    assert.equal(afterRace.length, 8);

    // Composition proof uses the real durable discovery/components queue and
    // one process coordinator. Provider budgets are deliberately not bootstrapped.
    initializeSyncEngine(["pull"]);
    const firstSync = await measure(sync);
    assert.equal(firstSync.length, 11, "Fresh account discovery plus warm resource fetch.");
    assert.equal((await event()).title, "Private event");
    assert.equal((await task()).title, "Private task details");

    // Hold A's actual HTTP response while B performs discovery, native resource
    // reads and canonical/dirty ACKs through the same global coordinator.
    await db.insert(user).values({ id: otherOwner, name: "Other material fixture", email: `${otherOwner}@example.test` });
    const otherAccount = await saveCaldavAccount(otherOwner, origin, "fixture-b", encryptSecret("steady-password"));
    assert.ok(otherAccount);
    let slowEntered!: () => void, slowRelease!: () => void;
    const slowReached = new Promise<void>(resolve => { slowEntered = resolve; });
    hold = { entered: slowEntered, wait: new Promise<void>(resolve => { slowRelease = resolve; }) };
    const fairnessStart = accountCalls.length;
    const slow = sync().then(() => null, error => error);
    await slowReached;
    const [activeDiscovery] = await db.select().from(syncReadWork).where(and(eq(syncReadWork.userID, owner), eq(syncReadWork.stream, "discovery")));
    assert.ok(activeDiscovery!.claimGeneration !== null);
    const midPull = await requestSyncReadWork({ userID: owner, provider: "caldav", accountID, stream: "discovery", configurationFingerprint: activeDiscovery!.configurationFingerprint, policyFingerprint: activeDiscovery!.policyFingerprint });
    assert.ok(BigInt(midPull.requestedGeneration) > activeDiscovery!.claimGeneration!);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const otherCompleted = syncProvider(caldavAdapter, otherOwner, { id: otherAccount.id, label: "Other fixture" }).then(() => true);
      const progressed = await Promise.race([otherCompleted, new Promise<false>(resolve => { deadline = setTimeout(() => resolve(false), 2000); })]);
      assert.equal(progressed, true, "B must finish while A's native response is still held.");
    } finally { if (deadline) clearTimeout(deadline); slowRelease(); }
    assert.equal(await slow, null);
    await submitSyncWork({ family: "pull", id: midPull.workID });
    const [afterMidPull] = await db.select().from(syncReadWork).where(eq(syncReadWork.id, midPull.workID));
    assert.ok(afterMidPull!.completedGeneration >= BigInt(midPull.requestedGeneration));
    assert.ok(accountCalls.slice(fairnessStart).filter(item => !item.other && item.kind === "principal").length >= 2,
      "The notification received during pull requires another real discovery, not an ACK of the current requested generation.");
    // The later discovery enqueued its own captured collection generation;
    // await that real child too before examining fully settled queue state.
    const [laterComponents] = await db.select().from(syncReadWork).where(and(eq(syncReadWork.userID, owner), eq(syncReadWork.stream, "components")));
    await submitSyncWork({ family: "pull", id: laterComponents!.id });
    const [otherEvent] = await db.select().from(events).where(eq(events.creatorID, otherOwner));
    assert.ok(otherEvent && otherEvent.id !== (await event()).id, "Equal native IDs in two physical accounts keep separate canonical authority.");
    assert.equal((await source()).cursor, "urn:fixture-material-cursor");
    const firstWork = await db.select().from(syncReadWork).where(eq(syncReadWork.userID, owner));
    assert.deepEqual(firstWork.map(work => work.stream).sort(), ["components", "discovery"]);
    for (const work of firstWork) {
      assert.equal(work.requestedGeneration, work.completedGeneration);
      assert.equal(work.claimToken, null);
      assert.equal(work.claimGeneration, null);
      assert.equal(work.leaseUntil, null);
    }
    const firstSource = await source();
    read = false;
    const denied = await measure(sync);
    assert.equal(denied.length, 7, "Fresh discovery and fresh ACL; no private resource reads.");
    assert.equal((await event()).title, "Busy");
    assert.equal((await event()).description, null);
    assert.equal((await task()).title, "Private task");
    assert.equal((await task()).description, null);
    assert.ok((await source()).sourceGeneration > firstSource.sourceGeneration);
    read = true;
    await sync();
    assert.equal((await event()).title, "Private event");
    assert.equal((await task()).title, "Private task details");

    const beforeIncomplete = await source(), beforeEvent = await event(), beforeTask = await task();
    listingFailure = true;
    await assert.rejects(sync());
    listingFailure = false;
    assert.equal((await source()).sourceGeneration, beforeIncomplete.sourceGeneration);
    assert.equal((await event()).title, beforeEvent.title);
    assert.equal((await task()).title, beforeTask.title);
    const afterIncompleteCalls = calls.length;
    await assert.rejects(sync(), error => error instanceof SyncWorkDeferred);
    assert.equal(calls.length, afterIncompleteCalls, "A persisted delay returns immediately without sleeping or native dispatch.");
    const [pendingDiscovery] = await db.select().from(syncReadWork).where(and(eq(syncReadWork.userID, owner), eq(syncReadWork.caldavAccountID, accountID), eq(syncReadWork.stream, "discovery")));
    assert.ok(pendingDiscovery!.requestedGeneration > pendingDiscovery!.completedGeneration);
    assert.equal(pendingDiscovery!.claimToken, null);
    assert.ok(pendingDiscovery!.notBefore.getTime() > Date.now());
    // Expire only this exact owned fixture row; do not erase any other work's
    // durable wait or consume a worker slot with a test sleep.
    await db.update(syncReadWork).set({ notBefore: sql`clock_timestamp()-interval '1 millisecond'` }).where(and(eq(syncReadWork.id, pendingDiscovery!.id), eq(syncReadWork.userID, owner), eq(syncReadWork.caldavAccountID, accountID)));
    absent = true;
    await sync();
    assert.equal(await source(), undefined, "Only the fresh complete account inventory removes the missing mirror.");
    assert.equal(fixtureFailure, undefined);
    console.log(JSON.stringify({ boundary: "actual-postgres-queued-adapter-engine-loopback-http", discoveryCalls: discovery.length, warmResourceCalls: warm.length, firstSyncCalls: firstSync.length, deniedSyncCalls: denied.length, rotations: 3, actualRetirement: true, queuedDirtyAck: true, slowAccountProgress: true, midPullNotificationReplayed: true, budgetsBootstrapped: false, liveProvider: false }));
  } finally {
    stopSyncWorkCoordinator();
    config.security.federationAllowPrivateHosts = priorPrivate;
    await db.delete(user).where(eq(user.id, owner));
    await db.delete(user).where(eq(user.id, otherOwner));
    fixture.closeAllConnections();
    await new Promise<void>((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
