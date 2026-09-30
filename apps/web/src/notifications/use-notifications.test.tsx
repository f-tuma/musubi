import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { fixtureEvents } from "~/calendar/fixtures";
import { eventNoticeKey } from "./model";
import { getServerOrigin } from "~/api/query-keys";
import { useNotifications } from "./use-notifications";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("reads other periods only after a real change, scopes read state, and removes revoked subjects", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const event = { ...fixtureEvents[0], revision: 3 };
  let revoked = false;
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("event-deliveries")
    ? { items: [], nextCursor: null }
    : revoked ? { error: "Permission removed" } : { events: [event], deletedIds: [], serverTime: new Date().toISOString() }), { status: revoked && !url.includes("event-deliveries") ? 403 : 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, rerender, unmount } = renderHook(({ userId }) => useNotifications(userId, [], []), { wrapper, initialProps: { userId: "me" } });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(fetch.mock.calls.some(([url]) => url.includes("/events"))).toBe(false);
  act(() => client.setQueryData(eventNoticeKey(getServerOrigin(), "me"), [{ eventId: event.id, revision: 3, kind: "event_updated" }]));
  await waitFor(() => expect(result.current.items[0]?.title).toBe(event.title));
  const id = result.current.items[0].id;
  act(() => result.current.read([id]));
  await waitFor(() => expect(result.current.readIds.has(id)).toBe(true));
  rerender({ userId: "another" });
  expect(result.current.readIds.has(id)).toBe(false);
  expect(result.current.items).toEqual([]);
  rerender({ userId: "me" });
  await waitFor(() => expect(result.current.readIds.has(id)).toBe(true));
  revoked = true;
  await act(() => client.invalidateQueries({ queryKey: ["events", getServerOrigin(), "me"] }));
  await waitFor(() => expect(result.current.items).toEqual([]));
  unmount(); client.clear();
});

it("hides a cached delivery title when the refreshed inbox rejects access", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let revoked = false;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(revoked
    ? { error: "Access removed" }
    : { items: [{ eventId: "00000000-0000-4000-8000-000000000001", savedTitle: "Private appointment" }], nextCursor: null }), { status: revoked ? 403 : 200, headers: { "content-type": "application/json" } })));
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, unmount } = renderHook(() => useNotifications("me", [], []), { wrapper });
  await waitFor(() => expect(result.current.items[0]?.title).toBe("Private appointment"));
  revoked = true;
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.error).toBe(true));
  expect(result.current.items).toEqual([]);
  unmount(); client.clear();
});
