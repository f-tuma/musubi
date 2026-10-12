import { setAllDayAdditionalDate, restoreAllDayExclusion, planEventScope, resolveEventTimeEdit } from "@musubi/calendar";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import { and, eq, sql } from "drizzle-orm";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  assert.ok(process.env.DATABASE_URL);
  const { config } = await import("@musubi/config");
  const { CLIENT_VERSION_HEADER, PRODUCT_VERSION } = await import("@musubi/types");
  const { db, user, events, calendarMembers, calendarEvents, createCalendar, eventOutbox, externalEvents, eventScopeOperations, externalCalendars, externalEventTombstones, saveCaldavAccount, importExternalCalendar, replaceExternalEventResource, upsertExternalEvent, getEventSnapshot, replaceMemberToken, applyLocalEventScope, claimEventOutbox, completeEventOutbox, confirmCaldavSplitOutbox, confirmCaldavSeriesOutbox, deleteExternalEvent, sweepExternalEvents, purgeDeletedEvents } = await import("@musubi/db");
  const { caldavAdapter, prepareCaldavSeriesSplit } = await import("./adapters/caldav");
  const { normalizeCaldavResource } = await import("./adapters/caldav_time");
  const { prepareCaldavSeries, prepareCaldavSeriesDelete } = await import("./caldav_scope");
  const { prepareEventDeliveryResolution } = await import("./event_resolution");
  const { commitEventDeliveryResolution, getEventDeliveryResolutionReplay } = await import("@musubi/db");
  const { deliverEventOutbox } = await import("./event_delivery");
  const { encryptSecret } = await import("./crypto");
  const { issueMemberToken } = await import("../federation_tokens");
  const { requireAuth } = await import("../middleware/require_auth");
  const { middlewareErrorHandler } = await import("../middleware/error_handler");
  const { handlerEventScope } = await import("../handlers/events");
  const { handlerGetEventDelivery, handlerGetEventDeliveryConflict, handlerResolveEventDelivery } = await import("../handlers/event_delivery");
  let data = "", etag = '"before"', mode = "ok", puts = 0;
  let missing = false, deletes = 0, providerGets = 0;
  let splitData: string | null = null, splitCreates = 0, unbindAllowed = true, bindAllowed = true, bindUnknown = false, writeUnknown = false;
  let onSplitRead: ((href: string) => Promise<void>) | undefined;
  let onSplitPut: (() => Promise<void>) | undefined;
  let onDelete: (() => Promise<void>) | undefined;
  let onGet: (() => Promise<void>) | undefined;
  let onPut: (() => Promise<void>) | undefined;
  const fixture = createServer(async (req, res) => {
    if (req.method === "GET") providerGets++;
    if (req.method === "PROPFIND") {
      if (bindUnknown && req.url === "/collection/" || writeUnknown && req.url === "/collection/family.ics") {
        res.writeHead(207, { "content-type": "application/xml" }); return res.end(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${req.url}</d:href><d:propstat><d:prop><d:current-user-privilege-set/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>`);
      }
      res.writeHead(207, { "content-type": "application/xml" });
      return res.end(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${req.url}</d:href><d:propstat><d:prop><d:current-user-privilege-set><d:privilege><d:write-content/></d:privilege>${unbindAllowed ? "<d:privilege><d:unbind/></d:privilege>" : ""}${bindAllowed ? "<d:privilege><d:bind/></d:privilege>" : ""}</d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
    }
    if (req.url?.startsWith("/collection/musubi-")) {
      if (req.method === "GET") { await onSplitRead?.(`http://${req.headers.host}${req.url}`); if (splitData === null) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": "text/calendar", etag: '\"created\"' }); return res.end(splitData); }
      assert.equal(req.method, "PUT"); assert.equal(req.headers["if-none-match"], "*");
      splitCreates++; if (splitData !== null) { res.writeHead(412); return res.end(); }
      let body = ""; for await (const chunk of req) body += chunk; splitData = body; await onSplitPut?.();
      res.writeHead(mode === "create-lost" ? 503 : 201); return res.end();
    }
    if (req.method === "GET") { await onGet?.(); if (missing) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": "text/calendar", etag }); return res.end(data); }
    if (req.method === "DELETE") {
      deletes++;
      if (mode === "race") { data = data.replace("SUMMARY:Moved", "SUMMARY:Remote child"); etag = '"raced"'; }
      if (req.headers["if-match"] !== etag) { res.writeHead(412); return res.end(); }
      missing = true; await onDelete?.(); res.writeHead(mode === "lost" ? 503 : 204); return res.end();
    }
    assert.equal(req.method, "PUT"); puts++;
    let body = ""; for await (const chunk of req) body += chunk;
    if (mode === "race") { data = data.replace("SUMMARY:Moved", "SUMMARY:Remote child"); etag = '"raced"'; }
    if (req.headers["if-match"] !== etag) { res.writeHead(412); return res.end(); }
    data = body; etag = '"after"';
    await onPut?.();
    res.writeHead(mode === "lost" ? 503 : 204, { etag }); res.end();
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const provider = `http://127.0.0.1:${(fixture.address() as any).port}`;
  const app = express(); app.use(express.json());
  app.post("/events/:eventId/scope", requireAuth, handlerEventScope);
  app.get("/events/:eventId/delivery", requireAuth, handlerGetEventDelivery);
  app.get("/events/:eventId/delivery/:operationId/conflict", requireAuth, handlerGetEventDeliveryConflict);
  app.post("/events/:eventId/delivery/:operationId/resolve", requireAuth, handlerResolveEventDelivery);
  app.use(middlewareErrorHandler);
  const api = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => api.once("listening", resolve));
  const apiOrigin = `http://127.0.0.1:${(api.address() as any).port}`;
  const enabled = config.api.eventTimeEditsEnabled;
  try {
    for (const scenario of ["oneoff-conflict", "oneoff-permission", "oneoff-content", "oneoff-all-day", "oneoff-floating", "oneoff-lost", "oneoff-stale", "oneoff-time", "oneoff-recurrence", "oneoff-delete", "oneoff-meeting", "oneoff-off", "oneoff-retired", "rdate-http", "rdate-remove", "rdate-lost", "rdate-conflict", "rdate-duplicate", "rdate-native-time", "rdate-stale", "rdate-child", "rdate-retired", "rdate-permission", "rdate-off", "exdate-http", "exdate-first", "exdate-malformed", "exdate-native-duplicate", "exdate-native-malformed", "exdate-lost", "exdate-conflict", "exdate-stale-preview", "exdate-proof-subset", "exdate-native-time", "exdate-native-dates", "exdate-native-content", "exdate-child", "exdate-retired", "exdate-duplicate", "exdate-foreign", "exdate-rule", "exdate-off", "exdate-permission", "exdate-local-race", "zone-http", "zone-lost", "zone-conflict", "zone-native-time", "zone-child", "zone-retired", "zone-off", "zone-permission", "zone-local-race", "remove-zoned", "remove-all-day", "remove-floating", "remove-lost", "remove-race", "remove-active-child", "remove-retired-child", "remove-grant-before", "remove-local-race", "remove-lease-race", "future-resolve-unknown-source", "future-resolve-applied-receipt", "future-resolve-wrong-receipt", "future-resolve-source-receipt", "future-resolve-zoned", "future-resolve-all-day", "future-resolve-floating", "future-resolve-http", "future-resolve-applied", "future-resolve-collision", "future-resolve-no-bind", "future-resolve-tombstone", "future-resolve-old-client", "future-resolve-wrong-scope", "future-resolve-stale", "future-resolve-head-race", "future-resolve-child-race", "future-resolve-grant", "future-resolve-proof", "future-resolve-source-edit", "future-resolve-repeated", "future-resolve-lost", "future-resolve-lease", "future-resolve-delete-during", "split-resolve-unknown-creation", "split-resolve-pair-metadata", "split-resolve-http", "split-resolve-zoned", "split-resolve-all-day", "split-resolve-floating", "split-resolve-old-client", "split-resolve-wrong-scope", "split-resolve-stale", "split-resolve-source-race", "split-resolve-head-race", "split-resolve-child-race", "split-resolve-head-deleted", "split-resolve-grant", "split-resolve-creation-lease", "split-resolve-proof-identity", "split-resolve-proof-request", "split-resolve-native-content", "split-resolve-native-rule", "split-resolve-native-collision", "split-resolve-no-bind", "split-resolve-lost-source", "split-resolve-lost-create", "split-resolve-repeated", "split-resolve-source-edit", "split-resolve-create-deletion", "split-legacy-zoned", "split-create-root-delete", "delete-resolve-no-unbind", "delete-resolve-unbind-after", "delete-resolve-http", "delete-resolve-zoned", "delete-resolve-all-day", "delete-resolve-floating", "delete-resolve-old-client", "delete-resolve-wrong-cut", "delete-resolve-stale", "delete-resolve-local-race", "delete-resolve-restored-child", "delete-resolve-restored-root", "delete-resolve-grant", "delete-resolve-proof-baseline", "delete-resolve-native-time", "delete-resolve-native-content", "delete-resolve-lost", "delete-resolve-repeated", "delete-resolve-restore", "delete-resolve-no-resource-write", "following-resolve-http", "following-resolve-zoned", "following-resolve-all-day", "following-resolve-floating", "following-resolve-old-client", "following-resolve-wrong-cut", "following-resolve-stale", "following-resolve-local-race", "following-resolve-restored-child", "following-resolve-grant", "following-resolve-proof-cut", "following-resolve-native-time", "following-resolve-native-content", "following-resolve-lost", "following-resolve-repeated", "following-resolve-restore", "definition-generated-zoned", "definition-generated-all-day", "definition-generated-floating", "definition-generated-time-zoned", "definition-generated-cancel-zoned", "definition-generated-cancel-all-day", "definition-generated-cancel-floating", "definition-cancel-zoned", "definition-cancel-all-day", "definition-cancel-floating", "definition-revive-zoned", "definition-revive-all-day", "definition-revive-floating", "definition-revive-time-zoned", "definition-generated-stale", "definition-generated-local-race", "definition-generated-grant", "definition-generated-proof-target", "definition-generated-proof-definition", "definition-cancel-proof-cancel", "definition-generated-native-child", "definition-cancel-native-content", "definition-generated-native-master", "definition-revive-native-time", "definition-generated-lost", "definition-cancel-lost", "definition-revive-lost", "definition-generated-repeated", "structure-series-time-zoned", "structure-series-time-all-day", "structure-series-time-floating", "structure-occurrence-time-zoned", "structure-occurrence-time-all-day", "structure-occurrence-time-floating", "structure-recurrence-zoned", "structure-recurrence-all-day", "structure-recurrence-floating", "structure-combined-zoned", "structure-stale", "structure-local-race", "structure-grant", "structure-lease", "structure-proof-time", "structure-proof-rule", "structure-native-time", "structure-native-rule", "structure-native-child", "structure-lost", "structure-repeated", "structure-native-after", "resolve-occurrence-repeated", "resolve-occurrence-zoned", "resolve-occurrence-all-day", "resolve-occurrence-floating", "resolve-occurrence-http", "resolve-occurrence-lost", "resolve-occurrence-stale", "resolve-occurrence-local-race", "resolve-occurrence-grant", "resolve-occurrence-target-tamper", "resolve-occurrence-native-time", "resolve-occurrence-native-slot", "resolve-occurrence-other-content", "resolve-occurrence-timezone", "public-split-noop-rule", "public-split-noop-time", "public-split-generated-zoned", "public-split-generated-all-day", "public-split-generated-floating", "public-split-first-time", "public-split-first-recurrence", "public-split-zoned", "public-split-all-day", "public-split-floating", "public-split-time", "public-split-recurrence", "public-split-first-zoned", "public-split-first-all-day", "public-split-first-floating", "public-split-noop", "public-split-off", "public-split-no-bind", "public-split-bind-unknown", "public-split-write-unknown", "public-split-grant-race", "public-split-local-race", "public-split-root-tombstone", "public-split-child-tombstone", "public-split-collision", "split-create-child-delete", "split-pair-tamper", "split-source-lost", "split-source-race", "split-source-grant-before", "split-source-grant-after", "split-source-local-race", "split-source-lease-race", "split-source-collision", "split-no-bind", "split-native-tamper", "split-create-lost", "split-create-grant-before", "split-create-grant-after", "split-create-local-race", "split-create-lease-race", "split-edit-source", "series-sweep", "split-sweep", "split-rollback", "split-delete-fence", "split-zoned", "split-all-day", "split-floating", "split-time", "split-recurrence", "split-race", "split-tamper", "following-sweep-echo", "delete-sweep-echo", "following-content-conflict", "following-shift-collision", "following-regenerate", "following-recancel", "following-zoned", "following-all-day", "following-floating", "following-lost", "following-race", "following-grant-before", "following-grant-after", "following-local-race", "following-lease-race", "following-cleanup", "following-restore", "following-first", "delete-recreate", "delete-cleanup", "delete-zoned", "delete-all-day", "delete-floating", "delete-lost", "delete-race", "delete-prepare-race", "delete-grant-before", "delete-grant-after", "delete-local-race", "delete-lease-race", "grant-before", "grant-after", "recurrence-zoned", "recurrence-all-day", "recurrence-floating", "recurrence-lost", "recurrence-race", "recurrence-orphan", "recurrence-bare", "recurrence-order", "series-time-zoned", "series-time-all-day", "series-time-floating", "series-time-lost", "series-time-race", "series-time-tombstone", "generated-time-zoned", "generated-time-all-day", "generated-time-floating", "generated-time-lost", "generated-time-race", "time-zoned", "time-all-day", "time-floating", "time-lost", "time-race", "revive-zoned", "revive-all-day", "revive-floating", "revive-lost", "revive-race", "generated-zoned", "generated-all-day", "generated-floating", "generated-cancel-zoned", "generated-cancel-all-day", "generated-cancel-floating", "generated-lost", "generated-race", "generated-prepare-race", "generated-tombstone", "cancel-zoned", "cancel-all-day", "cancel-floating", "cancel-lost", "cancel-race", "occurrence-zoned", "occurrence-all-day", "occurrence-floating", "occurrence-lost", "occurrence-race", "zoned", "all-day", "floating", "no-children", "malformed-private", "meeting", "copied", "lost", "race", "local-race", "mapping-race", "lease-race", "tombstone", "prepare-race", "no-op", "resolve", "resolve-all-day", "resolve-floating", "resolve-delete-observation", "resolve-twice", "resolve-http", "resolve-timezone", "resolve-stale", "resolve-local-race", "resolve-child-race"]) {
      if (process.env.CALDAV_SCOPE_SCENARIOS && !process.env.CALDAV_SCOPE_SCENARIOS.split(",").includes(scenario)) continue;
      const owner = `caldav-scope-${randomUUID()}`;
      const credential = issueMemberToken();
      await db.insert(user).values({ id: owner, name: "Fixture", email: `${owner}@example.test`, isExternal: true });
      await replaceMemberToken(owner, credential.tokenHash);
      config.api.eventTimeEditsEnabled = true;
      try {
        const account = await saveCaldavAccount(owner, provider + "/", "fixture", encryptSecret("fixture"));
        const collection = provider + "/collection/";
        const calendar = await importExternalCalendar("caldav", owner, account.id, "Fixture", { externalId: collection, name: "Fixture", color: "#7A8BA3", supportsEvents: true });
        const resource = collection + "family.ics";
        const stamp = (name: string, day: string, hour: string) => (scenario.startsWith("rdate-") || scenario.startsWith("exdate-") || scenario.endsWith("all-day")) ? `${name};VALUE=DATE:202603${day}` : `${name}${scenario.endsWith("floating") ? "" : ";TZID=Europe/Prague"}:202603${day}T${hour}0000`;
        const component = (...lines: string[]) => ["BEGIN:VEVENT", "UID:family", ...lines, "END:VEVENT"].join("\r\n");
        const master = component(stamp("DTSTART", "28", "09"), stamp("DTEND", "29", "10"), "RRULE:FREQ=DAILY;COUNT=4", "SUMMARY:Master", "X-PRIVATE:Never disclose", "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "DESCRIPTION:Private alarm", "END:VALARM");
        const child = component(stamp("RECURRENCE-ID", "29", "09"), stamp("DTSTART", "30", "14"), stamp("DTEND", "31", "16"), "SUMMARY:Moved");
        const cancelled = component(stamp("RECURRENCE-ID", "30", "09"), stamp("DTSTART", "30", "09"), stamp("DTEND", "31", "10"), "SUMMARY:Cancelled", "STATUS:CANCELLED");
        data = ["BEGIN:VCALENDAR", "VERSION:2.0", master, ...(scenario.startsWith("oneoff-") && scenario !== "oneoff-retired" || scenario.startsWith("rdate-") && !["rdate-child", "rdate-retired"].includes(scenario) || scenario.startsWith("exdate-") && !["exdate-child", "exdate-retired"].includes(scenario) || scenario.startsWith("zone-") && !["zone-child", "zone-retired"].includes(scenario) || scenario === "no-children" || scenario.startsWith("remove-") && !["remove-active-child", "remove-retired-child"].includes(scenario) ? [] : [child, cancelled]), "END:VCALENDAR", ""].join("\r\n");
        if (scenario.startsWith("oneoff-") && scenario !== "oneoff-retired") data = data.replace("RRULE:FREQ=DAILY;COUNT=4\r\n", "");
        if (scenario === "oneoff-meeting") data = data.replace("SUMMARY:Master", "SUMMARY:Master\r\nORGANIZER:mailto:owner@example.test\r\nATTENDEE:mailto:guest@example.test");
        if (["rdate-remove", "rdate-duplicate"].includes(scenario)) data = data.replace("RRULE:FREQ=DAILY;COUNT=4", "RRULE:FREQ=DAILY;COUNT=4\r\nRDATE;VALUE=DATE:20260402");
        if (scenario.startsWith("zone-")) data = data.replace(stamp("DTEND", "29", "10"), stamp("DTEND", "28", "10"));
        if (scenario.startsWith("exdate-")) data = data.replace("RRULE:FREQ=DAILY;COUNT=4", "RRULE:FREQ=DAILY;COUNT=4\r\nEXDATE;VALUE=DATE:20260329,20260330");
        if (scenario === "exdate-native-duplicate") data = data.replace("20260329,20260330", "20260329\r\nEXDATE;VALUE=DATE:20260330");
        if (scenario === "exdate-first") data = data.replace("20260329,20260330", "20260328,20260330");
        if (scenario === "exdate-malformed") data = data.replace("20260329,20260330", "20260329,202603300");
        if (scenario === "exdate-duplicate") data = data.replace("20260329,20260330", "20260329,20260329");
        if (scenario === "exdate-foreign") data = data.replace("20260329,20260330", "20260329,20260405");
        if (scenario === "public-split-noop-time") data = data.replace("RRULE:FREQ=DAILY;COUNT=4", "RRULE:FREQ=DAILY;UNTIL=20260331T070000Z");
        if (scenario === "meeting") data = data.replace("SUMMARY:Master", "SUMMARY:Master\r\nORGANIZER:mailto:owner@example.test\r\nATTENDEE:mailto:guest@example.test");
        etag = '"before"'; mode = "ok"; puts = 0; providerGets = 0; splitData = null; splitCreates = 0; unbindAllowed = true; bindAllowed = true; bindUnknown = false; writeUnknown = false; onSplitPut = undefined; onSplitRead = undefined; missing = false; deletes = 0; onDelete = undefined; onPut = undefined; onGet = undefined;
        const persist = () => replaceExternalEventResource("caldav", owner, calendar.id, collection, resource, normalizeCaldavResource({ url: resource, etag, data }).map(event => ({ externalId: event.externalId, etag, icalUid: "family", values: { title: event.title, start: event.start, end: event.end, color: "#7A8BA3", isAllDay: event.isAllDay, description: event.description, location: event.location, organizer: event.organizer ?? "", recurrence: event.recurrence, url: event.url }, time: { timeModel: event.timeModel!, externalSeriesID: event.externalSeriesID, originalStart: event.originalStart, isCanceled: event.isCanceled } })));
        if (scenario.startsWith("oneoff-")) console.log(`CalDAV personal ${scenario}`);
        await persist();
        const rows = () => db.select().from(events).where(eq(events.creatorID, owner)).orderBy(events.id);
        const maps = () => db.select().from(externalEvents).where(eq(externalEvents.calendarID, calendar.id)).orderBy(externalEvents.id);
        const outbox = () => db.select().from(eventOutbox).where(eq(eventOutbox.userID, owner));
        const original = await rows(), mappings = await maps();
        const root = original.find(event => !event.seriesID)!;
        if (scenario.startsWith("oneoff-")) {
          const before = data;
          const request: any = { operationID: randomUUID(), scope: "series", action: "update", expectedRevision: root.revision, patch: { title: "Personal changed", description: null, location: "Room" } };
          if (scenario === "oneoff-time") request.time = { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-03-28T11:00:00", endLocal: "2026-03-28T12:00:00" };
          if (scenario === "oneoff-recurrence") request.patch.recurrence = "RRULE:FREQ=DAILY;COUNT=2";
          if (scenario === "oneoff-delete") { request.action = "delete"; delete request.patch; }
          if (scenario === "oneoff-off") config.api.eventTimeEditsEnabled = false;
          if (scenario === "oneoff-permission") writeUnknown = true;
          if (scenario === "oneoff-retired") {
            await db.update(events).set({ deletedAt: new Date() }).where(eq(events.seriesID, root.id));
            await db.update(events).set({ recurrence: null }).where(eq(events.id, root.id));
          }
          const prepare = async () => {
            const candidate = await applyLocalEventScope(root.id, owner, request, { prepareProvider: true });
            assert.equal(candidate.status, "caldav_required");
            if (candidate.status !== "caldav_required") throw new Error("Missing one-off context");
            return prepareCaldavSeries(candidate.context, request);
          };
          if (["oneoff-time", "oneoff-recurrence", "oneoff-delete", "oneoff-meeting", "oneoff-off", "oneoff-retired", "oneoff-permission"].includes(scenario)) {
            const stable = await rows(); await assert.rejects(prepare);
            assert.deepEqual(await rows(), stable); assert.equal(puts, 0); assert.equal((await outbox()).length, 0); continue;
          }
          const prepared = await prepare();
          if (scenario === "oneoff-stale") {
            await db.update(events).set({ revision: sql`${events.revision} + 1` }).where(eq(events.id, root.id));
            assert.equal((await applyLocalEventScope(root.id, owner, request, { caldav: prepared })).status, "conflict");
            assert.equal(puts, 0); assert.equal((await outbox()).length, 0); continue;
          }
          const committed = await applyLocalEventScope(root.id, owner, request, { caldav: prepared });
          assert.equal(committed.status, "saved");
          assert.equal((await applyLocalEventScope(root.id, owner, request, { caldav: prepared })).status, "replayed");
          await assert.rejects(() => applyLocalEventScope(root.id, owner, { ...request, patch: { title: "Different" } }, { caldav: prepared }));
          const row = (await outbox())[0]!;
          mode = scenario === "oneoff-lost" ? "lost" : scenario === "oneoff-conflict" ? "race" : "ok";
          const delivered = await deliverEventOutbox(row.id, () => caldavAdapter);
          if (scenario === "oneoff-conflict") {
            assert.equal(delivered?.status, "conflict"); mode = "ok";
            const resolution = await prepareEventDeliveryResolution(owner, root.id, row.id, () => caldavAdapter);
            assert.ok(resolution);
            const { preview, proof } = resolution;
            const replacement = await commitEventDeliveryResolution(owner, proof, { mutationId: randomUUID(), expectedLocalRevision: preview.localRevision, expectedLatestOperationId: preview.latestOperationId, expectedRemoteExists: true, expectedRemoteEtag: preview.remoteEtag });
            assert.equal((await deliverEventOutbox(replacement, () => caldavAdapter))?.status, "completed");
            assert.equal(puts, 2); assert.equal(deletes, 0);
            assert.equal(data, prepared.write.after);
            assert.deepEqual((await rows())[0]!.timeModel, root.timeModel); continue;
          }
          assert.ok(["completed", "retry", "unconfirmed"].includes(delivered!.status));
          if (delivered!.status !== "completed") {
            await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, row.id));
            assert.equal((await deliverEventOutbox(row.id, () => caldavAdapter))?.status, "completed");
          }
          assert.equal(puts, 1); assert.equal(deletes, 0);
          assert.equal(data, before.replace("SUMMARY:Master", "SUMMARY:Personal changed").replace("END:VEVENT", "LOCATION:Room\r\nEND:VEVENT"));
          assert.equal((await rows())[0]!.title, "Personal changed");
          assert.deepEqual((await rows())[0]!.timeModel, root.timeModel); continue;
        }
        if (scenario.startsWith("rdate-")) {
          const recurrence = ["rdate-remove", "rdate-duplicate"].includes(scenario) ? root.recurrence!.split("\n")[0]! : root.recurrence! + "\nRDATE;VALUE=DATE:20260402";
          const request = { operationID: randomUUID(), scope: "series", action: "update", expectedRevision: root.revision, patch: { recurrence } };
          const before = data;
          if (scenario === "rdate-retired") await db.update(events).set({ deletedAt: new Date() }).where(eq(events.seriesID, root.id));
          if (scenario === "rdate-off") config.api.eventTimeEditsEnabled = false;
          if (scenario === "rdate-permission") writeUnknown = true;
          if (["rdate-child", "rdate-retired", "rdate-off", "rdate-permission"].includes(scenario)) {
            const stable = await rows();
            await assert.rejects(async () => { const result = await applyLocalEventScope(root.id, owner, request, { prepareProvider: true }); if (result.status !== "caldav_required") throw new Error("Refused"); await prepareCaldavSeries(result.context, request); });
            assert.deepEqual(await rows(), stable); assert.equal(puts, 0); assert.equal((await outbox()).length, 0); continue;
          }
          const candidate = await applyLocalEventScope(root.id, owner, request, { prepareProvider: true });
          if (candidate.status !== "caldav_required") throw new Error("Missing RDATE context");
          const prepared = await prepareCaldavSeries(candidate.context, request);
          if (scenario === "rdate-stale") {
            await db.update(events).set({ revision: sql`${events.revision} + 1` }).where(eq(events.id, root.id));
            assert.equal((await applyLocalEventScope(root.id, owner, request, { caldav: prepared })).status, "conflict"); assert.equal(puts, 0); assert.equal((await outbox()).length, 0); continue;
          }
          if (scenario === "rdate-http" || scenario === "rdate-remove") {
            const response = await fetch(`${apiOrigin}/events/${root.id}/scope`, { method: "POST", headers: { authorization: `Bearer ${credential.raw}`, "content-type": "application/json", [CLIENT_VERSION_HEADER]: PRODUCT_VERSION }, body: JSON.stringify(request) });
            const body = await response.text(); assert.equal(response.status, 200, body); assert.ok(!body.includes("BEGIN:VCALENDAR"));
          } else assert.equal((await applyLocalEventScope(root.id, owner, request, { caldav: prepared })).status, "saved");
          const operation = (await outbox())[0]!;
          assert.equal(operation.payload.caldavSeries!.write.patch.recurrence, recurrence);
          const saved = await rows(); assert.equal(saved.length, 1); assert.equal(saved[0]!.recurrence, recurrence); assert.equal(saved[0]!.start.getTime(), root.start.getTime());
          await assert.rejects(persist); assert.deepEqual(await rows(), saved);
          mode = scenario === "rdate-lost" ? "lost" : ["rdate-conflict", "rdate-duplicate", "rdate-native-time"].includes(scenario) ? "race" : "ok";
          let result = await deliverEventOutbox(operation.id, () => caldavAdapter);
          if (scenario === "rdate-lost") { assert.equal(result?.status, "unconfirmed"); mode = "ok"; await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, operation.id)); result = await deliverEventOutbox(operation.id, () => caldavAdapter); assert.equal(puts, 1); }
          if (["rdate-conflict", "rdate-duplicate", "rdate-native-time"].includes(scenario)) {
            assert.equal(result?.status, "conflict"); mode = "ok";
            if (scenario !== "rdate-conflict") {
              data = scenario === "rdate-duplicate" ? data.replace("SUMMARY:Master", "RDATE;VALUE=DATE:20260402\r\nSUMMARY:Master") : data.replace("DTSTART;VALUE=DATE:20260328", "DTSTART;VALUE=DATE:20260327");
              await assert.rejects(() => prepareEventDeliveryResolution(owner, root.id, operation.id, () => caldavAdapter)); assert.equal(puts, 1); assert.deepEqual(await rows(), saved); continue;
            }
            const resolution = await prepareEventDeliveryResolution(owner, root.id, operation.id, () => caldavAdapter);
            assert.ok(resolution);
            // Immutable saved date remains unchanged through explicit confirmation.
            const { preview, proof } = resolution;
            const replacement = await commitEventDeliveryResolution(owner, proof, { mutationId: randomUUID(), expectedLocalRevision: preview.localRevision, expectedLatestOperationId: preview.latestOperationId, expectedRemoteExists: true, expectedRemoteEtag: preview.remoteEtag });
            result = await deliverEventOutbox(replacement, () => caldavAdapter);
            assert.equal(result?.status, "completed");
            assert.equal((await outbox()).find(item => item.id === replacement)!.payload.caldavSeries!.write.patch.recurrence, recurrence);
            assert.ok(replacement);
          } else { assert.equal(result?.status, "completed"); await persist(); assert.equal((await rows())[0]!.recurrence, recurrence); assert.equal(data, prepared.write.after); }
          assert.equal(before.includes("RDATE"), ["rdate-remove", "rdate-duplicate"].includes(scenario));
          console.log(`CalDAV RDATE ${scenario}: exact master/count and durable native outcome OK`); continue;
        }
        if (scenario.startsWith("exdate-")) {
          const restoredDate = scenario === "exdate-first" ? "2026-03-28" : "2026-03-29";
          const excludedPair = `${restoredDate.replace(/-/g, "")},20260330`;
          const recurrence = scenario === "exdate-native-duplicate" ? restoreAllDayExclusion(root.recurrence!, restoredDate) : root.recurrence!.replace(`EXDATE;VALUE=DATE:${restoredDate.replace(/-/g, "")},`, "EXDATE;VALUE=DATE:");
          const request = { operationID: randomUUID(), scope: "series", action: "update", expectedRevision: root.revision, patch: { recurrence: scenario === "exdate-rule" ? recurrence.replace("COUNT=4", "COUNT=5") : recurrence } };
          const before = data;
          if (scenario === "exdate-retired") await db.update(events).set({ deletedAt: new Date() }).where(eq(events.seriesID, root.id));
          if (scenario === "exdate-off") config.api.eventTimeEditsEnabled = false;
          if (scenario === "exdate-permission") writeUnknown = true;
          if (["exdate-child", "exdate-retired", "exdate-duplicate", "exdate-malformed", "exdate-foreign", "exdate-rule", "exdate-off", "exdate-permission"].includes(scenario)) {
            const stable = await rows();
            await assert.rejects(async () => {
              const candidate = await applyLocalEventScope(root.id, owner, request, { prepareProvider: true });
              if (candidate.status !== "caldav_required") throw new Error("Refused");
              await prepareCaldavSeries(candidate.context, request);
            });
            assert.deepEqual(await rows(), stable); assert.equal((await outbox()).length, 0); assert.equal(puts, 0);
            console.log(`CalDAV DATE restoration ${scenario}: refused without mutation OK`); continue;
          }
          assert.equal(recurrence, restoreAllDayExclusion(root.recurrence!, restoredDate));
          const candidate = await applyLocalEventScope(root.id, owner, request, { prepareProvider: true });
          if (candidate.status !== "caldav_required") throw new Error("Missing DATE restoration context");
          const prepared = await prepareCaldavSeries(candidate.context, request);
          assert.equal(prepared.write.after, scenario === "exdate-native-duplicate" ? before.replace("EXDATE;VALUE=DATE:20260329\r\n", "") : before.replace(`EXDATE;VALUE=DATE:${excludedPair}`, "EXDATE;VALUE=DATE:20260330"));
          if (scenario === "exdate-local-race") {
            await db.update(events).set({ revision: sql`${events.revision} + 1` }).where(eq(events.id, root.id));
            assert.equal((await applyLocalEventScope(root.id, owner, request, { caldav: prepared })).status, "conflict");
            assert.equal((await outbox()).length, 0); assert.equal(puts, 0); console.log("CalDAV DATE restoration local CAS race: OK"); continue;
          }
          if (scenario === "exdate-http" || scenario === "exdate-first") {
            const response = await fetch(`${apiOrigin}/events/${root.id}/scope`, { method: "POST", headers: { authorization: `Bearer ${credential.raw}`, "content-type": "application/json", [CLIENT_VERSION_HEADER]: PRODUCT_VERSION }, body: JSON.stringify(request) });
            const text = await response.text(); assert.equal(response.status, 200, text); assert.ok(!text.includes("BEGIN:VCALENDAR"));
          } else assert.equal((await applyLocalEventScope(root.id, owner, request, { caldav: prepared })).status, "saved");
          const operation = (await outbox())[0]!; assert.equal(operation.payload.caldavSeries!.write.patch.recurrence, recurrence);
          const saved = await rows(); assert.equal(saved.length, 1); assert.equal(saved[0]!.recurrence, recurrence);
          assert.equal(saved[0]!.start.getTime(), root.start.getTime());
          await assert.rejects(persist); assert.deepEqual(await rows(), saved);
          mode = scenario === "exdate-lost" ? "lost" : ["exdate-conflict", "exdate-stale-preview", "exdate-proof-subset"].includes(scenario) || scenario.startsWith("exdate-native-") ? "race" : "ok";
          let result = await deliverEventOutbox(operation.id, () => caldavAdapter);
          if (scenario === "exdate-lost") {
            assert.equal(result?.status, "unconfirmed"); mode = "ok";
            await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, operation.id));
            result = await deliverEventOutbox(operation.id, () => caldavAdapter); assert.equal(puts, 1);
          }
          if (["exdate-conflict", "exdate-stale-preview", "exdate-proof-subset"].includes(scenario) || scenario.startsWith("exdate-native-")) {
            assert.equal(result?.status, "conflict"); assert.equal(data, before); mode = "ok";
            if (scenario.startsWith("exdate-native-")) {
              data = scenario === "exdate-native-duplicate" ? data.replace("SUMMARY:Master", "EXDATE;VALUE=DATE:20260330\r\nSUMMARY:Master") : scenario === "exdate-native-malformed" ? data.replace("20260329,20260330", "20260329,202603300") : scenario === "exdate-native-time" ? data.replace("DTSTART;VALUE=DATE:20260328", "DTSTART;VALUE=DATE:20260327") : scenario === "exdate-native-dates" ? data.replace("20260329,20260330", "20260329,20260331") : data.replace("SUMMARY:Master", "SUMMARY:Remote content");
              await assert.rejects(() => prepareEventDeliveryResolution(owner, root.id, operation.id, () => caldavAdapter));
              assert.equal(puts, 1); assert.equal((await outbox()).length, 1); assert.deepEqual(await rows(), saved);
              console.log(`CalDAV DATE restoration ${scenario}: immutable recovery refused OK`); continue;
            }
            data = data.replace("Never disclose", "Fresh private extension");
            const { preview, proof } = await prepareEventDeliveryResolution(owner, root.id, operation.id, () => caldavAdapter);
            if (scenario === "exdate-stale-preview" || scenario === "exdate-proof-subset") {
              const confirmation = { mutationId: randomUUID(), expectedLocalRevision: preview.localRevision, expectedLatestOperationId: preview.latestOperationId, expectedRemoteExists: true, expectedRemoteEtag: preview.remoteEtag };
              let rejectedProof = proof;
              if (scenario === "exdate-stale-preview") { etag = '\"newer\"'; rejectedProof = (await prepareEventDeliveryResolution(owner, root.id, operation.id, () => caldavAdapter)).proof; }
              else rejectedProof = { ...proof, caldavSeries: { ...proof.caldavSeries!, write: { ...proof.caldavSeries!.write, patch: { recurrence: restoreAllDayExclusion(root.recurrence!, "2026-03-30") } } } };
              await assert.rejects(() => commitEventDeliveryResolution(owner, rejectedProof, confirmation));
              assert.equal((await outbox()).length, 1); assert.equal(puts, 1); assert.deepEqual(await rows(), saved);
              console.log(`CalDAV DATE restoration ${scenario}: exact confirmation refused OK`); continue;
            }
            const replacement = await commitEventDeliveryResolution(owner, proof, { mutationId: randomUUID(), expectedLocalRevision: preview.localRevision, expectedLatestOperationId: preview.latestOperationId, expectedRemoteExists: true, expectedRemoteEtag: preview.remoteEtag });
            assert.equal((await outbox()).find(item => item.id === replacement)!.payload.caldavSeries!.write.patch.recurrence, recurrence);
            result = await deliverEventOutbox(replacement, () => caldavAdapter);
            assert.ok(data.includes("Fresh private extension")); assert.equal((await outbox()).find(item => item.id === operation.id)!.status, "not-needed");
          }
          assert.equal(result?.status, "completed", result?.errorCode ?? "Expected confirmed date restoration");
          assert.ok(data.includes("EXDATE;VALUE=DATE:20260330") && data.includes("DESCRIPTION:Private alarm"));
          await persist(); assert.deepEqual(await rows(), saved); assert.equal((await maps())[0]!.id, mappings[0]!.id);
          assert.equal((await applyLocalEventScope(root.id, owner, request, { prepareProvider: true })).status, "replayed");
          console.log(`CalDAV DATE restoration ${scenario}: typed subset, CAS, ACK, recovery and stable echo OK`); continue;
        }
        if (scenario.startsWith("zone-")) {
          const time = { kind: "zoned", timeZone: "UTC", startLocal: "2026-03-28T09:00:00.000", endLocal: "2026-03-28T10:00:00.000" };
          const request = { operationID: randomUUID(), scope: "series", action: "update", expectedRevision: root.revision, patch: {}, time };
          const before = data;
          if (scenario === "zone-retired") {
            await db.update(events).set({ deletedAt: new Date() }).where(eq(events.seriesID, root.id));
            const retired = await rows();
            await assert.rejects(() => applyLocalEventScope(root.id, owner, request, { prepareProvider: true }));
            assert.deepEqual(await rows(), retired); assert.equal((await outbox()).length, 0); assert.equal(puts, 0);
            console.log("CalDAV UTC retired definition refusal: OK"); continue;
          }
          if (scenario === "zone-off") config.api.eventTimeEditsEnabled = false;
          if (scenario === "zone-permission") writeUnknown = true;
          if (["zone-child", "zone-off", "zone-permission"].includes(scenario)) {
            await assert.rejects(async () => {
              const candidate = await applyLocalEventScope(root.id, owner, request, { prepareProvider: true });
              if (candidate.status !== "caldav_required") throw new Error("Refused");
              await prepareCaldavSeries(candidate.context, request);
            });
            assert.deepEqual(await rows(), original); assert.equal((await outbox()).length, 0); assert.equal(puts, 0);
            console.log(`CalDAV UTC ${scenario}: refused without mutation OK`); continue;
          }
          const candidate = await applyLocalEventScope(root.id, owner, request, { prepareProvider: true });
          if (candidate.status !== "caldav_required") throw new Error("Missing UTC context");
          const prepared = await prepareCaldavSeries(candidate.context, request);
          assert.equal(prepared.write.after, before.replace(stamp("DTSTART", "28", "09"), "DTSTART:20260328T090000Z").replace(stamp("DTEND", "28", "10"), "DTEND:20260328T100000Z"));
          if (scenario === "zone-local-race") {
            await db.update(events).set({ revision: sql`${events.revision} + 1` }).where(eq(events.id, root.id));
            assert.equal((await applyLocalEventScope(root.id, owner, request, { caldav: prepared })).status, "conflict");
            assert.equal((await outbox()).length, 0); assert.equal(puts, 0); console.log("CalDAV UTC local CAS race: OK"); continue;
          }
          if (scenario === "zone-http") {
            const response = await fetch(`${apiOrigin}/events/${root.id}/scope`, { method: "POST", headers: { authorization: `Bearer ${credential.raw}`, "content-type": "application/json", [CLIENT_VERSION_HEADER]: PRODUCT_VERSION }, body: JSON.stringify(request) });
            const text = await response.text(); assert.equal(response.status, 200, text); assert.ok(!text.includes("BEGIN:VCALENDAR"));
          } else assert.equal((await applyLocalEventScope(root.id, owner, request, { caldav: prepared })).status, "saved");
          const operation = (await outbox())[0]!;
          assert.deepEqual(operation.payload.caldavSeries!.write.time, time);
          const saved = await rows(); assert.equal(saved.length, 1); assert.equal(saved[0]!.start.toISOString(), "2026-03-28T09:00:00.000Z");
          await assert.rejects(persist); assert.deepEqual(await rows(), saved);
          mode = scenario === "zone-lost" ? "lost" : scenario === "zone-conflict" || scenario === "zone-native-time" ? "race" : "ok";
          let result = await deliverEventOutbox(operation.id, () => caldavAdapter);
          if (scenario === "zone-lost") {
            assert.equal(result?.status, "unconfirmed"); mode = "ok";
            await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, operation.id));
            result = await deliverEventOutbox(operation.id, () => caldavAdapter); assert.equal(puts, 1);
          }
          if (scenario === "zone-conflict" || scenario === "zone-native-time") {
            assert.equal(result?.status, "conflict"); assert.equal(data, before); mode = "ok";
            if (scenario === "zone-native-time") {
              data = data.replace("20260328T090000", "20260328T080000");
              await assert.rejects(() => prepareEventDeliveryResolution(owner, root.id, operation.id, () => caldavAdapter));
              assert.equal(puts, 1); console.log("CalDAV UTC changed native time refuses recovery: OK"); continue;
            }
            data = data.replace("Never disclose", "Fresh private extension");
            const { preview, proof } = await prepareEventDeliveryResolution(owner, root.id, operation.id, () => caldavAdapter);
            const replacement = await commitEventDeliveryResolution(owner, proof, { mutationId: randomUUID(), expectedLocalRevision: preview.localRevision, expectedLatestOperationId: preview.latestOperationId, expectedRemoteExists: true, expectedRemoteEtag: preview.remoteEtag });
            assert.deepEqual((await outbox()).find(item => item.id === replacement)!.payload.caldavSeries!.write.time, time);
            result = await deliverEventOutbox(replacement, () => caldavAdapter);
            assert.ok(data.includes("Fresh private extension")); assert.equal((await outbox()).find(item => item.id === operation.id)!.status, "not-needed");
          }
          assert.equal(result?.status, "completed", result?.errorCode ?? "Expected confirmed UTC conversion");
          assert.ok(data.includes("DTSTART:20260328T090000Z") && data.includes("DESCRIPTION:Private alarm"));
          await persist(); assert.deepEqual(await rows(), saved);
          assert.equal((await maps())[0]!.id, mappings[0]!.id);
          assert.equal((await applyLocalEventScope(root.id, owner, request, { prepareProvider: true })).status, "replayed");
          console.log(`CalDAV UTC ${scenario}: typed journal, CAS, ACK, recovery and stable echo OK`); continue;
        }
        if (scenario.startsWith("remove-")) {
          const request = { operationID: randomUUID(), scope: "series", action: "update", expectedRevision: root.revision, patch: { recurrence: null } };
          if (scenario.endsWith("retired-child")) await db.update(events).set({ deletedAt: new Date() }).where(eq(events.seriesID, root.id));
          if (scenario.endsWith("child")) {
            await assert.rejects(() => applyLocalEventScope(root.id, owner, request, { prepareProvider: true }));
            assert.equal((await outbox()).length, 0); assert.equal(puts, 0); continue;
          }
          const oldData = data, oldEtag = etag;
          const candidate = await applyLocalEventScope(root.id, owner, request, { prepareProvider: true });
          if (candidate.status !== "caldav_required") throw new Error("Missing removal context");
          const prepared = await prepareCaldavSeries(candidate.context, request);
          assert.equal(prepared.write.after, oldData.replace("RRULE:FREQ=DAILY;COUNT=4\r\n", ""));
          for (const patch of [{}, { recurrence: "RRULE:FREQ=DAILY;COUNT=4" }]) {
            await assert.rejects(() => applyLocalEventScope(root.id, owner, request, { caldav: { ...prepared, write: { ...prepared.write, patch } } }));
            assert.deepEqual(await rows(), original); assert.equal((await outbox()).length, 0);
          }
          if (scenario === "remove-zoned") {
            const response = await fetch(`${apiOrigin}/events/${root.id}/scope`, { method: "POST", headers: { authorization: `Bearer ${credential.raw}`, "content-type": "application/json", [CLIENT_VERSION_HEADER]: PRODUCT_VERSION }, body: JSON.stringify(request) });
            assert.equal(response.status, 200, await response.text());
          } else {
          assert.equal((await applyLocalEventScope(root.id, owner, request, { caldav: prepared })).status, "saved");
          }
          const operation = (await outbox())[0]!;
          assert.equal(operation.payload.caldavSeries!.write.baseline.master.recurrence, root.recurrence);
          assert.equal(operation.payload.caldavSeries!.write.patch.recurrence, null);
          assert.equal((await rows())[0]!.recurrence, null);
          assert.deepEqual(await maps(), mappings);
          await assert.rejects(persist, "A pending recurring snapshot cannot replace the saved one-off");
          if (scenario.endsWith("grant-before")) await db.update(calendarMembers).set({ role: "viewer" }).where(eq(calendarMembers.calendarID, calendar.id));
          if (scenario.endsWith("local-race")) onPut = async () => { await db.update(events).set({ revision: sql`${events.revision} + 1` }).where(eq(events.id, root.id)); };
          if (scenario.endsWith("lease-race")) onPut = async () => { await db.update(eventOutbox).set({ leaseUntil: new Date(0) }).where(eq(eventOutbox.id, operation.id)); };
          mode = scenario.endsWith("lost") ? "lost" : scenario.endsWith("race") && !scenario.includes("local-") && !scenario.includes("lease-") ? "race" : "ok";
          let delivered = await deliverEventOutbox(operation.id, () => caldavAdapter);
          if (scenario.endsWith("lost")) { mode = "ok"; await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, operation.id)); delivered = await deliverEventOutbox(operation.id, () => caldavAdapter); }
          if (["remove-race", "remove-grant-before", "remove-local-race", "remove-lease-race"].includes(scenario)) {
            assert.notEqual(delivered?.status, "completed"); assert.deepEqual(await maps(), mappings); continue;
          }
          assert.equal(delivered?.status, "completed"); assert.equal(puts, 1);
          const savedRows = await rows(), savedMaps = await maps();
          assert.equal(savedRows.length, 1); assert.equal(savedRows[0]!.id, root.id);
          assert.equal(savedRows[0]!.recurrence, null); assert.deepEqual(savedRows[0]!.timeModel, root.timeModel);
          assert.equal(savedMaps.length, 1); assert.equal(savedMaps[0]!.id, mappings[0]!.id);
          assert.equal(savedMaps[0]!.externalSeriesID, null); assert.equal(savedMaps[0]!.originalStart, null);
          assert.equal(await persist(), false); assert.deepEqual(await rows(), savedRows);
          const acceptedData = data, acceptedEtag = etag;
          data = oldData; etag = oldEtag; assert.equal(await persist(), false);
          const stale = normalizeCaldavResource({ url: resource, etag, data })[0]!;
          assert.equal(await upsertExternalEvent("caldav", owner, calendar.id, collection, resource, { title: stale.title, start: stale.start, end: stale.end, color: "#7A8BA3", isAllDay: stale.isAllDay, recurrence: stale.recurrence, organizer: "", description: stale.description, location: stale.location, url: stale.url }, etag, "family", undefined, { timeModel: stale.timeModel!, originalStart: null, externalSeriesID: null, isCanceled: false }), false);
          assert.deepEqual(await rows(), savedRows); assert.deepEqual(await maps(), savedMaps);
          data = acceptedData; etag = acceptedEtag;
          assert.equal((await applyLocalEventScope(root.id, owner, request)).status, "replayed");
          console.log(`CalDAV ${scenario}: immutable removal, same root/map, full ACK and stale recurring pull refusal: OK`);
          continue;
        }
        if (scenario.startsWith("future-resolve-")) {
          const cut = original.find(item => !item.isCanceled && item.seriesID)!;
          const headers = { authorization: `Bearer ${credential.raw}`, "content-type": "application/json", [CLIENT_VERSION_HEADER]: PRODUCT_VERSION };
          const request = { operationID: randomUUID(), scope: "following", action: "update", expectedRevision: root.revision, originalStart: cut.originalStart, expectedOccurrenceRevision: cut.revision, patch: { title: "Saved future portion" } };
          const response = await fetch(`${apiOrigin}/events/${root.id}/scope`, { method: "POST", headers, body: JSON.stringify(request) });
          assert.equal(response.status, 200, await response.text());
          const pair = (await outbox()).sort((a, b) => a.position - b.position), journal = pair[0].payload.caldavSplit!;
          const headID = journal.after.head.id, nativeID = journal.prepared.split.creation.ref.externalEventId;
          assert.equal((await deliverEventOutbox(pair[0].id, () => caldavAdapter))?.status, "completed");
          const source = (await outbox()).find(row => row.id === pair[0].id)!;
          const savedMaps = await maps(); let savedRows = await rows();
          // A collision appears AFTER source acknowledgement, so initial source
          // preflight could not prevent it. The conflict must never overwrite it.
          splitData = journal.prepared.split.creation.data.replace("Saved future portion", "Unrelated native copy");
          assert.equal((await deliverEventOutbox(pair[1].id, () => caldavAdapter))?.status, "conflict");
          const applied = scenario.endsWith("applied") || scenario.endsWith("applied-receipt");
          if (!scenario.endsWith("collision")) splitData = applied ? journal.prepared.split.creation.data : null;
          if (scenario.endsWith("applied-receipt") || scenario.endsWith("wrong-receipt")) await db.update(eventOutbox).set({ resultRef: { ...journal.prepared.split.creation.ref, externalEventId: scenario.endsWith("wrong-receipt") ? collection + "wrong.ics" : nativeID, etag: '\"created\"' } }).where(eq(eventOutbox.id, pair[1].id));
          if (scenario.endsWith("source-receipt")) await db.update(eventOutbox).set({ resultRef: null }).where(eq(eventOutbox.id, source.id));
          if (scenario.endsWith("no-bind")) bindAllowed = false;
          if (scenario.endsWith("tombstone")) await deleteExternalEvent("caldav", calendar.id, nativeID);
          if (scenario === "future-resolve-unknown-source") {
            const selected = (await outbox()).find(row => row.id === pair[1].id)!;
            const leaseToken = randomUUID(), leaseState = { status: "attempting" as const, leaseToken, leaseUntil: new Date(Date.now() + 120000), remoteSnapshot: null };
            await db.update(eventOutbox).set(leaseState).where(eq(eventOutbox.id, selected.id));
            assert.equal(await confirmCaldavSplitOutbox(selected.id, leaseToken), true, "The actual legacy prepared pair is valid before its other row gets an unknown marker");
            await db.update(eventOutbox).set({ status: selected.status, leaseToken: selected.leaseToken, leaseUntil: selected.leaseUntil, remoteSnapshot: selected.remoteSnapshot }).where(eq(eventOutbox.id, selected.id));
            await db.update(eventOutbox).set({ payload: { ...source.payload, operationEnvelope: { schemaVersion: 99 } } }).where(eq(eventOutbox.id, source.id));
            const frozen = await outbox(), frozenRows = await rows(), frozenMaps = await maps(), readsBefore = providerGets;
            let factories = 0;
            await assert.rejects(() => prepareEventDeliveryResolution(owner, headID, pair[1].id, () => { factories++; return caldavAdapter; }), (error: any) => error.code === "delivery-resolution-unavailable");
            assert.equal(factories, 0); assert.equal(providerGets, readsBefore, "An unknown completed source prevents legacy future proof before provider IO");
            assert.deepEqual(await outbox(), frozen); assert.deepEqual(await rows(), frozenRows); assert.deepEqual(await maps(), frozenMaps);
            await db.update(eventOutbox).set(leaseState).where(eq(eventOutbox.id, selected.id));
            const leasedPair = await outbox();
            assert.equal(await confirmCaldavSplitOutbox(selected.id, leaseToken), false);
            assert.deepEqual(await outbox(), leasedPair, "Worker pair proof cannot interpret or rewrite the unknown completed source");
            assert.equal(providerGets, readsBefore);
            console.log("CalDAV future unknown paired source: refused before adapter/provider IO, immutable pair: OK"); continue;
          }
          const path = `${apiOrigin}/events/${headID}/delivery/${pair[1].id}`;
          const fetched = await fetch(`${path}/conflict`, { headers });
          if (["collision", "no-bind", "tombstone", "wrong-receipt", "source-receipt"].some(suffix => scenario.endsWith(suffix))) { assert.equal(fetched.status, 409); assert.equal(splitCreates, 0); assert.deepEqual(await maps(), savedMaps); continue; }
          const text = await fetched.text(); assert.equal(fetched.status, 200, text);
          const scope = { kind: "following-create" as const, originalStart: cut.originalStart!, newSeriesId: headID };
          const publicPreview = JSON.parse(text); assert.deepEqual(publicPreview.scopeResolution, scope); assert.equal(publicPreview.local.title, "Saved future portion"); assert.equal(publicPreview.action, "create");
          assert.ok(!text.includes("BEGIN:VCALENDAR") && !text.includes("Private alarm") && !text.includes("Never disclose"));
          const prepared = await prepareEventDeliveryResolution(owner, headID, pair[1].id, () => caldavAdapter);
          const confirm = { mutationId: randomUUID(), expectedLocalRevision: prepared.preview.localRevision, expectedLatestOperationId: pair[1].id, expectedRemoteExists: !!prepared.preview.remote, expectedRemoteEtag: prepared.preview.remoteEtag, expectedScopeResolution: scope };
          if (["old-client", "wrong-scope", "stale"].some(suffix => scenario.endsWith(suffix))) {
            const body: any = structuredClone(confirm);
            if (scenario.endsWith("old-client")) delete body.expectedScopeResolution;
            if (scenario.endsWith("wrong-scope")) body.expectedScopeResolution.kind = "following-update";
            if (scenario.endsWith("stale")) splitData = journal.prepared.split.creation.data;
            const rejected = await fetch(`${path}/resolve`, { method: "POST", headers, body: JSON.stringify(body) }); assert.equal(rejected.status, 409); assert.equal((await outbox()).length, 2); continue;
          }
          if (scenario.endsWith("head-race") || scenario.endsWith("child-race")) await db.update(events).set({ revision: sql`${events.revision} + 1` }).where(eq(events.id, scenario.endsWith("head-race") ? headID : cut.id));
          if (scenario.endsWith("grant")) await db.update(calendarMembers).set({ role: "viewer" }).where(and(eq(calendarMembers.calendarID, calendar.id), eq(calendarMembers.userID, owner)));
          if (scenario.endsWith("proof")) prepared.proof.caldavSplitFuture!.before.journal.prepared.split.creation.master.title = "Tampered";
          if (["head-race", "child-race", "grant", "proof"].some(suffix => scenario.endsWith(suffix))) { await assert.rejects(() => commitEventDeliveryResolution(owner, prepared.proof, confirm)); assert.deepEqual(await maps(), savedMaps); assert.equal((await outbox()).length, 2); continue; }
          if (scenario.endsWith("source-edit")) {
            const current = (await rows()).find(row => row.id === root.id)!;
            const edit = { operationID: randomUUID(), scope: "series", action: "update", expectedRevision: current.revision, patch: { title: "Independent earlier edit" } };
            const edited = await fetch(`${apiOrigin}/events/${root.id}/scope`, { method: "POST", headers, body: JSON.stringify(edit) }); assert.equal(edited.status, 200, await edited.text());
            const operation = (await outbox()).find(row => row.mutationID === edit.operationID)!; assert.equal((await deliverEventOutbox(operation.id, () => caldavAdapter))?.status, "completed"); savedRows = await rows();
          }
          let replacement: string;
          if (scenario.endsWith("http")) {
            const accepted = await fetch(`${path}/resolve`, { method: "POST", headers, body: JSON.stringify(confirm) }); assert.equal(accepted.status, 202, await accepted.text());
            replacement = (await outbox()).find(row => row.mutationID === confirm.mutationId)!.id;
            for (let attempt = 0; attempt < 100 && (await outbox()).find(row => row.id === replacement)!.status !== "completed"; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
          } else {
            const result = await Promise.all([commitEventDeliveryResolution(owner, prepared.proof, confirm), commitEventDeliveryResolution(owner, prepared.proof, confirm)]); assert.equal(result[0], result[1]); replacement = result[0];
          }
          assert.equal(await getEventDeliveryResolutionReplay(owner, headID, pair[1].id, confirm), replacement);
          await assert.rejects(() => getEventDeliveryResolutionReplay(owner, headID, pair[1].id, { ...confirm, expectedScopeResolution: undefined }));
          const check = (await outbox()).find(row => row.id === replacement)!; assert.equal(check.payload.caldavSplit!.prepared.split.creation.ref.externalEventId, nativeID); assert.equal(check.eventID, headID); assert.equal(check.predecessorID, source.id);
          if (scenario.endsWith("repeated")) {
            splitData = journal.prepared.split.creation.data.replace("Saved future portion", "Later native collision");
            assert.equal((await deliverEventOutbox(replacement, () => caldavAdapter))?.status, "conflict"); splitData = null;
            const again = await prepareEventDeliveryResolution(owner, headID, replacement, () => caldavAdapter);
            replacement = await commitEventDeliveryResolution(owner, again.proof, { ...confirm, mutationId: randomUUID(), expectedLatestOperationId: replacement });
          }
          if (!scenario.endsWith("http")) {
            const observations = normalizeCaldavResource({ url: nativeID, data: journal.prepared.split.creation.data, etag: '\"created\"' }).map(event => ({ externalId: event.externalId, etag: '\"created\"', icalUid: journal.prepared.split.creation.ref.icalUid!, values: { title: event.title, start: event.start, end: event.end, color: "#7A8BA3", isAllDay: event.isAllDay, description: event.description, location: event.location, organizer: event.organizer ?? "", recurrence: event.recurrence, url: event.url }, time: { timeModel: event.timeModel!, externalSeriesID: event.externalSeriesID, originalStart: event.originalStart, isCanceled: event.isCanceled } }));
            await assert.rejects(() => replaceExternalEventResource("caldav", owner, calendar.id, collection, nativeID, observations), "Pending replacement fences inbound import at the same native address");
          }
          if (scenario.endsWith("lost")) mode = "create-lost";
          if (scenario.endsWith("lease")) onSplitPut = async () => { await db.update(eventOutbox).set({ leaseUntil: new Date(0) }).where(eq(eventOutbox.id, replacement)); };
          if (scenario.endsWith("delete-during")) onSplitPut = async () => { await deleteExternalEvent("caldav", calendar.id, nativeID); };
          let delivered = await deliverEventOutbox(replacement, () => caldavAdapter);
          if (scenario.endsWith("lost")) {
            assert.equal(delivered?.status, "unconfirmed"); mode = "ok";
            await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, replacement)); delivered = await deliverEventOutbox(replacement, () => caldavAdapter);
          }
          if (scenario.endsWith("lease") || scenario.endsWith("delete-during")) { assert.notEqual(delivered?.status, "completed"); assert.deepEqual(await maps(), savedMaps); }
          else {
            assert.equal(delivered?.status, "completed", JSON.stringify(delivered));
            assert.equal(splitCreates, applied ? 0 : 1);
            const acceptedMaps = await maps(); assert.equal(acceptedMaps.length, mappings.length + 1);
            assert.ok(journal.after.moved.every(child => acceptedMaps.some(mapping => mapping.eventID === child.id && mapping.externalSeriesID === nativeID)));
            const observed = normalizeCaldavResource({ url: nativeID, data: splitData!, etag: '"created"' });
            await replaceExternalEventResource("caldav", owner, calendar.id, collection, nativeID, observed.map(event => ({ externalId: event.externalId, etag: '"created"', icalUid: journal.prepared.split.creation.ref.icalUid!, values: { title: event.title, start: event.start, end: event.end, color: "#7A8BA3", isAllDay: event.isAllDay, description: event.description, location: event.location, organizer: event.organizer ?? "", recurrence: event.recurrence, url: event.url }, time: { timeModel: event.timeModel!, externalSeriesID: event.externalSeriesID, originalStart: event.originalStart, isCanceled: event.isCanceled } })));
            assert.deepEqual(await rows(), savedRows); assert.deepEqual(await maps(), acceptedMaps);
          }
          assert.equal(puts, scenario.endsWith("source-edit") ? 2 : 1); assert.equal(deletes, 0);
          assert.deepEqual((await outbox()).find(row => row.id === source.id), source, "Completed source receipt remains immutable");
          continue;
        }
        if (scenario.startsWith("split-resolve-")) {
          const cut = original.find(item => item.isCanceled)!;
          const request = { operationID: randomUUID(), scope: "following", action: "update", expectedRevision: root.revision, originalStart: cut.originalStart, expectedOccurrenceRevision: cut.revision, patch: { title: "Saved following portion" } };
          const headers = { authorization: `Bearer ${credential.raw}`, "content-type": "application/json", [CLIENT_VERSION_HEADER]: PRODUCT_VERSION };
          const response = await fetch(`${apiOrigin}/events/${root.id}/scope`, { method: "POST", headers, body: JSON.stringify(request) });
          assert.equal(response.status, 200, await response.text());
          const pair = (await outbox()).sort((a, b) => a.position - b.position);
          assert.equal(pair.length, 2);
          let savedRows = await rows(); const savedMaps = await maps(), journal = pair[0].payload.caldavSplit!;
          const headID = journal.after.head.id, nativeID = journal.prepared.split.creation.ref.externalEventId;
          const ancestors = [{ data, etag }];
          data = data.replace("X-PRIVATE:Never disclose", "X-PRIVATE:Fresh split extension"); etag = '"remote-v2"';
          assert.equal((await deliverEventOutbox(pair[0].id, () => caldavAdapter))?.status, "conflict"); assert.equal(puts, 0); assert.equal(splitCreates, 0);
          if (scenario === "split-resolve-unknown-creation") {
            const selected = (await outbox()).find(row => row.id === pair[0].id)!;
            const leaseToken = randomUUID(), leaseState = { status: "attempting" as const, leaseToken, leaseUntil: new Date(Date.now() + 120000), remoteSnapshot: null };
            await db.update(eventOutbox).set(leaseState).where(eq(eventOutbox.id, selected.id));
            assert.equal(await confirmCaldavSplitOutbox(selected.id, leaseToken), true, "The actual legacy prepared pair is valid before its other row gets an unknown marker");
            await db.update(eventOutbox).set({ status: selected.status, leaseToken: selected.leaseToken, leaseUntil: selected.leaseUntil, remoteSnapshot: selected.remoteSnapshot }).where(eq(eventOutbox.id, selected.id));
            await db.update(eventOutbox).set({ payload: { ...pair[1].payload, operationEnvelope: { schemaVersion: 99 } } }).where(eq(eventOutbox.id, pair[1].id));
            const frozen = await outbox(), frozenRows = await rows(), frozenMaps = await maps(), readsBefore = providerGets;
            let factories = 0;
            await assert.rejects(() => prepareEventDeliveryResolution(owner, root.id, pair[0].id, () => { factories++; return caldavAdapter; }), (error: any) => error.code === "delivery-resolution-unavailable");
            assert.equal(factories, 0); assert.equal(providerGets, readsBefore, "An unknown creation prevents legacy source resolution before provider IO");
            assert.deepEqual(await outbox(), frozen); assert.deepEqual(await rows(), frozenRows); assert.deepEqual(await maps(), frozenMaps);
            await db.update(eventOutbox).set(leaseState).where(eq(eventOutbox.id, selected.id));
            const leasedPair = await outbox();
            assert.equal(await confirmCaldavSplitOutbox(selected.id, leaseToken), false);
            assert.deepEqual(await outbox(), leasedPair, "Worker source proof cannot interpret or rewrite its unknown creation");
            assert.equal(providerGets, readsBefore); assert.equal(puts, 0); assert.equal(splitCreates, 0);
            console.log("CalDAV split unknown paired creation: refused before adapter/provider IO, immutable pair: OK"); continue;
          }
          if (scenario.endsWith("native-content")) data = data.replace("SUMMARY:Cancelled", "SUMMARY:Concurrent future edit");
          if (scenario.endsWith("native-rule")) data = data.replace("COUNT=4", "COUNT=5");
          if (scenario.endsWith("native-collision")) splitData = journal.prepared.split.creation.data;
          if (scenario.endsWith("no-bind")) bindAllowed = false;
          const previewResponse = await fetch(`${apiOrigin}/events/${root.id}/delivery/${pair[0].id}/conflict`, { headers });
          const previewText = await previewResponse.text();
          if (scenario.includes("-native-") || scenario.endsWith("no-bind")) { assert.equal(previewResponse.status, 409); assert.deepEqual(await rows(), savedRows); assert.deepEqual(await maps(), savedMaps); continue; }
          assert.equal(previewResponse.status, 200, previewText);
          const publicPreview = JSON.parse(previewText), scope = { kind: "following-update" as const, originalStart: cut.originalStart!, newSeriesId: headID };
          assert.deepEqual(publicPreview.scopeResolution, scope); assert.equal(publicPreview.splitFuture.title, "Saved following portion"); assert.deepEqual(publicPreview.splitFuture.timeModel, journal.after.head.timeModel);
          assert.notEqual(publicPreview.local.recurrence, publicPreview.remote.recurrence);
          assert.ok(!previewText.includes("Fresh split extension") && !previewText.includes("BEGIN:VCALENDAR"));
          await assert.rejects(() => prepareEventDeliveryResolution(owner, headID, pair[1].id, () => caldavAdapter));
          const { preview, proof } = await prepareEventDeliveryResolution(owner, root.id, pair[0].id, () => caldavAdapter);
          const confirm = { mutationId: randomUUID(), expectedLocalRevision: preview.localRevision, expectedLatestOperationId: preview.latestOperationId, expectedRemoteExists: true, expectedRemoteEtag: preview.remoteEtag, expectedScopeResolution: scope };
          if (["old-client", "wrong-scope", "stale"].some(part => scenario.endsWith(part))) {
            const body: any = structuredClone(confirm);
            if (scenario.endsWith("old-client")) delete body.expectedScopeResolution;
            if (scenario.endsWith("wrong-scope")) body.expectedScopeResolution.newSeriesId = randomUUID();
            if (scenario.endsWith("stale")) etag = '"remote-v3"';
            const rejected = await fetch(`${apiOrigin}/events/${root.id}/delivery/${pair[0].id}/resolve`, { method: "POST", headers, body: JSON.stringify(body) });
            assert.equal(rejected.status, 409); assert.deepEqual(await rows(), savedRows); assert.deepEqual(await maps(), savedMaps); assert.equal((await outbox()).length, 2); continue;
          }
          if (scenario.endsWith("source-race") || scenario.endsWith("head-race") || scenario.endsWith("child-race")) await db.update(events).set({ revision: sql`${events.revision} + 1` }).where(eq(events.id, scenario.endsWith("source-race") ? root.id : scenario.endsWith("head-race") ? headID : cut.id));
          if (scenario.endsWith("head-deleted")) await db.update(events).set({ deletedAt: new Date() }).where(eq(events.id, headID));
          if (scenario.endsWith("grant")) await db.update(calendarMembers).set({ role: "viewer" }).where(and(eq(calendarMembers.calendarID, calendar.id), eq(calendarMembers.userID, owner)));
          if (scenario.endsWith("creation-lease")) await db.update(eventOutbox).set({ status: "attempting", attempts: 1, leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60_000) }).where(eq(eventOutbox.id, pair[1].id));
          if (scenario.endsWith("pair-metadata")) await db.update(eventOutbox).set({ payload: { ...pair[1].payload, resolution: { operationID: randomUUID(), replacedOperationIDs: [], expectedLocalRevision: 1, expectedLatestOperationID: pair[1].id, expectedRemoteExists: false, expectedRemoteEtag: null } } }).where(eq(eventOutbox.id, pair[1].id));
          if (scenario.endsWith("proof-identity")) proof.caldavSplit!.prepared.split.creation.master.id = randomUUID();
          if (scenario.endsWith("proof-request")) (proof.caldavSplit!.prepared.split.request as any).patch.title = "Tampered future";
          if (["source-race", "head-race", "child-race", "head-deleted", "grant", "creation-lease", "pair-metadata", "proof-identity", "proof-request"].some(part => scenario.endsWith(part))) {
            await assert.rejects(() => commitEventDeliveryResolution(owner, proof, confirm));
            if (!scenario.includes("-proof-")) {
              const rejected = await fetch(`${apiOrigin}/events/${root.id}/delivery/${pair[0].id}/resolve`, { method: "POST", headers, body: JSON.stringify(confirm) });
              assert.equal(rejected.status, 409, await rejected.text());
            }
            assert.deepEqual(await maps(), savedMaps); assert.equal((await outbox()).length, 2); assert.equal(puts, 0); continue;
          }
          let sourceID: string;
          if (scenario.endsWith("http")) {
            const response = await fetch(`${apiOrigin}/events/${root.id}/delivery/${pair[0].id}/resolve`, { method: "POST", headers, body: JSON.stringify(confirm) });
            assert.equal(response.status, 202, await response.text());
            sourceID = (await outbox()).find(item => item.mutationID === confirm.mutationId && item.position === 0)!.id;
            for (let attempt = 0; attempt < 100 && (await outbox()).find(item => item.id === sourceID)!.status !== "completed"; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
            assert.equal((await outbox()).find(item => item.id === sourceID)!.status, "completed");
          } else {
            const ids = await Promise.all([commitEventDeliveryResolution(owner, proof, confirm), commitEventDeliveryResolution(owner, proof, confirm)]);
            assert.equal(ids[0], ids[1]); sourceID = ids[0]!;
          }
          assert.equal(await getEventDeliveryResolutionReplay(owner, root.id, pair[0].id, confirm), sourceID);
          await assert.rejects(() => getEventDeliveryResolutionReplay(owner, root.id, pair[0].id, { ...confirm, expectedScopeResolution: { ...scope, newSeriesId: randomUUID() } }));
          assert.equal((await outbox()).length, 4); assert.deepEqual(await rows(), savedRows);
          if (scenario.endsWith("repeated")) {
            ancestors.push({ data, etag }); data = data.replace("Fresh split extension", "Another split extension"); etag = '"remote-v3"';
            assert.equal((await deliverEventOutbox(sourceID, () => caldavAdapter))?.status, "conflict");
            const again = await prepareEventDeliveryResolution(owner, root.id, sourceID, () => caldavAdapter);
            sourceID = await commitEventDeliveryResolution(owner, again.proof, { ...confirm, mutationId: randomUUID(), expectedLatestOperationId: again.preview.latestOperationId, expectedRemoteEtag: again.preview.remoteEtag });
          }
          const nextSource = (await outbox()).find(item => item.id === sourceID)!, nextJournal = nextSource.payload.caldavSplit!;
          assert.equal(nextJournal.after.head.id, headID); assert.equal(nextJournal.prepared.split.creation.ref.externalEventId, nativeID);
          assert.notEqual(nextJournal.creationOperationID, pair[1].id); if (!scenario.endsWith("http")) assert.equal(await claimEventOutbox(nextJournal.creationOperationID), undefined);
          mode = scenario.endsWith("lost-source") ? "lost" : "ok";
          let delivered = await deliverEventOutbox(sourceID, () => caldavAdapter);
          if (scenario.endsWith("lost-source")) {
            assert.equal(delivered?.status, "unconfirmed"); mode = "ok";
            await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, sourceID));
            delivered = await deliverEventOutbox(sourceID, () => caldavAdapter);
          }
          assert.equal(delivered?.status, "completed", JSON.stringify(delivered)); assert.equal(puts, 1); assert.equal(splitCreates, 0);
          const acceptedData = data, acceptedETag = etag, sourceMaps = await maps();
          for (const ancestor of ancestors) { data = ancestor.data; etag = ancestor.etag; assert.equal(await persist(), false); assert.deepEqual(await rows(), savedRows); assert.deepEqual(await maps(), sourceMaps); }
          data = acceptedData; etag = acceptedETag;
          const oldRows = (await outbox()).filter(item => nextSource.payload.resolution!.replacedOperationIDs.includes(item.id));
          assert.ok(oldRows.filter(item => item.eventID === root.id).every(item => item.status === "not-needed"));
          assert.ok(oldRows.filter(item => item.eventID === headID).every(item => item.status === "cancelled"));
          if (scenario.endsWith("source-edit")) {
            const edit = { operationID: randomUUID(), scope: "series", action: "update", expectedRevision: (await getEventSnapshot(root.id))!.revision, patch: { title: "Independent earlier series" } };
            const candidate = await applyLocalEventScope(root.id, owner, edit, { prepareProvider: true }); if (candidate.status !== "caldav_required") throw new Error("Source family remained blocked");
            await applyLocalEventScope(root.id, owner, edit, { caldav: await prepareCaldavSeries(candidate.context, edit) });
            const operation = (await outbox()).find(item => item.mutationID === edit.operationID)!;
            assert.equal((await deliverEventOutbox(operation.id, () => caldavAdapter))?.status, "completed"); savedRows = await rows();
          }
          mode = scenario.endsWith("lost-create") ? "create-lost" : "ok";
          if (scenario.endsWith("create-deletion")) onSplitPut = async () => { await deleteExternalEvent("caldav", calendar.id, nativeID); };
          let created = await deliverEventOutbox(nextJournal.creationOperationID, () => caldavAdapter);
          if (scenario.endsWith("create-deletion")) { assert.notEqual(created?.status, "completed"); assert.deepEqual(await maps(), sourceMaps); assert.equal(splitCreates, 1); continue; }
          if (scenario.endsWith("lost-create")) { assert.equal(created?.status, "unconfirmed"); mode = "ok"; await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, nextJournal.creationOperationID)); created = await deliverEventOutbox(nextJournal.creationOperationID, () => caldavAdapter); }
          assert.equal(created?.status, "completed", JSON.stringify(created)); assert.equal(splitCreates, 1);
          assert.deepEqual(await rows(), savedRows);
          assert.ok((await outbox()).filter(item => nextSource.payload.resolution!.replacedOperationIDs.includes(item.id)).every(item => item.status === "not-needed"));
          const observed = normalizeCaldavResource({ url: nativeID, etag: '"created"', data: splitData! }).map(event => ({ externalId: event.externalId, etag: '"created"', icalUid: headID, values: { title: event.title, start: event.start, end: event.end, color: "#7A8BA3", isAllDay: event.isAllDay, description: event.description, location: event.location, organizer: event.organizer ?? "", recurrence: event.recurrence, url: event.url }, time: { timeModel: event.timeModel!, externalSeriesID: event.externalSeriesID, originalStart: event.originalStart, isCanceled: event.isCanceled } }));
          await replaceExternalEventResource("caldav", owner, calendar.id, collection, nativeID, observed); await persist(); assert.deepEqual(await rows(), savedRows);
          assert.equal((await maps()).find(item => item.eventID === headID)!.externalEventID, nativeID);
          continue;
        }
        if (scenario.startsWith("delete-resolve-")) {
          const cut = original.find(item => item.isCanceled)!;
          const request = { operationID: randomUUID(), scope: "series", action: "delete", expectedRevision: root.revision };
          const headers = { authorization: `Bearer ${credential.raw}`, "content-type": "application/json", [CLIENT_VERSION_HEADER]: PRODUCT_VERSION };
          const response = await fetch(`${apiOrigin}/events/${root.id}/scope`, { method: "POST", headers, body: JSON.stringify(request) });
          assert.equal(response.status, 200, await response.text());
          const [operation] = await outbox(); const savedRows = await rows(), savedMaps = await maps();
          const ancestorSnapshots = [{ data, etag }];
          data = data.replace("X-PRIVATE:Never disclose", "X-PRIVATE:Fresh cut extension"); etag = '"remote-v2"';
          assert.equal((await deliverEventOutbox(operation.id, () => caldavAdapter))?.status, "conflict"); assert.equal(puts, 0);
          if (scenario.endsWith("native-time")) data = data.replace(stamp("DTSTART", "30", "14"), stamp("DTSTART", "31", "14"));
          if (scenario.endsWith("native-content")) data = data.replace("SUMMARY:Cancelled", "SUMMARY:Concurrent content");
          if (scenario.endsWith("no-resource-write")) writeUnknown = true;
          if (scenario.endsWith("no-unbind")) unbindAllowed = false;
          const previewResponse = await fetch(`${apiOrigin}/events/${root.id}/delivery/${operation.id}/conflict`, { headers });
          const previewText = await previewResponse.text();
          if (scenario.includes("-native-") || scenario.endsWith("no-unbind")) { assert.equal(previewResponse.status, 409); assert.deepEqual(await rows(), savedRows); assert.deepEqual(await maps(), savedMaps); continue; }
          assert.equal(previewResponse.status, 200, previewText);
          const publicPreview = JSON.parse(previewText);
          const scope = { kind: "series-delete" as const };
          assert.deepEqual(publicPreview.scopeResolution, scope);
          assert.equal(publicPreview.local, null); assert.equal(publicPreview.localRevision, null);
          assert.equal(publicPreview.remote.recurrence, root.recurrence);
          assert.ok(!previewText.includes("Fresh cut extension") && !previewText.includes("BEGIN:VCALENDAR"));
          const { preview, proof } = await prepareEventDeliveryResolution(owner, root.id, operation.id, () => caldavAdapter);
          const confirm = { mutationId: randomUUID(), expectedLocalRevision: preview.localRevision, expectedLatestOperationId: preview.latestOperationId, expectedRemoteExists: true, expectedRemoteEtag: preview.remoteEtag, expectedScopeResolution: scope };
          if (scenario.endsWith("old-client") || scenario.endsWith("wrong-cut") || scenario.endsWith("stale")) {
            const body: any = structuredClone(confirm);
            if (scenario.endsWith("old-client")) delete body.expectedScopeResolution;
            if (scenario.endsWith("wrong-cut")) body.expectedScopeResolution = { kind: "following-delete", originalStart: cut.originalStart };
            if (scenario.endsWith("stale")) etag = '"remote-v3"';
            const rejected = await fetch(`${apiOrigin}/events/${root.id}/delivery/${operation.id}/resolve`, { method: "POST", headers, body: JSON.stringify(body) });
            assert.equal(rejected.status, 409); assert.deepEqual(await rows(), savedRows); assert.deepEqual(await maps(), savedMaps); assert.equal((await outbox()).length, 1); continue;
          }
          if (scenario.endsWith("local-race")) await db.update(events).set({ revision: sql`${events.revision} + 1` }).where(eq(events.id, cut.id));
          if (scenario.endsWith("restored-child")) await db.update(events).set({ deletedAt: null }).where(eq(events.id, cut.id));
          if (scenario.endsWith("restored-root")) await db.update(events).set({ deletedAt: null }).where(eq(events.id, root.id));
          if (scenario.endsWith("grant")) await db.update(calendarMembers).set({ role: "viewer" }).where(and(eq(calendarMembers.calendarID, calendar.id), eq(calendarMembers.userID, owner)));
          if (scenario.endsWith("proof-baseline")) proof.caldavSeriesDeletion!.deletion.baseline.children[0].title = "Tampered deletion baseline";
          if (["local-race", "restored-child", "restored-root", "grant", "proof-baseline"].some(part => scenario.endsWith(part))) {
            await assert.rejects(() => commitEventDeliveryResolution(owner, proof, confirm)); assert.deepEqual(await maps(), savedMaps); assert.equal((await outbox()).length, 1); continue;
          }
          let replacementID: string;
          if (scenario.endsWith("http")) {
            const committed = await fetch(`${apiOrigin}/events/${root.id}/delivery/${operation.id}/resolve`, { method: "POST", headers, body: JSON.stringify(confirm) });
            assert.equal(committed.status, 202, await committed.text());
            replacementID = (await outbox()).find(item => item.id !== operation.id)!.id;
            for (let attempt = 0; attempt < 100 && (await outbox()).find(item => item.id === replacementID)!.status !== "completed"; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
            assert.equal((await outbox()).find(item => item.id === replacementID)!.status, "completed");
          } else replacementID = await commitEventDeliveryResolution(owner, proof, confirm);
          let replacement = (await outbox()).find(item => item.id === replacementID)!;
          assert.equal(await getEventDeliveryResolutionReplay(owner, root.id, operation.id, confirm), replacement.id);
          await assert.rejects(() => getEventDeliveryResolutionReplay(owner, root.id, operation.id, { ...confirm, expectedScopeResolution: undefined }));
          if (scenario.endsWith("repeated")) {
            ancestorSnapshots.push({ data, etag });
            data = data.replace("Fresh cut extension", "Another cut extension"); etag = '"remote-v3"';
            assert.equal((await deliverEventOutbox(replacement.id, () => caldavAdapter))?.status, "conflict");
            const again = await prepareEventDeliveryResolution(owner, root.id, replacement.id, () => caldavAdapter);
            const next = await commitEventDeliveryResolution(owner, again.proof, { ...confirm, mutationId: randomUUID(), expectedLatestOperationId: again.preview.latestOperationId, expectedRemoteEtag: again.preview.remoteEtag });
            replacement = (await outbox()).find(item => item.id === next)!;
          }
          assert.deepEqual(await rows(), savedRows); assert.equal(puts, 0); assert.equal(deletes, scenario.endsWith("http") ? 1 : 0);
          if (scenario.endsWith("unbind-after")) unbindAllowed = false;
          mode = scenario.endsWith("lost") ? "lost" : "ok";
          let delivered = await deliverEventOutbox(replacement.id, () => caldavAdapter);
          if (scenario.endsWith("unbind-after")) { assert.notEqual(delivered?.status, "completed"); assert.equal(deletes, 0); assert.equal((await maps()).length, savedMaps.length); assert.deepEqual(await rows(), savedRows); continue; }
          if (scenario.endsWith("lost")) {
            assert.equal(delivered?.status, "unconfirmed"); mode = "ok";
            await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, replacement.id));
            delivered = await deliverEventOutbox(replacement.id, () => caldavAdapter);
          }
          assert.equal(delivered?.status, "completed", JSON.stringify(delivered)); assert.equal(puts, 0); assert.equal(deletes, 1);
          const acceptedData = data, acceptedETag = etag, acceptedMaps = await maps();
          assert.equal(acceptedMaps.length, 0);
          assert.ok(acceptedMaps.every(item => item.etag === '"after"'));
          for (const snapshot of ancestorSnapshots) {
            data = snapshot.data; etag = snapshot.etag;
            assert.equal(await persist(), false); assert.deepEqual(await rows(), savedRows); assert.deepEqual(await maps(), acceptedMaps);
          }
          data = acceptedData; etag = acceptedETag; assert.equal(missing, true);
          assert.equal(await persist(), false); assert.deepEqual(await rows(), savedRows);
          if (scenario.endsWith("restore")) {
            data = ancestorSnapshots[0].data; etag = '"genuinely-restored"'; missing = false; await persist();
            const restored = (await rows()).find(item => !item.seriesID && !item.deletedAt)!;
            assert.ok(restored); assert.notEqual(restored.id, root.id);
            const restoredRows = await rows(); assert.ok(savedRows.every(old => restoredRows.find(item => item.id === old.id)?.deletedAt));
          }
          continue;
        }
        if (scenario.startsWith("following-resolve-")) {
          const cut = original.find(item => item.isCanceled)!;
          const request = { operationID: randomUUID(), scope: "following", action: "delete", expectedRevision: root.revision, originalStart: cut.originalStart, expectedOccurrenceRevision: cut.revision };
          const headers = { authorization: `Bearer ${credential.raw}`, "content-type": "application/json", [CLIENT_VERSION_HEADER]: PRODUCT_VERSION };
          const response = await fetch(`${apiOrigin}/events/${root.id}/scope`, { method: "POST", headers, body: JSON.stringify(request) });
          assert.equal(response.status, 200, await response.text());
          const [operation] = await outbox(); const savedRows = await rows(), savedMaps = await maps();
          const ancestorSnapshots = [{ data, etag }];
          data = data.replace("X-PRIVATE:Never disclose", "X-PRIVATE:Fresh cut extension"); etag = '"remote-v2"';
          assert.equal((await deliverEventOutbox(operation.id, () => caldavAdapter))?.status, "conflict"); assert.equal(puts, 0);
          if (scenario.endsWith("native-time")) data = data.replace(stamp("DTSTART", "30", "14"), stamp("DTSTART", "31", "14"));
          if (scenario.endsWith("native-content")) data = data.replace("SUMMARY:Cancelled", "SUMMARY:Concurrent content");
          const previewResponse = await fetch(`${apiOrigin}/events/${root.id}/delivery/${operation.id}/conflict`, { headers });
          const previewText = await previewResponse.text();
          if (scenario.includes("-native-")) { assert.equal(previewResponse.status, 409); assert.deepEqual(await rows(), savedRows); assert.deepEqual(await maps(), savedMaps); continue; }
          assert.equal(previewResponse.status, 200, previewText);
          const publicPreview = JSON.parse(previewText);
          const scope = { kind: "following-delete" as const, originalStart: cut.originalStart! };
          assert.deepEqual(publicPreview.scopeResolution, scope);
          assert.notEqual(publicPreview.local.recurrence, publicPreview.remote.recurrence);
          assert.equal(publicPreview.local.originalStart, undefined);
          assert.ok(!previewText.includes("Fresh cut extension") && !previewText.includes("BEGIN:VCALENDAR"));
          const { preview, proof } = await prepareEventDeliveryResolution(owner, root.id, operation.id, () => caldavAdapter);
          const confirm = { mutationId: randomUUID(), expectedLocalRevision: preview.localRevision, expectedLatestOperationId: preview.latestOperationId, expectedRemoteExists: true, expectedRemoteEtag: preview.remoteEtag, expectedScopeResolution: scope };
          if (scenario.endsWith("old-client") || scenario.endsWith("wrong-cut") || scenario.endsWith("stale")) {
            const body: any = structuredClone(confirm);
            if (scenario.endsWith("old-client")) delete body.expectedScopeResolution;
            if (scenario.endsWith("wrong-cut")) body.expectedScopeResolution.originalStart.value = "2026-03-31T07:00:00.000Z";
            if (scenario.endsWith("stale")) etag = '"remote-v3"';
            const rejected = await fetch(`${apiOrigin}/events/${root.id}/delivery/${operation.id}/resolve`, { method: "POST", headers, body: JSON.stringify(body) });
            assert.equal(rejected.status, 409); assert.deepEqual(await rows(), savedRows); assert.deepEqual(await maps(), savedMaps); assert.equal((await outbox()).length, 1); continue;
          }
          if (scenario.endsWith("local-race")) await db.update(events).set({ revision: sql`${events.revision} + 1` }).where(eq(events.id, cut.id));
          if (scenario.endsWith("restored-child")) await db.update(events).set({ deletedAt: null }).where(eq(events.id, cut.id));
          if (scenario.endsWith("grant")) await db.update(calendarMembers).set({ role: "viewer" }).where(and(eq(calendarMembers.calendarID, calendar.id), eq(calendarMembers.userID, owner)));
          if (scenario.endsWith("proof-cut")) proof.caldavSeries!.write.followingDelete!.expectedOccurrenceRevision = null;
          if (["local-race", "restored-child", "grant", "proof-cut"].some(part => scenario.endsWith(part))) {
            await assert.rejects(() => commitEventDeliveryResolution(owner, proof, confirm)); assert.deepEqual(await maps(), savedMaps); assert.equal((await outbox()).length, 1); continue;
          }
          let replacementID: string;
          if (scenario.endsWith("http")) {
            const committed = await fetch(`${apiOrigin}/events/${root.id}/delivery/${operation.id}/resolve`, { method: "POST", headers, body: JSON.stringify(confirm) });
            assert.equal(committed.status, 202, await committed.text());
            replacementID = (await outbox()).find(item => item.id !== operation.id)!.id;
            for (let attempt = 0; attempt < 100 && (await outbox()).find(item => item.id === replacementID)!.status !== "completed"; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
            assert.equal((await outbox()).find(item => item.id === replacementID)!.status, "completed");
          } else replacementID = await commitEventDeliveryResolution(owner, proof, confirm);
          let replacement = (await outbox()).find(item => item.id === replacementID)!;
          assert.equal(await getEventDeliveryResolutionReplay(owner, root.id, operation.id, confirm), replacement.id);
          await assert.rejects(() => getEventDeliveryResolutionReplay(owner, root.id, operation.id, { ...confirm, expectedScopeResolution: undefined }));
          if (scenario.endsWith("repeated")) {
            ancestorSnapshots.push({ data, etag });
            data = data.replace("Fresh cut extension", "Another cut extension"); etag = '"remote-v3"';
            assert.equal((await deliverEventOutbox(replacement.id, () => caldavAdapter))?.status, "conflict");
            const again = await prepareEventDeliveryResolution(owner, root.id, replacement.id, () => caldavAdapter);
            const next = await commitEventDeliveryResolution(owner, again.proof, { ...confirm, mutationId: randomUUID(), expectedLatestOperationId: again.preview.latestOperationId, expectedRemoteEtag: again.preview.remoteEtag });
            replacement = (await outbox()).find(item => item.id === next)!;
          }
          assert.deepEqual(await rows(), savedRows); assert.equal(puts, scenario.endsWith("http") ? 1 : 0);
          mode = scenario.endsWith("lost") ? "lost" : "ok";
          let delivered = await deliverEventOutbox(replacement.id, () => caldavAdapter);
          if (scenario.endsWith("lost")) {
            assert.equal(delivered?.status, "unconfirmed"); mode = "ok";
            await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, replacement.id));
            delivered = await deliverEventOutbox(replacement.id, () => caldavAdapter);
          }
          assert.equal(delivered?.status, "completed", JSON.stringify(delivered)); assert.equal(puts, 1);
          const acceptedData = data, acceptedETag = etag, acceptedMaps = await maps();
          assert.equal(acceptedMaps.length, savedMaps.length - 1);
          assert.ok(acceptedMaps.every(item => item.etag === '"after"'));
          for (const snapshot of ancestorSnapshots) {
            data = snapshot.data; etag = snapshot.etag;
            assert.equal(await persist(), false); assert.deepEqual(await rows(), savedRows); assert.deepEqual(await maps(), acceptedMaps);
          }
          data = acceptedData; etag = acceptedETag; await persist(); assert.deepEqual(await rows(), savedRows);
          if (scenario.endsWith("restore")) {
            data = ancestorSnapshots[0].data; etag = '"genuinely-restored"'; await persist();
            const restored = (await rows()).find(item => item.id === cut.id)!;
            assert.equal(restored.deletedAt, null); assert.equal(restored.revision, cut.revision + 2);
          }
          continue;
        }
        if (scenario.startsWith("definition-")) {
          const generated = scenario.includes("-generated-");
          const cancellation = scenario.includes("-cancel-");
          const revival = scenario.includes("-revive-");
          const originalTarget = generated ? undefined : original.find(item => item.seriesID && item.isCanceled === revival)!;
          const originalStart = originalTarget?.originalStart ?? (scenario.endsWith("all-day") ? { kind: "date", value: "2026-03-31" } : scenario.endsWith("floating") ? { kind: "floating", value: "2026-03-31T09:00:00.000" } : { kind: "instant", value: "2026-03-31T07:00:00.000Z" });
          const time = scenario.includes("-time-") ? { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-04-02T12:00:00.000", endLocal: "2026-04-02T13:00:00.000" } : undefined;
          const request = { operationID: randomUUID(), scope: "occurrence", expectedRevision: root.revision, originalStart, expectedOccurrenceRevision: originalTarget?.revision ?? null, ...(cancellation ? { action: "delete" } : { action: "update", patch: { title: "Saved definition content" }, ...(time ? { time } : {}) }) };
          const headers = { authorization: `Bearer ${credential.raw}`, "content-type": "application/json", [CLIENT_VERSION_HEADER]: PRODUCT_VERSION };
          const response = await fetch(`${apiOrigin}/events/${root.id}/scope`, { method: "POST", headers, body: JSON.stringify(request) });
          assert.equal(response.status, 200, await response.text());
          const [operation] = await outbox(); assert.equal((await outbox()).length, 1);
          const savedRows = await rows(), savedMaps = await maps();
          const selected = savedRows.find(item => item.id === operation.payload.caldavSeries!.write.targetEventID)!;
          assert.ok(selected); assert.equal(selected.isCanceled, cancellation);
          data = data.replace("X-PRIVATE:Never disclose", "X-PRIVATE:Fresh definition extension"); etag = '"remote-v2"';
          if (revival) data = data.replace("SUMMARY:Cancelled", "SUMMARY:Remote cancelled content");
          assert.equal((await deliverEventOutbox(operation.id, () => caldavAdapter))?.status, "conflict"); assert.equal(puts, 0);
          if (scenario === "definition-generated-native-child") data = data.replace("END:VCALENDAR", component(stamp("RECURRENCE-ID", "31", "09"), stamp("DTSTART", "31", "09"), stamp("DTEND", "31", "10"), "SUMMARY:Concurrent native definition") + "\r\nEND:VCALENDAR");
          if (scenario === "definition-generated-native-master") data = data.replace("SUMMARY:Master", "SUMMARY:Remote master");
          if (scenario === "definition-cancel-native-content") data = data.replace("SUMMARY:Moved", "SUMMARY:Remote child");
          if (scenario === "definition-revive-native-time") data = data.replace(stamp("DTSTART", "30", "09"), stamp("DTSTART", "31", "09"));
          const previewResponse = await fetch(`${apiOrigin}/events/${root.id}/delivery/${operation.id}/conflict`, { headers });
          const text = await previewResponse.text();
          if (scenario.includes("-native-")) {
            assert.equal(previewResponse.status, 409); assert.deepEqual(await rows(), savedRows); assert.deepEqual(await maps(), savedMaps); assert.equal((await outbox()).length, 1); continue;
          }
          assert.equal(previewResponse.status, 200, text);
          const publicPreview = JSON.parse(text);
          assert.equal(publicPreview.local.isCanceled, cancellation); assert.equal(publicPreview.remote.isCanceled, revival);
          assert.deepEqual(publicPreview.local.originalStart, originalStart); assert.deepEqual(publicPreview.remote.originalStart, originalStart);
          assert.deepEqual(publicPreview.local.timeModel, selected.timeModel);
          assert.equal(publicPreview.remote.title, generated ? "Master" : revival ? "Remote cancelled content" : "Moved");
          assert.ok(!text.includes("Fresh definition extension") && !text.includes("BEGIN:VCALENDAR"));
          const { preview, proof } = await prepareEventDeliveryResolution(owner, root.id, operation.id, () => caldavAdapter);
          const confirm = { mutationId: randomUUID(), expectedLocalRevision: preview.localRevision, expectedLatestOperationId: preview.latestOperationId, expectedRemoteExists: true, expectedRemoteEtag: preview.remoteEtag };
          if (scenario === "definition-generated-stale") {
            etag = '"remote-v3"';
            const rejected = await fetch(`${apiOrigin}/events/${root.id}/delivery/${operation.id}/resolve`, { method: "POST", headers, body: JSON.stringify(confirm) });
            assert.equal(rejected.status, 409); assert.deepEqual(await maps(), savedMaps); assert.equal((await outbox()).length, 1); continue;
          }
          if (scenario === "definition-generated-local-race") await db.update(events).set({ revision: sql`${events.revision} + 1` }).where(eq(events.id, selected.id));
          if (scenario === "definition-generated-grant") await db.update(calendarMembers).set({ role: "viewer" }).where(and(eq(calendarMembers.calendarID, calendar.id), eq(calendarMembers.userID, owner)));
          if (scenario === "definition-generated-proof-target") proof.caldavSeries!.write.targetEventID = original.find(item => item.seriesID)!.id;
          if (scenario === "definition-generated-proof-definition") proof.caldavSeries!.write.newDefinition!.title = "Tampered generated definition";
          if (scenario === "definition-cancel-proof-cancel") proof.caldavSeries!.write.cancelTarget = undefined;
          if (scenario.endsWith("-local-race") || scenario.endsWith("-grant") || scenario.includes("-proof-")) {
            await assert.rejects(() => commitEventDeliveryResolution(owner, proof, confirm));
            assert.deepEqual(await maps(), savedMaps); assert.equal((await outbox()).length, 1); assert.equal(puts, 0); continue;
          }
          const ids = await Promise.all([commitEventDeliveryResolution(owner, proof, confirm), commitEventDeliveryResolution(owner, proof, confirm)]);
          assert.equal(ids[0], ids[1]); let replacement = ids[0]!;
          assert.equal(await getEventDeliveryResolutionReplay(owner, root.id, operation.id, confirm), replacement);
          if (scenario === "definition-generated-repeated") {
            data = data.replace("Fresh definition extension", "Changed definition extension"); etag = '"remote-v3"';
            assert.equal((await deliverEventOutbox(replacement, () => caldavAdapter))?.status, "conflict");
            const again = await prepareEventDeliveryResolution(owner, root.id, replacement, () => caldavAdapter);
            replacement = await commitEventDeliveryResolution(owner, again.proof, { ...confirm, mutationId: randomUUID(), expectedLatestOperationId: again.preview.latestOperationId, expectedRemoteEtag: again.preview.remoteEtag });
          }
          if (scenario.endsWith("-lost")) mode = "lost";
          let delivered = await deliverEventOutbox(replacement, () => caldavAdapter);
          if (scenario.endsWith("-lost")) {
            assert.equal(delivered?.status, "unconfirmed"); assert.equal(puts, 1); mode = "ok";
            await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, replacement));
            delivered = await deliverEventOutbox(replacement, () => caldavAdapter);
          }
          assert.equal(delivered?.status, "completed", delivered?.errorCode ?? "no delivery"); assert.equal(puts, 1);
          assert.ok((await outbox()).filter(item => item.id !== replacement).every(item => item.status === "not-needed"));
          assert.deepEqual(await rows(), savedRows); assert.ok((await maps()).every(item => item.etag === '"after"'));
          assert.ok(data.includes("definition extension") && data.includes("DESCRIPTION:Private alarm"));
          await persist(); assert.deepEqual(await rows(), savedRows); assert.equal((await maps()).length, savedMaps.length);
          assert.equal(savedRows.length, original.length + (generated ? 1 : 0));
          console.log(`CalDAV definition conflict ${scenario}: original identity/status, exact intent, full ACK and stable echo OK`); continue;
        }
        if (scenario.startsWith("structure-")) {
          const occurrence = scenario.includes("-occurrence-");
          const recurrenceEdit = scenario.includes("-recurrence-") || scenario.includes("-combined-");
          const target = occurrence ? original.find(item => item.seriesID && !item.isCanceled)! : root;
          const time = scenario.includes("-recurrence-") ? undefined : scenario.endsWith("all-day")
            ? { kind: "all-day", startDate: "2026-04-02", endDate: "2026-04-03" }
            : { kind: scenario.endsWith("floating") ? "floating" : "zoned", ...(scenario.endsWith("floating") ? {} : { timeZone: "Europe/Prague" }), startLocal: "2026-04-02T12:00:00.000", endLocal: "2026-04-03T13:00:00.000" };
          const request = { operationID: randomUUID(), scope: occurrence ? "occurrence" : "series", action: "update", expectedRevision: root.revision, ...(occurrence ? { originalStart: target.originalStart, expectedOccurrenceRevision: target.revision } : {}), patch: recurrenceEdit ? { recurrence: "RRULE:FREQ=DAILY;COUNT=5" } : {}, ...(time ? { time } : {}) };
          const headers = { authorization: `Bearer ${credential.raw}`, "content-type": "application/json", [CLIENT_VERSION_HEADER]: PRODUCT_VERSION };
          const response = await fetch(`${apiOrigin}/events/${root.id}/scope`, { method: "POST", headers, body: JSON.stringify(request) });
          assert.equal(response.status, 200, await response.text());
          const [operation] = await outbox(); assert.equal((await outbox()).length, 1);
          const savedRows = await rows(), savedMaps = await maps();
          const savedTarget = savedRows.find(item => item.id === target.id)!;
          data = data.replace(`SUMMARY:${target.title}`, "SUMMARY:Remote selected").replace("X-PRIVATE:Never disclose", "X-PRIVATE:Fresh structural extension"); etag = '"remote-v2"';
          assert.equal((await deliverEventOutbox(operation.id, () => caldavAdapter))?.status, "conflict"); assert.equal(puts, 0);
          if (scenario === "structure-native-time") data = data.replace(stamp("DTSTART", "28", "09"), stamp("DTSTART", "27", "09"));
          if (scenario === "structure-native-rule") data = data.replace("COUNT=4", "COUNT=5");
          if (scenario === "structure-native-child") data = data.replace("SUMMARY:Cancelled", "SUMMARY:Another child");
          const previewResponse = await fetch(`${apiOrigin}/events/${root.id}/delivery/${operation.id}/conflict`, { headers });
          if (["structure-native-time", "structure-native-rule", "structure-native-child"].includes(scenario)) {
            assert.equal(previewResponse.status, 409); assert.deepEqual(await rows(), savedRows); assert.deepEqual(await maps(), savedMaps); assert.equal((await outbox()).length, 1); continue;
          }
          const text = await previewResponse.text(); assert.equal(previewResponse.status, 200, text);
          const publicPreview = JSON.parse(text);
          assert.equal(publicPreview.local.title, target.title); assert.equal(publicPreview.remote.title, "Remote selected");
          assert.deepEqual(publicPreview.local.timeModel, savedTarget.timeModel); assert.deepEqual(publicPreview.remote.timeModel, target.timeModel);
          assert.equal(publicPreview.local.recurrence, savedTarget.recurrence); assert.equal(publicPreview.remote.recurrence, target.recurrence);
          if (occurrence) assert.deepEqual(publicPreview.local.originalStart, target.originalStart);
          assert.ok(!text.includes("Fresh structural extension") && !text.includes("BEGIN:VCALENDAR"));
          const { preview, proof } = await prepareEventDeliveryResolution(owner, root.id, operation.id, () => caldavAdapter);
          const confirm = { mutationId: randomUUID(), expectedLocalRevision: preview.localRevision, expectedLatestOperationId: preview.latestOperationId, expectedRemoteExists: true, expectedRemoteEtag: preview.remoteEtag };
          if (scenario === "structure-stale") {
            etag = '"remote-v3"';
            const rejected = await fetch(`${apiOrigin}/events/${root.id}/delivery/${operation.id}/resolve`, { method: "POST", headers, body: JSON.stringify(confirm) });
            assert.equal(rejected.status, 409); assert.deepEqual(await maps(), savedMaps); assert.equal((await outbox()).length, 1); continue;
          }
          if (scenario === "structure-local-race") await db.update(events).set({ revision: sql`${events.revision} + 1` }).where(eq(events.id, original.find(item => item.seriesID)!.id));
          if (scenario === "structure-grant") await db.update(calendarMembers).set({ role: "viewer" }).where(and(eq(calendarMembers.calendarID, calendar.id), eq(calendarMembers.userID, owner)));
          if (scenario === "structure-lease") await db.update(eventOutbox).set({ status: "attempting", leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60000) }).where(eq(eventOutbox.id, operation.id));
          if (scenario === "structure-proof-time") proof.caldavSeries!.write.time = { kind: "all-day", startDate: "2026-04-04", endDate: "2026-04-04" };
          if (scenario === "structure-proof-rule") proof.caldavSeries!.write.patch.recurrence = "RRULE:FREQ=DAILY;COUNT=9";
          if (["structure-local-race", "structure-grant", "structure-lease", "structure-proof-time", "structure-proof-rule"].includes(scenario)) {
            await assert.rejects(() => commitEventDeliveryResolution(owner, proof, confirm));
            assert.deepEqual(await maps(), savedMaps); assert.equal((await outbox()).length, 1); assert.equal(puts, 0); continue;
          }
          const ids = await Promise.all([commitEventDeliveryResolution(owner, proof, confirm), commitEventDeliveryResolution(owner, proof, confirm)]);
          assert.equal(ids[0], ids[1]); let replacement = ids[0]!;
          assert.equal(await getEventDeliveryResolutionReplay(owner, root.id, operation.id, confirm), replacement);
          if (scenario === "structure-repeated") {
            data = data.replace("SUMMARY:Remote selected", "SUMMARY:Changed again"); etag = '"remote-v3"';
            assert.equal((await deliverEventOutbox(replacement, () => caldavAdapter))?.status, "conflict");
            const again = await prepareEventDeliveryResolution(owner, root.id, replacement, () => caldavAdapter);
            replacement = await commitEventDeliveryResolution(owner, again.proof, { ...confirm, mutationId: randomUUID(), expectedLatestOperationId: again.preview.latestOperationId, expectedRemoteEtag: again.preview.remoteEtag });
          }
          if (scenario === "structure-lost") mode = "lost";
          if (scenario === "structure-native-after") onPut = async () => { data = data.replace("SUMMARY:Cancelled", "SUMMARY:Changed after PUT"); etag = '"after-race"'; };
          let delivery = await deliverEventOutbox(replacement, () => caldavAdapter);
          if (scenario === "structure-lost") {
            assert.equal(delivery?.status, "unconfirmed"); assert.equal(puts, 1); mode = "ok";
            await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, replacement));
            delivery = await deliverEventOutbox(replacement, () => caldavAdapter);
          }
          if (scenario === "structure-native-after") {
            assert.equal(delivery?.status, "conflict"); assert.equal(delivery?.uncertain, true); assert.equal(puts, 1); assert.deepEqual(await rows(), savedRows);
            assert.ok((await maps()).every(item => item.etag === '"remote-v2"')); assert.ok(data.includes("SUMMARY:Changed after PUT"));
            await assert.rejects(() => prepareEventDeliveryResolution(owner, root.id, replacement, () => caldavAdapter)); continue;
          }
          assert.equal(delivery?.status, "completed", delivery?.errorCode ?? "no delivery"); assert.equal(puts, 1);
          assert.ok((await outbox()).filter(item => item.id !== replacement).every(item => item.status === "not-needed"));
          assert.deepEqual(await rows(), savedRows); assert.ok((await maps()).every(item => item.etag === '"after"'));
          assert.ok(data.includes("X-PRIVATE:Fresh structural extension") && data.includes("DESCRIPTION:Private alarm"));
          assert.ok(!data.includes("SUMMARY:Remote selected") && !data.includes("SUMMARY:Changed again"));
          await persist(); assert.deepEqual(await rows(), savedRows); assert.equal((await maps()).length, mappings.length);
          console.log(`CalDAV saved structural conflict ${scenario}: exact time/rule intent, full family ACK and echo OK`); continue;
        }
        if (scenario.startsWith("public-split-")) {
          const firstSlot = scenario.includes("-first-");
          const generatedSlot = scenario.includes("-generated-");
          const noOp = scenario.startsWith("public-split-noop");
          const cut = original.find(item => item.isCanceled)!;
          const firstStart = scenario.endsWith("all-day") ? { kind: "date", value: "2026-03-28" } : scenario.endsWith("floating") ? { kind: "floating", value: "2026-03-28T09:00:00.000" } : { kind: "instant", value: "2026-03-28T08:00:00.000Z" };
          const generatedStart = scenario.endsWith("all-day") ? { kind: "date", value: "2026-03-31" } : scenario.endsWith("floating") ? { kind: "floating", value: "2026-03-31T09:00:00.000" } : { kind: "instant", value: "2026-03-31T07:00:00.000Z" };
          const request = { operationID: randomUUID(), scope: "following", action: "update", expectedRevision: root.revision, originalStart: firstSlot ? firstStart : generatedSlot ? generatedStart : cut.originalStart, expectedOccurrenceRevision: firstSlot || generatedSlot ? null : cut.revision, patch: { title: noOp ? "Master" : "Public future family", ...(scenario === "public-split-noop-rule" ? { recurrence: "FREQ=DAILY;COUNT=4;INTERVAL=1;WKST=MO" } : {}), ...(scenario.endsWith("-recurrence") ? { recurrence: "FREQ=DAILY;COUNT=3;INTERVAL=1" } : {}) }, ...(scenario === "public-split-noop-time" ? { time: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-03-30T09:00:00.000", endLocal: "2026-03-31T09:00:00.000" } } : {}), ...(["public-split-time", "public-split-first-time"].includes(scenario) ? { time: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-03-30T11:00:00.000", endLocal: "2026-03-31T12:00:00.000" } } : {}) };
          const headers = { authorization: `Bearer ${credential.raw}`, "content-type": "application/json", [CLIENT_VERSION_HEADER]: PRODUCT_VERSION };
          const post = () => fetch(`${apiOrigin}/events/${root.id}/scope`, { method: "POST", headers, body: JSON.stringify(request) });
          if (scenario === "public-split-off") config.api.eventTimeEditsEnabled = false;
          if (scenario === "public-split-no-bind") bindAllowed = false;
          if (scenario === "public-split-bind-unknown") bindUnknown = true;
          if (scenario === "public-split-write-unknown") writeUnknown = true;
          if (scenario === "public-split-collision") splitData = data;
          if (scenario === "public-split-grant-race") onSplitRead = async () => { await db.update(calendarMembers).set({ role: "viewer" }).where(and(eq(calendarMembers.calendarID, calendar.id), eq(calendarMembers.userID, owner))); };
          if (scenario === "public-split-local-race") onSplitRead = async () => { onSplitRead = undefined; await db.update(events).set({ revision: sql`${events.revision} + 1` }).where(eq(events.id, cut.id)); };
          if (["public-split-root-tombstone", "public-split-child-tombstone"].includes(scenario)) onSplitRead = async href => { await deleteExternalEvent("caldav", calendar.id, href + (scenario === "public-split-child-tombstone" ? "#musubi-original=" + encodeURIComponent(JSON.stringify(cut.originalStart)) : "")); };
          const refused = ["public-split-off", "public-split-no-bind", "public-split-bind-unknown", "public-split-write-unknown", "public-split-grant-race", "public-split-local-race", "public-split-root-tombstone", "public-split-child-tombstone", "public-split-collision"].includes(scenario);
          const responses = refused ? [await post()] : await Promise.all([post(), post()]);
          for (const response of responses) {
            const text = await response.text();
            const expected = refused ? ["public-split-local-race", "public-split-root-tombstone", "public-split-child-tombstone", "public-split-collision"].includes(scenario) ? 409 : 403 : 200;
            assert.equal(response.status, expected, text);
            assert.ok(!text.includes("BEGIN:VCALENDAR") && !text.includes("Never disclose") && !text.includes(resource));
            if (!refused) assert.equal(JSON.parse(text).localCommitted, true);
          }
          assert.equal(puts, 0); assert.equal(splitCreates, 0);
          if (refused) {
            assert.equal((await outbox()).length, 0); assert.deepEqual(await maps(), mappings);
            if (scenario !== "public-split-local-race") assert.deepEqual(await rows(), original);
            else assert.equal((await rows()).length, original.length);
            continue;
          }
          const queued = (await outbox()).sort((a, b) => a.position - b.position);
          if (noOp) { assert.equal(queued.length, 0); assert.deepEqual(await rows(), original); continue; }
          assert.equal(queued.length, firstSlot ? 1 : 2);
          const saved = await rows(); assert.equal(saved.length, original.length + (firstSlot ? 0 : 1));
          for (const operation of queued) assert.equal((await deliverEventOutbox(operation.id, () => caldavAdapter))?.status, "completed");
          assert.equal(puts, 1); assert.equal(splitCreates, firstSlot ? 0 : 1);
          await persist();
          if (!firstSlot) {
            const creation = queued[1].payload.caldavSplit!.prepared.split.creation;
            const observations = normalizeCaldavResource({ url: creation.ref.externalEventId, data: splitData!, etag: '\"created\"' }).map(event => ({ externalId: event.externalId, etag: '\"created\"', icalUid: creation.ref.icalUid!, values: { title: event.title, start: event.start, end: event.end, color: "#7A8BA3", isAllDay: event.isAllDay, recurrence: event.recurrence, description: event.description, location: event.location, organizer: event.organizer ?? "", url: event.url }, time: { timeModel: event.timeModel!, externalSeriesID: event.externalSeriesID, originalStart: event.originalStart, isCanceled: event.isCanceled } }));
            await replaceExternalEventResource("caldav", owner, calendar.id, collection, creation.ref.externalEventId, observations);
          }
          assert.deepEqual(await rows(), saved);
          const replay = await post(); assert.equal(replay.status, 200); assert.equal((await replay.json()).replayed, true); assert.equal((await outbox()).length, queued.length);
          continue;
        }
        if (scenario === "series-sweep") {
          const request = { operationID: randomUUID(), scope: "series", action: "update", patch: { title: "Pending series" }, expectedRevision: root.revision };
          const candidate = await applyLocalEventScope(root.id, owner, request, { prepareProvider: true });
          if (candidate.status !== "caldav_required") throw new Error("Missing series context");
          const prepared = await prepareCaldavSeries(candidate.context, request);
          await applyLocalEventScope(root.id, owner, request, { caldav: prepared });
          const saved = await rows();
          const child = mappings.find(item => item.eventID !== root.id)!;
          assert.equal(await deleteExternalEvent("caldav", calendar.id, child.externalEventID), false);
          assert.equal(await sweepExternalEvents("caldav", calendar.id, []), 0);
          assert.deepEqual(await rows(), saved); assert.deepEqual(await maps(), mappings);
          assert.equal((await outbox())[0].status, "conflict"); continue;
        }
        if (scenario.startsWith("split-")) {
          // Exercise the internal transaction and worker independently of the
          // HTTP preflight covered by public-split scenarios above.
          const probe = { operationID: randomUUID(), scope: "series", action: "update", patch: { title: "Probe" }, expectedRevision: root.revision };
          const candidate = await applyLocalEventScope(root.id, owner, probe, { prepareProvider: true });
          if (candidate.status !== "caldav_required") throw new Error("Missing split context");
          const cut = original.find(item => item.isCanceled)!;
          const request = { operationID: randomUUID(), scope: "following" as const, action: "update" as const, expectedRevision: root.revision, originalStart: cut.originalStart!, expectedOccurrenceRevision: cut.revision, patch: { title: "New portion", ...(scenario === "split-recurrence" ? { recurrence: "FREQ=DAILY;COUNT=3;INTERVAL=1" } : {}) }, ...(scenario === "split-time" ? { time: { kind: "zoned" as const, timeZone: "Europe/Prague", startLocal: "2026-03-30T11:00:00.000", endLocal: "2026-03-31T12:00:00.000" } } : {}) };
          const splitCandidate = await applyLocalEventScope(root.id, owner, request, { prepareProvider: true });
          assert.equal(splitCandidate.status, "caldav_required"); if (splitCandidate.status === "caldav_required") assert.equal(splitCandidate.splitResource, true);
          const baseline = { master: candidate.context.master, children: candidate.context.children, ref: { externalEventId: resource, etag, icalUid: "family" } };
          const evidence = await caldavAdapter.readCaldavSeries!(owner, account.id, collection, baseline);
          const split = prepareCaldavSeriesSplit(evidence, baseline, request);
          const prepared = JSON.parse(JSON.stringify({ context: candidate.context, split }));
          const originalData = data;
          if (scenario === "split-native-tamper") prepared.split.creation.data = prepared.split.creation.data.replace("SUMMARY:New portion", "SUMMARY:Unplanned native title");
          if (scenario === "split-rollback") {
            const unrelated = randomUUID();
            await db.insert(eventOutbox).values({ id: unrelated, actorID: owner, mutationID: request.operationID, position: 1, eventID: randomUUID(), revision: 1, calendarID: calendar.id, externalCalendarLinkID: candidate.context.link.id, provider: "caldav", userID: owner, accountID: account.id, externalCalendarID: collection, action: "create", payload: { event: candidate.context.master } });
            await assert.rejects(() => applyLocalEventScope(root.id, owner, request, { caldavSplit: prepared }));
            assert.deepEqual(await rows(), original); assert.deepEqual(await maps(), mappings); assert.deepEqual((await outbox()).map(item => item.id), [unrelated]);
            assert.equal((await db.select().from(eventScopeOperations).where(eq(eventScopeOperations.actorID, owner))).length, 0); continue;
          }
          if (scenario === "split-race") {
            await db.update(events).set({ revision: sql`${events.revision} + 1` }).where(eq(events.id, cut.id));
            const before = await rows();
            assert.equal((await applyLocalEventScope(root.id, owner, request, { caldavSplit: prepared })).status, "conflict");
            assert.deepEqual(await rows(), before); assert.deepEqual(await maps(), mappings); assert.equal((await outbox()).length, 0); continue;
          }
          if (scenario === "split-tamper") {
            for (const mutate of [
              (value: typeof prepared) => { value.split.creation.children[0].title = "Lost cancellation content"; },
              (value: typeof prepared) => { value.split.creation.ref.etag = '"invented"'; },
              (value: typeof prepared) => { value.split.source.followingDelete.originalStart = baseline.children.find(child => !child.isCanceled)!.originalStart; },
              (value: typeof prepared) => { value.split.creation.master.id = root.id; },

            ]) {
              const invalid = structuredClone(prepared); mutate(invalid);
              await assert.rejects(() => applyLocalEventScope(root.id, owner, request, { caldavSplit: invalid }));
              assert.deepEqual(await rows(), original); assert.deepEqual(await maps(), mappings); assert.equal((await outbox()).length, 0);
            }
            continue;
          }
          const [first, second] = await Promise.all([applyLocalEventScope(root.id, owner, request, { caldavSplit: prepared }), applyLocalEventScope(root.id, owner, request, { caldavSplit: prepared })]);
          assert.deepEqual([first.status, second.status].sort(), ["replayed", "saved"]);
          let saved = await rows(); assert.equal(saved.length, original.length + 1);
          const moved = saved.find(item => item.id === cut.id)!;
          assert.equal(moved.seriesID, split.creation.master.id); assert.equal(moved.revision, cut.revision + 1); assert.equal(moved.isCanceled, true); assert.equal(moved.title, cut.title); assert.deepEqual(moved.start, cut.start);
          const retained = original.find(item => item.seriesID && !item.isCanceled)!;
          assert.deepEqual(saved.find(item => item.id === retained.id), retained);
          assert.deepEqual(await maps(), mappings);
          let queued = (await outbox()).sort((a, b) => a.position - b.position); assert.equal(queued.length, 2);
          assert.notEqual(queued[1].id, split.creation.master.id);
          assert.equal(queued[1].externalEventID, split.creation.ref.externalEventId);
          assert.equal(queued[1].icalUid, split.creation.master.id);
          if (scenario === "split-legacy-zoned") {
            for (const operation of queued) await db.update(eventOutbox).set({ ...(operation.action === "create" ? { id: split.creation.master.id } : {}), payload: { ...operation.payload, caldavSplit: { ...operation.payload.caldavSplit!, creationOperationID: split.creation.master.id } } }).where(eq(eventOutbox.id, operation.id));
            queued = (await outbox()).sort((a, b) => a.position - b.position);
            assert.equal(queued[1].id, split.creation.master.id);
          }
          assert.equal(queued[0].action, "update"); assert.equal(queued[1].action, "create"); assert.equal(queued[1].predecessorID, queued[0].id);
          assert.deepEqual(queued[0].payload.caldavSplit, queued[1].payload.caldavSplit);
          assert.equal(await claimEventOutbox(queued[1].id), undefined);
          await assert.rejects(persist);
          const newObservations = normalizeCaldavResource({ url: split.creation.ref.externalEventId, data: split.creation.data, etag: '"created"' }).map(event => ({ externalId: event.externalId, etag: '"created"', icalUid: split.creation.ref.icalUid!, values: { title: event.title, start: event.start, end: event.end, color: "#7A8BA3", isAllDay: event.isAllDay, recurrence: event.recurrence, description: event.description, location: event.location, organizer: event.organizer ?? "", url: event.url }, time: { timeModel: event.timeModel!, externalSeriesID: event.externalSeriesID, originalStart: event.originalStart, isCanceled: event.isCanceled } }));
          await assert.rejects(() => replaceExternalEventResource("caldav", owner, calendar.id, collection, split.creation.ref.externalEventId, newObservations));
          const observedRoot = newObservations.find(item => !item.time.externalSeriesID)!;
          await assert.rejects(() => upsertExternalEvent("caldav", owner, calendar.id, collection, observedRoot.externalId, observedRoot.values, observedRoot.etag, observedRoot.icalUid, undefined, observedRoot.time));
          assert.deepEqual(await rows(), saved); assert.deepEqual(await maps(), mappings);
          if (scenario === "split-sweep") {
            const movedMapping = mappings.find(item => item.eventID === cut.id)!;
            assert.equal(await deleteExternalEvent("caldav", calendar.id, movedMapping.externalEventID), false);
            assert.equal(await sweepExternalEvents("caldav", calendar.id, []), 0);
            assert.deepEqual(await rows(), saved); assert.deepEqual(await maps(), mappings);
            assert.equal((await outbox()).find(item => item.id === queued[0].id)!.status, "conflict");
            assert.equal(await claimEventOutbox(queued[1].id), undefined); continue;
          }
          if (scenario === "split-delete-fence") {
            await deleteExternalEvent("caldav", calendar.id, split.creation.ref.externalEventId);
            assert.equal((await outbox()).find(item => item.id === queued[1].id)!.status, "conflict");
            assert.equal((await db.select().from(externalEventTombstones).where(eq(externalEventTombstones.externalCalendarLinkID, candidate.context.link.id))).length, 1);
            assert.deepEqual(await rows(), saved); assert.deepEqual(await maps(), mappings); continue;
          }
          const lease = await claimEventOutbox(queued[0].id); assert.ok(lease);
          assert.equal(await completeEventOutbox(lease.id, lease.leaseToken!, split.source.baseline.ref, split.source.baseline.ref), undefined);
          await db.update(eventOutbox).set({ status: "pending", leaseToken: null, leaseUntil: null }).where(eq(eventOutbox.id, lease.id));
          const revoke = () => db.update(calendarMembers).set({ role: "viewer" }).where(and(eq(calendarMembers.calendarID, calendar.id), eq(calendarMembers.userID, owner))).then(() => {});
          if (scenario === "split-source-lost") mode = "lost";
          if (scenario === "split-source-race") mode = "race";
          if (scenario === "split-source-grant-before") onGet = revoke;
          if (scenario === "split-source-grant-after") onPut = revoke;
          if (scenario === "split-source-local-race") onPut = () => db.update(events).set({ title: "Newer local child", revision: sql`${events.revision} + 1` }).where(eq(events.id, moved.id)).then(() => {});
          if (scenario === "split-source-lease-race") onPut = () => db.update(eventOutbox).set({ leaseUntil: new Date(0) }).where(eq(eventOutbox.id, lease.id)).then(() => {});
          if (scenario === "split-source-collision") splitData = split.creation.data.replace("SUMMARY:New portion", "SUMMARY:Unrelated remote resource");
          if (scenario === "split-no-bind") bindAllowed = false;
          if (scenario === "split-pair-tamper") await db.update(eventOutbox).set({ externalEventID: collection + "wrong-destination.ics" }).where(eq(eventOutbox.id, queued[1].id));
          let sourceResult = await deliverEventOutbox(lease.id, () => caldavAdapter);
          if (scenario === "split-source-lost") {
            assert.equal(sourceResult?.status, "unconfirmed"); assert.deepEqual(await maps(), mappings); assert.equal(splitCreates, 0);
            mode = "ok"; await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, lease.id));
            sourceResult = await deliverEventOutbox(lease.id, () => caldavAdapter);
          }
          if (["split-pair-tamper", "split-source-race", "split-source-grant-before", "split-source-grant-after", "split-source-local-race", "split-source-lease-race", "split-source-collision", "split-no-bind", "split-native-tamper"].includes(scenario)) {
            assert.notEqual(sourceResult?.status, "completed"); assert.deepEqual(await maps(), mappings); assert.equal(splitCreates, 0);
            assert.equal(puts, ["split-pair-tamper", "split-source-grant-before", "split-source-collision", "split-no-bind", "split-native-tamper"].includes(scenario) ? 0 : 1);
            assert.equal(await claimEventOutbox(queued[1].id), undefined); continue;
          }
          assert.equal(sourceResult?.status, "completed", JSON.stringify(sourceResult)); assert.equal(puts, 1); assert.equal(splitCreates, 0); assert.equal(deletes, 0);
          const sourceMaps = await maps(); assert.equal(sourceMaps.length, mappings.length - split.creation.children.length);
          assert.ok(sourceMaps.every(item => item.etag === '\"after\"'));
          // Delayed removals from the old resource cannot poison either address.
          for (const mapping of mappings.filter(item => split.creation.children.some(child => child.id === item.eventID))) assert.equal(await deleteExternalEvent("caldav", calendar.id, mapping.externalEventID), false);
          assert.equal((await db.select().from(externalEventTombstones).where(eq(externalEventTombstones.externalCalendarLinkID, candidate.context.link.id))).length, 0);
          if (scenario === "split-edit-source") {
            const edit = { operationID: randomUUID(), scope: "series", action: "update", expectedRevision: (await getEventSnapshot(root.id))!.revision, patch: { title: "Independent old portion" } };
            const context = await applyLocalEventScope(root.id, owner, edit, { prepareProvider: true });
            if (context.status !== "caldav_required") throw new Error("Old portion remained blocked");
            const native = await prepareCaldavSeries(context.context, edit);
            await applyLocalEventScope(root.id, owner, edit, { caldav: native });
            const operation = (await outbox()).find(item => item.payload.caldavSeries)!;
            assert.equal((await deliverEventOutbox(operation.id, () => caldavAdapter))?.status, "completed"); saved = await rows();
          }
          if (scenario === "split-create-lost") mode = "create-lost";
          if (scenario === "split-create-grant-before") await revoke();
          if (scenario === "split-create-grant-after") onSplitPut = revoke;
          if (scenario === "split-create-root-delete") onSplitPut = async () => { await deleteExternalEvent("caldav", calendar.id, split.creation.ref.externalEventId); };
          if (scenario === "split-create-child-delete") onSplitPut = async () => { await deleteExternalEvent("caldav", calendar.id, split.creation.ref.externalEventId + "#musubi-original=" + encodeURIComponent(JSON.stringify(split.creation.children[0].originalStart))); };
          if (scenario === "split-create-local-race") onSplitPut = () => db.update(events).set({ title: "Newer local head", revision: sql`${events.revision} + 1` }).where(eq(events.id, split.creation.master.id)).then(() => {});
          if (scenario === "split-create-lease-race") onSplitPut = () => db.update(eventOutbox).set({ leaseUntil: new Date(0) }).where(eq(eventOutbox.id, queued[1].id)).then(() => {});
          let creationResult = await deliverEventOutbox(queued[1].id, () => caldavAdapter);
          if (scenario === "split-create-lost") {
            assert.equal(creationResult?.status, "unconfirmed"); assert.deepEqual(await maps(), sourceMaps);
            mode = "ok"; await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, queued[1].id));
            creationResult = await deliverEventOutbox(queued[1].id, () => caldavAdapter);
          }
          if (["split-create-root-delete", "split-create-child-delete", "split-create-grant-before", "split-create-grant-after", "split-create-local-race", "split-create-lease-race"].includes(scenario)) {
            assert.notEqual(creationResult?.status, "completed"); assert.deepEqual(await maps(), sourceMaps); assert.equal(splitCreates, scenario === "split-create-grant-before" ? 0 : 1); continue;
          }
          assert.equal(creationResult?.status, "completed", JSON.stringify(creationResult)); assert.equal(puts, scenario === "split-edit-source" ? 2 : 1); assert.equal(splitCreates, 1);
          const accepted = await maps(); assert.equal(accepted.length, mappings.length + 1);
          assert.equal(accepted.find(item => item.eventID === moved.id)!.externalSeriesID, split.creation.ref.externalEventId);
          assert.equal(accepted.find(item => item.eventID === moved.id)!.etag, '\"created\"');
          assert.deepEqual(await rows(), saved);
          const acceptedData = data, acceptedTag = etag;
          data = originalData; etag = '\"before\"'; assert.equal(await persist(), false); assert.deepEqual(await rows(), saved); assert.deepEqual(await maps(), accepted);
          data = acceptedData; etag = acceptedTag;
          await persist();
          await replaceExternalEventResource("caldav", owner, calendar.id, collection, split.creation.ref.externalEventId, newObservations);
          assert.deepEqual(await rows(), saved); assert.deepEqual(await maps(), accepted);
          await assert.rejects(() => prepareEventDeliveryResolution(owner, root.id, lease.id, () => caldavAdapter));
          continue;
        }
        if (scenario.startsWith("following-")) {
          const cut = original.find(item => item.isCanceled)!;
          const originalStart = scenario === "following-first" ? { kind: "instant", value: "2026-03-28T08:00:00.000Z" } : cut.originalStart;
          const request = { operationID: randomUUID(), scope: "following", action: "delete", expectedRevision: root.revision, originalStart, expectedOccurrenceRevision: scenario === "following-first" ? null : cut.revision };
          const candidate = await applyLocalEventScope(root.id, owner, request, { prepareProvider: true });
          if (candidate.status !== "caldav_required") throw new Error("Missing following scope context");
          const plan = planEventScope(candidate.context.master, candidate.context.children, request);
          const fullDelete = scenario === "following-first";
          assert.equal(candidate.deleteResource, fullDelete);
          const beforeData = data;
          const response = await fetch(`${apiOrigin}/events/${root.id}/scope`, { method: "POST", headers: { authorization: `Bearer ${credential.raw}`, "content-type": "application/json", [CLIENT_VERSION_HEADER]: PRODUCT_VERSION }, body: JSON.stringify(request) });
          assert.equal(response.status, 200, await response.text());
          if (scenario === "following-cleanup") {
            for (const id of plan.deletes) await db.update(events).set({ deletedAt: new Date("2020-01-01") }).where(eq(events.id, id));
            await purgeDeletedEvents(new Date("2021-01-01"));
          }
          const savedRows = await rows(); assert.equal(savedRows.length, original.length);
          for (const current of savedRows) {
            const previous = original.find(item => item.id === current.id)!;
            assert.equal(!!current.deletedAt, plan.deletes.includes(current.id));
            assert.equal(current.revision, previous.revision + (current.id === root.id || plan.deletes.includes(current.id) ? 1 : 0));
            if (current.id !== root.id && !plan.deletes.includes(current.id)) assert.deepEqual(current, previous);
          }
          assert.deepEqual(await maps(), mappings); await assert.rejects(persist);
          const [operation] = await outbox(); assert.equal((await outbox()).length, 1); assert.equal(operation.action, fullDelete ? "delete" : "update");
          assert.equal((await applyLocalEventScope(root.id, owner, request, { prepareProvider: true })).status, "replayed");
          const revoke = () => db.update(calendarMembers).set({ role: "viewer" }).where(and(eq(calendarMembers.calendarID, calendar.id), eq(calendarMembers.userID, owner))).then(() => {});
          if (scenario === "following-grant-before") onGet = revoke;
          if (scenario === "following-grant-after") onPut = revoke;
          if (scenario === "following-sweep-echo") onPut = async () => { for (const mapping of mappings.filter(item => plan.deletes.includes(item.eventID))) assert.equal(await deleteExternalEvent("caldav", calendar.id, mapping.externalEventID), false); };
          if (scenario === "following-local-race") onPut = () => db.update(events).set({ revision: sql`${events.revision} + 1` }).where(eq(events.id, cut.id)).then(() => {});
          if (scenario === "following-lease-race") onPut = () => db.update(eventOutbox).set({ leaseUntil: new Date(0) }).where(eq(eventOutbox.id, operation.id)).then(() => {});
          mode = scenario === "following-lost" ? "lost" : scenario === "following-race" ? "race" : "ok";
          let delivered = await deliverEventOutbox(operation.id, () => caldavAdapter);
          if (scenario === "following-lost") {
            assert.equal(delivered?.status, "unconfirmed"); assert.deepEqual(await maps(), mappings);
            mode = "ok"; await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, operation.id));
            delivered = await deliverEventOutbox(operation.id, () => caldavAdapter);
          }
          assert.equal(puts, fullDelete || scenario === "following-grant-before" ? 0 : 1); assert.equal(deletes, fullDelete ? 1 : 0);
          if (["following-race", "following-grant-before", "following-grant-after", "following-local-race", "following-lease-race"].includes(scenario)) {
            assert.notEqual(delivered?.status, "completed"); assert.deepEqual(await maps(), mappings);
            await assert.rejects(() => prepareEventDeliveryResolution(owner, root.id, operation.id, () => caldavAdapter)); continue;
          }
          assert.equal(delivered?.status, "completed", JSON.stringify(delivered));
          const acceptedMaps = await maps(); assert.equal(acceptedMaps.length, mappings.length - plan.deletes.length);
          assert.ok(acceptedMaps.every(item => item.etag === '"after"'));
          const acceptedData = data, acceptedETag = etag;
          data = beforeData; etag = '"before"'; assert.equal(await persist(), false); assert.deepEqual(await rows(), savedRows);
          data = acceptedData; etag = acceptedETag;
          for (const mapping of mappings.filter(item => plan.deletes.includes(item.eventID))) await deleteExternalEvent("caldav", calendar.id, mapping.externalEventID);
          assert.equal((await db.select().from(externalEventTombstones).where(eq(externalEventTombstones.externalCalendarLinkID, candidate.context.link.id))).length, 0);
          if (fullDelete) continue;
          await persist(); assert.deepEqual(await rows(), savedRows);
          if (scenario === "following-restore") {
            data = beforeData; etag = '"restored"'; await persist();
            const restored = (await rows()).find(item => item.id === cut.id)!;
            assert.equal(restored.deletedAt, null); assert.equal(restored.revision, cut.revision + 2); assert.equal((await rows()).length, original.length);
            assert.equal((await maps()).find(item => item.eventID === cut.id)!.externalEventID, mappings.find(item => item.eventID === cut.id)!.externalEventID);
          }
          if (scenario === "following-shift-collision") {
            const shift = { operationID: randomUUID(), scope: "series", action: "update", expectedRevision: (await getEventSnapshot(root.id))!.revision, patch: {}, time: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-03-29T09:00:00.000", endLocal: "2026-03-30T10:00:00.000" } };
            const beforeRows = await rows(), beforeMaps = await maps(), beforeOutbox = await outbox();
            await assert.rejects(() => applyLocalEventScope(root.id, owner, shift, { prepareProvider: true }), /retired occurrence identity/);
            assert.deepEqual(await rows(), beforeRows); assert.deepEqual(await maps(), beforeMaps); assert.deepEqual(await outbox(), beforeOutbox);
          }
          const current = (await getEventSnapshot(root.id))!;
          const edit = { operationID: randomUUID(), scope: "series", action: "update", expectedRevision: current.revision, patch: { title: "Retained family remains editable", ...(["following-regenerate", "following-recancel"].includes(scenario) ? { recurrence: "RRULE:FREQ=DAILY;COUNT=4" } : {}) } };
          const next = await applyLocalEventScope(root.id, owner, edit, { prepareProvider: true });
          if (next.status !== "caldav_required") throw new Error("Historical tombstone blocked the remaining family");
          const prepared = await prepareCaldavSeries(next.context, edit);
          assert.equal((await applyLocalEventScope(root.id, owner, edit, { caldav: prepared })).status, "saved");
          const nextOperation = (await outbox()).find(item => item.mutationID === edit.operationID)!;
          if (scenario === "following-content-conflict") {
            data = data.replace("SUMMARY:Master", "SUMMARY:Remote master"); etag = '"remote-content"';
            assert.equal((await deliverEventOutbox(nextOperation.id, () => caldavAdapter))?.status, "conflict");
            const { preview, proof } = await prepareEventDeliveryResolution(owner, root.id, nextOperation.id, () => caldavAdapter);
            assert.equal(preview.canResolve, true);
            const replacement = await commitEventDeliveryResolution(owner, proof, { mutationId: randomUUID(), expectedLocalRevision: preview.localRevision, expectedLatestOperationId: preview.latestOperationId, expectedRemoteExists: true, expectedRemoteEtag: preview.remoteEtag });
            assert.equal((await deliverEventOutbox(replacement!, () => caldavAdapter))?.status, "completed");
          } else assert.equal((await deliverEventOutbox(nextOperation.id, () => caldavAdapter))?.status, "completed");
          if (["following-regenerate", "following-recancel"].includes(scenario)) {
            const request = { operationID: randomUUID(), scope: "occurrence", expectedRevision: (await getEventSnapshot(root.id))!.revision, originalStart: cut.originalStart, expectedOccurrenceRevision: null, ...(scenario === "following-recancel" ? { action: "delete" } : { action: "update", patch: { title: "Recreated occurrence" } }) };
            const retry = await applyLocalEventScope(root.id, owner, request, { prepareProvider: true });
            if (retry.status !== "caldav_required") throw new Error("Missing regenerated scope context");
            const retryPrepared = await prepareCaldavSeries(retry.context, request);
            assert.equal(retryPrepared.write.newDefinition!.id, cut.id);
            assert.equal((await applyLocalEventScope(root.id, owner, request, { caldav: retryPrepared })).status, "saved");
            const retryOperation = (await outbox()).find(item => item.mutationID === request.operationID)!;
            assert.equal((await deliverEventOutbox(retryOperation.id, () => caldavAdapter))?.status, "completed");
            const child = (await rows()).find(item => item.id === cut.id)!;
            assert.equal(child.deletedAt, null); assert.equal(child.revision, cut.revision + 2); assert.equal(child.isCanceled, scenario === "following-recancel");
            await persist(); assert.equal((await rows()).length, original.length);
          }
          if (scenario === "following-cleanup") {
            await purgeDeletedEvents(new Date("2021-01-01")); assert.equal((await rows()).length, original.length - plan.deletes.length);
          }
          const finalRoot = (await getEventSnapshot(root.id))!;
          const remove = { operationID: randomUUID(), scope: "series", action: "delete", expectedRevision: finalRoot.revision };
          const final = await applyLocalEventScope(root.id, owner, remove, { prepareProvider: true });
          if (final.status !== "caldav_required") throw new Error("Remaining family cannot be deleted");
          const deletion = await prepareCaldavSeriesDelete(final.context, remove);
          assert.equal((await applyLocalEventScope(root.id, owner, remove, { caldavDeletion: deletion })).status, "saved");
          const finalOperation = (await outbox()).find(item => item.mutationID === remove.operationID)!;
          assert.equal((await deliverEventOutbox(finalOperation.id, () => caldavAdapter))?.status, "completed"); assert.deepEqual(await maps(), []);
          continue;
        }
        if (scenario.startsWith("delete-")) {
          const request = { operationID: randomUUID(), scope: "series", action: "delete", expectedRevision: root.revision };
          const candidate = await applyLocalEventScope(root.id, owner, request, { prepareProvider: true });
          if (candidate.status !== "caldav_required") throw new Error("Missing series deletion context");
          const prepared = await prepareCaldavSeriesDelete(candidate.context, request);
          if (scenario === "delete-prepare-race") {
            await db.update(events).set({ revision: sql`${events.revision} + 1` }).where(eq(events.id, original.find(item => item.seriesID)!.id));
            assert.equal((await applyLocalEventScope(root.id, owner, request, { caldavDeletion: prepared })).status, "conflict");
            assert.ok((await rows()).every(item => !item.deletedAt)); assert.deepEqual(await maps(), mappings); assert.equal((await outbox()).length, 0); continue;
          }
          if (scenario === "delete-zoned") {
            const response = await fetch(`${apiOrigin}/events/${root.id}/scope`, { method: "POST", headers: { authorization: `Bearer ${credential.raw}`, "content-type": "application/json", [CLIENT_VERSION_HEADER]: PRODUCT_VERSION }, body: JSON.stringify(request) });
            assert.equal(response.status, 200, await response.text());
          } else assert.equal((await applyLocalEventScope(root.id, owner, request, { caldavDeletion: prepared })).status, "saved");
          if (scenario === "delete-cleanup") {
            for (const item of original) await db.update(events).set({ deletedAt: new Date("2020-01-01") }).where(eq(events.id, item.id));
            await purgeDeletedEvents(new Date("2021-01-01"));
          }
          const savedRows = await rows();
          assert.equal(savedRows.length, original.length);
          assert.ok(savedRows.every(item => item.deletedAt && item.revision === original.find(old => old.id === item.id)!.revision + 1));
          assert.deepEqual(await maps(), mappings);
          const [operation] = await outbox(); assert.equal((await outbox()).length, 1); assert.equal(operation.action, "delete");
          assert.equal((await applyLocalEventScope(root.id, owner, request, { prepareProvider: true })).status, "replayed");
          await assert.rejects(persist); assert.deepEqual(await rows(), savedRows);
          const claim = await claimEventOutbox(operation.id); assert.ok(claim);
          assert.equal(await completeEventOutbox(operation.id, claim.leaseToken!, prepared.deletion.baseline.ref, prepared.deletion.baseline.ref), undefined);
          await db.update(eventOutbox).set({ status: "pending", leaseToken: null, leaseUntil: null, nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, operation.id));
          const revoke = () => db.update(calendarMembers).set({ role: "viewer" }).where(and(eq(calendarMembers.calendarID, calendar.id), eq(calendarMembers.userID, owner))).then(() => {});
          if (scenario === "delete-grant-before") onGet = revoke;
          if (scenario === "delete-grant-after") onDelete = revoke;
          if (scenario === "delete-sweep-echo") onDelete = async () => { assert.equal(await sweepExternalEvents("caldav", calendar.id, []), 0); };
          if (scenario === "delete-local-race") onDelete = () => db.update(events).set({ revision: sql`${events.revision} + 1` }).where(eq(events.id, original.find(item => item.seriesID)!.id)).then(() => {});
          if (scenario === "delete-lease-race") onDelete = () => db.update(eventOutbox).set({ leaseUntil: new Date(0) }).where(eq(eventOutbox.id, operation.id)).then(() => {});
          mode = scenario === "delete-lost" ? "lost" : scenario === "delete-race" ? "race" : "ok";
          let delivered = await deliverEventOutbox(operation.id, () => caldavAdapter);
          if (scenario === "delete-lost") {
            assert.equal(delivered?.status, "unconfirmed"); assert.deepEqual(await maps(), mappings);
            await deleteExternalEvent("caldav", calendar.id, resource); assert.deepEqual(await rows(), savedRows); assert.deepEqual(await maps(), mappings);
            mode = "ok"; await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, operation.id));
            delivered = await deliverEventOutbox(operation.id, () => caldavAdapter);
          }
          assert.equal(puts, 0); assert.equal(deletes, scenario === "delete-grant-before" ? 0 : 1);
          if (["delete-race", "delete-grant-before", "delete-grant-after", "delete-local-race", "delete-lease-race"].includes(scenario)) {
            assert.notEqual(delivered?.status, "completed"); assert.deepEqual(await maps(), mappings);
          } else {
            assert.equal(delivered?.status, "completed", JSON.stringify(delivered)); assert.deepEqual(await maps(), []);
            assert.equal(await persist(), false, "An old resource snapshot must not resurrect a confirmed deletion");
            assert.deepEqual(await rows(), savedRows); assert.deepEqual(await maps(), []);
            await deliverEventOutbox(operation.id, () => caldavAdapter); assert.equal(deletes, 1);
            if (scenario === "delete-recreate") {
              for (const mapping of mappings) await deleteExternalEvent("caldav", calendar.id, mapping.externalEventID);
              assert.equal((await db.select().from(externalEventTombstones).where(eq(externalEventTombstones.externalCalendarLinkID, prepared.context.link.id))).length, 0);
              missing = false; etag = '"recreated"'; assert.equal(await persist(), true);
              const recreated = (await rows()).find(item => !item.deletedAt && !item.seriesID)!; assert.notEqual(recreated.id, root.id);
              const edit = { operationID: randomUUID(), scope: "series", action: "update", expectedRevision: recreated.revision, patch: { title: "Editable recreation" } };
              const next = await applyLocalEventScope(recreated.id, owner, edit, { prepareProvider: true });
              assert.equal(next.status, "caldav_required"); if (next.status !== "caldav_required") throw new Error("Recreated family must remain editable");
              const nextPrepared = await prepareCaldavSeries(next.context, edit);
              assert.equal((await applyLocalEventScope(recreated.id, owner, edit, { caldav: nextPrepared })).status, "saved");
              const update = (await outbox()).find(item => item.mutationID === edit.operationID)!;
              assert.equal((await deliverEventOutbox(update.id, () => caldavAdapter))?.status, "completed");
            }
            if (scenario === "delete-cleanup") {
              await purgeDeletedEvents(new Date("2021-01-01")); assert.deepEqual(await rows(), []);
              assert.equal(await persist(), false); assert.deepEqual(await rows(), []); continue;
            }
            assert.equal((await applyLocalEventScope(root.id, owner, request, { prepareProvider: true })).status, "replayed");
          }
          continue;
        }
        if (scenario.startsWith("series-time-")) {
          const time = scenario.endsWith("all-day") ? { kind: "all-day", startDate: "2026-03-29", endDate: "2026-03-30" } : { kind: scenario.endsWith("floating") ? "floating" : "zoned", ...(scenario.endsWith("floating") ? {} : { timeZone: "Europe/Prague" }), startLocal: "2026-03-29T09:00:00.000", endLocal: "2026-03-30T10:00:00.000" };
          const request = { operationID: randomUUID(), scope: "series", action: "update", expectedRevision: root.revision, patch: {}, time };
          const candidate = await applyLocalEventScope(root.id, owner, request, { prepareProvider: true });
          if (candidate.status !== "caldav_required") throw new Error("Missing series time context");
          const prepared = await prepareCaldavSeries(candidate.context, request);
          const plan = planEventScope(candidate.context.master, candidate.context.children, request);
          if (scenario.endsWith("tombstone")) {
            const next = plan.updates.find(item => item.seriesID)!;
            await db.insert(externalEventTombstones).values({ externalCalendarLinkID: prepared.context.link.id, externalEventID: resource + "#musubi-original=" + encodeURIComponent(JSON.stringify(next.originalStart)) });
            await assert.rejects(() => applyLocalEventScope(root.id, owner, request, { caldav: prepared }));
            assert.deepEqual(await rows(), original); assert.deepEqual(await maps(), mappings); assert.equal((await outbox()).length, 0); continue;
          }
          assert.equal((await applyLocalEventScope(root.id, owner, request, { caldav: prepared })).status, "saved");
          const savedRows = await rows(), savedMaps = await maps();
          assert.equal(savedRows.length, original.length);
          for (const previous of original.filter(item => item.seriesID)) {
            const current = savedRows.find(item => item.id === previous.id)!;
            assert.deepEqual(current.timeModel, previous.timeModel); assert.equal(current.title, previous.title); assert.equal(current.isCanceled, previous.isCanceled);
            assert.deepEqual(current.originalStart, plan.updates.find(item => item.id === current.id)!.originalStart);
            assert.equal(current.revision, previous.revision + 1);
            const mapping = savedMaps.find(item => item.eventID === current.id)!;
            assert.deepEqual(mapping.originalStart, current.originalStart); assert.equal(mapping.id, mappings.find(item => item.eventID === current.id)!.id);
            assert.ok(mapping.externalEventID.endsWith(encodeURIComponent(JSON.stringify(current.originalStart))));
          }
          assert.ok(savedMaps.every(item => item.etag === '"before"' && !item.externalEventID.includes("musubi-pending")));
          await assert.rejects(persist); assert.deepEqual(await rows(), savedRows); assert.deepEqual(await maps(), savedMaps);
          const [operation] = await outbox(); assert.equal((await outbox()).length, 1);
          mode = scenario.endsWith("lost") ? "lost" : scenario.endsWith("race") ? "race" : "ok";
          let result = await deliverEventOutbox(operation.id, () => caldavAdapter);
          if (mode === "lost") {
            assert.equal(result?.status, "unconfirmed"); assert.deepEqual(await maps(), savedMaps); mode = "ok";
            await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, operation.id));
            result = await deliverEventOutbox(operation.id, () => caldavAdapter);
          }
          assert.equal(puts, 1);
          if (scenario.endsWith("race")) {
            assert.equal(result?.status, "conflict"); assert.deepEqual(await maps(), savedMaps);
            await assert.rejects(() => prepareEventDeliveryResolution(owner, root.id, operation.id, () => caldavAdapter), (error: any) => error.code === "delivery-resolution-unavailable");
          } else {
            assert.equal(result?.status, "completed", JSON.stringify(result?.errorCode));
            assert.ok((await maps()).every(item => item.etag === '"after"'));
            await persist(); assert.deepEqual(await rows(), savedRows); assert.equal((await maps()).length, mappings.length);
            assert.equal((await applyLocalEventScope(root.id, owner, request, { prepareProvider: true })).status, "replayed");
          }
          continue;
        }
        if (scenario.startsWith("generated-")) {
          const cancellation = scenario.includes("cancel");
          const generatedTime = scenario.startsWith("generated-time-") ? scenario.endsWith("all-day") ? { kind: "all-day", startDate: "2026-04-02", endDate: "2026-04-03" } : { kind: scenario.endsWith("floating") ? "floating" : "zoned", ...(scenario.endsWith("floating") ? {} : { timeZone: "Europe/Prague" }), startLocal: "2026-04-02T12:00:00.000", endLocal: "2026-04-02T13:00:00.000" } : undefined;
          const originalStart = scenario.endsWith("all-day") ? { kind: "date", value: "2026-03-31" } : scenario.endsWith("floating") ? { kind: "floating", value: "2026-03-31T09:00:00.000" } : { kind: "instant", value: "2026-03-31T07:00:00.000Z" };
          const generatedRequest = { operationID: randomUUID(), scope: "occurrence", ...(generatedTime ? { time: generatedTime } : {}), originalStart, expectedOccurrenceRevision: null, expectedRevision: root.revision, ...(cancellation ? { action: "delete" } : { action: "update", patch: { title: "New definition" } }) };
          const candidate = await applyLocalEventScope(root.id, owner, generatedRequest, { prepareProvider: true });
          assert.equal(candidate.status, "caldav_required"); if (candidate.status !== "caldav_required") throw new Error("Missing generated context");
          const prepared = await prepareCaldavSeries(candidate.context, generatedRequest);
          const definitionID = prepared.write.newDefinition!.id;
          if (scenario === "generated-prepare-race") {
            await db.update(events).set({ revision: sql`${events.revision} + 1` }).where(eq(events.id, root.id));
            assert.equal((await applyLocalEventScope(root.id, owner, generatedRequest, { caldav: prepared })).status, "conflict");
            assert.equal((await rows()).length, original.length); assert.deepEqual(await maps(), mappings); assert.equal((await outbox()).length, 0); continue;
          }
          if (scenario === "generated-tombstone") {
            await db.insert(externalEventTombstones).values({ externalCalendarLinkID: prepared.context.link.id, externalEventID: resource + "#musubi-original=" + encodeURIComponent(JSON.stringify(originalStart)) });
            await assert.rejects(() => applyLocalEventScope(root.id, owner, generatedRequest, { caldav: prepared }));
            assert.deepEqual(await rows(), original); assert.deepEqual(await maps(), mappings); assert.equal((await outbox()).length, 0); continue;
          }
          const queued = await applyLocalEventScope(root.id, owner, generatedRequest, { caldav: prepared });
          assert.equal(queued.status, "saved");
          const savedRows = await rows(), savedMaps = await maps();
          assert.equal(savedRows.length, original.length + 1); assert.equal(savedMaps.length, mappings.length + 1);
          assert.equal(savedRows.find(item => item.id === root.id)!.revision, root.revision + 1);
          const definition = savedRows.find(item => item.id === definitionID)!;
          assert.equal(definition.revision, 1); assert.equal(definition.isCanceled, cancellation);
          assert.deepEqual(definition.originalStart, originalStart);
          if (generatedTime) assert.deepEqual(definition.timeModel, resolveEventTimeEdit(generatedTime).timeModel);
          assert.ok(savedMaps.every(item => item.etag === '"before"'));
          assert.equal(savedMaps.find(item => item.eventID === definitionID)!.externalSeriesID, resource);
          const [operation] = await outbox(); assert.equal((await outbox()).length, 1);
          assert.equal((await applyLocalEventScope(root.id, owner, generatedRequest, { prepareProvider: true })).status, "replayed");
          await assert.rejects(persist, /Complete external event resource/); assert.deepEqual(await rows(), savedRows); assert.deepEqual(await maps(), savedMaps);
          mode = scenario.endsWith("lost") ? "lost" : scenario.endsWith("race") ? "race" : "ok";
          let delivered = await deliverEventOutbox(operation.id, () => caldavAdapter);
          if (scenario.endsWith("lost")) {
            assert.equal(delivered?.status, "unconfirmed");
            await assert.rejects(persist, /Complete external event resource/); assert.deepEqual(await rows(), savedRows); assert.deepEqual(await maps(), savedMaps);
            mode = "ok";
            await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, operation.id));
            delivered = await deliverEventOutbox(operation.id, () => caldavAdapter);
          }
          assert.equal(puts, 1);
          if (scenario.endsWith("race")) {
            assert.equal(delivered?.status, "conflict"); assert.deepEqual(await maps(), savedMaps);
            assert.ok(data.includes("SUMMARY:Remote child"));
          } else {
            assert.equal(delivered?.status, "completed", JSON.stringify(delivered?.errorCode));
            assert.ok(data.includes(master) && data.includes(child) && data.includes(cancelled));
            assert.ok((await maps()).every(item => item.etag === '"after"'));
            await persist(); assert.deepEqual(await rows(), savedRows);
            assert.equal((await maps()).filter(item => item.eventID === definitionID).length, 1);
            await deliverEventOutbox(operation.id, () => caldavAdapter); assert.equal(puts, 1);
          }
          continue;
        }
        const recurrenceEdit = scenario.startsWith("recurrence-");
        const cancellation = scenario.startsWith("cancel-");
        const revival = scenario.startsWith("revive-");
        const moving = scenario.startsWith("time-");
        const time = moving ? scenario.endsWith("all-day") ? { kind: "all-day", startDate: "2026-04-02", endDate: "2026-04-03" } : { kind: scenario.endsWith("floating") ? "floating" : "zoned", ...(scenario.endsWith("floating") ? {} : { timeZone: "Europe/Prague" }), startLocal: "2026-04-02T12:00:00.000", endLocal: "2026-04-02T13:00:00.000" } : undefined;
        const resolvingOccurrence = scenario.startsWith("resolve-occurrence-");
        const occurrence = cancellation || revival || moving || scenario.startsWith("occurrence-") || resolvingOccurrence;
        const moved = original.find(event => event.seriesID && event.isCanceled === revival)!;
        const request = { operationID: randomUUID(), scope: occurrence ? "occurrence" : "series", ...(time ? { time } : {}), ...(occurrence ? { originalStart: moved.originalStart, expectedOccurrenceRevision: moved.revision } : {}), expectedRevision: root.revision, ...(cancellation ? { action: "delete" } : { action: "update", patch: scenario === "no-op" ? {} : { title: "Renamed", ...(recurrenceEdit ? { recurrence: scenario === "recurrence-bare" ? "FREQ=DAILY;COUNT=5" : scenario === "recurrence-order" ? "FREQ=DAILY;INTERVAL=1;COUNT=5" : "RRULE:FREQ=DAILY;COUNT=5" } : {}) } }) };
        const headers = { authorization: `Bearer ${credential.raw}`, "content-type": "application/json", [CLIENT_VERSION_HEADER]: PRODUCT_VERSION };
        const post = (body = request) => fetch(`${apiOrigin}/events/${root.id}/scope`, { method: "POST", headers, body: JSON.stringify(body) });
        if (scenario === "recurrence-orphan") {
          const rejected = await post({ ...request, patch: { recurrence: "RRULE:FREQ=DAILY;COUNT=2" } } as any);
          assert.equal(rejected.status, 400, await rejected.text()); assert.deepEqual(await rows(), original); assert.deepEqual(await maps(), mappings); assert.equal((await outbox()).length, 0); continue;
        }
        if (scenario === "malformed-private") {
          data = data.replace("X-PRIVATE:Never disclose", "PRIVATE_CALDAV_MARKER_NO_COLON");
          const ICAL = (await import("ical.js")).default;
          assert.throws(() => ICAL.parse(data), /PRIVATE_CALDAV_MARKER_NO_COLON/);
          const stderrWrite = process.stderr.write;
          let logged = "";
          process.stderr.write = ((...args: any[]) => { logged += String(args[0]); return (stderrWrite as any).apply(process.stderr, args); }) as typeof process.stderr.write;
          try {
            const rejected = await post(); const body = await rejected.text();
            assert.equal(rejected.status, 409); assert.equal(JSON.parse(body).code, "provider-write-failed");
            assert.ok(!body.includes("PRIVATE_CALDAV_MARKER") && !body.includes("BEGIN:VCALENDAR"));
          } finally { process.stderr.write = stderrWrite; }
          assert.ok(logged.includes("http.request.rejected"));
          assert.ok(!logged.includes("PRIVATE_CALDAV_MARKER") && !logged.includes("BEGIN:VCALENDAR"), "Raw provider parser errors must never reach structured logs");
          assert.deepEqual(await rows(), original); assert.equal((await outbox()).length, 0); assert.equal(puts, 0);
          continue;
        }
        if (scenario === "copied") {
          const copy = await createCalendar({ creatorID: owner, name: "Other calendar", color: "red" });
          await db.insert(calendarEvents).values({ eventID: root.id, calendarID: copy.id });
        }
        if (["copied", "meeting"].includes(scenario)) {
          const rejected = await post(); assert.equal(rejected.status, 403, await rejected.text());
          assert.equal((await outbox()).length, 0); assert.equal(puts, 0); assert.equal((await getEventSnapshot(root.id))!.title, "Master");
          continue;
        }
        if (scenario === "zoned") {
          config.api.eventTimeEditsEnabled = false; assert.equal((await post()).status, 403); config.api.eventTimeEditsEnabled = true;
          for (const patch of [{ recurrence: null }, { url: "https://example.test" }]) assert.equal((await post({ ...request, patch } as any)).status, 403);
          assert.deepEqual(await rows(), original); assert.equal((await outbox()).length, 0); assert.equal(puts, 0);
        }
        if (scenario === "prepare-race") {
          const candidate = await applyLocalEventScope(root.id, owner, request, { prepareProvider: true });
          assert.equal(candidate.status, "caldav_required"); if (candidate.status !== "caldav_required") throw new Error("Missing context");
          const prepared = await prepareCaldavSeries(candidate.context, request);
          const moved = original.find(event => event.seriesID)!;
          await db.update(events).set({ title: "Concurrent local", revision: sql`${events.revision} + 1` }).where(eq(events.id, moved.id));
          assert.equal((await applyLocalEventScope(root.id, owner, request, { caldav: prepared })).status, "conflict");
          assert.equal((await outbox()).length, 0); assert.equal((await db.select().from(eventScopeOperations).where(eq(eventScopeOperations.actorID, owner))).length, 0); assert.equal((await getEventSnapshot(root.id))!.title, "Master");
          continue;
        }
        const responses = await Promise.all([post(), post()]);
        for (const response of responses) { const text = await response.text(); assert.equal(response.status, 200, text); assert.ok(!text.includes("Never disclose") && !text.includes("Private alarm") && !text.includes("BEGIN:VCALENDAR")); }
        const operations = await outbox();
        if (scenario === "no-op") { assert.equal(operations.length, 0); assert.deepEqual(await rows(), original); continue; }
        assert.equal(operations.length, 1);
        const statusResponse = await fetch(`${apiOrigin}/events/${root.id}/delivery`, { headers });
        assert.equal(statusResponse.status, 200);
        const publicStatus = await statusResponse.text();
        assert.ok(!publicStatus.includes("Never disclose") && !publicStatus.includes("Private alarm") && !publicStatus.includes("BEGIN:VCALENDAR") && !publicStatus.includes(resource));
        const operation = operations[0]!;
        assert.equal((await getEventSnapshot(root.id))!.revision, root.revision + 1);
        if (occurrence) {
          const current = (await rows()).find(event => event.id === moved.id)!;
          assert.deepEqual(current, { ...moved, ...(time ? resolveEventTimeEdit(time) : {}), ...(cancellation ? { isCanceled: true } : { title: "Renamed", ...(revival ? { isCanceled: false } : {}) }), revision: moved.revision + 1, updatedAt: current.updatedAt });
          assert.equal((await getEventSnapshot(root.id))!.title, "Master");
          assert.deepEqual((await rows()).filter(event => event.seriesID && event.id !== moved.id), original.filter(event => event.seriesID && event.id !== moved.id));
        } else assert.deepEqual((await rows()).filter(event => event.seriesID), original.filter(event => event.seriesID));
        assert.deepEqual(await maps(), mappings);
        await assert.rejects(persist, /resource could not be persisted/);
        assert.deepEqual(await maps(), mappings, "Pending pull cannot accept any component validator");
        if (["lost", "race", "occurrence-lost", "occurrence-race", "cancel-lost", "cancel-race", "revive-lost", "revive-race", "time-lost", "time-race", "recurrence-lost", "recurrence-race"].includes(scenario)) mode = scenario.replace(/^(occurrence|cancel|revive|time|recurrence)-/, "");
        const revokeGrant = async () => { await db.update(calendarMembers).set({ role: "viewer" }).where(and(eq(calendarMembers.calendarID, calendar.id), eq(calendarMembers.userID, owner))); };
        if (scenario === "grant-before") onGet = revokeGrant;
        if (scenario === "grant-after") onPut = revokeGrant;
        if (scenario === "local-race") onPut = async () => { await db.update(events).set({ revision: sql`${events.revision} + 1`, title: "Newer local child" }).where(eq(events.id, original.find(event => event.seriesID)!.id)); };
        if (scenario === "mapping-race") onPut = async () => { await db.update(externalEvents).set({ etag: '"newer-map"' }).where(eq(externalEvents.id, mappings.find(map => map.eventID !== root.id)!.id)); };
        if (scenario === "lease-race") onPut = async () => { await db.update(eventOutbox).set({ leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 120000) }).where(eq(eventOutbox.id, operation.id)); };
        if (scenario === "tombstone") onPut = async () => { await db.insert(externalEventTombstones).values({ externalCalendarLinkID: operation.externalCalendarLinkID, externalEventID: resource }); };
        if (scenario.startsWith("resolve")) { data = data.replace(resolvingOccurrence ? "SUMMARY:Moved" : "SUMMARY:Master", resolvingOccurrence ? "SUMMARY:Remote child" : "SUMMARY:Remote master").replace("X-PRIVATE:Never disclose", "X-PRIVATE:Fresh private extension"); etag = '"remote-v2"'; }
        let result = await deliverEventOutbox(operation.id, () => caldavAdapter);
        if (resolvingOccurrence) {
          assert.equal(result?.status, "conflict"); assert.equal(puts, 0);
          const stableRows = await rows(), stableMaps = await maps();
          if (scenario === "resolve-occurrence-native-time") data = data.replace(stamp("DTSTART", "30", "14"), stamp("DTSTART", "30", "15"));
          if (scenario === "resolve-occurrence-native-slot") data = data.replace(stamp("RECURRENCE-ID", "29", "09"), stamp("RECURRENCE-ID", "31", "09"));
          if (scenario === "resolve-occurrence-other-content") data = data.replace("SUMMARY:Master", "SUMMARY:Another remote master");
          if (scenario === "resolve-occurrence-timezone") data = data.replace("VERSION:2.0", "VERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Prague\r\nBEGIN:STANDARD\r\nDTSTART:20261025T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0300\r\nEND:STANDARD\r\nEND:VTIMEZONE");
          const previewResponse = await fetch(`${apiOrigin}/events/${root.id}/delivery/${operation.id}/conflict`, { headers });
          if (scenario.includes("-native-") || scenario.endsWith("-other-content") || scenario.endsWith("-timezone")) {
            assert.equal(previewResponse.status, 409); assert.equal((await outbox()).length, 1); assert.deepEqual(await rows(), stableRows); assert.deepEqual(await maps(), stableMaps); assert.equal(puts, 0); continue;
          }
          assert.equal(previewResponse.status, 200);
          const publicText = await previewResponse.text(); const publicPreview = JSON.parse(publicText);
          assert.equal(publicPreview.local.title, "Renamed"); assert.equal(publicPreview.remote.title, "Remote child");
          assert.deepEqual(publicPreview.local.originalStart, moved.originalStart); assert.deepEqual(publicPreview.remote.originalStart, moved.originalStart);
          assert.equal(publicPreview.localRevision, root.revision + 1, "The resource journal remains revisioned by its root");
          assert.ok(!publicText.includes("Fresh private extension") && !publicText.includes("BEGIN:VCALENDAR"));
          const { preview, proof } = await prepareEventDeliveryResolution(owner, root.id, operation.id, () => caldavAdapter);
          assert.equal(proof.caldavSeries?.write.targetEventID, moved.id);
          const resolveRequest = { mutationId: randomUUID(), expectedLocalRevision: preview.localRevision, expectedLatestOperationId: preview.latestOperationId, expectedRemoteExists: true, expectedRemoteEtag: preview.remoteEtag };
          if (scenario === "resolve-occurrence-stale") {
            etag = '"remote-v3"';
            const fresh = await prepareEventDeliveryResolution(owner, root.id, operation.id, () => caldavAdapter);
            await assert.rejects(() => commitEventDeliveryResolution(owner, fresh.proof, resolveRequest), (error: any) => error.code === "delivery-state-changed");
            assert.deepEqual(await maps(), stableMaps); assert.equal((await outbox()).length, 1); continue;
          }
          if (scenario === "resolve-occurrence-local-race") {
            await db.update(events).set({ revision: sql`${events.revision} + 1` }).where(eq(events.id, moved.id));
            await assert.rejects(() => commitEventDeliveryResolution(owner, proof, resolveRequest));
            assert.deepEqual(await maps(), stableMaps); assert.equal((await outbox()).length, 1); continue;
          }
          if (scenario === "resolve-occurrence-grant") {
            await db.update(calendarMembers).set({ role: "viewer" }).where(and(eq(calendarMembers.calendarID, calendar.id), eq(calendarMembers.userID, owner)));
            await assert.rejects(() => commitEventDeliveryResolution(owner, proof, resolveRequest));
            assert.deepEqual(await maps(), stableMaps); assert.equal((await outbox()).length, 1); continue;
          }
          if (scenario === "resolve-occurrence-target-tamper") {
            proof.caldavSeries!.write.targetEventID = original.find(item => item.isCanceled)!.id;
            await assert.rejects(() => commitEventDeliveryResolution(owner, proof, resolveRequest), (error: any) => error.code === "delivery-state-changed");
            assert.deepEqual(await maps(), stableMaps); assert.equal((await outbox()).length, 1); continue;
          }
          let replacementID: string;
          if (scenario === "resolve-occurrence-http") {
            const confirmed = await fetch(`${apiOrigin}/events/${root.id}/delivery/${operation.id}/resolve`, { method: "POST", headers, body: JSON.stringify(resolveRequest) });
            assert.equal(confirmed.status, 202, await confirmed.text());
            let replacement;
            for (let attempt = 0; attempt < 100; attempt++) {
              replacement = (await outbox()).find(item => item.id !== operation.id);
              if (replacement?.status === "completed") break;
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.equal(replacement?.status, "completed"); replacementID = replacement!.id;
          } else {
            const ids = await Promise.all([commitEventDeliveryResolution(owner, proof, resolveRequest), commitEventDeliveryResolution(owner, proof, resolveRequest)]);
            assert.equal(ids[0], ids[1]); replacementID = ids[0]!;
            assert.equal(await getEventDeliveryResolutionReplay(owner, root.id, operation.id, resolveRequest), replacementID);
            if (scenario === "resolve-occurrence-repeated") {
              data = data.replace("SUMMARY:Remote child", "SUMMARY:Changed again"); etag = '"remote-v3"';
              assert.equal((await deliverEventOutbox(replacementID, () => caldavAdapter))?.status, "conflict");
              const again = await prepareEventDeliveryResolution(owner, root.id, replacementID, () => caldavAdapter);
              assert.equal(again.preview.remote?.title, "Changed again");
              replacementID = await commitEventDeliveryResolution(owner, again.proof, { ...resolveRequest, mutationId: randomUUID(), expectedLatestOperationId: again.preview.latestOperationId, expectedRemoteEtag: again.preview.remoteEtag });
            }
            if (scenario === "resolve-occurrence-lost") mode = "lost";
            let delivery = await deliverEventOutbox(replacementID, () => caldavAdapter);
            if (scenario === "resolve-occurrence-lost") {
              assert.equal(delivery?.status, "unconfirmed"); assert.equal(puts, 1); mode = "ok";
              await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, replacementID));
              delivery = await deliverEventOutbox(replacementID, () => caldavAdapter);
            }
            assert.equal(delivery?.status, "completed");
          }
          assert.equal(puts, 1); assert.equal((await outbox()).length, scenario === "resolve-occurrence-repeated" ? 3 : 2);
          assert.ok((await outbox()).filter(item => item.id !== replacementID).every(item => item.status === "not-needed"));
          assert.deepEqual(await rows(), stableRows, "Conflict confirmation changes no canonical revision or draft");
          assert.ok((await maps()).every(item => item.etag === '"after"'));
          assert.ok(data.includes(master.replace("X-PRIVATE:Never disclose", "X-PRIVATE:Fresh private extension")) && data.includes(cancelled));
          assert.ok(data.includes("SUMMARY:Renamed") && !data.includes("SUMMARY:Remote child"));
          await persist(); assert.deepEqual(await rows(), stableRows, "Echo retains every canonical identity and revision");
          const next = await post({ ...request, operationID: randomUUID(), expectedRevision: root.revision + 1, expectedOccurrenceRevision: moved.revision + 1, patch: { title: "After occurrence resolution" } });
          assert.equal(next.status, 200, await next.text());
          console.log(`CalDAV occurrence conflict ${scenario}: complete HTTP/DB preservation and ACK OK`); continue;
        }
        if (scenario.startsWith("resolve")) {
          assert.equal(result?.status, "conflict");
          if (scenario === "resolve-timezone") {
            data = data.replace("VERSION:2.0", "VERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Prague\r\nBEGIN:STANDARD\r\nDTSTART:20261025T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0300\r\nEND:STANDARD\r\nEND:VTIMEZONE");
            const refused = await fetch(`${apiOrigin}/events/${root.id}/delivery/${operation.id}/conflict`, { headers });
            assert.equal(refused.status, 409); assert.equal((await outbox()).length, 1); assert.ok((await maps()).every(item => item.etag === '"before"')); continue;
          }
          const { preview, proof } = await prepareEventDeliveryResolution(owner, root.id, operation.id, () => caldavAdapter);
          assert.equal(preview.canResolve, true); assert.equal(preview.local?.title, "Renamed"); assert.equal(preview.remote?.title, "Remote master");
          const publicPreview = await fetch(`${apiOrigin}/events/${root.id}/delivery/${operation.id}/conflict`, { headers });
          const publicText = await publicPreview.text(); assert.equal(publicPreview.status, 200); assert.ok(!publicText.includes("Fresh private extension") && !publicText.includes("BEGIN:VCALENDAR"));
          const resolveRequest = { mutationId: randomUUID(), expectedLocalRevision: preview.localRevision, expectedLatestOperationId: preview.latestOperationId, expectedRemoteExists: true, expectedRemoteEtag: preview.remoteEtag };
          const unchangedMaps = await maps();
          if (scenario === "resolve-stale") {
            etag = '"remote-v3"';
            const fresh = await prepareEventDeliveryResolution(owner, root.id, operation.id, () => caldavAdapter);
            await assert.rejects(() => commitEventDeliveryResolution(owner, fresh.proof, resolveRequest), (error: any) => error.code === "delivery-state-changed");
            assert.deepEqual(await maps(), unchangedMaps); assert.equal((await outbox()).length, 1); continue;
          }
          if (scenario === "resolve-local-race") {
            const child = (await rows()).find(item => item.seriesID)!;
            await db.update(events).set({ title: "New local child", revision: sql`${events.revision} + 1` }).where(eq(events.id, child.id));
            await assert.rejects(() => commitEventDeliveryResolution(owner, proof, resolveRequest), (error: any) => error.code === "delivery-state-changed");
            assert.deepEqual(await maps(), unchangedMaps); assert.equal((await outbox()).length, 1); continue;
          }
          if (scenario === "resolve-http") {
            const confirmed = await fetch(`${apiOrigin}/events/${root.id}/delivery/${operation.id}/resolve`, { method: "POST", headers, body: JSON.stringify(resolveRequest) });
            assert.equal(confirmed.status, 202, await confirmed.text());
            let replacement;
            for (let attempt = 0; attempt < 100; attempt++) {
              replacement = (await outbox()).find(item => item.id !== operation.id);
              if (replacement?.status === "completed") break;
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.equal(replacement?.status, "completed"); assert.ok((await maps()).every(item => item.etag === '"after"'));
            console.log("CalDAV scope conflict authenticated HTTP confirmation/worker: OK"); continue;
          }
          const ids = await Promise.all([commitEventDeliveryResolution(owner, proof, resolveRequest), commitEventDeliveryResolution(owner, proof, resolveRequest)]);
          assert.equal(ids[0], ids[1]); assert.equal((await outbox()).length, 2);
          if (occurrence) assert.ok(data.includes(master) && data.includes(revival ? child : cancelled), "Native master and unrelated cancellation bytes are untouched");
          assert.ok((await maps()).every(item => item.etag === '"remote-v2"'));
          assert.equal(await getEventDeliveryResolutionReplay(owner, root.id, operation.id, resolveRequest), ids[0]);
          if (scenario === "resolve-child-race") { data = data.replace("SUMMARY:Moved", "SUMMARY:New remote child"); etag = '"remote-v3"'; }
          if (scenario === "resolve-delete-observation") {
            const before = await rows();
            const child = mappings.find(item => item.eventID !== root.id)!;
            assert.equal(await deleteExternalEvent("caldav", calendar.id, child.externalEventID), false);
            const journals = await outbox();
            assert.equal(journals.find(item => item.id === operation.id)!.errorCode, "superseded-by-resolution");
            assert.equal(journals.find(item => item.id === ids[0])!.status, "conflict");
            assert.deepEqual(await rows(), before);
            const again = await prepareEventDeliveryResolution(owner, root.id, ids[0]!, () => caldavAdapter);
            const second = await commitEventDeliveryResolution(owner, again.proof, { ...resolveRequest, mutationId: randomUUID(), expectedLatestOperationId: again.preview.latestOperationId, expectedRemoteEtag: again.preview.remoteEtag });
            assert.equal((await deliverEventOutbox(second, () => caldavAdapter))?.status, "completed");
            assert.ok((await outbox()).filter(item => item.id !== second).every(item => item.status === "not-needed")); continue;
          }
          if (scenario === "resolve-twice") {
            data = data.replace("SUMMARY:Remote master", "SUMMARY:Changed again"); etag = '"remote-v3"';
            assert.equal((await deliverEventOutbox(ids[0]!, () => caldavAdapter))?.status, "conflict");
            const again = await prepareEventDeliveryResolution(owner, root.id, ids[0]!, () => caldavAdapter);
            const second = await commitEventDeliveryResolution(owner, again.proof, { ...resolveRequest, mutationId: randomUUID(), expectedLatestOperationId: again.preview.latestOperationId, expectedRemoteEtag: again.preview.remoteEtag });
            assert.equal((await deliverEventOutbox(second, () => caldavAdapter))?.status, "completed");
            assert.ok((await outbox()).filter(item => item.id !== second).every(item => item.status === "not-needed"));
            if (occurrence) assert.ok(data.includes(master) && data.includes(revival ? child : cancelled), "Native master and unrelated cancellation bytes are untouched");
          assert.ok((await maps()).every(item => item.etag === '"after"')); console.log("CalDAV repeated conflict resolution releases exact history: OK"); continue;
          }
          const resolved = await deliverEventOutbox(ids[0]!, () => caldavAdapter);
          if (scenario === "resolve-child-race") {
            assert.equal(resolved?.status, "conflict"); assert.ok((await maps()).every(item => item.etag === '"remote-v2"')); assert.ok(data.includes("SUMMARY:New remote child")); continue;
          }
          assert.equal(resolved?.status, "completed"); assert.ok((await maps()).every(item => item.etag === '"after"'));
          assert.equal((await outbox()).find(item => item.id === operation.id)!.status, "not-needed");
          assert.ok(data.includes("SUMMARY:Renamed") && data.includes("X-PRIVATE:Fresh private extension"));
          const settled = await rows(); await persist(); assert.deepEqual(await rows(), settled);
          const next = await post({ ...request, operationID: randomUUID(), expectedRevision: root.revision + 1, patch: { title: "After resolution" } });
          assert.equal(next.status, 200, await next.text());
          continue;
        }

        if (scenario === "lost" || scenario === "occurrence-lost" || (scenario === "cancel-lost" || scenario === "revive-lost" || scenario === "time-lost" || scenario === "recurrence-lost")) {
          assert.equal(result?.status, "unconfirmed"); assert.deepEqual(await maps(), mappings);
          mode = "ok";
          await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, operation.id));
          result = await deliverEventOutbox(operation.id, () => caldavAdapter);
        }
        if (scenario.startsWith("grant-")) {
          assert.equal(result?.status, "conflict"); assert.equal(puts, scenario === "grant-before" ? 0 : 1);
          assert.deepEqual(await maps(), mappings); assert.equal((await outbox())[0]!.status, "conflict"); continue;
        }
        assert.equal(puts, 1);
        if (["recurrence-bare", "recurrence-order", "recurrence-zoned", "recurrence-all-day", "recurrence-floating", "recurrence-lost", "time-zoned", "time-all-day", "time-floating", "time-lost", "revive-zoned", "revive-all-day", "revive-floating", "revive-lost", "zoned", "all-day", "floating", "no-children", "lost", "occurrence-zoned", "occurrence-all-day", "occurrence-floating", "occurrence-lost", "cancel-zoned", "cancel-all-day", "cancel-floating", "cancel-lost"].includes(scenario)) {
          assert.equal(result?.status, "completed", JSON.stringify({ status: result?.status, error: result?.errorCode }));
          if (occurrence) assert.ok(data.includes(master) && data.includes(revival ? child : cancelled), "Native master and unrelated cancellation bytes are untouched");
          assert.ok((await maps()).every(map => map.etag === '"after"'));
          if (recurrenceEdit) assert.equal((await getEventSnapshot(root.id))!.recurrence, operation.payload.caldavSeries!.write.patch.recurrence);
          const confirmedRows = await rows(); await persist(); assert.deepEqual(await rows(), confirmedRows, "Accepted echo neither duplicates nor revises children");
          assert.equal((await post()).status, 200); assert.equal((await outbox()).length, 1);
          if (!cancellation) {
          const next = await post({ ...request, operationID: randomUUID(), expectedRevision: root.revision + 1, ...(occurrence ? { expectedOccurrenceRevision: moved.revision + 1 } : {}), patch: { title: "Next" } });
          assert.equal(next.status, 200, await next.text()); assert.equal((await outbox()).length, 2);
          }
        } else {
          assert.notEqual(result?.status, "completed");
          for (const map of await maps()) if (!(scenario === "mapping-race" && map.eventID !== root.id && map.etag === '"newer-map"')) assert.equal(map.etag, '"before"');
          const preview = await fetch(`${apiOrigin}/events/${root.id}/delivery/${operation.id}/conflict`, { headers });
          const text = await preview.text();
          if (scenario === "occurrence-race" || scenario === "time-race") {
            assert.equal(preview.status, 200); assert.equal(JSON.parse(text).remote.title, "Remote child");
            assert.deepEqual(JSON.parse(text).local.originalStart, moved.originalStart);
          } else {
            assert.equal(preview.status, 409); assert.equal(JSON.parse(text).code, ["lease-race", "local-race"].includes(scenario) ? "delivery-state-changed" : "delivery-resolution-unavailable");
          }
          assert.ok(!text.includes("Never disclose") && !text.includes("BEGIN:VCALENDAR"));
          if (scenario === "race" || scenario === "occurrence-race" || (scenario === "cancel-race" || scenario === "revive-race" || scenario === "time-race" || scenario === "recurrence-race")) {
            assert.ok(data.includes("SUMMARY:Remote child"));
            await db.update(eventOutbox).set({ status: "pending", nextAttemptAt: new Date(0), uncertain: false }).where(eq(eventOutbox.id, operation.id));
            const lease = await claimEventOutbox(operation.id); assert.ok(lease);
            assert.equal(await completeEventOutbox(operation.id, lease.leaseToken!, { externalEventId: resource, icalUid: "family", etag }, { externalEventId: resource, etag: '"before"', icalUid: "family" }), undefined, "Generic single-event ACK cannot settle a family operation");
            assert.equal(await confirmCaldavSeriesOutbox(operation.id, "00000000-0000-4000-8000-000000000000", { externalEventId: resource, icalUid: "family", etag }), false);
          }
        }
      } finally { await db.delete(user).where(eq(user.id, owner)); }
      console.log(`CalDAV scoped HTTP/outbox ${scenario}: OK`);
    }
  } finally {
    config.api.eventTimeEditsEnabled = enabled;
    fixture.closeAllConnections(); api.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => fixture.close(() => resolve())), new Promise<void>(resolve => api.close(() => resolve()))]);
    await db.$client.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
