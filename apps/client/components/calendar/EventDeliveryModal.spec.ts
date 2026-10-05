import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
vi.mock("./TimeZonePicker", () => ({ TimeZonePicker: "TimeZonePicker" }));
vi.mock("@/components/ui/DateTimePicker", () => ({ DateTimePicker: "DateTimePicker" }));
vi.mock("@/components/ui/BottomSheetFrame", () => ({ BottomSheetFrame: "BottomSheetFrame" }));

const h = vi.hoisted(() => ({
  callbacks: {} as Record<string, (...args: any[]) => void>,
  slots: [] as any[],
  index: 0,
  effects: [] as (() => void)[],
  request: vi.fn(),
  alert: vi.fn(),
  userId: "owner",
  apiUrl: "https://home.example.test",
  version: 0,
  eventLifecycle: 0,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: any) => {
    const i = h.index++;
    if (!(i in h.slots))
      h.slots[i] = typeof initial === "function" ? initial() : initial;
    return [
      h.slots[i],
      (value: any) => {
        h.slots[i] = typeof value === "function" ? value(h.slots[i]) : value;
      },
    ];
  },
  useRef: (initial: any) => {
    const i = h.index++;
    if (!(i in h.slots)) h.slots[i] = { current: initial };
    return h.slots[i];
  },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const i = h.index++;
    const previous = h.slots[i];
    if (!previous || deps.some((dep, index) => dep !== previous.deps[index])) {
      const slot = { deps, cleanup: previous?.cleanup };
      h.slots[i] = slot;
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect();
      });
    }
  },
}));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  ScrollView: "ScrollView",
  Pressable: "Pressable",
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: vi.fn() }),
  },
  Platform: { OS: "android" },
  Alert: { alert: h.alert },
  ActionSheetIOS: {},
}));
vi.mock("@/contexts/ServerContext", () => ({
  useServer: () => ({
    apiUrl: h.apiUrl,
    authClient: {
      $fetch: h.request,
      getSession: async () => ({
        data: { session: { token: "test-session" } },
      }),
      useSession: () => ({ data: { user: { id: h.userId } } }),
    },
  }),
}));
vi.mock("@/constants/theme", () => ({ colors: {}, fonts: {}, styles: {} }));
vi.mock("@/components/ui/ModalPortal", () => ({ ModalPortal: "Modal" }));
vi.mock("@/components/ui/Btn", () => ({ Btn: "Btn" }));
vi.mock("@/lib/haptics", () => ({ warn: vi.fn() }));
vi.mock("@/services/federation", () => ({
  setHomeRequester: vi.fn(),
  remoteForCalendar: vi.fn(),
}));
vi.mock("@/services/notifications", () => ({ setReminderWriter: vi.fn() }));
vi.mock("@/lib/signOut", () => ({ notifySessionExpired: vi.fn() }));
vi.mock("@/store/useDeliveryRefreshStore", () => {
  const state = () => ({
    version: h.version,
    refresh: () => {
      h.version++;
    },
  });
  return {
    useDeliveryRefreshStore: Object.assign(
      (selector: (value: ReturnType<typeof state>) => unknown) =>
        selector(state()),
      { getState: state },
    ),
  };
});
const { default: EventDeliveryModal, DeliveryBody } =
  await import("./EventDeliveryModal");
const { useApi } = await import("@/services/api");
const id = "00000000-0000-4000-8000-000000000001";
const op = "00000000-0000-4000-8000-000000000002";
const target = {
  targetId: "00000000-0000-4000-8000-000000000003",
  calendarId: "00000000-0000-4000-8000-000000000004",
  calendarName: "Work",
  provider: "google",
  connected: true,
  owned: true,
  operationId: op,
  action: "update",
  status: "conflict",
  revision: 1,
  latestRevision: 1,
  updatedAt: "2026-09-07T10:00:00Z",
  retryAt: null,
  issue: "conflict",
};
const receipt = { eventId: id, localRevision: 1, targets: [target] };
const content = {
  title: "Saved",
  start: "2026-09-07T10:00:00Z",
  end: "2026-09-07T11:00:00Z",
  isAllDay: false,
  description: null,
  location: null,
  recurrence: null,
};
const preview = {
  eventId: id,
  operationId: op,
  latestOperationId: op,
  localRevision: 1,
  local: content,
  remote: { ...content, title: "Remote" },
  remoteEtag: '"remote"',
  action: "update",
  canResolve: true,
  reason: null,
};
const reply = (data: unknown) => ({ data, error: null });
function unmount() {
  for (const slot of h.slots) slot?.cleanup?.();
}
beforeEach(() => {
  h.slots = [];
  h.index = 0;
  h.effects = [];
  h.version = 0;
  h.eventLifecycle = 0;
  h.userId = "owner";
  h.apiUrl = "https://home.example.test";
  vi.clearAllMocks();
  h.request.mockImplementation(async (url: string) =>
    reply(url.endsWith("/conflict") ? preview : receipt),
  );
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
});
function render(eventId: string | null = id, connectionId?: string) {
  h.index = 0;
  const tree = DeliveryBody({
    visible: true,
    eventId: eventId ?? undefined,
    connectionId,
    onClose: vi.fn(),
  });
  for (const effect of h.effects.splice(0)) effect();
  return tree;
}
function buttons(node: ReactNode, label: string): any[] {
  if (Array.isArray(node))
    return node.flatMap((child) => buttons(child, label));
  if (
    !isValidElement<{
      children?: ReactNode;
      label?: string;
      accessibilityLabel?: string;
      header?: ReactNode;
      onPress?: () => void;
    }>(node)
  )
    return [];
  return [
    ...((node.props.label === label || node.props.accessibilityLabel === label) ? [node.props] : []),
    ...buttons(node.props.header, label),
    ...buttons(node.props.children, label),
  ];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (
    !isValidElement<{
      children?: ReactNode;
      label?: string;
      onPress?: () => void;
    }>(node)
  )
    return "";
  if (typeof node.type === "function" && node.type.name === "DeliveryContent")
    return text((node.type as (props: any) => ReactNode)(node.props));
  return text(node.props.children);
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function review() {
  render();
  await settle();
  buttons(render(), "Review changes")[0].onPress();
  await settle();
  return render();
}
function acceptNative() {
  const choices = h.alert.mock.lastCall![2];
  choices.find((choice: any) => choice.style !== "cancel").onPress();
}

it("executes the actual comparison and native confirmation, preserving UUID after a lost reply", async () => {
  const bodies: unknown[] = [];
  h.request.mockImplementation(async (url: string, options: any) => {
    if (url.endsWith("/resolve")) {
      bodies.push(JSON.parse(options.body));
      if (bodies.length === 1) throw new TypeError("lost response");
    }
    return reply(url.endsWith("/conflict") ? preview : receipt);
  });
  const tree = await review();
  buttons(tree, "Apply saved changes")[0].onPress();
  expect(bodies).toHaveLength(0);
  expect(h.alert.mock.lastCall![2][0].style).toBe("cancel");
  acceptNative();
  await settle();
  expect(text(render())).toContain("Could not verify this request");
  buttons(render(), "Apply saved changes")[0].onPress();
  acceptNative();
  await settle();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0]).toMatchObject({
    expectedLocalRevision: 1,
    expectedLatestOperationId: op,
    expectedRemoteExists: true,
    expectedRemoteEtag: '"remote"',
  });
  expect(text(render())).toContain("Provider confirmation is still pending");
});

it("does not send a delayed native confirmation after the scoped modal unmounts", async () => {
  buttons(await review(), "Apply saved changes")[0].onPress();
  unmount();
  acceptNative();
  await settle();
  expect(
    h.request.mock.calls.some(([url]) => String(url).endsWith("/resolve")),
  ).toBe(false);
});

it("drops stale comparison after 409 and requires another provider read", async () => {
  h.request.mockImplementation(async (url: string) =>
    url.endsWith("/resolve")
      ? { data: null, error: { status: 409 } }
      : reply(url.endsWith("/conflict") ? preview : receipt),
  );
  buttons(await review(), "Apply saved changes")[0].onPress();
  acceptNative();
  await settle();
  expect(buttons(render(), "Apply saved changes")).toHaveLength(0);
  expect(text(render())).toContain("fresh comparison");
});

it("paginates retained deletions without immediately discarding the appended page", async () => {
  const deleted = "00000000-0000-4000-8000-000000000009";
  h.request.mockImplementation(async (url: string) =>
    reply(
      url.includes("cursor=")
        ? {
            items: [{ eventId: deleted, savedTitle: "Deleted event" }],
            nextCursor: null,
          }
        : url.includes("event-deliveries")
          ? {
              items: [{ eventId: id, savedTitle: "First event" }],
              nextCursor: id,
            }
          : {
              ...receipt,
              eventId: deleted,
              localRevision: null,
              targets: [
                {
                  ...target,
                  action: "delete",
                  status: "unconfirmed",
                  issue: "unconfirmed",
                },
              ],
            },
    ),
  );
  render(null);
  await settle();
  buttons(render(null), "Load more")[0].onPress();
  await settle();
  h.version++;
  render(null);
  await settle();
  const next = render(null);
  expect(buttons(next, "First event")).toHaveLength(1);
  buttons(next, "Deleted event")[0].onPress();
  render(null);
  await settle();
  expect(text(render(null))).toContain("Retained delivery records");
  expect(text(render(null))).toContain("Delivery unconfirmed");
});

it("keeps scopes in the host key and routes remote calls through the captured home requester", async () => {
  const props = {
    visible: true,
    eventId: id,
    connectionId: "remote",
    onClose: vi.fn(),
  };
  const first = EventDeliveryModal(props)!;
  h.userId = "other";
  const second = EventDeliveryModal(props)!;
  expect(first.key).not.toBe(second.key);
  h.apiUrl = "https://second.example.test";
  expect(EventDeliveryModal(props)!.key).not.toBe(second.key);
  await useApi().getEventDelivery(id, "remote");
  expect(h.request.mock.lastCall![0]).toBe(
    `https://second.example.test/api/v1/federation/s/remote/api/v1/events/${id}/delivery`,
  );
});

it("rejects malformed receipts in production instead of treating an unchecked cast as confirmation", async () => {
  h.request.mockResolvedValue(
    reply({ eventId: id, targets: [{ status: "completed" }] }),
  );
  await expect(useApi().getEventDelivery(id)).rejects.toThrow();
});

it("does not offer retry/review on another owner's destination", async () => {
  h.request.mockResolvedValue(
    reply({ ...receipt, targets: [{ ...target, owned: false }] }),
  );
  render();
  await settle();
  const tree = render();
  expect(buttons(tree, "Review changes")).toHaveLength(0);
  expect(buttons(tree, "Retry")).toHaveLength(0);
  expect(text(tree)).toContain("Only the connection owner");
});

vi.mock("@/hooks/useModalAnimation", () => ({
  useModalAnimation: (_visible: boolean, close: () => void) => ({
    handleClose: close,
  }),
}));
vi.mock("@expo/vector-icons", () => ({ Feather: "Icon", Ionicons: "Icon" }));
vi.mock("react-native-reanimated", () => ({
  default: { View: "AnimatedView" },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock("react-native-gesture-handler", () => ({
  GestureDetector: "GestureDetector",
  GestureHandlerRootView: "GestureHandlerRootView",
}));
vi.mock("@/store/useCalendarsStore", () => ({
  useCalendarsStore: () => ({ calendars: [] }),
}));
vi.mock("@/store/useEventsStore", () => ({
  useEventsStore: () => ({ events: [] }),
  getEventLifecycle: () => h.eventLifecycle,
}));
vi.mock("@/store/useSettingsStore", () => ({
  useSettingsStore: () => ({ timeFormat: "24h", dateFormat: "dmy" }),
}));
vi.mock("@/store/useAttendeesStore", () => ({
  useAttendeesStore: () => ({ byEvent: {}, setAttendees: vi.fn() }),
}));
vi.mock("./CalendarPickerModal", () => ({ default: "CalendarPicker" }));
vi.mock("@/components/ui/Tap", () => ({ Tap: "Tap" }));
vi.mock("@/components/Avatar", () => ({ Avatar: "Avatar" }));
vi.mock("@/components/ui/Toast", () => ({ showToast: vi.fn() }));

it("keeps delivery discovery out of the event detail", async () => {
  const { default: EventDetailModal } = await import("./EventDetailModal");
  const { remoteForCalendar } = await import("@/services/federation");
  vi.mocked(remoteForCalendar).mockReturnValue({
    id: "remote",
    server: "https://remote.example.test",
    label: "Remote",
    userID: "shadow",
  });
  const event = {
    ...content,
    start: new Date(content.start),
    end: new Date(content.end),
    id,
    revision: 1,
    creatorID: "owner",
    organizer: "owner",
    calendars: [target.calendarId],
    originCalendarID: target.calendarId,
    color: "#112233",
    isCanceled: false,
    hasAttendees: false,
  };
  const renderDetail = () => {
    h.index = 0;
    const tree = EventDetailModal({
      event,
      visible: true,
      onClose: vi.fn(),
      onEdit: vi.fn(),
    });
    for (const effect of h.effects.splice(0)) effect();
    return tree;
  };
  expect(buttons(renderDetail(), "Delivery details")).toHaveLength(0);
});

it("coalesces refreshes and reads the newest status after the active read settles", async () => {
  let finish!: (value: unknown) => void;
  h.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render();
  h.version++;
  h.request.mockResolvedValue(
    reply({
      ...receipt,
      targets: [{ ...target, status: "blocked", issue: "write-denied" }],
    }),
  );
  render();
  await settle();
  finish(
    reply({
      ...receipt,
      targets: [{ ...target, status: "completed", issue: null }],
    }),
  );
  await settle();
  render();
  await settle();
  expect(text(render())).toContain("Delivery blocked");
  expect(text(render())).not.toContain("Delivery confirmed");
});

it("drops an old account's late read after remounting the new identity", async () => {
  let finish!: (value: unknown) => void;
  h.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render();
  unmount();
  h.slots = [];
  h.index = 0;
  h.userId = "other";
  h.request.mockResolvedValue(
    reply({
      ...receipt,
      targets: [{ ...target, calendarName: "Other account" }],
    }),
  );
  render();
  await settle();
  finish(reply(receipt));
  await settle();
  expect(text(render())).toContain("Other account");
  expect(text(render())).not.toContain("Work");
});

vi.mock("react-native-sse", () => ({
  default: class {
    addEventListener(name: string, callback: (...args: any[]) => void) {
      h.callbacks[name] = callback;
    }
    close() {}
  },
}));
vi.mock("expo-network", () => ({
  addNetworkStateListener: () => ({ remove: vi.fn() }),
}));
vi.mock("@/hooks/useRefreshData", () => ({
  useRefreshData: () => async () => {},
}));
vi.mock("@/lib/eventSync", () => ({
  serializeEventRefresh: async (action: () => unknown) => action(),
}));

it("invalidates delivery from the actual native external_sync and reconnect listeners", async () => {
  const { useConnectToEventStream } = await import("@/hooks/useEventsStream");
  h.index = 0;
  useConnectToEventStream();
  for (const effect of h.effects.splice(0)) effect();
  await settle();
  const initial = h.version;
  h.callbacks.message({ data: JSON.stringify({ type: "external_sync" }) });
  expect(h.version).toBe(initial + 1);
  h.callbacks.open();
  h.callbacks.open();
  expect(h.version).toBe(initial + 2);
  // Delivery updates from the previous account's stream cannot invalidate the
  // replacement account after its stores have been reset.
  h.eventLifecycle++;
  h.callbacks.message({ data: JSON.stringify({ type: "external_sync" }) });
  h.callbacks.open();
  expect(h.version).toBe(initial + 2);
});

it("publishes a slow receipt despite the 15 second poll", async () => {
  vi.useFakeTimers();
  h.request.mockImplementation(
    () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(reply(receipt)), 16_000);
      }),
  );
  render();
  await vi.advanceTimersByTimeAsync(15_000);
  render();
  expect(h.request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_000);
  const tree = render();
  expect(text(tree)).toContain("Remote changes need review");
  expect(buttons(tree, "Review changes")[0].disabled).toBe(false);
  expect(h.request).toHaveBeenCalledTimes(1);
});

it("finishes a multi-page inbox refresh across polling intervals", async () => {
  vi.useFakeTimers();
  const second = "00000000-0000-4000-8000-000000000009";
  let delay = 0;
  h.request.mockImplementation(
    (url: string) =>
      new Promise((resolve) => {
        setTimeout(
          () =>
            resolve(
              reply(
                url.includes("cursor=")
                  ? {
                      items: [
                        { eventId: second, savedTitle: "Retained second" },
                      ],
                      nextCursor: null,
                    }
                  : {
                      items: [{ eventId: id, savedTitle: "Retained first" }],
                      nextCursor: id,
                    },
              ),
            ),
          delay,
        );
      }),
  );
  render(null);
  await vi.advanceTimersByTimeAsync(0);
  buttons(render(null), "Load more")[0].onPress();
  await vi.advanceTimersByTimeAsync(0);
  render(null);
  delay = 8_000;
  h.version++;
  render(null);
  await vi.advanceTimersByTimeAsync(15_000);
  render(null);
  expect(h.request).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(1_000);
  const tree = render(null);
  expect(buttons(tree, "Retained second")).toHaveLength(1);
  expect(buttons(tree, "Refresh status")[0].disabled).toBe(false);
});

it("serializes Load more with a background inbox refresh", async () => {
  h.request.mockResolvedValue(
    reply({
      items: [{ eventId: id, savedTitle: "First" }],
      nextCursor: id,
    }),
  );
  render(null);
  await settle();
  const previousButton = buttons(render(null), "Load more")[0];
  let finish!: (value: unknown) => void;
  h.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  h.version++;
  render(null);
  expect(buttons(render(null), "Load more")[0].disabled).toBe(true);
  previousButton.onPress();
  expect(h.request).toHaveBeenCalledTimes(2);
  finish(
    reply({
      items: [{ eventId: id, savedTitle: "Refreshed" }],
      nextCursor: id,
    }),
  );
  await settle();
  const next = render(null);
  expect(buttons(next, "Refreshed")).toHaveLength(1);
  expect(buttons(next, "Load more")[0].disabled).toBe(false);
});

it("makes pagination available after an inbox read slower than polling", async () => {
  vi.useFakeTimers();
  h.request.mockImplementation(
    () =>
      new Promise((resolve) => {
        setTimeout(
          () =>
            resolve(
              reply({
                items: [{ eventId: id, savedTitle: "Slow first page" }],
                nextCursor: id,
              }),
            ),
          16_000,
        );
      }),
  );
  render(null);
  await vi.advanceTimersByTimeAsync(15_000);
  render(null);
  await vi.advanceTimersByTimeAsync(1_000);
  const tree = render(null);
  expect(buttons(tree, "Load more")[0].disabled).toBe(false);
  buttons(tree, "Load more")[0].onPress();
  await vi.advanceTimersByTimeAsync(14_000);
  render(null);
  expect(h.request).toHaveBeenCalledTimes(2);
});

it("confirms occurrence scope with the displayed master revision", async () => {
  let body: any;
  const scoped = {
    ...content,
    isCanceled: true,
    originalStart: { kind: "instant", value: "2026-09-07T10:00:00.000Z" },
    timeModel: {
      kind: "zoned",
      timeZone: "Europe/Prague",
      startLocal: "2026-09-07T12:00:00.000",
      endLocal: "2026-09-07T13:00:00.000",
    },
  };
  h.request.mockImplementation(async (url: string, options: any) => {
    if (url.endsWith("/resolve")) body = JSON.parse(options.body);
    return reply(
      url.endsWith("/conflict")
        ? {
            ...preview,
            masterRevision: 7,
            local: scoped,
            remote: { ...scoped, isCanceled: false },
          }
        : receipt,
    );
  });
  const tree = await review();
  expect(text(tree)).toContain("Cancelled");
  expect(text(tree)).toContain("Europe/Prague");
  buttons(tree, "Apply saved changes")[0].onPress();
  acceptNative();
  await settle();
  expect(body.expectedMasterRevision).toBe(7);
});

it("confirms the displayed personal reminder state and preserves its retry identity", async () => {
  const requests: any[] = [];
  h.request.mockImplementation(async (url: string, options: any) => {
    if (url.endsWith("/resolve")) { requests.push(JSON.parse(options.body)); if (requests.length === 1) throw new Error("Network unavailable"); }
    return reply(url.endsWith("/conflict") ? { ...preview, reminderResolution: {
      desired: { useDefault: false, overrides: [] },
      remote: { provider: "google", useDefault: false, overrides: [{ method: "unknown-native", minutes: null }] },
      stateVersion: "b".repeat(64),
    } } : receipt);
  });
  let tree = await review();
  expect(text(tree)).toMatch(/Saved Google reminders:\s+Off/);
  expect(text(tree)).toContain("unknown-native · time not reported");
  expect(text(tree)).toContain("other apps may notify separately");
  buttons(tree, "Apply saved reminders")[0].onPress();
  acceptNative();
  await settle();
  tree = render(null);
  buttons(tree, "Apply saved reminders")[0].onPress();
  acceptNative();
  await settle();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0].expectedReminderStateVersion).toBe("b".repeat(64));
  expect(requests[0]).not.toHaveProperty("reminders");
});

it("confirms the saved own RSVP response and keeps the same native preview on retry", async () => {
  const requests: any[] = [];
  h.request.mockImplementation(async (url: string, options: any) => {
    if (url.endsWith("/resolve")) { requests.push(JSON.parse(options.body)); if (requests.length === 1) throw new Error("Network unavailable"); }
    return reply(url.endsWith("/conflict") ? { ...preview, rsvpResolution: { desired: "tentative", remote: "needsAction", baselineVersion: "d".repeat(64) } } : receipt);
  });
  let tree = await review();
  expect(text(tree)).toMatch(/Saved Google response:\s+Tentative/);
  expect(text(tree)).toContain("Awaiting response"); expect(text(tree)).toContain("Email delivery cannot be verified");
  buttons(tree, "Send saved response")[0].onPress(); acceptNative(); await settle();
  tree = render(null); buttons(tree, "Send saved response")[0].onPress(); acceptNative(); await settle();
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect(requests[0].expectedRsvpBaselineVersion).toBe("d".repeat(64));
  expect(requests[0]).not.toHaveProperty("attendees"); expect(requests[0]).not.toHaveProperty("response");
});


it("confirms the displayed following-deletion cut with a frozen retry identity", async () => {
  const scopeResolution = { kind: "following-delete", originalStart: { kind: "instant", value: "2026-09-07T10:00:00.000Z" } };
  const requests: any[] = [];
  h.request.mockImplementation(async (url: string, options: any) => {
    if (url.endsWith("/resolve")) { requests.push(JSON.parse(options.body)); if (requests.length === 1) throw new Error("Lost response"); }
    return reply(url.endsWith("/conflict") ? { ...preview, scopeResolution } : receipt);
  });
  let tree = await review();
  expect(text(tree)).toContain("Delete this and following");
  expect(text(tree)).toContain(scopeResolution.originalStart.value);
  expect(text(tree)).toContain("Earlier occurrences remain");
  expect(buttons(tree, "Apply saved changes")).toHaveLength(0);
  buttons(tree, "Delete following occurrences")[0].onPress(); acceptNative(); await settle();
  tree = render();
  buttons(tree, "Delete following occurrences")[0].onPress(); acceptNative(); await settle();
  expect(requests).toHaveLength(2);
  expect(requests[0].expectedScopeResolution).toEqual(scopeResolution);
  expect(requests[1]).toEqual(requests[0]);
});

it("confirms the displayed whole-series deletion with a frozen retry identity", async () => {
  const scopeResolution = { kind: "series-delete" };
  const requests: any[] = [];
  h.request.mockImplementation(async (url: string, options: any) => {
    if (url.endsWith("/resolve")) { requests.push(JSON.parse(options.body)); if (requests.length === 1) throw new Error("Lost response"); }
    return reply(url.endsWith("/conflict") ? { ...preview, scopeResolution, action: "delete", local: null, localRevision: null } : receipt);
  });
  let tree = await review();
  expect(text(tree)).toContain("Entire series");
  expect(text(tree)).toContain("all occurrences and exceptions");
  expect(buttons(tree, "Apply saved changes")).toHaveLength(0);
  buttons(tree, "Delete entire series")[0].onPress(); acceptNative(); await settle();
  tree = render();
  buttons(tree, "Delete entire series")[0].onPress(); acceptNative(); await settle();
  expect(requests).toHaveLength(2);
  expect(requests[0].expectedScopeResolution).toEqual(scopeResolution);
  expect(requests[1]).toEqual(requests[0]);
});

it("confirms the displayed following split and its future series with a frozen retry identity", async () => {
  const scopeResolution = { kind: "following-update", newSeriesId: "00000000-0000-4000-8000-000000000099", originalStart: { kind: "instant", value: "2026-09-07T10:00:00.000Z" } };
  const requests: any[] = [];
  h.request.mockImplementation(async (url: string, options: any) => {
    if (url.endsWith("/resolve")) { requests.push(JSON.parse(options.body)); if (requests.length === 1) throw new Error("Lost response"); }
    return reply(url.endsWith("/conflict") ? { ...preview, scopeResolution, splitFuture: { ...content, title: "Saved future title", recurrence: "RRULE:FREQ=WEEKLY;COUNT=4" } } : receipt);
  });
  let tree = await review();
  expect(text(tree)).toContain("Saved future series");
  expect(text(tree)).toContain("Saved future title");
  expect(text(tree)).toContain("Change this and following");
  expect(text(tree)).toContain(scopeResolution.originalStart.value);
  expect(text(tree)).toContain("two steps");
  expect(buttons(tree, "Apply saved changes")).toHaveLength(0);
  buttons(tree, "Apply following changes")[0].onPress(); acceptNative(); await settle();
  tree = render();
  buttons(tree, "Apply following changes")[0].onPress(); acceptNative(); await settle();
  expect(requests).toHaveLength(2);
  expect(requests[0].expectedScopeResolution).toEqual(scopeResolution);
  expect(requests[1]).toEqual(requests[0]);
});


it("refuses a split confirmation without its saved future comparison", async () => {
  h.request.mockImplementation(async (url: string) => reply(url.endsWith("/conflict") ? { ...preview, scopeResolution: { kind: "following-update", originalStart: { kind: "instant", value: "2026-09-07T10:00:00.000Z" }, newSeriesId: "00000000-0000-4000-8000-000000000099" } } : receipt));
  const tree = await review();
  expect(buttons(tree, "Apply following changes")[0].disabled).toBe(true);
});

it("confirms future-only recovery without repeating the completed source step", async () => {
  const scopeResolution = { kind: "following-create", newSeriesId: "00000000-0000-4000-8000-000000000099", originalStart: { kind: "instant", value: "2026-09-07T10:00:00.000Z" } };
  const bodies: any[] = [];
  h.request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/resolve")) { bodies.push(JSON.parse(String(init?.body))); return reply(receipt); }
    return reply(url.endsWith("/conflict") ? { ...preview, action: "create", remote: null, remoteEtag: null, scopeResolution } : receipt);
  });
  const tree = await review();
  expect(text(tree)).toContain("The earlier series is already saved");
  expect(text(tree)).not.toContain("Delivery uses two steps");
  buttons(tree, "Finish future series")[0].onPress();
  expect(bodies).toHaveLength(0); acceptNative(); await settle();
  expect(bodies[0]).toMatchObject({ expectedScopeResolution: scopeResolution, expectedRemoteExists: false, expectedRemoteEtag: null });
});

it("requires native confirmation before discarding only the saved alarm intent", async () => {
  const bodies: any[] = [];
  h.request.mockImplementation(async (url: string, options: any) => {
    if (url.endsWith("/discard-alarm")) bodies.push(JSON.parse(options.body));
    return reply({ ...receipt, targets: [{ ...receipt.targets[0], provider: "caldav", alarmDiscardRevision: 2 }] });
  });
  render(); await settle(); const tree = render();
  buttons(tree, "Discard saved alarm change")[0].onPress();
  expect(bodies).toHaveLength(0); acceptNative(); await settle();
  expect(bodies).toEqual([{ expectedRevision: 2 }]);
});
it("requires explicit native confirmation to adopt the provider family without queuing a write", async () => {
  const bodies: any[] = [];
  h.request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/resolve")) { bodies.push(JSON.parse(String(init?.body))); return reply(receipt); }
    return reply(url.endsWith("/conflict") ? { ...preview, action: "create", graphCreateAdoption: { stateVersion: "b".repeat(64), occurrenceCount: 3 } } : receipt);
  });
  const tree = await review();
  expect(buttons(tree, "Recreate remote copy")).toHaveLength(0);
  buttons(tree, "Use provider version")[0].onPress(); expect(bodies).toHaveLength(0);
  acceptNative(); await settle();
  expect(bodies[0]).toEqual({ kind: "graph-create-adoption", mutationID: expect.any(String), expectedRevision: preview.localRevision, stateVersion: "b".repeat(64) });
  expect(text(render())).toContain("Provider version accepted in Musubi");
});

it("offers read-only checking of a dispatched Graph conflict and preserves its operation", async () => {
  let checked = false;
  h.request.mockImplementation(async (url: string) => {
    if (url.endsWith("/retry")) checked = true;
    return reply({ ...receipt, targets: [{ ...target, provider: "microsoft", status: checked ? "unconfirmed" : "conflict", graphRsvpPhase: checked ? "absent" : "accepted" }] });
  });
  render(); await settle();
  let tree = render();
  expect(buttons(tree, "Review changes")).toHaveLength(0);
  buttons(tree, "Check response")[0].onPress(); await settle();
  render(); await settle(); tree = render();
  expect(text(tree)).toContain("Outlook meeting copy unavailable");
  expect(h.request.mock.calls.filter(call => call[0].endsWith("/retry"))).toHaveLength(1);
  expect(h.request.mock.calls.some(call => call[0].includes("/resolve") || call[0].includes("/provider-rsvp"))).toBe(false);
});

it("explicitly confirms applying the saved CalDAV alarm to every series occurrence", async () => {
  const bodies: any[] = [];
  h.request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/resolve")) { bodies.push(JSON.parse(String(init?.body))); return reply(receipt); }
    return reply(url.endsWith("/conflict") ? { ...preview, caldavAlarmResolution: { scope: "series", desired: { minutesBeforeStart: 30 }, remote: { minutesBeforeStart: 20 }, stateVersion: "a".repeat(64) } } : receipt);
  });
  const tree = await review();
  buttons(tree, "Apply saved series alarm")[0].onPress();
  expect(h.alert.mock.lastCall![1]).toContain("every occurrence in the series");
  expect(bodies).toHaveLength(0); acceptNative(); await settle();
  expect(bodies[0].expectedReminderStateVersion).toBe("a".repeat(64));
});
