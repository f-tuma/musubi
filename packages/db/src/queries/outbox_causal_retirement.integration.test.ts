import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { config } from "@musubi/config";
import { EventSchema, SyncOperationCaptureSchema, SyncOperationEnvelopeSchema, type Event } from "@musubi/types";
import { db, user, account, events, tasks, eventOutbox, taskOutbox, externalCalendars, caldavAccounts,
  createCalendar, createEvent, patchEventAndCalendarLinks, createTask, updateTask,
  claimEventOutbox, claimTaskOutbox, decodeEventOutboxOperation, decodeTaskOutboxOperation,
  type EventOutboxIntent, type EventOutboxRow, type TaskOutboxRow,
  taskOutboxSnapshot, prepareTaskOutboxInTransaction, appendTaskOutbox } from "..";

import { lockCalendarLifecycle } from "./calendar-lifecycle";
import { assertPinnedOutboxSourceInTransaction } from "./operation-admission";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Use a disposable test database");
  const owner = `causal-retirement-${randomUUID()}`, accountID = randomUUID(), oauthID = randomUUID();
  const originalEncoder = config.api.syncOperationV1EncoderEnabled;
  await db.insert(user).values({ id: owner, name: "Causal retirement fixture", email: `${owner}@example.test` });
  config.api.syncOperationV1EncoderEnabled = true;
  try {
    await db.insert(account).values({ id: oauthID, userId: owner, providerId: "google", accountId: accountID,
      syncStatus: "active", refreshToken: "fixture.no-http", accessToken: "fixture.no-http", scope: "fixture" });
    const calendar = await createCalendar({ creatorID: owner, name: "Causal recovery", color: "#112233" });
    const [source] = await db.insert(externalCalendars).values({ calendarID: calendar.id, provider: "google",
      userID: owner, accountID, externalCalendarID: `fixture-${randomUUID()}`, providerAccessRole: "owner",
      providerAccessRevision: 1, supportsEvents: true, supportsTasks: true }).returning();
    const row = async (kind: "event" | "task", id: string) => kind === "event"
      ? (await db.select().from(eventOutbox).where(eq(eventOutbox.id, id)))[0]!
      : (await db.select().from(taskOutbox).where(eq(taskOutbox.id, id)))[0]!;
    const eventIntent = (event: Event, action: EventOutboxIntent["action"]): EventOutboxIntent => ({
      id: randomUUID(), actorID: owner, mutationID: randomUUID(), position: 0, eventID: event.id,
      calendarID: calendar.id, externalCalendarLinkID: source.id, provider: "google", userID: owner, accountID,
      externalCalendarID: source.externalCalendarID, action, payload: { event, ...(action === "update" ? { patch: { title: "Fresh A2" } } : {}) },
    });
    const enqueue = async (kind: "event" | "task", legacy = false) => {
      config.api.syncOperationV1EncoderEnabled = !legacy;
      try {
        if (kind === "event") {
          const event = EventSchema.parse({ id: randomUUID(), creatorID: owner, organizer: owner,
            title: "Admitted A", start: "2026-10-01T09:00:00Z", end: "2026-10-01T10:00:00Z",
            isAllDay: false, isCanceled: false, color: "#112233", calendars: [calendar.id], originCalendarID: calendar.id });
          const intent = eventIntent(event, "create"); await createEvent(event, event.calendars, [intent]);
          return { id: event.id, event, receipt: await row(kind, intent.id!) };
        }
        const task = await createTask({ id: randomUUID(), creatorID: owner, calendarID: calendar.id,
          title: "Admitted A", description: "Accepted notes" }, { actorID: owner, mutationID: randomUUID() });
        const [receipt] = await db.select().from(taskOutbox).where(eq(taskOutbox.taskID, task.id));
        return { id: task.id, event: undefined, receipt };
      } finally { config.api.syncOperationV1EncoderEnabled = true; }
    };
    const changeConnection = async () => {
      await db.update(account).set({ syncStatus: "disabled" }).where(eq(account.id, oauthID));
      await db.update(account).set({ syncStatus: "active" }).where(eq(account.id, oauthID));
    };
    const appendFresh = async (kind: "event" | "task", original: Awaited<ReturnType<typeof enqueue>>, retired = 0, sourceImport = false) => {
      if (kind === "event") {
        const intent = eventIntent(original.event!, "update");
        assert.ok(await patchEventAndCalendarLinks(original.id, 1, { title: "Fresh A2" }, false, [intent]));
        return await row(kind, intent.id!);
      }
      if (sourceImport) {
        // Native authoritative admission uses the same canonical CAS and outbox
        // preparation helpers, without claiming that a retired home permits UI
        // edits. The API fixture separately covers actual provider pull/delivery.
        await db.transaction(async tx => {
          await lockCalendarLifecycle(tx, [calendar.id], "shared");
          await tx.select().from(tasks).where(eq(tasks.id, original.id)).for("update");
          const [saved] = await tx.update(tasks).set({ title: "Fresh A2", revision: 2 }).where(and(
            eq(tasks.id, original.id), eq(tasks.revision, 1))).returning();
          assert.ok(saved);
          const target = taskOutboxSnapshot(saved, [calendar.id]);
          const intents = await prepareTaskOutboxInTransaction(tx, target, [{ calendarID: calendar.id, action: "update" }],
            { actorID: owner, mutationID: randomUUID() });
          await appendTaskOutbox(tx, target, intents);
        });
      } else assert.ok(await updateTask(original.id, { title: "Fresh A2" }, { actorID: owner, expectedRevision: 1,
        expectedProviderReadRetiredGeneration: retired, mutationID: randomUUID() }));
      return (await db.select().from(taskOutbox).where(and(eq(taskOutbox.taskID, original.id), eq(taskOutbox.revision, 2))))[0]!;
    };
    const claim = (kind: "event" | "task", id: string) => kind === "event" ? claimEventOutbox(id) : claimTaskOutbox(id);
    const updateReceipt = async (kind: "event" | "task", id: string, change: Record<string, unknown>) => {
      if (kind === "event") await db.update(eventOutbox).set(change as Partial<EventOutboxRow>).where(eq(eventOutbox.id, id));
      else await db.update(taskOutbox).set(change as Partial<TaskOutboxRow>).where(eq(taskOutbox.id, id));
    };

    let cases = 0;
    for (const kind of ["event", "task"] as const) {
      for (const status of ["blocked", "pending", "retry", "not-written"] as const) {
        const original = await enqueue(kind);
        await updateReceipt(kind, original.receipt.id, { status, uncertain: false, attempts: status === "pending" ? 0 : 1 });
        const before = await row(kind, original.receipt.id), bytes = hash(before.payload);
        await changeConnection();
        const fresh = await appendFresh(kind, original), old = await row(kind, original.receipt.id);
        assert.equal(old.status, "cancelled", `${kind}/${status}: known unwritten stale incarnation retires`);
        assert.equal(old.errorCode, "superseded-admission-generation"); assert.equal(hash(old.payload), bytes);
        assert.equal(old.resultRef, null); assert.equal(old.remoteSnapshot, null);
        assert.equal(fresh.action, "create", "retired addressless CREATE requires a fresh CREATE, never UPDATE");
        assert.equal(fresh.predecessorID, null); assert.notEqual(fresh.id, old.id);
        assert.equal(kind === "event" ? decodeEventOutboxOperation(fresh as EventOutboxRow).kind : decodeTaskOutboxOperation(fresh as TaskOutboxRow).kind, "pinned-v1");
        assert.ok(await claim(kind, fresh.id), "new incarnation operation is actually claimable");
        cases++;
      }
      for (const epoch of ["source", "privacy"] as const) {
        const original = await enqueue(kind);
        await updateReceipt(kind, original.receipt.id, { status: "blocked", uncertain: false });
        if (epoch === "source") {
          const [current] = await db.select().from(externalCalendars).where(eq(externalCalendars.id, source.id));
          await db.update(externalCalendars).set({ providerAccessRevision: current.providerAccessRevision + 1 }).where(eq(externalCalendars.id, source.id));
        } else if (kind === "event") await db.update(events).set({ providerReadRetiredRevision: 1 }).where(eq(events.id, original.id));
        else await db.update(tasks).set({ providerReadRetiredGeneration: 1 }).where(eq(tasks.id, original.id));
        const fresh = await appendFresh(kind, original, epoch === "privacy" ? 1 : 0, true);
        assert.equal((await row(kind, original.receipt.id)).status, "cancelled");
        assert.ok(await claim(kind, fresh.id), `${kind}/${epoch}: known no-effect stale epoch releases only its local barrier`);
        cases++;
      }
      for (const barrier of ["uncertain", "expired-attempt", "result", "observation", "unknown-version", "unknown-id", "legacy", "current"] as const) {
        const original = await enqueue(kind, barrier === "legacy");
        const patch: Record<string, unknown> = { status: "blocked", uncertain: false };
        if (barrier === "uncertain") patch.uncertain = true;
        if (barrier === "expired-attempt") Object.assign(patch, { status: "attempting", uncertain: false, attempts: 1,
          leaseToken: randomUUID(), leaseUntil: new Date(0) });
        if (barrier === "result") patch.resultRef = kind === "event" ? { externalEventId: "possible-native" } : { externalTaskId: "possible-native" };
        if (barrier === "observation") patch.remoteSnapshot = kind === "event" ? { externalEventId: "observed-native", etag: '"seen"' } : { title: "Observed native" };
        if (barrier === "unknown-version" || barrier === "unknown-id") {
          const envelope = SyncOperationEnvelopeSchema.parse(original.receipt.payload.operationEnvelope);
          if (barrier === "unknown-version") envelope.serializer.version = 99; else envelope.serializer.id = "future-codec";
          patch.payload = { ...original.receipt.payload, operationEnvelope: envelope };
        }
        await updateReceipt(kind, original.receipt.id, patch);
        const before = await row(kind, original.receipt.id), bytes = hash(before.payload), evidence = hash([before.resultRef, before.remoteSnapshot]);
        if (barrier !== "current") await changeConnection();
        if (barrier === "unknown-version") {
          const [current] = await db.select().from(externalCalendars).where(eq(externalCalendars.id, source.id));
          await db.update(externalCalendars).set({ providerAccessRevision: current.providerAccessRevision + 1 }).where(eq(externalCalendars.id, source.id));
        }
        const fresh = await appendFresh(kind, original, 0, barrier === "unknown-version"), after = await row(kind, original.receipt.id);
        assert.equal(after.status, before.status, `${kind}/${barrier}: retain causal barrier`);
        assert.equal(hash(after.payload), bytes); assert.equal(hash([after.resultRef, after.remoteSnapshot]), evidence);
        assert.equal(fresh.predecessorID, before.id); assert.equal(await claim(kind, fresh.id), undefined);
        cases++;
      }
    }
    // A saved task dispatch projection is local evidence of a dispatched attempt;
    // even a valid saved A target cannot become a no-write incarnation proof.
    const dispatched = await enqueue("task"), target = SyncOperationEnvelopeSchema.parse(dispatched.receipt.payload.operationEnvelope).admittedProjection.data;
    await updateReceipt("task", dispatched.receipt.id, { status: "retry", uncertain: false, attempts: 1,
      payload: { ...dispatched.receipt.payload, dispatchProjection: { version: 1, projection: target, patch: target, baseline: null } } });
    await changeConnection();
    const successor = await appendFresh("task", dispatched);
    assert.equal((await row("task", dispatched.receipt.id)).status, "retry");
    assert.equal(successor.predecessorID, dispatched.receipt.id); assert.equal(await claim("task", successor.id), undefined);
    cases++;
    // The same timestamp fence is used for DAV connection revisions. This
    // fixture proves changed revisions; it does not assert monotonic DAV ABA.
    const [dav] = await db.insert(caldavAccounts).values({ userID: owner, serverUrl: "https://fixture.test/dav",
      username: "fixture", encryptedPassword: "fixture.not-used", updatedAt: new Date("2026-01-01T00:00:00Z") }).returning();
    const davCalendar = await createCalendar({ creatorID: owner, name: "DAV recovery", color: "#112233" });
    const [davSource] = await db.insert(externalCalendars).values({ calendarID: davCalendar.id, provider: "caldav",
      userID: owner, accountID: dav.id, externalCalendarID: "https://fixture.test/dav/tasks/",
      providerAccessRole: "caldav:read=yes;write=yes", providerAccessRevision: 1, supportsEvents: true, supportsTasks: true }).returning();
    for (const kind of ["event", "task"] as const) {
      let objectID: string, oldID: string, event: Event | undefined;
      const davIntent = (action: "create" | "update"): EventOutboxIntent => ({ id: randomUUID(), actorID: owner,
        mutationID: randomUUID(), position: 0, eventID: event!.id, calendarID: davCalendar.id,
        externalCalendarLinkID: davSource.id, provider: "caldav", userID: owner, accountID: dav.id,
        externalCalendarID: davSource.externalCalendarID, action, payload: { event: event!, patch: { title: "DAV A2" } } });
      if (kind === "event") {
        event = EventSchema.parse({ id: randomUUID(), creatorID: owner, organizer: owner, title: "DAV A",
          start: "2026-10-01T09:00:00Z", end: "2026-10-01T10:00:00Z", isAllDay: false, isCanceled: false,
          color: "#112233", calendars: [davCalendar.id], originCalendarID: davCalendar.id });
        const intent = davIntent("create"); await createEvent(event, event.calendars, [intent]); objectID = event.id; oldID = intent.id!;
      } else {
        const task = await createTask({ id: randomUUID(), creatorID: owner, calendarID: davCalendar.id,
          title: "DAV A" }, { actorID: owner, mutationID: randomUUID() }); objectID = task.id;
        oldID = (await db.select().from(taskOutbox).where(eq(taskOutbox.taskID, task.id)))[0]!.id;
      }
      await updateReceipt(kind, oldID, { status: "blocked", uncertain: false });
      const before = await row(kind, oldID), bytes = hash(before.payload);
      const [oldConnection] = await db.select().from(caldavAccounts).where(eq(caldavAccounts.id, dav.id));
      await db.update(caldavAccounts).set({ updatedAt: new Date(oldConnection.updatedAt.getTime() + 1000) }).where(eq(caldavAccounts.id, dav.id));
      let fresh: EventOutboxRow | TaskOutboxRow;
      if (kind === "event") {
        const intent = davIntent("update"); assert.ok(await patchEventAndCalendarLinks(objectID, 1, { title: "DAV A2" }, false, [intent]));
        fresh = await row(kind, intent.id!);
      } else {
        assert.ok(await updateTask(objectID, { title: "DAV A2" }, { actorID: owner, expectedRevision: 1, mutationID: randomUUID() }));
        fresh = (await db.select().from(taskOutbox).where(and(eq(taskOutbox.taskID, objectID), eq(taskOutbox.revision, 2))))[0]!;
      }
      assert.equal((await row(kind, oldID)).status, "cancelled"); assert.equal(hash((await row(kind, oldID)).payload), bytes);
      assert.equal(fresh.action, "create"); assert.equal(fresh.predecessorID, null);
      assert.ok(await claim(kind, fresh.id)); cases++;
    }

    // A stale sibling source belongs to a separate causal chain. Retiring one
    // exact destination never retires another source in the same OAuth grant.
    const sibling = await createCalendar({ creatorID: owner, name: "Sibling source", color: "#112233" });
    const [siblingSource] = await db.insert(externalCalendars).values({ calendarID: sibling.id, provider: "google",
      userID: owner, accountID, externalCalendarID: `sibling-${randomUUID()}`, providerAccessRole: "owner",
      providerAccessRevision: 1, supportsEvents: true }).returning();
    const scopedEvent = EventSchema.parse({ id: randomUUID(), creatorID: owner, organizer: owner, title: "Scoped A",
      start: "2026-10-01T09:00:00Z", end: "2026-10-01T10:00:00Z", isAllDay: false, isCanceled: false,
      color: "#112233", calendars: [calendar.id, sibling.id], originCalendarID: calendar.id });
    const firstIntent = eventIntent(scopedEvent, "create"), siblingIntent = { ...eventIntent(scopedEvent, "create"),
      mutationID: firstIntent.mutationID, position: 1, calendarID: sibling.id, externalCalendarLinkID: siblingSource.id,
      externalCalendarID: siblingSource.externalCalendarID };
    await createEvent(scopedEvent, scopedEvent.calendars, [firstIntent, siblingIntent]);
    await updateReceipt("event", firstIntent.id!, { status: "blocked", uncertain: false });
    await updateReceipt("event", siblingIntent.id!, { status: "blocked", uncertain: false });
    await changeConnection();
    const newIntent = eventIntent(scopedEvent, "update");
    assert.ok(await patchEventAndCalendarLinks(scopedEvent.id, 1, { title: "Fresh A2" }, false, [newIntent]));
    assert.equal((await row("event", firstIntent.id!)).status, "cancelled");
    assert.equal((await row("event", siblingIntent.id!)).status, "blocked", "sibling grant/source capture remains unchanged");
    assert.ok(await claim("event", newIntent.id!)); cases++;
    // Legacy host source keys are opaque strings. A retired DAV projection
    // need not have a physical credential row; causal recovery has no new proof
    // to derive and must preserve its ordinary legacy admission path.
    config.api.syncOperationV1EncoderEnabled = false;
    const opaqueCalendar = await createCalendar({ creatorID: owner, name: "Opaque retired DAV", color: "#112233" });
    const [opaqueSource] = await db.insert(externalCalendars).values({ calendarID: opaqueCalendar.id, provider: "caldav",
      userID: owner, accountID: "retired-account", externalCalendarID: "retired-collection",
      providerAccessRole: "caldav:read=yes;freebusy=yes", supportsEvents: true, supportsTasks: true }).returning();
    const opaqueTask = await createTask({ id: randomUUID(), creatorID: owner, calendarID: opaqueCalendar.id,
      title: "Legacy opaque source task" }, { actorID: owner, mutationID: randomUUID() });
    const [opaqueReceipt] = await db.select().from(taskOutbox).where(eq(taskOutbox.taskID, opaqueTask.id));
    assert.equal(opaqueReceipt.payload.operationEnvelope, undefined); assert.equal(opaqueReceipt.status, "pending"); cases++;
    await db.update(externalCalendars).set({ disabled: true, providerAccessRole: "caldav:read=no;freebusy=yes" }).where(eq(externalCalendars.id, opaqueSource.id));
    await db.transaction(async tx => {
      await lockCalendarLifecycle(tx, [opaqueCalendar.id], "shared");
      await tx.select().from(tasks).where(eq(tasks.id, opaqueTask.id)).for("update");
      const [saved] = await tx.update(tasks).set({ revision: 2, title: "Canonical authoritative A2" }).where(eq(tasks.id, opaqueTask.id)).returning();
      const target = taskOutboxSnapshot(saved, [opaqueCalendar.id]);
      const intents = await prepareTaskOutboxInTransaction(tx, target, [{ calendarID: opaqueCalendar.id, action: "update" }],
        { actorID: owner, mutationID: randomUUID() }, undefined, true);
      await appendTaskOutbox(tx, target, intents);
    });
    const [unavailable] = await db.select().from(taskOutbox).where(and(eq(taskOutbox.taskID, opaqueTask.id), eq(taskOutbox.revision, 2)));
    assert.equal(unavailable.status, "blocked"); assert.equal(unavailable.errorCode, "task-source-read-only");
    assert.equal(unavailable.payload.operationEnvelope, undefined); cases++;
    const opaqueEvent = EventSchema.parse({ id: randomUUID(), creatorID: owner, organizer: owner, title: "Legacy opaque source event",
      start: "2026-10-01T09:00:00Z", end: "2026-10-01T10:00:00Z", isAllDay: false, isCanceled: false,
      color: "#112233", calendars: [opaqueCalendar.id], originCalendarID: opaqueCalendar.id });
    const opaqueIntent: EventOutboxIntent = { id: randomUUID(), actorID: owner, mutationID: randomUUID(), position: 0,
      eventID: opaqueEvent.id, calendarID: opaqueCalendar.id, externalCalendarLinkID: opaqueSource.id, provider: "caldav",
      userID: owner, accountID: opaqueSource.accountID, externalCalendarID: opaqueSource.externalCalendarID,
      action: "create", payload: { event: opaqueEvent } };
    await createEvent(opaqueEvent, opaqueEvent.calendars, [opaqueIntent]);
    assert.equal((await row("event", opaqueIntent.id!)).payload.operationEnvelope, undefined); cases++;
    // Enabling v1 never invents a physical DAV connection identity for an old
    // opaque source. Both canonical kinds still commit on their legacy profile.
    config.api.syncOperationV1EncoderEnabled = true;
    await db.update(externalCalendars).set({ disabled: false, providerAccessRole: "caldav:read=yes;freebusy=yes" }).where(eq(externalCalendars.id, opaqueSource.id));
    const enabledOpaqueTask = await createTask({ id: randomUUID(), creatorID: owner, calendarID: opaqueCalendar.id,
      title: "Encoder enabled, legacy opaque source task" }, { actorID: owner, mutationID: randomUUID() });
    const [enabledOpaqueReceipt] = await db.select().from(taskOutbox).where(eq(taskOutbox.taskID, enabledOpaqueTask.id));
    assert.equal(enabledOpaqueReceipt.payload.operationEnvelope, undefined);
    assert.equal(enabledOpaqueReceipt.payload.operationCapture, undefined);
    assert.equal((await db.select({ title: tasks.title }).from(tasks).where(eq(tasks.id, enabledOpaqueTask.id)))[0]!.title,
      "Encoder enabled, legacy opaque source task"); cases++;
    const enabledOpaqueEvent = EventSchema.parse({ ...opaqueEvent, id: randomUUID(), title: "Encoder enabled, legacy opaque source event" });
    const enabledOpaqueIntent = { ...opaqueIntent, id: randomUUID(), mutationID: randomUUID(), eventID: enabledOpaqueEvent.id,
      payload: { event: enabledOpaqueEvent } };
    await createEvent(enabledOpaqueEvent, enabledOpaqueEvent.calendars, [enabledOpaqueIntent]);
    assert.equal((await row("event", enabledOpaqueIntent.id!)).payload.operationEnvelope, undefined);
    assert.equal((await db.select({ title: events.title }).from(events).where(eq(events.id, enabledOpaqueEvent.id)))[0]!.title,
      "Encoder enabled, legacy opaque source event"); cases++;

    // A structurally valid captured UUID cannot make an opaque host account key
    // queryable in the UUID credential table. Test the authority primitive
    // directly (dispatcher format binding is a separate gate) and prove that
    // rejecting it leaves this same PostgreSQL transaction usable.
    const captured = SyncOperationCaptureSchema.parse(dispatched.receipt.payload.operationCapture);
    const noPhysicalIdentity: TaskOutboxRow = { ...(dispatched.receipt as TaskOutboxRow), taskID: enabledOpaqueTask.id,
      calendarID: opaqueCalendar.id, externalCalendarLinkID: opaqueSource.id, provider: "caldav",
      accountID: opaqueSource.accountID, externalCalendarID: opaqueSource.externalCalendarID,
      payload: { ...dispatched.receipt.payload, operationCapture: { ...captured, sourceId: opaqueSource.id,
        writeGeneration: opaqueSource.providerAccessRevision, privacyEpoch: "task:0" } } } as TaskOutboxRow;
    await db.transaction(async tx => {
      await lockCalendarLifecycle(tx, [opaqueCalendar.id], "shared");
      await tx.select().from(tasks).where(eq(tasks.id, enabledOpaqueTask.id)).for("update");
      assert.equal(await assertPinnedOutboxSourceInTransaction(tx, noPhysicalIdentity), false,
        "Opaque CalDAV host key cannot grant a physical connection-incarnation proof");
      const proof = await tx.execute(sql`select 1 as proof`);
      assert.equal(proof.rows[0]?.proof, 1, "rejected key never sends invalid UUID SQL or aborts its transaction");
    }); cases++;
    console.log(`Causal retirement PostgreSQL: ${cases} scoped known-format/no-effect and retained-barrier cases passed`);
  } finally {
    config.api.syncOperationV1EncoderEnabled = originalEncoder;
    // Delivery journals deliberately have no object/calendar foreign key, so
    // remove fixture-owned receipts explicitly before deleting their user.
    await db.delete(eventOutbox).where(eq(eventOutbox.userID, owner));
    await db.delete(taskOutbox).where(eq(taskOutbox.userID, owner));
    await db.delete(user).where(eq(user.id, owner));
    assert.equal((await db.select({ id: eventOutbox.id }).from(eventOutbox).where(eq(eventOutbox.userID, owner))).length, 0);
    assert.equal((await db.select({ id: taskOutbox.id }).from(taskOutbox).where(eq(taskOutbox.userID, owner))).length, 0);
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
