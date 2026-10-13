import { prepareEventWrites } from "./engine";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mock } from "node:test";
import { eq } from "drizzle-orm";
import { EventSchema, EventWriteError, type Event } from "@musubi/types";
import {
  db,
  user,
  eventOutbox,
  externalCalendars,
  externalEvents,
  createCalendar,
  createEvent,
  patchEventAndCalendarLinks,
  getEvent,
  upsertExternalEvent,
  deleteExternalEvent,
  removeCalendar,
  requestEventDeliveryRetry,
  type EventOutboxIntent,
} from "@musubi/db";
import { googleAdapter } from "./adapters/google";
import type { CalendarAdapter, CreatedEventEvidence } from "./adapter";
import { deliverEventOutbox } from "./event_delivery";
import { googleEventCreateID } from "./event_create_identity";
import { ProviderEventWriteError, providerRetryAfterMs } from "./event_write";
import { ProviderAuthError } from "./errors";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const owner = `worker-${randomUUID()}`;
  await db
    .insert(user)
    .values({ id: owner, name: owner, email: `${owner}@example.test` });
  let mode: "normal" | "timeout" | "lost" | "429" | "403" | "reconnect" =
    "normal";
  let calls = 0;
  let writeGate: (() => Promise<void>) | undefined;
  let version = 0;
  const remote = new Map<string, CreatedEventEvidence>();
  const evidence = (id: string, event: Event): CreatedEventEvidence => ({
    ref: { externalEventId: id, etag: `"v${++version}"` },
    event: {
      externalId: id,
      status: "active",
      title: event.title,
      start: event.start,
      end: event.end,
      isAllDay: event.isAllDay,
      description: event.description ?? null,
      location: event.location ?? null,
      recurrence: event.recurrence ?? null,
      organizer: null,
      url: null,
    },
  });
  const afterWrite = async (signal?: AbortSignal) => {
    await writeGate?.();
    if (mode === "lost")
      throw new ProviderEventWriteError("provider-write-failed", "unconfirmed");
    if (mode === "timeout")
      await new Promise<never>((_, reject) => {
        if (signal?.aborted) reject(new Error("aborted"));
        else
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
      });
  };
  const adapter: CalendarAdapter = {
    ...googleAdapter,
    // This fixture supplies a pinned transport itself; it does not register native HTTP ports.
    googlePersonalContentV1: undefined,
    async assertEventWrite() {
      if (mode === "403") throw new EventWriteError("event-write", "denied");
      if (mode === "reconnect")
        throw new ProviderAuthError("google", "invalid_grant", undefined, true);
    },
    async pushCreate(_u, _a, _c, event, identity) {
      calls++;
      if (mode === "429")
        throw new ProviderEventWriteError(
          "provider-write-failed",
          "not-written",
          429,
          60_000,
        );
      const id = googleEventCreateID(identity!);
      if (remote.has(id))
        throw new ProviderEventWriteError("provider-conflict");
      const result = evidence(id, event);
      remote.set(id, result);
      await afterWrite(identity?.signal);
      return result.ref;
    },
    async findCreatedEvent(_u, _a, _c, identity) {
      return remote.get(googleEventCreateID(identity)) ?? null;
    },
    async readEvent(_u, _a, _c, ref) {
      return remote.get(ref.externalEventId) ?? null;
    },
    async pushUpdate(_u, _a, _c, id, event, ref, _patch, signal) {
      calls++;
      if (remote.get(id)?.ref.etag !== ref?.etag)
        throw new ProviderEventWriteError(
          "provider-conflict",
          "not-written",
          412,
        );
      const result = evidence(id, event);
      remote.set(id, result);
      await afterWrite(signal);
      return result.ref;
    },
    async pushDelete(_u, _a, _c, id, ref, signal) {
      calls++;
      if (remote.has(id) && remote.get(id)?.ref.etag !== ref?.etag)
        throw new ProviderEventWriteError(
          "provider-conflict",
          "not-written",
          412,
        );
      remote.delete(id);
      await afterWrite(signal);
    },
  };
  const deliver = (id: string, timeoutMs?: number) =>
    deliverEventOutbox(id, () => adapter, { timeoutMs });
  const due = (id: string) =>
    db
      .update(eventOutbox)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(eventOutbox.id, id));
  const jobs = (id: string) =>
    db.select().from(eventOutbox).where(eq(eventOutbox.eventID, id));
  try {
    const calendar = await createCalendar({
      creatorID: owner,
      name: "Worker",
      color: "#112233",
    });
    const [link] = await db
      .insert(externalCalendars)
      .values({
        provider: "google",
        userID: owner,
        accountID: owner,
        calendarID: calendar.id,
        externalCalendarID: "remote",
      })
      .returning();
    const value = () =>
      EventSchema.parse({
        id: randomUUID(),
        creatorID: owner,
        organizer: owner,
        title: "Original",
        color: "#112233",
        start: "2026-01-01T09:00:00Z",
        end: "2026-01-01T10:00:00Z",
        isAllDay: false,
        isCanceled: false,
        originCalendarID: calendar.id,
        calendars: [calendar.id],
      });
    const intent = (
      event: Event,
      action: EventOutboxIntent["action"] = "create",
      extra: Partial<EventOutboxIntent> = {},
    ): EventOutboxIntent => ({
      id: randomUUID(),
      actorID: owner,
      mutationID: randomUUID(),
      position: 0,
      eventID: event.id,
      calendarID: calendar.id,
      externalCalendarLinkID: link.id,
      provider: "google",
      userID: owner,
      accountID: owner,
      externalCalendarID: "remote",
      action,
      payload: { event, createIdentityVersion: 1 },
      ...extra,
    });
    const enqueue = async () => {
      const event = value();
      const job = intent(event);
      await createEvent(event, event.calendars, [job]);
      return { event, id: job.id! };
    };

    const known = { ...value(), timeModel: { kind: "zoned" as const, timeZone: "UTC", startLocal: "2026-01-01T09:00:00.000", endLocal: "2026-01-01T10:00:00.000" } };
    await assert.rejects(() => prepareEventWrites([{ event: known, calendarIDs: known.calendars, action: "create" }]), /time-model-aware provider write/);
    const knownJob = intent(known);
    await createEvent(known, known.calendars, [knownJob]);
    const callsBeforeKnown = calls;
    assert.equal((await deliver(knownJob.id!))?.status, "blocked");
    assert.equal(calls, callsBeforeKnown, "a durable known-model snapshot must never reach a legacy provider serializer");
    assert.equal(remote.size, 0);

    const timeout = await enqueue();
    mode = "timeout";
    // Expire the real worker deadline only after the fake provider committed.
    // A 30ms wall-clock race could expire in DB preflight on a loaded runner,
    // correctly producing retry instead of exercising ambiguous delivery.
    const deadlineMs = 123_456;
    const realSetTimeout = globalThis.setTimeout;
    let expireDeadline: (() => void) | undefined;
    const timer = mock.method(
      globalThis,
      "setTimeout",
      (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
        if (delay === deadlineMs) {
          expireDeadline = () => callback(...args);
          // A genuine guard still fails a worker that never reaches the write.
          return realSetTimeout(callback, 20_000, ...args);
        }
        return realSetTimeout(callback, delay, ...args);
      },
    );
    writeGate = async () => {
      assert.ok(expireDeadline, "worker deadline must be armed before writing");
      expireDeadline();
    };
    try {
      assert.equal(
        (await deliver(timeout.id, deadlineMs))?.status,
        "unconfirmed",
      );
      assert.ok(
        remote.size > 0,
        "the timeout follows a committed remote write",
      );
    } finally {
      writeGate = undefined;
      timer.mock.restore();
    }
    const afterTimeout = calls;
    mode = "normal";
    await requestEventDeliveryRetry(owner, timeout.event.id, timeout.id);
    await due(timeout.id);
    assert.equal((await deliver(timeout.id))?.status, "completed");
    assert.equal(
      calls,
      afterTimeout,
      "timeout after commit recovers without create replay",
    );

    const throttled = await enqueue();
    mode = "429";
    const retry = await deliver(throttled.id);
    assert.equal(retry?.status, "retry");
    assert.equal(retry?.uncertain, false);
    assert.ok(retry!.nextAttemptAt.getTime() >= Date.now() + 59_000);
    const after429 = calls;
    await requestEventDeliveryRetry(owner, throttled.event.id, throttled.id);
    assert.equal(
      (await jobs(throttled.event.id))[0].nextAttemptAt.getTime(),
      retry!.nextAttemptAt.getTime(),
    );
    await deliver(throttled.id);
    assert.equal(
      calls,
      after429,
      "Retry-After must postpone even an explicit delivery tick",
    );
    mode = "normal";
    await due(throttled.id);
    assert.equal((await deliver(throttled.id))?.status, "completed");
    assert.equal(
      providerRetryAfterMs(
        new Response(null, { headers: { "retry-after": "60" } }),
      ),
      60_000,
    );

    const denied = await enqueue();
    mode = "403";
    const before403 = calls;
    const permissionFailure = await deliver(denied.id);
    assert.equal(permissionFailure?.status, "blocked");
    assert.equal(permissionFailure?.errorCode, "provider-write-denied");
    mode = "normal";
    await deliver(denied.id);
    assert.equal(
      calls,
      before403,
      "blocked permission is not an automatic retry",
    );
    await requestEventDeliveryRetry(owner, denied.event.id, denied.id);
    await due(denied.id);
    mode = "403";
    assert.equal((await deliver(denied.id))?.status, "blocked");
    assert.equal(
      calls,
      before403,
      "retry must recheck a permission which is still denied",
    );
    mode = "normal";
    await requestEventDeliveryRetry(owner, denied.event.id, denied.id);
    await due(denied.id);
    assert.equal((await deliver(denied.id))?.status, "completed");
    assert.equal(
      calls,
      before403 + 1,
      "explicit retry rechecks permission and writes once after it is restored",
    );
    const reconnect = await enqueue();
    mode = "reconnect";
    assert.equal(
      (await deliver(reconnect.id))?.errorCode,
      "provider-reconnect-required",
    );
    mode = "normal";

    const queued = await enqueue();
    const update = intent(queued.event, "update", {
      payload: { event: queued.event, patch: { title: "Next" } },
    });
    await patchEventAndCalendarLinks(
      queued.event.id,
      1,
      { title: "Next" },
      false,
      [update],
    );
    const deletion = intent(queued.event, "delete");
    await patchEventAndCalendarLinks(
      queued.event.id,
      2,
      { calendars: [] },
      true,
      [deletion],
    );
    assert.equal((await deliver(update.id!))?.status, "pending");
    assert.equal((await deliver(queued.id))?.status, "completed");
    assert.equal((await deliver(update.id!))?.status, "completed");
    assert.equal((await deliver(deletion.id!))?.status, "completed");
    assert.equal(
      remote.has(googleEventCreateID({ operationID: queued.id })),
      false,
    );
    assert.deepEqual(
      await db
        .select()
        .from(externalEvents)
        .where(eq(externalEvents.eventID, queued.event.id)),
      [],
    );
    assert.ok((await getEvent(queued.event.id)).deletedAt);

    const edited = await enqueue();
    await deliver(edited.id);
    const [mapped] = await db
      .select()
      .from(externalEvents)
      .where(eq(externalEvents.eventID, edited.event.id));
    const edit = intent(edited.event, "update", {
      externalEventID: mapped.externalEventID,
      expectedEtag: mapped.etag,
      payload: { event: edited.event, patch: { title: "Local edit" } },
    });
    await patchEventAndCalendarLinks(
      edited.event.id,
      1,
      { title: "Local edit" },
      false,
      [edit],
    );
    mode = "lost";
    assert.equal((await deliver(edit.id!))?.status, "unconfirmed");
    mode = "normal";
    const afterLost = calls;
    await due(edit.id!);
    assert.equal((await deliver(edit.id!))?.status, "completed");
    assert.equal(
      calls,
      afterLost,
      "ambiguous PATCH reconciles content without another PATCH",
    );

    const conflict = intent(edited.event, "update", {
      externalEventID: mapped.externalEventID,
      expectedEtag: remote.get(mapped.externalEventID)!.ref.etag,
      payload: { event: edited.event, patch: { title: "Newest local" } },
    });
    await patchEventAndCalendarLinks(
      edited.event.id,
      2,
      { title: "Newest local" },
      false,
      [conflict],
    );
    const observation = {
      ...remote.get(mapped.externalEventID)!.event,
      title: "Remote concurrent",
      color: "#112233",
      organizer: "",
    };
    await upsertExternalEvent(
      "google",
      owner,
      calendar.id,
      "remote",
      mapped.externalEventID,
      observation,
      '"remote-change"',
    );
    assert.equal((await getEvent(edited.event.id)).title, "Newest local");
    const retained = (await jobs(edited.event.id)).find(
      (row) => row.id === conflict.id,
    )!;
    assert.equal(retained.status, "conflict");
    assert.equal(retained.remoteSnapshot?.values?.title, "Remote concurrent");

    const derived = await createCalendar({
      creatorID: owner,
      name: "Derived",
      color: "#112233",
    });
    const [derivedLink] = await db
      .insert(externalCalendars)
      .values({
        provider: "google",
        userID: owner,
        accountID: owner,
        calendarID: derived.id,
        externalCalendarID: "derived",
      })
      .returning();
    const shared = { ...value(), calendars: [calendar.id, derived.id] };
    const originalCreate = intent(shared);
    const derivedCreate = intent(shared, "create", {
      calendarID: derived.id,
      externalCalendarLinkID: derivedLink.id,
      externalCalendarID: "derived",
      mutationID: originalCreate.mutationID,
      position: 1,
    });
    await createEvent(shared, shared.calendars, [
      originalCreate,
      derivedCreate,
    ]);
    await deliver(originalCreate.id!);
    await deliver(derivedCreate.id!);
    const originID = googleEventCreateID({ operationID: originalCreate.id! });
    const authoritative = {
      ...remote.get(originID)!.event,
      title: "Authoritative inbound",
      color: "#112233",
      organizer: "",
    };
    assert.equal(
      await upsertExternalEvent(
        "google",
        owner,
        calendar.id,
        "remote",
        originID,
        authoritative,
        '"source-new"',
      ),
      true,
    );
    const fanout = (await jobs(shared.id)).filter((row) => row.revision === 2);
    assert.equal(fanout.length, 1);
    assert.equal(
      fanout[0].calendarID,
      derived.id,
      "authoritative inbound never enqueues an origin echo",
    );
    assert.equal((await deliver(fanout[0].id))?.status, "completed");
    assert.equal(
      remote.get(googleEventCreateID({ operationID: derivedCreate.id! }))?.event
        .title,
      authoritative.title,
    );
    assert.equal(
      await deleteExternalEvent("google", calendar.id, originID),
      true,
    );
    const fanoutDelete = (await jobs(shared.id)).find(
      (row) => row.revision === 3,
    )!;
    assert.equal(fanoutDelete.action, "delete");
    assert.equal(fanoutDelete.calendarID, derived.id);
    assert.equal((await deliver(fanoutDelete.id))?.status, "completed");
    assert.equal(
      await upsertExternalEvent(
        "google",
        owner,
        calendar.id,
        "remote",
        originID,
        { ...authoritative, title: "Revived origin" },
        '"source-revived"',
      ),
      true,
    );
    const revival = (await jobs(shared.id)).find((row) => row.revision === 4)!;
    assert.equal(
      revival.action,
      "create",
      "revival needs a new remote resource after completed delete",
    );
    assert.equal((await deliver(revival.id))?.status, "completed");
    const revivedMaps = await db
      .select()
      .from(externalEvents)
      .where(eq(externalEvents.eventID, shared.id));
    const newDerivedID = googleEventCreateID({ operationID: revival.id });
    assert.ok(remote.has(newDerivedID));
    assert.ok(
      revivedMaps.some(
        (mapping) =>
          mapping.externalEventID === newDerivedID &&
          mapping.calendarID === derived.id,
      ),
    );
    assert.notEqual(
      newDerivedID,
      googleEventCreateID({ operationID: derivedCreate.id! }),
    );

    for (const provider of ["google", "microsoft"]) {
      const destination = await createCalendar({
        creatorID: owner,
        name: "Delete before ACK",
        color: "#112233",
      });
      const [destinationLink] = await db
        .insert(externalCalendars)
        .values({
          provider,
          userID: owner,
          accountID: owner,
          calendarID: destination.id,
          externalCalendarID: destination.id,
        })
        .returning();
      const pendingValue = {
        ...value(),
        originCalendarID: destination.id,
        calendars: [destination.id],
      };
      const pending = intent(pendingValue, "create", {
        provider,
        calendarID: destination.id,
        externalCalendarLinkID: destinationLink.id,
        externalCalendarID: destination.id,
      });
      await createEvent(pendingValue, pendingValue.calendars, [pending]);
      let reached!: () => void;
      const committed = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let resume!: () => void;
      const resumed = new Promise<void>((resolve) => {
        resume = resolve;
      });
      writeGate = async () => {
        reached();
        await resumed;
      };
      const remoteID =
        provider === "google"
          ? googleEventCreateID({ operationID: pending.id! })
          : `opaque-${randomUUID()}`;
      const currentAdapter =
        provider === "google"
          ? adapter
          : {
              ...adapter,
              provider,
              async pushCreate(
                _u: string,
                _a: string,
                _c: string,
                event: Event,
              ) {
                const result = evidence(remoteID, event);
                remote.set(remoteID, result);
                await afterWrite();
                return result.ref;
              },
            };
      const pendingDelivery = deliverEventOutbox(
        pending.id!,
        () => currentAdapter,
      );
      await committed;
      try {
        remote.delete(remoteID);
        await deleteExternalEvent(provider, destination.id, remoteID);
      } finally {
        resume();
        writeGate = undefined;
      }
      const result = await pendingDelivery;
      assert.equal(
        result?.status,
        "conflict",
        `${provider}: a delete delta before create ACK cannot be dropped`,
      );
      assert.equal(result?.remoteSnapshot?.deleted, true);
      assert.deepEqual(
        await db
          .select()
          .from(externalEvents)
          .where(eq(externalEvents.eventID, pendingValue.id)),
        [],
      );
    }

    const disconnected = await enqueue();
    await removeCalendar(calendar.id);
    const beforeDisconnect = calls;
    assert.equal((await deliver(disconnected.id))?.status, "cancelled");
    assert.equal(calls, beforeDisconnect);
    console.log(
      "K08 worker timeout recovery, Retry-After, permission block, ordered create/update/delete, retained pull conflict and disconnect: OK",
    );
  } finally {
    await db.delete(user).where(eq(user.id, owner));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
