import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mock } from "node:test";
import { eq } from "drizzle-orm";
import { TaskSchema } from "@musubi/types";
import { db, user, calendars, calendarMembers, calendarTasks, tasks, externalCalendars, taskOutbox, type TaskOutboxRow } from "@musubi/db";
import type { CalendarAdapter, TaskReadEvidence } from "./adapter";
import { deliverTaskOutbox } from "./task_delivery";
import { canonicalTaskProjection, ProviderTaskWriteError } from "./task_write";
import { prepareTaskWrites } from "./engine";
import { googleAdapter } from "./adapters/google";
import { DELIVERY_ATTEMPT_TIMEOUT_MS } from "./delivery_policy";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Use a disposable test database");
  const owner = `delivery-${randomUUID()}`, calendar = randomUUID();
  await db.insert(user).values({ id: owner, name: "Delivery fixture", email: `${owner}@example.test` });
  await db.insert(calendars).values({ id: calendar, creatorID: owner, name: "Delivery", color: "#112233" });
  await db.insert(calendarMembers).values({ calendarID: calendar, userID: owner, role: "owner" });
  const [source] = await db.insert(externalCalendars).values({ calendarID: calendar, provider: "google", userID: owner, accountID: owner, externalCalendarID: "fixture-list", supportsEvents: false, supportsTasks: true }).returning();
  let mode: "normal" | "preflight-hang" | "create-hang" | "observe-hang" | "429" | "observe-429" | "late-preflight" | "preflight-401" = "normal";
  let creates = 0, reads = 0;
  let activeSignal: AbortSignal | undefined;
  let expire: (() => void) | undefined;
  let resumePreflight: (() => void) | undefined;
  const remote = new Map<string, TaskReadEvidence>();
  const hang = async (signal?: AbortSignal): Promise<never> => {
    assert.ok(signal, "executor must pass its deadline to provider transport");
    activeSignal = signal;
    setImmediate(() => expire!());
    return new Promise<never>(() => {}); // deliberately ignores abort
  };
  const adapter = {
    projectTask: canonicalTaskProjection,
    async assertTaskWrite(_u, _a, _c, operation) {
      if (mode === "preflight-401") throw new ProviderTaskWriteError("task-write-failed", "not-written", 401);
      if (mode === "preflight-hang") return hang(operation.signal);
      if (mode === "late-preflight") {
        activeSignal = operation.signal;
        setImmediate(() => expire!());
        await new Promise<void>(resolve => { resumePreflight = resolve; });
      }
    },
    async readTask(_u, _a, _c, ref, signal) {
      reads++;
      if (mode === "observe-hang") return hang(signal);
      if (mode === "observe-429") throw new ProviderTaskWriteError("task-write-failed", "not-written", 429, 90_000);
      return remote.get(ref.externalTaskId) ?? null;
    },
    async pushTaskCreate(_u, _a, _c, task, mark, signal) {
      await mark?.(); creates++;
      if (mode === "429") throw new ProviderTaskWriteError("task-write-failed", "not-written", 429, 90_000);
      const ref = { externalTaskId: `native-${task.id}`, etag: '"v1"' };
      remote.set(ref.externalTaskId, { ref, projection: canonicalTaskProjection(task) });
      if (mode === "create-hang") return hang(signal);
      return ref;
    },
    async pushTaskUpdate() { throw new Error("Unexpected update"); },
    async pushTaskDelete() { throw new Error("Unexpected delete"); },
  } satisfies Partial<CalendarAdapter>;
  const adapterFor = () => adapter as unknown as CalendarAdapter;
  const enqueue = async () => {
    const [task] = await db.insert(tasks).values({ id: randomUUID(), creatorID: owner, calendarID: calendar, originCalendarID: calendar, title: "Fixture", status: "needs-action" }).returning();
    await db.insert(calendarTasks).values({ taskID: task.id, calendarID: calendar });
    const id = randomUUID();
    await db.insert(taskOutbox).values({ id, actorID: owner, mutationID: randomUUID(), position: 0, taskID: task.id, revision: task.revision, calendarID: calendar, externalCalendarLinkID: source.id, provider: "google", userID: owner, accountID: owner, externalCalendarID: source.externalCalendarID, providerAccessRevision: source.providerAccessRevision, retiredGeneration: 0, action: "create", payload: { task: TaskSchema.parse({ ...task, calendarIDs: [calendar] }) } });
    return id;
  };
  const due = (id: string) => db.update(taskOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(taskOutbox.id, id));
  const deadlineMs = 123_457;
  const realSetTimeout = globalThis.setTimeout;
  const timer = mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay === deadlineMs || delay === DELIVERY_ATTEMPT_TIMEOUT_MS) {
      expire = () => callback(...args);
      return realSetTimeout(callback, 20_000, ...args);
    }
    return realSetTimeout(callback, delay, ...args);
  });
  const deliver = (id: string) => deliverTaskOutbox(id, adapterFor, { timeoutMs: deadlineMs });
  const released = (row: TaskOutboxRow | undefined) => { assert.equal(row?.leaseToken, null); assert.equal(row?.leaseUntil, null); };
  try {
    const preview = await enqueue();
    const [previewRow] = await db.select().from(taskOutbox).where(eq(taskOutbox.id, preview));
    const previewTransport = googleAdapter.assertTaskWrite;
    googleAdapter.assertTaskWrite = async (_u, _a, _c, operation) => hang(operation.signal);
    try {
      const prepared = await prepareTaskWrites(TaskSchema.parse(previewRow!.payload.task), [{ calendarID: calendar, action: "create" }]);
      assert.equal(prepared[0]?.providerProjection?.errorCode, "task-write-failed");
      assert.equal(activeSignal?.aborted, true, "pre-admission permission check receives the bounded signal");
      assert.equal(creates, 0);
    } finally { googleAdapter.assertTaskWrite = previewTransport; }

    mode = "preflight-hang";
    const before = await enqueue();
    const pending = await deliver(before);
    assert.equal(pending?.status, "retry");
    assert.equal(pending?.uncertain, false);
    assert.equal(activeSignal?.aborted, true);
    assert.equal(creates, 0);
    released(pending);
    mode = "normal";
    await due(before);
    assert.equal((await deliver(before))?.status, "completed", "pre-dispatch timeout can safely recover");

    mode = "create-hang";
    const unknown = await enqueue();
    assert.equal((await deliver(unknown))?.status, "unconfirmed");
    const createdBeforeRecovery = creates;
    mode = "normal";
    await due(unknown);
    assert.equal((await deliver(unknown))?.status, "unconfirmed");
    assert.equal(creates, createdBeforeRecovery, "unknown Google CREATE cannot be blindly repeated");

    mode = "observe-hang";
    const known = await enqueue();
    const accepted = await deliver(known);
    assert.equal(accepted?.status, "unconfirmed");
    assert.ok(accepted?.resultRef?.externalTaskId, "keep response identity when verification times out");
    released(accepted);
    const acceptedCreates = creates;
    mode = "normal";
    await due(known);
    assert.equal((await deliver(known))?.status, "completed");
    assert.equal(creates, acceptedCreates, "known CREATE recovery observes without another POST");

    mode = "preflight-401";
    const auth = await enqueue();
    const authCreates = creates;
    assert.equal((await deliver(auth))?.status, "retry", "resource 401 is not proof of permanent grant loss");
    assert.equal(creates, authCreates);

    mode = "429";
    const throttled = await enqueue();
    const retry = await deliver(throttled);
    assert.equal(retry?.status, "retry");
    assert.equal(retry?.uncertain, false);
    assert.ok(retry!.nextAttemptAt.getTime() >= Date.now() + 89_000);
    released(retry);

    mode = "observe-429";
    const postRead = await enqueue();
    const postReadFailure = await deliver(postRead);
    assert.equal(postReadFailure?.status, "unconfirmed", "failed GET does not undo a successful POST");
    assert.equal(postReadFailure?.uncertain, true);
    assert.ok(postReadFailure!.nextAttemptAt.getTime() >= Date.now() + 89_000);

    mode = "late-preflight";
    const late = await enqueue();
    assert.equal((await deliver(late))?.status, "retry");
    const lateCreates = creates;
    resumePreflight!();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(creates, lateCreates, "late preflight cannot pass the mutation fence after deadline");

    mode = "normal";
    const crashed = await enqueue();
    await db.update(taskOutbox).set({ status: "attempting", leaseToken: randomUUID(), leaseUntil: new Date(0) }).where(eq(taskOutbox.id, crashed));
    const crashCreates = creates;
    assert.equal((await deliver(crashed))?.status, "unconfirmed");
    assert.equal(creates, crashCreates, "restart treats expired CREATE lease as unknown, never a fresh write");
    assert.ok(reads > 0);
    console.log("task delivery PostgreSQL: deadlines, aborted transports, released leases, throttling, late dispatch fence and restart/create observation passed");
  } finally {
    timer.mock.restore();
    await db.delete(user).where(eq(user.id, owner));
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
