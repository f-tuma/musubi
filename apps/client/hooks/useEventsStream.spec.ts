import { beforeEach, expect, it, vi } from "vitest";
import { serializeEventRefresh } from "@/lib/eventSync";
import { useConnectToEventStream } from "./useEventsStream";
import { useEventsStore } from "@/store/useEventsStore";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { cacheUpsertEvents } from "@/services/eventsCache";
import { CLIENT_VERSION_HEADER, PRODUCT_VERSION } from "@musubi/types";

const h = vi.hoisted(() => ({
  effects: [] as { run: () => undefined | (() => void); deps?: readonly unknown[] }[],
  refs: [] as { current: unknown }[], refIndex: 0,
  apiUrl: "https://old.example.test", authClient: undefined as undefined | { getSession: ReturnType<typeof vi.fn> },
  streams: [] as { url: string; options: { headers: Record<string, string> }; close: ReturnType<typeof vi.fn>; emit: (type: string, event: unknown) => void }[],
  session: vi.fn(), refresh: vi.fn(), network: undefined as undefined | ((value: { isConnected: boolean }) => void),
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useEffect: (run: () => undefined | (() => void), deps?: readonly unknown[]) => { h.effects.push({ run, deps }); },
  useRef: (current: unknown) => {
    const index = h.refIndex++;
    return h.refs[index] ??= { current };
  },
}));
vi.mock("react-native-sse", () => ({ default: class {
  listeners = new Map<string, (event: unknown) => void>();
  close = vi.fn();
  constructor(public url: string, public options: { headers: Record<string, string> }) { h.streams.push(this); }
  addEventListener(type: string, listener: (event: unknown) => void) { this.listeners.set(type, listener); }
  emit(type: string, event: unknown) { this.listeners.get(type)?.(event); }
} }));
vi.mock("expo-network", () => ({ addNetworkStateListener: (callback: typeof h.network) => { h.network = callback; return { remove: vi.fn() }; } }));
vi.mock("@/contexts/ServerContext", () => ({ useServer: () => ({ apiUrl: h.apiUrl, authClient: h.authClient }) }));
vi.mock("@/hooks/useRefreshData", () => ({ useRefreshData: () => h.refresh }));
vi.mock("@/store/useEventsStore", async original => {
  const actual = await original<typeof import("@/store/useEventsStore")>();
  return { ...actual, useEventsStore: Object.assign(() => actual.useEventsStore.getState(), actual.useEventsStore) };
});
vi.mock("@/store/useCalendarsStore", async original => {
  const actual = await original<typeof import("@/store/useCalendarsStore")>();
  return { ...actual, useCalendarsStore: Object.assign(() => actual.useCalendarsStore.getState(), actual.useCalendarsStore) };
});
vi.mock("@/store/useAttendeesStore", () => ({ useAttendeesStore: () => vi.fn() }));
vi.mock("@/services/eventsCache", () => ({ cacheUpsertEvents: vi.fn().mockResolvedValue(undefined), cacheDeleteEvents: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/notifications", () => ({ cancelEventNotification: vi.fn().mockResolvedValue(undefined), syncScheduledReminders: vi.fn().mockResolvedValue(undefined) }));

function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function RenderHook() { useConnectToEventStream(); }
function render() { h.effects = []; h.refIndex = 0; RenderHook(); return h.effects; }
function mountedHook() {
  let effects = render();
  const cleanups = effects.map(effect => effect.run());
  return {
    unmount: () => cleanups.forEach(cleanup => cleanup?.()),
    rerender: () => {
      const next = render();
      next.forEach((effect, index) => {
        const previous = effects[index].deps;
        if (!effect.deps || !previous || effect.deps.length !== previous.length || effect.deps.some((value, i) => !Object.is(value, previous[i]))) {
          cleanups[index]?.();
          cleanups[index] = effect.run();
        }
      });
      effects = next;
    },
  };
}
function mount() { return mountedHook().unmount; }
const event = { id: "event-a", revision: 1, title: "Account A private", calendars: ["calendar-a"], start: "2026-10-05T12:00:00Z", end: "2026-10-05T13:00:00Z" };
function frame() { h.streams[0].emit("message", { data: JSON.stringify({ type: "event_created", payload: event }) }); }

beforeEach(async () => {
  await serializeEventRefresh(async () => undefined);
  h.effects = []; h.refs = []; h.refIndex = 0; h.streams = []; h.network = undefined;
  h.apiUrl = "https://old.example.test"; h.authClient = { getSession: h.session };
  vi.clearAllMocks();
  h.session.mockResolvedValue({ data: { session: { token: "synthetic-session" } } });
  h.refresh.mockResolvedValue(undefined);
  useEventsStore.getState().resetEvents();
  useCalendarsStore.getState().loadCalendars([]);
});

it("keeps current-session frames ordered and advertises the release version", async () => {
  const wait = deferred(); const blocked = serializeEventRefresh(() => wait.promise);
  const unmount = mount(); await settle(); frame();
  expect(h.streams[0].options.headers[CLIENT_VERSION_HEADER]).toBe(PRODUCT_VERSION);
  expect(useEventsStore.getState().events).toEqual([]);
  wait.resolve(); await blocked; await serializeEventRefresh(async () => undefined);
  expect(useEventsStore.getState().events.map(value => value.title)).toEqual([event.title]);
  expect(cacheUpsertEvents).toHaveBeenCalledOnce();
  unmount();
});

it.each(["account-reset", "unmount"])("drops a queued old-session frame after %s without repopulating store or cache", async boundary => {
  const wait = deferred(); const blocked = serializeEventRefresh(() => wait.promise);
  const unmount = mount(); await settle(); frame();
  if (boundary === "account-reset") useEventsStore.getState().resetEvents();
  else unmount();
  wait.resolve(); await blocked; await serializeEventRefresh(async () => undefined);
  expect(useEventsStore.getState().events).toEqual([]);
  expect(cacheUpsertEvents).not.toHaveBeenCalled();
  if (boundary === "account-reset") unmount();
});

it("does not reconnect with an old session that resolves after account reset", async () => {
  const session = deferred<{ data: { session: { token: string } } }>(); h.session.mockReturnValue(session.promise);
  const unmount = mount();
  useEventsStore.getState().resetEvents();
  session.resolve({ data: { session: { token: "old-synthetic-session" } } }); await settle();
  expect(h.streams).toEqual([]);
  unmount();
});

it("ignores old network and SSE callbacks after reset", async () => {
  const unmount = mount(); await settle();
  useEventsStore.getState().resetEvents();
  h.network!({ isConnected: false }); h.network!({ isConnected: true });
  h.streams[0].emit("open", {}); h.streams[0].emit("open", {}); frame();
  await settle(); await serializeEventRefresh(async () => undefined);
  expect(h.refresh).not.toHaveBeenCalled();
  expect(cacheUpsertEvents).not.toHaveBeenCalled();
  unmount();
});


it.each(["server", "auth-client"])("replaces the network listener for a new %s scope while tabs remain mounted", async boundary => {
  const hook = mountedHook(); await settle();
  const oldNetwork = h.network!;
  const oldStream = h.streams[0];
  useEventsStore.getState().resetEvents();
  if (boundary === "server") h.apiUrl = "https://new.example.test";
  h.authClient = { getSession: h.session };
  hook.rerender(); await settle();

  oldNetwork({ isConnected: false }); oldNetwork({ isConnected: true });
  oldStream.emit("open", {}); oldStream.emit("open", {});
  expect(h.refresh).not.toHaveBeenCalled();
  expect(oldStream.close).toHaveBeenCalledOnce();
  expect(h.streams[1].url).toBe(`${h.apiUrl}/api/stream`);
  h.network!({ isConnected: false }); h.network!({ isConnected: true });
  await settle();
  expect(h.refresh).toHaveBeenCalledExactlyOnceWith({ providerSync: false, full: true });
  hook.unmount();
});
