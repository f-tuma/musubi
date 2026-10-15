import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import {
  account, CALENDAR_SCOPE, TASK_SCOPE, calendarMembers, calendars, calendarTasks,
  db, externalCalendars, externalTasks, tasks, taskOutbox, user,
} from "@musubi/db";
import { TaskSchema } from "@musubi/types";
import { microsoftAdapter, microsoftTaskListExternalId } from "./adapters/microsoft";
import { syncProvider } from "./engine";

const graph = "https://graph.microsoft.com/v1.0";
const label = "Task completeness fixture";
type ReadMode = "missing-envelope" | "missing-terminal" | "partial" | "late-invalid"
  | "late-removal-invalid" | "late-conflicting-links" | "snapshot-invalid"
  | "snapshot-late-invalid" | "empty" | "snapshot-empty" | "removal"
  | "bootstrap-complete" | "bootstrap-invalid" | "bootstrap-late-invalid"
  | "bootstrap-partial" | "bootstrap-saved-error" | "bootstrap-saved-initial-error"
  | "bootstrap-next-error" | "bootstrap-wrong-code" | "bootstrap-message-newline"
  | "bootstrap-message-suffix";

/** This suite uses real adapter HTTP, the engine, and seeded PostgreSQL rows.
 * It never substitutes a recording adapter or contacts a provider account. */
async function scenario(mode: ReadMode, renewal = false, copy = false, fence?: "incremental" | "completed-after-read" | "source-changed") {
  const owner = `task-completeness-${randomUUID()}`;
  const home = randomUUID(), target = randomUUID();
  const homeAccount = randomUUID(), copyAccount = randomUUID();
  const selectedCalendar = copy ? target : home;
  const selectedAccount = copy ? copyAccount : homeAccount;
  const selectedList = copy ? "copy" : "home";
  const listURL = (list: string) => `${graph}/me/todo/lists/${list}/tasks`;
  const saved = `${listURL(selectedList)}/delta?fixture=saved`;
  const initial = `${listURL(selectedList)}/delta?$top=100`;
  const terminal = `${listURL(selectedList)}/delta?fixture=terminal%2Bopaque`;
  const bootstrap = mode.startsWith("bootstrap-");
  let failure: unknown;
  let taskRequests = 0, expiredRequests = 0, snapshotRequests = 0;
  let beforeTaskResponse: (() => Promise<void>) | undefined;
  const fixture = createServer((req, res) => {
    void (async () => {
      assert.equal(req.method, "GET", "This fixture only permits provider reads");
      const url = new URL(req.url!, "http://fixture.test");
      const token = req.headers.authorization;
      assert.ok(token === "Bearer fixture-home" || token === "Bearer fixture-copy");
      const list = token === "Bearer fixture-home" ? "home" : "copy";
      const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/v1.0/me/calendars") return json({ value: [] });
      if (url.pathname === "/v1.0/me/todo/lists") return json({ value: [{ id: list, displayName: `${list} tasks` }] });
      assert.equal(list, selectedList, "Only the selected account is read");
      const path = `/v1.0/me/todo/lists/${list}/tasks`;
      assert.ok(url.pathname === path || url.pathname === `${path}/delta`, "Unexpected fixture request");
      taskRequests++;
      if (renewal && url.searchParams.get("fixture") === "saved") {
        expiredRequests++;
        return json({ error: { code: "SyncStateNotFound" } }, 410);
      }
      await beforeTaskResponse?.();
      if (bootstrap) {
        if (url.pathname.endsWith("/delta")) {
          if (mode === "bootstrap-next-error" && !url.searchParams.has("page"))
            return json({ value: [{ id: "primary", title: "Buffered delta edit must not commit", status: "completed", "@odata.etag": '"buffered-delta-v2"' }], "@odata.nextLink": `${listURL(list)}/delta?page=second` });
          return json({ error: {
            code: mode === "bootstrap-wrong-code" ? "InvalidRequest" : "BadRequest",
            message: mode === "bootstrap-message-newline" ? "Skip token is not provided\n"
              : mode === "bootstrap-message-suffix" ? "Skip token is not provided for another resource"
                : renewal ? "SKIP TOKEN IS NOT PROVIDED." : "Skip token is not provided",
          } }, 400);
        }
        snapshotRequests++;
        if (mode === "bootstrap-invalid") return json({});
        if (mode === "bootstrap-partial") return json({ value: [] }, 206, { "content-range": "items 0-0/2" });
        if (url.searchParams.get("page") === "second")
          return json(mode === "bootstrap-late-invalid" ? {} : { value: [] });
        return json({ value: [{ id: "primary", title: "Recovered native task", status: "inProgress", body: { contentType: "text", content: "Canonical content must survive a rejected read" }, startDateTime: null, dueDateTime: { dateTime: "2026-10-01T14:45:00", timeZone: "UTC" }, importance: "high", "@odata.etag": '"recovered-v2"' }], "@odata.nextLink": `${listURL(list)}?page=second` });
      }
      const snapshot = mode.startsWith("snapshot-");
      if (snapshot && url.pathname.endsWith("/delta"))
        return json({ error: { code: "BadRequest", message: "Delta query is not supported by this resource" } }, 400);
      if (mode === "missing-envelope") return json({});
      if (mode === "missing-terminal") return json({ value: [] });
      if (mode === "partial") return json({ value: [], "@odata.deltaLink": terminal }, 206, { "content-range": "items 0-0/2" });
      if (mode === "snapshot-invalid") return json({ value: [], "@odata.nextLink": null });
      if (mode === "snapshot-empty") return json({ value: [] });
      if (mode === "empty") return json({ value: [], "@odata.deltaLink": terminal });
      if (mode === "removal") return json({ value: [{ id: "primary", "@removed": { reason: "deleted" } }, { id: "protected", "@removed": { reason: "deleted" } }], "@odata.deltaLink": terminal });
      if (url.searchParams.get("page") === "second") {
        if (mode === "late-conflicting-links") return json({ value: [], "@odata.nextLink": `${listURL(list)}/delta?page=third`, "@odata.deltaLink": terminal });
        if (mode === "snapshot-late-invalid") return json({ value: [], "@odata.nextLink": "" });
        return json({});
      }
      return json({
        value: mode === "late-removal-invalid"
          ? [{ id: "primary", "@removed": { reason: "deleted" } }]
          : [{ id: "primary", title: "Uncommitted remote edit", status: "completed", "@odata.etag": '"uncommitted-v2"' }],
        "@odata.nextLink": `${listURL(list)}${snapshot ? "" : "/delta"}?page=second`,
      });
    })().catch((error) => { failure = error; res.writeHead(500); res.end(); });
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://graph.microsoft.com", "No live provider or token requests");
    assert.equal(init?.method ?? "GET", "GET", "The reader cannot dispatch task writes");
    return originalFetch(`${origin}${url.pathname}${url.search}`, init);
  };
  try {
    await db.insert(user).values({ id: owner, name: label, email: `${owner}@example.test` });
    await db.insert(account).values([
      { id: randomUUID(), userId: owner, providerId: "microsoft", accountId: homeAccount, accessToken: "fixture-home", refreshToken: "fixture-refresh", scope: `${CALENDAR_SCOPE.microsoft},${TASK_SCOPE.microsoft}`, accessTokenExpiresAt: new Date(Date.now() + 3600000) },
      { id: randomUUID(), userId: owner, providerId: "microsoft", accountId: copyAccount, accessToken: "fixture-copy", refreshToken: "fixture-refresh", scope: `${CALENDAR_SCOPE.microsoft},${TASK_SCOPE.microsoft}`, accessTokenExpiresAt: new Date(Date.now() + 3600000) },
    ]);
    await db.insert(calendars).values([{ id: home, creatorID: owner, name: "Home", color: "#7A8BA3" }, { id: target, creatorID: owner, name: "Copy", color: "#7A8BA3" }]);
    await db.insert(calendarMembers).values([{ calendarID: home, userID: owner, role: "owner" }, { calendarID: target, userID: owner, role: "owner" }]);
    const initialCursor = mode === "bootstrap-saved-initial-error" ? initial
      : renewal || fence === "incremental" || mode === "bootstrap-saved-error" ? saved : null;
    const sources = await db.insert(externalCalendars).values([
      { calendarID: home, provider: "microsoft", userID: owner, accountID: homeAccount, accountLabel: label, externalCalendarID: microsoftTaskListExternalId("home"), supportsEvents: false, supportsTasks: true, cursor: selectedCalendar === home ? initialCursor : null },
      { calendarID: target, provider: "microsoft", userID: owner, accountID: copyAccount, accountLabel: label, externalCalendarID: microsoftTaskListExternalId("copy"), supportsEvents: false, supportsTasks: true, cursor: selectedCalendar === target ? initialCursor : null },
    ]).returning();
    const source = (calendarID: string) => sources.find((item) => item.calendarID === calendarID)!;
    const taskNames = mode === "bootstrap-complete" ? ["primary", "protected", "missing"] : ["primary", "protected"];
    const seeded = await db.insert(tasks).values(taskNames.map((name) => ({ id: randomUUID(), creatorID: owner, calendarID: home, originCalendarID: home, title: `Seeded ${name}`, description: "Canonical content must survive a rejected read", status: "in-process" as const, revision: 4, due: new Date("2026-10-01T14:45:00Z"), priority: 2 }))).returning();
    const primary = seeded[0]!, protectedTask = seeded[1]!;
    for (const [index, task] of seeded.entries()) {
      await db.insert(calendarTasks).values([{ taskID: task.id, calendarID: home }, { taskID: task.id, calendarID: target }]);
      for (const calendarID of [home, target]) {
        const selected = source(calendarID);
        const projection = microsoftAdapter.projectTask!(TaskSchema.parse({ ...task, calendarIDs: [home, target] }));
        await db.insert(externalTasks).values({ provider: "microsoft", taskID: task.id, calendarID, externalCalendarID: selected.externalCalendarID, externalTaskID: taskNames[index]!, externalCalendarLinkID: selected.id, accountID: selected.accountID, etag: `"${calendarID}-v1"`, projectionBaseline: projection, acceptedRevision: task.revision });
      }
    }
    const intent = async (calendarID: string, status: "pending" | "unconfirmed", task = protectedTask) => {
      const selected = source(calendarID);
      const [row] = await db.insert(taskOutbox).values({ id: randomUUID(), actorID: owner, mutationID: randomUUID(), position: 0, taskID: task.id, revision: task.revision, calendarID, externalCalendarLinkID: selected.id, provider: "microsoft", userID: owner, accountID: selected.accountID, externalCalendarID: selected.externalCalendarID, externalTaskID: task.id === primary.id ? "primary" : "protected", expectedEtag: `"${calendarID}-v1"`, providerAccessRevision: selected.providerAccessRevision, action: "update", status, uncertain: status === "unconfirmed", payload: { task: TaskSchema.parse({ ...task, calendarIDs: [home, target] }) } }).returning();
      return row!;
    };
    await intent(home, "pending");
    await intent(target, "unconfirmed");
    const snapshot = async () => ({
      tasks: await db.select().from(tasks).where(eq(tasks.creatorID, owner)).orderBy(tasks.id),
      mappings: await db.select().from(externalTasks).where(inArray(externalTasks.calendarID, [home, target])).orderBy(externalTasks.id),
      links: await db.select().from(calendarTasks).where(inArray(calendarTasks.calendarID, [home, target])).orderBy(calendarTasks.taskID, calendarTasks.calendarID),
      outbox: await db.select().from(taskOutbox).where(eq(taskOutbox.userID, owner)).orderBy(taskOutbox.id),
      sources: (await db.select().from(externalCalendars).where(eq(externalCalendars.userID, owner)).orderBy(externalCalendars.id)).map(({ updatedAt: _discoveryLabelTime, ...row }) => row),
    });
    const run = () => syncProvider(microsoftAdapter, owner, { id: selectedAccount, label });
    let concurrentState: Awaited<ReturnType<typeof snapshot>> | undefined;
    if (fence === "completed-after-read") {
      const pending = await intent(selectedCalendar, "pending", primary);
      beforeTaskResponse = async () => {
        if (concurrentState) return;
        // Model the durable ACK barrier during an in-flight GET. No task
        // writer or real provider mutation is dispatched by this read fixture.
        const [acknowledged] = await db.update(tasks).set({ title: "Acknowledged local edit", revision: primary.revision + 1 }).where(eq(tasks.id, primary.id)).returning();
        const projection = microsoftAdapter.projectTask!(TaskSchema.parse({ ...acknowledged!, calendarIDs: [home, target] }));
        await db.update(taskOutbox).set({ status: "completed", updatedAt: new Date(), resultRef: { externalTaskId: "primary", etag: '"acknowledged-v2"' } }).where(eq(taskOutbox.id, pending.id));
        await db.update(externalTasks).set({ etag: '"acknowledged-v2"', projectionBaseline: projection, acceptedRevision: acknowledged!.revision }).where(and(eq(externalTasks.taskID, primary.id), eq(externalTasks.calendarID, selectedCalendar)));
        concurrentState = await snapshot();
      };
    } else if (fence === "source-changed") {
      beforeTaskResponse = async () => {
        if (concurrentState) return;
        await db.update(externalCalendars).set({ providerAccessRevision: source(selectedCalendar).providerAccessRevision + 1 }).where(eq(externalCalendars.id, source(selectedCalendar).id));
        concurrentState = await snapshot();
      };
    }
    const before = await snapshot();
    if (mode === "bootstrap-complete") {
      await run();
      assert.equal(failure, undefined);
      const after = await snapshot();
      const recovered = after.tasks.find((row) => row.id === primary.id)!;
      assert.equal(recovered.title, "Recovered native task", "A complete fallback imports actual native content");
      assert.equal(recovered.revision, primary.revision + 1);
      assert.equal(recovered.deletedAt, null, "A present native task is never treated as missing");
      assert.equal(recovered.description, primary.description);
      assert.equal(recovered.due?.toISOString(), primary.due?.toISOString());
      const missing = seeded[2]!;
      const missingAfter = after.tasks.find((row) => row.id === missing.id)!;
      assert.ok(missingAfter.deletedAt, "Complete snapshot absence preserves existing origin missing-task handling");
      assert.equal(missingAfter.revision, missing.revision + 1);
      assert.deepEqual(after.tasks.find((row) => row.id === protectedTask.id), protectedTask, "Pending local writes remain authoritative during bootstrap fallback");
      assert.deepEqual(after.links, before.links);
      assert.deepEqual(after.mappings.filter((row) => row.calendarID === target || row.taskID === protectedTask.id), before.mappings.filter((row) => row.calendarID === target || row.taskID === protectedTask.id), "Secondary and pending/uncertain mapping evidence stays intact");
      const accepted = after.mappings.find((row) => row.taskID === primary.id && row.calendarID === home)!;
      assert.equal(accepted.etag, '"recovered-v2"');
      assert.equal(accepted.projectionBaseline?.title, "Recovered native task");
      assert.equal(accepted.acceptedRevision, recovered.revision);
      const retired = after.mappings.find((row) => row.taskID === missing.id && row.calendarID === home)!;
      assert.equal(retired.etag, null);
      assert.equal(retired.projectionBaseline, null);
      assert.deepEqual(after.outbox.filter((row) => before.outbox.some((old) => old.id === row.id)), before.outbox, "Fallback never rewrites existing durable pending/uncertain intents");
      const fanout = after.outbox.filter((row) => !before.outbox.some((old) => old.id === row.id));
      assert.equal(fanout.length, 2);
      assert.deepEqual(fanout.map((row) => ({ taskID: row.taskID, action: row.action, calendarID: row.calendarID, status: row.status })).sort((a, b) => a.taskID.localeCompare(b.taskID)), [
        { taskID: primary.id, action: "update", calendarID: target, status: "pending" },
        { taskID: missing.id, action: "delete", calendarID: target, status: "pending" },
      ].sort((a, b) => a.taskID.localeCompare(b.taskID)), "These are durable fanout intents, never dispatched provider mutations");
      const checkpoint = after.sources.find((row) => row.calendarID === selectedCalendar)!;
      assert.equal(checkpoint.cursor, null, "A complete list snapshot cannot manufacture a delta checkpoint");
      assert.equal(checkpoint.checkpointRevision, source(selectedCalendar).checkpointRevision + 1);
      assert.equal(snapshotRequests, 2, "Both snapshot pages must complete before any import/checkpoint");
    } else if (fence === "source-changed") {
      await assert.rejects(run(), /Task source access changed during sync/);
      assert.equal(failure, undefined);
      assert.ok(concurrentState, "Access revision actually changed while the real GET was in flight");
      assert.deepEqual(await snapshot(), concurrentState, "An obsolete source admission applies neither missing-task evidence nor its checkpoint");
    } else if (fence === "incremental" || fence === "completed-after-read") {
      await run();
      assert.equal(failure, undefined);
      const after = await snapshot();
      const expected = concurrentState ?? before;
      assert.deepEqual(after.tasks, expected.tasks, "Empty incremental or read begun before ACK cannot retire canonical state");
      assert.deepEqual(after.mappings, expected.mappings, "A completed-after-read fence retains acknowledged mapping versions/baselines");
      assert.deepEqual(after.links, expected.links);
      assert.deepEqual(after.outbox, expected.outbox, "Successful read cannot append a delete intent for fenced tasks");
      const checkpoint = after.sources.find((row) => row.calendarID === selectedCalendar)!;
      assert.equal(checkpoint.cursor, terminal);
      assert.equal(checkpoint.checkpointRevision, source(selectedCalendar).checkpointRevision + 1);
      if (fence === "completed-after-read") assert.ok(concurrentState, "Completion barrier ran inside the task GET");
    } else if (!["empty", "snapshot-empty", "removal"].includes(mode)) {
      const error: unknown = await run().then(() => null, (value: unknown) => value);
      assert.equal(failure, undefined, "Owned HTTP fixture completed without an unexpected request");
      assert.deepEqual(await snapshot(), before, `${mode}/${renewal ? "saved-410-renewal" : initialCursor !== null ? "saved-cursor" : "initial"}: rejected read cannot mutate seeded canonical rows/revisions/tombstones, copies, mappings/baselines, attachments, durable writes or checkpoint`);
      const noFallback = ["bootstrap-saved-error", "bootstrap-saved-initial-error", "bootstrap-next-error", "bootstrap-wrong-code", "bootstrap-message-newline", "bootstrap-message-suffix"].includes(mode);
      const cause = (error as { cause?: { code?: string; requestPhase?: string; httpStatus?: number; failureKind?: string } } | null)?.cause;
      assert.equal(cause?.code, noFallback ? "graph-task-read-http-failed" : "graph-task-read-response-invalid", `${mode}: fail closed before applying any buffered observations`);
      if (noFallback) {
        assert.equal(snapshotRequests, 0, "The exact bootstrap repair must not widen to another status/code/message/phase or saved URL");
        assert.equal(cause?.httpStatus, 400);
        assert.equal(cause?.requestPhase, mode.startsWith("bootstrap-saved-") ? "saved-cursor" : mode === "bootstrap-next-error" ? "next-page" : renewal ? "recovery-initial" : "initial");
        assert.equal(cause?.failureKind, mode.startsWith("bootstrap-saved-") || mode === "bootstrap-next-error" ? "missing-page-state" : "other");
      }
      if (bootstrap && !noFallback) assert.ok(snapshotRequests > 0, "The failure is an actual rejected fallback snapshot, not the original delta HTTP 400");
    } else {
      await run();
      assert.equal(failure, undefined);
      const after = await snapshot();
      const currentPrimary = after.tasks.find((row) => row.id === primary.id)!;
      assert.deepEqual(after.tasks.find((row) => row.id === protectedTask.id), protectedTask, "Pending/uncertain writes retain their canonical task");
      assert.deepEqual(after.links, before.links, "Native missing/removal does not detach shared task links");
      const retained = after.mappings.filter((row) => row.taskID === protectedTask.id);
      assert.deepEqual(retained, before.mappings.filter((row) => row.taskID === protectedTask.id), "Pending/uncertain native copies keep their captured versions and baselines");
      if (copy) {
        assert.deepEqual(currentPrimary, primary, "Secondary native deletion has no canonical authority");
        assert.deepEqual(after.outbox, before.outbox, "Retiring a secondary copy creates no global delete intent");
      } else {
        assert.ok(currentPrimary.deletedAt, "Only a validated complete initial/snapshot or explicit removal retires the missing origin task");
        assert.equal(currentPrimary.revision, primary.revision + 1);
        const fanout = after.outbox.filter((row) => !before.outbox.some((old) => old.id === row.id));
        assert.equal(fanout.length, 1, "Origin tombstone atomically records one secondary fanout intent");
        assert.equal(fanout[0]!.action, "delete");
        assert.equal(fanout[0]!.calendarID, target);
        assert.equal(fanout[0]!.status, "pending", "This is an admitted intent, not proof of a provider DELETE");
      }
      const retired = after.mappings.find((row) => row.taskID === primary.id && row.calendarID === selectedCalendar)!;
      assert.equal(retired.etag, null);
      assert.equal(retired.projectionBaseline, null);
      assert.deepEqual(after.mappings.find((row) => row.taskID === primary.id && row.calendarID !== selectedCalendar), before.mappings.find((row) => row.taskID === primary.id && row.calendarID !== selectedCalendar));
      const checkpoint = after.sources.find((row) => row.calendarID === selectedCalendar)!;
      assert.equal(checkpoint.cursor, mode === "snapshot-empty" ? null : terminal);
      assert.equal(checkpoint.checkpointRevision, source(selectedCalendar).checkpointRevision + 1);
    }
    if (renewal) assert.equal(expiredRequests, 1, "Fixture exercised the saved cursor 410 before a new initial read");
    assert.ok(taskRequests > 0, "Real Microsoft task transport was exercised");
    console.log(`Microsoft task completeness DB: ${mode}, ${renewal ? "saved-410-renewal" : initialCursor !== null ? "saved-cursor" : "initial"}, ${copy ? "secondary" : "origin"}${fence ? `, ${fence}` : ""}: OK`);
  } finally {
    globalThis.fetch = originalFetch;
    await db.delete(user).where(eq(user.id, owner));
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
}

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Only a disposable test database is permitted");
  const database = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(database.hostname), "Refuse a non-local test database");
  for (const renewal of [false, true]) {
    for (const mode of ["missing-envelope", "missing-terminal", "partial", "late-invalid", "late-removal-invalid", "late-conflicting-links", "snapshot-invalid", "snapshot-late-invalid"] as const) await scenario(mode, renewal);
  }
  await scenario("empty");
  await scenario("empty", true);
  await scenario("snapshot-empty");
  await scenario("removal");
  await scenario("removal", false, true);
  await scenario("empty", false, false, "incremental");
  await scenario("removal", false, false, "completed-after-read");
  await scenario("empty", false, false, "source-changed");
  for (const renewal of [false, true]) {
    await scenario("bootstrap-complete", renewal);
    for (const mode of ["bootstrap-invalid", "bootstrap-late-invalid", "bootstrap-partial", "bootstrap-next-error", "bootstrap-wrong-code", "bootstrap-message-newline", "bootstrap-message-suffix"] as const) await scenario(mode, renewal);
  }
  await scenario("bootstrap-saved-error");
  await scenario("bootstrap-saved-initial-error");
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
