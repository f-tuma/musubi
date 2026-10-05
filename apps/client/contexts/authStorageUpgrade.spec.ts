import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { migrate } from "drizzle-orm/expo-sqlite/migrator";
import migrations from "@/drizzle/migrations";
import { CalendarSchema, EventSchema } from "@musubi/types";

const h = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  effects: [] as (() => void | (() => void))[], server: null as unknown,
  createClient: vi.fn(), clearWidget: vi.fn(), cancelReminders: vi.fn(),
  widget: null as string | null, scheduled: new Set<string>(),
  widgetFailure: false, notificationFailure: false, markerFailure: false, ownerMarkerFailure: false,
  cancellationGate: null as Promise<void> | null,
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: () => [h.server, (value: unknown) => { h.server = value; }],
  useEffect: (effect: () => void | (() => void)) => { h.effects.push(effect); },
}));
vi.mock("expo-sqlite", async () => {
  const { sqlitePlatform } = await import("@/test/sqlitePlatform");
  const handle = sqlitePlatform();
  return { openDatabaseSync: () => handle };
});
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => h.storage.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    if (h.markerFailure && key === "musubi_auth_storage_version") throw new Error("marker write failed");
    if (h.ownerMarkerFailure && key === "musubi_account_cache_owner") throw new Error("owner marker write failed");
    h.storage.set(key, value);
  },
  deleteItemAsync: async (key: string) => { h.storage.delete(key); },
}));
vi.mock("@/services/auth-client", () => ({ createClient: h.createClient }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("@/constants/theme", () => ({ colors: { fg4: "gray" } }));
vi.mock("expo-router", () => ({ router: { replace: vi.fn() } }));
vi.mock("@react-native-google-signin/google-signin", () => ({ GoogleSignin: { signOut: vi.fn() } }));
vi.mock("@/modules/musubi-agenda-widget", () => ({ default: {
  clearSnapshot: async () => {
    h.clearWidget();
    if (h.widgetFailure) throw new Error("widget cleanup failed");
    h.widget = null;
  },
} }));
vi.mock("expo-notifications", () => ({
  setNotificationHandler: vi.fn(),
  cancelAllScheduledNotificationsAsync: async () => {
    h.cancelReminders();
    if (h.cancellationGate) await h.cancellationGate;
    if (h.notificationFailure) throw new Error("notification cleanup failed");
    h.scheduled.clear();
  },
}));

const { db, sqlite } = await import("@/services/db");
const { notificationsTable } = await import("@/db/schema");
const { ServerProvider } = await import("./ServerContext");
const { prepareAuthStorage } = await import("@/lib/authStorageUpgrade");
const { accountCacheOwner, prepareAccountCache } = await import("@/lib/accountCache");
const { useEventsStore } = await import("@/store/useEventsStore");
const { useCalendarsStore } = await import("@/store/useCalendarsStore");
const { useSettingsStore } = await import("@/store/useSettingsStore");
const { cacheUpsertEvents, cacheGetAllEvents, cacheSetCalendars, cacheGetCalendars, cacheSetReminders, cacheGetReminders, cacheGetSettingsSync, setLastSync, getLastSync } = await import("@/services/eventsCache");
const database = (sqlite as unknown as { database: { exec(sql: string): void; close(): void } }).database;
const calendar = CalendarSchema.parse({ id: "private-calendar-a", creatorID: "account-a", name: "Account A private", color: "red", members: [] });
const event = EventSchema.parse({ id: "private-event-a", creatorID: "account-a", title: "Account A private", organizer: "account-a", isCanceled: false, isAllDay: false, color: "red", start: "2026-10-05T12:00:00Z", end: "2026-10-05T13:00:00Z", calendars: [calendar.id] });

function start() {
  h.server = null; h.effects = [];
  expect(ServerProvider({ children: "Account B UI" })).toBeNull();
  const cleanups = h.effects.splice(0).map(effect => effect());
  return () => cleanups.forEach(cleanup => cleanup?.());
}
async function started() { await vi.waitFor(() => expect(h.createClient).toHaveBeenCalledOnce()); }
async function seedAccountA() {
  await migrate(db, migrations);
  await cacheUpsertEvents([event]);
  await cacheSetCalendars([calendar]);
  await cacheSetReminders({ default: { minutesBefore: 10, allDay: null }, calendars: {}, events: {} });
  await setLastSync("2026-10-05T10:00:00Z");
  useEventsStore.getState().loadEvents([event]);
  useCalendarsStore.getState().loadCalendars([calendar]);
  useSettingsStore.getState().setCalendarOrder([calendar.id]);
  h.storage.set("musubi_api_example_com_cookie", "ambiguous-old-account-cookie");
  h.storage.set("FEDERATED_ACCOUNTS", '[{"id":"account-a-connection"}]');
  h.widget = event.title; h.scheduled.add("account-a-reminder");
  await db.insert(notificationsTable).values({ identifier: "account-a-reminder", occurrenceID: "account-a-occurrence", eventID: event.id, triggerDate: event.start.toISOString() });
}

beforeEach(() => {
  database.exec("DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS sync_meta; DROP TABLE IF EXISTS notifications_table; DROP TABLE IF EXISTS __drizzle_migrations;");
  h.storage.clear(); h.effects = []; h.server = null;
  h.widget = null; h.scheduled.clear(); h.cancellationGate = null;
  h.widgetFailure = false; h.notificationFailure = false; h.markerFailure = false; h.ownerMarkerFailure = false;
  vi.clearAllMocks();
  h.createClient.mockReturnValue({ getSession: async () => ({ data: { user: { id: "account-b" } } }) });
  useEventsStore.getState().resetEvents();
  useCalendarsStore.getState().loadCalendars([]);
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { database.close(); });

it("starts a fresh install by migrating its empty SQLite database before cleanup", async () => {
  start(); await started();
  expect(await cacheGetAllEvents()).toEqual([]);
  expect(await cacheGetCalendars()).toEqual([]);
  expect(h.storage.get("musubi_auth_storage_version")).toBe("2");
  expect(h.clearWidget).toHaveBeenCalledOnce();
  expect(h.cancelReminders).toHaveBeenCalledOnce();
});

it("wipes account A's persisted mirror, widget and reminders before fresh account B can initialize", async () => {
  await seedAccountA();
  let release!: () => void;
  h.cancellationGate = new Promise<void>(resolve => { release = resolve; });
  start();
  await vi.waitFor(() => expect(h.cancelReminders).toHaveBeenCalledOnce());
  expect(h.createClient).not.toHaveBeenCalled();
  expect(h.server).toBeNull();
  expect(h.storage.has("musubi_auth_storage_version")).toBe(false);
  release(); await started();
  expect(await cacheGetAllEvents()).toEqual([]);
  expect(await cacheGetCalendars()).toEqual([]);
  expect(await getLastSync()).toBeNull();
  expect(await cacheGetReminders()).toBeNull();
  expect(cacheGetSettingsSync()).toBeNull();
  expect(h.storage.has("FEDERATED_ACCOUNTS")).toBe(false);
  expect(h.widget).toBeNull(); expect(h.scheduled.size).toBe(0);
  expect(await db.select().from(notificationsTable)).toEqual([]);
  // The same cache hydration used after B signs in is safe even while the
  // authoritative network snapshot is offline or delayed.
  useCalendarsStore.getState().loadCalendars(await cacheGetCalendars());
  useEventsStore.getState().loadEvents(await cacheGetAllEvents());
  expect(useEventsStore.getState().events).toEqual([]);
  expect(useCalendarsStore.getState().calendars).toEqual([]);
  expect(useSettingsStore.getState().calendarOrder).toEqual([]);
});

it.each(["widget", "notification", "marker"])("keeps auth closed and retries after a failed %s cleanup step", async failure => {
  await seedAccountA();
  h.widgetFailure = failure === "widget";
  h.notificationFailure = failure === "notification";
  h.markerFailure = failure === "marker";
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  start(); await vi.waitFor(() => expect(log).toHaveBeenCalled());
  expect(h.createClient).not.toHaveBeenCalled();
  expect(h.server).toBeNull();
  expect(h.storage.has("musubi_auth_storage_version")).toBe(false);
  h.widgetFailure = false; h.notificationFailure = false; h.markerFailure = false;
  start(); await started();
  expect(await cacheGetAllEvents()).toEqual([]);
  expect(h.widget).toBeNull(); expect(h.scheduled.size).toBe(0);
  expect(h.storage.get("musubi_auth_storage_version")).toBe("2");
});

it("shares one cleanup across concurrent initializations, then preserves the new account's offline cache on restart", async () => {
  await seedAccountA();
  await Promise.all([prepareAuthStorage(), prepareAuthStorage()]);
  expect(h.clearWidget).toHaveBeenCalledOnce();
  expect(h.cancelReminders).toHaveBeenCalledOnce();
  const ownEvent = { ...event, id: "event-b", creatorID: "account-b", title: "Account B private" };
  await cacheUpsertEvents([ownEvent]);
  h.widget = ownEvent.title; h.scheduled.add("account-b-reminder");
  start(); await started();
  expect((await cacheGetAllEvents()).map(value => value.title)).toEqual([ownEvent.title]);
  expect(h.clearWidget).toHaveBeenCalledOnce();
  expect(h.cancelReminders).toHaveBeenCalledOnce();
  expect(h.widget).toBe(ownEvent.title); expect(h.scheduled.has("account-b-reminder")).toBe(true);
});

it("keeps auth closed if the existing SQLite schema cannot be migrated", async () => {
  database.exec("CREATE TABLE events (id TEXT PRIMARY KEY);");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  start(); await vi.waitFor(() => expect(log).toHaveBeenCalled());
  expect(h.createClient).not.toHaveBeenCalled();
  expect(h.server).toBeNull();
  expect(h.storage.has("musubi_auth_storage_version")).toBe(false);
  expect(h.clearWidget).not.toHaveBeenCalled();
});


it("retired and replacement bootstrap effects share a deferred wipe without opening a stale auth client", async () => {
  await seedAccountA();
  let release!: () => void;
  h.cancellationGate = new Promise<void>(resolve => { release = resolve; });
  const retire = start();
  await vi.waitFor(() => expect(h.cancelReminders).toHaveBeenCalledOnce());
  retire();
  start();
  await Promise.resolve(); await Promise.resolve();
  expect(h.createClient).not.toHaveBeenCalled();
  expect(h.storage.has("musubi_auth_storage_version")).toBe(false);
  release(); await started();
  expect(h.clearWidget).toHaveBeenCalledOnce();
  expect(h.cancelReminders).toHaveBeenCalledOnce();
  expect(await cacheGetAllEvents()).toEqual([]);
});


const ownerA = accountCacheOwner("https://home.example.test", "account-a");
const ownerB = accountCacheOwner("https://home.example.test", "account-b");
async function ownedAccountA() {
  await migrate(db, migrations);
  await prepareAccountCache(ownerA);
  await seedAccountA();
  h.storage.set("musubi_auth_storage_version", "2");
  h.clearWidget.mockClear(); h.cancelReminders.mockClear();
}

it("clears cold expired A before welcome and a fresh B even after the v2 upgrade marker exists", async () => {
  await ownedAccountA();
  start(); await started(); // Existing v2 startup retains A until session resolves.
  expect((await cacheGetAllEvents())[0].title).toBe(event.title);
  await prepareAccountCache(null); // Root resolved expired cookie to signed out.
  expect(await cacheGetAllEvents()).toEqual([]);
  expect(h.widget).toBeNull(); expect(h.scheduled.size).toBe(0);
  await prepareAccountCache(ownerB);
  useCalendarsStore.getState().loadCalendars(await cacheGetCalendars());
  useEventsStore.getState().loadEvents(await cacheGetAllEvents());
  expect(useEventsStore.getState().events).toEqual([]);
  expect(useCalendarsStore.getState().calendars).toEqual([]);
  expect(h.storage.get("musubi_account_cache_owner")).toBe(ownerB);
});

it("preserves the proven same actor's offline mirror, widget and reminders across normalized-origin restarts", async () => {
  await ownedAccountA();
  await prepareAccountCache(accountCacheOwner(" HTTPS://HOME.EXAMPLE.TEST/path ", "account-a"));
  expect((await cacheGetAllEvents()).map(value => value.title)).toEqual([event.title]);
  expect((await cacheGetCalendars())[0].name).toBe(calendar.name);
  expect(h.widget).toBe(event.title); expect(h.scheduled.has("account-a-reminder")).toBe(true);
  expect(h.clearWidget).not.toHaveBeenCalled(); expect(h.cancelReminders).not.toHaveBeenCalled();
});

it.each(["different actor", "different origin"])("discards the old mirror for a %s instead of sharing global cache", async boundary => {
  await ownedAccountA();
  const replacement = boundary === "different actor" ? ownerB : accountCacheOwner("https://other.example.test", "account-a");
  await prepareAccountCache(replacement);
  expect(await cacheGetAllEvents()).toEqual([]);
  expect(await cacheGetCalendars()).toEqual([]);
  expect(h.widget).toBeNull(); expect(h.scheduled.size).toBe(0);
  expect(h.storage.get("musubi_account_cache_owner")).toBe(replacement);
});

it.each(["widget", "notification", "owner-marker"])("does not mark the replacement owner prepared after failed %s cleanup", async failure => {
  await ownedAccountA();
  h.widgetFailure = failure === "widget";
  h.notificationFailure = failure === "notification";
  h.ownerMarkerFailure = failure === "owner-marker";
  await expect(prepareAccountCache(ownerB)).rejects.toThrow();
  expect(h.storage.get("musubi_account_cache_owner")).toBe(ownerA);
  h.widgetFailure = false; h.notificationFailure = false; h.ownerMarkerFailure = false;
  await prepareAccountCache(ownerB);
  expect(h.storage.get("musubi_account_cache_owner")).toBe(ownerB);
  expect(await cacheGetAllEvents()).toEqual([]);
  expect(h.widget).toBeNull(); expect(h.scheduled.size).toBe(0);
});

it("orders overlapping owner changes and shares the current owner's deferred cleanup", async () => {
  await ownedAccountA();
  let release!: () => void;
  h.cancellationGate = new Promise<void>(resolve => { release = resolve; });
  const first = prepareAccountCache(ownerB);
  await vi.waitFor(() => expect(h.cancelReminders).toHaveBeenCalledOnce());
  const ownerC = accountCacheOwner("https://other.example.test", "account-c");
  const current = prepareAccountCache(ownerC);
  expect(prepareAccountCache(ownerC)).toBe(current);
  expect(h.storage.get("musubi_account_cache_owner")).toBe(ownerA);
  release(); await Promise.all([first, current]);
  expect(h.storage.get("musubi_account_cache_owner")).toBe(ownerC);
  expect(h.cancelReminders).toHaveBeenCalledTimes(2);
  expect(await cacheGetAllEvents()).toEqual([]);
});
