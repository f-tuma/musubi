import type { GraphSeriesDeletionPrepared } from "./queries/graph-series-delete";
import type { GraphSeriesCreateJournal } from "./queries/graph-series-create";
import type { CaldavSplitJournal } from "./queries/caldav-split";
import type { CaldavSeriesPrepared, CaldavSeriesDeletionPrepared } from "./queries/caldav-series-scope";
import type { GoogleOccurrenceIntent } from "./queries/google-occurrence-scope";
import type { ProviderReminderEdit, ProviderRsvpIntent, ProviderReminderInstanceIntent } from "@musubi/types";
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  integer,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import {
  DEFAULT_NOTIFICATION_EMAILS,
  DEFAULT_REMINDER_RULE,
  type NotificationEmails,
  type ReminderRule,
  type TaskStatus,
  type Task,
  type Event,
  type EventScopeOutcome,
  type ProviderEventState,
  type EventTimeModel,
  type OccurrenceStart,
} from "@musubi/types";

// drizzle has no built-in bytea — minimal custom type
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// AUTH

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  isAnonymous: boolean("is_anonymous").default(false).notNull(),
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

// Compatibility bridge for avatars uploaded before media storage moved out of
// PostgreSQL. API lazily copies each row to configured storage, then deletes it.
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
    .primaryKey()
    .references(() => user.id, {
      onDelete: "cascade",
    }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  revision: integer("revision").notNull().default(1),
  // settings
  notificationsOnByDefault: boolean("notifications_on_by_default")
    .notNull()
    .default(true),
  defaultCalendarView: text("default_calendar_view").notNull().default("month"),
  weekStartsOn: text("week_starts_on").notNull().default("monday"),
  timeFormat: text("time_format").notNull().default("24h"),
  dateFormat: text("date_format").notNull().default("dmy"),
  theme: text("theme").notNull().default("system"),
  tabBarLabels: boolean("tab_bar_labels").notNull().default(true),
  onboarded: boolean("onboarded").notNull().default(false),
  // flat, user-chosen calendar order; group order derives from first appearance
  calendarOrder: jsonb("calendar_order")
    .$type<string[]>()
    .notNull()
    .default([]),
  // IANA zone. All-day reminders are a wall-clock time ("the evening before at
  // 18:00"), which UTC cannot answer. Timed events need no zone — they are
  // instants, and an offset from an instant is another instant.
  timezone: text("timezone").notNull().default("UTC"),
  // Bottom of the reminder inheritance chain, so always a concrete rule.
  // `notificationsOnByDefault` above stays in step with it for older mobile
  // clients, which read the boolean and know nothing about rules.
  defaultReminder: jsonb("default_reminder")
    .$type<ReminderRule>()
    .notNull()
    .default(DEFAULT_REMINDER_RULE),
  // Emails about what other people did, separate from reminders. The document
  // keeps the deprecated pollDecided key only for 0.1.7 client compatibility.
  notificationEmails: jsonb("notification_emails")
    .$type<NotificationEmails>()
    .notNull()
    .default(DEFAULT_NOTIFICATION_EMAILS),
  // Nejnovější zpráva o novinkách, kterou uživatel viděl. NOT NULL s prázdným
  // výchozím řetězcem, ne nullable: "" a NULL by znamenaly totéž, a jedna
  // podoba prázdna se zpracovává líp než dvě.
  lastSeenAnnouncement: text("last_seen_announcement").notNull().default(""),
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
  calendarTasks: many(calendarTasks),
  tasks: many(tasks, { relationName: "taskLegacyHome" }),
  originatedTasks: many(tasks, { relationName: "taskHome" }),
  user: one(user, { fields: [calendars.creatorID], references: [user.id] }),
}));

export const events = pgTable("events", {
  id: uuid("id").primaryKey(),
  // Shared content, membership and tombstone version; provider ETags live on mappings.
  revision: integer("revision").notNull().default(1),
  providerReadRetiredRevision: integer("provider_read_retired_revision"),
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
  // Null is unresolved legacy semantics, never the database/server timezone.
  // Writers remain disabled until revision-CAS and provider projections support it.
  timeModel: jsonb("time_model").$type<EventTimeModel>(),
  seriesID: uuid("series_id").references((): AnyPgColumn => events.id),
  originalStart: jsonb("original_start").$type<OccurrenceStart>(),
  url: text("url"),
  // home calendar — where the event was created / claimed. Edit-content is gated by
  // editEvents on THIS calendar; links into other calendars are read-only shares.
  // null for legacy events (fallback: creator-only edit). Set null if home is removed.
  originCalendarID: uuid("origin_calendar_id").references(() => calendars.id, {
    onDelete: "set null",
  }),
  deletedAt: timestamp("deleted_at"), // soft-delete tombstone for delta sync (null = live)
}, (t) => [
  check("events_occurrence_pair_check", sql`(${t.seriesID} is null) = (${t.originalStart} is null)`),
  check("events_occurrence_not_self_check", sql`${t.seriesID} is null or ${t.seriesID} <> ${t.id}`),
  // Migration makes this constraint deferrable for atomic family identity shifts.
  unique("events_series_original_start_unique").on(t.seriesID, t.originalStart),
]);

export type NewEvent = typeof events.$inferInsert;

export const eventsRelations = relations(events, ({ many, one }) => ({
  eventUsers: many(eventUsers),
  calendarEvents: many(calendarEvents),
  user: one(user, { fields: [events.creatorID], references: [user.id] }),
}));

// One canonical task, readable through calendar_tasks. Only the home calendar
// governs content/completion; provider projections keep their own validators.
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    creatorID: text("creator_id")
      .references(() => user.id, { onDelete: "cascade" })
      .notNull(),
    calendarID: uuid("calendar_id")
      .references(() => calendars.id, { onDelete: "set null" }),
    originCalendarID: uuid("origin_calendar_id")
      .references(() => calendars.id, { onDelete: "set null" }),
    providerReadRetiredGeneration: integer("provider_read_retired_generation"),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status")
      .$type<TaskStatus>()
      .notNull()
      .default("needs-action"),
    start: timestamp("start_at"),
    due: timestamp("due_at"),
    isAllDay: boolean("is_all_day").notNull().default(false),
    completedAt: timestamp("completed_at"),
    percentComplete: integer("percent_complete").notNull().default(0),
    priority: integer("priority").notNull().default(0),
    recurrence: text("recurrence"),
    relatedTo: text("related_to"),
    sequence: integer("sequence").notNull().default(0),
    url: text("url"),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    index("tasks_calendar_updated_at_idx").on(t.calendarID, t.updatedAt),
    index("tasks_origin_updated_at_idx").on(t.originCalendarID, t.updatedAt),
    check("tasks_revision_check", sql`${t.revision} > 0`),
  ],
);

export type NewTask = typeof tasks.$inferInsert;

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  calendarTasks: many(calendarTasks),
  calendar: one(calendars, {
    fields: [tasks.calendarID],
    references: [calendars.id],
    relationName: "taskLegacyHome",
  }),
  originCalendar: one(calendars, {
    fields: [tasks.originCalendarID],
    references: [calendars.id],
    relationName: "taskHome",
  }),
  user: one(user, { fields: [tasks.creatorID], references: [user.id] }),
}));

export const calendarTasks = pgTable("calendar_tasks", {
  taskID: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  calendarID: uuid("calendar_id").notNull().references(() => calendars.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.taskID, t.calendarID] }),
  index("calendar_tasks_calendar_task_idx").on(t.calendarID, t.taskID),
]);

export const calendarTasksRelations = relations(calendarTasks, ({ one }) => ({
  task: one(tasks, { fields: [calendarTasks.taskID], references: [tasks.id] }),
  calendar: one(calendars, { fields: [calendarTasks.calendarID], references: [calendars.id] }),
}));

/** Idempotency applies to native-only operations too. Identity survives a task
 * tombstone; user removal purges it. No private content is stored here. */
export const taskMutations = pgTable("task_mutations", {
  actorID: text("actor_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  mutationID: uuid("mutation_id").notNull(),
  taskID: uuid("task_id").notNull(),
  revision: integer("revision").notNull(),
  operation: text("operation").$type<"create" | "update" | "link" | "unlink" | "fork" | "delete" | "calendar-delete">().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.actorID, t.mutationID] }),
  check("task_mutations_revision_check", sql`${t.revision} > 0`),
]);

// Deprecated public-event storage. No runtime code reads or writes this table.
// Keep through 0.2.0 for rollback safety; drop it in a later contract release.
export const eventShares = pgTable("event_shares", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  eventID: uuid("event_id")
    .references(() => events.id, { onDelete: "cascade" })
    .notNull(),
  token: text("token").notNull().unique(),
  mode: text("mode").notNull(),
  indexable: boolean("indexable").notNull().default(false),
  attendeeVisibility: text("attendee_visibility").notNull().default("counts"),
  theme: jsonb("theme").notNull().default({}),
  content: jsonb("content").notNull().default({}),
  createdBy: text("created_by")
    .references(() => user.id, { onDelete: "cascade" })
    .notNull(),
  revokedAt: timestamp("revoked_at"),
});

// Deprecated scheduler storage. No runtime code reads or writes these tables.
// Keep through 0.2.0 so rolling back the API does not meet a missing schema;
// remove in a later contract release per docs/releasing.md.
export const schedulingPolls = pgTable("scheduling_polls", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  ownerID: text("owner_id").references(() => user.id, { onDelete: "cascade" }),
  ownerEmail: text("owner_email").notNull(),
  ownerName: text("owner_name").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  /** Exact start time for timed polls; optional context for all-day polls. */
  approximateStartTime: text("approximate_start_time"),
  durationMinutes: integer("duration_minutes").notNull(),
  // An unguessable capability, revocable by closing the poll.
  token: text("token").notNull().unique(),
  deadline: timestamp("deadline"),
  // Where the decided event lands. Chosen when the poll is written, used days
  // later when a day is picked — so it has to be stored rather than guessed at
  // the end. Null for polls made without an account: those resolve to the
  // creator's own calendar when they decide.
  calendarID: uuid("calendar_id").references(() => calendars.id, {
    onDelete: "set null",
  }),
  // Set when the organizer picks. The poll stays readable afterwards so people
  // who voted can see what was chosen without hunting for the calendar invite.
  chosenSlotID: uuid("chosen_slot_id"),
  eventID: uuid("event_id").references(() => events.id, {
    onDelete: "set null",
  }),
  closedAt: timestamp("closed_at"),
});

export type NewSchedulingPoll = typeof schedulingPolls.$inferInsert;

export const schedulingSlots = pgTable("scheduling_slots", {
  id: uuid("id").primaryKey().defaultRandom(),
  pollID: uuid("poll_id")
    .references(() => schedulingPolls.id, { onDelete: "cascade" })
    .notNull(),
  start: timestamp("start_at").notNull(),
  end: timestamp("end_at").notNull(),
});

export type NewSchedulingSlot = typeof schedulingSlots.$inferInsert;

export const schedulingParticipants = pgTable(
  "scheduling_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pollID: uuid("poll_id")
      .references(() => schedulingPolls.id, { onDelete: "cascade" })
      .notNull(),
    userID: text("user_id").references(() => user.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    name: text("name").notNull(),
  },
  (table) => [
    unique("scheduling_participants_poll_email_unique").on(
      table.pollID,
      table.email,
    ),
  ],
);

// One row per person per slot. `yes` / `if-needed` / `no` — the middle one is
// what makes a poll converge, so it is a first-class answer rather than an
// absence.
export const schedulingVotes = pgTable(
  "scheduling_votes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    slotID: uuid("slot_id")
      .references(() => schedulingSlots.id, { onDelete: "cascade" })
      .notNull(),
    participantID: uuid("participant_id")
      .references(() => schedulingParticipants.id, { onDelete: "cascade" })
      .notNull(),
    // Kept through the transition for rollback; new writes use participantID.
    userID: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
  },
  (table) => [
    unique("scheduling_votes_slot_participant_unique").on(
      table.slotID,
      table.participantID,
    ),
  ],
);

export type NewSchedulingVote = typeof schedulingVotes.$inferInsert;

export const schedulingPollsRelations = relations(
  schedulingPolls,
  ({ many, one }) => ({
    owner: one(user, {
      fields: [schedulingPolls.ownerID],
      references: [user.id],
    }),
    participants: many(schedulingParticipants),
    slots: many(schedulingSlots),
  }),
);

export const schedulingSlotsRelations = relations(
  schedulingSlots,
  ({ many, one }) => ({
    poll: one(schedulingPolls, {
      fields: [schedulingSlots.pollID],
      references: [schedulingPolls.id],
    }),
    votes: many(schedulingVotes),
  }),
);

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

export const calendarInvitesRelations = relations(
  calendarInvites,
  ({ one }) => ({
    calendars: one(calendars, {
      fields: [calendarInvites.calendarID],
      references: [calendars.id],
    }),
  }),
);

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
});

export const calendarMembers = pgTable(
  "calendar_members",
  {
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
    // MY reminder rule for this calendar, not the owner's. null = inherit the
    // user's global default. Deliberately on the membership: letting a calendar
    // owner set this would be a way to make somebody else's phone buzz.
    reminder: jsonb("reminder").$type<ReminderRule>(),
  },
  (t) => [unique().on(t.userID, t.calendarID)],
); // re-join hits onConflictDoNothing instead of duplicating the membership

export const calendarMembersRelations = relations(
  calendarMembers,
  ({ one }) => ({
    calendars: one(calendars, {
      fields: [calendarMembers.calendarID],
      references: [calendars.id],
    }),
    user: one(user, {
      fields: [calendarMembers.userID],
      references: [user.id],
    }),
  }),
);

export const calendarEvents = pgTable(
  "calendar_events",
  {
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
  },
  (t) => [
    unique("calendar_events_event_id_calendar_id_unique").on(
      t.eventID,
      t.calendarID,
    ),
  ],
);

export const calendarEventsRelations = relations(calendarEvents, ({ one }) => ({
  calendars: one(calendars, {
    fields: [calendarEvents.calendarID],
    references: [calendars.id],
  }),
  events: one(events, {
    fields: [calendarEvents.eventID],
    references: [events.id],
  }),
}));

// Attendees and their answer: one event, one list of people.
export const eventUsers = pgTable(
  "event_users",
  {
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
    // going | maybe | declined. No row = has not answered; presence + status is the
    // whole answer. Membership from before answers existed means "going", which is
    // what it meant.
    status: text("status").notNull().default("going"),
  },
  (t) => [unique().on(t.eventID, t.userID)],
); // makes join idempotent (onConflictDoNothing)

// A per-user reminder override on one event — the exception to whatever the
// calendar rule says. Its own table rather than a column on `eventUsers`,
// because there "no row = has not answered", and wanting a reminder is not an
// answer: plenty of people want the nudge for something they are not attending.
//
// A row is always an explicit choice, "never" included. Inheriting is the
// absence of a row.
export const eventReminders = pgTable(
  "event_reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    eventID: uuid("event_id")
      .references(() => events.id, { onDelete: "cascade" })
      .notNull(),
    userID: text("user_id")
      .references(() => user.id, { onDelete: "cascade" })
      .notNull(),
    rule: jsonb("rule").$type<ReminderRule>().notNull(),
  },
  (t) => [unique().on(t.eventID, t.userID)],
);

// One browser that has agreed to be pushed to. The endpoint is a URL at the
// browser vendor's push service and IS the address, so it is the unique key —
// the same person on a laptop and a phone browser is two rows, and re-granting
// permission in the same browser returns the same endpoint rather than a second.
//
// `p256dh` and `auth` are the keys the payload is encrypted to, so the push
// service relays a message it cannot read. Losing this table costs nothing but
// a re-subscribe; there is no history here worth keeping.
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    userID: text("user_id")
      .references(() => user.id, { onDelete: "cascade" })
      .notNull(),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    // Bumped on every successful send, so a dead endpoint is visible before the
    // push service admits it with a 410.
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  },
  (t) => [index("push_subscriptions_user_id_idx").on(t.userID)],
);

// An email waiting for its moment.
//
// Notifications about other people's actions are batched rather than sent the
// instant they happen: somebody dragging twenty events across a week would
// otherwise send twenty emails and earn Musubi a spam label. One row per
// (person, kind, subject) collapses repeated tugs at the same thing into one.
//
// `dueAt` is set from the FIRST change and never pushed forward. Extending it
// on every edit would mean somebody who keeps fiddling never tells anyone
// anything.
export const pendingNotifications = pgTable(
  "pending_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    userID: text("user_id")
      .references(() => user.id, { onDelete: "cascade" })
      .notNull(),
    /** What happened: "event_changed", and whatever comes later. */
    kind: text("kind").notNull(),
    /** What it happened to; text keeps notification kinds decoupled from FKs. */
    subjectID: text("subject_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    dueAt: timestamp("due_at").notNull(),
  },
  (t) => [
    unique().on(t.userID, t.kind, t.subjectID),
    index("pending_notifications_due_at_idx").on(t.dueAt),
  ],
);

// How far a scheduled job has already looked. One row per job, not per user:
// "which slice of time has been dispatched" is the same question whoever is
// asking. In the database rather than in memory so a restart neither re-sends
// the last window nor skips it.
export const dispatchCursors = pgTable("dispatch_cursors", {
  name: text("name").primaryKey(),
  value: timestamp("value").notNull(),
});

export const eventRemindersRelations = relations(eventReminders, ({ one }) => ({
  event: one(events, {
    fields: [eventReminders.eventID],
    references: [events.id],
  }),
  user: one(user, { fields: [eventReminders.userID], references: [user.id] }),
}));

export const eventUsersRelations = relations(eventUsers, ({ one }) => ({
  user: one(user, { fields: [eventUsers.userID], references: [user.id] }),
  events: one(events, {
    fields: [eventUsers.eventID],
    references: [events.id],
  }),
}));

// EXTERNAL CALENDAR SYNC (provider-agnostic — google | microsoft | caldav)

export const externalCalendars = pgTable(
  "external_calendars",
  {
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
    calendarID: uuid("calendar_id").references(() => calendars.id, {
      onDelete: "cascade",
    }),
    externalCalendarID: text("external_calendar_id").notNull(),
    cursor: text("cursor"),
    // Locally ordered discovery grant; invalidates in-flight reads and cursors.
    providerAccessRole: text("provider_access_role"),
    providerAccessRevision: integer("provider_access_revision").notNull().default(0),
    supportsEvents: boolean("supports_events").notNull().default(true),
    supportsTasks: boolean("supports_tasks").notNull().default(false),
    providerDefaultCalendar: boolean("provider_default_calendar"),
    disabled: boolean("disabled").notNull().default(false),
  },
  (t) => [
    unique().on(t.provider, t.accountID, t.externalCalendarID),
    unique().on(t.calendarID),
  ],
);

export type NewExternalCalendar = typeof externalCalendars.$inferInsert;

export const externalEvents = pgTable(
  "external_events",
  {
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
    // Resource URL addresses the object; iCalendar UID is its stable identity.
    icalUid: text("ical_uid"),
    providerState: jsonb("provider_state").$type<ProviderEventState>(),
    providerStateObservedAt: timestamp("provider_state_observed_at", { withTimezone: true }),
    // Fresh grant restoration is a read, not a new cross-provider write.
    readRedactionRevision: integer("read_redaction_revision"),
    // Destination-scoped recurrence identity; never a cross-account UID join.
    externalSeriesID: text("external_series_id"),
    originalStart: jsonb("original_start").$type<OccurrenceStart>(),
  },
  (t) => [
    unique().on(t.provider, t.calendarID, t.externalEventID),
    check("external_events_occurrence_series_check", sql`${t.originalStart} is null or ${t.externalSeriesID} is not null`),
    index("external_events_series_idx").on(t.provider, t.calendarID, t.externalSeriesID).where(sql`${t.externalSeriesID} is not null`),
  ],
);

export type NewExternalEvent = typeof externalEvents.$inferInsert;

/** A delete delta may precede an outbound create mapping. Retain the remote
 * address until its connection is removed; cursor advancement cannot erase it. */
export const externalEventTombstones = pgTable("external_event_tombstones", {
  id: uuid("id").primaryKey().defaultRandom(),
  externalCalendarLinkID: uuid("external_calendar_link_id").notNull().references(() => externalCalendars.id, { onDelete: "cascade" }),
  externalEventID: text("external_event_id").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique().on(t.externalCalendarLinkID, t.externalEventID)]);

/** Internal EVENT provider intent. Remote addresses deliberately outlive mapping
 * and event deletion; owner deletion purges private payloads. No credentials. */
export const eventOutbox = pgTable(
  "event_outbox",
  {
    id: uuid("id").primaryKey(),
    actorID: text("actor_id").notNull(),
    mutationID: uuid("mutation_id").notNull(),
    position: integer("position").notNull(),
    eventID: uuid("event_id").notNull(),
    revision: integer("revision").notNull(),
    predecessorID: uuid("predecessor_id"),
    calendarID: uuid("calendar_id").notNull(),
    externalCalendarLinkID: uuid("external_calendar_link_id").notNull(),
    provider: text("provider").notNull(),
    userID: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountID: text("account_id").notNull(),
    externalCalendarID: text("external_calendar_id").notNull(),
    externalEventID: text("external_event_id"),
    expectedEtag: text("expected_etag"),
    icalUid: text("ical_uid"),
    action: text("action").$type<"create" | "update" | "delete">().notNull(),
    // Read-only privacy recovery provenance; never changes the accepted intent.
    personalReadRecovery: jsonb("personal_read_recovery").$type<{ acceptedRevision: number; intentHash: string; mappingID: string; redactedRevision: number; restoredRevision: number | null }>(),
    payload: jsonb("payload")
      .$type<{
        event: Event;
        patch?: Record<string, unknown>;
        scopeEditValidated?: boolean;
        reminderEdit?: ProviderReminderEdit;
        rsvp?: ProviderRsvpIntent;
        organizer?: import("@musubi/types").ProviderOrganizerIntent;
        reminderInstance?: ProviderReminderInstanceIntent;
        googleOccurrence?: GoogleOccurrenceIntent;
        caldavSeries?: CaldavSeriesPrepared;
        caldavSplit?: CaldavSplitJournal;
        caldavAlarm?: import("./queries/caldav-alarms").CaldavAlarmIntent;
        caldavSeriesDeletion?: CaldavSeriesDeletionPrepared;
        graphSeriesCreate?: GraphSeriesCreateJournal;
        graphSeriesDeletion?: GraphSeriesDeletionPrepared;
        graphOccurrenceContent?: import("./queries/graph-occurrence-content").GraphOccurrenceContent;
        graphMeetingCancellation?: import("./queries/graph-meeting-cancel").GraphMeetingCancellation;
        graphCreateAdoption?: import("@musubi/types").GraphCreateAdoptionRecord;
        createIdentityVersion?: 1;
        resolution?: {
          operationID: string;
          replacedOperationIDs: string[];
          expectedLocalRevision: number | null;
          expectedLatestOperationID: string;
          expectedRemoteExists: boolean;
          expectedRemoteEtag: string | null;
          expectedMasterRevision?: number;
          expectedScopeResolution?: { kind: "following-delete"; originalStart: OccurrenceStart } | { kind: "series-delete" } | { kind: "following-update" | "following-create"; originalStart: OccurrenceStart; newSeriesId: string };
          expectedReminderStateVersion?: string;
          expectedRsvpBaselineVersion?: string;
        };
        providerProjection?: Pick<Event, "title" | "start" | "end" | "isAllDay" | "description" | "location" | "recurrence">;
      }>()
      .notNull(),
    status: text("status")
      .$type<
        | "pending"
        | "attempting"
        | "completed"
        | "not-needed"
        | "conflict"
        | "not-written"
        | "unconfirmed"
        | "retry"
        | "blocked"
        | "cancelled"
      >()
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    attemptedAt: timestamp("attempted_at"),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    uncertain: boolean("uncertain").notNull().default(false),
    resultRef: jsonb("result_ref").$type<{
      externalEventId: string;
      etag?: string | null;
      icalUid?: string | null;
    }>(),
    remoteSnapshot: jsonb("remote_snapshot").$type<{
      isEcho?: boolean;
      providerState?: ProviderEventState;
      externalEventId: string;
      values?: Record<string, unknown>;
      etag: string | null;
      icalUid?: string | null;
      deleted: boolean;
      observedAt: string;
    }>(),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("event_outbox_mutation_position_unique").on(
      t.actorID,
      t.mutationID,
      t.position,
    ),
    index("event_outbox_event_revision_idx").on(t.eventID, t.revision),
    index("event_outbox_caldav_deleted_version_idx")
      .on(t.provider, t.userID, t.calendarID, t.externalEventID, t.expectedEtag)
      .where(sql`${t.status} = 'completed' and ((${t.action} = 'delete' and ${t.payload}->'caldavSeriesDeletion' is not null) or (${t.action} = 'update' and (${t.payload}->'caldavSeries'->'write'->'followingDelete' is not null or ${t.payload}->'caldavSplit' is not null)))`),
    index("event_outbox_inbox_idx")
      .on(t.userID, t.eventID)
      .where(sql`${t.status} not in ('completed', 'not-needed')`),
    index("event_outbox_pending_idx")
      .on(t.nextAttemptAt, t.id)
      .where(sql`${t.status} in ('pending', 'retry', 'attempting', 'unconfirmed')`),
    check("event_outbox_revision_check", sql`${t.revision} > 0`),
    check(
      "event_outbox_attempts_check",
      sql`${t.attempts} >= 0 and ${t.position} >= 0`,
    ),
    check(
      "event_outbox_action_check",
      sql`${t.action} in ('create', 'update', 'delete')`,
    ),
    check(
      "event_outbox_status_check",
      sql`${t.status} in ('pending', 'attempting', 'completed', 'not-needed', 'conflict', 'not-written', 'unconfirmed', 'retry', 'blocked', 'cancelled')`,
    ),
  ],
);

/** Task delivery evidence deliberately has no task/calendar/source FK. A
 * disconnected home must not erase an accepted delete or uncertain CREATE. */
export const taskOutbox = pgTable("task_outbox", {
  id: uuid("id").primaryKey(),
  actorID: text("actor_id").notNull(),
  mutationID: uuid("mutation_id").notNull(),
  position: integer("position").notNull(),
  taskID: uuid("task_id").notNull(),
  revision: integer("revision").notNull(),
  predecessorID: uuid("predecessor_id"),
  calendarID: uuid("calendar_id").notNull(),
  externalCalendarLinkID: uuid("external_calendar_link_id").notNull(),
  provider: text("provider").notNull(),
  userID: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accountID: text("account_id").notNull(),
  externalCalendarID: text("external_calendar_id").notNull(),
  externalTaskID: text("external_task_id"),
  expectedEtag: text("expected_etag"),
  icalUid: text("ical_uid"),
  providerAccessRevision: integer("provider_access_revision").notNull(),
  retiredGeneration: integer("retired_generation").notNull().default(0),
  action: text("action").$type<"create" | "update" | "delete">().notNull(),
  payload: jsonb("payload").$type<{
    task: Task;
    projectionBaseline?: Record<string, unknown> | null;
    providerProjection?: { version: 1; projection: Record<string, unknown>; patch: Record<string, unknown>; baseline: Record<string, unknown> | null; errorCode?: string };
    dispatchProjection?: { version: 1; projection: Record<string, unknown>; patch: Record<string, unknown>; baseline: Record<string, unknown> | null; errorCode?: string };
  }>().notNull(),
  status: text("status").$type<"pending" | "attempting" | "completed" | "not-needed" | "conflict" | "not-written" | "unconfirmed" | "retry" | "blocked" | "cancelled">().notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  attemptedAt: timestamp("attempted_at"),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  uncertain: boolean("uncertain").notNull().default(false),
  resultRef: jsonb("result_ref").$type<{ externalTaskId: string; etag?: string | null; icalUid?: string | null }>(),
  remoteSnapshot: jsonb("remote_snapshot").$type<Record<string, unknown>>(),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  unique("task_outbox_mutation_position_unique").on(t.actorID, t.mutationID, t.position),
  index("task_outbox_task_revision_idx").on(t.taskID, t.revision),
  index("task_outbox_source_order_idx").on(t.taskID, t.externalCalendarLinkID, t.createdAt),
  index("task_outbox_pending_idx").on(t.nextAttemptAt, t.id).where(sql`${t.status} in ('pending', 'retry', 'attempting', 'unconfirmed')`),
  check("task_outbox_revision_check", sql`${t.revision} > 0`),
  check("task_outbox_attempts_check", sql`${t.attempts} >= 0 and ${t.position} >= 0`),
  check("task_outbox_action_check", sql`${t.action} in ('create', 'update', 'delete')`),
  check("task_outbox_status_check", sql`${t.status} in ('pending', 'attempting', 'completed', 'not-needed', 'conflict', 'not-written', 'unconfirmed', 'retry', 'blocked', 'cancelled')`),
]);

export const externalTasks = pgTable(
  "external_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    provider: text("provider").notNull(),
    taskID: uuid("task_id")
      .references(() => tasks.id, { onDelete: "cascade" })
      .notNull(),
    calendarID: uuid("calendar_id")
      .references(() => calendars.id, { onDelete: "cascade" })
      .notNull(),
    externalCalendarID: text("external_calendar_id").notNull(),
    externalTaskID: text("external_task_id").notNull(),
    externalCalendarLinkID: uuid("external_calendar_link_id"),
    accountID: text("account_id"),
    providerAccessRevision: integer("provider_access_revision").notNull().default(0),
    projectionBaseline: jsonb("projection_baseline").$type<Record<string, unknown>>(),
    acceptedRevision: integer("accepted_revision").notNull().default(1),
    etag: text("etag"),
    icalUid: text("ical_uid"),
  },
  (t) => [
    unique("external_tasks_provider_calendar_external_task_unique").on(
      t.provider,
      t.calendarID,
      t.externalTaskID,
    ),
    index("external_tasks_task_source_idx").on(t.taskID, t.calendarID, t.externalCalendarLinkID),
  ],
);

export type NewExternalTask = typeof externalTasks.$inferInsert;

// CalDAV credentials (Apple/iCloud + generic). Password stored AES-GCM encrypted
// by the app layer — this table never sees plaintext. Multiple accounts per user.
export const caldavAccounts = pgTable(
  "caldav_accounts",
  {
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
  },
  (t) => [unique().on(t.userID, t.serverUrl, t.username)],
);

export type NewCaldavAccount = typeof caldavAccounts.$inferInsert;

// FEDERATION (Musubi ↔ Musubi)

// Bearer tokens for external (shadow) members. The raw token is shown once and
// only this SHA-256 hash persists. Authentication accepts createdAt < 90 days;
// clients rotate during the final 14 days. Removing a shadow user's last
// membership revokes the row in the same transaction.
export const memberTokens = pgTable(
  "member_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    userID: text("user_id")
      .references(() => user.id, { onDelete: "cascade" })
      .notNull(),
    tokenHash: text("token_hash").notNull().unique(),
  },
  (t) => [index("member_tokens_user_idx").on(t.userID)],
);

export type NewMemberToken = typeof memberTokens.$inferInsert;

// Home side: this user's memberships on OTHER Musubi servers. The member token
// is stored AES-GCM encrypted at the app layer (same scheme + key as CalDAV
// passwords) so every signed-in device picks the connection up — accepting an
// invite on one device federates them all.
export const musubiAccounts = pgTable(
  "musubi_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    userID: text("user_id")
      .references(() => user.id, { onDelete: "cascade" })
      .notNull(),
    server: text("server").notNull(), // the origin server's URL
    remoteUserID: text("remote_user_id").notNull(), // our shadow-user id there
    encryptedToken: text("encrypted_token").notNull(),
  },
  (t) => [unique().on(t.userID, t.server)],
);

export type NewMusubiAccount = typeof musubiAccounts.$inferInsert;

// Pages: private per-user calendar view profiles. Not shared with calendar
// members. The config is versioned JSONB (view + calendar visibility + filters)
// saved atomically with one revision for compare-and-swap. Soft-deleted so a
// removed Page can't orphan a client that still holds its id.
export const pages = pgTable(
  "pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userID: text("user_id")
      .references(() => user.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    isDefault: boolean("is_default").notNull().default(false),
    schemaVersion: integer("schema_version").notNull().default(1),
    config: jsonb("config").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [index("pages_user_position_idx").on(t.userID, t.position)],
);

export type NewPage = typeof pages.$inferInsert;
export type PageRow = typeof pages.$inferSelect;

/**
 * Zprávy o novinkách, které majitel serveru píše v admin panelu.
 *
 * `id` je datum (`2026-08-29`, druhá zpráva téhož dne `2026-08-29-2`) a zároveň
 * řazení — formát se lexikograficky řadí správně, takže "novější než poslední
 * viděná" je porovnání řetězců a druhý sloupec na pořadí není potřeba.
 */
export const announcements = pgTable("announcements", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  // Nejstarší verze klienta, které se zpráva týká. NULL = všem. Filtruje se
  // podle ní na klientovi; server neví, jaká verze se ho ptá.
  minVersion: text("min_version"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type NewAnnouncement = typeof announcements.$inferInsert;

// A committed local family operation. The result contains only IDs/revisions,
// so retry history does not retain a second copy of private event content.
export const eventScopeOperations = pgTable("event_scope_operations", {
  actorID: text("actor_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  operationID: uuid("operation_id").notNull(),
  eventID: uuid("event_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  result: jsonb("result").$type<EventScopeOutcome>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [primaryKey({ columns: [table.actorID, table.operationID] })]);

// Private, bounded bulk intent. Each provider write still has its own existing
// outbox journal; this row records the preview and partial outcome across them.
export const outlookMoves = pgTable("outlook_moves", {
  id: uuid("id").primaryKey(),
  actorID: text("actor_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  calendarID: uuid("calendar_id").notNull().references(() => calendars.id, { onDelete: "cascade" }),
  linkID: uuid("link_id").notNull().references(() => externalCalendars.id, { onDelete: "cascade" }),
  eventID: uuid("event_id").notNull(),
  masterID: text("master_id").notNull(),
  status: text("status").$type<"preview" | "running" | "completed" | "stopped">().notNull(),
  journal: jsonb("journal").$type<import("./queries/outlook-move-plan").OutlookMoveJournal>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  index("outlook_moves_owner_family_idx").on(t.actorID, t.linkID, t.masterID, t.createdAt),
  index("outlook_moves_running_idx").on(t.updatedAt).where(sql`${t.status} = 'running'`),
  uniqueIndex("outlook_moves_one_running_idx").on(t.linkID, t.masterID).where(sql`${t.status} = 'running'`),
]);

// Private connected-account availability. Never a shared calendar/event mirror.
export const availabilityAccounts = pgTable("availability_accounts", {
  epoch: uuid("epoch").notNull().defaultRandom(),
  accountID: text("account_id").primaryKey().references(() => account.id, { onDelete: "cascade" }),
  generation: integer("generation").notNull().default(0),
});
export const availabilitySources = pgTable("availability_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountID: text("account_id").notNull().references(() => availabilityAccounts.accountID, { onDelete: "cascade" }),
  externalID: text("external_id").notNull(),
  label: text("label").notNull(),
  accountLabel: text("account_label").notNull(),
  active: boolean("active").notNull().default(true),
  enabled: boolean("enabled").notNull().default(false),
  generation: integer("generation").notNull().default(0),
}, table => [uniqueIndex("availability_sources_account_external").on(table.accountID, table.externalID)]);
