import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, user, calendarMembers, externalCalendars, taskOutbox, createCalendar,
  createTask, linkTask, getTaskDeliveryStatus, getTaskDeliveryInbox, requestTaskDeliveryRetry,
  TaskDeliveryRetryError, unlinkTask } from "..";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Use only a disposable PostgreSQL database.");
  const owner = `task-receipt-owner-${randomUUID()}`, collaborator = `task-receipt-reader-${randomUUID()}`, outsider = `task-receipt-outsider-${randomUUID()}`;
  const ids = [owner, collaborator, outsider];
  for (const id of ids) await db.insert(user).values({ id, name: id, email: `${id}@example.test` });
  try {
    const home = await createCalendar({ creatorID: owner, name: "Private home", color: "#112233" });
    const shared = await createCalendar({ creatorID: collaborator, name: "Readable mirror", color: "#112233" });
    const privateMirror = await createCalendar({ creatorID: owner, name: "Secret provider", color: "#112233" });
    await db.insert(calendarMembers).values({ userID: collaborator, calendarID: home.id, role: "viewer" });
    const sources = await db.insert(externalCalendars).values([
      { provider: "google", userID: owner, accountID: "private-account", calendarID: home.id, externalCalendarID: "private-list", supportsTasks: true, supportsEvents: false },
      { provider: "google", userID: collaborator, accountID: "shared-account", calendarID: shared.id, externalCalendarID: "shared-list", supportsTasks: true, supportsEvents: false },
      { provider: "google", userID: owner, accountID: "other-account", calendarID: privateMirror.id, externalCalendarID: "secret-list", supportsTasks: true, supportsEvents: false },
    ]).returning();
    const task = await createTask({ id: randomUUID(), creatorID: owner, calendarID: home.id, title: "Current readable work", description: "Never in a receipt" });
    await linkTask(task.id, shared.id, { actorID: collaborator, mutationID: randomUUID(), expectedRevision: 1 });
    await linkTask(task.id, privateMirror.id, { actorID: owner, mutationID: randomUUID(), expectedRevision: 2 });
    await db.delete(calendarMembers).where(and(eq(calendarMembers.calendarID, home.id), eq(calendarMembers.userID, collaborator)));
    const readable = await getTaskDeliveryStatus(collaborator, task.id);
    assert.deepEqual(readable.targets.map(row => row.calendarId), [shared.id]);
    assert.equal(readable.localRevision, 3);
    assert.equal(JSON.stringify(readable).includes("private-account"), false);
    assert.equal(JSON.stringify(readable).includes("private-list"), false);
    assert.equal(JSON.stringify(readable).includes("Never in a receipt"), false);
    await assert.rejects(() => getTaskDeliveryStatus(outsider, task.id), /Task not found/);
    assert.deepEqual((await getTaskDeliveryInbox(outsider)).items, []);
    assert.deepEqual((await getTaskDeliveryInbox(collaborator)).items, [{ taskId: task.id, savedTitle: task.title }]);
    const [receipt] = await db.select().from(taskOutbox).where(and(eq(taskOutbox.taskID, task.id), eq(taskOutbox.externalCalendarLinkID, sources[1].id)));
    await db.update(taskOutbox).set({ status: "blocked", errorCode: "provider-write-denied", uncertain: false }).where(eq(taskOutbox.id, receipt.id));
    assert.equal(await requestTaskDeliveryRetry(collaborator, task.id, receipt.id), receipt.id);
    assert.equal((await db.select().from(taskOutbox).where(eq(taskOutbox.id, receipt.id)))[0].status, "retry");
    await db.update(taskOutbox).set({ status: "unconfirmed", uncertain: true }).where(eq(taskOutbox.id, receipt.id));
    await assert.rejects(() => requestTaskDeliveryRetry(collaborator, task.id, receipt.id), TaskDeliveryRetryError);
    assert.equal((await db.select().from(taskOutbox).where(eq(taskOutbox.id, receipt.id)))[0].status, "unconfirmed", "Uncertain CREATE is never replayed by Retry");
    await db.update(taskOutbox).set({ status: "conflict", uncertain: false, remoteSnapshot: { private: "Remote body" } }).where(eq(taskOutbox.id, receipt.id));
    await assert.rejects(() => requestTaskDeliveryRetry(collaborator, task.id, receipt.id), TaskDeliveryRetryError);
    assert.equal(JSON.stringify(await getTaskDeliveryStatus(collaborator, task.id)).includes("Remote body"), false);
    await db.update(taskOutbox).set({ status: "blocked", remoteSnapshot: null, errorCode: "task-conditional-write-unsupported" }).where(eq(taskOutbox.id, receipt.id));
    await assert.rejects(() => requestTaskDeliveryRetry(collaborator, task.id, receipt.id), TaskDeliveryRetryError);
    await db.update(externalCalendars).set({ providerAccessRevision: 1 }).where(eq(externalCalendars.id, sources[1].id));
    await db.update(taskOutbox).set({ status: "blocked", errorCode: "provider-write-denied" }).where(eq(taskOutbox.id, receipt.id));
    await assert.rejects(() => requestTaskDeliveryRetry(collaborator, task.id, receipt.id), TaskDeliveryRetryError);
    await db.update(externalCalendars).set({ disabled: true }).where(eq(externalCalendars.id, sources[1].id));
    assert.equal((await getTaskDeliveryStatus(collaborator, task.id)).localRevision, null, "Membership alone does not authorize a retired provider source");
    assert.deepEqual((await getTaskDeliveryInbox(collaborator)).items, [{ taskId: task.id, savedTitle: "Task" }]);
    await db.update(externalCalendars).set({ disabled: false }).where(eq(externalCalendars.id, sources[1].id));
    await unlinkTask(task.id, shared.id, { actorID: collaborator, mutationID: randomUUID(), expectedRevision: 3 });
    assert.equal((await getTaskDeliveryStatus(collaborator, task.id)).localRevision, null);
    assert.deepEqual((await getTaskDeliveryInbox(collaborator)).items, [{ taskId: task.id, savedTitle: "Task" }], "Retained receipts do not resurrect private content after unlink");
    await db.delete(calendarMembers).where(and(eq(calendarMembers.calendarID, shared.id), eq(calendarMembers.userID, collaborator)));
    assert.equal((await getTaskDeliveryStatus(collaborator, task.id)).targets[0].calendarName, null, "Receipt ownership does not grant current calendar-name access");
    await assert.rejects(() => requestTaskDeliveryRetry(collaborator, task.id, receipt.id), TaskDeliveryRetryError);
    console.log("Task delivery receipts: filtered targets, title authorization, retained unlink, strict retry and uncertain CREATE fences OK");
  } finally { await db.delete(user).where(inArray(user.id, ids)); }
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
