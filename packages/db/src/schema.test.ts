import assert from "node:assert/strict";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  calendarEvents,
  calendarMembers,
  calendarTasks,
  eventReminders,
  eventUsers,
  events,
  externalCalendars,
  externalTasks,
  pages,
  schedulingParticipants,
  schedulingPolls,
  schedulingVotes,
  tasks,
  taskOutbox,
  user,
  userSettings,
} from "./schema";

assert.equal(
  user.isAnonymous.default,
  false,
  "users must be ordinary accounts unless explicitly created anonymously",
);

assert.equal(
  userSettings.id.primary,
  true,
  "user_settings.id must enforce one settings row per user",
);
assert.equal(
  userSettings.revision.default,
  1,
  "user_settings.revision must start at one",
);

const calendarEventUnique = getTableConfig(
  calendarEvents,
).uniqueConstraints.find(
  (constraint) =>
    constraint.name === "calendar_events_event_id_calendar_id_unique",
);
assert.ok(
  calendarEventUnique,
  "calendar_events must reject duplicate event/calendar links",
);

assert.equal(events.revision.default, 1);
assert.equal(events.revision.notNull, true);

assert.equal(tasks.status.default, "needs-action");
assert.equal(tasks.percentComplete.default, 0);
assert.equal(tasks.priority.default, 0);
assert.equal(tasks.revision.default, 1);
assert.equal(tasks.revision.notNull, true);
assert.equal(tasks.calendarID.notNull, false, "transitional home alias survives calendar removal");
assert.equal(tasks.originCalendarID.notNull, false);
for (const key of getTableConfig(tasks).foreignKeys) {
  const columns = key.reference().columns.map((column) => column.name);
  if (columns.includes("calendar_id") || columns.includes("origin_calendar_id"))
    assert.equal(key.onDelete, "set null", "home deletion must not hard-delete shared identity");
}
assert.deepEqual(getTableConfig(calendarTasks).primaryKeys[0].columns.map((column) => column.name),
  ["task_id", "calendar_id"], "one membership per task/calendar");
assert.ok(getTableConfig(calendarTasks).indexes.some((i) => i.config.name === "calendar_tasks_calendar_task_idx"));
assert.deepEqual(getTableConfig(taskOutbox).foreignKeys.flatMap((key) => key.reference().columns.map((c) => c.name)),
  ["user_id"], "delivery addresses must outlive source/task/calendar deletion");
assert.ok(getTableConfig(taskOutbox).uniqueConstraints.some((c) => c.name === "task_outbox_mutation_position_unique"));
assert.equal(externalCalendars.supportsEvents.default, true);
assert.equal(externalCalendars.supportsTasks.default, false);

const externalTaskUnique = getTableConfig(externalTasks).uniqueConstraints.find(
  (constraint) =>
    constraint.name === "external_tasks_provider_calendar_external_task_unique",
);
assert.ok(
  externalTaskUnique,
  "external_tasks must reject duplicate resources within one mirror",
);
assert.deepEqual(
  calendarEventUnique.columns.map((column) => column.name),
  ["event_id", "calendar_id"],
);

assert.equal(
  pages.revision.default,
  1,
  "pages.revision must start at one for compare-and-swap saves",
);
assert.equal(
  pages.config.notNull,
  true,
  "pages.config must always hold a versioned document",
);
assert.equal(
  schedulingPolls.approximateStartTime.notNull,
  false,
  "a poll's approximate start must stay optional",
);
assert.equal(schedulingPolls.ownerEmail.notNull, true);
assert.equal(schedulingPolls.ownerName.notNull, true);
assert.equal(schedulingPolls.ownerID.notNull, false);
assert.ok(
  getTableConfig(schedulingParticipants).uniqueConstraints.some(
    (constraint) =>
      constraint.name === "scheduling_participants_poll_email_unique",
  ),
  "one email must identify at most one participant in a poll",
);
assert.ok(
  getTableConfig(schedulingVotes).uniqueConstraints.some(
    (constraint) =>
      constraint.name === "scheduling_votes_slot_participant_unique",
  ),
  "a participant must have at most one answer per slot",
);
assert.equal(
  eventUsers.status.notNull,
  true,
  "an attendee row must always say which answer it is",
);
assert.equal(
  eventUsers.status.default,
  "going",
  "membership rows that predate answers mean 'going'",
);

const pagesPositionIndex = getTableConfig(pages).indexes.find(
  (index) => index.config.name === "pages_user_position_idx",
);
assert.ok(pagesPositionIndex, "pages must be orderable per user by position");

console.log("database schema invariant self-check: OK");

// ── Reminders ────────────────────────────────────────────────────────────────

assert.equal(
  userSettings.timezone.default,
  "UTC",
  "an account with no reported zone must still resolve all-day reminders",
);
assert.equal(
  userSettings.defaultReminder.notNull,
  true,
  "the bottom of the inheritance chain has nothing to fall back to",
);

assert.equal(
  calendarMembers.reminder.notNull,
  false,
  "a null calendar rule is how a membership says 'inherit'",
);

assert.ok(
  getTableConfig(eventReminders).uniqueConstraints.some((constraint) =>
    ["event_id", "user_id"].every((column) =>
      constraint.columns.some((c) => c.name === column),
    ),
  ),
  "one override per person per event, so a repeated PUT updates rather than piles up",
);
