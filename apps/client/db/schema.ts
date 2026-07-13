import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const notificationsTable = sqliteTable("notifications_table", {
  id: int().primaryKey({ autoIncrement: true }),
  identifier: text().notNull(),
  eventID: text().notNull(),
  triggerDate: text(),
  // "notify N minutes before" — kept so remote event changes can reschedule
  // with the user's original choice
  offsetMinutes: int().notNull().default(15),
});

// Local cache of events (full mirror). Dates stored as ISO text; calendars as
// a JSON string[]. Booleans as int (0/1).
export const eventsTable = sqliteTable("events", {
  id: text().primaryKey(),
  creatorID: text().notNull(),
  title: text().notNull(),
  color: text().notNull(),
  start: text().notNull(),
  end: text().notNull(),
  isAllDay: int({ mode: "boolean" }).notNull().default(false),
  description: text(),
  location: text(),
  isCanceled: int({ mode: "boolean" }).notNull().default(false),
  hasAttendees: int({ mode: "boolean" }).notNull().default(false),
  organizer: text().notNull(),
  recurrence: text(),
  url: text(),
  calendars: text().notNull(), // JSON string[]
  originCalendarID: text(),
});

// key/value for sync bookkeeping (e.g. lastSync = server time of last delta).
export const syncMetaTable = sqliteTable("sync_meta", {
  key: text().primaryKey(),
  value: text().notNull(),
});
