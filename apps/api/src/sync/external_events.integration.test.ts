import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { setTimeout } from "node:timers/promises";
import type { Request, Response } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { logger } from "@musubi/config";
import {
  account,
  calendarEvents,
  caldavAccounts,
  calendarMembers,
  clearCalendarEvents,
  createEvent,
  db,
  deleteExternalEvent,
  events,
  externalCalendars,
  externalEvents,
  getEvent,
  getEventCalendars,
  getExternalLinkForCalendar,
  getUsersEvents,
  importExternalCalendar,
  importExternalEvent,
  linkEventToCalendars,
  reconcileMicrosoftCalendarAccess,
  sweepExternalEvents,
  upsertExternalEvent,
  unlinkEventAndTombstoneIfOrphaned,
  user,
} from "@musubi/db";
import { assertCanEditEvent, assertCanViewEvent } from "../permissions";
import { handlerStream } from "../handlers/stream";
import { getAdapter, syncProvider } from "./engine";
import type { CalendarAdapter, NormalizedChange } from "./adapter";

// Run only against a disposable, migrated test database. These fixtures use
// real query/permission paths; no provider credentials or network calls.
async function main() {
  if (process.env.ENVIRONMENT !== "test") {
    throw new Error("External event DB integration requires ENVIRONMENT=test");
  }
  const alice = `event-origin-${randomUUID()}`;
  const bob = `event-viewer-${randomUUID()}`;
  await db.insert(user).values(
    [alice, bob].map((id) => ({
      id,
      name: id,
      email: `${id}@example.test`,
    })),
  );

  try {
    for (const provider of ["google", "microsoft", "caldav"]) {
      // The same remote collection may be visible through multiple accounts.
      // Unlinking one mirror must not delete a sibling mirror's mapping.
      const remoteCalendar = `shared-${randomUUID()}`;
      const accountIDs = [randomUUID(), randomUUID(), randomUUID()];
      if (provider === "caldav") {
        // Engine mutations carry a read-generation fence which requires the
        // actual connected CalDAV account, even before first grant discovery.
        await db.insert(caldavAccounts).values(accountIDs.map((id, index) => ({
          id, userID: index === 1 ? bob : alice,
          serverUrl: "https://fixture.invalid", username: id,
          encryptedPassword: "unused-fixture",
        })));
      }
      if (provider === "microsoft") await db.insert(account).values(accountIDs.map((id, index) => ({
        id: randomUUID(), userId: index === 1 ? bob : alice, accountId: id,
        providerId: "microsoft", scope: "Calendars.ReadWrite", refreshToken: "fixture-only",
        accessToken: "fixture-only", accessTokenExpiresAt: new Date(Date.now() + 3600000),
      })));
      const home = await importExternalCalendar(
        provider,
        alice,
        accountIDs[0]!,
        "Origin",
        {
          externalId: remoteCalendar,
          name: "Origin",
          color: "#7A8BA3",
        },
      );
      const copy = await importExternalCalendar(
        provider,
        bob,
        accountIDs[1]!,
        "Copy",
        {
          externalId: remoteCalendar,
          name: "Copy",
          color: "#7A8BA3",
        },
      );
      const sibling = await importExternalCalendar(
        provider,
        alice,
        accountIDs[2]!,
        "Sibling",
        {
          externalId: remoteCalendar,
          name: "Sibling",
          color: "#7A8BA3",
        },
      );
      await db
        .insert(calendarMembers)
        .values({ userID: bob, calendarID: home.id, role: "viewer" });
      const fixture = {
        provider,
        alice,
        bob,
        remoteCalendar,
        home: home.id,
        copy: copy.id,
        sibling: sibling.id,
      };
      await checkUpdates(fixture);
      await checkDeletion(fixture, false);
      await checkDeletion(fixture, true);
      await checkConcurrentDeletion(fixture);
      await checkLocalUnlinkLockOrder(fixture);
      await checkUnlinkNotifications(fixture, false);
      await checkUnlinkNotifications(fixture, true);
      await checkUnlinkNotifications(fixture, false, true);
      await checkUnlinkNotifications(fixture, false, false, true);
      await checkMissingOrigin(fixture);
      await checkLegacyReset(fixture);
    }
    console.log("external event authority DB integration self-check: OK");
  } finally {
    await db.delete(user).where(inArray(user.id, [alice, bob]));
    await db.$client.end();
  }
}

type Fixture = {
  provider: string;
  alice: string;
  bob: string;
  remoteCalendar: string;
  home: string;
  copy: string;
  sibling: string;
};

function eventValues(title = "Origin meeting") {
  return {
    title,
    color: "#7A8BA3",
    start: new Date("2026-01-01T10:00:00Z"),
    end: new Date("2026-01-01T11:00:00Z"),
    isAllDay: false,
    description: null,
    location: null,
    organizer: "alice@example.test",
    recurrence: null,
    url: null,
  };
}

async function linkedEvent(f: Fixture) {
  const id = randomUUID();
  await createEvent({ id, creatorID: f.alice, ...eventValues() }, [f.home]);
  await assertCanViewEvent(f.bob, id);
  await assert.rejects(assertCanEditEvent(f.bob, id), /permission/);
  // Same local path used after handlerLinkEvent authorizes the target calendar.
  await linkEventToCalendars(id, [f.copy, f.sibling]);
  for (const calendarID of [f.home, f.copy, f.sibling]) {
    await importExternalEvent(
      f.provider,
      id,
      calendarID,
      f.remoteCalendar,
      id,
      '"v1"',
      id,
    );
  }
  return id;
}

function pull(
  f: Fixture,
  id: string,
  calendarID: string,
  title: string,
  etag: string | null = '"v2"',
) {
  return upsertExternalEvent(
    f.provider,
    calendarID === f.copy ? f.bob : f.alice,
    calendarID,
    f.remoteCalendar,
    id,
    eventValues(title),
    etag,
    id,
  );
}

async function checkUpdates(f: Fixture) {
  const id = await linkedEvent(f);
  const before = await getEvent(id);
  const warn = logger.warn;
  const warnings: string[] = [];
  try {
    logger.warn = (message) => {
      warnings.push(message);
    };
    assert.equal(
      await upsertExternalEvent(
        f.provider,
        f.bob,
        f.copy,
        f.remoteCalendar,
        id,
        { ...eventValues(), color: "#C8553D" },
        null,
        id,
      ),
      false,
    );
    assert.deepEqual(
      warnings,
      [],
      "A different mirror color is not a content conflict, even without ETags",
    );
  } finally {
    logger.warn = warn;
  }
  assert.equal(
    await pull(f, id, f.copy, "Viewer changed the title"),
    false,
    `${f.provider}: a derived copy cannot update shared content`,
  );
  assert.deepEqual(
    await getEvent(id),
    before,
    "Rejected updates must not even touch the origin timestamp",
  );
  assert.equal(
    await pull(f, id, f.copy, "Unversioned provider update", null),
    false,
  );
  assert.deepEqual(await getEvent(id), before);
  const [copyMapping] = await db
    .select()
    .from(externalEvents)
    .where(
      and(
        eq(externalEvents.eventID, id),
        eq(externalEvents.calendarID, f.copy),
      ),
    );
  assert.equal(
    copyMapping?.etag,
    '"v1"',
    "Rejected content must not advance its write precondition",
  );
  assert.equal(
    await pull(f, id, f.sibling, "Another account's copy"),
    false,
    "Authority belongs to the origin mapping, not to account ownership",
  );
  assert.equal(await pull(f, id, f.home, "Authoritative update"), true);
  assert.equal((await getEvent(id))?.title, "Authoritative update");
  assert.equal(
    await pull(f, id, f.home, "Must not overwrite", '"v2"'),
    false,
    "ETag no-op preserved",
  );

  // A deleted origin must not be revived by a surviving external copy.
  assert.equal(await deleteExternalEvent(f.provider, f.home, id), true);
  const tombstone = await getEvent(id);
  assert.equal(await pull(f, id, f.copy, "Resurrection", '"v3"'), false);
  assert.deepEqual(await getEvent(id), tombstone);
  assert.equal(await pull(f, id, f.home, "Restored by origin", '"v3"'), true);
  assert.equal(
    (await getEvent(id))?.deletedAt,
    null,
    "Authoritative revival preserves the same ID",
  );

  // An independent fork's own mapping remains authoritative.
  const fork = randomUUID();
  await createEvent({ id: fork, creatorID: f.bob, ...eventValues() }, [f.copy]);
  await importExternalEvent(
    f.provider,
    fork,
    f.copy,
    f.remoteCalendar,
    fork,
    '"v1"',
    fork,
  );
  assert.equal(await pull(f, fork, f.copy, "Independent fork edit"), true);
  assert.equal((await getEvent(id))?.title, "Restored by origin");
}

async function checkDeletion(f: Fixture, sweep: boolean) {
  const id = await linkedEvent(f);
  const before = await getEvent(id);
  const remove = async (calendarID: string) => {
    if (!sweep)
      return Number(await deleteExternalEvent(f.provider, calendarID, id));
    const mappings = await db
      .select({ externalID: externalEvents.externalEventID })
      .from(externalEvents)
      .where(
        and(
          eq(externalEvents.provider, f.provider),
          eq(externalEvents.calendarID, calendarID),
        ),
      );
    return sweepExternalEvents(
      f.provider,
      calendarID,
      mappings.map((row) => row.externalID).filter((value) => value !== id),
    );
  };
  assert.equal(await remove(f.copy), 1);
  const after = await getEvent(id);
  assert.deepEqual(
    { ...after, updatedAt: before?.updatedAt, revision: before?.revision },
    before,
    "Deleting a derived copy changes links, not shared content or deletedAt",
  );
  assert.equal(
    after.revision,
    before.revision + 1,
    "Membership changes invalidate stale event drafts",
  );
  assert.deepEqual(
    (await getEventCalendars(id)).sort(),
    [f.home, f.sibling].sort(),
  );
  const mappings = await db
    .select({ calendarID: externalEvents.calendarID })
    .from(externalEvents)
    .where(eq(externalEvents.eventID, id));
  assert.deepEqual(
    mappings.map((row) => row.calendarID).sort(),
    [f.home, f.sibling].sort(),
    "Equal remote collection IDs must not broaden mapping deletion",
  );
  assert.equal(await remove(f.copy), 0, "Derived deletion is idempotent");
  assert.equal(
    await deleteExternalEvent("unrelated-provider", f.home, id),
    false,
  );
  assert.equal(await remove(f.home), 1);
  assert.ok(
    (await getEvent(id))?.deletedAt,
    "Deleting the authoritative mapping tombstones all linked views",
  );
  assert.equal(await remove(f.home), 0, "Authoritative deletion is idempotent");
}

async function checkConcurrentDeletion(f: Fixture) {
  const id = await linkedEvent(f);
  const results = await Promise.all([
    deleteExternalEvent(f.provider, f.copy, id),
    deleteExternalEvent(f.provider, f.copy, id),
  ]);
  assert.deepEqual(
    results.sort(),
    [false, true],
    "Concurrent deletion acknowledges the unlink only once",
  );
  assert.equal((await getEvent(id))?.deletedAt, null);
}

async function checkLocalUnlinkLockOrder(f: Fixture) {
  const id = await linkedEvent(f);
  const holder = await db.$client.connect();
  const probe = await db.$client.connect();
  let unlink: ReturnType<typeof unlinkEventAndTombstoneIfOrphaned> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM events WHERE id = $1 FOR UPDATE", [id]);
    const {
      rows: [{ pid }],
    } = await holder.query("SELECT pg_backend_pid() AS pid");
    unlink = unlinkEventAndTombstoneIfOrphaned(id, [f.copy]);
    // Wait until the local transaction is blocked by the event-first holder,
    // not a guessed sleep that might miss the inversion under CI load.
    let blocked = false;
    for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
      const { rows } = await probe.query(
        "SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))",
        [pid],
      );
      blocked = rows.length > 0;
      if (!blocked) await setTimeout(10);
    }
    assert.ok(blocked, "Local unlink must wait for the event row");
    await probe.query("BEGIN");
    // If the waiting transaction already holds the link, an inbound delete
    // holding the event would deadlock here. NOWAIT makes that a regression.
    await probe.query(
      "SELECT id FROM calendar_events WHERE event_id = $1 AND calendar_id = $2 FOR UPDATE NOWAIT",
      [id, f.copy],
    );
  } finally {
    await probe.query("ROLLBACK");
    probe.release();
    await holder.query("ROLLBACK");
    holder.release();
    await unlink;
  }
  assert.equal((await getEvent(id))?.deletedAt, null);
}

class StreamResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writes: string[] = [];
  setHeader() {}
  flushHeaders() {}
  write(value: string) {
    this.writes.push(value);
    return true;
  }
  end() {
    this.writableEnded = true;
    this.emit("close");
  }
}

async function checkUnlinkNotifications(
  f: Fixture,
  reset: boolean,
  failAfterUnlink = false,
  relinkDuringNotification = false,
) {
  const viewer = `copy-only-${randomUUID()}`;
  const responses: StreamResponse[] = [];
  await db
    .insert(user)
    .values({ id: viewer, name: viewer, email: `${viewer}@example.test` });
  try {
    await db
      .insert(calendarMembers)
      .values({ userID: viewer, calendarID: f.copy, role: "viewer" });
    const id = await linkedEvent(f);
    for (const userID of [viewer, f.bob]) {
      const req = Object.assign(new EventEmitter(), {
        user: { id: userID, isExternal: true },
      });
      const res = new StreamResponse();
      responses.push(res);
      await handlerStream(
        req as unknown as Request,
        res as unknown as Response,
      );
    }
    const link = await getExternalLinkForCalendar(f.copy);
    assert.ok(link);
    const adapter = getAdapter(f.provider);
    assert.ok(adapter);
    const graph = f.provider === "microsoft";
    if (graph) await reconcileMicrosoftCalendarAccess(f.bob, link.accountID, f.copy, { canEdit: true, canViewPrivateItems: true });
    const [sourceBeforeRead] = await db.select().from(externalCalendars).where(eq(externalCalendars.calendarID, f.copy));
    const eventBeforeRead = await getEvent(id);
    const mappingsBeforeRead = await db.select().from(externalEvents).where(eq(externalEvents.eventID, id));
    const unlinkRevision = (await getEvent(id))!.revision + 1;
    const query = db.$client.query.bind(db.$client);
    let relinked = false;
    if (relinkDuringNotification) (db.$client as any).query = async (config: any, ...args: any[]) => {
      const text = typeof config === "string" ? config : config.text;
      const result = await (query as any)(config, ...args);
      if (!relinked && text.includes('from "calendar_members"') && args[0]?.includes(f.home)) {
        const links = await query('select 1 from calendar_events where event_id = $1 and calendar_id = $2', [id, f.copy]);
        if (!links.rowCount) {
          relinked = true;
          // The membership result above describes the old audience, not this relink.
          await linkEventToCalendars(id, [f.copy]);
        }
      }
      return result;
    };
    const changes: NormalizedChange[] = reset ? [] : [graph ? {
      // This engine/DB fixture supplies already verified adapter evidence.
      // Real Graph HTTP proof is exercised by graph_read_coverage.integration.
      kind: "event-absence", externalId: id, reason: "window-removal",
      deletionEvidence: { kind: "scoped-native-absence", responseStatus: 404,
        readAuthorityVerified: true, nativeReadProfile: "graph-event-double-404-calendar-v1" },
    } : { kind: "event", data: { ...eventValues(), externalId: id, status: "cancelled" } },
      ...(failAfterUnlink ? [{ kind: "event" as const, data: {
        ...eventValues(), externalId: randomUUID(), status: "active" as const, start: new Date(NaN),
      } }] : []),
    ];
    const simulatedAdapter: CalendarAdapter = {
        ...adapter,
        listCalendars: async () => ({
          taskListsComplete: true,
          calendars: [
            { externalId: f.remoteCalendar, name: "Copy", color: "#7A8BA3",
              ...(graph ? { microsoftAccess: { canEdit: true, canViewPrivateItems: true } } : {}) },
          ],
        }),
        fetchChanges: async () => ({
          changes,
          reset: graph ? false : reset,
          nextCursor: graph ? JSON.stringify({ version: 2, calendarId: f.remoteCalendar,
            link: `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(f.remoteCalendar)}/calendarView/delta?$deltatoken=${id}`,
            windowStart: Date.parse("2025-01-01T00:00:00Z"), windowEnd: Date.parse("2030-01-01T00:00:00Z"),
          }) : `after-${id}`,
          ...(graph ? { coverage: { kind: "window" as const, fromInclusive: "2025-01-01T00:00:00Z", untilExclusive: "2030-01-01T00:00:00Z", complete: true } } : {}),
        }),
    };
    const sync = syncProvider(simulatedAdapter, f.bob, { id: link.accountID, label: "Copy" });
    try {
      if (failAfterUnlink) await assert.rejects(sync);
      else await sync;
    } finally { db.$client.query = query; }
    if (graph && (reset || failAfterUnlink)) {
      assert.deepEqual(await getEvent(id), eventBeforeRead, "Empty Graph coverage or a later failed item preserves the canonical revision");
      assert.deepEqual(await db.select().from(externalEvents).where(eq(externalEvents.eventID, id)), mappingsBeforeRead, "Graph absence/rollback keeps all source-copy binding identities");
      const [sourceAfterRead] = await db.select().from(externalCalendars).where(eq(externalCalendars.calendarID, f.copy));
      if (failAfterUnlink) {
        for (const key of ["cursor", "readCoverage", "sourceGeneration", "checkpointRevision"] as const)
          assert.deepEqual(sourceAfterRead[key], sourceBeforeRead![key], "A failed Graph batch cannot publish its checkpoint or coverage");
      } else {
        assert.equal(sourceAfterRead.checkpointRevision, sourceBeforeRead!.checkpointRevision + 1, "Completed empty Graph coverage advances only its checkpoint");
      }
      assert.ok(responses.every(response => !response.writes.some(frame => frame.includes('"type":"event_removed"'))), "No unlink SSE may escape empty coverage or a rolled-back Graph batch");
      assert.ok((await getUsersEvents(viewer)).some(row => row.event.id === id));
      assert.ok((await getEventCalendars(id)).includes(f.copy));
      return;
    }
    if (relinkDuringNotification) {
      assert.equal(relinked, true);
      assert.equal((await getEvent(id))!.revision, unlinkRevision + 1);
    }
    assert.equal((await getEvent(id))?.deletedAt, null);
    const removal = `data: ${JSON.stringify({ type: "event_removed", payload: { id, revision: unlinkRevision } })}\n\n`;
    assert.ok(
      responses[0].writes.includes(removal),
      "Copy-only viewer must evict the event via the existing SSE frame",
    );
    assert.ok(
      !responses[1].writes.includes(removal),
      "Do not remove an event from a viewer who retains origin access",
    );
    assert.ok(
      (await getUsersEvents(viewer)).some((row) => row.event.id === id) === relinkDuringNotification,
      "Full catch-up no longer includes the removed copy",
    );
    assert.ok(
      (await getUsersEvents(f.bob)).some((row) => row.event.id === id),
      "Remaining access retains the event",
    );
  } finally {
    for (const response of responses) response.end();
    await db.delete(user).where(eq(user.id, viewer));
  }
}

async function checkMissingOrigin(f: Fixture) {
  const id = await linkedEvent(f);
  await db
    .update(events)
    .set({ originCalendarID: null })
    .where(eq(events.id, id));
  const before = await getEvent(id);
  assert.equal(await pull(f, id, f.home, "Unknown authority"), false);
  assert.deepEqual(
    await getEvent(id),
    before,
    "Legacy origin cannot be inferred from the sync caller",
  );
  assert.equal(await deleteExternalEvent(f.provider, f.copy, id), true);
  assert.equal((await getEvent(id))?.deletedAt, null);
  // Even the final non-authoritative unlink must not tombstone an unknown origin.
  await deleteExternalEvent(f.provider, f.home, id);
  await sweepExternalEvents(
    f.provider,
    f.sibling,
    (
      await db
        .select({ id: externalEvents.externalEventID })
        .from(externalEvents)
        .where(eq(externalEvents.calendarID, f.sibling))
    )
      .map((row) => row.id)
      .filter((value) => value !== id),
  );
  assert.equal((await getEvent(id))?.deletedAt, null);
  assert.equal((await getEventCalendars(id)).length, 0);
}

async function checkLegacyReset(f: Fixture) {
  const id = await linkedEvent(f);
  await clearCalendarEvents(f.copy);
  assert.equal(
    (await getEvent(id))?.deletedAt,
    null,
    "Legacy reset helper cannot tombstone a linked origin",
  );
  await clearCalendarEvents(f.home);
  assert.ok((await getEvent(id))?.deletedAt);
  assert.equal(
    (
      await db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.eventID, id))
    ).length,
    3,
    "Authoritative tombstones keep their links for client deltas",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
