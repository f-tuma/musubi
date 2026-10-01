import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { fixtureEvents } from "~/calendar/fixtures";
import { getServerOrigin } from "~/api/query-keys";
import { ApplicationNotifications } from "./ApplicationNotifications";
import { eventNoticeKey } from "./model";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
for (const refusal of ["removed", "forbidden"] as const) {
  it(`opens readable cancellations and drops the live title after the record is ${refusal}`, async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const event = { ...fixtureEvents[0], revision: 3, isCanceled: true, description: "Private cancelled notes" };
    let revoked = false;
    client.setQueryData(eventNoticeKey(getServerOrigin(), "me"), [{ eventId: event.id, revision: 3, kind: "event_updated" }]);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const delivery = url.includes("event-deliveries");
      return new Response(JSON.stringify(delivery ? { items: [], nextCursor: null }
        : revoked && refusal === "forbidden" ? { error: "Access removed" }
          : { events: revoked ? [] : [event], deletedIds: revoked ? [event.id] : [], serverTime: new Date().toISOString() }), {
        status: !delivery && revoked && refusal === "forbidden" ? 403 : 200, headers: { "content-type": "application/json" },
      });
    }));
    render(<QueryClientProvider client={client}><ApplicationNotifications userId="me" calendars={[]} events={[]} onOpenConnections={vi.fn()} /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /^Notifications/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Cancelled by another member/ }));
    const detail = await screen.findByRole("dialog", { name: event.title });
    expect(within(detail).getByText("Cancelled", { exact: true })).toBeTruthy();
    expect(within(detail).getByText("Private cancelled notes")).toBeTruthy();
    revoked = true;
    await act(() => client.invalidateQueries({ queryKey: ["events", getServerOrigin(), "me"] }));
    await waitFor(() => expect(screen.queryByText("Private cancelled notes")).toBeNull());
    expect(screen.queryByRole("dialog", { name: event.title })).toBeNull();
    const unavailable = screen.getByRole("dialog", { name: "Event" });
    expect(within(unavailable).getByText(refusal === "forbidden" ? "Could not load event" : "This event is no longer available.")).toBeTruthy();
    fireEvent.click(within(unavailable).getByRole("button", { name: "Close event" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Notifications/ })));
    client.clear();
  });
}
