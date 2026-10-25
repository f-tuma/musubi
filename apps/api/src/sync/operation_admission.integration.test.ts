import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { config } from "@musubi/config";
import { EventSchema, SyncOperationCaptureSchema, SyncOperationEnvelopeSchema, type Event } from "@musubi/types";
import { applyCaldavEventPlanV1, parseNativeWritePlanV1 } from "@musubi/sync-codec";
import { db, user, account, events, tasks, eventOutbox, taskOutbox, externalCalendars, externalEvents, externalTasks,
  createCalendar, createEvent, createEventInTransaction, appendEventOutbox,
  patchEventAndCalendarLinks, createTask, updateTask, linkTask, unlinkTask, createTaskInTransaction,
  prepareTaskOutboxInTransaction, appendTaskOutbox, taskOutboxSnapshot,
  decodeEventOutboxOperation,
  saveCaldavAccount, getEventDeliveryResolutionContext, commitEventDeliveryResolution,
  upsertExternalTask,
  type EventOutboxIntent, type EventOutboxRow, type TaskOutboxRow } from "@musubi/db";
import { retainPendingEventPull } from "../../../../packages/db/src/queries/event-outbox-pull";
import type { CalendarAdapter, CreatedEventEvidence, TaskReadEvidence } from "./adapter";
import { googleAdapter } from "./adapters/google";
import { deliverEventOutbox } from "./event_delivery";
import { deliverTaskOutbox } from "./task_delivery";
import { ProviderEventWriteError } from "./event_write";
import { ProviderTaskWriteError } from "./task_write";
import { pinnedJsonBodyV1 } from "./pinned_write";
import { encryptSecret } from "./crypto";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Use a disposable test database");
  const originalEncoder = config.api.syncOperationV1EncoderEnabled;
  const owner = `pinned-admission-${randomUUID()}`, accountID = randomUUID(), oauthID = randomUUID();
  await db.insert(user).values({ id: owner, name: "Operation admission fixture", email: `${owner}@example.test` });
  let factories = 0, projectors = 0, eventWrites = 0, taskWrites = 0;
  let loseEventReply = false, failTaskPreflight = false;
  let afterEventWrite: (() => Promise<void>) | undefined, afterTaskWrite: (() => Promise<void>) | undefined;
  const remoteEvents = new Map<string, CreatedEventEvidence>();
  const remoteTasks = new Map<string, TaskReadEvidence>();
  const adapter: CalendarAdapter = {
    ...googleAdapter,
    // This fixture supplies a pinned transport itself; it does not register native HTTP ports.
    googlePersonalCreateV1: undefined,
    googlePersonalContentV1: undefined,
    googleTaskUpdateV1: undefined,
    projectEvent() { projectors++; throw new Error("Current event mapper B must never run"); },
    projectTask() { projectors++; throw new Error("Current task mapper B must never run"); },
    async assertEventWrite() {},
    async pushCreate(_u, _a, _c, _event, identity, plan) {
      assert.ok(identity); assert.ok(plan); eventWrites++;
      const body = pinnedJsonBodyV1(plan), id = body.id as string;
      const start = body.start as { dateTime: string }, end = body.end as { dateTime: string };
      const evidence: CreatedEventEvidence = { ref: { externalEventId: id, etag: '"native-A"' },
        event: { externalId: id, status: "active", title: body.summary as string,
          start: new Date(start.dateTime), end: new Date(end.dateTime), isAllDay: false,
          description: body.description as string | null, location: body.location as string | null,
          recurrence: null, organizer: null, url: null } };
      remoteEvents.set(id, evidence);
      if (afterEventWrite) { const action = afterEventWrite; afterEventWrite = undefined; await action(); }
      if (loseEventReply) throw new ProviderEventWriteError("provider-write-failed", "unconfirmed");
      return evidence.ref;
    },
    async findCreatedEvent(_u, _a, _c, identity) {
      return remoteEvents.get(`musubi${identity.operationID.replace(/-/g, "")}`) ?? null;
    },
    async readEvent(_u, _a, _c, ref) { return remoteEvents.get(ref.externalEventId) ?? null; },
    async pushUpdate(_u, _a, _c, id, _event, ref, _patch, _signal, plan) {
      assert.ok(plan); assert.equal(remoteEvents.get(id)?.ref.etag, ref?.etag); eventWrites++;
      const body = pinnedJsonBodyV1(plan), prior = remoteEvents.get(id)!;
      const next = { ref: { ...prior.ref, etag: '"native-A2"' }, event: { ...prior.event,
        ...(typeof body.summary === "string" ? { title: body.summary } : {}) } };
      remoteEvents.set(id, next); return next.ref;
    },
    async assertTaskWrite() {
      if (failTaskPreflight) throw new ProviderTaskWriteError("task-write-failed", "not-written", 503);
    },
    async readTask(_u, _a, _c, ref) { return remoteTasks.get(ref.externalTaskId) ?? null; },
    async pushTaskCreate(_u, _a, _c, _task, mark, _signal, plan) {
      assert.ok(plan); await mark?.(); taskWrites++;
      const ref = { externalTaskId: `native-task-${randomUUID()}`, etag: '"task-A1"' };
      remoteTasks.set(ref.externalTaskId, { ref, projection: pinnedJsonBodyV1(plan) });
      if (afterTaskWrite) { const action = afterTaskWrite; afterTaskWrite = undefined; await action(); }
      return ref;
    },
    async pushTaskUpdate(_u, _a, _c, id, _task, ref, patch, _signal, plan) {
      assert.ok(plan); await ref?.beforeMutation?.(); taskWrites++;
      assert.deepEqual(Object.keys(patch ?? {}), ["title"], "late baseline selects only the changed admitted field");
      const prior = remoteTasks.get(id)!;
      const next = { ref: { externalTaskId: id, etag: '"task-A2"' },
        projection: { ...prior.projection, ...pinnedJsonBodyV1(plan, Object.keys(patch ?? {})) } };
      remoteTasks.set(id, next); return next.ref;
    },
    async pushTaskDelete() { throw new Error("Unexpected task delete"); },
  };
  const factory = () => { factories++; return adapter; };
  const eventRow = async (id: string) => (await db.select().from(eventOutbox).where(eq(eventOutbox.id, id)))[0]!;
  const taskRow = async (id: string) => (await db.select().from(taskOutbox).where(eq(taskOutbox.id, id)))[0]!;
  const taskJob = async (id: string) => (await db.select().from(taskOutbox).where(eq(taskOutbox.taskID, id)).orderBy(taskOutbox.revision))[0]!;
  const envelope = (row: EventOutboxRow | TaskOutboxRow) => SyncOperationEnvelopeSchema.parse(row.payload.operationEnvelope);
  const dueEvent = (id: string) => db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, id));
  const dueTask = (id: string) => db.update(taskOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(taskOutbox.id, id));
  try {
    await db.insert(account).values({ id: oauthID, userId: owner, providerId: "google", accountId: accountID,
      scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks",
      syncStatus: "active", accessToken: "fixture.no-http", refreshToken: "fixture.no-http",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000) });
    const calendar = await createCalendar({ creatorID: owner, name: "Pinned admission", color: "#112233" });
    const [source] = await db.insert(externalCalendars).values({ calendarID: calendar.id, provider: "google",
      userID: owner, accountID, externalCalendarID: `fixture-${randomUUID()}`, providerAccessRole: "owner",
      providerAccessRevision: 7, supportsEvents: true, supportsTasks: true }).returning();
    const value = (title = "Admitted event A") => EventSchema.parse({ id: randomUUID(), creatorID: owner,
      organizer: owner, title, color: "#112233", start: "2026-10-01T09:00:00Z", end: "2026-10-01T10:00:00Z",
      isAllDay: false, isCanceled: false, calendars: [calendar.id], originCalendarID: calendar.id });
    const intent = (event: Event, action: EventOutboxIntent["action"] = "create"): EventOutboxIntent => ({
      id: randomUUID(), actorID: owner, mutationID: randomUUID(), position: 0, eventID: event.id,
      calendarID: calendar.id, externalCalendarLinkID: source.id, provider: "google", userID: owner, accountID,
      externalCalendarID: source.externalCalendarID, action, payload: { event: { ...event, title: "Unaccepted draft B" } },
    });
    const enqueueEvent = async (title?: string) => {
      const event = value(title), job = intent(event);
      await createEvent(event, event.calendars, [job]); return { event, row: await eventRow(job.id!) };
    };
    const enqueueTask = async (title = "Admitted task A", stalePreview = false) => {
      const task = await createTask({ id: randomUUID(), creatorID: owner, calendarID: calendar.id, title,
        description: "Accepted notes", due: new Date("2026-10-01T12:00:00Z") },
        { actorID: owner, mutationID: randomUUID(), preparedDestinations: stalePreview ? [{
          calendarID: calendar.id, externalCalendarLinkID: source.id, provider: "google", userID: owner,
          accountID, externalCalendarID: source.externalCalendarID, providerAccessRevision: source.providerAccessRevision,
          providerProjection: { version: 1, projection: { title: "Diagnostic preview B" }, baseline: null,
            patch: { title: "Diagnostic preview B" }, errorCode: "task-write-failed" },
        }] : undefined });
      return { task, row: await taskJob(task.id) };
    };

    config.api.syncOperationV1EncoderEnabled = false;
    assert.equal(own((await enqueueEvent()).row.payload, "operationEnvelope"), false);
    assert.equal(own((await enqueueTask()).row.payload, "operationEnvelope"), false);
    config.api.syncOperationV1EncoderEnabled = true;

    const knownDate = { ...value("Specialized DATE"), isAllDay: true,
      start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-10-01T00:00:00Z"),
      timeModel: { kind: "all-day" as const } };
    const knownDateJob = intent(knownDate);
    await createEvent(knownDate, knownDate.calendars, [knownDateJob]);
    assert.equal(own((await eventRow(knownDateJob.id!)).payload, "operationEnvelope"), false,
      "the encoder does not expand current generic known-time capability");

    const graphAccountID = randomUUID(), graphCalendar = await createCalendar({ creatorID: owner, name: "Graph capture", color: "#112233" });
    await db.insert(account).values({ id: randomUUID(), userId: owner, providerId: "microsoft", accountId: graphAccountID,
      scope: "Calendars.ReadWrite Tasks.ReadWrite", accessToken: "fixture.no-http", refreshToken: "fixture.no-http" });
    const [graphSource] = await db.insert(externalCalendars).values({ calendarID: graphCalendar.id, provider: "microsoft",
      userID: owner, accountID: graphAccountID, externalCalendarID: randomUUID(), providerAccessRole: "owner" }).returning();
    const graphEvent = { ...value(), calendars: [graphCalendar.id], originCalendarID: graphCalendar.id };
    const graphIntent = { ...intent(graphEvent), calendarID: graphCalendar.id, externalCalendarLinkID: graphSource.id,
      provider: "microsoft", accountID: graphAccountID, externalCalendarID: graphSource.externalCalendarID };
    await createEvent(graphEvent, graphEvent.calendars, [graphIntent]);
    const graphRow = await eventRow(graphIntent.id!);
    assert.equal(envelope(graphRow).locator.resourceId, null, "Graph CREATE has correlation but no fabricated resource identity");
    assert.equal(decodeEventOutboxOperation(graphRow).kind, "pinned-v1");
    const graphRecurring = { ...graphEvent, id: randomUUID(), recurrence: "RRULE:FREQ=DAILY;COUNT=3" };
    const graphRecurringIntent = { ...graphIntent, id: randomUUID(), mutationID: randomUUID(), eventID: graphRecurring.id,
      payload: { event: graphRecurring } };
    await createEvent(graphRecurring, graphRecurring.calendars, [graphRecurringIntent]);
    assert.equal(own((await eventRow(graphRecurringIntent.id!)).payload, "operationEnvelope"), false);
    const graphTimePatch = { ...graphIntent, id: randomUUID(), mutationID: randomUUID(), action: "update" as const,
      externalEventID: "graph-native", expectedEtag: 'W/"graph"',
      payload: { event: graphEvent, patch: { start: new Date("2026-10-01T09:30:00Z") } } };
    await patchEventAndCalendarLinks(graphEvent.id, 1, graphTimePatch.payload.patch, false, [graphTimePatch]);
    assert.equal(own((await eventRow(graphTimePatch.id!)).payload, "operationEnvelope"), false,
      "Graph generic time patch stays on existing legacy profile");
    const graphTitlePatch = { ...graphTimePatch, id: randomUUID(), mutationID: randomUUID(),
      payload: { event: graphEvent, patch: { title: "Graph personal pinned title" } } };
    await patchEventAndCalendarLinks(graphEvent.id, 2, graphTitlePatch.payload.patch, false, [graphTitlePatch]);
    assert.equal(envelope(await eventRow(graphTitlePatch.id!)).serializer.id, "microsoft-personal-event");
    for (const recurrence of ["RRULE:FREQ=DAILY;COUNT=3\nEXRULE:FREQ=WEEKLY;BYDAY=MO",
      "RRULE:FREQ=DAILY;COUNT=3\nEXDATE;TZID=Europe/Prague:20261002T090000"]) {
      const legacyFeature = { ...value("Native recurrence outside pinned syntax"), recurrence };
      const legacyFeatureJob = intent(legacyFeature);
      await createEvent(legacyFeature, legacyFeature.calendars, [legacyFeatureJob]);
      assert.equal(own((await eventRow(legacyFeatureJob.id!)).payload, "operationEnvelope"), false);
    }
    const cancelled = { ...value("Cancelled native generic state"), isCanceled: true };
    const cancelledJob = intent(cancelled); await createEvent(cancelled, cancelled.calendars, [cancelledJob]);
    assert.equal(own((await eventRow(cancelledJob.id!)).payload, "operationEnvelope"), false);

    const accepted = await enqueueEvent();
    const admitted = envelope(accepted.row), acceptedHash = hash(admitted);
    assert.equal(admitted.acceptedRevision, 1);
    assert.equal(accepted.row.payload.event.title, accepted.event.title, "final committed canonical snapshot replaces the draft");
    assert.equal(admitted.admittedProjection.data.title, accepted.event.title);
    assert.equal(admitted.operationId, accepted.row.id);
    assert.deepEqual(admitted.sourceEpoch, { sourceId: source.id, generation: 7 });
    assert.equal(admitted.privacyEpoch, "event:0");
    assert.equal(SyncOperationCaptureSchema.parse(accepted.row.payload.operationCapture).connectionId, oauthID);
    assert.equal(admitted.locator.resourceId, `musubi${accepted.row.id.replace(/-/g, "")}`);
    assert.ok(parseNativeWritePlanV1(admitted.serializer, "create", "event", admitted.nativePlan.data));
    await db.execute(sql`update external_calendars set source_generation = source_generation + 1 where id = ${source.id}`);
    loseEventReply = true;
    assert.equal((await deliverEventOutbox(accepted.row.id, factory))?.status, "unconfirmed");
    assert.equal(projectors, 0, "mapper B is unavailable before the first worker dispatch");
    assert.equal(eventWrites, 1);
    assert.equal(hash(envelope(await eventRow(accepted.row.id))), acceptedHash);
    loseEventReply = false; await dueEvent(accepted.row.id);
    assert.equal((await deliverEventOutbox(accepted.row.id, factory))?.status, "completed");
    assert.equal(eventWrites, 1, "restart observes accepted A without a second mutation");
    assert.equal(hash(envelope(await eventRow(accepted.row.id))), acceptedHash);

    const updatedIntent = { ...intent(accepted.event, "update"), externalEventID: admitted.locator.resourceId,
      expectedEtag: '"native-A"', payload: { event: accepted.event, patch: { title: "Committed revision two" } } };
    const saved = await patchEventAndCalendarLinks(accepted.event.id, 1, { title: "Committed revision two" }, false, [updatedIntent]);
    assert.equal(saved.status, "saved");
    const revisionTwo = envelope(await eventRow(updatedIntent.id!));
    assert.equal(revisionTwo.acceptedRevision, 2);
    assert.equal(revisionTwo.admittedProjection.data.title, "Committed revision two");
    assert.equal(revisionTwo.predecessorOperationId, accepted.row.id);

    const acceptedTask = await enqueueTask("Admitted task A", true);
    const taskEnvelope = envelope(acceptedTask.row), taskHash = hash(taskEnvelope);
    assert.equal(taskEnvelope.locator.resourceId, null, "Google task CREATE has no fabricated native identity");
    assert.equal(own(acceptedTask.row.payload, "dispatchProjection"), false, "admitted target exists before dispatch baseline");
    assert.equal(acceptedTask.row.payload.providerProjection?.projection.title, "Diagnostic preview B");
    assert.equal(taskEnvelope.admittedProjection.data.title, "Admitted task A");
    failTaskPreflight = true;
    assert.equal((await deliverTaskOutbox(acceptedTask.row.id, factory))?.status, "retry");
    const temporary = await taskRow(acceptedTask.row.id);
    assert.equal(temporary.payload.dispatchProjection?.errorCode, undefined, "temporary preflight error never becomes immutable intent");
    assert.equal(hash(envelope(temporary)), taskHash);
    failTaskPreflight = false; await dueTask(acceptedTask.row.id);
    assert.equal((await deliverTaskOutbox(acceptedTask.row.id, factory))?.status, "completed");
    assert.equal(taskWrites, 1); assert.equal(projectors, 0);
    const updatedTask = await updateTask(acceptedTask.task.id, { title: "Admitted task A2" },
      { actorID: owner, expectedRevision: 1, mutationID: randomUUID() });
    assert.ok(updatedTask);
    const successor = (await db.select().from(taskOutbox).where(and(eq(taskOutbox.taskID, acceptedTask.task.id), eq(taskOutbox.revision, 2))))[0]!;
    assert.equal(envelope(successor).acceptedRevision, 2);
    assert.equal(envelope(successor).admittedProjection.data.title, "Admitted task A2");
    assert.equal((await deliverTaskOutbox(successor.id, factory))?.status, "completed");
    assert.deepEqual((await taskRow(successor.id)).payload.dispatchProjection?.patch, { title: "Admitted task A2" });
    assert.equal(taskWrites, 2); assert.equal(projectors, 0);

    // A registered active CREATE cannot identify its new remote task until the
    // POST response is accepted. A concurrent full pull must defer ingestion.
    const race = await enqueueTask("Task CREATE before mapping ACK");
    const beforeRaceCount = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.creatorID, owner))).length;
    const raceEnvelopeHash = hash(envelope(race.row));
    let raceNativeID = "", raceImported: boolean | undefined, raceLive: TaskOutboxRow | undefined;
    const unrelatedNativeID = `unrelated-native-${randomUUID()}`;
    let rereadUnrelated: (() => Promise<boolean>) | undefined;
    afterTaskWrite = async () => {
      const [nativeID, evidence] = [...remoteTasks.entries()][remoteTasks.size - 1]!;
      raceNativeID = nativeID;
      await db.update(taskOutbox).set({ uncertain: false }).where(eq(taskOutbox.id, race.row.id));
      const live = await taskRow(race.row.id);
      assert.equal(live.status, "attempting"); assert.ok(live.leaseToken); assert.equal(live.uncertain, false);
      const [currentSource] = await db.select().from(externalCalendars).where(eq(externalCalendars.id, source.id));
      const value = race.task;
      raceImported = await upsertExternalTask("google", owner, calendar.id, source.externalCalendarID, nativeID,
        { title: value.title, description: value.description, status: value.status, start: value.start,
          due: value.due, isAllDay: value.isAllDay, completedAt: value.completedAt,
          percentComplete: value.percentComplete, priority: value.priority, recurrence: value.recurrence,
          relatedTo: value.relatedTo, sequence: value.sequence, url: value.url }, evidence.ref.etag,
        null, { provider: "google", linkID: source.id, revision: currentSource.providerAccessRevision,
          userID: owner, accountID, externalCalendarID: source.externalCalendarID },
        { sourceID: source.id, accountID, providerAccessRevision: currentSource.providerAccessRevision }, evidence.projection);
      assert.equal((await db.select().from(externalTasks).where(eq(externalTasks.externalTaskID, nativeID))).length, 0,
        "matching content is not proof of a CREATE response identity");
      rereadUnrelated = () => upsertExternalTask("google", owner, calendar.id, source.externalCalendarID, unrelatedNativeID,
        { title: "Unrelated native task", description: null, status: "needs-action", start: null, due: null,
          isAllDay: false, completedAt: null, percentComplete: 0, priority: 0, recurrence: null,
          relatedTo: null, sequence: 0, url: null }, '"unrelated"', null,
        { provider: "google", linkID: source.id, revision: currentSource.providerAccessRevision, userID: owner,
          accountID, externalCalendarID: source.externalCalendarID },
        { sourceID: source.id, accountID, providerAccessRevision: currentSource.providerAccessRevision });
      assert.equal(await rereadUnrelated(), false, "the full-source read defers uncorrelated items during CREATE");
      raceLive = await taskRow(race.row.id);
      assert.equal(raceLive.status, "attempting"); assert.equal(raceLive.leaseToken, live.leaseToken);
      assert.equal(raceLive.uncertain, false); assert.equal(raceLive.resultRef, null);
      assert.equal(hash(raceLive.payload), hash(live.payload), "unmapped observation cannot rewrite admitted intent");
      assert.equal(hash(envelope(raceLive)), raceEnvelopeHash);
    };
    const raceResult = await deliverTaskOutbox(race.row.id, factory);
    assert.equal((await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.creatorID, owner))).length,
      beforeRaceCount, "pre-ACK pull must not import a duplicate canonical task");
    assert.equal(raceImported, false); assert.ok(raceLive);
    assert.equal(raceLive.remoteSnapshot?.unmapped, true, "retained observation is explicitly uncorrelated");
    assert.equal(raceResult?.status, "completed", "the original live worker can accept its own response identity");
    const [raceMapping] = await db.select().from(externalTasks).where(eq(externalTasks.externalTaskID, raceNativeID));
    assert.equal(raceMapping.taskID, race.task.id, "only the POST response binds the native identity");
    assert.ok(rereadUnrelated); assert.equal(await rereadUnrelated(), true, "next complete read imports unrelated tasks after ACK");
    const [unrelatedMapping] = await db.select().from(externalTasks).where(eq(externalTasks.externalTaskID, unrelatedNativeID));
    assert.notEqual(unrelatedMapping.taskID, race.task.id);
    config.api.syncOperationV1EncoderEnabled = false;
    const legacyActive = await enqueueTask("Legacy active profile");
    config.api.syncOperationV1EncoderEnabled = true;
    await db.update(taskOutbox).set({ status: "attempting", uncertain: false, leaseToken: randomUUID(),
      leaseUntil: new Date(Date.now() + 120_000) }).where(eq(taskOutbox.id, legacyActive.row.id));
    const legacyBefore = await taskRow(legacyActive.row.id);
    assert.equal(await upsertExternalTask("google", owner, calendar.id, source.externalCalendarID,
      `legacy-unrelated-${randomUUID()}`, { title: "Legacy unrelated import", description: null, status: "needs-action",
        start: null, due: null, isAllDay: false, completedAt: null, percentComplete: 0, priority: 0,
        recurrence: null, relatedTo: null, sequence: 0, url: null }, '"legacy"', null,
      { provider: "google", linkID: source.id, revision: source.providerAccessRevision, userID: owner,
        accountID, externalCalendarID: source.externalCalendarID },
      { sourceID: source.id, accountID, providerAccessRevision: source.providerAccessRevision }), true,
      "default-OFF legacy admission keeps its existing unmapped pull policy");
    assert.deepEqual(await taskRow(legacyActive.row.id), legacyBefore);
    await db.update(taskOutbox).set({ status: "cancelled", leaseToken: null, leaseUntil: null }).where(eq(taskOutbox.id, legacyActive.row.id));

    // A real SQL failure after both inserts must roll back canonical and outbox.
    const rollbackEvent = value("Rollback"), rollbackIntent = intent(rollbackEvent);
    await assert.rejects(() => db.transaction(async tx => {
      const canonical = await createEventInTransaction(tx, rollbackEvent, rollbackEvent.calendars);
      await appendEventOutbox(tx, { ...canonical, calendars: rollbackEvent.calendars }, [rollbackIntent]);
      assert.equal((await tx.select().from(eventOutbox).where(eq(eventOutbox.id, rollbackIntent.id!))).length, 1);
      await tx.execute(sql`select 1 / 0`);
    }));
    assert.equal((await db.select().from(events).where(eq(events.id, rollbackEvent.id))).length, 0);
    assert.equal((await db.select().from(eventOutbox).where(eq(eventOutbox.id, rollbackIntent.id!))).length, 0);
    const rollbackTaskID = randomUUID();
    await assert.rejects(() => db.transaction(async tx => {
      const canonical = await createTaskInTransaction(tx, { id: rollbackTaskID, creatorID: owner, calendarID: calendar.id, title: "Rollback" });
      const wire = taskOutboxSnapshot(canonical, canonical.calendars);
      const jobs = await prepareTaskOutboxInTransaction(tx, wire, [{ calendarID: calendar.id, action: "create" }],
        { actorID: owner, mutationID: randomUUID() });
      await appendTaskOutbox(tx, wire, jobs);
      assert.equal((await tx.select().from(taskOutbox).where(eq(taskOutbox.taskID, rollbackTaskID))).length, 1);
      await tx.execute(sql`select 1 / 0`);
    }));
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, rollbackTaskID))).length, 0);
    assert.equal((await db.select().from(taskOutbox).where(eq(taskOutbox.taskID, rollbackTaskID))).length, 0);

    const rejectBeforeFactory = async (row: EventOutboxRow | TaskOutboxRow) => {
      const isEvent = "eventID" in row, table = isEvent ? eventOutbox : taskOutbox;
      await db.update(table).set({ status: "attempting", leaseToken: randomUUID(), leaseUntil: new Date(0) }).where(eq(table.id, row.id));
      const before = factories, writes = eventWrites + taskWrites, bytes = hash(row.payload);
      const result = isEvent ? await deliverEventOutbox(row.id, factory) : await deliverTaskOutbox(row.id, factory);
      assert.equal(result?.status, "blocked"); assert.equal(result?.uncertain, true, "expired attempt remains uncertain");
      assert.equal(factories, before); assert.equal(eventWrites + taskWrites, writes);
      assert.equal(hash((isEvent ? await eventRow(row.id) : await taskRow(row.id)).payload), bytes);
      return result;
    };
    for (const invalidKind of ["null", "malformed", "version", "target", "patch"] as const) {
      const row = (await enqueueTask()).row, target = envelope(row).admittedProjection.data;
      const invalid = invalidKind === "null" ? null : invalidKind === "malformed" ? {} : {
        version: invalidKind === "version" ? 99 : 1, baseline: null,
        projection: invalidKind === "target" ? { ...target, title: "Unaccepted target B" } : target,
        patch: invalidKind === "patch" ? { ...target, title: "Unaccepted patch B" } : target,
      };
      await db.update(taskOutbox).set({ payload: { ...row.payload, dispatchProjection: invalid } as TaskOutboxRow["payload"] }).where(eq(taskOutbox.id, row.id));
      await rejectBeforeFactory(await taskRow(row.id));
    }
    for (const kind of ["event", "task"] as const) for (const change of ["id", "version"] as const) {
      const row = kind === "event" ? (await enqueueEvent()).row : (await enqueueTask()).row;
      const invalid = envelope(row);
      if (change === "id") invalid.serializer.id = "missing-historical-codec";
      else invalid.serializer.version = 99;
      const payload = { ...row.payload, operationEnvelope: invalid };
      if (kind === "event") await db.update(eventOutbox).set({ payload: payload as EventOutboxRow["payload"] }).where(eq(eventOutbox.id, row.id));
      else await db.update(taskOutbox).set({ payload: payload as TaskOutboxRow["payload"] }).where(eq(taskOutbox.id, row.id));
      assert.equal((await rejectBeforeFactory(kind === "event" ? await eventRow(row.id) : await taskRow(row.id)))?.errorCode,
        "delivery-serializer-unavailable");
    }
    const staleSource = await enqueueEvent();
    await db.update(externalCalendars).set({ providerAccessRole: "reader", providerAccessRevision: 8 }).where(eq(externalCalendars.id, source.id));
    await db.update(externalCalendars).set({ providerAccessRole: "owner", providerAccessRevision: 9 }).where(eq(externalCalendars.id, source.id));
    await rejectBeforeFactory(staleSource.row);
    const staleConnection = await enqueueTask();
    await db.update(account).set({ syncStatus: "disabled" }).where(eq(account.id, oauthID));
    await db.update(account).set({ syncStatus: "active", refreshToken: "fixture.reconnected" }).where(eq(account.id, oauthID));
    await rejectBeforeFactory(staleConnection.row);
    const staleEventPrivacy = await enqueueEvent();
    await db.update(events).set({ providerReadRetiredRevision: 1 }).where(eq(events.id, staleEventPrivacy.event.id));
    await rejectBeforeFactory(staleEventPrivacy.row);
    const staleTaskPrivacy = await enqueueTask();
    await db.update(tasks).set({ providerReadRetiredGeneration: 1 }).where(eq(tasks.id, staleTaskPrivacy.task.id));
    await rejectBeforeFactory(staleTaskPrivacy.row);

    // A resolution is a new admission, even when the replaced receipt is legacy.
    for (const previousProfile of ["legacy", "pinned"] as const) {
      config.api.syncOperationV1EncoderEnabled = previousProfile === "pinned";
      const old = await enqueueEvent(`Resolution ${previousProfile} A`), oldHash = hash(old.row.payload);
      await db.update(eventOutbox).set({ status: "blocked", uncertain: false, errorCode: "provider-write-denied" }).where(eq(eventOutbox.id, old.row.id));
      config.api.syncOperationV1EncoderEnabled = true;
      const context = await getEventDeliveryResolutionContext(owner, old.event.id, old.row.id);
      const request = { mutationId: randomUUID(), expectedLocalRevision: context.localRevision,
        expectedLatestOperationId: context.latest.id, expectedRemoteExists: false, expectedRemoteEtag: null };
      const id = await commitEventDeliveryResolution(owner, { context, ref: null, remoteExists: false,
        action: "create", patch: {}, deletion: undefined }, request);
      const replacement = await eventRow(id), replacementEnvelope = envelope(replacement);
      assert.notEqual(id, old.row.id); assert.equal(replacementEnvelope.operationId, id);
      assert.equal(replacementEnvelope.commandId, request.mutationId);
      assert.equal(replacementEnvelope.acceptedRevision, context.localRevision);
      assert.equal(replacementEnvelope.admittedProjection.data.title, old.event.title);
      assert.equal(hash((await eventRow(old.row.id)).payload), oldHash, "replacement never backfills the original receipt");
      assert.equal((await eventRow(old.row.id)).status, "cancelled");
      assert.equal((await deliverEventOutbox(id, factory))?.status, "completed", "mapper B stays unavailable after new resolution admission");
    }
    const conflictedUpdate = await eventRow(updatedIntent.id!), updateHash = hash(conflictedUpdate.payload);
    await db.update(eventOutbox).set({ status: "conflict", uncertain: false }).where(eq(eventOutbox.id, conflictedUpdate.id));
    const updateContext = await getEventDeliveryResolutionContext(owner, accepted.event.id, conflictedUpdate.id);
    const remoteID = String(admitted.locator.resourceId), priorRemote = remoteEvents.get(remoteID)!;
    const freshRef = { ...priorRemote.ref, etag: '"fresh-resolution-proof"' };
    remoteEvents.set(remoteID, { ref: freshRef, event: { ...priorRemote.event, title: "Concurrent remote B" } });
    const updateResolutionID = await commitEventDeliveryResolution(owner, { context: updateContext,
      ref: freshRef, remoteExists: true, action: "update", patch: { title: updateContext.local.title }, deletion: undefined },
      { mutationId: randomUUID(), expectedLocalRevision: updateContext.localRevision,
        expectedLatestOperationId: updateContext.latest.id, expectedRemoteExists: true, expectedRemoteEtag: freshRef.etag });
    const updateReplacement = await eventRow(updateResolutionID);
    assert.equal(envelope(updateReplacement).acceptedRevision, 2);
    assert.equal(updateReplacement.payload.event.revision, 2);
    assert.equal(envelope(updateReplacement).locator.resourceId, remoteID);
    assert.equal(updateReplacement.expectedEtag, freshRef.etag);
    assert.equal(hash((await eventRow(conflictedUpdate.id)).payload), updateHash);
    assert.equal((await deliverEventOutbox(updateResolutionID, factory))?.status, "completed");
    assert.equal(remoteEvents.get(remoteID)?.event.title, "Committed revision two");
    config.api.syncOperationV1EncoderEnabled = false;
    const rejectedEvent = { ...value("Invalid input rollback"), start: new Date("2026-10-01T11:00:00Z") };
    const rejectedJob = intent(rejectedEvent);
    await createEvent(rejectedEvent, rejectedEvent.calendars, [rejectedJob]);
    await db.update(eventOutbox).set({ status: "blocked", uncertain: false }).where(eq(eventOutbox.id, rejectedJob.id!));
    config.api.syncOperationV1EncoderEnabled = true;
    const rejectedContext = await getEventDeliveryResolutionContext(owner, rejectedEvent.id, rejectedJob.id!);
    await assert.rejects(() => commitEventDeliveryResolution(owner, { context: rejectedContext,
      ref: null, remoteExists: false, action: "create", patch: {}, deletion: undefined },
      { mutationId: randomUUID(), expectedLocalRevision: 1, expectedLatestOperationId: rejectedJob.id!,
        expectedRemoteExists: false, expectedRemoteEtag: null }));
    assert.equal((await eventRow(rejectedJob.id!)).status, "blocked", "codec rejection rolls back supersession too");
    assert.equal((await db.select().from(eventOutbox).where(eq(eventOutbox.eventID, rejectedEvent.id))).length, 1);

    const davAccount = await saveCaldavAccount(owner, `https://dav.fixture.test/${randomUUID()}/`, "fixture", encryptSecret("fixture"));
    const davCalendar = await createCalendar({ creatorID: owner, name: "DAV causal UID", color: "#112233" });
    const collection = `https://dav.fixture.test/${randomUUID()}/`;
    const [davSource] = await db.insert(externalCalendars).values({ calendarID: davCalendar.id, provider: "caldav",
      userID: owner, accountID: davAccount.id, externalCalendarID: collection, providerAccessRole: "caldav:read=yes;write=yes" }).returning();
    const davEvent = { ...value("CalDAV A1"), calendars: [davCalendar.id], originCalendarID: davCalendar.id };
    const davIntent = (event: Event, action: "create" | "update"): EventOutboxIntent => ({
      ...intent(event, action), calendarID: davCalendar.id, externalCalendarLinkID: davSource.id,
      provider: "caldav", accountID: davAccount.id, externalCalendarID: collection,
    });
    const davCreate = davIntent(davEvent, "create");
    await createEvent(davEvent, davEvent.calendars, [davCreate]);
    const davUpdate = { ...davIntent(davEvent, "update"), payload: { event: davEvent, patch: { title: "CalDAV A2" } } };
    await patchEventAndCalendarLinks(davEvent.id, 1, { title: "CalDAV A2" }, false, [davUpdate]);
    const createPlan = parseNativeWritePlanV1(envelope(await eventRow(davCreate.id!)).serializer, "create", "event", envelope(await eventRow(davCreate.id!)).nativePlan.data)!;
    const updatePlan = parseNativeWritePlanV1(envelope(await eventRow(davUpdate.id!)).serializer, "update", "event", envelope(await eventRow(davUpdate.id!)).nativePlan.data)!;
    assert.equal(createPlan.planKind, "caldav-properties"); assert.equal(updatePlan.planKind, "caldav-properties");
    if (createPlan.planKind !== "caldav-properties" || updatePlan.planKind !== "caldav-properties") throw new Error("Expected DAV plans");
    assert.equal(updatePlan.uid, createPlan.uid, "pre-ACK successor inherits the exact admitted native UID");
    assert.equal(updatePlan.uid, `musubi-${davCreate.id}`);
    assert.equal(envelope(await eventRow(davUpdate.id!)).locator.resourceId, null);
    let resource = "", davWrites = 0;
    const davRef = { externalEventId: `${collection}${createPlan.uid}.ics`, icalUid: createPlan.uid, etag: '"dav-A1"' };
    const davEvidence = (title: string): CreatedEventEvidence => ({ ref: davRef, event: {
      externalId: davRef.externalEventId, title, start: davEvent.start, end: davEvent.end, isAllDay: false,
      status: "active", description: null, location: null, recurrence: null, organizer: null, url: null } });
    let davTitle = "CalDAV A1";
    const davAdapter: CalendarAdapter = { ...adapter,
      async pushCreate(_u, _a, _c, _event, _identity, plan) {
        assert.ok(plan?.planKind === "caldav-properties"); resource = plan.createResource; davWrites++; return davRef;
      },
      async readEvent() { return davEvidence(davTitle); },
      async pushUpdate(_u, _a, _c, _id, _event, _ref, _patch, _signal, plan) {
        assert.ok(plan?.planKind === "caldav-properties"); resource = applyCaldavEventPlanV1(resource, plan);
        assert.match(resource, /SUMMARY:CalDAV A2/); davTitle = "CalDAV A2"; davWrites++; return { etag: '"dav-A2"', icalUid: plan.uid };
      },
    };
    assert.equal((await deliverEventOutbox(davCreate.id!, () => davAdapter))?.status, "completed");
    assert.equal((await deliverEventOutbox(davUpdate.id!, () => davAdapter))?.status, "completed");
    assert.equal(davWrites, 2);

    // A native home may gain features outside a mirror's bounded codec. That
    // mirror intent must retain its explicit legacy profile without rolling
    // back the authoritative home import.
    const home = await createCalendar({ creatorID: owner, name: "Authoritative DAV task", color: "#112233" });
    const mirror = await createCalendar({ creatorID: owner, name: "Google task mirror", color: "#112233" });
    const [mirrorSource] = await db.insert(externalCalendars).values({ calendarID: mirror.id, provider: "google",
      userID: owner, accountID, externalCalendarID: `task-mirror-${randomUUID()}`, supportsEvents: false,
      supportsTasks: true }).returning();
    config.api.syncOperationV1EncoderEnabled = false;
    const mirroredTask = await createTask({ id: randomUUID(), creatorID: owner, calendarID: home.id, title: "Before native recurrence" });
    const linked = await linkTask(mirroredTask.id, mirror.id,
      { actorID: owner, expectedRevision: 1, mutationID: randomUUID() });
    assert.ok(linked);
    const mirrorCreate = (await db.select().from(taskOutbox).where(eq(taskOutbox.taskID, mirroredTask.id)))[0]!;
    const mirrorNativeID = `google-mirror-${randomUUID()}`, homeCollection = `https://dav.fixture.test/${randomUUID()}/`, homeNativeID = `${homeCollection}native.ics`;
    await db.update(taskOutbox).set({ status: "completed", resultRef: { externalTaskId: mirrorNativeID, etag: '"google-before"' },
      remoteSnapshot: { title: "Before native recurrence", notes: null, status: "needsAction", due: null } }).where(eq(taskOutbox.id, mirrorCreate.id));
    await db.insert(externalTasks).values([
      { provider: "caldav", taskID: mirroredTask.id, calendarID: home.id, externalCalendarID: homeCollection,
        externalTaskID: homeNativeID, etag: '"dav-before"', icalUid: mirroredTask.id },
      { provider: "google", taskID: mirroredTask.id, calendarID: mirror.id, externalCalendarID: mirrorSource.externalCalendarID,
        externalTaskID: mirrorNativeID, etag: '"google-before"', externalCalendarLinkID: mirrorSource.id, accountID,
        providerAccessRevision: mirrorSource.providerAccessRevision,
        projectionBaseline: { title: "Before native recurrence", notes: null, status: "needsAction", due: null } },
    ]);
    config.api.syncOperationV1EncoderEnabled = true;
    const nativeTaskValues = { title: "Authoritative recurring task", description: null, status: "needs-action" as const,
      start: null, due: null, isAllDay: false, completedAt: null, percentComplete: 0, priority: 0,
      recurrence: "RRULE:FREQ=DAILY;COUNT=3", relatedTo: null, sequence: 1, url: null };
    assert.equal(await upsertExternalTask("caldav", owner, home.id, homeCollection, homeNativeID,
      nativeTaskValues, '"dav-recurring"', mirroredTask.id), true,
      "authoritative recurrence import must commit while Google fanout remains legacy");
    const [recurringCanonical] = await db.select().from(tasks).where(eq(tasks.id, mirroredTask.id));
    assert.equal(recurringCanonical.recurrence, nativeTaskValues.recurrence);
    assert.equal(recurringCanonical.title, nativeTaskValues.title);
    const recurringFanout = (await db.select().from(taskOutbox).where(and(eq(taskOutbox.taskID, mirroredTask.id),
      eq(taskOutbox.revision, recurringCanonical.revision))))[0]!;
    assert.equal(recurringFanout.action, "update");
    assert.equal(own(recurringFanout.payload, "operationEnvelope"), false, "recurring Google target has explicit legacy profile");
    const unlinkedRecurring = await unlinkTask(mirroredTask.id, mirror.id,
      { actorID: owner, expectedRevision: recurringCanonical.revision, mutationID: randomUUID() });
    assert.ok(unlinkedRecurring);
    const recurringDelete = (await db.select().from(taskOutbox).where(and(eq(taskOutbox.taskID, mirroredTask.id),
      eq(taskOutbox.action, "delete"))))[0]!;
    assert.equal(own(recurringDelete.payload, "operationEnvelope"), false, "recurring cleanup DELETE also keeps legacy profile");

    for (const descriptionLength of [2_000_001, 1_990_000]) {
      config.api.syncOperationV1EncoderEnabled = false;
      const budgetTask = await createTask({ id: randomUUID(), creatorID: owner, calendarID: home.id, title: "Before native budget boundary" });
      await linkTask(budgetTask.id, mirror.id, { actorID: owner, expectedRevision: 1, mutationID: randomUUID() });
      const budgetCreate = (await db.select().from(taskOutbox).where(eq(taskOutbox.taskID, budgetTask.id)))[0]!;
      const budgetHomeID = `${homeCollection}budget-${randomUUID()}.ics`, budgetMirrorID = `budget-mirror-${randomUUID()}`;
      await db.update(taskOutbox).set({ status: "completed", resultRef: { externalTaskId: budgetMirrorID, etag: '"budget-before"' },
        remoteSnapshot: { title: budgetTask.title, notes: null, status: "needsAction", due: null } }).where(eq(taskOutbox.id, budgetCreate.id));
      await db.insert(externalTasks).values([
        { provider: "caldav", taskID: budgetTask.id, calendarID: home.id, externalCalendarID: homeCollection,
          externalTaskID: budgetHomeID, etag: '"budget-home-before"', icalUid: budgetTask.id },
        { provider: "google", taskID: budgetTask.id, calendarID: mirror.id, externalCalendarID: mirrorSource.externalCalendarID,
          externalTaskID: budgetMirrorID, etag: '"budget-before"', externalCalendarLinkID: mirrorSource.id, accountID,
          providerAccessRevision: mirrorSource.providerAccessRevision,
          projectionBaseline: { title: budgetTask.title, notes: null, status: "needsAction", due: null } },
      ]);
      const description = "x".repeat(descriptionLength);
      config.api.syncOperationV1EncoderEnabled = true;
      assert.equal(await upsertExternalTask("caldav", owner, home.id, homeCollection, budgetHomeID,
        { ...nativeTaskValues, title: `Native budget ${descriptionLength}`, recurrence: null, description },
        '"budget-home-next"', budgetTask.id), true, "valid large native data cannot roll back its source import");
      const [budgetCanonical] = await db.select().from(tasks).where(eq(tasks.id, budgetTask.id));
      assert.equal(budgetCanonical.description?.length, descriptionLength);
      assert.equal(hash(budgetCanonical.description), hash(description), "native content is preserved without truncation");
      const [budgetFanout] = await db.select().from(taskOutbox).where(and(eq(taskOutbox.taskID, budgetTask.id), eq(taskOutbox.revision, budgetCanonical.revision)));
      if (descriptionLength > 2_000_000) {
        assert.equal(own(budgetFanout.payload, "operationEnvelope"), false, "outside v1 JSON budget stays legacy");
        assert.equal(hash(budgetFanout.payload.task.description), hash(description));
        await unlinkTask(budgetTask.id, mirror.id, { actorID: owner, expectedRevision: budgetCanonical.revision, mutationID: randomUUID() });
        const [budgetDelete] = await db.select().from(taskOutbox).where(and(eq(taskOutbox.taskID, budgetTask.id), eq(taskOutbox.action, "delete")));
        assert.equal(own(budgetDelete.payload, "operationEnvelope"), false);
        assert.equal(hash(budgetDelete.payload.task.description), hash(description), "cleanup retains the full legacy snapshot too");
      } else {
        assert.equal(envelope(budgetFanout).serializer.id, "google-task");
        assert.equal(hash(envelope(budgetFanout).admittedProjection.data.notes), hash(description));
      }
    }

    const budgetDavAccount = await saveCaldavAccount(owner, "https://fixture.invalid/", "fixture", encryptSecret("fixture"));
    for (const boundary of ["collection-over", "planned-at", "planned-over"] as const) {
      const taskID = randomUUID(), suffix = `${taskID}.ics`, origin = "https://fixture.invalid/";
      const longCollection = boundary === "collection-over" ? origin + "path".repeat(520) + "/"
        : origin + "p".repeat(2048 + Number(boundary === "planned-over") - suffix.length - origin.length - 1) + "/";
      const plannedURL = longCollection + suffix;
      assert.equal(boundary === "collection-over" ? longCollection.length : plannedURL.length,
        boundary === "collection-over" ? 2105 : boundary === "planned-at" ? 2048 : 2049);
      const longCalendar = await createCalendar({ creatorID: owner, name: `DAV ${boundary}`, color: "#112233" });
      await db.insert(externalCalendars).values({ calendarID: longCalendar.id, provider: "caldav", userID: owner,
        accountID: budgetDavAccount.id, externalCalendarID: longCollection, supportsTasks: true,
        providerAccessRole: "caldav:read=yes;write=yes" });
      const longTask = await createTask({ id: taskID, creatorID: owner, calendarID: longCalendar.id, title: "Valid long DAV address" });
      const longRow = await taskJob(longTask.id);
      assert.equal(longRow.externalCalendarID, longCollection, "destination address is never truncated");
      assert.equal(hash(longRow.externalCalendarID), hash(longCollection));
      assert.equal((await db.select().from(tasks).where(eq(tasks.id, taskID)))[0].title, longTask.title);
      if (boundary === "planned-at") {
        assert.equal(envelope(longRow).locator.resourceId, plannedURL, "exact address boundary is supported losslessly");
        assert.equal(envelope(longRow).serializer.id, "caldav-task");
      } else assert.equal(own(longRow.payload, "operationEnvelope"), false, "oversized collection or planned address stays legacy");
    }

    config.api.syncOperationV1EncoderEnabled = false;
    const disabledTask = await createTask({ id: randomUUID(), creatorID: owner, calendarID: home.id, title: "Before disabled mirror" });
    await linkTask(disabledTask.id, mirror.id, { actorID: owner, expectedRevision: 1, mutationID: randomUUID() });
    const disabledMirrorCreate = (await db.select().from(taskOutbox).where(eq(taskOutbox.taskID, disabledTask.id)))[0]!;
    const disabledHomeID = `${homeCollection}disabled-${randomUUID()}.ics`, disabledMirrorID = `disabled-mirror-${randomUUID()}`;
    await db.update(taskOutbox).set({ status: "completed", resultRef: { externalTaskId: disabledMirrorID, etag: '"disabled-before"' },
      remoteSnapshot: { title: "Before disabled mirror", notes: null, status: "needsAction", due: null } }).where(eq(taskOutbox.id, disabledMirrorCreate.id));
    await db.insert(externalTasks).values([
      { provider: "caldav", taskID: disabledTask.id, calendarID: home.id, externalCalendarID: homeCollection,
        externalTaskID: disabledHomeID, etag: '"disabled-home-before"', icalUid: disabledTask.id },
      { provider: "google", taskID: disabledTask.id, calendarID: mirror.id, externalCalendarID: mirrorSource.externalCalendarID,
        externalTaskID: disabledMirrorID, etag: '"disabled-before"', externalCalendarLinkID: mirrorSource.id, accountID,
        providerAccessRevision: mirrorSource.providerAccessRevision,
        projectionBaseline: { title: "Before disabled mirror", notes: null, status: "needsAction", due: null } },
    ]);
    await db.update(account).set({ syncStatus: "disabled" }).where(eq(account.id, oauthID));
    config.api.syncOperationV1EncoderEnabled = true;
    assert.equal(await upsertExternalTask("caldav", owner, home.id, homeCollection, disabledHomeID,
      { ...nativeTaskValues, title: "Native edit while mirror disabled", recurrence: null }, '"disabled-home-next"', disabledTask.id), true,
      "disabled destination cannot roll back the authoritative native source");
    const disabledCanonical = (await db.select().from(tasks).where(eq(tasks.id, disabledTask.id)))[0]!;
    assert.equal(disabledCanonical.title, "Native edit while mirror disabled");
    const disabledFanout = (await db.select().from(taskOutbox).where(and(eq(taskOutbox.taskID, disabledTask.id), eq(taskOutbox.revision, disabledCanonical.revision))))[0]!;
    const inactiveCapture = SyncOperationCaptureSchema.parse(disabledFanout.payload.operationCapture);
    const [inactiveConnection] = await db.select({ generation: sql<number>`sync_read_generation` }).from(account).where(eq(account.id, oauthID));
    assert.equal(inactiveCapture.connectionGeneration, inactiveConnection.generation);
    assert.equal(envelope(disabledFanout).admittedProjection.data.title, disabledCanonical.title);
    const factoriesBeforeInactive = factories;
    assert.equal((await deliverTaskOutbox(disabledFanout.id, factory))?.status, "blocked");
    assert.equal(factories, factoriesBeforeInactive);
    await db.update(account).set({ syncStatus: "active" }).where(eq(account.id, oauthID));
    await db.update(taskOutbox).set({ status: "pending", nextAttemptAt: new Date(0) }).where(eq(taskOutbox.id, disabledFanout.id));
    assert.equal((await deliverTaskOutbox(disabledFanout.id, factory))?.status, "blocked", "reconnect never grants the old captured operation authority");
    assert.equal(factories, factoriesBeforeInactive);
    await upsertExternalTask("caldav", owner, home.id, homeCollection, disabledHomeID,
      { ...nativeTaskValues, title: "Fresh native edit after reconnect", recurrence: null, sequence: 2 }, '"disabled-home-fresh"', disabledTask.id);
    const freshCanonical = (await db.select().from(tasks).where(eq(tasks.id, disabledTask.id)))[0]!;
    const freshFanout = (await db.select().from(taskOutbox).where(and(eq(taskOutbox.taskID, disabledTask.id), eq(taskOutbox.revision, freshCanonical.revision))))[0]!;
    const freshCapture = SyncOperationCaptureSchema.parse(freshFanout.payload.operationCapture);
    assert.ok(freshCapture.connectionGeneration > inactiveCapture.connectionGeneration);
    assert.equal(envelope(freshFanout).admittedProjection.data.title, "Fresh native edit after reconnect");
    remoteTasks.set(disabledMirrorID, { ref: { externalTaskId: disabledMirrorID, etag: '"disabled-before"' },
      projection: { title: "Before disabled mirror", notes: null, status: "needsAction", due: null } });
    const writesBeforeFresh = taskWrites;
    assert.equal((await deliverTaskOutbox(freshFanout.id, factory))?.status, "completed",
      "a fresh captured operation can follow a proven no-write retired connection intent");
    assert.equal(taskWrites, writesBeforeFresh + 1);
    assert.equal(remoteTasks.get(disabledMirrorID)?.projection.title, "Fresh native edit after reconnect");
    assert.equal(projectors, 0, "connection recovery dispatches its new pinned target without mapper B");
    assert.equal(hash((await taskRow(disabledFanout.id)).payload), hash(disabledFanout.payload));

    const imported = { ...value("Imported DAV"), calendars: [davCalendar.id], originCalendarID: davCalendar.id };
    await createEvent(imported, imported.calendars);
    const importedID = `${collection}imported.ics`;
    await db.insert(externalEvents).values({ eventID: imported.id, calendarID: davCalendar.id, provider: "caldav",
      externalCalendarID: collection, externalEventID: importedID, etag: '"imported"', icalUid: null });
    const importedUpdate = { ...davIntent(imported, "update"), externalEventID: importedID, expectedEtag: '"imported"',
      payload: { event: imported, patch: { title: "Imported A2" } } };
    await patchEventAndCalendarLinks(imported.id, 1, { title: "Imported A2" }, false, [importedUpdate]);
    assert.equal(own((await eventRow(importedUpdate.id!)).payload, "operationEnvelope"), false, "missing imported UID remains explicit legacy profile");

    const recurring = { ...value("Google normalized echo"), recurrence: "RRULE:FREQ=YEARLY;BYMONTHDAY=1;COUNT=3" };
    const recurringJob = intent(recurring); await createEvent(recurring, recurring.calendars, [recurringJob]);
    const echoRow = await eventRow(recurringJob.id!), target = envelope(echoRow).admittedProjection.data;
    assert.notEqual(target.recurrence, recurring.recurrence, "provider normalization differs from canonical recurrence");
    const echoLease = randomUUID();
    await db.update(eventOutbox).set({ status: "attempting", attempts: 1, uncertain: true, leaseToken: echoLease,
      leaseUntil: new Date(Date.now() + 120_000), payload: { ...echoRow.payload,
        providerProjection: { ...recurring, title: "Old preview B" } } }).where(eq(eventOutbox.id, echoRow.id));
    await db.transaction(async tx => {
      await tx.select({ id: events.id }).from(events).where(eq(events.id, recurring.id)).for("update");
      assert.equal(await retainPendingEventPull(tx, recurring.id, calendar.id, "google", `musubi${echoRow.id.replace(/-/g, "")}`,
        { title: String(target.title), start: new Date(String(target.start)), end: new Date(String(target.end)),
          isAllDay: Boolean(target.isAllDay), description: target.description as string | null,
          location: target.location as string | null, recurrence: target.recurrence as string | null }, '"echo-A"', null), true);
    });
    const retainedEcho = await eventRow(echoRow.id);
    assert.equal(retainedEcho.remoteSnapshot?.isEcho, true); assert.equal(retainedEcho.status, "attempting");
    assert.equal(retainedEcho.leaseToken, echoLease, "valid admitted echo never revokes its live worker lease");

    const afterWriteEvent = await enqueueEvent("Native A before source retirement");
    afterEventWrite = async () => { await db.update(externalCalendars).set({ providerAccessRevision: 10 }).where(eq(externalCalendars.id, source.id)); };
    const blockedEventAck = await deliverEventOutbox(afterWriteEvent.row.id, factory);
    assert.equal(blockedEventAck?.status, "blocked"); assert.equal(blockedEventAck?.uncertain, true);
    assert.equal((await db.select().from(externalEvents).where(eq(externalEvents.eventID, afterWriteEvent.event.id))).length, 0,
      "source retirement after native write prevents atomic local mapping ACK");
    const afterWriteTask = await enqueueTask("Native task A before connection retirement");
    afterTaskWrite = async () => {
      await db.update(account).set({ syncStatus: "disabled" }).where(eq(account.id, oauthID));
      await db.update(account).set({ syncStatus: "active" }).where(eq(account.id, oauthID));
    };
    const blockedTaskAck = await deliverTaskOutbox(afterWriteTask.row.id, factory);
    assert.equal(blockedTaskAck?.status, "blocked"); assert.equal(blockedTaskAck?.uncertain, true);
    assert.equal((await db.select().from(externalTasks).where(eq(externalTasks.taskID, afterWriteTask.task.id))).length, 0,
      "connection retirement after native write prevents atomic task mapping ACK");
    console.log("Operation admission PostgreSQL: immutable dispatch/recovery, task race, rollback/resolution, DAV identity, bounded legacy data, inactive/reconnected destinations and privacy/ACK fences passed");
  } finally {
    config.api.syncOperationV1EncoderEnabled = originalEncoder;
    // Durable journals intentionally have no user FK; keep this synthetic
    // owner out of later queue/metrics fixtures as well as canonical tables.
    await db.delete(eventOutbox).where(eq(eventOutbox.userID, owner));
    await db.delete(taskOutbox).where(eq(taskOutbox.userID, owner));
    await db.delete(user).where(eq(user.id, owner));
    assert.equal((await db.select({ id: eventOutbox.id }).from(eventOutbox).where(eq(eventOutbox.userID, owner))).length, 0);
    assert.equal((await db.select({ id: taskOutbox.id }).from(taskOutbox).where(eq(taskOutbox.userID, owner))).length, 0);
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
