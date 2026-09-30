import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AvailabilitySection } from "./AvailabilitySection";
import { shouldPersistQuery } from "~/offline/snapshot";
import { providerConnectionScopes } from "../connections";
import { GOOGLE_AVAILABILITY_SCOPE } from "@musubi/types";
const id = "00000000-0000-4000-8000-000000000001";
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.unstubAllGlobals(); });
function mount(onReconnect = vi.fn(), onRefresh = vi.fn().mockResolvedValue(undefined)) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  return render(<QueryClientProvider client={client}><AvailabilitySection userId="owner" onReconnect={onReconnect} onRefresh={onRefresh} /></QueryClientProvider>);
}
it("requires explicit selection, displays intervals without event actions, and distinguishes unavailable from free", async () => {
  let enabled = false, generation = 0, mode = "unavailable";
  const reads: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/availability")) {
      const body = JSON.parse(String(init?.body)); reads.push(body);
      return Response.json({ ...body, sourceIds: undefined, observedAt: body.start, sources: [{ sourceId: id, generation, status: mode, ...(mode === "available" ? { intervals: [] } : {}) }] });
    }
    if (init?.method === "PUT") { const body = JSON.parse(String(init.body)); expect(body.expectedGeneration).toBe(generation); enabled = body.enabled; generation++; }
    return Response.json({ sources: [{ id, generation, enabled, label: "Work availability", accountLabel: "My Google", reconnectRequired: false }] });
  }));
  mount(); const toggle = await screen.findByRole("switch", { name: "Use Work availability for availability" });
  expect((screen.getByRole("button", { name: "Check availability" }) as HTMLButtonElement).disabled).toBe(true);
  expect(reads).toHaveLength(0); fireEvent.click(toggle);
  const trigger = screen.getByRole("button", { name: "Check availability" });
  await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "Check availability" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Read busy intervals" }));
  await within(dialog).findByText("Unavailable — free time is unknown");
  expect(within(dialog).queryByText("No busy intervals in the requested range")).toBeNull();
  mode = "available"; fireEvent.click(within(dialog).getByRole("button", { name: "Read busy intervals" }));
  await within(dialog).findByText("No busy intervals in the requested range");
  expect(reads).toHaveLength(2); expect(reads[0].sourceIds).toEqual([id]);
  expect(within(dialog).queryByRole("button", { name: /Edit|RSVP|Reminder/ })).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close availability" }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
it("never persists interval/source observations and only requests extra consent when enabled", () => {
  for (const suffix of ["sources", "intervals"]) expect(shouldPersistQuery({ queryKey: ["availability", "origin", "owner", suffix], state: { status: "success", data: {} } })).toBe(false);
  expect(providerConnectionScopes("google", false)).not.toContain(GOOGLE_AVAILABILITY_SCOPE);
  expect(providerConnectionScopes("google", true)).toContain(GOOGLE_AVAILABILITY_SCOPE);
  expect(providerConnectionScopes("microsoft", true)).not.toContain(GOOGLE_AVAILABILITY_SCOPE);
});

it("keeps a saved selection when an older source poll completes after the PUT", async () => {
  let generation = 1, enabled = false, gets = 0;
  let finishPoll!: (response: Response) => void;
  let pollSignal: AbortSignal | undefined;
  const snapshot = () => ({ sources: [{ id, generation, enabled, label: "Work availability", accountLabel: "My Google", reconnectRequired: false }] });
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") { enabled = true; generation++; return Response.json(snapshot()); }
    if (++gets === 2) { pollSignal = init?.signal ?? undefined; return new Promise<Response>(resolve => { finishPoll = resolve; }); }
    return Response.json(snapshot());
  }));
  mount(); const toggle = await screen.findByRole("switch", { name: "Use Work availability for availability" });
  const stale = snapshot();
  const poll = clients[0]!.refetchQueries({ queryKey: ["availability"] });
  await waitFor(() => expect(finishPoll).toBeDefined());
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(pollSignal?.aborted).toBe(true);
  finishPoll(Response.json(stale)); await poll;
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(clients[0]!.getQueriesData({ queryKey: ["availability"] })[0]![1]).toMatchObject({ sources: [{ generation: 2, enabled: true }] });
});

it.each([20, 21])("explains and recovers the source limit with %s sources already enabled", async count => {
  const sources = Array.from({ length: count + 1 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, generation: 1, enabled: i < count, label: `Source ${i + 1}`, accountLabel: "Google", reconnectRequired: false }));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") { const source = sources.find(item => url.endsWith(item.id))!; source.enabled = JSON.parse(String(init.body)).enabled; source.generation++; }
    return Response.json({ sources });
  }));
  mount();
  const off = await screen.findByRole("switch", { name: `Use Source ${count + 1} for availability` });
  expect((off as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(`Select up to 20 sources. ${count} selected; turn a source off before adding another.`)).toBeTruthy();
  const check = screen.getByRole("button", { name: "Check availability" }) as HTMLButtonElement;
  expect(check.disabled).toBe(count > 20);
  fireEvent.click(screen.getByRole("switch", { name: "Use Source 1 for availability" }));
  await waitFor(() => expect(check.disabled).toBe(false));
  if (count === 20) await waitFor(() => expect((off as HTMLButtonElement).disabled).toBe(false));
  else expect((off as HTMLButtonElement).disabled).toBe(true);
});

it("retains the named source and reconnect action after an invalid grant", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ sources: [{ id, generation: 2, enabled: true, label: "Work availability", accountLabel: "My Google", reconnectRequired: true }] })));
  const reconnect = vi.fn(); mount(reconnect);
  fireEvent.click(await screen.findByRole("button", { name: "Reconnect Google for availability" }));
  expect(reconnect).toHaveBeenCalledOnce();
  expect(screen.queryByText("No free/busy-only sources found")).toBeNull();
  expect(screen.getByRole("switch", { name: "Use Work availability for availability" }).getAttribute("aria-checked")).toBe("true");
});

it("explains setup without reading availability, refreshes discovery, and restores focus", async () => {
  const fetch = vi.fn(async (url: string) => {
    expect(url.endsWith("/availability/sources")).toBe(true);
    return Response.json({ sources: [] });
  });
  vi.stubGlobal("fetch", fetch);
  const onRefresh = vi.fn().mockRejectedValueOnce(new Error("Google is unavailable")).mockResolvedValueOnce(undefined);
  mount(vi.fn(), onRefresh);
  await screen.findByText("No shared busy-time calendars yet");
  expect(screen.queryByRole("button", { name: "Check availability" })).toBeNull();
  const setup = screen.getByRole("button", { name: "How to set up" });
  fireEvent.click(setup);
  const dialog = screen.getByRole("dialog", { name: "Set up Google availability" });
  expect(within(dialog).getByText("See only free/busy (hide details)")).toBeTruthy();
  expect(within(dialog).getByText(/Open the sharing email/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Refresh connected calendars" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe("Google is unavailable");
  fireEvent.click(within(dialog).getByRole("button", { name: "Refresh connected calendars" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(setup));
  expect(onRefresh).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.every(([url]) => String(url).endsWith("/availability/sources"))).toBe(true);
});
