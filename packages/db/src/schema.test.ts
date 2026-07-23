import assert from "node:assert/strict";
import { getTableConfig } from "drizzle-orm/pg-core";
import { calendarEvents, userSettings } from "./schema";

assert.equal(
  userSettings.id.primary,
  true,
  "user_settings.id must enforce one settings row per user",
);

const calendarEventUnique = getTableConfig(calendarEvents).uniqueConstraints.find(
  (constraint) => constraint.name === "calendar_events_event_id_calendar_id_unique",
);
assert.ok(
  calendarEventUnique,
  "calendar_events must reject duplicate event/calendar links",
);
assert.deepEqual(
  calendarEventUnique.columns.map((column) => column.name),
  ["event_id", "calendar_id"],
);

console.log("database schema invariant self-check: OK");
