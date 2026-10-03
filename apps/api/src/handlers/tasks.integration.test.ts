import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db, user, calendarMembers, createCalendar, replaceMemberToken, getTaskSnapshot, tasks, taskMutations, taskOutbox } from "@musubi/db";
import { CLIENT_VERSION_HEADER, PRODUCT_VERSION, TaskSchema, TaskMutationResponseSchema, TaskDeleteResponseSchema, TASK_FORK_NOT_COMMITTED_CODE, type Task } from "@musubi/types";
import { issueMemberToken } from "../federation_tokens";
import { middlewareErrorHandler } from "../middleware/error_handler";
import { requireAuth } from "../middleware/require_auth";
import { handlerStream } from "./stream";
import { registerTaskRoutes } from "../task_routes";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Use a disposable PostgreSQL database.");
  const users = Array.from({ length: 3 }, () => `task-api-${randomUUID()}`);
  const tokens = users.map(() => issueMemberToken());
  for (let index = 0; index < users.length; index++) {
    await db.insert(user).values({ id: users[index], name: users[index], email: `${users[index]}@example.test`, isExternal: true });
    await replaceMemberToken(users[index], tokens[index].tokenHash);
  }
  const home = await createCalendar({ creatorID: users[0], name: "Private home", color: "#112233" });
  const mirror = await createCalendar({ creatorID: users[1], name: "Shared", color: "#112233" });
  const forkHome = await createCalendar({ creatorID: users[1], name: "Copies", color: "#112233" });
  await db.insert(calendarMembers).values([
    { userID: users[1], calendarID: home.id, role: "viewer" },
    { userID: users[2], calendarID: mirror.id, role: "viewer" },
  ]);
  const app = express(); app.use(express.json());
  // Destroy the real HTTP connection only after the handler has committed and
  // assembled its result, reproducing a lost response rather than a failed write.
  let loseNextForkResponse = false;
  app.use((req, res, next) => {
    if (loseNextForkResponse && req.method === "POST" && req.path.endsWith("/fork")) {
      loseNextForkResponse = false;
      res.json = () => { res.destroy(); return res; };
    }
    next();
  });
  registerTaskRoutes(app);
  app.get("/api/v1/stream", requireAuth, handlerStream);
  app.use(middlewareErrorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const send = async (actor: number, method: string, path: string, body?: unknown, mutationID?: string) => {
    const endpoint = path.startsWith("/task-deliveries") ? `/api/v1${path}`
      : path.replace(/^\/tasks/, method === "GET" || path.includes("/delivery") ? "/api/v1/tasks" : "/api/v1/task-mutations");
    const response = await fetch(origin + endpoint, { method, headers: { authorization: `Bearer ${tokens[actor].raw}`,
      [CLIENT_VERSION_HEADER]: PRODUCT_VERSION, "content-type": "application/json", ...(mutationID ? { "Idempotency-Key": mutationID } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const streamAbort = new AbortController();
  let captureStream: Promise<void> | undefined;
  const streamFrames: { type: string; payload: { id?: string } }[] = [];
  try {
    const stream = await fetch(`${origin}/api/v1/stream`, { signal: streamAbort.signal,
      headers: { authorization: `Bearer ${tokens[1].raw}`, [CLIENT_VERSION_HEADER]: PRODUCT_VERSION } });
    assert.equal(stream.status, 200); assert.ok(stream.body);
    const reader = stream.body.getReader(), decoder = new TextDecoder();
    captureStream = (async () => {
      let pending = "";
      while (!streamAbort.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) return;
        pending += decoder.decode(value, { stream: true });
        const frames = pending.split("\n\n"); pending = frames.pop()!;
        for (const frame of frames) if (frame.startsWith("data: ")) streamFrames.push(JSON.parse(frame.slice(6)));
      }
    })().catch(error => { if (!streamAbort.signal.aborted) throw error; });
    const creationCount = (id: string) => streamFrames.filter(frame => frame.type === "task_created" && frame.payload.id === id).length;
    const waitForCreation = async (id: string) => {
      const deadline = Date.now() + 2_000;
      while (!creationCount(id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(creationCount(id), 1, "Committed copy emits one creation notification");
    };
    const id = randomUUID(), path = `/tasks/${id}`;
    const created = await send(0, "POST", "/tasks", { id, calendarID: home.id, title: "Shared work", description: "Preserve this", priority: 3 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const initial = TaskMutationResponseSchema.parse(created.body).task!;
    assert.equal(initial.revision, 1); assert.equal(initial.originCalendarID, home.id);
    assert.equal(initial.capabilities?.edit, true);
    assert.equal((await send(2, "GET", path)).status, 404);
    for (const expectedRevision of [undefined, null, 0, -1, 1.5, "1"]) {
      assert.equal((await send(0, "PATCH", path, { expectedRevision, patch: { title: "Invalid" } })).status, 400);
      assert.equal((await send(0, "DELETE", path, { expectedRevision })).status, 400);
      assert.equal((await send(1, "POST", `${path}/link`, { calendarID: mirror.id, expectedRevision })).status, 400);
    }
    assert.equal((await send(0, "PUT", path, { ...initial, title: "Legacy bypass" })).status, 400);
    assert.equal((await send(0, "PATCH", path, { expectedRevision: 1, patch: { originCalendarID: mirror.id } })).status, 400);
    const linked = await send(1, "POST", `${path}/link`, { calendarID: mirror.id, expectedRevision: 1 });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.equal(linked.body.task.revision, 2);
    await db.delete(calendarMembers).where(and(eq(calendarMembers.userID, users[1]), eq(calendarMembers.calendarID, home.id)));
    const secondary = TaskSchema.parse((await send(1, "GET", path)).body);
    assert.deepEqual(secondary.calendarIDs, [mirror.id]); assert.equal(secondary.capabilities?.edit, false);
    assert.equal(secondary.capabilities?.fork, true);
    assert.equal((await send(1, "PATCH", path, { expectedRevision: 2, patch: { status: "completed" } })).status, 403);
    assert.equal((await send(1, "DELETE", path, { expectedRevision: 2 })).status, 403);
    const racers = await Promise.all([
      send(0, "PATCH", path, { expectedRevision: 2, patch: { title: "Draft A" } }),
      send(0, "PATCH", path, { expectedRevision: 2, patch: { title: "Draft B" } }),
    ]);
    assert.deepEqual(racers.map(result => result.status).sort(), [200, 409]);
    const winner = racers.find(result => result.status === 200)!.body.task;
    assert.equal(winner.description, "Preserve this"); assert.equal(winner.priority, 3);
    assert.equal(winner.revision, 3);
    const done = await send(0, "PATCH", path, { expectedRevision: 3, patch: { status: "completed" } });
    assert.equal(done.status, 200); assert.equal(done.body.task.percentComplete, 100); assert.ok(done.body.task.completedAt);
    assert.equal((await send(2, "GET", path)).body.status, "completed");
    assert.equal((await send(2, "GET", "/tasks")).body.tasks.filter((task: Task) => task.id === id).length, 1);
    const copyMutation = randomUUID(), copyRequest = { expectedRevision: 4, calendarID: forkHome.id };
    loseNextForkResponse = true;
    await assert.rejects(() => send(1, "POST", `${path}/fork`, copyRequest, copyMutation), /fetch failed/);
    const [savedCopyReceipt] = await db.select().from(taskMutations)
      .where(and(eq(taskMutations.actorID, users[1]), eq(taskMutations.mutationID, copyMutation)));
    assert.ok(savedCopyReceipt, "Fork committed before its HTTP response was lost");
    const copy = await send(1, "POST", `${path}/fork`, copyRequest, copyMutation);
    assert.equal(copy.status, 201, JSON.stringify(copy.body));
    const copiedTask = TaskMutationResponseSchema.parse(copy.body).task!;
    assert.equal(copiedTask.id, savedCopyReceipt.taskID); assert.notEqual(copiedTask.id, id);
    assert.equal(copiedTask.originCalendarID, forkHome.id); assert.deepEqual(copiedTask.calendarIDs, [forkHome.id]);
    assert.equal(copiedTask.capabilities?.edit, true); assert.equal(copiedTask.revision, 1);
    await waitForCreation(copiedTask.id);
    const copyRows = () => db.select().from(tasks).where(eq(tasks.originCalendarID, forkHome.id));
    assert.equal((await copyRows()).length, 1, "Retry returns the same copy rather than creating another task");
    const conflictingCopies = [
      { ...copyRequest, calendarID: mirror.id },
      { ...copyRequest, expectedRevision: 3 },
      { ...copyRequest, expectedProviderReadRetiredGeneration: 1 },
    ];
    for (const request of conflictingCopies) {
      const conflict = await send(1, "POST", `${path}/fork`, request, copyMutation);
      assert.equal(conflict.status, 409); assert.equal(conflict.body.code, "task-mutation-duplicate");
      assert.equal(JSON.stringify(conflict.body).includes(copiedTask.title), false);
    }
    assert.equal((await send(1, "POST", `/tasks/${copiedTask.id}/fork`, copyRequest, copyMutation)).status, 409);
    assert.equal((await send(2, "POST", `${path}/fork`, copyRequest, copyMutation)).status, 403,
      "A different actor cannot retrieve another actor's copy with its mutation key");
    assert.equal((await copyRows()).length, 1);
    const concurrentMutation = randomUUID();
    const concurrent = await Promise.all([
      send(1, "POST", `${path}/fork`, copyRequest, concurrentMutation),
      send(1, "POST", `${path}/fork`, copyRequest, concurrentMutation),
    ]);
    assert.deepEqual(concurrent.map(result => result.status), [201, 201]);
    assert.equal(concurrent[0].body.task.id, concurrent[1].body.task.id);
    await waitForCreation(concurrent[0].body.task.id);
    assert.equal((await copyRows()).length, 2, "Concurrent exact requests commit one additional independent copy");
    assert.equal((await db.select().from(taskMutations).where(and(eq(taskMutations.actorID, users[1]),
      eq(taskMutations.mutationID, concurrentMutation)))).length, 1);
    assert.equal((await db.select().from(taskOutbox).where(eq(taskOutbox.mutationID, copyMutation))).length, 0);

    const reopened = await send(0, "PATCH", path, { expectedRevision: 4, patch: { status: "needs-action" } });
    assert.equal(reopened.body.task.completedAt, null); assert.equal(reopened.body.task.percentComplete, 0);
    const recoveredAfterSourceChange = await send(1, "POST", `${path}/fork`, copyRequest, copyMutation);
    assert.equal(recoveredAfterSourceChange.status, 201);
    assert.equal(recoveredAfterSourceChange.body.task.id, copiedTask.id);
    assert.equal(recoveredAfterSourceChange.body.task.status, "completed", "Copy remains independent of later source changes");
    const staleTarget = await createCalendar({ creatorID: users[1], name: "Refreshed intentional copies", color: "#112233" });
    const staleMutation = randomUUID(), staleRequest = { calendarID: staleTarget.id, expectedRevision: 4 };
    const staleAttempts = await Promise.all([
      send(1, "POST", `${path}/fork`, staleRequest, staleMutation),
      send(1, "POST", `${path}/fork`, staleRequest, staleMutation),
    ]);
    for (const rejected of staleAttempts) {
      assert.equal(rejected.status, 409); assert.equal(rejected.body.code, TASK_FORK_NOT_COMMITTED_CODE);
      assert.equal(rejected.body.localCommitted, false); assert.equal(rejected.body.task, undefined);
    }
    assert.equal((await db.select().from(tasks).where(eq(tasks.originCalendarID, staleTarget.id))).length, 0);
    assert.equal((await send(1, "POST", `${path}/fork`, staleRequest, staleMutation)).body.code, TASK_FORK_NOT_COMMITTED_CODE,
      "Late original requests remain terminal noncommits");
    assert.equal((await send(1, "POST", `${path}/fork`, { ...staleRequest, expectedRevision: 5 }, staleMutation)).status, 409,
      "Fresh payload requires a fresh intentional key after the terminal proof");
    const intentionalCopy = await send(1, "POST", `${path}/fork`, { ...staleRequest, expectedRevision: 5 }, randomUUID());
    assert.equal(intentionalCopy.status, 201, JSON.stringify(intentionalCopy.body));
    assert.equal(intentionalCopy.body.task.status, "needs-action");
    assert.equal((await db.select().from(tasks).where(eq(tasks.originCalendarID, staleTarget.id))).length, 1);
    const unlink = await send(1, "DELETE", path, { expectedRevision: 5, unlinkCalendarID: mirror.id });
    assert.equal(unlink.status, 200); assert.equal(TaskDeleteResponseSchema.parse(unlink.body).removed, false);
    assert.equal(unlink.body.task, null, "Last readable unlink does not return private home content");
    assert.equal((await send(1, "GET", path)).status, 404); assert.equal((await getTaskSnapshot(id))?.deletedAt, null);
    const recoveredWithoutSourceAccess = await send(1, "POST", `${path}/fork`, copyRequest, copyMutation);
    assert.equal(recoveredWithoutSourceAccess.status, 201);
    assert.equal(recoveredWithoutSourceAccess.body.task.id, copiedTask.id,
      "A legitimate independent copy uses its own current read permissions");
    const privateCopyMirror = await createCalendar({ creatorID: users[0], name: "Private copied membership", color: "#112233" });
    await db.insert(calendarMembers).values({ userID: users[1], calendarID: privateCopyMirror.id, role: "editor" });
    assert.equal((await send(1, "POST", `/tasks/${copiedTask.id}/link`, {
      expectedRevision: 1, calendarID: privateCopyMirror.id,
    })).status, 200);
    await db.delete(calendarMembers).where(and(eq(calendarMembers.userID, users[1]), eq(calendarMembers.calendarID, privateCopyMirror.id)));
    const filteredReplay = await send(1, "POST", `${path}/fork`, copyRequest, copyMutation);
    assert.equal(filteredReplay.status, 201);
    assert.deepEqual(filteredReplay.body.task.calendarIDs, [forkHome.id], "Replay filters current private membership links");
    await db.delete(calendarMembers).where(and(eq(calendarMembers.userID, users[1]), eq(calendarMembers.calendarID, forkHome.id)));
    const hiddenReplay = await send(1, "POST", `${path}/fork`, copyRequest, copyMutation);
    assert.equal(hiddenReplay.status, 201); assert.equal(hiddenReplay.body.localCommitted, true); assert.equal(hiddenReplay.body.task, null);
    const hiddenBody = JSON.stringify(hiddenReplay.body);
    for (const secret of [copiedTask.title, "Preserve this", home.id, privateCopyMirror.id, "Private copied membership"])
      assert.equal(hiddenBody.includes(secret), false, "Permission loss must reveal no copy content or private source memberships");
    assert.equal((await copyRows()).length, 2, "Revoked read rights never cause another copy to be created");
    assert.equal((await send(0, "GET", `${path}/delivery`)).body.targets.length, 0);
    assert.deepEqual((await send(0, "GET", "/task-deliveries")).body, { items: [], nextCursor: null });
    assert.equal((await send(0, "GET", "/task-deliveries?cursor=invalid")).status, 400);
    const reconciledID = randomUUID();
    assert.equal((await send(0, "POST", "/tasks", { id: reconciledID, calendarID: home.id, title: "Postcommit" })).status, 201);
    const pool = db.$client, originalQuery = pool.query.bind(pool);
    let failedRead = false;
    (pool as any).query = async (config: any, ...args: any[]) => {
      const statement = typeof config === "string" ? config : config.text;
      if (statement.includes('from "tasks" inner join "calendar_tasks"')) {
        const result = await originalQuery('select revision from tasks where id = $1', [reconciledID]);
        if (result.rows[0]?.revision === 2) { failedRead = true; throw new Error("Injected postcommit read outage"); }
      }
      return (originalQuery as any)(config, ...args);
    };
    try {
      const response = await send(0, "PATCH", `/tasks/${reconciledID}`, { expectedRevision: 1, patch: { title: "Committed locally" } });
      assert.equal(response.status, 200); assert.equal(response.body.localCommitted, true);
      assert.equal(response.body.task, null); assert.equal(failedRead, true);
    } finally { pool.query = originalQuery; }
    assert.equal((await getTaskSnapshot(reconciledID))?.title, "Committed locally");
    const deleted = await send(0, "DELETE", path, { expectedRevision: 6 });
    assert.equal(deleted.status, 200); assert.equal(deleted.body.removed, true); assert.equal(deleted.body.revision, 7);
    assert.equal((await send(0, "GET", path)).status, 404);
    assert.ok((await getTaskSnapshot(id))?.deletedAt);
    assert.equal(creationCount(copiedTask.id), 1, "Exact fork replays never emit another task_created notification");
    assert.equal(creationCount(concurrent[0].body.task.id), 1, "Concurrent duplicate recovery does not emit another creation");
    console.log("Authenticated shared tasks: home permissions, filtered memberships, CAS race, copy idempotence, unlink privacy, completion and tombstone OK");
  } finally {
    streamAbort.abort();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await captureStream;
    await db.delete(user).where(inArray(user.id, users));
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
