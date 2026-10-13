import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { config } from "@musubi/config";
import { EventSchema, SyncOperationEnvelopeSchema, type Event } from "@musubi/types";
import { db, user, account, caldavAccounts, events, tasks, eventOutbox, taskOutbox,
  externalCalendars, externalEvents, externalTasks,
  createCalendar, createEvent, patchEventAndCalendarLinks, createTask, updateTask,
  createTaskInTransaction, linkTask, upsertExternalEvent, upsertExternalTask,
  appendTaskOutbox, taskOutboxSnapshot, assertPinnedOutboxSource,
  decodeEventOutboxOperation, decodeTaskOutboxOperation,
  type EventOutboxIntent, type TaskOutboxIntent, type EventOutboxRow, type TaskOutboxRow } from "..";
import { lockCalendarLifecycle } from "./calendar-lifecycle";

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const assertLegacy = (row: EventOutboxRow | TaskOutboxRow) => {
  assert.equal(own(row.payload, "operationEnvelope"), false, "missing credentials select explicit legacy admission");
  assert.equal(own(row.payload, "operationCapture"), false, "no invented physical connection incarnation");
};

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Use a disposable test database");
  assert.equal(process.env.SYNC_OPERATION_V1_ENCODER_ENABLED, undefined, "Exercise the actual default, without a flag override");
  assert.equal(config.api.syncOperationV1EncoderEnabled, true, "Default-ON admission is active throughout this suite");
  const owner = `missing-admission-${randomUUID()}`;
  await db.insert(user).values({ id: owner, name: "Missing credential fixture", email: `${owner}@example.test` });
  let cases = 0;
  const eventRow = async (id: string) => (await db.select().from(eventOutbox).where(eq(eventOutbox.id, id)))[0]!;
  const taskRows = (id: string) => db.select().from(taskOutbox).where(eq(taskOutbox.taskID, id)).orderBy(taskOutbox.revision);
  try {
    for (const provider of ["google", "microsoft", "caldav"] as const) {
      const accountID = provider === "caldav" ? randomUUID() : `Case-Sensitive-ACCOUNT-${randomUUID()}`;
      const physicalID = provider === "caldav" ? accountID : randomUUID();
      const calendar = await createCalendar({ creatorID: owner, name: `Missing ${provider}`, color: "#112233" });
      const collection = provider === "caldav" ? `https://dav.fixture.test/Mixed-CASE/${randomUUID()}/` : `Collection-CASE-${randomUUID()}`;
      const [source] = await db.insert(externalCalendars).values({ calendarID: calendar.id, provider, userID: owner,
        accountID, externalCalendarID: collection, providerAccessRole: provider === "caldav" ? "caldav:read=yes;write=yes" : "owner",
        providerAccessRevision: 1, supportsEvents: true, supportsTasks: true }).returning();
      if (provider === "caldav") await db.insert(caldavAccounts).values({ id: physicalID, userID: owner,
        serverUrl: collection, username: "synthetic.fixture", encryptedPassword: "fixture.not-used-by-a-provider" });
      else await db.insert(account).values({ id: physicalID, userId: owner, providerId: provider, accountId: accountID,
        syncStatus: "active", accessToken: "fixture.no-http", refreshToken: "fixture.no-http", scope: "fixture" });
      const value = (title: string, calendars = [calendar.id]) => EventSchema.parse({ id: randomUUID(), creatorID: owner,
        organizer: owner, title, start: "2026-10-13T09:00:00Z", end: "2026-10-13T10:00:00Z",
        isAllDay: false, isCanceled: false, color: "#112233", calendars, originCalendarID: calendars[0] });
      const intent = (event: Event, action: "create" | "update" = "create"): EventOutboxIntent => ({
        id: randomUUID(), actorID: owner, mutationID: randomUUID(), position: 0, eventID: event.id,
        calendarID: calendar.id, externalCalendarLinkID: source.id, provider, userID: owner, accountID,
        externalCalendarID: collection, action,
        ...(action === "update" ? { externalEventID: provider === "caldav" ? `${collection}native.ics` : "native-event",
          expectedEtag: '"native-before"', icalUid: "fixture-native-uid" } : {}),
        payload: { event, ...(action === "update" ? { patch: { title: "Committed edit" } } : {}) },
      });
      const taskIntent = (task: ReturnType<typeof taskOutboxSnapshot>, badSource = false): TaskOutboxIntent => ({
        id: randomUUID(), actorID: owner, mutationID: randomUUID(), position: 0, taskID: task.id,
        calendarID: calendar.id, externalCalendarLinkID: badSource ? randomUUID() : source.id,
        provider, userID: owner, accountID, externalCalendarID: collection, providerAccessRevision: 1,
        retiredGeneration: 0, action: "create", payload: { task },
      });

      // The host UUID columns canonicalize input case, while the connection,
      // collection and native resource remain opaque and case-sensitive.
      const upper = { ...value("Uppercase physical UUID create"), id: randomUUID().toUpperCase(),
        calendars: [calendar.id.toUpperCase()], originCalendarID: calendar.id.toUpperCase() };
      const upperJob = { ...intent(upper), id: randomUUID().toUpperCase(), mutationID: randomUUID().toUpperCase(),
        calendarID: calendar.id.toUpperCase(), externalCalendarLinkID: source.id.toUpperCase() };
      const upperCreated = await createEvent(upper, upper.calendars, [upperJob]);
      const upperReceipt = await eventRow(upperJob.id!), upperEnvelope = SyncOperationEnvelopeSchema.parse(upperReceipt.payload.operationEnvelope);
      assert.equal(decodeEventOutboxOperation(upperReceipt).kind, "pinned-v1");
      assert.equal(upperEnvelope.commandId, upperJob.mutationID.toLowerCase()); assert.equal(upperEnvelope.operationId, upperJob.id.toLowerCase());
      assert.equal(upperEnvelope.hostObjectId, upper.id.toLowerCase()); assert.equal(upperEnvelope.sourceEpoch.sourceId, source.id);
      assert.equal(upperEnvelope.locator.connectionId, accountID); assert.equal(upperEnvelope.locator.collectionId, collection); cases++;
      await assert.rejects(() => createEvent(upper, upper.calendars, [upperJob]));
      assert.equal((await db.select().from(eventOutbox).where(eq(eventOutbox.eventID, upper.id))).length, 1);
      assert.deepEqual((await db.select().from(events).where(eq(events.id, upper.id)))[0], upperCreated); cases++;
      const upperEdit = { ...intent(upper, "update"), id: randomUUID().toUpperCase(), mutationID: randomUUID().toUpperCase(),
        calendarID: calendar.id.toUpperCase(), externalCalendarLinkID: source.id.toUpperCase(), externalEventID: provider === "caldav" ? `${collection}Native-CASE.ics` : "Native-CASE",
        payload: { event: upper, patch: { title: "Uppercase physical UUID edit" } } };
      assert.equal((await patchEventAndCalendarLinks(upper.id, 1, upperEdit.payload.patch, false, [upperEdit])).status, "saved");
      const upperEditReceipt = await eventRow(upperEdit.id!), upperEditEnvelope = SyncOperationEnvelopeSchema.parse(upperEditReceipt.payload.operationEnvelope);
      assert.equal(decodeEventOutboxOperation(upperEditReceipt).kind, "pinned-v1"); assert.equal(upperEditEnvelope.commandId, upperEdit.mutationID.toLowerCase());
      assert.equal(upperEditEnvelope.predecessorOperationId, upperReceipt.id); assert.equal(upperEditEnvelope.locator.resourceId, upperEdit.externalEventID); cases++;
      await assert.rejects(() => patchEventAndCalendarLinks(upper.id, 1, upperEdit.payload.patch, false, [upperEdit]), /already been committed/);
      assert.equal((await db.select().from(eventOutbox).where(eq(eventOutbox.eventID, upper.id))).length, 2); cases++;
      const upperTaskID = randomUUID().toUpperCase(), upperTaskMutation = randomUUID().toUpperCase();
      const upperTask = await createTask({ id: upperTaskID, creatorID: owner, calendarID: calendar.id, title: "Uppercase task create" },
        { actorID: owner, mutationID: upperTaskMutation });
      const [upperTaskReceipt] = await taskRows(upperTaskID), upperTaskEnvelope = SyncOperationEnvelopeSchema.parse(upperTaskReceipt.payload.operationEnvelope);
      assert.equal(decodeTaskOutboxOperation(upperTaskReceipt).kind, "pinned-v1"); assert.equal(upperTaskEnvelope.commandId, upperTaskMutation.toLowerCase());
      assert.equal(upperTaskEnvelope.hostObjectId, upperTaskID.toLowerCase()); assert.equal(upperTaskEnvelope.locator.collectionId, collection); cases++;
      await assert.rejects(() => createTask({ id: upperTaskID, creatorID: owner, calendarID: calendar.id, title: "Duplicate" },
        { actorID: owner, mutationID: upperTaskMutation }));
      assert.equal((await taskRows(upperTaskID)).length, 1); cases++;
      const upperTaskEditMutation = randomUUID().toUpperCase();
      assert.ok(await updateTask(upperTaskID, { title: "Uppercase task edit" }, { actorID: owner, expectedRevision: 1, mutationID: upperTaskEditMutation }));
      const upperTaskEditReceipt = (await taskRows(upperTaskID))[1];
      assert.equal(decodeTaskOutboxOperation(upperTaskEditReceipt).kind, "pinned-v1");
      assert.equal(SyncOperationEnvelopeSchema.parse(upperTaskEditReceipt.payload.operationEnvelope).commandId, upperTaskEditMutation.toLowerCase());
      assert.equal(upperTask.revision, 1); cases++;

      // Legacy all-day timestamp shapes deliberately normalize through the old
      // mapper. Midnight DATE inputs remain in the exact bounded v1 profile.
      for (const midnight of [true, false]) {
        const date = { ...value("Legacy DATE profile"), isAllDay: true,
          start: new Date(midnight ? "2026-10-13T00:00:00Z" : "2026-10-13T09:00:00.123Z"),
          end: new Date(midnight ? "2026-10-13T00:00:00Z" : "2026-10-13T10:00:00.456Z") };
        const dateJob = intent(date); await createEvent(date, date.calendars, [dateJob]);
        const dateReceipt = await eventRow(dateJob.id!);
        if (midnight) assert.equal(decodeEventOutboxOperation(dateReceipt).kind, "pinned-v1"); else assertLegacy(dateReceipt); cases++;
        const dateEdit = { ...intent(date, "update"), payload: { event: date, patch: { title: "Edited DATE title" } } };
        assert.equal((await patchEventAndCalendarLinks(date.id, 1, dateEdit.payload.patch, false, [dateEdit])).status, "saved");
        const dateEditReceipt = await eventRow(dateEdit.id!);
        if (midnight) assert.equal(decodeEventOutboxOperation(dateEditReceipt).kind, "pinned-v1"); else assertLegacy(dateEditReceipt); cases++;
        if (!midnight) {
          const dateDelete: EventOutboxIntent = { ...intent(date, "update"), action: "delete", payload: { event: date } };
          assert.equal((await patchEventAndCalendarLinks(date.id, 2, { calendars: [] }, true, [dateDelete])).status, "saved");
          assertLegacy(await eventRow(dateDelete.id!)); cases++;
        }
      }
      const invalid = { ...value("Invalid selected chronology"), start: new Date("2026-10-13T11:00:00Z") }, invalidJob = intent(invalid);
      await assert.rejects(() => createEvent(invalid, invalid.calendars, [invalidJob]));
      assert.equal((await db.select().from(events).where(eq(events.id, invalid.id))).length, 0);
      assert.equal(await eventRow(invalidJob.id!), undefined, "malformed selected codec input cannot fall back"); cases++;
      const dateHome = await createCalendar({ creatorID: owner, name: "Legacy DATE native home", color: "#112233" });
      const dateCollection = `https://dav.fixture.test/${randomUUID()}/`, dateAddress = `${dateCollection}Native-Date.ics`;
      const nativeDate = { ...value("Before legacy DATE native pull", [dateHome.id, calendar.id]), isAllDay: true,
        start: new Date("2026-10-13T09:00:00.123Z"), end: new Date("2026-10-13T10:00:00.456Z") };
      await createEvent(nativeDate, nativeDate.calendars);
      await db.insert(externalEvents).values([
        { eventID: nativeDate.id, calendarID: dateHome.id, provider: "caldav", externalCalendarID: dateCollection,
          externalEventID: dateAddress, etag: '"date-before"', icalUid: "Native-Date-UID" },
        { eventID: nativeDate.id, calendarID: calendar.id, provider, externalCalendarID: collection,
          externalEventID: provider === "caldav" ? `${collection}Native-Mirror.ics` : "Native-Mirror", etag: '"mirror-date-before"', icalUid: "Native-Mirror-UID" },
      ]);
      assert.equal(await upsertExternalEvent("caldav", owner, dateHome.id, dateCollection, dateAddress,
        { title: "Legacy DATE authoritative native edit", color: nativeDate.color, start: nativeDate.start, end: nativeDate.end,
          isAllDay: true, description: null, location: null, organizer: owner, recurrence: null, url: null }, '"date-after"', "Native-Date-UID"), true);
      const [dateCanonical] = await db.select().from(events).where(eq(events.id, nativeDate.id));
      assert.equal(dateCanonical.title, "Legacy DATE authoritative native edit"); assert.equal(dateCanonical.revision, 2);
      const [dateFanout] = await db.select().from(eventOutbox).where(eq(eventOutbox.eventID, nativeDate.id));
      assertLegacy(dateFanout); assert.equal(dateFanout.action, "update"); cases++;

      // An ordinary physical account exists first. Direct account deletion
      // models unlink paths that leave the TEXT source binding behind.
      const beforeUnlink = value("Before account unlink"), beforeJob = intent(beforeUnlink);
      await createEvent(beforeUnlink, beforeUnlink.calendars, [beforeJob]);
      const beforeEvent = await eventRow(beforeJob.id!);
      assert.equal(decodeEventOutboxOperation(beforeEvent).kind, "pinned-v1"); cases++;
      const beforeTask = await createTask({ id: randomUUID(), creatorID: owner, calendarID: calendar.id, title: "Before task unlink" });
      const [beforeTaskJob] = await taskRows(beforeTask.id);
      assert.equal(decodeTaskOutboxOperation(beforeTaskJob).kind, "pinned-v1"); cases++;
      if (provider === "caldav") await db.delete(caldavAccounts).where(eq(caldavAccounts.id, physicalID));
      else await db.delete(account).where(eq(account.id, physicalID));
      assert.equal((await db.select().from(externalCalendars).where(eq(externalCalendars.id, source.id))).length, 1);
      assert.equal(await assertPinnedOutboxSource(beforeEvent), false, "missing credentials never authorize an existing v1 event"); cases++;
      assert.equal(await assertPinnedOutboxSource(beforeTaskJob), false, "missing credentials never authorize an existing v1 task"); cases++;
      assert.deepEqual((await eventRow(beforeEvent.id)).payload, beforeEvent.payload);
      assert.deepEqual((await taskRows(beforeTask.id))[0].payload, beforeTaskJob.payload);

      const created = value("Authoritative local create"), createJob = intent(created);
      await createEvent(created, created.calendars, [createJob]);
      const createReceipt = await eventRow(createJob.id!); assertLegacy(createReceipt);
      assert.equal(createReceipt.revision, 1); assert.equal(createReceipt.payload.event.title, created.title); cases++;
      const editJob = intent(created, "update");
      const edited = await patchEventAndCalendarLinks(created.id, 1, { title: "Committed edit" }, false, [editJob]);
      assert.equal(edited.status, "saved"); assertLegacy(await eventRow(editJob.id!));
      const [canonicalEvent] = await db.select().from(events).where(eq(events.id, created.id));
      assert.equal(canonicalEvent.title, "Committed edit"); assert.equal(canonicalEvent.revision, 2); cases++;

      const createdTask = await createTask({ id: randomUUID(), creatorID: owner, calendarID: calendar.id, title: "Authoritative task create" });
      assertLegacy((await taskRows(createdTask.id))[0]); assert.equal(createdTask.revision, 1); cases++;
      const editedTask = await updateTask(createdTask.id, { title: "Committed task edit" },
        { actorID: owner, expectedRevision: 1, mutationID: randomUUID() });
      assert.ok(editedTask); assert.equal(editedTask.revision, 2); assert.equal(editedTask.title, "Committed task edit");
      assertLegacy((await taskRows(createdTask.id))[1]); cases++;

      // Actual inbound APIs update the authoritative home and append secondary
      // intents in their same transaction. No provider request is made here.
      const home = await createCalendar({ creatorID: owner, name: `Native home ${provider}`, color: "#112233" });
      const homeCollection = `https://dav.fixture.test/${randomUUID()}/`, homeEventID = `${homeCollection}home.ics`;
      const imported = value("Before native edit", [home.id, calendar.id]);
      await createEvent(imported, imported.calendars);
      await db.insert(externalEvents).values([
        { eventID: imported.id, calendarID: home.id, provider: "caldav", externalCalendarID: homeCollection,
          externalEventID: homeEventID, etag: '"home-before"', icalUid: "fixture-home-uid" },
        { eventID: imported.id, calendarID: calendar.id, provider, externalCalendarID: collection,
          externalEventID: provider === "caldav" ? `${collection}mirror.ics` : "mirror-event", etag: '"mirror-before"', icalUid: "fixture-mirror-uid" },
      ]);
      assert.equal(await upsertExternalEvent("caldav", owner, home.id, homeCollection, homeEventID,
        { title: "Authoritative native edit", color: imported.color, start: imported.start, end: imported.end,
          isAllDay: false, description: null, location: null, organizer: owner, recurrence: null, url: null },
        '"home-after"', "fixture-home-uid"), true);
      const [nativeCanonical] = await db.select().from(events).where(eq(events.id, imported.id));
      assert.equal(nativeCanonical.title, "Authoritative native edit"); assert.equal(nativeCanonical.revision, 2);
      const [fanout] = await db.select().from(eventOutbox).where(eq(eventOutbox.eventID, imported.id));
      assert.ok(fanout); assert.equal(fanout.action, "update"); assert.equal(fanout.revision, nativeCanonical.revision); assertLegacy(fanout); cases++;
      // Graph supports independent task copies; exercise live membership fanout
      // only where the product capability currently permits it.
      if (provider !== "microsoft") {
        const importedTask = await createTask({ id: randomUUID(), creatorID: owner, calendarID: home.id, title: "Before native task edit" });
        assert.ok(await linkTask(importedTask.id, calendar.id, { actorID: owner, expectedRevision: 1, mutationID: randomUUID() }));
        const [mirrorCreate] = await taskRows(importedTask.id); assertLegacy(mirrorCreate);
        const homeTaskID = `${homeCollection}home-task.ics`, mirrorTaskID = provider === "caldav" ? `${collection}mirror-task.ics` : "mirror-task";
        await db.update(taskOutbox).set({ status: "completed", resultRef: { externalTaskId: mirrorTaskID, etag: '"mirror-task-before"' } }).where(eq(taskOutbox.id, mirrorCreate.id));
        await db.insert(externalTasks).values([
          { provider: "caldav", taskID: importedTask.id, calendarID: home.id, externalCalendarID: homeCollection,
            externalTaskID: homeTaskID, etag: '"home-task-before"', icalUid: "fixture-home-task-uid" },
          { provider, taskID: importedTask.id, calendarID: calendar.id, externalCalendarID: collection,
            externalTaskID: mirrorTaskID, etag: '"mirror-task-before"', icalUid: "fixture-mirror-task-uid",
            externalCalendarLinkID: source.id, accountID, providerAccessRevision: 1 },
        ]);
        assert.equal(await upsertExternalTask("caldav", owner, home.id, homeCollection, homeTaskID,
          { title: "Authoritative native task edit", description: null, status: "needs-action", start: null, due: null,
            isAllDay: false, completedAt: null, percentComplete: 0, priority: 0, recurrence: null, relatedTo: null, sequence: 1, url: null },
          '"home-task-after"', "fixture-home-task-uid"), true);
        const [nativeTask] = await db.select().from(tasks).where(eq(tasks.id, importedTask.id));
        assert.equal(nativeTask.title, "Authoritative native task edit"); assert.equal(nativeTask.revision, 3);
        const nativeTaskFanout = (await taskRows(importedTask.id))[1]; assert.ok(nativeTaskFanout);
        assert.equal(nativeTaskFanout.action, "update"); assert.equal(nativeTaskFanout.revision, 3); assertLegacy(nativeTaskFanout); cases++;
      }

      // Account absence is the only fallback here. A missing/mismatching exact
      // SOURCE must still roll back the canonical write and journal together.
      for (const problem of ["missing", "mismatched"] as const) {
        const corruptEventIntent = (event: Event, action: "create" | "update") => ({ ...intent(event, action),
          ...(problem === "missing" ? { externalCalendarLinkID: randomUUID() } : { externalCalendarID: `${collection}-wrong` }) });
        const rejected = value(`Rejected ${problem} source`), rejectedJob = corruptEventIntent(rejected, "create");
        await assert.rejects(() => createEvent(rejected, rejected.calendars, [rejectedJob]), /Operation admission source changed/);
        assert.equal((await db.select().from(events).where(eq(events.id, rejected.id))).length, 0);
        assert.equal(await eventRow(rejectedJob.id!), undefined); cases++;
        const failedEdit = corruptEventIntent(created, "update");
        await assert.rejects(() => patchEventAndCalendarLinks(created.id, 2, { title: "Must roll back" }, false, [failedEdit]), /Operation admission source changed/);
        assert.deepEqual((await db.select().from(events).where(eq(events.id, created.id)))[0], canonicalEvent);
        assert.equal(await eventRow(failedEdit.id!), undefined); cases++;

        const rejectedTaskID = randomUUID(), rejectedTaskJobID = randomUUID();
        await assert.rejects(() => db.transaction(async tx => {
          await lockCalendarLifecycle(tx, [calendar.id], "shared");
          const task = await createTaskInTransaction(tx, { id: rejectedTaskID, creatorID: owner, calendarID: calendar.id, title: "Must roll back" });
          const wire = taskOutboxSnapshot(task, task.calendars), job = taskIntent(wire, problem === "missing");
          await appendTaskOutbox(tx, wire, [{ ...job, id: rejectedTaskJobID,
            ...(problem === "mismatched" ? { externalCalendarID: `${collection}-wrong` } : {}) }]);
        }), /Operation admission source changed/);
        assert.equal((await db.select().from(tasks).where(eq(tasks.id, rejectedTaskID))).length, 0);
        assert.equal((await db.select().from(taskOutbox).where(eq(taskOutbox.id, rejectedTaskJobID))).length, 0); cases++;
        const beforeEdit = (await db.select().from(tasks).where(eq(tasks.id, createdTask.id)))[0], rejectedEditJobID = randomUUID();
        await assert.rejects(() => db.transaction(async tx => {
          await lockCalendarLifecycle(tx, [calendar.id], "shared");
          await tx.select().from(tasks).where(eq(tasks.id, createdTask.id)).for("update");
          const [saved] = await tx.update(tasks).set({ title: "Must roll back", revision: 3 }).where(and(eq(tasks.id, createdTask.id), eq(tasks.revision, 2))).returning();
          assert.ok(saved);
          const wire = taskOutboxSnapshot(saved, [calendar.id]), job = taskIntent(wire, problem === "missing");
          await appendTaskOutbox(tx, wire, [{ ...job, id: rejectedEditJobID, action: "update", externalTaskID: "fixture-native-task",
            ...(problem === "mismatched" ? { externalCalendarID: `${collection}-wrong` } : {}) }]);
        }), /Operation admission source changed/);
        assert.deepEqual((await db.select().from(tasks).where(eq(tasks.id, createdTask.id)))[0], beforeEdit);
        assert.equal((await db.select().from(taskOutbox).where(eq(taskOutbox.id, rejectedEditJobID))).length, 0); cases++;
      }

      const future = { schemaVersion: 99, futureData: "opaque-future-plan" }, futureCapture = { futureGeneration: 99 };
      const futureEvent = value("Future format preserved"), futureJob = intent(futureEvent);
      futureJob.payload = { ...futureJob.payload, operationEnvelope: future, operationCapture: futureCapture };
      await createEvent(futureEvent, futureEvent.calendars, [futureJob]);
      const storedFuture = await eventRow(futureJob.id!);
      assert.deepEqual(storedFuture.payload.operationEnvelope, future); assert.deepEqual(storedFuture.payload.operationCapture, futureCapture);
      assert.equal(decodeEventOutboxOperation(storedFuture).kind, "blocked"); cases++;
      const futureTaskID = randomUUID();
      await db.transaction(async tx => {
        await lockCalendarLifecycle(tx, [calendar.id], "shared");
        const task = await createTaskInTransaction(tx, { id: futureTaskID, creatorID: owner, calendarID: calendar.id, title: "Future task preserved" });
        const wire = taskOutboxSnapshot(task, task.calendars), job = taskIntent(wire);
        await appendTaskOutbox(tx, wire, [{ ...job, payload: { ...job.payload, operationEnvelope: future, operationCapture: futureCapture } }]);
      });
      const [storedFutureTask] = await taskRows(futureTaskID);
      assert.deepEqual(storedFutureTask.payload.operationEnvelope, future); assert.deepEqual(storedFutureTask.payload.operationCapture, futureCapture);
      assert.equal(decodeTaskOutboxOperation(storedFutureTask).kind, "blocked"); cases++;
    }
    assert.equal(config.api.syncOperationV1EncoderEnabled, true, "No global legacy opt-out masked the regression");
    console.log(`Default-ON admission: ${cases} UUID-case, DATE profile, Google/Graph/UUID-DAV missing-credential persistence/native fanout, strict source/old-v1 fences and unknown-format cases passed`);
  } finally {
    await db.delete(eventOutbox).where(eq(eventOutbox.userID, owner));
    await db.delete(taskOutbox).where(eq(taskOutbox.userID, owner));
    await db.delete(user).where(eq(user.id, owner));
    assert.equal((await db.select({ id: eventOutbox.id }).from(eventOutbox).where(eq(eventOutbox.userID, owner))).length, 0);
    assert.equal((await db.select({ id: taskOutbox.id }).from(taskOutbox).where(eq(taskOutbox.userID, owner))).length, 0);
  }
}
void main().then(() => process.exit(0));
