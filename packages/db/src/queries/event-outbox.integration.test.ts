import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { lockCalendarLifecycle } from "./calendar-lifecycle";
import {
  db,
  user,
  events,
  eventOutbox,
  externalEvents,
  createCalendar,
  createEvent,
  getEvent,
  getEventCalendars,
  importExternalEvent,
  patchEventAndCalendarLinks,
  forkEventAtRevision,
  claimEventOutbox,
  finishEventOutbox,
  renewEventOutboxLease,
  completeEventOutbox,
  getEventOutboxExpectedRef,
  externalCalendars,
  DuplicateEventMutationError,
  type EventOutboxIntent,
} from "..";
import { EventSchema } from "@musubi/types";
import { config } from "@musubi/config";

// This historical raw-journal fixture intentionally has no provider source rows.
// Exercise its legacy profile; real default-on admission is covered separately.
config.api.syncOperationV1EncoderEnabled = false;
process.env.SYNC_OPERATION_V1_ENCODER_ENABLED = "false";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const owner = `outbox-${randomUUID()}`;
  await db
    .insert(user)
    .values({ id: owner, name: owner, email: `${owner}@example.test` });
  try {
    const home = await createCalendar({
      creatorID: owner,
      name: "Home",
      color: "#112233",
    });
    const copy = await createCalendar({
      creatorID: owner,
      name: "Copy",
      color: "#112233",
    });
    const value = (id = randomUUID()) =>
      EventSchema.parse({
        id,
        creatorID: owner,
        title: "Original",
        color: "#112233",
        organizer: owner,
        start: new Date("2026-01-01T09:00:00Z"),
        end: new Date("2026-01-01T10:00:00Z"),
        isAllDay: false,
        isCanceled: false,
        originCalendarID: home.id,
        calendars: [home.id],
      });
    const linkIDs = new Map([[home.id, randomUUID()], [copy.id, randomUUID()]]);
    const intent = (
      event: ReturnType<typeof value>,
      action: EventOutboxIntent["action"] = "create",
      extra: Partial<EventOutboxIntent> = {},
    ): EventOutboxIntent => ({
      id: randomUUID(),
      actorID: owner,
      mutationID: randomUUID(),
      position: 0,
      eventID: event.id,
      calendarID: home.id,
      externalCalendarLinkID: linkIDs.get(extra.calendarID ?? home.id)!,
      userID: owner,
      provider: "google",
      accountID: "fixture-account",
      externalCalendarID: "remote-calendar",
      externalEventID: action === "create" ? null : "remote-event",
      expectedEtag: action === "create" ? null : '"accepted"',
      icalUid: "retained-uid",
      action,
      payload: { event },
      ...extra,
    });
    const rows = (id: string) =>
      db.select().from(eventOutbox).where(eq(eventOutbox.eventID, id));

    // Raw DB callers and lifecycle locks must use PostgreSQL UUID identity too.
    const uppercase = value(randomUUID().toUpperCase());
    const uppercaseIntent = intent(uppercase);
    const uppercaseCreated = await createEvent(uppercase, [home.id.toUpperCase()], [uppercaseIntent]);
    assert.equal((await rows(uppercaseCreated.id)).length, 1);
    await assert.rejects(() => createEvent({ ...uppercase, id: uppercase.id.toLowerCase() }, [home.id],
      [{ ...uppercaseIntent, eventID: uppercase.id.toLowerCase(), mutationID: uppercaseIntent.mutationID.toUpperCase() }]),
      DuplicateEventMutationError);
    const caseOnly = await patchEventAndCalendarLinks(uppercase.id, 1, { calendars: [home.id.toUpperCase()] });
    assert.equal(caseOnly.status, "saved");
    if (caseOnly.status === "saved") assert.equal(caseOnly.changed, false);
    assert.equal((await getEvent(uppercase.id)).revision, 1);
    await db.transaction(async (tx) => {
      await lockCalendarLifecycle(tx, [home.id, home.id.toUpperCase()], "shared");
      const locks = await tx.execute<{ count: string }>(sql`select count(*)::text as count from pg_locks
        where pid = pg_backend_pid() and locktype = 'advisory'`);
      assert.equal(locks.rows[0].count, "1", "UUID spelling cannot select a different lifecycle fence");
    });

    // A failure in the outbox insert rolls back the event AND calendar links.
    const rejected = value();
    await assert.rejects(() =>
      createEvent(
        rejected,
        [home.id],
        [intent(rejected, "create", { position: -1 })],
      ),
    );
    assert.equal(
      (await db.select().from(events).where(eq(events.id, rejected.id))).length,
      0,
    );
    assert.deepEqual(await getEventCalendars(rejected.id), []);
    assert.deepEqual(await rows(rejected.id), []);

    // A separate writer exits immediately after COMMIT, before any provider call.
    const crashEvent = value();
    const crashIntent = intent(crashEvent);
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        import.meta.filename,
        "--commit-and-exit",
        JSON.stringify({ event: crashEvent, intent: crashIntent }),
      ],
      {
        env: process.env,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let childError = "";
    child.stderr.on("data", (data) => {
      childError += data;
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(exitCode, 0, childError);
    assert.equal((await getEvent(crashEvent.id)).revision, 1);
    assert.equal((await rows(crashEvent.id))[0].status, "pending");
    assert.equal((await rows(crashEvent.id))[0].attempts, 0);

    // A create that has not acquired a remote ID still orders later intentions.
    const waitingUpdate = intent(crashEvent, "update", {
      externalEventID: null,
      expectedEtag: null,
      payload: { event: crashEvent, patch: { title: "After crash" } },
    });
    await patchEventAndCalendarLinks(
      crashEvent.id,
      1,
      { title: "After crash" },
      false,
      [waitingUpdate],
    );
    const waitingDelete = intent(crashEvent, "delete", {
      externalEventID: null,
      expectedEtag: null,
    });
    await patchEventAndCalendarLinks(
      crashEvent.id,
      2,
      { calendars: [] },
      true,
      [waitingDelete],
    );
    const waiting = await rows(crashEvent.id);
    assert.equal(
      waiting.find((row) => row.id === waitingUpdate.id)?.predecessorID,
      crashIntent.id,
    );
    assert.equal(
      waiting.find((row) => row.id === waitingDelete.id)?.predecessorID,
      waitingUpdate.id,
    );
    assert.equal(await claimEventOutbox(waitingUpdate.id!), undefined);
    assert.equal(await claimEventOutbox(waitingDelete.id!), undefined);
    assert.equal(
      waiting.length,
      3,
      "all committed intentions survive, including those without remote IDs",
    );

    const initial = value();
    const createIntent = intent(initial);
    const created = await createEvent(initial, [home.id], [createIntent]);
    await assert.rejects(
      () => createEvent(initial, [home.id], [createIntent]),
      DuplicateEventMutationError,
    );
    let jobs = await rows(created.id);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "pending");
    assert.equal(jobs[0].attempts, 0);
    assert.equal(jobs[0].revision, 1);
    assert.equal(jobs[0].payload.event.revision, 1);
    assert.equal(
      EventSchema.parse(jobs[0].payload.event).start.toISOString(),
      initial.start.toISOString(),
    );
    // No in-memory delivery closure is required to find the committed intent.
    const claimed = await claimEventOutbox(createIntent.id!);
    assert.equal(claimed?.attempts, 1);
    assert.equal(
      await claimEventOutbox(createIntent.id!),
      undefined,
      "ambiguous attempt must not be blindly re-sent",
    );
    await finishEventOutbox(createIntent.id!, claimed!.leaseToken!, "completed");
    assert.equal(await claimEventOutbox(createIntent.id!), undefined);

    const updateIntent = intent(initial, "update", {
      payload: { event: initial, patch: { title: "Changed" } },
    });
    await assert.rejects(() =>
      patchEventAndCalendarLinks(initial.id, 1, { title: "Lost?" }, false, [
        { ...updateIntent, position: -1 },
      ]),
    );
    assert.equal((await getEvent(initial.id)).title, "Original");
    assert.equal((await getEvent(initial.id)).revision, 1);
    assert.equal((await rows(initial.id)).length, 1);
    const updated = await patchEventAndCalendarLinks(
      initial.id,
      1,
      { title: "Changed" },
      false,
      [updateIntent],
    );
    assert.equal(updated.status, "saved");
    jobs = await rows(initial.id);
    assert.equal(jobs.length, 2);
    assert.equal(jobs.find((job) => job.action === "update")?.revision, 2);
    await assert.rejects(
      () =>
        patchEventAndCalendarLinks(initial.id, 1, { title: "Changed" }, false, [
          updateIntent,
        ]),
      DuplicateEventMutationError,
    );
    await patchEventAndCalendarLinks(initial.id, 2, {}, false, [
      intent(initial, "update"),
    ]);
    assert.equal(
      (await rows(initial.id)).length,
      2,
      "stale and no-op requests create no operation",
    );

    const linked = await patchEventAndCalendarLinks(
      initial.id,
      2,
      { calendars: [home.id, copy.id] },
      false,
      [intent(initial, "create", { calendarID: copy.id })],
    );
    assert.equal(linked.status, "saved");
    await importExternalEvent(
      "google",
      initial.id,
      copy.id,
      "remote-calendar",
      "remote-event",
      '"accepted"',
      "retained-uid",
    );
    const deletion = intent(initial, "delete", { calendarID: copy.id });
    const unlinked = await patchEventAndCalendarLinks(
      initial.id,
      3,
      { calendars: [home.id] },
      true,
      [deletion],
    );
    assert.equal(unlinked.status, "saved");
    assert.equal(
      (
        await db
          .select()
          .from(externalEvents)
          .where(eq(externalEvents.eventID, initial.id))
      ).length,
      0,
    );
    const retained = (await rows(initial.id)).find(
      (row) => row.id === deletion.id,
    )!;
    assert.equal(retained.externalEventID, "remote-event");
    assert.equal(retained.expectedEtag, '"accepted"');
    assert.equal(retained.icalUid, "retained-uid");
    assert.equal(retained.accountID, "fixture-account");
    assert.equal(retained.revision, 4);

    const fork = value();
    const forkIntent = intent(fork);
    const forked = await forkEventAtRevision(
      initial.id,
      4,
      fork,
      [copy.id],
      [forkIntent],
    );
    assert.equal(forked.status, "saved");
    const retry = value();
    await assert.rejects(
      () =>
        forkEventAtRevision(
          initial.id,
          4,
          retry,
          [copy.id],
          [
            {
              ...forkIntent,
              id: randomUUID(),
              eventID: retry.id,
              payload: { event: retry },
            },
          ],
        ),
      DuplicateEventMutationError,
    );
    assert.equal(
      (await db.select().from(events).where(eq(events.id, retry.id))).length,
      0,
    );
    assert.deepEqual(await rows(retry.id), []);
    assert.deepEqual(await getEventCalendars(retry.id), []);

    const tombstone = intent(initial, "delete");
    await patchEventAndCalendarLinks(initial.id, 4, { calendars: [] }, true, [
      tombstone,
    ]);
    await db.delete(events).where(eq(events.id, initial.id));
    assert.ok(
      (await rows(initial.id)).some((row) => row.id === tombstone.id),
      "purging tombstone cannot erase delete address",
    );

    const collaborator = `collaborator-${randomUUID()}`;
    await db
      .insert(user)
      .values({
        id: collaborator,
        name: collaborator,
        email: `${collaborator}@example.test`,
      });
    const shared = value();
    await createEvent(
      shared,
      [home.id],
      [intent(shared, "create", { actorID: collaborator })],
    );
    await db.delete(user).where(eq(user.id, collaborator));
    assert.equal(
      (await rows(shared.id)).length,
      1,
      "actor removal must retain another owner's delivery",
    );

    // Two claimers can never both start the same operation.
    const claims = await Promise.all([
      claimEventOutbox(forkIntent.id!),
      claimEventOutbox(forkIntent.id!),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);

    // A restarted worker must reconcile an expired attempt; the previous process
    // cannot renew or acknowledge it, even before another worker claims it.
    const leased = value();
    const leasedIntent = intent(leased);
    await createEvent(leased, [home.id], [leasedIntent]);
    const first = (await claimEventOutbox(leasedIntent.id!))!;
    assert.equal(first.reconciling, false);
    assert.equal(await renewEventOutboxLease(first.id, first.leaseToken!), true);
    await db.update(eventOutbox).set({ leaseUntil: new Date(0) }).where(eq(eventOutbox.id, first.id));
    assert.equal(await renewEventOutboxLease(first.id, first.leaseToken!), false);
    assert.equal(await finishEventOutbox(first.id, first.leaseToken!, "completed"), false);
    assert.equal(await completeEventOutbox(first.id, first.leaseToken!, { externalEventId: "lease-resource" }, null), undefined);
    const restarted = (await claimEventOutbox(first.id))!;
    assert.equal(restarted.reconciling, true);
    assert.equal(restarted.attempts, 2);
    assert.notEqual(restarted.leaseToken, first.leaseToken);
    assert.equal(await finishEventOutbox(first.id, first.leaseToken!, "completed"), false);
    await db.insert(externalCalendars).values({
      id: linkIDs.get(home.id), provider: "google", userID: owner,
      accountID: "fixture-account", calendarID: home.id, externalCalendarID: "remote-calendar",
    });
    const accepted = { externalEventId: "lease-resource", etag: '"v1"', icalUid: "lease-uid" };
    const acknowledged = await completeEventOutbox(first.id, restarted.leaseToken!, accepted, null);
    assert.equal(acknowledged?.status, "completed");
    assert.deepEqual(acknowledged?.resultRef, accepted);
    const [mapped] = await db.select().from(externalEvents).where(eq(externalEvents.eventID, leased.id));
    assert.equal(mapped.externalEventID, accepted.externalEventId);
    assert.equal(mapped.etag, accepted.etag);

    // A queued successor advances through our own receipt, never a fresh remote ETag.
    const successor = intent(leased, "update", { externalEventID: null, expectedEtag: null });
    await patchEventAndCalendarLinks(leased.id, 1, { title: "Next" }, false, [successor]);
    const second = (await claimEventOutbox(successor.id!))!;
    assert.deepEqual(await getEventOutboxExpectedRef(second), accepted);
    assert.equal((await completeEventOutbox(second.id, second.leaseToken!, { ...accepted, etag: '"v2"' }, accepted))?.status, "completed");
    const [advanced] = await db.select().from(externalEvents).where(eq(externalEvents.eventID, leased.id));
    assert.equal(advanced.etag, '"v2"');
    assert.deepEqual(await getEventOutboxExpectedRef({ ...second, externalEventID: accepted.externalEventId, expectedEtag: '"new-inbound"' }), {
      externalEventId: accepted.externalEventId, etag: '"new-inbound"', icalUid: second.icalUid,
    }, "an old predecessor receipt cannot replace a newer accepted inbound baseline");

    // A provider mapping changed by another writer is not silently overwritten.
    const thirdIntent = intent(leased, "update", { externalEventID: accepted.externalEventId, expectedEtag: '"v2"' });
    await patchEventAndCalendarLinks(leased.id, 2, { title: "Third" }, false, [thirdIntent]);
    const third = (await claimEventOutbox(thirdIntent.id!))!;
    await db.update(externalEvents).set({ etag: '"remote-edit"' }).where(eq(externalEvents.id, advanced.id));
    assert.equal((await completeEventOutbox(third.id, third.leaseToken!, { ...accepted, etag: '"v3"' }, { ...accepted, etag: '"v2"' }))?.status, "conflict");
    const [preserved] = await db.select().from(externalEvents).where(eq(externalEvents.id, advanced.id));
    assert.equal(preserved.etag, '"remote-edit"');

    const delayed = value();
    const delayedIntent = intent(delayed);
    await createEvent(delayed, [home.id], [delayedIntent]);
    const delayedClaim = (await claimEventOutbox(delayedIntent.id!))!;
    let locked!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { locked = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.select().from(events).where(eq(events.id, delayed.id)).for("update");
      locked();
      await released;
    });
    await lockAcquired;
    const delayedAck = completeEventOutbox(delayedClaim.id, delayedClaim.leaseToken!, { externalEventId: "too-late" }, null);
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const result = await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity
          where wait_event_type = 'Lock' and query like '%"events"%for update%') as waiting`);
        waiting = result.rows[0].waiting;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(waiting, "ACK has started its transaction and is waiting on the event lock");
      await db.update(eventOutbox).set({ leaseUntil: sql`clock_timestamp() + interval '100 milliseconds'` }).where(eq(eventOutbox.id, delayedClaim.id));
      await new Promise((resolve) => setTimeout(resolve, 150));
    } finally { release(); }
    await holder;
    assert.equal(await delayedAck, undefined, "transaction start time cannot extend a lease while waiting for a lock");
    assert.deepEqual(await db.select().from(externalEvents).where(eq(externalEvents.eventID, delayed.id)), []);
    console.log(
      "K07 transactional outbox rollback, revision, unlink/delete retention, duplicate fork and single-attempt claim: OK",
    );
  } finally {
    await db.delete(user).where(eq(user.id, owner));
  }
  assert.deepEqual(
    await db.select().from(eventOutbox).where(eq(eventOutbox.userID, owner)),
    [],
    "account deletion purges private payloads",
  );
}
async function run() {
  if (process.argv[2] === "--commit-and-exit") {
    const input = JSON.parse(process.argv[3]);
    const event = EventSchema.parse(input.event);
    await createEvent(event, event.calendars, [input.intent]);
    process.exit(0); // Deliberately skip graceful cleanup and all delivery.
  }
  await main();
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
