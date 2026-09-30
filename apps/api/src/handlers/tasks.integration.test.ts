import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db, user, calendarMembers, createCalendar, replaceMemberToken, getTaskSnapshot } from "@musubi/db";
import { CLIENT_VERSION_HEADER, PRODUCT_VERSION, TaskSchema, TaskMutationResponseSchema, TaskDeleteResponseSchema, type Task } from "@musubi/types";
import { issueMemberToken } from "../federation_tokens";
import { requireAuth } from "../middleware/require_auth";
import { middlewareErrorHandler } from "../middleware/error_handler";
import { handlerCreateTask, handlerGetTask, handlerGetTasks, handlerUpdateTask, handlerRemoveTask, handlerLinkTask, handlerForkTask } from "./tasks";
import { handlerGetTaskDeliveryInbox, handlerGetTaskDelivery, handlerRetryTaskDelivery } from "./task_delivery";

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
  app.get("/tasks", requireAuth, handlerGetTasks);
  app.post("/tasks", requireAuth, handlerCreateTask);
  app.get("/tasks/:taskId", requireAuth, handlerGetTask);
  app.patch("/tasks/:taskId", requireAuth, handlerUpdateTask);
  app.put("/tasks/:taskId", requireAuth, handlerUpdateTask);
  app.delete("/tasks/:taskId", requireAuth, handlerRemoveTask);
  app.post("/tasks/:taskId/link", requireAuth, handlerLinkTask);
  app.post("/tasks/:taskId/fork", requireAuth, handlerForkTask);
  app.get("/task-deliveries", requireAuth, handlerGetTaskDeliveryInbox);
  app.get("/tasks/:taskId/delivery", requireAuth, handlerGetTaskDelivery);
  app.post("/tasks/:taskId/delivery/:operationId/retry", requireAuth, handlerRetryTaskDelivery);
  app.use(middlewareErrorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const send = async (actor: number, method: string, path: string, body?: unknown, mutationID?: string) => {
    const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${tokens[actor].raw}`,
      [CLIENT_VERSION_HEADER]: PRODUCT_VERSION, "content-type": "application/json", ...(mutationID ? { "Idempotency-Key": mutationID } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
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
    const copyMutation = randomUUID();
    const copy = await send(1, "POST", `${path}/fork`, { expectedRevision: 4, calendarID: forkHome.id }, copyMutation);
    assert.equal(copy.status, 201); assert.notEqual(copy.body.task.id, id); assert.equal(copy.body.task.originCalendarID, forkHome.id);
    assert.equal(copy.body.task.capabilities.edit, true); assert.equal(copy.body.task.revision, 1);
    assert.equal((await send(1, "POST", `${path}/fork`, { expectedRevision: 4, calendarID: forkHome.id }, copyMutation)).status, 409);
    const reopened = await send(0, "PATCH", path, { expectedRevision: 4, patch: { status: "needs-action" } });
    assert.equal(reopened.body.task.completedAt, null); assert.equal(reopened.body.task.percentComplete, 0);
    const unlink = await send(1, "DELETE", path, { expectedRevision: 5, unlinkCalendarID: mirror.id });
    assert.equal(unlink.status, 200); assert.equal(TaskDeleteResponseSchema.parse(unlink.body).removed, false);
    assert.equal(unlink.body.task, null, "Last readable unlink does not return private home content");
    assert.equal((await send(1, "GET", path)).status, 404); assert.equal((await getTaskSnapshot(id))?.deletedAt, null);
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
    console.log("Authenticated shared tasks: home permissions, filtered memberships, CAS race, copy idempotence, unlink privacy, completion and tombstone OK");
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await db.delete(user).where(inArray(user.id, users));
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
