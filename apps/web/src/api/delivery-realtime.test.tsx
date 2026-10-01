import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { refreshServerData, useServerStream } from "./realtime";
import { getServerOrigin, queryKeys } from "./query-keys";

vi.mock("~/auth/auth-client", () => ({
  authClient: { getSession: vi.fn() },
  notifyAuthExpired: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("refreshes delivery after reconnect and external sync only for the current owner", async () => {
  const streams: FakeSource[] = [];
  class FakeSource {
    onmessage?: (message: { data: string }) => void;
    onopen?: () => void;
    onerror?: () => void;
    close = vi.fn();
    constructor() {
      streams.push(this);
    }
  }
  vi.stubGlobal("EventSource", FakeSource);
  const client = new QueryClient();
  const own = [
    ...queryKeys.delivery(getServerOrigin(), "owner"),
    "event",
    "saved",
  ];
  const other = [
    ...queryKeys.delivery(getServerOrigin(), "other"),
    "event",
    "saved",
  ];
  const ownCalendars = queryKeys.calendars(getServerOrigin(), "owner");
  const ownTasks = queryKeys.tasks(getServerOrigin(), "owner");
  const otherTasks = queryKeys.tasks(getServerOrigin(), "other");
  const otherCalendars = queryKeys.calendars(getServerOrigin(), "other");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { unmount } = renderHook(() => useServerStream("owner"), { wrapper });
  for (const trigger of [
    () => streams[0].onopen?.(),
    () =>
      streams[0].onmessage?.({
        data: JSON.stringify({ type: "external_sync" }),
      }),
  ]) {
    client.setQueryData(ownTasks, []);
    client.setQueryData(otherTasks, []);
    client.setQueryData(ownCalendars, []);
    client.setQueryData(otherCalendars, []);
    client.setQueryData(own, "old");
    client.setQueryData(other, "other");
    act(trigger);
    await waitFor(() =>
      expect(client.getQueryState(own)?.isInvalidated).toBe(true),
    );
    expect(client.getQueryState(other)?.isInvalidated).toBe(false);
    expect(client.getQueryState(ownTasks)?.isInvalidated).toBe(true);
    expect(client.getQueryState(otherTasks)?.isInvalidated).toBe(false);
    expect(client.getQueryState(ownCalendars)?.isInvalidated).toBe(true);
    expect(client.getQueryState(otherCalendars)?.isInvalidated).toBe(false);
  }
  unmount();
  expect(streams[0].close).toHaveBeenCalled();
  client.clear();
});

it("manual refresh waits for every source on failure and retains other accounts and cached data", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const calendars = queryKeys.calendars(getServerOrigin(), "owner");
  const tasks = queryKeys.tasks(getServerOrigin(), "owner");
  const other = queryKeys.tasks(getServerOrigin(), "other");
  client.setQueryData(calendars, "saved calendars");
  client.setQueryData(tasks, "saved tasks");
  client.setQueryData(other, "other account");
  let release!: () => void;
  const failure = new Error("Server unavailable");
  const calendarObserver = new QueryObserver(client, { queryKey: calendars, queryFn: async () => { throw failure; } });
  const taskObserver = new QueryObserver(client, { queryKey: tasks, queryFn: () => new Promise<string>(resolve => { release = () => resolve("fresh tasks"); }) });
  const stops = [calendarObserver.subscribe(() => {}), taskObserver.subscribe(() => {})];
  let settled = false;
  const refresh = refreshServerData(client, "owner").catch(error => { settled = true; return error; });
  await waitFor(() => expect(client.getQueryState(calendars)?.error).toBe(failure));
  expect(settled).toBe(false);
  expect(client.getQueryData(calendars)).toBe("saved calendars");
  expect(client.getQueryData(tasks)).toBe("saved tasks");
  expect(client.getQueryState(other)?.isInvalidated).toBe(false);
  release();
  expect(await refresh).toBe(failure);
  expect(client.getQueryData(tasks)).toBe("fresh tasks");
  stops.forEach(stop => stop());
  client.clear();
});
