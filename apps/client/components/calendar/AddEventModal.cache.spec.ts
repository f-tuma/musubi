import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { EventSchema, DEFAULT_REMINDER_RULE, type Event } from "@musubi/types";

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  index: 0,
  effects: [] as (() => void)[],
  collectEffects: false,
}));
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  close: vi.fn(),
  alert: vi.fn(),
  reminder: vi.fn(),
  reconcile: vi.fn(),
  streamMessage: undefined as ((event: { data: string }) => void) | undefined,
}));
vi.mock("react-native-sse", () => ({
  default: class {
    addEventListener(
      type: string,
      listener: (event: { data: string }) => void,
    ) {
      if (type === "message") mocks.streamMessage = listener;
    }
    close() {}
  },
}));
vi.mock("expo-network", () => ({
  addNetworkStateListener: () => ({ remove() {} }),
}));
vi.mock("@/lib/serverDiagnostics", () => ({ recordServerDiagnostic: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void) => {
    if (state.collectEffects) state.effects.push(effect);
  },
  useMemo: (fn: () => unknown) => fn(),
  useRef: (value: unknown) => ({ current: value }),
  useState: (initial: unknown) => {
    const index = state.index++;
    if (!(index in state.values))
      state.values[index] = typeof initial === "function" ? initial() : initial;
    return [
      state.values[index],
      (value: unknown) => {
        state.values[index] =
          typeof value === "function" ? value(state.values[index]) : value;
      },
    ];
  },
}));
vi.mock("react-native-get-random-values", () => ({}));
vi.mock("react-native", () => ({
  Text: "Text",
  TextInput: "TextInput",
  Switch: "Switch",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
  ActivityIndicator: "ActivityIndicator",
  Alert: { alert: mocks.alert },
  Keyboard: { dismiss: vi.fn() },
  Platform: { OS: "android" },
  StyleSheet: { create: (value: unknown) => value },
  useWindowDimensions: () => ({ width: 390, height: 800 }),
}));
vi.mock("@/constants/theme", () => ({
  colors: {},
  fonts: {},
  styles: {},
  activeScheme: () => "light",
}));
vi.mock("@/contexts/ServerContext", () => ({
  useServer: () => ({
    apiUrl: "https://home.example.test",
    authClient: {
      $fetch: mocks.request,
      getSession: async () => ({
        data: { session: { token: "test-session" } },
      }),
      useSession: () => ({ data: { user: { id: "owner" } } }),
    },
  }),
}));
vi.mock("@/hooks/useModalAnimation", () => ({
  useModalAnimation: (_visible: boolean, close: () => void) => ({
    handleClose: () => {
      mocks.close();
      close();
    },
  }),
}));
vi.mock("@/components/ui/ModalPortal", () => ({ ModalPortal: "Modal" }));
vi.mock("react-native-gesture-handler", () => {
  const chain: unknown = new Proxy(() => {}, {
    get: () => chain,
    apply: () => chain,
  });
  return {
    GestureDetector: "GestureDetector",
    GestureHandlerRootView: "GestureHandlerRootView",
    Gesture: { Pan: () => chain },
  };
});
vi.mock("react-native-reanimated", () => ({
  default: { View: "AnimatedView" },
  useSharedValue: (value: unknown) => ({
    value,
    get() { return this.value; },
    set(next: unknown) { this.value = typeof next === "function" ? next(this.value) : next; },
  }),
  useAnimatedStyle: () => ({}),
  withSpring: (value: unknown) => value,
  withTiming: (value: unknown) => value,
  runOnJS: (fn: unknown) => fn,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0, top: 0 }),
}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Icon", Feather: "Icon" }));
vi.mock("@/components/ui/DateTimePicker", () => ({
  DateTimePicker: "DateTimePicker",
}));
vi.mock("@/components/ui/Tap", () => ({ Tap: "Tap" }));
vi.mock("@/components/ui/Btn", () => ({ Btn: "Btn" }));
vi.mock("@/components/ui/OptionPicker", () => ({
  OptionPicker: "OptionPicker",
}));
vi.mock("@/components/SettingRow", () => ({
  SettingRowAction: "SettingRowAction",
}));
vi.mock("@/components/ui/Toast", () => ({ showToast: vi.fn() }));
vi.mock("@/lib/haptics", () => ({ success: vi.fn(), warn: vi.fn() }));
vi.mock("@/store/useSettingsStore", () => ({
  useSettingsStore: () => ({
    timeFormat: "24h",
    dateFormat: "dmy",
    calendarOrder: [],
    tabBarLabels: false,
  }),
}));
vi.mock("@/services/federation", () => ({
  setHomeRequester: vi.fn(),
  remoteForCalendar: vi.fn(),
  fedFetch: vi.fn(),
  syncFederatedAccounts: vi
    .fn()
    .mockResolvedValue({ calendars: [], events: [], syncedServers: new Set() }),
}));
vi.mock("@/services/notifications", () => ({
  setReminderWriter: vi.fn(),
  storeReminderRules: vi.fn(),
  adoptLegacyReminderRules: vi.fn(),
  setEventReminderRule: mocks.reminder,
  syncScheduledReminders: mocks.reconcile,
  cancelEventNotification: vi.fn().mockResolvedValue(undefined),
  reminderRules: () => ({ events: { event: DEFAULT_REMINDER_RULE } }),
  effectiveReminderRule: () => DEFAULT_REMINDER_RULE,
  inheritedReminderRule: () => DEFAULT_REMINDER_RULE,
  requestEventNotificationPermission: vi.fn(async () => true),
}));
vi.mock("@/lib/signOut", () => ({ notifySessionExpired: vi.fn() }));

vi.mock("expo-sqlite", async () => {
  const { sqlitePlatform } = await import("@/test/sqlitePlatform");
  const sqlite = sqlitePlatform();
  return { openDatabaseSync: () => sqlite };
});
vi.mock("@/services/settingsSync", () => ({
  refreshSettingsDocument: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/store/useAttendeesStore", () => ({
  useAttendeesStore: () => vi.fn(),
}));
const { AddEventModal } = await import("./AddEventModal");
const { default: CalendarPickerModal } = await import("./CalendarPickerModal");
vi.mock("./EventDetailModal", () => ({ default: "EventDetailModal" }));
vi.mock("@/store/useCalendarsStore", async (original) => {
  const actual = await original<typeof import("@/store/useCalendarsStore")>();
  return {
    useCalendarsStore: Object.assign(
      () => actual.useCalendarsStore.getState(),
      actual.useCalendarsStore,
    ),
  };
});
vi.mock("@/store/useEventsStore", async (original) => {
  const actual = await original<typeof import("@/store/useEventsStore")>();
  return {
    ...actual,
    useEventsStore: Object.assign(
      () => actual.useEventsStore.getState(),
      actual.useEventsStore,
    ),
  };
});
vi.mock("@/store/useEventDetailStore", async (original) => {
  const actual = await original<typeof import("@/store/useEventDetailStore")>();
  return {
    ...actual,
    useEventDetailStore: Object.assign(
      () => actual.useEventDetailStore.getState(),
      actual.useEventDetailStore,
    ),
    useEditComposerStore: Object.assign(
      () => actual.useEditComposerStore.getState(),
      actual.useEditComposerStore,
    ),
  };
});
const { GlobalEventModals } = await import("./GlobalEventModals");
const { useEventsStore } = await import("@/store/useEventsStore");
const { useEditComposerStore } = await import("@/store/useEventDetailStore");
const master = EventSchema.parse({
  revision: 1,
  id: "event",
  creatorID: "owner",
  organizer: "owner",
  title: "Standup",
  color: "#7A8BA3",
  start: "2026-07-06T09:00:00Z",
  end: "2026-07-06T10:00:00Z",
  isAllDay: false,
  isCanceled: false,
  calendars: ["calendar"],
  originCalendarID: "calendar",
  recurrence: "FREQ=WEEKLY",
});

// Execute the real host-provided props, not a stand-in boolean callback. Native
// hosts/animation are the seam; the form effects, scope helper, stores and API run.
function renderComposer(mount = false) {
  const host = GlobalEventModals();
  const composer = host.props.children.find(
    (child: { type: unknown }) => child.type === AddEventModal,
  );
  state.index = 0;
  state.collectEffects = mount;
  const tree = AddEventModal(composer.props);
  state.collectEffects = false;
  if (mount) {
    state.effects.splice(0).forEach((effect) => effect());
    return renderComposer();
  }
  return tree;
}
function titleInput(
  node: ReactNode,
): { value: string; onChangeText: (value: string) => void } | undefined {
  if (Array.isArray(node)) return node.map(titleInput).find(Boolean);
  if (
    !isValidElement<{
      value: string;
      onChangeText: (value: string) => void;
      children?: ReactNode;
    }>(node)
  )
    return;
  if (node.type === "TextInput") return node.props;
  return titleInput(node.props.children);
}
type Props = {
  label?: string;
  onPress?: () => Promise<void>;
  children?: ReactNode;
};
function saveButton(node: ReactNode): Props | undefined {
  if (Array.isArray(node)) return node.map(saveButton).find(Boolean);
  if (!isValidElement<Props>(node)) return;
  if (node.props.label === "Save") return node.props;
  return saveButton(node.props.children);
}
const { useApi } = await import("@/services/api");
const { useRefreshData } = await import("@/hooks/useRefreshData");
const { useConnectToEventStream } = await import("@/hooks/useEventsStream");
const { serializeEventRefresh } = await import("@/lib/eventSync");
const { useCalendarsStore } = await import("@/store/useCalendarsStore");
const { cacheClearAll, cacheGetAllEvents } = await import(
  "@/services/eventsCache"
);
const { db, sqlite } = await import("@/services/db");
const { migrate } = await import("drizzle-orm/expo-sqlite/migrator");
const migrations = (await import("@/drizzle/migrations")).default;
const calendar = {
  id: "calendar",
  creatorID: "owner",
  role: "owner",
  name: "Calendar",
  color: "#7A8BA3",
  isVisible: true,
  isDefault: false,
};
const apiEvent = { ...master, recurrence: null, revision: 7 };
let fetched: Event[] = [apiEvent];
let fetchedCalendars = [calendar];
let patchResult: () => Promise<unknown>;
let initialBoot = true;

beforeEach(async () => {
  if (initialBoot) {
    await migrate(db, {
      ...migrations,
      journal: {
        ...migrations.journal,
        entries: migrations.journal.entries.slice(0, 7),
      },
    });
    db.run(
      `INSERT INTO events (id, creatorID, title, color, start, end, organizer, calendars, originCalendarID) VALUES ('event', 'owner', 'Old cache', '#7A8BA3', '2026-07-06T09:00:00Z', '2026-07-06T10:00:00Z', 'owner', '["calendar"]', 'calendar')`,
    );
    await migrate(db, migrations);
    initialBoot = false;
  } else await cacheClearAll();
  useEventsStore.getState().loadEvents([]);
  useCalendarsStore.getState().loadCalendars([]);
  vi.clearAllMocks();
  mocks.reconcile.mockResolvedValue(undefined);
  mocks.reminder.mockResolvedValue(undefined);
  state.index = 0;
  state.values = [];
  state.effects = [];
  state.collectEffects = false;
  fetched = [apiEvent];
  fetchedCalendars = [calendar];
  mocks.streamMessage = undefined;
  patchResult = async () => ({
    data: { ...apiEvent, title: "Changed from SQLite", revision: 8 },
    error: null,
  });
  mocks.request.mockImplementation(async (url, options) => {
    if (options.method === "PATCH") return patchResult();
    if (url.includes("/events"))
      return {
        data: {
          events: fetched,
          deletedIds: [],
          serverTime: new Date().toISOString(),
        },
        error: null,
      };
    if (url.includes("/calendars"))
      return { data: fetchedCalendars, error: null };
    if (url.includes("/reminders"))
      return {
        data: { default: DEFAULT_REMINDER_RULE, calendars: {}, events: {} },
        error: null,
      };
    throw new Error(`Unexpected request: ${url}`);
  });
});
afterAll(() =>
  (sqlite as unknown as { database: { close(): void } }).database.close(),
);

it("real refresh fetches revision-bearing Events through SQLite and composer PATCH uses that frozen authority; old-null remains read-only", async () => {
  const [old] = await cacheGetAllEvents();
  useEventsStore.getState().loadEvents([old]);
  useCalendarsStore.getState().loadCalendars([calendar as any]);
  useEditComposerStore.getState().open(old);
  titleInput(renderComposer(true))!.onChangeText("Not authorized yet");
  await saveButton(renderComposer())!.onPress!();
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.reminder).not.toHaveBeenCalled();
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.alert).toHaveBeenLastCalledWith(
    "Failed to save",
    expect.stringContaining("revision is unavailable"),
  );

  await useRefreshData()({ providerSync: false, full: true });
  expect((await cacheGetAllEvents())[0].revision).toBe(7);
  const loaded = useEventsStore.getState().events[0];
  expect(loaded.revision).toBe(7);
  useEditComposerStore.getState().open(loaded);
  state.values = [];
  titleInput(renderComposer(true))!.onChangeText("Changed from SQLite");
  await saveButton(renderComposer())!.onPress!();
  const writes = mocks.request.mock.calls.filter(
    ([, options]) => options.method === "PATCH",
  );
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0][1].body)).toMatchObject({
    expectedRevision: 7,
    patch: { title: "Changed from SQLite" },
  });
  expect((await cacheGetAllEvents())[0]).toMatchObject({
    revision: 8,
    title: "Changed from SQLite",
  });
  expect(useEventsStore.getState().events[0].revision).toBe(8);
  expect(mocks.reminder).toHaveBeenCalledOnce();
  expect(mocks.close).toHaveBeenCalledOnce();
});

for (const removal of [
  "unrelated",
  "target",
  "full-target",
  "full-unchanged",
] as const) {
  for (const outcome of ["success", "committed-error"] as const) {
    it(`actual composer/cache/reminders handle ${outcome} after ${removal} removal`, async () => {
      const other = { ...apiEvent, id: "other" };
      fetched = [other, apiEvent];
      await useRefreshData()({ providerSync: false, full: true });
      useEditComposerStore
        .getState()
        .open(
          useEventsStore.getState().events.find((e) => e.id === apiEvent.id)!,
        );
      titleInput(renderComposer(true))!.onChangeText("Changed from SQLite");
      let finish!: (value: unknown) => void;
      patchResult = () =>
        new Promise((resolve) => {
          finish = resolve;
        });
      const pending = saveButton(renderComposer())!.onPress!();
      await vi.waitFor(() =>
        expect(
          mocks.request.mock.calls.some(([, opts]) => opts.method === "PATCH"),
        ).toBe(true),
      );
      if (removal === "unrelated" || removal === "target") {
        await useEventsStore.getState().localRemoveEvent({
          ...(removal === "target" ? apiEvent : other),
          revision: 9,
        });
      } else {
        fetched =
          removal === "full-target"
            ? [other]
            : [
                useEventsStore
                  .getState()
                  .events.find((e) => e.id === apiEvent.id)!,
              ];
        await useRefreshData()({ providerSync: false, full: true });
      }
      mocks.reminder.mockClear();
      mocks.reconcile.mockClear();
      const receipt = {
        ...apiEvent,
        title: "Changed from SQLite",
        revision: 8,
      };
      finish(
        outcome === "success"
          ? { data: receipt, error: null }
          : {
              data: null,
              error: {
                status: 409,
                code: "provider-conflict",
                localCommitted: true,
                current: receipt,
                error: "Saved locally",
              },
            },
      );
      await pending;
      const removedTarget = removal === "target" || removal === "full-target";
      expect(
        (await cacheGetAllEvents()).some((e) => e.id === apiEvent.id),
      ).toBe(!removedTarget);
      expect(
        useEventsStore.getState().events.some((e) => e.id === apiEvent.id),
      ).toBe(!removedTarget);
      if (removedTarget || outcome === "committed-error") {
        expect(mocks.reminder).not.toHaveBeenCalled();
        expect(mocks.close).not.toHaveBeenCalled();
        expect(useEditComposerStore.getState().master?.revision).toBe(7);
      } else {
        expect(mocks.reminder).toHaveBeenCalledOnce();
        expect(mocks.close).toHaveBeenCalledOnce();
      }
      if (removedTarget)
        expect(
          mocks.reconcile.mock.calls.every(
            ([events]) =>
              !events.some((e: typeof apiEvent) => e.id === apiEvent.id),
          ),
        ).toBe(true);
      else
        expect(
          (await cacheGetAllEvents()).find((e) => e.id === apiEvent.id)
            ?.revision,
        ).toBe(8);
    });
  }
}

for (const action of ["addEvent", "forkEvent"] as const) {
  for (const outcome of ["success", "committed-error"] as const) {
    it(`reconciles server-assigned ${action} identity after full absence (${outcome}) without binding source removal`, async () => {
      await useRefreshData()({ providerSync: false, full: true });
      let finish!: (value: unknown) => void;
      mocks.request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const source =
        action === "addEvent"
          ? { ...apiEvent, id: "client-created" }
          : apiEvent;
      const pending =
        action === "addEvent"
          ? useEventsStore.getState().addEvent(source, useApi())
          : useEventsStore.getState().forkEvent(source, "calendar", useApi());
      fetched = [];
      await useRefreshData()({ providerSync: false, full: true });
      const created = { ...apiEvent, id: "server-created", revision: 1 };
      fetched = [created];
      mocks.request.mockClear();
      finish(
        outcome === "success"
          ? { data: created, error: null }
          : {
              data: null,
              error: {
                status: 409,
                code: "provider-conflict",
                localCommitted: true,
                current: created,
                error: "Saved locally",
              },
            },
      );
      if (outcome === "success") await pending;
      else await expect(pending).rejects.toThrow("Saved locally");
      expect(
        mocks.request.mock.calls.some(
          ([, options]) => options.method === "GET",
        ),
      ).toBe(true);
      expect(useEventsStore.getState().events.map((e) => e.id)).toEqual([
        created.id,
      ]);
      expect(
        (await cacheGetAllEvents()).map((e) => [e.id, e.revision]),
      ).toEqual([[created.id, 1]]);
    });
  }
}

it("an ambiguous committed success requests real reconciliation and preserves draft/commit truth when refetch fails", async () => {
  await useRefreshData()({ providerSync: false, full: true });
  useEditComposerStore.getState().open(useEventsStore.getState().events[0]);
  titleInput(renderComposer(true))!.onChangeText("Held draft");
  let finish!: (value: unknown) => void;
  patchResult = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = saveButton(renderComposer())!.onPress!();
  await vi.waitFor(() =>
    expect(
      mocks.request.mock.calls.some(([, opts]) => opts.method === "PATCH"),
    ).toBe(true),
  );
  fetched = [];
  await useRefreshData()({ providerSync: false, full: true });
  mocks.request.mockImplementation(async () => {
    throw new Error("offline refetch");
  });
  mocks.reminder.mockClear();
  finish({ data: { ...apiEvent, revision: 8 }, error: null });
  await pending;
  expect(await cacheGetAllEvents()).toEqual([]);
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.reminder).not.toHaveBeenCalled();
  expect(titleInput(renderComposer())!.value).toBe("Held draft");
  expect(mocks.alert).toHaveBeenLastCalledWith(
    "Failed to save",
    expect.stringContaining("Saved locally"),
  );
});

it("a receipt-triggered refresh cannot refill SQLite/store/reminders after account/server reset", async () => {
  await useRefreshData()({ providerSync: false, full: true });
  let finish!: (value: unknown) => void;
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = useEventsStore.getState().updateEvent(apiEvent, useApi());
  fetched = [];
  await useRefreshData()({ providerSync: false, full: true });
  let refreshed!: (value: unknown) => void;
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        refreshed = resolve;
      }),
  );
  finish({ data: { ...apiEvent, revision: 8 }, error: null });
  await vi.waitFor(() => expect(refreshed).toBeTypeOf("function"));
  useEventsStore.getState().resetEvents();
  await cacheClearAll();
  mocks.reconcile.mockClear();
  refreshed({
    data: {
      events: [{ ...apiEvent, revision: 8 }],
      deletedIds: [],
      serverTime: new Date().toISOString(),
    },
    error: null,
  });
  await expect(pending).rejects.toThrow("Saved locally");
  expect(useEventsStore.getState().events).toEqual([]);
  expect(await cacheGetAllEvents()).toEqual([]);
  expect(mocks.reconcile).not.toHaveBeenCalled();
});

it("refresh reminder completion uses current store truth after a later target removal", async () => {
  const request = mocks.request.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  mocks.request.mockImplementation((url, options) =>
    url.includes("/reminders")
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : request(url, options),
  );
  const refresh = useRefreshData()({ providerSync: false, full: true });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await useEventsStore
    .getState()
    .localRemoveEvent({ ...apiEvent, revision: 9 });
  mocks.reconcile.mockClear();
  finish({
    data: { default: DEFAULT_REMINDER_RULE, calendars: {}, events: {} },
    error: null,
  });
  await refresh;
  expect(await cacheGetAllEvents()).toEqual([]);
  expect(mocks.reconcile).toHaveBeenCalledWith([]);
});

it("a newer removal while receipt side effects settle still prevents composer reminder override/close", async () => {
  await useRefreshData()({ providerSync: false, full: true });
  useEditComposerStore.getState().open(useEventsStore.getState().events[0]);
  titleInput(renderComposer(true))!.onChangeText("Changed from SQLite");
  mocks.reconcile.mockImplementationOnce(async () => {
    await useEventsStore
      .getState()
      .localRemoveEvent({ ...apiEvent, revision: 9 });
  });
  await saveButton(renderComposer())!.onPress!();
  expect(await cacheGetAllEvents()).toEqual([]);
  expect(mocks.reminder).not.toHaveBeenCalled();
  expect(mocks.close).not.toHaveBeenCalled();
  expect(useEditComposerStore.getState().master?.revision).toBe(7);
});

// Drive the production stream listener/serialized apply queue, not a direct
// store removal. SQLite, refresh, API transport and receipt side effects are real.
function ReceiptStream() {
  useConnectToEventStream();
  return null;
}
async function connectReceiptStream() {
  state.collectEffects = true;
  ReceiptStream();
  state.collectEffects = false;
  const cleanups = state.effects.splice(0).map((effect) => effect());
  await vi.waitFor(() => expect(mocks.streamMessage).toBeTypeOf("function"));
  return () =>
    cleanups.forEach((cleanup) => {
      if (typeof cleanup === "function") (cleanup as () => void)();
    });
}
async function streamCalendarRemoved(id: string) {
  mocks.streamMessage!({
    data: JSON.stringify({ type: "calendar_removed", payload: { id } }),
  });
  await serializeEventRefresh(async () => {});
  expect(useCalendarsStore.getState().calendars.some((c) => c.id === id)).toBe(
    false,
  );
}
function ReceiptCalendarPicker({
  action,
}: {
  action: "linkEvent" | "forkEvent";
}) {
  // Same awaited store callback as EventDetailModal's link/fork pickers. Execute
  // the actual picker too: rejecting the receipt must prevent its handleClose.
  const api = useApi();
  return CalendarPickerModal({
    title: "Receipt target",
    visible: true,
    onClose: () => {},
    onSelect: async (id) => {
      await useEventsStore.getState()[action](apiEvent, id, api);
    },
  });
}
function selectReceiptCalendar(
  action: "linkEvent" | "forkEvent",
  target: string,
) {
  const tree = ReceiptCalendarPicker({ action });
  function option(node: ReactNode): Props | undefined {
    if (Array.isArray(node)) return node.map(option).find(Boolean);
    if (!isValidElement<Props & { accessibilityLabel?: string }>(node)) return;
    if (node.props.accessibilityLabel === `${target} calendar`)
      return node.props;
    return option(node.props.children);
  }
  return option(tree)!.onPress!();
}

for (const action of ["linkEvent", "forkEvent"] as const) {
  for (const outcome of ["success", "committed-error"] as const) {
    for (const reconciliation of [
      "absent",
      "stripped",
      "failed",
      "calendar-fetch-failed",
      "target-absent",
      "rejoined",
    ] as const) {
      it(`calendar_removed before ${action} ${outcome} echo reconciles ${reconciliation} with real SQLite/reminders`, async () => {
        const target = { ...calendar, id: "target", name: "Target" };
        fetchedCalendars = [calendar, target];
        await useRefreshData()({ providerSync: false, full: true });
        const disconnect = await connectReceiptStream();
        const request = mocks.request.getMockImplementation()!;
        let finish!: (value: unknown) => void;
        mocks.request.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        );
        const completed = vi.fn();
        const pending = selectReceiptCalendar(action, target.name).then(
          completed,
        );
        const receipt = {
          ...apiEvent,
          id: action === "linkEvent" ? apiEvent.id : "server-assigned-fork",
          revision: action === "linkEvent" ? 8 : 1,
          calendars:
            action === "linkEvent" ? [calendar.id, target.id] : [target.id],
          originCalendarID: action === "linkEvent" ? calendar.id : target.id,
        };
        // Neither the linked target nor the server-assigned identity has echoed.
        expect(useEventsStore.getState().events).toHaveLength(1);
        expect(useEventsStore.getState().events[0].calendars).toEqual([
          calendar.id,
        ]);
        await streamCalendarRemoved(target.id);
        mocks.reconcile.mockClear();
        mocks.request.mockClear();
        fetchedCalendars =
          reconciliation === "rejoined" ? [calendar, target] : [calendar];
        fetched = [
          "rejoined",
          "calendar-fetch-failed",
          "target-absent",
        ].includes(reconciliation)
          ? action === "linkEvent"
            ? [receipt]
            : [apiEvent, receipt]
          : reconciliation === "stripped" && action === "linkEvent"
            ? [{ ...receipt, calendars: [calendar.id] }]
            : [apiEvent];
        if (reconciliation === "failed")
          mocks.request.mockImplementation(async () => {
            throw new Error("offline reconciliation");
          });
        if (reconciliation === "calendar-fetch-failed")
          mocks.request.mockImplementation(async (url, options) => {
            if (url.includes("/calendars"))
              throw new Error("offline calendars");
            return request(url, options);
          });
        const error = {
          status: 409,
          code: "provider-conflict",
          localCommitted: true,
          current: receipt,
          error: "Saved locally",
        };
        finish(
          outcome === "success"
            ? { data: receipt, error: null }
            : { data: null, error },
        );
        if (outcome === "success" && reconciliation === "rejoined") {
          await pending;
          expect(completed).toHaveBeenCalledOnce();
        } else {
          await expect(pending).rejects.toMatchObject({ localCommitted: true });
          expect(completed).not.toHaveBeenCalled();
        }
        expect(mocks.close).toHaveBeenCalledTimes(
          outcome === "success" && reconciliation === "rejoined" ? 1 : 0,
        );
        expect(
          mocks.request.mock.calls.some(
            ([, options]) => options.method === "GET",
          ),
        ).toBe(true);
        for (const events of [
          useEventsStore.getState().events,
          await cacheGetAllEvents(),
        ]) {
          expect(events.some((e) => e.calendars.includes(target.id))).toBe(
            reconciliation === "rejoined",
          );
          if (action === "forkEvent")
            expect(events.some((e) => e.id === receipt.id)).toBe(
              reconciliation === "rejoined",
            );
        }
        expect(
          mocks.reconcile.mock.calls.every(
            ([events]) =>
              reconciliation === "rejoined" ||
              !events.some((e: Event) => e.calendars.includes(target.id)),
          ),
        ).toBe(true);
        expect(mocks.reminder).not.toHaveBeenCalled();

        // Loss evidence belongs only to requests that witnessed it. An actual
        // later authoritative rejoin/revival and a new write are not banned.
        mocks.request.mockImplementation(request);
        fetchedCalendars = [calendar, target];
        fetched = action === "linkEvent" ? [receipt] : [apiEvent, receipt];
        await useRefreshData()({ providerSync: false, full: true });
        const revived = useEventsStore
          .getState()
          .events.find((e) => e.id === receipt.id)!;
        expect(revived.calendars).toContain(target.id);
        mocks.request.mockImplementationOnce(async () => ({
          data: { ...receipt, revision: receipt.revision + 1 },
          error: null,
        }));
        await useEventsStore.getState().updateEvent(revived, useApi());
        expect(
          (await cacheGetAllEvents()).find((e) => e.id === receipt.id)
            ?.revision,
        ).toBe(receipt.revision + 1);
        disconnect();
      });
    }
    for (const removal of [
      "unrelated-calendar",
      "fork-source-calendar",
      "fork-source-event",
    ] as const) {
      if (action === "linkEvent" && removal !== "unrelated-calendar") continue;
      it(`${action} ${outcome} stays independent of ${removal} via the actual stream`, async () => {
        const target = { ...calendar, id: "target", name: "Target" };
        const unrelated = { ...calendar, id: "unrelated" };
        fetchedCalendars = [calendar, target, unrelated];
        await useRefreshData()({ providerSync: false, full: true });
        const disconnect = await connectReceiptStream();
        let finish!: (value: unknown) => void;
        mocks.request.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        );
        const completed = vi.fn();
        const pending = selectReceiptCalendar(action, target.name).then(
          completed,
        );
        if (removal === "fork-source-event") {
          mocks.streamMessage!({
            data: JSON.stringify({
              type: "event_removed",
              payload: { ...apiEvent, revision: 9 },
            }),
          });
          await serializeEventRefresh(async () => {});
        } else
          await streamCalendarRemoved(
            removal === "unrelated-calendar" ? unrelated.id : calendar.id,
          );
        mocks.request.mockClear();
        mocks.reconcile.mockClear();
        const receipt = {
          ...apiEvent,
          id: action === "linkEvent" ? apiEvent.id : "server-assigned-fork",
          revision: action === "linkEvent" ? 8 : 1,
          calendars:
            action === "linkEvent" ? [calendar.id, target.id] : [target.id],
          originCalendarID: action === "linkEvent" ? calendar.id : target.id,
        };
        finish(
          outcome === "success"
            ? { data: receipt, error: null }
            : {
                data: null,
                error: {
                  status: 409,
                  code: "provider-conflict",
                  localCommitted: true,
                  current: receipt,
                  error: "Saved locally",
                },
              },
        );
        if (outcome === "success") {
          await pending;
          expect(completed).toHaveBeenCalledOnce();
        } else {
          await expect(pending).rejects.toMatchObject({ localCommitted: true });
          expect(completed).not.toHaveBeenCalled();
        }
        expect(mocks.close).toHaveBeenCalledTimes(
          outcome === "success" ? 1 : 0,
        );
        expect(mocks.request).not.toHaveBeenCalled(); // no blanket reconciliation
        expect(
          (await cacheGetAllEvents()).find((e) => e.id === receipt.id),
        ).toMatchObject({
          revision: receipt.revision,
          calendars: receipt.calendars,
        });
        expect(
          useEventsStore.getState().events.find((e) => e.id === receipt.id)
            ?.calendars,
        ).toEqual(receipt.calendars);
        expect(mocks.reconcile).toHaveBeenCalledWith(
          [
            expect.objectContaining({
              id: receipt.id,
              calendars: receipt.calendars,
            }),
          ],
          { onlyEventIDs: [receipt.id] },
        );
        disconnect();
      });
    }
  }
}

for (const outcome of ["success", "committed-error"] as const) {
  for (const failure of ["events", "calendars"] as const) {
    it(`actual composer retains frozen draft and reminder settings on ${outcome} after calendar loss and failed ${failure} reconciliation`, async () => {
      const target = { ...calendar, id: "target", name: "Target" };
      fetchedCalendars = [calendar, target];
      fetched = [{ ...apiEvent, calendars: [calendar.id, target.id] }];
      await useRefreshData()({ providerSync: false, full: true });
      const disconnect = await connectReceiptStream();
      const baseline = useEventsStore.getState().events[0];
      useEditComposerStore.getState().open(baseline);
      titleInput(renderComposer(true))!.onChangeText(
        "Frozen calendar-loss draft",
      );
      let finish!: (value: unknown) => void;
      patchResult = () =>
        new Promise((resolve) => {
          finish = resolve;
        });
      const pending = saveButton(renderComposer())!.onPress!();
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      await streamCalendarRemoved(target.id);
      const request = mocks.request.getMockImplementation()!;
      mocks.request.mockImplementation(async (url, options) => {
        if (url.includes(`/${failure}`))
          throw new Error("offline reconciliation");
        return request(url, options);
      });
      mocks.reconcile.mockClear();
      const receipt = {
        ...baseline,
        revision: 8,
        title: "Frozen calendar-loss draft",
      };
      fetched = [receipt];
      finish(
        outcome === "success"
          ? { data: receipt, error: null }
          : {
              data: null,
              error: {
                status: 409,
                code: "provider-conflict",
                localCommitted: true,
                current: receipt,
                error: "Saved locally",
              },
            },
      );
      await pending;
      expect(useEditComposerStore.getState().master).toEqual(baseline);
      expect(titleInput(renderComposer())!.value).toBe(
        "Frozen calendar-loss draft",
      );
      expect(mocks.close).not.toHaveBeenCalled();
      expect(mocks.reminder).not.toHaveBeenCalled();
      expect(mocks.reconcile).not.toHaveBeenCalled();
      expect(mocks.alert).toHaveBeenLastCalledWith(
        "Failed to save",
        expect.stringContaining("Saved locally"),
      );
      for (const events of [
        useEventsStore.getState().events,
        await cacheGetAllEvents(),
      ]) {
        expect(events[0].calendars).toEqual([calendar.id]);
        expect(events[0].revision).toBe(7);
      }
      disconnect();
    });
  }
}

it("membership filtering strips stale target links but preserves unrelated offline federated cache", async () => {
  await useRefreshData()({ providerSync: false, full: true });
  const remoteCalendar = {
    ...calendar,
    id: "remote-calendar",
    provider: "musubi" as const,
    serverUrl: "https://offline-peer.example.test",
  };
  const remoteEvent = {
    ...apiEvent,
    id: "remote-event",
    calendars: [remoteCalendar.id],
    originCalendarID: remoteCalendar.id,
  };
  await useEventsStore.getState().localAddEvent(remoteEvent);
  const { cacheSetCalendars } = await import("@/services/eventsCache");
  await cacheSetCalendars([calendar as any, remoteCalendar as any]);
  const { syncFederatedAccounts } = await import("@/services/federation");
  vi.mocked(syncFederatedAccounts).mockResolvedValueOnce({
    calendars: [remoteCalendar as any],
    events: [],
    syncedServers: new Set(),
  });
  fetched = [{ ...apiEvent, revision: 8, calendars: [calendar.id, "target"] }];
  await useRefreshData()({ providerSync: false, full: true });
  for (const events of [
    useEventsStore.getState().events,
    await cacheGetAllEvents(),
  ]) {
    expect(events.find((e) => e.id === apiEvent.id)?.calendars).toEqual([
      calendar.id,
    ]);
    expect(events.find((e) => e.id === remoteEvent.id)).toMatchObject(
      remoteEvent,
    );
  }
});

it("failed Google membership refresh keeps the modal source; confirmed removal retires it", async () => {
  useEventsStore.getState().resetEvents();
  fetchedCalendars = [{ ...calendar, provider: "google" } as any];
  await useRefreshData()({ providerSync: false, full: true });
  const loaded = useEventsStore.getState().events[0];
  expect(loaded).toBeDefined();
  const request = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((url, options) => {
    if (url.includes("/calendars")) throw new Error("offline membership read");
    return request(url, options);
  });
  fetched = [];
  await expect(useRefreshData()({ providerSync: false, full: true })).rejects.toThrow("offline membership read");
  expect(useEventsStore.getState().retiredGoogleEventIDs.has(loaded.id)).toBe(false);
  expect(useEventsStore.getState().events.some(event => event.id === loaded.id)).toBe(true);
  mocks.request.mockImplementation(request);
  fetchedCalendars = [];
  await useRefreshData()({ providerSync: false, full: true });
  expect(useEventsStore.getState().retiredGoogleEventIDs.has(loaded.id)).toBe(true);
});
