import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { EventSchema, TaskSchema } from "@musubi/types";
import { db, user, eventOutbox, taskOutbox, getDueEventOutboxIDs, getDueTaskOutboxIDs } from "@musubi/db";
import { boundedOutboxRows, loadOutboxSnapshot, type OutboxMetricRow } from "./metrics";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Run only against a disposable test database.");
  const owner = randomUUID();
  const provider = `metrics-fixture-${randomUUID()}`;
  const calendarID = randomUUID();
  const now = Date.now();
  const ago = (seconds: number) => new Date(now - seconds * 1000);
  const event = EventSchema.parse({ id: randomUUID(), creatorID: owner, title: "Private event title", color: "#112233", organizer: owner,
    start: ago(600), end: ago(300), isAllDay: false, isCanceled: false, calendars: [calendarID], originCalendarID: calendarID });
  const task = TaskSchema.parse({ id: randomUUID(), creatorID: owner, title: "Private task title", calendarID });
  await db.insert(user).values({ id: owner, name: "Private metric fixture", email: `${owner}@example.test` });
  try {
    const common = () => ({ id: randomUUID(), actorID: owner, mutationID: randomUUID(), position: 0, revision: 1,
      calendarID, externalCalendarLinkID: randomUUID(), provider, userID: owner, accountID: "private-account", externalCalendarID: "private-calendar",
      action: "create" as const, createdAt: ago(600), nextAttemptAt: ago(120) });
    const fixtures = () => {
      const blocked = { ...common(), status: "blocked" as const, createdAt: ago(7200) };
      const completed = { ...common(), status: "completed" as const };
      return [
        { ...common(), status: "pending" as const },
        { ...common(), status: "retry" as const, nextAttemptAt: ago(-120), createdAt: ago(3600) },
        { ...common(), status: "attempting" as const, leaseUntil: ago(-600), nextAttemptAt: ago(300) },
        { ...common(), status: "attempting" as const, leaseUntil: ago(1), nextAttemptAt: ago(180) },
        blocked,
        { ...common(), status: "conflict" as const },
        { ...common(), status: "pending" as const, predecessorID: blocked.id, nextAttemptAt: ago(999) },
        { ...common(), status: "pending" as const, predecessorID: completed.id, nextAttemptAt: ago(60) },
        completed,
        { ...common(), status: "cancelled" as const },
        { ...common(), status: "not-needed" as const },
        { ...common(), status: "unconfirmed" as const, nextAttemptAt: ago(240) },
        { ...common(), status: "not-written" as const },
      ];
    };
    const eventFixtures = fixtures();
    const taskFixtures = fixtures();
    await db.insert(eventOutbox).values(eventFixtures.map(row => ({ ...row, eventID: event.id, payload: { event } })));
    await db.insert(taskOutbox).values(taskFixtures.map(row => ({ ...row, taskID: task.id, providerAccessRevision: 0, payload: { task } })));
    const snapshot = await loadOutboxSnapshot();
    const verify = (allRows: OutboxMetricRow[]) => {
      const rows = allRows.filter(row => row.provider === provider);
      assert.equal(rows.reduce((n, row) => n + row.count, 0), 10, "terminal work is excluded from unresolved counts");
      const row = (status: string) => {
        const found = rows.find(row => row.status === status);
        assert.ok(found);
        return found;
      };
      assert.equal(row("pending").count, 3);
      assert.equal(row("pending").dueCount, 2, "causally blocked successor is excluded");
      assert.ok(row("pending").dueLagSeconds >= 120 && row("pending").dueLagSeconds < 150, "blocked successor cannot inflate due lag");
      assert.equal(row("attempting").count, 2);
      assert.equal(row("attempting").dueCount, 1, "active lease is excluded, expired lease is eligible");
      assert.ok(row("attempting").dueLagSeconds >= 180 && row("attempting").dueLagSeconds < 210);
      assert.equal(row("retry").dueCount, 0, "future retry is not due");
      assert.equal(row("retry").dueLagSeconds, 0);
      assert.ok(row("retry").ageSeconds >= 3600, "queue age survives future retry scheduling");
      assert.equal(row("blocked").dueCount, 0);
      assert.ok(row("blocked").ageSeconds >= 7200, "manual-resolution queue retains accepted age");
      assert.equal(row("unconfirmed").dueCount, 1, "observation recovery is eligible without replay");
      assert.ok(!JSON.stringify(rows).includes("Private"), "aggregate snapshot never returns payload content");
      assert.ok(!JSON.stringify(boundedOutboxRows(rows)).includes(provider), "unknown provider labels are bounded");
      return rows.reduce((n, row) => n + row.dueCount, 0);
    };
    const dueEvents = await getDueEventOutboxIDs(1000);
    const dueTasks = await getDueTaskOutboxIDs(1000);
    const eventIDs = new Set<string>(eventFixtures.map(row => row.id));
    const taskIDs = new Set<string>(taskFixtures.map(row => row.id));
    assert.equal(verify(snapshot.eventRows), dueEvents.filter(row => eventIDs.has(row.id)).length, "event due metrics and claim query agree");
    assert.equal(verify(snapshot.taskRows), dueTasks.filter(row => taskIDs.has(row.id)).length, "task due metrics and claim query agree");
    console.log("outbox PostgreSQL metrics: age, due lag, leases, retry scheduling, causal barriers and terminal filtering passed");
  } finally {
    await db.delete(user).where(eq(user.id, owner));
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
