import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  account, CALENDAR_SCOPE, TASK_SCOPE, db, user, calendars, calendarMembers,
  events, externalEvents, calendarEvents, eventOutbox, externalEventTombstones,
  tasks, externalTasks, calendarTasks, taskOutbox, externalCalendars,
  getEventSnapshot, getUserExternalCalendars, importExternalCalendar,
  reconcileMicrosoftCalendarAccess, upsertExternalEvent,
} from "@musubi/db";
import { EventSchema, TaskSchema } from "@musubi/types";
import { logger } from "@musubi/config";
import { microsoftAdapter, microsoftTaskListExternalId } from "./adapters/microsoft";
import { syncProvider, syncUser } from "./engine";
import { metricsRegistry } from "../metrics";
import { handlerStream } from "../handlers/stream";
import type { CalendarDiscoveryResult } from "./adapter";
import { GraphTaskListDiscoveryHttpError } from "./adapters/microsoft_task_list_discovery_error";
import { GraphCalendarDiscoveryHttpError, isMicrosoftEventMailboxUnavailable } from "./adapters/microsoft_calendar_discovery_error";

const graph = "https://graph.microsoft.com/v1.0";
const label = "Resource isolation fixture";
type Mode = "mailbox" | "inner-mailbox" | "unsupported-mailbox" | "no-scope" | "unknown404" | "bare404"
  | "late404" | "event-invalid" | "event-partial" | "event-late-invalid" | "event-reserved-late"
  | "tasks-invalid" | "tasks-late-invalid" | "tasks403" | "tasks401" | "tasks404" | "tasks-late404" | "tasks-empty"
  | "fetch401" | "fetch403" | "healthy" | "recovered" | "invalid-contract" | "missing-failure-contract";

async function scenario(mode: Mode) {
  const owner = `resource-isolation-${randomUUID()}`, sourceReader = `source-${randomUUID()}`, linkedReader = `linked-${randomUUID()}`;
  const accountID = randomUUID(), connectionID = randomUUID();
  const taskCalendarID = randomUUID(), linkedCalendarID = randomUUID();
  const taskExternalID = microsoftTaskListExternalId("tasks");
  const taskTerminal = `${graph}/me/todo/lists/tasks/tasks/delta?fixture=accepted`;
  let taskListCalls = 0, taskReadCalls = 0, eventPullCalls = 0;
  let recovered = false;
  let fixtureFailure: unknown;
  const calls: string[] = [];
  const fixture = createServer((req, res) => {
    try {
      assert.equal(req.method, "GET", "No provider mutations are permitted");
      assert.equal(req.headers.authorization, "Bearer fixture-resource-access");
      const url = new URL(req.url!, "http://fixture.test");
      calls.push(url.pathname);
      const json = (body: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body));
      };
      if (url.pathname === "/v1.0/me") return json({ id: "fixture-user", mail: label });
      if (url.pathname === "/v1.0/me/calendars") {
        if (mode === "event-reserved-late") return json(url.searchParams.has("second")
          ? { value: [{ id: taskExternalID, name: "Must not retag existing Tasks as Events", canEdit: true, canViewPrivateItems: false }] }
          : { value: [{ id: "unrelated-calendar", name: "Would remove retained event mirror", canEdit: true }], "@odata.nextLink": `${graph}/me/calendars?second=true` });
        if (recovered) return json({ value: [{ id: "remote-calendar", name: "Events", canEdit: true, canViewPrivateItems: true }] });
        if (mode === "healthy") return json({ value: [] });
        if (mode === "event-invalid") return json({});
        if (mode === "event-partial") return json({ value: [] }, 206);
        if (["late404", "event-late-invalid"].includes(mode) && !url.searchParams.has("second"))
          return json({ value: [{ id: "remote-calendar", name: "Events", canEdit: true }], "@odata.nextLink": `${graph}/me/calendars?second=true` });
        if (mode === "event-late-invalid") return json({});
        if (mode === "bare404") return json({}, 404);
        return json({ error: { code: mode === "unknown404" ? "ResourceNotFound" : mode === "inner-mailbox" ? "ErrorItemNotFound"
          : mode === "unsupported-mailbox" ? "MailboxNotSupportedForRESTAPI" : "MailboxNotEnabledForRESTAPI",
          ...(mode === "inner-mailbox" ? { innerError: { code: "MailboxNotEnabledForRESTAPI" } } : {}), message: "Private fixture mailbox" } }, 404);
      }
      if (url.pathname === "/v1.0/me/todo/lists") {
        taskListCalls++;
        if (mode === "tasks-late404") return json(url.searchParams.has("second")
          ? { error: { code: "ErrorItemNotFound", innerError: { code: "MailboxNotEnabledForRESTAPI" } } }
          : { value: [{ id: "tasks", displayName: "Tasks", isOwner: true }], "@odata.nextLink": `${graph}/me/todo/lists?second=true` }, url.searchParams.has("second") ? 404 : 200);
        if (mode === "tasks-empty") return json({ value: [] });
        if (mode === "tasks-invalid" || mode === "tasks-late-invalid" && url.searchParams.has("second")) return json({});
        if (["tasks403", "tasks401", "tasks404"].includes(mode)) return json({ error: { code: "ErrorItemNotFound" } }, Number(mode.slice(5)));
        return json({ value: [{ id: "tasks", displayName: "Tasks", isOwner: true }],
          ...(mode === "tasks-late-invalid" ? { "@odata.nextLink": `${graph}/me/todo/lists?second=true` } : {}) });
      }
      if (url.pathname === "/v1.0/me/todo/lists/tasks/tasks/delta") {
        taskReadCalls++;
        if (mode === "fetch401" || mode === "fetch403") return json({}, Number(mode.slice(5)));
        return json({ value: [{ id: "native-task", title: "Imported through unavailable calendar", status: "inProgress", "@odata.etag": '"task-v2"' },
          { id: "protected-task", title: "Provider cannot overwrite pending", status: "completed" },
          { id: "uncertain-task", title: "Provider cannot overwrite uncertain", status: "completed" }], "@odata.deltaLink": taskTerminal });
      }
      eventPullCalls++;
      if (recovered && url.pathname === "/v1.0/me/calendars/remote-calendar/calendarView/delta")
        return json({ value: [], "@odata.deltaLink": `${graph}/me/calendars/remote-calendar/calendarView/delta?fixture=accepted` });
      throw new Error("Unavailable event resource must never be read");
    } catch (error) { fixtureFailure = error; res.writeHead(500); res.end(); }
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://graph.microsoft.com", "Only fixture Graph GETs");
    return realFetch(`${origin}${url.pathname}${url.search}`, init);
  };
  const streams: EventEmitter[] = [], emitted = new Map<string, string[]>();
  try {
    await db.insert(user).values([owner, sourceReader, linkedReader].map(id => ({ id, name: label, email: `${id}@example.test` })));
    await db.insert(account).values({ id: connectionID, userId: owner, providerId: "microsoft", accountId: accountID,
      scope: `${CALENDAR_SCOPE.microsoft}${mode === "no-scope" ? "" : `,${TASK_SCOPE.microsoft}`}`, accessToken: "fixture-resource-access",
      refreshToken: "fixture-refresh", accessTokenExpiresAt: new Date(Date.now() + 3600_000) });
    const eventCalendar = await importExternalCalendar("microsoft", owner, accountID, label,
      { externalId: "remote-calendar", name: "Events", color: "red", supportsEvents: true, supportsTasks: false });
    await reconcileMicrosoftCalendarAccess(owner, accountID, eventCalendar.id, { canEdit: true, canViewPrivateItems: true });
    await upsertExternalEvent("microsoft", owner, eventCalendar.id, "remote-calendar", "native-event",
      { title: "Retained event", color: "red", start: new Date("2026-09-15T09:00:00Z"), end: new Date("2026-09-15T10:00:00Z"),
        isAllDay: false, description: "Private retained notes", location: null, organizer: "", recurrence: null, url: null }, 'W/"event-v1"', "fixture-uid");
    const [eventSource] = await getUserExternalCalendars("microsoft", owner, accountID);
    const [eventMapping] = await db.select().from(externalEvents).where(eq(externalEvents.calendarID, eventCalendar.id));
    await db.update(externalCalendars).set({ cursor: "retained-event-cursor", sourceGeneration: 7, checkpointRevision: 11,
      readConfigurationFingerprint: "retained-profile", readCoverage: { kind: "window", fromInclusive: "2026-01-01T00:00:00.000Z", untilExclusive: "2028-01-01T00:00:00.000Z", complete: true } }).where(eq(externalCalendars.id, eventSource.sourceID));
    await db.insert(calendars).values([{ id: taskCalendarID, creatorID: owner, name: "Tasks", color: "red" }, { id: linkedCalendarID, creatorID: owner, name: "Linked", color: "red" }]);
    await db.insert(calendarMembers).values([{ userID: owner, calendarID: taskCalendarID, role: "owner" }, { userID: owner, calendarID: linkedCalendarID, role: "owner" },
      { userID: sourceReader, calendarID: taskCalendarID, role: "viewer" }, { userID: linkedReader, calendarID: linkedCalendarID, role: "viewer" }]);
    await db.insert(calendarEvents).values({ eventID: eventMapping.eventID, calendarID: linkedCalendarID });
    const event = EventSchema.parse(await getEventSnapshot(eventMapping.eventID));
    for (const status of ["pending", "unconfirmed"] as const) await db.insert(eventOutbox).values({ id: randomUUID(), actorID: owner, mutationID: randomUUID(), position: 0,
      eventID: event.id, revision: event.revision!, calendarID: eventCalendar.id, externalCalendarLinkID: eventSource.sourceID,
      provider: "microsoft", userID: owner, accountID, externalCalendarID: "remote-calendar", externalEventID: "native-event", expectedEtag: 'W/"event-v1"',
      action: "update", payload: { event }, status, uncertain: status === "unconfirmed" });
    const [taskSource] = await db.insert(externalCalendars).values({ provider: "microsoft", userID: owner, accountID, accountLabel: label, calendarID: taskCalendarID,
      externalCalendarID: taskExternalID, supportsEvents: false, supportsTasks: true, cursor: `${graph}/me/todo/lists/tasks/tasks/delta?fixture=saved` }).returning();
    const seeded = await db.insert(tasks).values(["native-task", "protected-task", "uncertain-task"].map(title => ({ id: randomUUID(), creatorID: owner,
      calendarID: taskCalendarID, originCalendarID: taskCalendarID, title, status: "in-process" as const, revision: 4 }))).returning();
    for (const task of seeded) {
      await db.insert(calendarTasks).values([{ taskID: task.id, calendarID: taskCalendarID }, { taskID: task.id, calendarID: linkedCalendarID }]);
      await db.insert(externalTasks).values({ provider: "microsoft", taskID: task.id, calendarID: taskCalendarID, externalCalendarID: taskExternalID,
        externalTaskID: task.title, externalCalendarLinkID: taskSource.id, accountID, etag: '"task-v1"', acceptedRevision: task.revision,
        projectionBaseline: microsoftAdapter.projectTask!(TaskSchema.parse({ ...task, calendarIDs: [taskCalendarID] })) });
    }
    const protectedTask = seeded.find(row => row.title === "protected-task")!;
    const uncertainTask = seeded.find(row => row.title === "uncertain-task")!;
    for (const task of [protectedTask, uncertainTask]) await db.insert(taskOutbox).values({ id: randomUUID(), actorID: owner, mutationID: randomUUID(), position: 0, taskID: task.id,
      revision: task.revision, calendarID: taskCalendarID, externalCalendarLinkID: taskSource.id, provider: "microsoft", userID: owner,
      accountID, externalCalendarID: taskExternalID, externalTaskID: task.title, expectedEtag: '"task-v1"', providerAccessRevision: taskSource.providerAccessRevision,
      action: "update", status: task === uncertainTask ? "unconfirmed" : "pending", uncertain: task === uncertainTask,
      payload: { task: TaskSchema.parse({ ...task, calendarIDs: [taskCalendarID] }) } });
    const snapshot = async () => ({
      events: await db.select().from(events).where(eq(events.creatorID, owner)).orderBy(events.id),
      eventMappings: await db.select().from(externalEvents).where(eq(externalEvents.calendarID, eventCalendar.id)).orderBy(externalEvents.id),
      eventLinks: await db.select().from(calendarEvents).where(eq(calendarEvents.eventID, event.id)).orderBy(calendarEvents.calendarID),
      eventOutbox: await db.select().from(eventOutbox).where(eq(eventOutbox.userID, owner)).orderBy(eventOutbox.id),
      tombstones: await db.select().from(externalEventTombstones).where(eq(externalEventTombstones.externalCalendarLinkID, eventSource.sourceID)),
      sources: (await db.select().from(externalCalendars).where(eq(externalCalendars.userID, owner)).orderBy(externalCalendars.id)).map(({ updatedAt: _labelUpdated, ...row }) => row),
      tasks: await db.select().from(tasks).where(eq(tasks.creatorID, owner)).orderBy(tasks.id),
      taskMappings: await db.select().from(externalTasks).where(eq(externalTasks.calendarID, taskCalendarID)).orderBy(externalTasks.id),
      taskOutbox: await db.select().from(taskOutbox).where(eq(taskOutbox.userID, owner)).orderBy(taskOutbox.id),
    });
    for (const id of [sourceReader, linkedReader]) {
      const output: string[] = []; emitted.set(id, output);
      const stream = new EventEmitter(); streams.push(stream);
      const response = Object.assign(stream, { destroyed: false, writableEnded: false, setHeader() {}, flushHeaders() {}, write(value: string) { output.push(value); return true; }, end() { response.writableEnded = true; } });
      await handlerStream(Object.assign(new EventEmitter(), { aborted: false, user: { id, isExternal: true } }) as unknown as Request, response as unknown as Response);
    }
    const before = await snapshot();
    const observedDebug: string[] = [];
    const originalDebug = logger.debug;
    logger.debug = message => { observedDebug.push(message); };
    // Only these two negative cases substitute the boundary DTO to exercise a
    // malformed future adapter contract. Every provider-read case uses the real
    // adapter unchanged and a local HTTP fixture.
    const adapter = mode.endsWith("contract") ? { ...microsoftAdapter, listCalendars: async () => ({
      calendars: mode === "invalid-contract" ? [{ externalId: "remote-calendar", name: "Must not alter source", color: "red", supportsEvents: true, supportsTasks: true, microsoftAccess: { canEdit: false, canViewPrivateItems: false } }] : [],
      taskListsComplete: false, eventCalendarsComplete: false,
      ...(mode === "invalid-contract" ? { eventCalendarDiscoveryError: new Error("Unavailable events") } : {}),
    } as CalendarDiscoveryResult) } : microsoftAdapter;
    const run = () => syncProvider(adapter, owner, { id: accountID, label });
    try {
    if (mode === "healthy") {
      await run();
      assert.equal((await getUserExternalCalendars("microsoft", owner, accountID)).some(link => link.calendarID === eventCalendar.id), false, "A complete empty event inventory still removes a deleted event mirror");
    } else {
      let observedFailure: unknown;
      await assert.rejects(run(), error => { observedFailure = error; return true; });
      if (["tasks401", "tasks404", "tasks-late404"].includes(mode)) {
        assert.ok(observedFailure instanceof GraphTaskListDiscoveryHttpError, "The actual Tasks inventory failure reaches the account boundary before the deferred Events error");
        assert.equal(observedFailure.cause.httpStatus, mode === "tasks401" ? 401 : 404);
        assert.equal(observedFailure.cause.requestPhase, mode === "tasks-late404" ? "next-page" : "initial");
        assert.equal(observedFailure.cause.graphCode, "ErrorItemNotFound");
        assert.equal(observedFailure.cause.graphInnerCode, mode === "tasks-late404" ? "MailboxNotEnabledForRESTAPI" : "missing");
        assert.equal(isMicrosoftEventMailboxUnavailable(observedFailure), false, "Task-list failure cannot become Events recovery evidence");
        assert.equal(taskReadCalls, 0, "Incomplete list discovery never authorizes a partial task collection read");
      } else if (mode === "tasks403") {
        assert.ok(observedFailure instanceof GraphCalendarDiscoveryHttpError, "Optional Tasks403 preserves the original deferred typed Events404");
      }
      assert.equal(observedDebug.includes("sync.account.completed"), false, "Partial or failed account must not be logged as fully completed");
      if (["mailbox", "inner-mailbox", "unsupported-mailbox", "recovered"].includes(mode)) {
        assert.equal(taskListCalls, 1, "Mailbox-unavailable events cannot prevent granted To Do discovery");
        assert.equal(taskReadCalls, 1, "Independent Tasks actually read through the real adapter");
        const after = await snapshot();
        assert.deepEqual({ ...after, sources: [], tasks: [], taskMappings: [] }, { ...before, sources: [], tasks: [], taskMappings: [] }, "All event evidence and pending intents remain unchanged");
        assert.deepEqual(after.sources.find(row => row.id === eventSource.sourceID), before.sources.find(row => row.id === eventSource.sourceID), "Event source cursor/coverage/profile/generation/checkpoint are untouched");
        assert.deepEqual(after.tasks.find(row => row.id === protectedTask.id), protectedTask, "Pending task intent protects canonical content");
        assert.deepEqual(after.tasks.find(row => row.id === uncertainTask.id), uncertainTask, "Uncertain task intent protects canonical content");
        const binding = ({ id, taskID, calendarID, externalCalendarLinkID, accountID, externalCalendarID, externalTaskID, acceptedRevision }: typeof before.taskMappings[number]) => ({ id, taskID, calendarID, externalCalendarLinkID, accountID, externalCalendarID, externalTaskID, acceptedRevision });
        assert.deepEqual(after.taskMappings.filter(row => [protectedTask.id, uncertainTask.id].includes(row.taskID)).map(binding), before.taskMappings.filter(row => [protectedTask.id, uncertainTask.id].includes(row.taskID)).map(binding), "Successful observations retain pending/uncertain binding identity and accepted canonical revision");
        assert.equal(after.tasks.find(row => row.id === seeded[0]!.id)!.title, "Imported through unavailable calendar");
        const accepted = after.sources.find(row => row.id === taskSource.id)!;
        assert.equal(accepted.cursor, taskTerminal);
        assert.equal(accepted.checkpointRevision, taskSource.checkpointRevision + 1);
        for (const output of emitted.values()) assert.ok(output.some(frame => frame.includes("external_sync") && frame.includes(taskCalendarID) && frame.includes(linkedCalendarID)), "Both source-only and linked-only readers receive committed Tasks despite deferred account failure");
        const failedCount = async () => (await metricsRegistry.getSingleMetric("musubi_sync_runs_total")!.get()).values.filter(row => row.labels.outcome === "failed").reduce((sum, row) => sum + row.value, 0);
        const failedBefore = await failedCount();
        await syncUser(owner, { provider: "microsoft", accountId: accountID, throwOnError: true }).then(() => assert.fail("Strict manual sync must still fail"), () => {});
        assert.ok(await failedCount() > failedBefore, "Partial account remains failed in metrics");
        if (mode === "recovered") {
          recovered = true;
          await run();
          const source = (await getUserExternalCalendars("microsoft", owner, accountID)).find(row => row.calendarID === eventCalendar.id)!;
          assert.equal(source.sourceID, eventSource.sourceID, "Recovered availability resumes the existing source incarnation identity");
          assert.ok(source.cursor?.includes("fixture=accepted"), "Normal event reading resumes only after complete successful discovery");
          assert.deepEqual((await snapshot()).eventOutbox, before.eventOutbox, "Recovery never disables or rewrites pending event intent");
          assert.ok(observedDebug.includes("sync.account.completed"));
        }
      } else if (mode === "tasks-empty") {
        const after = await snapshot();
        assert.deepEqual(after.sources.find(row => row.id === eventSource.sourceID), before.sources.find(row => row.id === eventSource.sourceID));
        assert.deepEqual({ events: after.events, mappings: after.eventMappings, links: after.eventLinks, outbox: after.eventOutbox, tombstones: after.tombstones },
          { events: before.events, mappings: before.eventMappings, links: before.eventLinks, outbox: before.eventOutbox, tombstones: before.tombstones }, "Complete empty Tasks inventory cannot grant event absence authority");
        assert.equal(after.sources.some(row => row.id === taskSource.id), false, "Complete empty Tasks inventory can remove the genuinely absent Tasks mirror");
      } else {
        assert.deepEqual(await snapshot(), before, `${mode}: unsuccessful discovery/read cannot mutate mirrors, data, checkpoint or pending intents`);
        if (mode === "no-scope" || mode.endsWith("contract") || ["unknown404", "bare404", "late404", "event-invalid", "event-partial", "event-late-invalid", "event-reserved-late"].includes(mode)) assert.equal(taskListCalls, 0);
        else assert.ok(taskListCalls > 0);
      }
    }
    assert.equal(eventPullCalls, mode === "recovered" ? 1 : 0);
    assert.equal(fixtureFailure, undefined);
    assert.ok(calls.every(path => !path.includes("/token")), "No refresh/reconnect is synthesized");
    console.log(`Microsoft real HTTP/engine/PostgreSQL resource isolation ${mode}: OK`);
    } finally { logger.debug = originalDebug; }
  } finally {
    for (const stream of streams) stream.emit("close");
    globalThis.fetch = realFetch;
    await db.delete(user).where(inArray(user.id, [owner, sourceReader, linkedReader]));
    fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve()));
  }
}

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Use a disposable migrated database");
  const database = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(database.hostname), "Refuse a non-local test database");
  for (const mode of ["mailbox", "inner-mailbox", "unsupported-mailbox", "no-scope", "unknown404", "bare404", "late404",
    "event-invalid", "event-partial", "event-late-invalid", "event-reserved-late", "tasks-invalid", "tasks-late-invalid", "tasks403", "tasks401", "tasks404", "tasks-late404", "fetch401", "fetch403", "tasks-empty", "healthy", "recovered", "invalid-contract", "missing-failure-contract"] as const) await scenario(mode);
}

main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
