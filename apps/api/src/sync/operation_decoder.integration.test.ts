import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { EventSchema, TaskSchema } from "@musubi/types";
import {
  db, user, calendarEvents, calendarTasks, events, tasks, eventOutbox, taskOutbox,
  externalCalendars, externalEvents, externalTasks, createCalendar, createEvent, getDueEventOutboxIDs, getDueTaskOutboxIDs,
  getEventOutboxRow, getTaskOutbox, finishEventOutbox, getEventDeliveryStatus, getTaskDeliveryStatus,
  reconcileGoogleCalendarAccess, deleteExternalEvent, upsertExternalEvent, upsertExternalTask,
  type EventOutboxRow, type TaskOutboxRow,
} from "@musubi/db";
import { retainPendingEventPull, retainUnmappedCreatePull } from "../../../../packages/db/src/queries/event-outbox-pull";
import type { CalendarAdapter } from "./adapter";
import { deliverEventOutbox } from "./event_delivery";
import { deliverTaskOutbox } from "./task_delivery";
import { canonicalTaskProjection } from "./task_write";
import { prepareEventDeliveryResolution } from "./event_resolution";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Use a disposable test database");
  const owner = `decoder-${randomUUID()}`;
  await db.insert(user).values({ id: owner, name: "Decoder fixture", email: `${owner}@example.test` });
  const calendar = await createCalendar({ creatorID: owner, name: "Decoder", color: "#112233" });
  const [source] = await db.insert(externalCalendars).values({ calendarID: calendar.id,
    provider: "google", userID: owner, accountID: owner, externalCalendarID: "fixture",
    supportsEvents: true, supportsTasks: true }).returning();
  const event = () => EventSchema.parse({ id: randomUUID(), creatorID: owner,
    title: "Accepted original", color: "#112233", organizer: owner,
    start: "2026-10-01T09:00:00Z", end: "2026-10-01T10:00:00Z", isAllDay: false,
    isCanceled: false, originCalendarID: calendar.id, calendars: [calendar.id] });
  const task = () => TaskSchema.parse({ id: randomUUID(), creatorID: owner,
    calendarID: calendar.id, originCalendarID: calendar.id, calendarIDs: [calendar.id], title: "Accepted task" });
  const enqueueEvent = async (payload: EventOutboxRow["payload"], extra: Partial<EventOutboxRow> = {}) => {
    const [row] = await db.insert(eventOutbox).values({ id: randomUUID(), actorID: owner,
      mutationID: randomUUID(), position: 0, eventID: payload.event.id, revision: 1,
      calendarID: calendar.id, externalCalendarLinkID: source.id, provider: "google", userID: owner,
      accountID: owner, externalCalendarID: source.externalCalendarID, action: "create", payload,
      nextAttemptAt: new Date(0), ...extra }).returning();
    return row;
  };
  const enqueueTask = async (payload: TaskOutboxRow["payload"], extra: Partial<TaskOutboxRow> = {}) => {
    const [row] = await db.insert(taskOutbox).values({ id: randomUUID(), actorID: owner,
      mutationID: randomUUID(), position: 0, taskID: payload.task.id, revision: 1,
      calendarID: calendar.id, externalCalendarLinkID: source.id, provider: "google", userID: owner,
      accountID: owner, externalCalendarID: source.externalCalendarID,
      providerAccessRevision: source.providerAccessRevision, retiredGeneration: 0, action: "create", payload,
      nextAttemptAt: new Date(0), ...extra }).returning();
    return row;
  };
  let factories = 0, providerCalls = 0;
  const forbidden = () => { factories++; throw new Error("Unknown operation reached adapter factory"); };
  const hash = (payload: unknown) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const envelope = (row: EventOutboxRow | TaskOutboxRow) => {
    const kind = "eventID" in row ? "event" : "task";
    return { schemaVersion: 1, profileVersion: "sync-profile-v1",
      operation: { kind, action: row.action, version: 1 },
      serializer: { id: kind === "event" ? "google-personal-event" : "google-task", version: 1 },
      commandId: row.mutationID, operationId: row.id, hostObjectId: "eventID" in row ? row.eventID : row.taskID,
      locator: { provider: row.provider, connectionId: row.accountID, collectionId: row.externalCalendarID,
        resourceId: "eventID" in row ? row.externalEventID ?? "planned-native" : row.externalTaskID ?? "planned-native" },
      sourceEpoch: { sourceId: row.externalCalendarLinkID, generation: 0 }, acceptedRevision: row.revision,
      privacyEpoch: "fixture:0", allowedSideEffects: ["provider-content-write"],
      admittedProjection: { data: { title: "Accepted original" } }, nativePlan: { kind: "codec-data", data: { title: "Accepted original" } },
    };
  };
  try {
    // Malformed body/private family metadata must not be parsed before envelope routing.
    for (const operationEnvelope of [null, {}, { version: 99 }, { version: 1, profileVersion: "future" }]) {
      const row = await enqueueEvent({ event: event(), operationEnvelope,
        organizer: { request: { provider: "google" } } as never });
      const result = await deliverEventOutbox(row.id, forbidden);
      assert.equal(result?.status, "blocked");
      assert.equal(result?.uncertain, false);
      assert.equal(hash(result?.payload), hash(row.payload), "decoder does not rewrite admitted JSON");
      assert.equal(result?.leaseToken, null);
      assert.equal(result?.leaseUntil, null);
      assert.equal((await getEventDeliveryStatus(owner, row.eventID)).targets[0]?.issue, "recovery-unavailable");
      const taskRow = await enqueueTask({ task: task(), operationEnvelope });
      const taskResult = await deliverTaskOutbox(taskRow.id, forbidden);
      assert.equal(taskResult?.status, "blocked");
      assert.equal(hash(taskResult?.payload), hash(taskRow.payload));
      assert.equal((await getTaskDeliveryStatus(owner, taskRow.taskID)).targets[0]?.issue, "recovery-unavailable");
    }
    for (const kind of ["event", "task"] as const) {
      for (const mode of ["valid-hold", "schema", "profile", "serializer", "serializer-version", "identity"] as const) {
        const row = kind === "event" ? await enqueueEvent({ event: event() }) : await enqueueTask({ task: task() });
        const operationEnvelope = envelope(row);
        if (mode === "schema") operationEnvelope.schemaVersion = 2;
        if (mode === "profile") operationEnvelope.profileVersion = "sync-profile-v2";
        if (mode === "serializer") operationEnvelope.serializer.id = "unknown-serializer";
        if (mode === "serializer-version") operationEnvelope.serializer.version = 2;
        if (mode === "identity") operationEnvelope.operationId = randomUUID();
        const expectedCode = { "valid-hold": "operation-envelope-codec-unavailable", schema: "operation-envelope-schema-unsupported",
          profile: "operation-envelope-profile-unsupported", serializer: "delivery-serializer-unavailable",
          "serializer-version": "delivery-serializer-unavailable", identity: "operation-envelope-binding-mismatch" }[mode];
        if ("eventID" in row) {
          await db.update(eventOutbox).set({ payload: { ...row.payload, operationEnvelope } }).where(eq(eventOutbox.id, row.id));
          const admitted = await getEventOutboxRow(row.id);
          const result = await deliverEventOutbox(row.id, forbidden);
          assert.equal(result?.status, "blocked");
          assert.equal(result?.errorCode, expectedCode);
          assert.equal(hash(result?.payload), hash(admitted?.payload));
        } else {
          await db.update(taskOutbox).set({ payload: { ...row.payload, operationEnvelope } }).where(eq(taskOutbox.id, row.id));
          const admitted = await getTaskOutbox(row.id);
          const result = await deliverTaskOutbox(row.id, forbidden);
          assert.equal(result?.status, "blocked");
          assert.equal(result?.errorCode, expectedCode);
          assert.equal(hash(result?.payload), hash(admitted?.payload));
        }
      }
    }
    for (const dispatchProjection of [null, {}, { version: 2, projection: {}, patch: {}, baseline: null }]) {
      const row = await enqueueTask({ task: task(), dispatchProjection } as TaskOutboxRow["payload"]);
      const result = await deliverTaskOutbox(row.id, forbidden);
      assert.equal(result?.status, "blocked");
      assert.equal(hash(result?.payload), hash(row.payload));
    }
    assert.equal(factories, 0);

    // Reclaimed uncertain work retains result/snapshot and does not become a new plan.
    const oldLease = randomUUID();
    const snapshot = { externalEventId: "native", etag: '"v1"', deleted: false,
      observedAt: "2026-10-01T00:00:00Z", isEcho: true };
    const uncertain = await enqueueEvent({ event: event(), operationEnvelope: null }, {
      status: "attempting", leaseToken: oldLease, leaseUntil: new Date(0), uncertain: true,
      resultRef: { externalEventId: "native", etag: '"v1"' }, remoteSnapshot: snapshot,
      personalReadRecovery: { acceptedRevision: 1, intentHash: "retained-lineage-hash",
        mappingID: randomUUID(), redactedRevision: 2, restoredRevision: null },
    });
    const reclaimed = await deliverEventOutbox(uncertain.id, forbidden);
    assert.equal(reclaimed?.status, "blocked");
    assert.equal(reclaimed?.uncertain, true);
    assert.equal(reclaimed?.id, uncertain.id);
    assert.deepEqual(reclaimed?.resultRef, uncertain.resultRef);
    assert.deepEqual(reclaimed?.remoteSnapshot, uncertain.remoteSnapshot);
    assert.deepEqual(reclaimed?.personalReadRecovery, uncertain.personalReadRecovery);
    assert.equal(hash(reclaimed?.payload), hash(uncertain.payload));
    assert.equal(await finishEventOutbox(uncertain.id, oldLease, "completed"), false, "stale lease cannot ACK the held intent");
    const expiredTask = await enqueueTask({ task: task(), operationEnvelope: null }, {
      status: "attempting", leaseToken: randomUUID(), leaseUntil: new Date(0), uncertain: true,
      resultRef: { externalTaskId: "native-task", etag: '"v1"' }, remoteSnapshot: { title: "Accepted task" },
    });
    const heldTask = await deliverTaskOutbox(expiredTask.id, forbidden);
    assert.equal(heldTask?.status, "blocked");
    assert.equal(heldTask?.uncertain, true);
    assert.deepEqual(heldTask?.resultRef, expiredTask.resultRef);
    assert.deepEqual(heldTask?.remoteSnapshot, expiredTask.remoteSnapshot);
    assert.equal(hash(heldTask?.payload), hash(expiredTask.payload));

    // Unknown DELETE, organizer and invalid RSVP cannot take any old pull shortcut.
    for (const family of ["delete", "organizer", "rsvp", "generic"] as const) {
      const value = event();
      await createEvent(value, value.calendars);
      const payload = { event: value, operationEnvelope: null,
        ...(family === "organizer" ? { organizer: { request: { provider: "google" } } } : {}),
        ...(family === "rsvp" ? { rsvp: {} } : {}) } as EventOutboxRow["payload"];
      const row = await enqueueEvent(payload, { action: family === "delete" ? "delete" : "update",
        attempts: 1, status: "attempting", uncertain: false,
        resultRef: { externalEventId: "native", etag: '"v1"' }, leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 120_000) });
      const values = family === "delete" ? null : { ...value, description: null, location: null, recurrence: null };
      await db.transaction(async tx => {
        await tx.select({ id: events.id }).from(events).where(eq(events.id, value.id)).for("update");
        assert.equal(await retainPendingEventPull(tx, value.id, calendar.id, "google", "native", values,
          '"v1"', null, undefined, true), true, "unknown format is retained even before onlyReplace shortcut");
      });
      const saved = await getEventOutboxRow(row.id);
      assert.equal(saved?.status, "blocked");
      assert.equal(saved?.uncertain, true, "an older floor cannot prove a live unknown worker has not dispatched");
      assert.deepEqual(saved?.resultRef, row.resultRef);
      assert.notEqual(saved?.remoteSnapshot?.isEcho, true);
      assert.equal(saved?.remoteSnapshot?.deleted, family === "delete");
      assert.equal(saved?.leaseToken, null);
      assert.equal(hash(saved?.payload), hash(row.payload));
      await assert.rejects(() => prepareEventDeliveryResolution(owner, value.id, row.id, forbidden),
        /cannot be resolved/, "an unknown format cannot be reinterpreted into a new legacy resolution intent");
    }
    const lateValue = event();
    await createEvent(lateValue, lateValue.calendars);
    const terminalUnknown = await enqueueEvent({ event: lateValue, operationEnvelope: null },
      { status: "completed", attempts: 1 });
    const futureNativeID = `future-native-${terminalUnknown.id}`;
    const canonicalIDs = (await db.select({ id: events.id }).from(events).where(eq(events.creatorID, owner))).map(row => row.id).sort();
    assert.equal(await upsertExternalEvent("google", owner, calendar.id, source.externalCalendarID,
      futureNativeID, { ...lateValue, description: null, location: null, recurrence: null, url: lateValue.url ?? null },
      '"v1"', null, terminalUnknown.id), false, "scoped future CREATE is retained before legacy identity checks");
    assert.deepEqual((await db.select({ id: events.id }).from(events).where(eq(events.creatorID, owner))).map(row => row.id).sort(), canonicalIDs,
      "a future address without the legacy marker cannot create a duplicate canonical event");
    assert.equal((await db.select().from(externalEvents).where(eq(externalEvents.eventID, lateValue.id))).length, 0,
      "the older floor cannot adopt a future CREATE native mapping");
    const terminalHeld = await getEventOutboxRow(terminalUnknown.id);
    assert.equal(terminalHeld?.status, "completed", "late unknown format does not reopen terminal history");
    assert.notEqual(terminalHeld?.remoteSnapshot?.isEcho, true, "terminal fallback cannot ACK by interpreting old event fields");
    assert.equal(hash(terminalHeld?.payload), hash(terminalUnknown.payload));

    // Resolving a legacy head cannot supersede a newer unknown plan in the
    // same causal chain into a new legacy intent.
    const chainEvent = event();
    await createEvent(chainEvent, chainEvent.calendars);
    const legacyHead = await enqueueEvent({ event: chainEvent },
      { action: "update", status: "conflict", externalEventID: "resolution-native" });
    const unknownSuccessor = await enqueueEvent({ event: chainEvent, operationEnvelope: null },
      { action: "update", status: "blocked", predecessorID: legacyHead.id, revision: 2, externalEventID: "resolution-native" });
    await assert.rejects(() => prepareEventDeliveryResolution(owner, chainEvent.id, legacyHead.id, forbidden),
      /cannot be resolved/, "legacy resolution checks the entire pending chain before provider access");
    assert.equal((await getEventOutboxRow(unknownSuccessor.id))?.status, unknownSuccessor.status);
    assert.equal(hash((await getEventOutboxRow(unknownSuccessor.id))?.payload), hash(unknownSuccessor.payload));
    assert.equal(factories, 0);

    // The CalDAV family-removal shortcut lives before the ordinary pending-pull gate.
    const davCalendar = await createCalendar({ creatorID: owner, name: "DAV family HOLD", color: "#112233" });
    const [davSource] = await db.insert(externalCalendars).values({ calendarID: davCalendar.id,
      provider: "caldav", userID: owner, accountID: owner, externalCalendarID: "dav-fixture", supportsEvents: true }).returning();
    const davEvent = { ...event(), calendars: [davCalendar.id], originCalendarID: davCalendar.id };
    await createEvent(davEvent, davEvent.calendars);
    await db.insert(externalEvents).values({ provider: "caldav", calendarID: davCalendar.id,
      eventID: davEvent.id, externalCalendarID: "dav-fixture", externalEventID: "native-child",
      externalSeriesID: "native-resource", etag: '"dav-v1"', icalUid: "native-uid" });
    const davRow = await enqueueEvent({ event: davEvent, operationEnvelope: null,
      caldavSeriesDeletion: { context: { mappings: [{ eventID: davEvent.id, externalEventID: "native-child" }] } } as never },
      { provider: "caldav", calendarID: davCalendar.id, externalCalendarLinkID: davSource.id,
        externalCalendarID: "dav-fixture", externalEventID: "native-resource", action: "delete", attempts: 1, uncertain: true });
    assert.equal(await deleteExternalEvent("caldav", davCalendar.id, "native-child"), false);
    const davHeld = await getEventOutboxRow(davRow.id);
    assert.equal(davHeld?.status, "blocked");
    assert.equal(davHeld?.uncertain, true);
    assert.notEqual(davHeld?.remoteSnapshot?.isEcho, true, "unknown full-family intent cannot ACK from a child removal");
    assert.equal((await db.select().from(events).where(eq(events.id, davEvent.id)))[0]?.deletedAt, null);
    assert.equal(hash(davHeld?.payload), hash(davRow.payload));

    const destination = await createCalendar({ creatorID: owner, name: "Family derived destination", color: "#112233" });
    const [destinationSource] = await db.insert(externalCalendars).values({ calendarID: destination.id,
      provider: "google", userID: owner, accountID: owner, externalCalendarID: "family-destination", supportsEvents: true }).returning();
    // Completed cancellation history must not be reinterpreted or rewritten by
    // an older floor, even when the native resource resurfaces or disappears.
    for (const provider of ["google", "caldav"] as const) {
      const targetCalendar = provider === "google" ? calendar : davCalendar;
      const targetSource = provider === "google" ? source : davSource;
      const value = { ...event(), recurrence: "RRULE:FREQ=DAILY;COUNT=2", isCanceled: true, calendars: [targetCalendar.id], originCalendarID: targetCalendar.id };
      await createEvent(value, value.calendars);
      const child = EventSchema.parse({ ...event(), seriesID: value.id, recurrence: null,
        start: "2026-10-02T09:00:00Z", end: "2026-10-02T10:00:00Z",
        originalStart: { kind: "instant", value: "2026-10-02T09:00:00.000Z" },
        calendars: [targetCalendar.id, destination.id], originCalendarID: targetCalendar.id });
      await createEvent(child, child.calendars);
      const nativeID = `terminal-cancel-${randomUUID()}`;
      const [mapping] = await db.insert(externalEvents).values({ provider, calendarID: targetCalendar.id,
        eventID: value.id, externalCalendarID: targetSource.externalCalendarID, externalEventID: nativeID,
        etag: '"v1"' }).returning();
      await db.insert(externalEvents).values([
        { provider, calendarID: targetCalendar.id, eventID: child.id,
          externalCalendarID: targetSource.externalCalendarID, externalEventID: `${nativeID}-child`,
          externalSeriesID: nativeID, originalStart: child.originalStart, etag: '"child-v1"' },
        { provider: "google", calendarID: destination.id, eventID: child.id,
          externalCalendarID: destinationSource.externalCalendarID, externalEventID: `${nativeID}-derived-child`, etag: '"copy-v1"' },
      ]);
      const row = await enqueueEvent({ event: value, operationEnvelope: null,
        organizer: { mappingID: mapping.id, sourceEvent: value,
          dispatch: { startedAt: "2026-10-01T00:00:00Z", acceptedAt: "2026-10-01T00:00:01Z" } } as never },
        { provider, calendarID: targetCalendar.id, externalCalendarLinkID: targetSource.id,
          externalCalendarID: targetSource.externalCalendarID, externalEventID: nativeID,
          action: "delete", status: "completed", attempts: 1, expectedEtag: '"v1"' });
      const values = { ...value, title: "Native resurfaces", description: null, location: null, recurrence: null, url: value.url ?? null };
      assert.equal(await upsertExternalEvent(provider, owner, targetCalendar.id, targetSource.externalCalendarID,
        nativeID, values, '"v2"', null), false);
      const activeHeld = (await getEventOutboxRow(row.id))!;
      assert.equal(activeHeld.status, "completed", "unknown completed cancellation is not reopened as legacy conflict");
      assert.equal(activeHeld.remoteSnapshot?.deleted, false);
      assert.equal(hash(activeHeld.payload), hash(row.payload));
      const familyIDs = [value.id, child.id];
      const familySnapshot = async () => ({
        events: await db.select().from(events).where(inArray(events.id, familyIDs)).orderBy(events.id),
        maps: await db.select().from(externalEvents).where(inArray(externalEvents.eventID, familyIDs)).orderBy(externalEvents.id),
        links: await db.select().from(calendarEvents).where(inArray(calendarEvents.eventID, familyIDs)).orderBy(calendarEvents.id),
        outbox: (await db.select().from(eventOutbox).where(inArray(eventOutbox.eventID, familyIDs)).orderBy(eventOutbox.id))
          .map(({ remoteSnapshot, updatedAt, ...retained }) => retained),
      });
      const before = await familySnapshot();
      assert.equal(before.events.length, 2, "real cancelled master and visible native child");
      assert.equal(before.maps.length, 3, "native child and a real derived destination binding");
      assert.equal(before.outbox.length, 1, "only the completed root cancellation exists");
      assert.equal(await deleteExternalEvent(provider, targetCalendar.id, nativeID), false);
      assert.deepEqual(await familySnapshot(), before, "unknown root cancellation leaves children, mappings, links and all intents byte-equal");
      const deletedHeld = (await getEventOutboxRow(row.id))!;
      assert.equal(deletedHeld.status, "completed");
      assert.equal(deletedHeld.remoteSnapshot?.deleted, true);
      assert.equal(hash(deletedHeld.payload), hash(row.payload), "unknown format does not gain a legacy cancellation tombstone");
      assert.equal((await db.select().from(events).where(eq(events.id, value.id)))[0]?.deletedAt, null);
    }

    // Real unaddressed task CREATEs cannot fall through to native task import,
    // even before uncertainty is recorded or when the marker is merely present.
    const taskValues = (value: ReturnType<typeof task>) => ({
      title: value.title, description: value.description ?? null, status: value.status,
      start: value.start ?? null, due: value.due ?? null, isAllDay: value.isAllDay,
      completedAt: value.completedAt ?? null, percentComplete: value.percentComplete,
      priority: value.priority, recurrence: value.recurrence ?? null,
      relatedTo: value.relatedTo ?? null, sequence: value.sequence, url: value.url ?? null,
    });
    for (const mode of ["blocked", "attempting", "present-null"] as const) {
      const target = await createCalendar({ creatorID: owner, name: `Unmapped task ${mode}`, color: "#112233" });
      const [currentSource] = await db.insert(externalCalendars).values({ calendarID: target.id,
        provider: "google", userID: owner, accountID: owner, externalCalendarID: `task-${mode}`,
        providerAccessRole: "owner", providerAccessRevision: 1, supportsEvents: true, supportsTasks: true }).returning();
      const value = TaskSchema.parse({ ...task(), calendarID: target.id, originCalendarID: target.id, calendarIDs: [target.id] });
      await db.insert(tasks).values(value);
      await db.insert(calendarTasks).values({ taskID: value.id, calendarID: target.id });
      const row = await enqueueTask({ task: value, operationEnvelope: mode === "present-null" ? null : { schemaVersion: 99 } },
        { calendarID: target.id, externalCalendarLinkID: currentSource.id, externalCalendarID: currentSource.externalCalendarID,
          providerAccessRevision: currentSource.providerAccessRevision,
          externalTaskID: null, uncertain: false, status: mode === "attempting" ? "attempting" : "blocked",
          ...(mode === "attempting" ? { leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 120_000), attempts: 1 } : {}) });
      const scope = { sourceID: currentSource.id, accountID: owner, providerAccessRevision: currentSource.providerAccessRevision, readStartedAt: new Date() };
      const access = { provider: "google" as const, linkID: currentSource.id, revision: currentSource.providerAccessRevision,
        userID: owner, accountID: owner, externalCalendarID: currentSource.externalCalendarID };
      const beforeTasks = await db.select().from(tasks).where(eq(tasks.creatorID, owner)).orderBy(tasks.id);
      const beforeMaps = await db.select().from(externalTasks).orderBy(externalTasks.id);
      const beforeLinks = await db.select().from(calendarTasks).orderBy(calendarTasks.taskID, calendarTasks.calendarID);
      const beforeRows = await db.select().from(taskOutbox).where(eq(taskOutbox.userID, owner)).orderBy(taskOutbox.id);
      assert.equal(await upsertExternalTask("google", owner, target.id, currentSource.externalCalendarID,
        `unmapped-native-${mode}`, { ...taskValues(value), title: "Native observation" }, '"native-v2"', null, access, scope), false);
      assert.deepEqual(await db.select().from(tasks).where(eq(tasks.creatorID, owner)).orderBy(tasks.id), beforeTasks);
      assert.deepEqual(await db.select().from(externalTasks).orderBy(externalTasks.id), beforeMaps, "no native address adoption");
      assert.deepEqual(await db.select().from(calendarTasks).orderBy(calendarTasks.taskID, calendarTasks.calendarID), beforeLinks);
      const afterRows = await db.select().from(taskOutbox).where(eq(taskOutbox.userID, owner)).orderBy(taskOutbox.id);
      assert.equal(afterRows.length, beforeRows.length, "no duplicate intent or canonical task");
      assert.deepEqual(afterRows.filter(item => item.id !== row.id), beforeRows.filter(item => item.id !== row.id));
      const held = (await getTaskOutbox(row.id))!;
      assert.equal(held.status, "blocked");
      assert.equal(held.uncertain, mode === "attempting", "revoked attempting lease preserves possible dispatch");
      assert.equal(held.leaseToken, null);
      assert.equal(held.leaseUntil, null);
      assert.equal(held.resultRef, null, "unproven correlation cannot supply a delivery receipt");
      assert.equal(held.remoteSnapshot?.unmapped, true);
      assert.equal(held.remoteSnapshot?.externalTaskId, `unmapped-native-${mode}`);
      assert.equal(hash(held.payload), hash(row.payload));
      assert.equal(factories, 0);
      assert.equal(providerCalls, 0);
    }

    // A stale source/privacy capture is rejected before observing unknown work;
    // an old CREATE from another privacy incarnation cannot claim the new task.
    for (const stale of ["source", "retirement"] as const) {
      const target = await createCalendar({ creatorID: owner, name: `Task old ${stale}`, color: "#112233" });
      const [currentSource] = await db.insert(externalCalendars).values({ calendarID: target.id,
        provider: "google", userID: owner, accountID: owner, externalCalendarID: `old-${stale}`,
        providerAccessRole: "owner", providerAccessRevision: 2, supportsEvents: true, supportsTasks: true }).returning();
      const value = TaskSchema.parse({ ...task(), calendarID: target.id, originCalendarID: target.id, calendarIDs: [target.id] });
      await db.insert(tasks).values({ ...value, providerReadRetiredGeneration: stale === "retirement" ? 1 : 0 });
      await db.insert(calendarTasks).values({ taskID: value.id, calendarID: target.id });
      const row = await enqueueTask({ task: value, operationEnvelope: { schemaVersion: 99 } },
        { calendarID: target.id, externalCalendarLinkID: currentSource.id, externalCalendarID: currentSource.externalCalendarID,
          providerAccessRevision: stale === "source" ? 1 : 2, retiredGeneration: 0, status: "blocked" });
      const access = { provider: "google" as const, linkID: currentSource.id, revision: 2,
        userID: owner, accountID: owner, externalCalendarID: currentSource.externalCalendarID };
      const scope = { sourceID: currentSource.id, accountID: owner, providerAccessRevision: 2 };
      await assert.rejects(upsertExternalTask("google", owner, target.id, currentSource.externalCalendarID,
        `new-native-${stale}`, taskValues(value), '"native-v1"', null, { ...access, revision: 1 }, { ...scope, providerAccessRevision: 1 }));
      await assert.rejects(upsertExternalTask("google", owner, target.id, currentSource.externalCalendarID,
        `new-native-${stale}`, taskValues(value), '"native-v1"', null, access, { ...scope, providerAccessRevision: 1 }));
      assert.deepEqual(await getTaskOutbox(row.id), row);
      assert.equal(await upsertExternalTask("google", owner, target.id, currentSource.externalCalendarID,
        `new-native-${stale}`, taskValues(value), '"native-v1"', null, access, scope), true);
      assert.deepEqual(await getTaskOutbox(row.id), row, "retired capture retains unknown bytes/status without claiming fresh identity");
      assert.equal(factories, 0);
      assert.equal(providerCalls, 0);
    }

    // Actual privacy retirement and grant restoration keep the format marker.
    // Existing policy retains private owner outbox evidence rather than rewriting it.
    const privateEvent = event();
    await createEvent(privateEvent, privateEvent.calendars);
    await db.insert(externalEvents).values({ provider: "google", calendarID: calendar.id,
      eventID: privateEvent.id, externalCalendarID: source.externalCalendarID, externalEventID: "private-event", etag: '"v1"' });
    const privateRow = await enqueueEvent({ event: privateEvent, operationEnvelope: { schemaVersion: 99, nativePlan: { private: "owner-retained" } } },
      { externalEventID: "private-event", expectedEtag: '"v1"', action: "update" });
    const privateTask = task();
    await db.insert(tasks).values(privateTask);
    await db.insert(calendarTasks).values({ taskID: privateTask.id, calendarID: calendar.id });
    await db.insert(externalTasks).values({ provider: "google", calendarID: calendar.id, taskID: privateTask.id,
      externalCalendarID: source.externalCalendarID, externalTaskID: "private-task", etag: '"v1"' });
    const privateTaskRow = await enqueueTask({ task: privateTask, operationEnvelope: null });
    await reconcileGoogleCalendarAccess(owner, owner, calendar.id, "owner");
    await reconcileGoogleCalendarAccess(owner, owner, calendar.id, "reader");
    assert.equal((await db.select().from(events).where(eq(events.id, privateEvent.id)))[0]?.title, "Busy");
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, privateTask.id)))[0]?.title, "Private task");
    await reconcileGoogleCalendarAccess(owner, owner, calendar.id, "owner");
    assert.equal(hash((await getEventOutboxRow(privateRow.id))?.payload), hash(privateRow.payload));
    assert.equal(hash((await getTaskOutbox(privateTaskRow.id))?.payload), hash(privateTaskRow.payload));
    assert.equal(Object.prototype.hasOwnProperty.call((await getEventOutboxRow(privateRow.id))!.payload, "operationEnvelope"), true);
    assert.equal(Object.prototype.hasOwnProperty.call((await getTaskOutbox(privateTaskRow.id))!.payload, "operationEnvelope"), true);
    assert.equal((await deliverEventOutbox(privateRow.id, forbidden))?.status, "blocked");
    assert.equal((await deliverTaskOutbox(privateTaskRow.id, forbidden))?.status, "blocked");
    assert.equal(factories, 0, "restored grants do not turn a retained unknown format into legacy dispatch");

    // Blocking finite unknown work removes it from due selection instead of hot retrying.
    for (let index = 0; index < 60; index++) {
      await enqueueEvent({ event: event(), operationEnvelope: null }, { createdAt: new Date(index * 1000) });
      await enqueueTask({ task: task(), operationEnvelope: null }, { createdAt: new Date(index * 1000) });
    }
    const supportedEvent = event();
    await createEvent(supportedEvent, supportedEvent.calendars);
    const legacyEvent = await enqueueEvent({ event: supportedEvent, createIdentityVersion: 1 });
    const supportedTask = task();
    await db.insert(tasks).values(supportedTask);
    await db.insert(calendarTasks).values({ taskID: supportedTask.id, calendarID: calendar.id });
    const [freshSource] = await db.select().from(externalCalendars).where(eq(externalCalendars.id, source.id));
    const legacyTask = await enqueueTask({ task: supportedTask }, { providerAccessRevision: freshSource.providerAccessRevision });
    const remoteTasks = new Map<string, { ref: { externalTaskId: string; etag: string }; projection: Record<string, unknown> }>();
    const adapter = {
      async assertEventWrite() { providerCalls++; },
      async pushCreate() { providerCalls++; return { externalEventId: "supported-event", etag: '"v1"' }; },
      projectTask: canonicalTaskProjection,
      async assertTaskWrite() { providerCalls++; },
      async pushTaskCreate(_u, _a, _c, value, mark) {
        await mark?.(); providerCalls++;
        const ref = { externalTaskId: "supported-task", etag: '"v1"' };
        remoteTasks.set(ref.externalTaskId, { ref, projection: canonicalTaskProjection(value) });
        return ref;
      },
      async readTask(_u, _a, _c, ref) { providerCalls++; return remoteTasks.get(ref.externalTaskId) ?? null; },
      async pushTaskUpdate() { throw new Error("Unexpected task update"); },
      async pushTaskDelete() { throw new Error("Unexpected task delete"); },
    } satisfies Partial<CalendarAdapter>;
    const adapterFor = () => { factories++; return adapter as unknown as CalendarAdapter; };
    const firstEvents = await getDueEventOutboxIDs(50);
    const firstTasks = await getDueTaskOutboxIDs(50);
    assert.equal(firstEvents.length, 50);
    assert.equal(firstTasks.length, 50);
    for (const { id } of firstEvents) assert.equal((await deliverEventOutbox(id, adapterFor))?.status, "blocked");
    for (const { id } of firstTasks) assert.equal((await deliverTaskOutbox(id, adapterFor))?.status, "blocked");
    assert.equal(factories, 0, "whole unknown batch does not initialize providers");
    assert.equal(providerCalls, 0);
    const nextEvents = await getDueEventOutboxIDs(50);
    const nextTasks = await getDueTaskOutboxIDs(50);
    assert.ok(nextEvents.some(row => row.id === legacyEvent.id));
    assert.ok(nextTasks.some(row => row.id === legacyTask.id));
    for (const { id } of nextEvents) await deliverEventOutbox(id, adapterFor);
    for (const { id } of nextTasks) await deliverTaskOutbox(id, adapterFor);
    assert.equal((await getEventOutboxRow(legacyEvent.id))?.status, "completed");
    assert.equal((await getTaskOutbox(legacyTask.id))?.status, "completed");
    assert.equal(Object.prototype.hasOwnProperty.call((await getEventOutboxRow(legacyEvent.id))!.payload, "operationEnvelope"), false);
    assert.equal(Object.prototype.hasOwnProperty.call((await getTaskOutbox(legacyTask.id))!.payload, "operationEnvelope"), false);
    assert.deepEqual(await getDueEventOutboxIDs(50), []);
    assert.deepEqual(await getDueTaskOutboxIDs(50), []);
    assert.ok(providerCalls > 0, "supported legacy delivery progresses normally");
    console.log("Operation decoder PostgreSQL: zero-provider HOLD, private payload/uncertainty/lease parity, all pull shortcuts and due-batch progress passed");
  } finally {
    await db.delete(user).where(eq(user.id, owner));
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
