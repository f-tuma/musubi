import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const notificationsTable = sqliteTable("notifications_table", {
  id: int().primaryKey({ autoIncrement: true }),
  identifier: text().notNull(),
  eventID: text().notNull(),
  trigerDate: text().notNull(),
});

