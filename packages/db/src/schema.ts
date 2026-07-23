import { relations } from "drizzle-orm";
import { boolean, customType, index, jsonb, pgTable, text, timestamp, uuid, integer, unique } from "drizzle-orm/pg-core";

// drizzle has no built-in bytea — minimal custom type
const bytea = customType<{ data: Buffer }>({
  dataType() { return "bytea"; },
});


// AUTH

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  // Federation: a "shadow account" for a member whose real account lives on
  // another Musubi server. isExternal users have no password/session — they
  // authenticate with a member token (member_tokens) issued on invite accept.
  // homeServer is their origin server's URL (null for local users).
  isExternal: boolean("is_external").default(false).notNull(),
  homeServer: text("home_server"),
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
    // Provider sync can be disabled independently from account linking/login.
    // A revoked Google refresh token should keep the account and its mirrored
    // calendars, but must stop background retries until OAuth is linked again.
    syncStatus: text("sync_status").default("active").notNull(),
    syncErrorCode: text("sync_error_code"),
    syncErrorSubtype: text("sync_error_subtype"),
    syncDisabledAt: timestamp("sync_disabled_at"),
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


// Avatars live in the DB on purpose: client-side optimization keeps them at
// ~10-20 KB, self-hosting stays "just docker-compose", and pg_dump backs them
// up. If bigger media ever lands (event attachments), swap the storage behind
// the avatar endpoints for S3/MinIO — nothing else needs to change.
export const userAvatars = pgTable("user_avatars", {
  id: text("id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  data: bytea("data").notNull(),
  mimeType: text("mime_type").notNull(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

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
  defaultCalendarView: text("default_calendar_view").notNull().default("month"),
  weekStartsOn: text("week_starts_on").notNull().default("monday"),
  timeFormat: text("time_format").notNull().default("24h"),
  dateFormat: text("date_format").notNull().default("dmy"),
  theme: text("theme").notNull().default("system"),
  tabBarLabels: boolean("tab_bar_labels").notNull().default(true),
  onboarded: boolean("onboarded").notNull().default(false),
  // flat, user-chosen calendar order; group order derives from first appearance
  calendarOrder: jsonb("calendar_order").$type<string[]>().notNull().default([]),
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
  // Every user gets one auto-created personal calendar — can't be deleted or
  // transferred; the default home for future features.
  isDefault: boolean("is_default").notNull().default(false),
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
  // Attendance toggle (a "kind of event"). Off hides the attendee UI only —
  // event_users rows survive the flip, so re-enabling restores the list.
  hasAttendees: boolean("has_attendees").notNull().default(false),
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
  expiresAt: timestamp("expires_at"), // null = never expires
  maxUses: integer("max_uses"), // null = unlimited
  uses: integer("uses").notNull().default(0), // bumped on join/accept, checked against maxUses
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
}, (t) => [unique().on(t.userID, t.calendarID)]); // re-join hits onConflictDoNothing instead of duplicating the membership

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


// Attendees. Presence in the table = attending; the creator is added on event
// creation. When RSVP lands (web), add a `status` column — presence + status
// covers yes/no/maybe with no rework.
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
}, (t) => [unique().on(t.eventID, t.userID)]); // makes join idempotent (onConflictDoNothing)


export const eventUsersRelations = relations(eventUsers, ({ one }) => ({
  user: one(user, { fields: [eventUsers.userID], references: [user.id] }),
  events: one(events, { fields: [eventUsers.eventID], references: [events.id] }),
}));


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
  // Null while disabled: the user opted this calendar out of sync, so its local
  // mirror was deleted but the row survives as a tombstone. Discovery keys off
  // (provider, accountID, externalCalendarID) to skip re-importing it.
  calendarID: uuid("calendar_id")
    .references(() => calendars.id, { onDelete: "cascade" }),
  externalCalendarID: text("external_calendar_id").notNull(),
  cursor: text("cursor"),
  disabled: boolean("disabled").notNull().default(false),
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
  // The LOCAL mirror calendar this mapping belongs to. Scoping by it is what
  // lets two users mirror the same global external calendar (Google holidays
  // share one externalCalendarID across all accounts) without colliding.
  calendarID: uuid("calendar_id")
    .references(() => calendars.id, { onDelete: "cascade" })
    .notNull(),
  externalCalendarID: text("external_calendar_id").notNull(),
  externalEventID: text("external_event_id").notNull(),
  etag: text("etag"),
}, (t) => [
  unique().on(t.provider, t.calendarID, t.externalEventID),
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


// FEDERATION (Musubi ↔ Musubi)

// Bearer tokens for external (shadow) members. The raw token is shown once and
// only this SHA-256 hash persists. Authentication accepts createdAt < 90 days;
// clients rotate during the final 14 days. Removing a shadow user's last
// membership revokes the row in the same transaction.
export const memberTokens = pgTable("member_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  userID: text("user_id")
    .references(() => user.id, { onDelete: "cascade" })
    .notNull(),
  tokenHash: text("token_hash").notNull().unique(),
}, (t) => [index("member_tokens_user_idx").on(t.userID)]);

export type NewMemberToken = typeof memberTokens.$inferInsert;

// Home side: this user's memberships on OTHER Musubi servers. The member token
// is stored AES-GCM encrypted at the app layer (same scheme + key as CalDAV
// passwords) so every signed-in device picks the connection up — accepting an
// invite on one device federates them all.
export const musubiAccounts = pgTable("musubi_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  userID: text("user_id")
    .references(() => user.id, { onDelete: "cascade" })
    .notNull(),
  server: text("server").notNull(),          // the origin server's URL
  remoteUserID: text("remote_user_id").notNull(), // our shadow-user id there
  encryptedToken: text("encrypted_token").notNull(),
}, (t) => [unique().on(t.userID, t.server)]);

export type NewMusubiAccount = typeof musubiAccounts.$inferInsert;
