import { relations } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uuid, integer, unique } from "drizzle-orm/pg-core";


// AUTH

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  calendarMembers: many(calendarMembers),
  eventUsers: many(eventUsers),
  calendars: many(calendars),
  events: many(events),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));


// User settings


export const userSettings = pgTable("user_settings", {
  id: text("id")
    .references(() => user.id, {
      onDelete: "cascade",
    })
    .notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  // settings
  showKanji: boolean("show_kanji").notNull().default(true),
  notificationsOnByDefault: boolean("notifications_on_by_default").notNull().default(true),
  defaultCalendarView: text("default_calendar_view").notNull().default("week"),
  weekStartsOn: text("week_starts_on").notNull().default("monday"),
  timeLocale: text("time_locale").notNull().default("en-UK"),
  theme: text("theme").notNull().default("system"),
});

export type NewSettings = typeof userSettings.$inferInsert;


// Calendars and Events


export const calendars = pgTable("calendars", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  creatorID: text("creator_id")
    .references(() => user.id, {
      onDelete: "cascade",
    })
    .notNull(),
  name: text("name").notNull(),
  color: text("color").notNull(),
});

export type NewCalendar = typeof calendars.$inferInsert;

export const calendarsRelations = relations(calendars, ({ many, one }) => ({
  calendarEvents: many(calendarEvents),
  calendarMembers: many(calendarMembers),
  user: one(user, { fields: [calendars.creatorID], references: [user.id] }),
}));


export const events = pgTable("events", {
  id: uuid("id").primaryKey(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  creatorID: text("creator_id")
    .references(() => user.id, {
      onDelete: "cascade",
    })
    .notNull(),
  title: text("name").notNull(),
  color: text("color").notNull(),
  start: timestamp("start_at").notNull(),
  end: timestamp("end_at").notNull(),
  isAllDay: boolean("is_all_day").notNull().default(false),
  description: text("description"),
  location: text("location"),
  isCanceled: boolean("is_canceled").notNull().default(false),
  organizer: text("organizer").notNull(),
  recurrence: text("recurrence"),
  // reminders:
  url: text("url"),
  // home calendar — where the event was created / claimed. Edit-content is gated by
  // editEvents on THIS calendar; links into other calendars are read-only shares.
  // null for legacy events (fallback: creator-only edit). Set null if home is removed.
  originCalendarID: uuid("origin_calendar_id").references(() => calendars.id, {
    onDelete: "set null",
  }),
  deletedAt: timestamp("deleted_at"), // soft-delete tombstone for delta sync (null = live)
});

export type NewEvent = typeof events.$inferInsert;

export const eventsRelations = relations(events, ({ many, one }) => ({
  eventUsers: many(eventUsers),
  calendarEvents: many(calendarEvents),
  user: one(user, { fields: [events.creatorID], references: [user.id] }),
}));


export const calendarInvites = pgTable("calendar_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  calendarID: uuid("calendar_id")
    .references(() => calendars.id, {
      onDelete: "cascade",
    })
    .notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  maxUses: integer("max_uses"),
});

export type NewCalendarInvite = typeof calendarInvites.$inferInsert;

export const calendarInvitesRelations = relations(calendarInvites, ({ one }) => ({
  calendars: one(calendars, { fields: [calendarInvites.calendarID], references: [calendars.id] }),
}));



// LINK TABLES


export const userStatus = pgTable("user_status", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  userID: text("user_id")
    .references(() => user.id, {
      onDelete: "cascade",
    })
    .notNull(),
  isSponsor: boolean("is_sponsor").default(false),
  isPremium: boolean("is_premium").default(false),
})

export const calendarMembers = pgTable("calendar_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  userID: text("user_id")
    .references(() => user.id, {
      onDelete: "cascade",
    })
    .notNull(),
  calendarID: uuid("calendar_id")
    .references(() => calendars.id, {
      onDelete: "cascade",
    })
    .notNull(),
  role: text("role").notNull().default("viewer"), // owner | editor | viewer
});

export const calendarMembersRelations = relations(calendarMembers, ({ one }) => ({
  calendars: one(calendars, { fields: [calendarMembers.calendarID], references: [calendars.id] }),
  user: one(user, { fields: [calendarMembers.userID], references: [user.id] }),
}));


export const calendarEvents = pgTable("calendar_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  eventID: uuid("event_id")
    .references(() => events.id, {
      onDelete: "cascade",
    })
    .notNull(),
  calendarID: uuid("calendar_id")
    .references(() => calendars.id, {
      onDelete: "cascade",
    })
    .notNull(),
});


export const calendarEventsRelations = relations(calendarEvents, ({ one }) => ({
  calendars: one(calendars, { fields: [calendarEvents.calendarID], references: [calendars.id] }),
  events: one(events, { fields: [calendarEvents.eventID], references: [events.id] }),
}));


export const eventUsers = pgTable("event_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  eventID: uuid("event_id")
    .references(() => events.id, {
      onDelete: "cascade",
    })
    .notNull(),
  userID: text("user_id")
    .references(() => user.id, {
      onDelete: "cascade",
    })
    .notNull(),
});


export const eventUsersRelations = relations(eventUsers, ({ one }) => ({
  user: one(user, { fields: [eventUsers.userID], references: [user.id] }),
  events: one(events, { fields: [eventUsers.eventID], references: [events.id] }),
}));


// export const eventAttendees = pgTable("event_attendees", {
//   id: uuid("id").primaryKey().defaultRandom(),
//   createdAt: timestamp("created_at").notNull().defaultNow(),
//   updatedAt: timestamp("updated_at")
//     .notNull()
//     .defaultNow()
//     .$onUpdate(() => new Date()),
//   eventID: uuid("event_id")
//     .references(() => events.id, {
//       onDelete: "cascade",
//     })
//     .notNull(),
//   userID: text("user_id")
//     .references(() => user.id, {
//       onDelete: "cascade",
//     })
//     .notNull(),
//   //TODO: Complete Table
// });


// EXTERNAL CALENDAR SYNC (provider-agnostic — google | microsoft | caldav)


export const externalCalendars = pgTable("external_calendars", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  provider: text("provider").notNull(),
  userID: text("user_id")
    .references(() => user.id, { onDelete: "cascade" })
    .notNull(),
  accountID: text("account_id").notNull(),
  accountLabel: text("account_label"),
  calendarID: uuid("calendar_id")
    .references(() => calendars.id, { onDelete: "cascade" })
    .notNull(),
  externalCalendarID: text("external_calendar_id").notNull(),
  cursor: text("cursor"),
}, (t) => [
  unique().on(t.provider, t.accountID, t.externalCalendarID),
  unique().on(t.calendarID),
]);

export type NewExternalCalendar = typeof externalCalendars.$inferInsert;


export const externalEvents = pgTable("external_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  provider: text("provider").notNull(),
  eventID: uuid("event_id")
    .references(() => events.id, { onDelete: "cascade" })
    .notNull(),
  externalCalendarID: text("external_calendar_id").notNull(),
  externalEventID: text("external_event_id").notNull(),
  etag: text("etag"),
}, (t) => [
  unique().on(t.provider, t.externalCalendarID, t.externalEventID),
]);

export type NewExternalEvent = typeof externalEvents.$inferInsert;


// CalDAV credentials (Apple/iCloud + generic). Password stored AES-GCM encrypted
// by the app layer — this table never sees plaintext. Multiple accounts per user.
export const caldavAccounts = pgTable("caldav_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  userID: text("user_id")
    .references(() => user.id, { onDelete: "cascade" })
    .notNull(),
  serverUrl: text("server_url").notNull(),
  username: text("username").notNull(),
  encryptedPassword: text("encrypted_password").notNull(),
}, (t) => [unique().on(t.userID, t.serverUrl, t.username)]);

export type NewCaldavAccount = typeof caldavAccounts.$inferInsert;
