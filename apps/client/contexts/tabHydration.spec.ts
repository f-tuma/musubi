import { beforeEach, expect, it, vi } from "vitest";
import TabLayout from "../app/(tabs)/_layout";
import { useEventsStore } from "@/store/useEventsStore";
import { useCalendarsStore } from "@/store/useCalendarsStore";

const h = vi.hoisted(() => ({ effects: [] as (() => undefined | (() => void))[], ready: vi.fn(), refresh: vi.fn(), calendars: vi.fn(), events: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useEffect: (effect: () => undefined | (() => void)) => { h.effects.push(effect); }, useState: () => [false, h.ready] }));
vi.mock("@/contexts/ServerContext", () => ({ useServer: () => ({ apiUrl: "https://old.example.test", authClient: {} }) }));
vi.mock("@/constants/theme", () => ({ colors: {}, fonts: {} }));
vi.mock("@/lib/haptics", () => ({ select: vi.fn() }));
vi.mock("@/constants/layout", () => ({ tabBarBottomInset: () => 0, tabBarHeight: () => 48, TAB_BAR_ITEM_HEIGHT: 40, TAB_BAR_LABEL_FONT_SIZE: 12, TAB_BAR_TOP_INSET: 0 }));
vi.mock("@/components/LoadingOverlay", () => ({ LoadingOverlay: "LoadingOverlay" }));
vi.mock("@expo/vector-icons", () => ({ Feather: "Feather" }));
vi.mock("expo-router", () => ({ Tabs: Object.assign(() => null, { Screen: () => null }), router: { replace: vi.fn() } }));
vi.mock("react-native-gesture-handler", () => ({ GestureHandlerRootView: "RootView" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@/hooks/useEventsStream", () => ({ useConnectToEventStream: vi.fn() }));
vi.mock("@/hooks/useNotificationActions", () => ({ useNotificationActions: vi.fn() }));
vi.mock("@/hooks/useRefreshData", () => ({ useRefreshData: () => h.refresh }));
vi.mock("@/services/agendaWidget", () => ({ startAgendaWidgetSync: vi.fn() }));
vi.mock("@/lib/signOut", () => ({ onSessionExpired: () => () => undefined, signOutAndReset: vi.fn() }));
vi.mock("@/components/calendar/GlobalEventModals", () => ({ GlobalEventModals: "GlobalEventModals" }));
vi.mock("@/services/eventsCache", () => ({ cacheGetCalendars: h.calendars, cacheGetAllEvents: h.events, cacheUpsertEvents: vi.fn(), cacheDeleteEvents: vi.fn() }));
vi.mock("@/services/notifications", () => ({ cancelEventNotification: vi.fn(), syncScheduledReminders: vi.fn() }));
vi.mock("@/store/useSettingsStore", () => ({ useSettingsStore: (selector: (value: { onboarded: boolean; tabBarLabels: boolean }) => unknown) => selector({ onboarded: true, tabBarLabels: true }) }));
vi.mock("@/store/useEventsStore", async original => {
  const actual = await original<typeof import("@/store/useEventsStore")>();
  return { ...actual, useEventsStore: Object.assign(() => actual.useEventsStore.getState(), actual.useEventsStore) };
});
vi.mock("@/store/useCalendarsStore", async original => {
  const actual = await original<typeof import("@/store/useCalendarsStore")>();
  return { ...actual, useCalendarsStore: Object.assign(() => actual.useCalendarsStore.getState(), actual.useCalendarsStore) };
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function mount() { TabLayout(); const cleanups = h.effects.map(effect => effect()); return () => cleanups.forEach(cleanup => cleanup?.()); }
const calendar = { id: "calendar-a", name: "Account A private" } as any;
const event = { id: "event-a", title: "Account A private", calendars: [calendar.id] } as any;
beforeEach(() => {
  h.effects = []; vi.clearAllMocks(); h.refresh.mockResolvedValue(undefined);
  useEventsStore.getState().resetEvents(); useCalendarsStore.getState().loadCalendars([]);
});

it("hydrates the active account cache then starts the authoritative refresh", async () => {
  h.calendars.mockResolvedValue([calendar]); h.events.mockResolvedValue([event]);
  const unmount = mount(); await settle();
  expect(useCalendarsStore.getState().calendars).toEqual([calendar]);
  expect(useEventsStore.getState().events).toEqual([event]);
  expect(h.refresh).toHaveBeenCalledWith({ full: true });
  expect(h.ready).toHaveBeenCalledWith(true);
  unmount();
});

it.each(["account-reset", "unmount"])("discards old deferred cache hydration after %s and never starts an old-server refresh", async boundary => {
  const cachedEvents = deferred<any[]>(); h.calendars.mockResolvedValue([calendar]); h.events.mockReturnValue(cachedEvents.promise);
  const unmount = mount(); await settle();
  if (boundary === "account-reset") useEventsStore.getState().resetEvents();
  else unmount();
  cachedEvents.resolve([event]); await settle();
  expect(useCalendarsStore.getState().calendars).toEqual([]);
  expect(useEventsStore.getState().events).toEqual([]);
  expect(h.refresh).not.toHaveBeenCalled();
  expect(h.ready).not.toHaveBeenCalled();
  if (boundary === "account-reset") unmount();
});
