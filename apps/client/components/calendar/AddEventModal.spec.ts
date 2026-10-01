import { beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { EventSchema, DEFAULT_REMINDER_RULE } from "@musubi/types";
vi.mock("./TimeZonePicker", () => ({ TimeZonePicker: "TimeZonePicker" }));

const state = vi.hoisted(() => ({
  platform: "android" as "android" | "ios",
  values: [] as unknown[],
  index: 0,
  effects: [] as (() => void)[],
  collectEffects: false,
  persistent: false, refs: [] as any[], refIndex: 0, dependencies: [] as any[], effectIndex: 0,
}));
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  close: vi.fn(),
  alert: vi.fn(),
  actionSheet: vi.fn(),
  reminder: vi.fn(),
  reconcile: vi.fn(),
  cache: vi.fn(),
  stream: {} as Record<string, (event: { data: string }) => void>,
  refresh: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void, deps: unknown[]) => {
    if (state.persistent) {
      const index = state.effectIndex++;
      if (!state.dependencies[index] || deps?.some((value, i) => value !== state.dependencies[index][i])) state.effects.push(effect);
      state.dependencies[index] = deps;
      return;
    }
    if (state.collectEffects) state.effects.push(effect);
  },
  useMemo: (fn: () => unknown) => fn(),
  useRef: (value: unknown) => {
    if (!state.persistent) return { current: value };
    const index = state.refIndex++;
    return state.refs[index] ??= { current: value };
  },
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
  ActionSheetIOS: { showActionSheetWithOptions: mocks.actionSheet },
  Keyboard: { dismiss: vi.fn() },
  Platform: { get OS() { return state.platform; } },
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
}));
vi.mock("@/services/notifications", () => ({
  setReminderWriter: vi.fn(),
  setEventReminderRule: mocks.reminder,
  syncScheduledReminders: mocks.reconcile,
  cancelEventNotification: vi.fn(),
  reminderRules: () => ({ events: { event: DEFAULT_REMINDER_RULE } }),
  effectiveReminderRule: () => DEFAULT_REMINDER_RULE,
  inheritedReminderRule: () => DEFAULT_REMINDER_RULE,
  requestEventNotificationPermission: vi.fn(async () => true),
}));
vi.mock("@/lib/signOut", () => ({ notifySessionExpired: vi.fn() }));

vi.mock("react-native-sse", () => ({
  default: class {
    addEventListener(name: string, fn: (event: { data: string }) => void) {
      mocks.stream[name] = fn;
    }
    close() {}
  },
}));
vi.mock("expo-network", () => ({
  addNetworkStateListener: () => ({ remove() {} }),
}));
vi.mock("@/lib/serverDiagnostics", () => ({ recordServerDiagnostic: vi.fn() }));
vi.mock("@/hooks/useRefreshData", () => ({
  useRefreshData: () => mocks.refresh,
  refreshEventData: mocks.refresh,
}));
vi.mock("@/store/useAttendeesStore", () => ({
  useAttendeesStore: () => vi.fn(),
}));
const { useConnectToEventStream } = await import("@/hooks/useEventsStream");
function StreamHost() {
  useConnectToEventStream();
  return null;
}
async function receiveEvent(event: typeof master) {
  state.effects = [];
  state.collectEffects = true;
  StreamHost();
  state.collectEffects = false;
  for (const effect of state.effects) effect();
  await vi.waitFor(() => expect(mocks.stream.message).toBeTypeOf("function"));
  mocks.stream.message({
    data: JSON.stringify({ type: "event_updated", payload: event }),
  });
  await vi.waitFor(() =>
    expect(
      useEventsStore.getState().events.find((e) => e.id === event.id)?.revision,
    ).toBe(event.revision),
  );
}

const { AddEventModal } = await import("./AddEventModal");
vi.mock("./EventDetailModal", () => ({ default: "EventDetailModal" }));
vi.mock("@/services/eventsCache", () => ({
  cacheDeleteEvents: mocks.cache,
  cacheUpsertEvents: mocks.cache,
}));
vi.mock("@/store/useCalendarsStore", async original => {
  const actual = await original<typeof import("@/store/useCalendarsStore")>();
  return { useCalendarsStore: Object.assign(() => actual.useCalendarsStore.getState(), actual.useCalendarsStore) };
});
vi.mock("@/store/useEventsStore", async (original) => {
  const actual = await original<typeof import("@/store/useEventsStore")>();
  return {
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
const { useCalendarsStore } = await import("@/store/useCalendarsStore");
const { useEventsStore } = await import("@/store/useEventsStore");
const { useEditComposerStore, useEventDetailStore, presentEventDetail } = await import("@/store/useEventDetailStore");
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
  calendars: ["00000000-0000-4000-8000-000000000155"],
  originCalendarID: "00000000-0000-4000-8000-000000000155",
  recurrence: "FREQ=WEEKLY",
});
const occurrence = {
  ...master,
  start: new Date("2026-07-20T09:00:00Z"),
  end: new Date("2026-07-20T10:00:00Z"),
};

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
function scopeAnswer(label: string) {
  if (state.platform === "ios") {
    const [options, answer] = mocks.actionSheet.mock.lastCall!;
    expect(options.title).toBe("Change recurring event");
    answer(options.options.indexOf(label));
    return;
  }
  expect(mocks.alert.mock.lastCall![0]).toBe("Change recurring event");
  const options = mocks.alert.mock.lastCall![2] as {
    text: string;
    onPress: () => void;
  }[];
  options.find((option) => option.text === label)!.onPress();
}
type Props = {
  label?: string;
  onPress?: () => Promise<void>;
  children?: ReactNode;
};
function saveButton(node: ReactNode): Props | undefined {
  if (Array.isArray(node)) return node.map(saveButton).find(Boolean);
  if (!isValidElement<Props>(node)) return;
  if (node.props.label === "Save" || node.props.label === "Create") return node.props;
  return saveButton(node.props.children);
}
beforeEach(() => {
  state.platform = "android";
  state.persistent = false; state.refs = []; state.dependencies = [];

  vi.clearAllMocks();
  mocks.stream = {};
  mocks.request.mockReset();
  mocks.cache.mockResolvedValue(undefined);
  mocks.reconcile.mockResolvedValue(undefined);
  mocks.reminder.mockImplementation(async () => {
    await mocks.reconcile();
  });
  state.index = 0;
  state.values = [];
  state.effects = [];
  state.collectEffects = false;
  useCalendarsStore.getState().loadCalendars([{ id: master.calendars[0], creatorID: "owner", role: "owner", name: "Calendar", color: "#7A8BA3" } as any]);
  useEventsStore.setState({ events: [master] });
  useEditComposerStore.getState().open(occurrence);
});

it("GlobalEventModals scope Cancel retains the actual draft and reminders, then a successful retry saves and closes", async () => {
  const tree = renderComposer(true);
  titleInput(tree)!.onChangeText("Keep native draft");
  const mutations = vi.fn();
  const unsubscribe = useEventsStore.subscribe(mutations);
  const cancelled = saveButton(renderComposer())!.onPress!();
  await vi.waitFor(() => expect(mocks.alert).toHaveBeenCalledOnce());
  scopeAnswer("Cancel");
  await cancelled;
  expect(useEditComposerStore.getState().visible).toBe(true);
  expect(titleInput(renderComposer())!.value).toBe("Keep native draft");
  expect(useEditComposerStore.getState().prefilled).toEqual(occurrence);
  expect(state.values[7]).toEqual(DEFAULT_REMINDER_RULE);
  expect(useEventsStore.getState().events).toEqual([master]);
  expect(mutations).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.cache).not.toHaveBeenCalled();
  expect(mocks.reminder).not.toHaveBeenCalled();
  expect(mocks.reconcile).not.toHaveBeenCalled();
  expect(mocks.close).not.toHaveBeenCalled();
  unsubscribe();

  let complete!: (value: unknown) => void;
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const saved = saveButton(renderComposer())!.onPress!();
  await vi.waitFor(() => expect(mocks.alert).toHaveBeenCalledTimes(2));
  scopeAnswer("All events");
  await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.reminder).not.toHaveBeenCalled();
  const options = mocks.request.mock.lastCall![1];
  expect(options.method).toBe("PATCH");
  const { scopeEdit, ...update } = JSON.parse(options.body);
  expect(update.expectedRevision).toBe(1);
  expect(update.patch).toEqual({ title: "Keep native draft" });
  expect(scopeEdit).toEqual({ updates: [update], creates: [] });
  expect(useEventsStore.getState().events[0]).not.toHaveProperty("scopeEdit");
  complete({ error: null, data: { ...master, ...update.patch, revision: 2 } });
  await saved;
  expect(mocks.reminder).toHaveBeenCalledOnce();
  expect(mocks.reconcile).toHaveBeenCalledTimes(2);
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(useEditComposerStore.getState().visible).toBe(false);
  expect(titleInput(renderComposer())!.value).toBe("");
  expect(useEventsStore.getState().events[0]).toMatchObject({
    title: "Keep native draft",
    start: master.start,
    end: master.end,
  });
  expect(useEventsStore.getState().events[0]).not.toHaveProperty("scopeEdit");
});

it.each(["denied", "unknown", "unsupported", "network"])(
  "GlobalEventModals form keeps draft and reminders after real scoped %s",
  async (reason) => {
    const message = `Event writing is ${reason}. No changes were saved.`;
    mocks.request.mockImplementation(async () => {
      if (reason === "network") throw new Error(message);
      return {
        error: {
          status: 403,
          error: message,
          reason,
          capability: "event-write",
        },
        data: null,
      };
    });
    titleInput(renderComposer(true))!.onChangeText("Keep native draft");
    const pending = saveButton(renderComposer())!.onPress!();
    await vi.waitFor(() => expect(mocks.alert).toHaveBeenCalledOnce());
    scopeAnswer("This event");
    await pending;
    expect(mocks.request).toHaveBeenCalledOnce();
    const { scopeEdit } = JSON.parse(mocks.request.mock.lastCall![1].body);
    expect(scopeEdit.creates[0]).toMatchObject({
      title: "Keep native draft",
      start: occurrence.start.toISOString(),
      end: occurrence.end.toISOString(),
    });
    expect(mocks.alert).toHaveBeenLastCalledWith("Failed to save", message);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.reminder).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(useEditComposerStore.getState().visible).toBe(true);
    expect(titleInput(renderComposer())!.value).toBe("Keep native draft");
    expect(state.values[7]).toEqual(DEFAULT_REMINDER_RULE);
    expect(useEventsStore.getState().events).toEqual([master]);
  },
);

it.each([
  "event-revision-conflict",
  "provider-conflict",
  "network",
  "401",
  "426",
])(
  "K06 real composer keeps frozen master and newer SSE across %s",
  async (code) => {
    titleInput(renderComposer(true))!.onChangeText("Second draft title");
    const newer = {
      ...master,
      revision: 3,
      title: "Inbound title",
      start: new Date("2026-07-06T12:00:00Z"),
      end: new Date("2026-07-06T13:00:00Z"),
    };
    await useEventsStore.getState().localUpdateEvent(newer);
    mocks.reconcile.mockClear();
    mocks.cache.mockClear();
    mocks.request.mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      expect(body.expectedRevision).toBe(1);
      expect(body.patch).toEqual({ title: "Second draft title" });
      expect(useEventsStore.getState().events[0]).toEqual(newer);
      if (code === "network") throw new TypeError("Network failed");
      if (["401", "426"].includes(code))
        return {
          error: { status: Number(code), message: "Upgrade or sign in" },
          data: null,
        };
      return {
        error: {
          status: 409,
          error:
            code === "provider-conflict"
              ? "Saved locally. Remote delivery unconfirmed. Refresh and reconcile."
              : "Event changed. Refresh and reconcile.",
          code,
          localCommitted: code === "provider-conflict",
          current: { ...newer, revision: 2 },
        },
        data: null,
      };
    });
    const pending = saveButton(renderComposer())!.onPress!();
    await vi.waitFor(() => expect(mocks.alert).toHaveBeenCalledOnce());
    scopeAnswer("All events");
    await pending;
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(useEditComposerStore.getState().visible).toBe(true);
    expect(titleInput(renderComposer())!.value).toBe("Second draft title");
    expect(useEventsStore.getState().events[0]).toEqual(newer);
    expect(useEditComposerStore.getState().master?.revision).toBe(1);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.reminder).not.toHaveBeenCalled();
    expect(mocks.cache).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  },
);

it("K06 revisionless native cache is nonwritable without mutating cache or reminders", async () => {
  const old = { ...occurrence, revision: undefined };
  useEventsStore.setState({ events: [{ ...master, revision: undefined }] });
  useEditComposerStore.getState().open(old);
  titleInput(renderComposer(true))!.onChangeText("Keep old cache draft");
  const pending = saveButton(renderComposer())!.onPress!();
  await vi.waitFor(() => expect(mocks.alert).toHaveBeenCalledOnce());
  scopeAnswer("All events");
  await pending;
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.cache).not.toHaveBeenCalled();
  expect(mocks.reminder).not.toHaveBeenCalled();
  expect(mocks.close).not.toHaveBeenCalled();
  expect(titleInput(renderComposer())!.value).toBe("Keep old cache draft");
  expect(mocks.alert).toHaveBeenLastCalledWith(
    "Failed to save",
    expect.stringContaining("revision is unavailable"),
  );
});

it.each(["network", "provider-conflict"])(
  "K06 in-flight %s never rolls back over a later SSE",
  async (code) => {
    titleInput(renderComposer(true))!.onChangeText("Pending draft");
    let complete!: (value: unknown) => void;
    let fail!: (error: Error) => void;
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          complete = resolve;
          fail = reject;
        }),
    );
    const pending = saveButton(renderComposer())!.onPress!();
    await vi.waitFor(() => expect(mocks.alert).toHaveBeenCalledOnce());
    scopeAnswer("All events");
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
    expect(useEventsStore.getState().events[0].title).toBe("Pending draft");
    const inbound = {
      ...master,
      revision: 4,
      title: "Later inbound",
      start: new Date("2026-07-06T14:00:00Z"),
    };
    await receiveEvent(inbound);
    mocks.cache.mockClear();
    mocks.reconcile.mockClear();
    if (code === "network") fail(new TypeError("Network failed"));
    else
      complete({
        error: {
          status: 409,
          code,
          error:
            "Saved locally. Remote delivery unconfirmed. Refresh and reconcile.",
          localCommitted: true,
          current: { ...master, title: "Pending draft", revision: 2 },
        },
        data: null,
      });
    await pending;
    expect(useEventsStore.getState().events[0]).toEqual(inbound);
    expect(titleInput(renderComposer())!.value).toBe("Pending draft");
    expect(useEditComposerStore.getState().master?.revision).toBe(1);
    expect(mocks.cache).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.reminder).not.toHaveBeenCalled();
  },
);

it("K06 actual native SSE removal respects revisions and reconciles an unversioned access-loss frame", async () => {
  renderComposer(true);
  const inbound = { ...master, revision: 3 };
  await receiveEvent(inbound);
  const { serializeEventRefresh } = await import("@/lib/eventSync");
  mocks.stream.message({
    data: JSON.stringify({
      type: "event_removed",
      payload: { id: master.id, revision: 2 },
    }),
  });
  await serializeEventRefresh(async () => undefined);
  expect(useEventsStore.getState().events[0].revision).toBe(3);
  mocks.stream.message({
    data: JSON.stringify({ type: "event_removed", payload: { id: master.id } }),
  });
  expect(mocks.refresh).toHaveBeenCalledWith({
    providerSync: false,
    full: true,
  });
  expect(useEventsStore.getState().events[0].revision).toBe(3);
  mocks.stream.message({
    data: JSON.stringify({
      type: "event_removed",
      payload: { id: master.id, revision: 3 },
    }),
  });
  await serializeEventRefresh(async () => undefined);
  expect(useEventsStore.getState().events).toEqual([]);
  expect(useEditComposerStore.getState().master?.revision).toBe(1);
});

it("K06 postcommit failure accepts server truth without closing or advancing the draft baseline", async () => {
  titleInput(renderComposer(true))!.onChangeText("Locally committed draft");
  mocks.request.mockResolvedValueOnce({
    data: null,
    error: {
      status: 409,
      code: "provider-conflict",
      error:
        "Saved locally. Remote delivery unconfirmed. Refresh and reconcile.",
      localCommitted: true,
      currentRevision: 2,
      current: { ...master, title: "Locally committed draft", revision: 2 },
    },
  });
  const pending = saveButton(renderComposer())!.onPress!();
  await vi.waitFor(() => expect(mocks.alert).toHaveBeenCalledOnce());
  scopeAnswer("All events");
  await pending;
  expect(useEventsStore.getState().events[0]).toMatchObject({
    title: "Locally committed draft",
    revision: 2,
  });
  expect(mocks.cache).toHaveBeenLastCalledWith([
    expect.objectContaining({ revision: 2 }),
  ]);
  expect(mocks.reconcile).toHaveBeenCalledOnce();
  expect(titleInput(renderComposer())!.value).toBe("Locally committed draft");
  expect(useEditComposerStore.getState().master?.revision).toBe(1);
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.reminder).not.toHaveBeenCalled();
});


it("saves a known civil date and title through one time request without losing hidden precision", async () => {
  const { resolveEventTimeEdit } = await import("@musubi/calendar");
  const known = EventSchema.parse({ ...master, recurrence: null, ...resolveEventTimeEdit({ kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-03-29T02:30:17.123", endLocal: "2026-03-29T04:30:19.456" }) });
  useEventsStore.setState({ events: [known] });
  useEditComposerStore.getState().open(known);
  const tree = renderComposer(true);
  function field(node: ReactNode, label: string): { value: string; onChangeText: (value: string) => void } | undefined {
    if (Array.isArray(node)) return node.map(child => field(child, label)).find(Boolean);
    if (!isValidElement<{ accessibilityLabel?: string; value: string; onChangeText: (value: string) => void; children?: ReactNode }>(node)) return;
    if (node.props.accessibilityLabel === label) return node.props;
    return field(node.props.children, label);
  }
  expect(field(tree, "Starts time (HH:mm)")!.value).toBe("02:30");
  titleInput(tree)!.onChangeText("Civil draft");
  field(tree, "Starts date (YYYY-MM-DD)")!.onChangeText("2026-03-30");
  field(tree, "Ends date (YYYY-MM-DD)")!.onChangeText("2026-03-30");
  mocks.request.mockImplementationOnce(async (_url, options) => {
    const body = JSON.parse(options.body);
    return { error: null, data: { ...known, ...body.patch, ...resolveEventTimeEdit(body.time), revision: 2 } };
  });
  await saveButton(renderComposer())!.onPress!();
  expect(mocks.request).toHaveBeenCalledOnce();
  const [url, options] = mocks.request.mock.lastCall!;
  expect(url).toContain(`/events/${known.id}/time`);
  expect(options.method).toBe("PUT");
  expect(JSON.parse(options.body)).toMatchObject({ expectedRevision: 1, patch: { title: "Civil draft" }, time: { startLocal: "2026-03-30T02:30:17.123", endLocal: "2026-03-30T04:30:19.456" } });
  expect(useEventsStore.getState().events[0]).not.toHaveProperty("timeEdit");
  expect(mocks.reminder).toHaveBeenCalledWith(expect.objectContaining({ start: new Date("2026-03-30T00:30:17.123Z"), end: new Date("2026-03-30T02:30:19.456Z"), timeModel: expect.objectContaining({ startLocal: "2026-03-30T02:30:17.123" }) }), null);
});


  function find(node: ReactNode, predicate: (props: Record<string, unknown>) => boolean): Record<string, any> | undefined {
    if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
    if (!isValidElement<Record<string, any>>(node)) return;
    if (predicate(node.props)) return node.props;
    return find(node.props.children, predicate);
  }
it("requires an explicit zone when adopting a legacy event and commits the whole draft", async () => {
  const { resolveEventTimeEdit } = await import("@musubi/calendar");
  const legacy = EventSchema.parse({ ...master, recurrence: null });
  useEventsStore.setState({ events: [legacy] });
  useEditComposerStore.getState().open(legacy);
  renderComposer(true);
  const picker = find(renderComposer(), props => props.title === "Time model")!;
  picker.onSelect("zoned");
  find(renderComposer(), props => props.label === "Advanced time settings")!.onPress();
  const tree = renderComposer();
  const zone = find(tree, props => props.accessibilityLabel === "Event time zone")!;
  expect(zone.value).toBe("");
  titleInput(tree)!.onChangeText("Adopted draft");
  await saveButton(renderComposer())!.onPress!();
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.close).not.toHaveBeenCalled();
  expect(titleInput(renderComposer())!.value).toBe("Adopted draft");
  zone.onChange("Europe/Prague");
  mocks.request.mockImplementationOnce(async (_url, options) => {
    const body = JSON.parse(options.body);
    return { error: null, data: { ...legacy, ...body.patch, ...resolveEventTimeEdit(body.time), revision: 2 } };
  });
  await saveButton(renderComposer())!.onPress!();
  expect(mocks.request).toHaveBeenCalledOnce();
  const options = mocks.request.mock.lastCall![1];
  expect(options.method).toBe("PUT");
  expect(JSON.parse(options.body)).toMatchObject({ expectedRevision: 1, patch: { title: "Adopted draft" }, time: { kind: "zoned", timeZone: "Europe/Prague" } });
});


it("initializes the all-day switch from the event and converts on its first change", async () => {
  const { resolveEventTimeEdit } = await import("@musubi/calendar");
  const allDay = EventSchema.parse({ ...master, recurrence: null, ...resolveEventTimeEdit({ kind: "all-day", startDate: "2026-07-25", endDate: "2026-07-26" }) });
  useEventsStore.setState({ events: [allDay] });
  useEditComposerStore.getState().open(allDay);
  const toggle = find(renderComposer(true), props => props.accessibilityLabel === "All-day event")!;
  expect(toggle.value).toBe(true);
  toggle.onValueChange(false);
  find(renderComposer(), props => props.label === "Advanced time settings")!.onPress();
  const tree = renderComposer();
  expect(find(tree, props => props.accessibilityLabel === "All-day event")!.value).toBe(false);
  expect(find(tree, props => props.accessibilityLabel === "Event time zone")!.value).toBe("");
  expect(find(tree, props => props.accessibilityLabel === "Starts time (HH:mm)")!.value).toBe("00:00");
});


it("keeps the displayed legacy all-day dates when adopting an explicit model", async () => {
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(process.env.MUSUBI_TEST_EXPECTED_ZONE ?? "Europe/Prague");
  const legacy = EventSchema.parse({ ...master, recurrence: null, isAllDay: true, start: new Date("2026-07-25T00:00:00Z"), end: new Date("2026-07-26T00:00:00Z") });
  useEventsStore.setState({ events: [legacy] });
  useEditComposerStore.getState().open(legacy);
  const tree = renderComposer(true);
  // Actual picker state: assertions are independent of the process's offset.
  const dates = state.values.filter((value): value is Date => value instanceof Date);
  expect(dates.some(value => value.getDate() === 25 && value.getHours() === 0)).toBe(true);
  expect(dates.some(value => value.getDate() === 26 && value.getHours() === 0)).toBe(true);
  find(tree, props => props.title === "Time model")!.onSelect("all-day");
  const adopted = renderComposer();
  expect(find(adopted, props => props.accessibilityLabel === "Starts date (YYYY-MM-DD)")!.value).toBe("2026-07-25");
  expect(find(adopted, props => props.accessibilityLabel === "Ends date (YYYY-MM-DD)")!.value).toBe("2026-07-26");
});


it.each(["zoned", "floating", "all-day"] as const)("keeps the tapped %s occurrence's civil dates through detail refresh and edit", async kind => {
  const { expandRecurringEvents, resolveEventTimeEdit, knownEventTimeDraft } = await import("@musubi/calendar");
  const { liveEventDetail } = await import("@/lib/liveEvent");
  const series = EventSchema.parse({ ...master, id: "00000000-0000-4000-8000-000000000153", recurrence: "FREQ=DAILY;COUNT=4",
    ...resolveEventTimeEdit(kind === "all-day" ? { kind, startDate: "2026-03-28", endDate: "2026-03-29" } : {
      kind, ...(kind === "zoned" ? { timeZone: "Europe/Prague" } : {}), startLocal: "2026-03-28T09:30:17.123", endLocal: "2026-03-28T10:30:19.456",
    }),
  });
  const expanded = expandRecurringEvents([series], new Date("2026-03-30T00:00:00Z"), new Date("2026-03-31T00:00:00Z"), { consumerTimeZone: "America/New_York" });
  const tapped = expanded.find(item => knownEventTimeDraft(item)!.date === "2026-03-30")!;
  expect(tapped).toBeDefined();
  useEventsStore.setState({ events: [series] });
  presentEventDetail([series], tapped);
  const detail = useEventDetailStore.getState().event!;
  expect(detail.id).toBe(series.id);
  expect(detail.timeModel).toEqual(tapped.timeModel);
  expect(detail.start).toEqual(tapped.start);
  const renamed = { ...series, title: "Remote title", revision: 2 };
  useEventsStore.setState({ events: [renamed] });
  const live = liveEventDetail([renamed], detail)!;
  expect(live.title).toBe("Remote title");
  expect(live.timeModel).toEqual(tapped.timeModel);
  useEditComposerStore.getState().open(live);
  const tree = renderComposer(true);
  expect(find(tree, props => props.accessibilityLabel === "Starts date (YYYY-MM-DD)")!.value).toBe("2026-03-30");
  if (kind !== "all-day") expect(find(tree, props => props.accessibilityLabel === "Starts time (HH:mm)")!.value).toBe("09:30");
  expect(useEditComposerStore.getState().master!.start).toEqual(series.start);
  expect(useEditComposerStore.getState().master!.timeModel).toEqual(series.timeModel);
  expect(useEditComposerStore.getState().prefilled!.timeModel).toEqual(tapped.timeModel);
  titleInput(tree)!.onChangeText("Rename whole series");
  let finish!: (value: unknown) => void;
  mocks.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const saving = saveButton(renderComposer())!.onPress!();
  await vi.waitFor(() => expect(mocks.alert).toHaveBeenCalledOnce());
  scopeAnswer("All events");
  await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
  expect(useEventsStore.getState().events[0]).toMatchObject({ start: series.start, end: series.end, timeModel: series.timeModel });
  expect(JSON.parse(mocks.request.mock.lastCall![1].body)).toMatchObject({ expectedRevision: 2, patch: { title: "Rename whole series" } });
  useEventsStore.setState({ events: [{ ...renamed, title: "Rename whole series", revision: 3 }] });
  finish({ error: null, data: { operationID: JSON.parse(mocks.request.mock.lastCall![1].body).operationID, changed: true, events: [{ id: series.id, revision: 3 }], deleted: [], localCommitted: true, replayed: false } });
  await saving;
  expect(useEventsStore.getState().events[0].timeModel).toEqual(series.timeModel);
});


it("saves a whole-series civil date shift across DST and schedules from the saved master", async () => {
  const { expandRecurringEvents, resolveEventTimeEdit, knownEventTimeDraft } = await import("@musubi/calendar");
  const series = EventSchema.parse({ ...master, id: "00000000-0000-4000-8000-000000000154", recurrence: "FREQ=DAILY;COUNT=4", ...resolveEventTimeEdit({ kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-03-28T09:30:17.123", endLocal: "2026-03-28T10:30:19.456" }) });
  const tapped = expandRecurringEvents([series], new Date("2026-03-29T00:00Z"), new Date("2026-03-30T00:00Z"), { consumerTimeZone: "America/New_York" }).find(item => knownEventTimeDraft(item)!.date === "2026-03-29")!;
  useEventsStore.setState({ events: [series] });
  presentEventDetail([series], tapped);
  useEditComposerStore.getState().open(useEventDetailStore.getState().event!);
  const tree = renderComposer(true);
  titleInput(tree)!.onChangeText("Civil series draft");
  find(tree, props => props.accessibilityLabel === "Starts date (YYYY-MM-DD)")!.onChangeText("2026-03-30");
  find(tree, props => props.accessibilityLabel === "Ends date (YYYY-MM-DD)")!.onChangeText("2026-03-30");
  mocks.request.mockResolvedValueOnce({ data: null, error: { status: 403, error: "Scope editing is not enabled" } });
  let saving = saveButton(renderComposer())!.onPress!();
  await vi.waitFor(() => expect(mocks.alert).toHaveBeenCalledOnce());
  scopeAnswer("This event");
  await saving;
  expect(mocks.request).toHaveBeenCalledOnce();
  expect(mocks.close).not.toHaveBeenCalled();
  expect(titleInput(renderComposer())!.value).toBe("Civil series draft");
  mocks.alert.mockClear();
  mocks.request.mockClear();
  mocks.request.mockImplementationOnce(async (_url, options) => {
    const body = JSON.parse(options.body);
    useEventsStore.setState({ events: [{ ...series, ...body.patch, ...resolveEventTimeEdit(body.time), revision: 2 }] });
    return { error: null, data: { operationID: body.operationID, changed: true, events: [{ id: series.id, revision: 2 }], deleted: [], localCommitted: true, replayed: false } };
  });
  saving = saveButton(renderComposer())!.onPress!();
  await vi.waitFor(() => expect(mocks.alert).toHaveBeenCalledOnce());
  scopeAnswer("All events");
  await saving;
  expect(mocks.request).toHaveBeenCalledOnce();
  expect(JSON.parse(mocks.request.mock.lastCall![1].body)).toMatchObject({ action: "update", scope: "series", expectedRevision: 1, patch: { title: "Civil series draft" }, time: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-03-29T09:30:17.123", endLocal: "2026-03-29T10:30:19.456" } });
  expect(mocks.reminder).toHaveBeenCalledWith(expect.objectContaining({ revision: 2, start: new Date("2026-03-29T07:30:17.123Z"), recurrence: series.recurrence }), null);

  // An old open occurrence must not borrow a newer master's revision for a shift.
  const { liveEventDetail } = await import("@/lib/liveEvent");
  const displayed = useEventDetailStore.getState().event!;
  const live = liveEventDetail(useEventsStore.getState().events, displayed)!;
  expect(live.revision).toBe(1);
  useEditComposerStore.getState().open(live);
  const reopened = renderComposer(true);
  find(reopened, props => props.accessibilityLabel === "Starts date (YYYY-MM-DD)")!.onChangeText("2026-03-30");
  find(reopened, props => props.accessibilityLabel === "Ends date (YYYY-MM-DD)")!.onChangeText("2026-03-30");
  mocks.alert.mockClear();
  mocks.request.mockClear();
  mocks.close.mockClear();
  saving = saveButton(renderComposer())!.onPress!();
  await vi.waitFor(() => expect(mocks.alert).toHaveBeenCalledOnce());
  scopeAnswer("All events");
  await saving;
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.close).not.toHaveBeenCalled();
});

it("prefills the local zone for a new explicit zoned draft", async () => {
  const { resolveEventTimeEdit } = await import("@musubi/calendar");
  useEditComposerStore.getState().open();
  renderComposer(true);
  titleInput(renderComposer())!.onChangeText("New zoned event");
  find(renderComposer(), props => props.title === "Time model")!.onSelect("zoned");

  expect(titleInput(renderComposer())!.value).toBe("New zoned event");
  find(renderComposer(), props => props.label === "Advanced time settings")!.onPress();
  expect(find(renderComposer(), props => props.accessibilityLabel === "Event time zone")!.value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  find(renderComposer(), props => props.accessibilityLabel === "Event time zone")!.onChange("Europe/Prague");
  find(renderComposer(), props => props.accessibilityLabel === "Starts date (YYYY-MM-DD)")!.onChangeText("2026-07-21");
  find(renderComposer(), props => props.accessibilityLabel === "Ends date (YYYY-MM-DD)")!.onChangeText("2026-07-21");
  find(renderComposer(), props => props.accessibilityLabel === "Starts time (HH:mm)")!.onChangeText("09:00");
  find(renderComposer(), props => props.accessibilityLabel === "Ends time (HH:mm)")!.onChangeText("10:00");
  find(renderComposer(), props => props.accessibilityLabel === "Weekly recurrence")!.onPress();
  expect(find(renderComposer(), props => props.accessibilityLabel === "Weekly on Tue recurrence")).toBeDefined();
  mocks.request.mockImplementationOnce(async (_url, options) => {
    const body = JSON.parse(options.body);
    expect(body.event.recurrence).toBe("FREQ=WEEKLY;BYDAY=TU");
    return { error: null, data: { ...body.event, ...resolveEventTimeEdit(body.time), revision: 1 } };
  });
  await find(renderComposer(), props => props.label === "Create")!.onPress();
  expect(mocks.request).toHaveBeenCalledOnce();
  expect(mocks.request.mock.lastCall![0]).toMatch(/\/events\/time$/);
  expect(JSON.parse(mocks.request.mock.lastCall![1].body)).toMatchObject({ event: { title: "New zoned event" }, time: { kind: "zoned", timeZone: "Europe/Prague" } });
  expect(useEventsStore.getState().events.find(e => e.title === "New zoned event")?.timeModel?.kind).toBe("zoned");
});

it("new native composer retains its creation UUID through failed and edited retries, then resets for another draft", async () => {
  const saved: { id: string; title: string }[] = [];
  const onSave = vi.fn(async (event: { id: string; title: string }) => {
    saved.push(event);
    if (saved.length < 3) throw new TypeError("Response lost");
  });
  const props = {
    visible: true,
    startingDate: new Date("2026-07-26T09:00:00Z"),
    endingDate: new Date("2026-07-26T10:00:00Z"),
    calendars: [{ id: "00000000-0000-4000-8000-000000000155", creatorID: "owner", role: "owner" as const, name: "Calendar", color: "red", members: [] }],
    onSave, onEdit: vi.fn(), onClose: vi.fn(),
  };
  const render = (mount = false): ReactNode => {
    state.index = 0; state.collectEffects = mount;
    const tree = AddEventModal(props);
    state.collectEffects = false;
    if (mount) { state.effects.splice(0).forEach(effect => effect()); return render(); }
    return tree;
  };
  titleInput(render(true))!.onChangeText("Native create retry");
  await saveButton(render())!.onPress!();
  expect(saved).toHaveLength(1);
  expect(props.onClose).not.toHaveBeenCalled();
  titleInput(render())!.onChangeText("Edited after uncertain response");
  await saveButton(render())!.onPress!();
  expect(saved).toHaveLength(2);
  expect(saved[1]!.id).toBe(saved[0]!.id);
  expect(saved[1]!.title).toBe("Edited after uncertain response");
  await saveButton(render())!.onPress!();
  expect(saved[2]!.id).toBe(saved[0]!.id);
  expect(props.onClose).toHaveBeenCalledOnce();
  titleInput(render(true))!.onChangeText("Another draft");
  await saveButton(render())!.onPress!();
  expect(saved).toHaveLength(4);
  expect(saved[3]!.id).not.toBe(saved[0]!.id);
});


it.each([false, true])("privacy refresh preserves field deltas and accepted revision (all private fields edited: %s)", async (editExtras) => {
  state.persistent = true;
  const before = { ...master, recurrence: null, description: "Provider note", location: "Private room", url: "https://private.example" };
  const props = { visible: true, calendars: useCalendarsStore.getState().calendars, event: before, onClose: vi.fn(), onSave: vi.fn(), onEdit: vi.fn().mockResolvedValue(false) };
  function render(privacyEvent?: typeof before, sourceRemoved = false) {
    state.index = 0; state.refIndex = 0; state.effectIndex = 0;
    const tree = AddEventModal({ ...props, privacyEvent, sourceRemoved });
    state.effects.splice(0).forEach(effect => effect());
    return tree;
  }
  render();
  titleInput(render())!.onChangeText("My draft title");
  function allNodes(node: ReactNode): any[] {
    if (Array.isArray(node)) return node.flatMap(allNodes);
    if (!isValidElement(node)) return [];
    return [node, ...allNodes((node.props as any).children)];
  }
  const inputs = () => allNodes(render()).filter(node => node.type === "TextInput");
  inputs().find(node => node.props.value === "Provider note")!.props.onChangeText(editExtras ? "My note" : "");
  if (editExtras) {
    inputs().find(node => node.props.value === "Private room")!.props.onChangeText("My room");
    inputs().find(node => node.props.value === "https://private.example")!.props.onChangeText("https://mine.example");
  }
  const { privateEditorRefresh } = await import("@/lib/eventEditorPrivacy");
  const viewerSource = [{ id: before.originCalendarID, provider: "google", role: "viewer" }] as any;
  const ownerSource = [{ id: before.originCalendarID, provider: "google", role: "owner" }] as any;
  const redacted = privateEditorRefresh(before, { ...before, revision: 2, title: "Busy", description: null, location: null, url: null, organizer: "" }, viewerSource)! as any;
  render(redacted);
  let tree = render(redacted);
  expect(titleInput(tree)!.value).toBe("My draft title");
  // First let provider values coincide with the owned draft, then change them.
  // Neither equality nor a null redaction baseline releases field ownership.
  const coinciding = privateEditorRefresh(redacted, { ...redacted, revision: 3, title: "My draft title", description: editExtras ? "My note" : null, location: editExtras ? "My room" : null, url: editExtras ? "https://mine.example" : null }, viewerSource)! as any;
  render(coinciding);
  const readable = privateEditorRefresh(coinciding, { ...redacted, revision: 4, title: "Provider renamed", description: "Provider restored note", location: "Provider new room", url: "https://restored.example" }, ownerSource)! as any;
  expect(readable.revision).toBe(before.revision);
  render(readable);
  tree = render(readable);
  expect(titleInput(tree)!.value).toBe("My draft title");
  expect(allNodes(tree).some(node => node.props.value === "Provider restored note")).toBe(false);
  if (editExtras) {
    expect(allNodes(tree).some(node => node.props.value === "My note")).toBe(true);
    expect(allNodes(tree).some(node => node.props.value === "My room")).toBe(true);
    expect(allNodes(tree).some(node => node.props.value === "https://mine.example")).toBe(true);
  } else {
    expect(allNodes(tree).some(node => node.props.value === "Provider new room")).toBe(true);
    expect(allNodes(tree).some(node => node.props.value === "https://restored.example")).toBe(true);
  }
  render(redacted);
  tree = render(redacted);
  expect(JSON.stringify(tree)).not.toMatch(/Private room|private.example|Provider note/);
  await saveButton(tree)!.onPress!();
  expect(props.onEdit).toHaveBeenCalledWith(expect.objectContaining({ revision: 1, title: "My draft title", description: editExtras ? "My note" : null, location: editExtras ? "My room" : null, url: editExtras ? "https://mine.example" : null }));
  props.onEdit.mockClear();
  tree = render(redacted, true);
  await saveButton(tree)!.onPress!();
  expect(props.onEdit).not.toHaveBeenCalled();
  expect(titleInput(render(redacted, true))!.value).toBe("My draft title");
});


it("the global native host closes a confirmed missing Google detail and retires frozen composer source values", async () => {
  useCalendarsStore.getState().loadCalendars([{ id: master.originCalendarID, creatorID: "owner", role: "owner", name: "Google", provider: "google", color: "red" } as any]);
  useEventsStore.getState().resetEvents();
  useEventsStore.getState().loadEvents([master]);
  useEventDetailStore.getState().open(occurrence);
  useEditComposerStore.getState().open(occurrence);
  useCalendarsStore.getState().loadCalendars([]);
  // A transient empty cache is insufficient proof.
  useEventsStore.getState().loadEvents([]);
  let host = GlobalEventModals();
  expect(host.props.children[1].props.visible).toBe(true);
  useEventsStore.getState().loadEvents([], { reconciled: true });
  state.collectEffects = true;
  host = GlobalEventModals();
  state.collectEffects = false;
  state.effects.splice(0).forEach(effect => effect());
  expect(host.props.children[1].props.visible).toBe(false);
  expect(host.props.children[1].props.event).toBeNull();
  expect(host.props.children[0].props.sourceRemoved).toBe(true);
  expect(useEditComposerStore.getState().prefilled).toMatchObject({ title: "Busy", revision: occurrence.revision, start: occurrence.start });
  expect(useEditComposerStore.getState().master).toMatchObject({ title: "Busy", revision: master.revision, start: master.start });
});

it("the native host passes canonical observation revision separately from a known occurrence's frozen time authority", () => {
  const known = { ...master, timeModel: { kind: "zoned" as const, timeZone: "Europe/Prague", startLocal: "2026-07-06T11:00:00.000", endLocal: "2026-07-06T12:00:00.000" } };
  const tapped = { ...known, start: occurrence.start, end: occurrence.end, timeModel: { ...known.timeModel, startLocal: "2026-07-20T11:00:00.000", endLocal: "2026-07-20T12:00:00.000" } };
  useEventsStore.getState().resetEvents();
  useEventsStore.getState().loadEvents([{ ...known, revision: 2, title: "Busy", organizer: "" }]);
  useEventDetailStore.getState().open(tapped);
  const props = GlobalEventModals().props.children[1].props;
  expect(props.event).toMatchObject({ title: "Busy", revision: 1, start: tapped.start, timeModel: tapped.timeModel });
  expect(props.observationRevision).toBe(2);
});

it("keeps explicit UTC clock fields in the native whole-series request", async () => {
  const { resolveEventTimeEdit } = await import("@musubi/calendar");
  const series = EventSchema.parse({ ...master, id: "00000000-0000-4000-8000-000000000194", recurrence: "FREQ=DAILY;COUNT=4", ...resolveEventTimeEdit({ kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-03-28T09:00:00", endLocal: "2026-03-28T10:00:00" }) });
  useEventsStore.setState({ events: [series] });
  presentEventDetail([series], series);
  useEditComposerStore.getState().open(useEventDetailStore.getState().event!);
  find(renderComposer(true), props => props.label === "Advanced time settings")!.onPress();
  const tree = renderComposer();
  find(tree, props => props.accessibilityLabel === "Event time zone")!.onChange("UTC");
  mocks.request.mockImplementationOnce(async (_url, options) => {
    const body = JSON.parse(options.body);
    useEventsStore.setState({ events: [{ ...series, ...resolveEventTimeEdit(body.time), revision: 2 }] });
    return { error: null, data: { operationID: body.operationID, changed: true, events: [{ id: series.id, revision: 2 }], deleted: [], localCommitted: true, replayed: false } };
  });
  const saving = saveButton(renderComposer())!.onPress!();
  await vi.waitFor(() => expect(mocks.alert).toHaveBeenCalledOnce());
  scopeAnswer("All events"); await saving;
  expect(mocks.request).toHaveBeenCalledOnce();
  expect(JSON.parse(mocks.request.mock.lastCall![1].body)).toMatchObject({ action: "update", scope: "series", expectedRevision: 1, patch: {}, time: { kind: "zoned", timeZone: "UTC", startLocal: "2026-03-28T09:00:00.000", endLocal: "2026-03-28T10:00:00.000" } });
  expect(mocks.reminder).toHaveBeenCalledWith(expect.objectContaining({ revision: 2, start: new Date("2026-03-28T09:00:00.000Z") }), null);
});
it("converts the last generated COUNT occurrence without inventing a fold slot", async () => {
  const { resolveEventTimeEdit, expandRecurringEvents } = await import("@musubi/calendar");
  const series = EventSchema.parse({ ...master, id: "00000000-0000-4000-8000-000000000194", recurrence: "FREQ=DAILY;COUNT=2", ...resolveEventTimeEdit({ kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-10-23T02:30:00", endLocal: "2026-10-23T03:30:00" }) });
  useEventsStore.setState({ events: [series] });
  const last = expandRecurringEvents([series], new Date("2026-10-24T00:00:00Z"), new Date("2026-10-24T23:59:59Z"), { consumerTimeZone: "UTC" })[0]!;
  expect(last.id).toBe(series.id + "_" + Date.parse("2026-10-24T00:30:00Z"));
  presentEventDetail([series], last);
  useEditComposerStore.getState().open(useEventDetailStore.getState().event!);
  find(renderComposer(true), props => props.label === "Advanced time settings")!.onPress();
  const tree = renderComposer();
  find(tree, props => props.accessibilityLabel === "Event time zone")!.onChange("UTC");
  mocks.request.mockImplementationOnce(async (_url, options) => {
    const body = JSON.parse(options.body);
    useEventsStore.setState({ events: [{ ...series, ...resolveEventTimeEdit(body.time), revision: 2 }] });
    return { error: null, data: { operationID: body.operationID, changed: true, events: [{ id: series.id, revision: 2 }], deleted: [], localCommitted: true, replayed: false } };
  });
  const saving = saveButton(renderComposer())!.onPress!();
  await vi.waitFor(() => expect(mocks.alert).toHaveBeenCalledOnce());
  scopeAnswer("All events"); await saving;
  expect(mocks.request).toHaveBeenCalledOnce();
  expect(JSON.parse(mocks.request.mock.lastCall![1].body)).toMatchObject({ action: "update", scope: "series", expectedRevision: 1, patch: {}, time: { kind: "zoned", timeZone: "UTC", startLocal: "2026-10-23T02:30:00.000", endLocal: "2026-10-23T03:30:00.000" } });
  expect(mocks.reminder).toHaveBeenCalledWith(expect.objectContaining({ revision: 2, start: new Date("2026-10-23T02:30:00.000Z") }), null);
});

it("restores an imported all-day exclusion through the native whole-series caller", async () => {
  const { resolveEventTimeEdit } = await import("@musubi/calendar");
  const recurrence = "RRULE:FREQ=DAILY;COUNT=4\nEXDATE;VALUE=DATE:20260329,20260330";
  const series = EventSchema.parse({ ...master, id: "00000000-0000-4000-8000-000000000201", recurrence, ...resolveEventTimeEdit({ kind: "all-day", startDate: "2026-03-28", endDate: "2026-03-28" }) });
  useEventsStore.setState({ events: [series] }); presentEventDetail([series], series);
  useEditComposerStore.getState().open(useEventDetailStore.getState().event!);
  const tree = renderComposer(true);
  find(tree, props => props.label === "Restore 2026-03-29")!.onPress();
  mocks.request.mockImplementationOnce(async (_url, options) => {
    const body = JSON.parse(options.body); useEventsStore.setState({ events: [{ ...series, ...body.patch, revision: 2 }] });
    return { error: null, data: { operationID: body.operationID, changed: true, events: [{ id: series.id, revision: 2 }], deleted: [], localCommitted: true, replayed: false } };
  });
  const saving = saveButton(renderComposer())!.onPress!();
  await vi.waitFor(() => expect(mocks.alert).toHaveBeenCalledOnce()); scopeAnswer("All events"); await saving;
  expect(mocks.request).toHaveBeenCalledOnce();
  const body = JSON.parse(mocks.request.mock.lastCall![1].body);
  expect(body).toMatchObject({ scope: "series", action: "update", expectedRevision: 1, patch: { recurrence: "RRULE:FREQ=DAILY;COUNT=4\nEXDATE;VALUE=DATE:20260330" } });
  expect(body.time).toBeUndefined();
});

for (const platform of ["android", "ios"] as const) for (const remove of [false, true]) it(`${platform} explicit series ${remove ? "removes" : "adds"} one date from the stored master`, async () => {
  state.platform = platform;
  const { resolveEventTimeEdit } = await import("@musubi/calendar");
  const recurrence = "RRULE:FREQ=DAILY;COUNT=2" + (remove ? "\nRDATE;VALUE=DATE:20260402" : "");
  const series = EventSchema.parse({ ...master, id: "00000000-0000-4000-8000-000000000901", recurrence, ...resolveEventTimeEdit({ kind: "all-day", startDate: "2026-03-28", endDate: "2026-03-28" }) });
  useCalendarsStore.getState().loadCalendars([{ id: series.originCalendarID, creatorID: "owner", role: "owner", name: "CalDAV", provider: "caldav", color: "#7A8BA3" } as any]);
  useEventsStore.setState({ events: [series] });
  // Open the second generated slot: proof and COUNT anchor still use stored root.
  presentEventDetail([series], { ...series, id: `${series.id}_${Date.parse("2026-03-29T00:00:00Z")}`, start: new Date("2026-03-29T00:00:00Z"), end: new Date("2026-03-29T00:00:00Z") });
  useEditComposerStore.getState().open(useEventDetailStore.getState().event!);
  find(renderComposer(true), props => props.label === (remove ? "Remove additional date 2026-04-02" : "Add series date"))!.onPress();
  if (!remove) {
    const picker = () => find(renderComposer(), props => props.mode === "date" && typeof props.onValueChange === "function");
    expect(picker()).toBeDefined();
    expect(picker()![platform === "ios" ? "display" : "presentation"]).toBe(platform === "ios" ? "compact" : "dialog");
    if (platform === "android") {
      picker()!.onDismiss();
      expect(picker()).toBeUndefined();
      find(renderComposer(), props => props.label === "Add series date")!.onPress();
    } else {
      // Expo's compact iOS control stays mounted when its native popover is
      // closed/reopened. It has no JS onDismiss callback; selection is the
      // reachable callback that hides our temporary control.
      expect(picker()!.onDismiss).toBeUndefined();
      expect(picker()!.display).toBe("compact");
      expect(picker()!.value).toEqual(new Date("2026-03-28T12:00:00"));
    }
    expect(useEditComposerStore.getState().visible).toBe(true);
    expect(mocks.request).not.toHaveBeenCalled();
    picker()!.onValueChange({}, new Date("2026-04-02T12:00:00"));
    expect(picker()).toBeUndefined();
    expect(mocks.request).not.toHaveBeenCalled();
  }
  mocks.request.mockImplementationOnce(async (_url, options) => { const body = JSON.parse(options.body); useEventsStore.setState({ events: [{ ...series, ...body.patch, revision: 2 }] }); return { error: null, data: { operationID: body.operationID, changed: true, events: [{ id: series.id, revision: 2 }], deleted: [], localCommitted: true, replayed: false } }; });
  const saving = saveButton(renderComposer())!.onPress!();
  await vi.waitFor(() => expect(platform === "ios" ? mocks.actionSheet : mocks.alert).toHaveBeenCalledOnce()); scopeAnswer("All events"); await saving;
  expect(mocks.request).toHaveBeenCalledOnce();
  const body = JSON.parse(mocks.request.mock.lastCall![1].body);
  expect(mocks.request.mock.lastCall![0]).toContain(`/events/${series.id}/scope`);
  expect(body).toMatchObject({ scope: "series", action: "update", expectedRevision: 1, patch: { recurrence: remove ? "RRULE:FREQ=DAILY;COUNT=2" : "RRULE:FREQ=DAILY;COUNT=2\nRDATE;VALUE=DATE:20260402" } });
  expect(body.time).toBeUndefined(); expect(body.originalStart).toBeUndefined();
  expect(useEditComposerStore.getState().visible).toBe(false);
});
