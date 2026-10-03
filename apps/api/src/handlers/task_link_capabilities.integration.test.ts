import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";
import { db, user, createCalendar, importExternalCalendar, createTask, linkTask, forkTask,
  getTaskSnapshot, getExternalLinkForCalendar, getTaskDeliveryStatus, requestTaskDeliveryRetry, TaskDeliveryRetryError,
  replaceMemberToken, calendarTasks, externalTasks, taskOutbox, unlinkTask } from "@musubi/db";
import { CLIENT_VERSION_HEADER, PRODUCT_VERSION, CalendarSchema } from "@musubi/types";
import { issueMemberToken } from "../federation_tokens";
import { registerTaskRoutes } from "../task_routes";
import { requireAuth } from "../middleware/require_auth";
import { middlewareErrorHandler } from "../middleware/error_handler";
import { handlerGetCalendars } from "./calendars";
import { deliverTaskOutbox } from "../sync/task_delivery";
import { ProviderTaskWriteError } from "../sync/task_write";
import type { CalendarAdapter } from "../sync/adapter";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Use only a disposable test database.");
  const actor = `task-link-qa-${randomUUID()}`, token = issueMemberToken();
  await db.insert(user).values({ id: actor, name: "Task link QA", email: `${actor}@example.test`, isExternal: true });
  await replaceMemberToken(actor, token.tokenHash);
  const app = express(); app.use(express.json()); registerTaskRoutes(app);
  app.get("/api/v1/calendars", requireAuth, handlerGetCalendars); app.use(middlewareErrorHandler);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${token.raw}`,
      [CLIENT_VERSION_HEADER]: PRODUCT_VERSION, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const home = await createCalendar({ creatorID: actor, name: "Home", color: "#B3A48A" });
    const ms = await importExternalCalendar("microsoft", actor, "task-link-account", "Tasks", { externalId: "task-list", name: "To Do", color: "#B3A48A", supportsTasks: true, supportsEvents: false });
    const source = await createTask({ id: randomUUID(), creatorID: actor, calendarID: home.id, title: "Live task" });
    const list = await request("GET", "/api/v1/calendars"); assert.equal(list.status, 200);
    const calendars = list.body.map((item: unknown) => CalendarSchema.parse(item));
    assert.equal(calendars.find((item: { id: string }) => item.id === ms.id).supportsTaskLinks, false);
    assert.equal(calendars.find((item: { id: string }) => item.id === home.id).supportsTaskLinks, true);
    const denied = await request("POST", `/api/v1/task-mutations/${source.id}/link`, { calendarID: ms.id, expectedRevision: 1 });
    assert.equal(denied.status, 403); assert.match(denied.body.error, /independent copy/);
    assert.deepEqual((await getTaskSnapshot(source.id))!.calendars, [home.id]);
    assert.equal((await getTaskSnapshot(source.id))!.revision, 1);
    assert.equal((await db.select().from(taskOutbox).where(eq(taskOutbox.taskID, source.id))).length, 0);
    await assert.rejects(() => linkTask(source.id, ms.id, { actorID: actor, mutationID: randomUUID(), expectedRevision: 1 }), /does not support live task links/);
    assert.deepEqual((await getTaskSnapshot(source.id))!.calendars, [home.id]);
    const copy = await forkTask(source.id, { id: randomUUID(), calendarID: ms.id }, { actorID: actor, mutationID: randomUUID(), expectedRevision: 1 });
    assert.ok(copy); assert.notEqual(copy.id, source.id); assert.equal(copy.originCalendarID, ms.id);
    assert.deepEqual(copy.calendars, [ms.id], "An independent Microsoft copy has its own home, never a secondary live projection");
    // Simulate an earlier release's already-created secondary membership.
    await db.insert(calendarTasks).values({ taskID: source.id, calendarID: ms.id });
    const external = await getExternalLinkForCalendar(ms.id);
    await db.insert(externalTasks).values({ externalCalendarLinkID: external!.id, provider: "microsoft", taskID: source.id, calendarID: ms.id, externalCalendarID: "task-list", externalTaskID: "legacy-copy", accountID: "task-link-account", etag: '"legacy-version"' });
    await unlinkTask(source.id, ms.id, { actorID: actor, mutationID: randomUUID(), expectedRevision: 1 });
    const [outbox] = await db.select().from(taskOutbox).where(eq(taskOutbox.taskID, source.id));
    assert.ok(outbox); assert.equal(outbox.action, "delete");
    let mutations = 0;
    const adapter = { projectTask: () => ({}), readTask: async () => ({ ref: { externalTaskId: "legacy-copy", etag: '"legacy-version"' }, projection: {} }),
      assertTaskWrite: async () => { throw new ProviderTaskWriteError("task-conditional-write-unsupported"); },
      pushTaskCreate: async () => { mutations++; }, pushTaskUpdate: async () => { mutations++; }, pushTaskDelete: async () => { mutations++; } } as unknown as CalendarAdapter;
    await deliverTaskOutbox(outbox.id, () => adapter);
    assert.equal(mutations, 0, "Remediation never uses an unverified remote mutation");
    const status = await getTaskDeliveryStatus(actor, source.id);
    assert.equal(status.targets.find(target => target.calendarId === ms.id)?.issue, "write-unsupported");
    await assert.rejects(() => requestTaskDeliveryRetry(actor, source.id, outbox.id), TaskDeliveryRetryError);
    assert.deepEqual((await getTaskSnapshot(source.id))!.calendars, [home.id]);
    console.log("Task link capabilities: actual route/DB precommit rejection, independent copies and safe legacy unlink receipts OK");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.delete(taskOutbox).where(eq(taskOutbox.actorID, actor));
    await db.delete(user).where(eq(user.id, actor));
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
