import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { handlerStream } from "../handlers/stream";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { caldavAccounts, createTask, db, events, externalTasks, tasks, user, getUserExternalCalendars, reconcileCaldavReadAccess, updateTask, assertExternalTaskPush, setExternalTaskSyncData, queuePendingNotification, getDuePendingNotifications, eventOutbox, getEventDeliveryInbox, calendarMembers, setCursor, calendarEvents, createCalendar } from "@musubi/db";
import { config } from "@musubi/config";
import { encryptSecret } from "./crypto";
import { EventSchema, TaskSchema } from "@musubi/types";
import { normalizeCaldavResource } from "./adapters/caldav_time";
import { caldavAdapter } from "./adapters/caldav";
import type { CalendarAdapter, NormalizedChange } from "./adapter";
import { planDeliveries } from "../notification_dispatch";
import { syncProvider, pushTaskToCalendar } from "./engine";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const editorID = `caldav-editor-${randomUUID()}`;
  const userID = `caldav-read-${randomUUID()}`, accountID = randomUUID(), address = "http://127.0.0.1:1/calendar/";
  let read: boolean | null = true, readOnly = false, absent = false, failed = false, discovered = true, serial = 0, title = "Private original";
  let hold: { entered(): void; wait: Promise<void> } | undefined;
  const adapter: CalendarAdapter = { ...caldavAdapter,
    async listCalendars() { if (!discovered) throw new Error("Incomplete discovery"); return { calendars: absent ? [] : [{ externalId: address, name: "Private", color: "#7A8BA3", supportsEvents: true, supportsTasks: true, readOnly, caldavAccess: { read, readFreeBusy: true } }], taskListsComplete: true }; },
    async fetchChanges() {
      if (failed) throw new Error("Native read failed");
      const changes: NormalizedChange[] = [
        { kind: "event", data: { externalId: address + "event.ics", status: "active", title, description: "Private notes", location: "Private room", organizer: null, start: new Date("2026-09-15T09:00:00Z"), end: new Date("2026-09-15T10:00:00Z"), isAllDay: false, recurrence: null, url: null, etag: '"same"', icalUid: "event" } },
        { kind: "task", data: { externalId: address + "task.ics", title, description: "Private notes", status: "needs-action", start: null, due: null, isAllDay: false, completedAt: null, percentComplete: 0, priority: 0, recurrence: null, relatedTo: "private-parent", sequence: 4, url: "https://private.invalid", etag: '"same"', icalUid: "task" } },
      ];
      const component = (...lines: string[]) => ["BEGIN:VEVENT", "UID:family", ...lines, "END:VEVENT"].join("\r\n");
      const resource = normalizeCaldavResource({ url: address + "event.ics", etag: '\"same\"', data: ["BEGIN:VCALENDAR", "VERSION:2.0",
        component("DTSTART:20260915T090000Z", "DTEND:20260915T100000Z", "RRULE:FREQ=DAILY;COUNT=4", `SUMMARY:${title}`, "DESCRIPTION:Private notes"),
        component("RECURRENCE-ID:20260916T090000Z", "DTSTART:20260916T110000Z", "DTEND:20260916T120000Z", `SUMMARY:${title} child`),
        component("RECURRENCE-ID:20260917T090000Z", "DTSTART:20260917T090000Z", "DURATION:PT1H", "STATUS:CANCELLED", `SUMMARY:${title} cancelled`),
        "END:VCALENDAR"].join("\r\n") });
      changes[0] = { kind: "event-resource", externalId: address + "event.ics", events: resource };
      const pending = hold; hold = undefined; if (pending) { pending.entered(); await pending.wait; }
      return { changes, reset: true, nextCursor: `cursor-${++serial}` };
    },
  };
  await db.insert(user).values({ id: userID, name: "Read fixture", email: `${userID}@example.test` });
  await db.insert(user).values({ id: editorID, name: "Other editor", email: `${editorID}@example.test` });
  await db.insert(caldavAccounts).values({ id: accountID, userID, serverUrl: address, username: "fixture", encryptedPassword: encryptSecret("fixture") });
  const sync = () => syncProvider(adapter, userID, { id: accountID, label: "Fixture" });
  const source = async () => (await getUserExternalCalendars("caldav", userID, accountID))[0]!;
  const event = async () => (await db.select().from(events).where(eq(events.creatorID, userID))).find(row => !row.seriesID)!;
  const task = async () => (await db.select().from(tasks).where(eq(tasks.id, taskID))).find(row => row.id === taskID)!;
  let taskID = "";
  try {
    await sync(); taskID = (await db.select().from(tasks).where(eq(tasks.creatorID, userID)))[0]!.id;
    const firstEvent = await event(), firstTask = await task(), calendarID = (await source()).calendarID;
    const local = await createTask({ id: randomUUID(), creatorID: userID, calendarID, title: "Authored local task" });
    await db.update(tasks).set({ creatorID: editorID }).where(eq(tasks.id, taskID));
    readOnly = true; failed = true; await assert.rejects(sync());
    assert.equal((await task()).title, title, "Write loss alone does not retire read details");
    read = false; await sync();
    assert.equal((await event()).title, "Busy"); assert.equal((await event()).description, null);
    assert.ok((await db.select().from(events).where(eq(events.creatorID, userID))).every(row => row.title === "Busy" && row.providerReadRetiredRevision !== null), "All recurring children retire, including cancellation tombstones");
    assert.equal((await task()).title, "Private task"); assert.equal((await task()).description, null);
    assert.equal((await task()).sequence, firstTask.sequence, "Retirement does not borrow native SEQUENCE");
    assert.equal((await task()).providerReadRetiredGeneration, 1);
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, local.id)))[0]!.title, "Authored local task");
    assert.equal(await updateTask(taskID, { ...firstTask, status: "completed" }, { actorID: userID, mutationID: randomUUID(), expectedRevision: firstTask.revision, expectedProviderReadRetiredGeneration: 0 }), null, "Old full DTO cannot restore its private fields");
    assert.equal(await updateTask(taskID, { ...firstTask, status: "completed" }, { actorID: userID, mutationID: randomUUID(), expectedRevision: firstTask.revision, expectedProviderReadRetiredGeneration: 1 }), null, "Current counter does not override denied source");
    discovered = false; read = true; await assert.rejects(sync()); assert.equal((await task()).title, "Private task");
    discovered = true; read = null; await assert.rejects(sync()); assert.equal((await event()).title, "Busy");
    read = true; failed = false; readOnly = false; title = "Fresh permitted"; await sync();
    assert.equal((await event()).id, firstEvent.id); assert.equal((await event()).title, title);
    assert.equal((await task()).id, taskID); assert.equal((await task()).title, title); assert.equal((await task()).providerReadRetiredGeneration, 1);
    await db.update(tasks).set({ creatorID: userID }).where(eq(tasks.id, taskID));
    const current = await task(); assert.ok(await updateTask(taskID, { ...current, status: "completed" }, { actorID: userID, mutationID: randomUUID(), expectedRevision: current.revision, expectedProviderReadRetiredGeneration: 1 }));
    // A captured read cannot write events, tasks or cursor across a grant ABA.
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    hold = { entered, wait: new Promise<void>(resolve => { release = resolve; }) };
    const old = sync().then(() => null, error => error);
    await reached;
    await reconcileCaldavReadAccess(userID, accountID, calendarID, { read: false, readFreeBusy: true }, false);
    await reconcileCaldavReadAccess(userID, accountID, calendarID, { read: true, readFreeBusy: true }, false);
    const retiredEvent = await event(), retiredTask = await task(), retiredSource = await source();
    release(); assert.ok(await old); assert.deepEqual(await event(), retiredEvent); assert.deepEqual(await task(), retiredTask); assert.deepEqual(await source(), retiredSource);
    await queuePendingNotification({ userID, subjectID: firstEvent.id, kind: "event_changed", dueAt: new Date(0), payload: { title: "Old private queue" } });
    const eligible = async () => (await getDuePendingNotifications(new Date())).find(row => row.subjectID === firstEvent.id)?.eligible;
    assert.equal(await eligible(), false, "A late notification cannot expose retired payload");
    await sync(); assert.equal(await eligible(), false, "Fresh full resource never reauthorizes historical payload text");
    assert.equal(planDeliveries((await getDuePendingNotifications(new Date())).filter(row => row.subjectID === firstEvent.id)).deliveries.length, 0);
    await queuePendingNotification({ userID, subjectID: firstEvent.id, kind: "event_changed", dueAt: new Date(0), payload: { kind: "cancelled", title: (await event()).title, start: (await event()).start.toISOString(), isAllDay: false, eventRevision: (await event()).revision } });
    assert.equal(planDeliveries((await getDuePendingNotifications(new Date())).filter(row => row.subjectID === firstEvent.id)).deliveries.length, 1);
    assert.equal(await eligible(), true, "A newly captured authorized notification remains deliverable");
    // The real task adapter reads the complete native resource before PUT.
    // A downgrade during that read must prevent the outgoing mutation.
    const originalFetch = globalThis.fetch, allowPrivate = config.security.federationAllowPrivateHosts;
    config.security.federationAllowPrivateHosts = true;
    let nativePuts = 0, nativeReads = 0;
    globalThis.fetch = async (input, init) => {
      const target = new URL(String(input)); assert.equal(target.origin, "http://127.0.0.1:1");
      const body = String(init?.body ?? ""); let properties: string;
      if (init?.method === "PUT") { nativePuts++; return new Response(null, { status: 204, headers: { etag: '\"written\"' } }); }
      if (init?.method === "REPORT") {
        nativeReads++;
        await reconcileCaldavReadAccess(userID, accountID, calendarID, { read: false, readFreeBusy: true }, false);
        properties = '<d:getetag>"same"</d:getetag><c:calendar-data>BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:task\r\nSUMMARY:Private original\r\nEND:VTODO\r\nEND:VCALENDAR</c:calendar-data>';
      } else {
        assert.equal(init?.method, "PROPFIND");
        properties = body.includes("current-user-principal") ? "<d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal>" : "<c:calendar-home-set><d:href>/</d:href></c:calendar-home-set>";
      }
      const href = init?.method === "REPORT" ? address + "task.ics" : target.href;
      return new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${href}</d:href><d:propstat><d:prop>${properties}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, { status: 207, headers: { "content-type": "application/xml" } });
    };
    try { await pushTaskToCalendar(TaskSchema.parse(await task()), "update"); }
    finally { globalThis.fetch = originalFetch; config.security.federationAllowPrivateHosts = allowPrivate; }
    assert.equal(nativeReads, 1); assert.equal(nativePuts, 0, "Native preparation cannot carry an old full DTO past retirement");
    await sync();
    // Immediate delivery may commit remotely, then lose access before ACK.
    const originalUpdate = caldavAdapter.pushTaskUpdate!;
    let sends = 0;
    caldavAdapter.pushTaskUpdate = async (_u, _a, _c, _e, _task, ref) => {
      await ref?.beforeMutation?.(); sends++;
      await reconcileCaldavReadAccess(userID, accountID, calendarID, { read: false, readFreeBusy: true }, false);
      return { etag: '"remote-ack"' };
    };
    try { await pushTaskToCalendar(TaskSchema.parse(await task()), "update"); } finally { caldavAdapter.pushTaskUpdate = originalUpdate; }
    assert.equal(sends, 1); assert.equal((await task()).title, "Private task");
    const [mapping] = await db.select().from(externalTasks).where(eq(externalTasks.taskID, taskID));
    assert.equal(mapping!.etag, null, "Late ACK must not revive the retired validator");
    const link = await source(), snapshot = await task();
    const context = { provider: "caldav" as const, linkID: link.sourceID, revision: link.providerAccessRevision, userID, accountID, externalCalendarID: address };
    await assert.rejects(assertExternalTaskPush(snapshot, context));
    await assert.rejects(setExternalTaskSyncData("caldav", taskID, address, { etag: '"stale"', icalUid: "task" }, { task: snapshot, context }));
    const receiptID = randomUUID(), savedEvent = EventSchema.parse({ ...firstEvent, calendars: [calendarID] });
    await db.insert(eventOutbox).values({ id: receiptID, actorID: userID, mutationID: randomUUID(), position: 0, eventID: firstEvent.id, revision: firstEvent.revision, calendarID, externalCalendarLinkID: link.sourceID, provider: "caldav", userID, accountID, externalCalendarID: address, action: "delete", payload: { event: savedEvent }, status: "cancelled" });
    const savedIntent = (await db.select().from(eventOutbox).where(eq(eventOutbox.id, receiptID)))[0]!.payload;
    assert.equal((await getEventDeliveryInbox(userID)).items[0]!.savedTitle, "Calendar event");
    await reconcileCaldavReadAccess(userID, accountID, calendarID, { read: true, readFreeBusy: true }, false);
    assert.equal((await getEventDeliveryInbox(userID)).items[0]!.savedTitle, "Calendar event", "Regain alone does not reveal the retained private title");
    assert.deepEqual((await db.select().from(eventOutbox).where(eq(eventOutbox.id, receiptID)))[0]!.payload, savedIntent);
    title = "Newly authorized receipt title"; await sync();
    assert.equal((await getEventDeliveryInbox(userID)).items[0]!.savedTitle, title, "Receipt projects fresh content, never the immutable historical title");
    assert.deepEqual((await db.select().from(eventOutbox).where(eq(eventOutbox.id, receiptID)))[0]!.payload, savedIntent);
    const latestSource = await source();
    const latestContext = { ...context, revision: latestSource.providerAccessRevision };
    const [membership] = await db.select().from(calendarMembers).where(eq(calendarMembers.calendarID, calendarID));
    await db.delete(calendarMembers).where(eq(calendarMembers.id, membership!.id));
    await assert.rejects(assertExternalTaskPush(await task(), latestContext), /read access/);
    await assert.rejects(setCursor(calendarID, "late-membership", latestContext));
    await db.insert(calendarMembers).values(membership!);
    const [connected] = await db.select().from(caldavAccounts).where(eq(caldavAccounts.id, accountID));
    await db.delete(caldavAccounts).where(eq(caldavAccounts.id, accountID));
    await assert.rejects(assertExternalTaskPush(await task(), latestContext), /read access/);
    await assert.rejects(setCursor(calendarID, "late-disconnect", latestContext));
    await db.insert(caldavAccounts).values(connected!);
    absent = true; await sync(); assert.ok((await task()).deletedAt); assert.equal((await task()).title, "Private task"); assert.equal((await task()).originCalendarID, null); assert.equal((await getUserExternalCalendars("caldav", userID, accountID)).length, 0);
    console.log("CalDAV event/task read retirement, same-validator regain, ABA, task admission/ACK and notification fences: OK");
  } finally { await db.delete(user).where(eq(user.id, userID)); await db.delete(user).where(eq(user.id, editorID)); }
}
main().then(verifyResourceRestorationStream).then(() => process.exit(0), error => { console.error(error); process.exit(1); });


async function verifyResourceRestorationStream() {
  for (const laterFailure of [false, true]) {
    const owner = `caldav-resource-owner-${randomUUID()}`, reader = `caldav-resource-reader-${randomUUID()}`, accountID = randomUUID();
    const address = "http://127.0.0.1:1/resource-stream/";
    await db.insert(user).values([{ id: owner, name: "Owner", email: `${owner}@example.test` }, { id: reader, name: "Linked reader", email: `${reader}@example.test` }]);
    const emitted: string[] = [];
    const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, setHeader() {}, flushHeaders() {}, write(value: string) { emitted.push(value); return true; }, end() { response.writableEnded = true; } });
    const request = Object.assign(new EventEmitter(), { aborted: false, user: { id: reader, isExternal: true } });
    let injectFailure = false, title = "Private series", serial = 0;
    const adapter: CalendarAdapter = { ...caldavAdapter,
      async listCalendars() { return { calendars: [{ externalId: address, name: "Source", color: "red", supportsEvents: true, supportsTasks: false, readOnly: false, caldavAccess: { read: true, readFreeBusy: true } }], taskListsComplete: true }; },
      async fetchChanges() {
        const resource = normalizeCaldavResource({ url: address + "family.ics", etag: '"same"', data: ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:stream-family", "DTSTART:20260915T090000Z", "DTEND:20260915T100000Z", "RRULE:FREQ=DAILY;COUNT=3", `SUMMARY:${title}`, "END:VEVENT", "BEGIN:VEVENT", "UID:stream-family", "RECURRENCE-ID:20260916T090000Z", "DTSTART:20260916T110000Z", "DTEND:20260916T120000Z", `SUMMARY:${title} child`, "END:VEVENT", "END:VCALENDAR"].join("\r\n") });
        const changes: NormalizedChange[] = [{ kind: "event-resource", externalId: address + "family.ics", events: resource }];
        if (injectFailure) changes.push({ kind: "event-resource", externalId: address + "invalid.ics", events: [{ ...resource[0]!, externalId: address + "invalid.ics", timeModel: undefined }] });
        return { changes, reset: true, nextCursor: `stream-${++serial}` };
      },
    };
    const sync = () => syncProvider(adapter, owner, { id: accountID, label: "Stream fixture" });
    try {
      await db.insert(caldavAccounts).values({ id: accountID, userID: owner, serverUrl: address, username: "fixture", encryptedPassword: encryptSecret("fixture") });
      await sync();
      const source = (await getUserExternalCalendars("caldav", owner, accountID))[0]!;
      const family = await db.select().from(events).where(eq(events.creatorID, owner));
      const root = family.find(item => !item.seriesID)!;
      const linked = await createCalendar({ creatorID: owner, name: "Linked reader only", color: "red" });
      await db.insert(calendarEvents).values({ eventID: root.id, calendarID: linked.id });
      await db.insert(calendarMembers).values({ userID: reader, calendarID: linked.id, role: "viewer" });
      assert.equal((await db.select().from(calendarMembers).where(eq(calendarMembers.userID, reader))).some(member => member.calendarID === source.calendarID), false);
      await handlerStream(request as unknown as Request, response as unknown as Response);
      // Commit grant changes directly before the measured sync. Discovery sees
      // an unchanged full grant, so its invalidations cannot satisfy this test.
      await reconcileCaldavReadAccess(owner, accountID, source.calendarID, { read: false, readFreeBusy: true }, false);
      await reconcileCaldavReadAccess(owner, accountID, source.calendarID, { read: true, readFreeBusy: true }, false);
      assert.equal((await db.select().from(events).where(eq(events.id, root.id)))[0]!.title, "Busy");
      const cursorBefore = (await getUserExternalCalendars("caldav", owner, accountID))[0]!.cursor;
      emitted.length = 0; title = "Restored authorized series"; injectFailure = laterFailure;
      if (laterFailure) await assert.rejects(sync(), /Resource observation requires a time model and UID/);
      else assert.ok((await sync()).includes(linked.id));
      assert.equal((await db.select().from(events).where(eq(events.id, root.id)))[0]!.title, title);
      assert.ok(emitted.some(frame => frame.includes("external_sync") && frame.includes(linked.id) && frame.includes(source.calendarID)), "Linked-only stream reader receives the committed resource restoration, even before a later failure returns");
      if (laterFailure) assert.equal((await getUserExternalCalendars("caldav", owner, accountID))[0]!.cursor, cursorBefore, "Partial resource failure does not commit the cursor");
      injectFailure = false;
      await sync();
      emitted.length = 0;
      await sync();
      assert.equal(emitted.some(frame => frame.includes("external_sync")), false, "An unchanged complete resource remains a quiet no-op");
      console.log(`CalDAV resource restoration linked-only stream (${laterFailure ? "later invalid resource" : "normal"}): OK`);
    } finally { request.emit("close"); response.emit("close"); await db.delete(user).where(eq(user.id, owner)); await db.delete(user).where(eq(user.id, reader)); }
  }
}
