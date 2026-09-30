import { eventDeliveryActions, eventDeliveryRetryLabel } from "@musubi/calendar";
import { EventDeliveryTargetSchema } from "@musubi/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EventDeliveryDialog } from "./EventDeliveryDialog";
import { ApplicationNotifications } from "~/notifications/ApplicationNotifications";
import { getServerOrigin, queryKeys } from "~/api/query-keys";

const eventId = "00000000-0000-4000-8000-000000000001";
const operationId = "00000000-0000-4000-8000-000000000002";
const calendarId = "00000000-0000-4000-8000-000000000003";
const targetId = "00000000-0000-4000-8000-000000000004";
const content = {
  title: "Saved title",
  start: "2026-09-07T10:00:00Z",
  end: "2026-09-07T11:00:00Z",
  isAllDay: false,
  description: "Saved notes",
  location: null,
  recurrence: null,
};
const target = {
  targetId,
  calendarId,
  calendarName: "Work",
  provider: "google",
  owned: true,
  connected: true,
  operationId,
  action: "update",
  status: "conflict",
  revision: 2,
  latestRevision: 2,
  updatedAt: "2026-09-07T11:00:00Z",
  retryAt: null,
  issue: "conflict",
};
const receipt = { eventId, localRevision: 2, targets: [target] };
const preview = {
  eventId,
  operationId,
  latestOperationId: operationId,
  localRevision: 2,
  local: content,
  remote: { ...content, title: "Remote title" },
  remoteEtag: '"remote-2"',
  action: "update",
  canResolve: true,
  reason: null,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});
function mount(connectionId?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const result = render(
    <QueryClientProvider client={client}>
      <EventDeliveryDialog
        eventId={eventId}
        userId="owner"
        connectionId={connectionId}
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return { ...result, client };
}

it("renders mixed destination receipts, and never lends owner actions to a collaborator", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        ...receipt,
        targets: [
          { ...target, status: "completed", issue: null },
          {
            ...target,
            targetId: "00000000-0000-4000-8000-000000000005",
            calendarName: "Shared",
            owned: false,
          },
          {
            ...target,
            targetId: "00000000-0000-4000-8000-000000000006",
            calendarName: "Unknown",
            status: "unknown",
            operationId: null,
            issue: null,
          },
        ],
      }),
    ),
  );
  mount();
  await screen.findByText(/Delivery confirmed/);
  expect(screen.getByText(/Remote changes need review/)).toBeTruthy();
  expect(screen.getByText(/No delivery receipt/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Review changes" })).toBeNull();
});

it("holds the explicit preview across SSE invalidation and reuses its mutation identity after a lost reply", async () => {
  const bodies: unknown[] = [];
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/conflict")) return json(preview);
      if (url.endsWith("/resolve")) {
        bodies.push(JSON.parse(String(init?.body)));
        if (bodies.length === 1) throw new TypeError("lost response");
        return json(
          {
            ...receipt,
            targets: [{ ...target, status: "pending", issue: null }],
          },
          202,
        );
      }
      reads++;
      return json(receipt);
    }),
  );
  const { client } = mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Review changes" }),
  );
  const comparison = await screen.findByRole("dialog", {
    name: "Review remote changes",
  });
  expect(within(comparison).getByText("Saved title")).toBeTruthy();
  expect(within(comparison).getByText("Remote title")).toBeTruthy();
  await client.invalidateQueries({
    queryKey: queryKeys.delivery(getServerOrigin(), "owner"),
  });
  expect(reads).toBeGreaterThan(1);
  fireEvent.click(
    within(comparison).getByRole("button", { name: "Apply saved changes" }),
  );
  await within(comparison).findByText(/Could not reach the server/);
  fireEvent.click(
    within(comparison).getByRole("button", { name: "Apply saved changes" }),
  );
  await screen.findByText(/Saved changes queued/);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0]).toMatchObject({
    expectedLocalRevision: 2,
    expectedLatestOperationId: operationId,
    expectedRemoteExists: true,
    expectedRemoteEtag: '"remote-2"',
  });
  expect(Object.keys(bodies[0] as object).sort()).toEqual([
    "expectedLatestOperationId",
    "expectedLocalRevision",
    "expectedRemoteEtag",
    "expectedRemoteExists",
    "mutationId",
  ]);
});

it("requires a fresh comparison after a stale-state rejection", async () => {
  let previews = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/conflict")) {
        previews++;
        return json(preview);
      }
      if (url.endsWith("/resolve")) return json({ error: "changed" }, 409);
      return json(receipt);
    }),
  );
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Review changes" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Apply saved changes" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Review remote changes" }),
    ).toBeNull(),
  );
  expect(
    screen.queryByRole("button", { name: "Apply saved changes" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load comparison" }));
  await screen.findByRole("dialog", { name: "Review remote changes" });
  expect(previews).toBe(2);
});

it.each(["preview", "resolve"])("treats a provider-conflict envelope during %s as a safe refusal", async (stage) => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const failure = { error: "Remote event version changed or is unavailable. No changes were saved. Refresh and reconcile before retrying.", code: "provider-conflict", localCommitted: false };
    if (url.endsWith("/conflict")) return stage === "preview" ? json(failure, 409) : json(preview);
    if (url.endsWith("/resolve")) return json(failure, 409);
    return json(receipt);
  }));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Review changes" }));
  if (stage === "resolve") fireEvent.click(await screen.findByRole("button", { name: "Apply saved changes" }));
  await screen.findByText("The delivery state changed or cannot be resolved safely. Load a fresh comparison before trying again.");
  expect(screen.queryByText(/Could not reach the server/)).toBeNull();
  expect(screen.queryByRole("dialog", { name: "Review remote changes" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Apply saved changes" })).toBeNull();
  expect(screen.getByRole("button", { name: "Load comparison" })).toBeTruthy();
});

it("routes retry through the chosen federation connection without claiming remote success", async () => {
  const requests: string[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(url);
    if (init?.method === "POST") expect(init.body).toBe("{}");
    return json({
      ...receipt,
      targets: [{ ...target, status: "retry", issue: "delivery-failed" }],
    });
  });
  vi.stubGlobal("fetch", fetch);
  const { client } = mount("remote");
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await screen.findByText(
    /Retry requested. Provider confirmation is still pending/,
  );
  expect(
    requests.every((url) => url.startsWith("/api/v1/federation/s/remote/")),
  ).toBe(true);
  expect(
    client.getQueryData([
      ...queryKeys.delivery(getServerOrigin(), "owner"),
      "event",
      eventId,
    ]),
  ).toBeUndefined();
});

it("discovers retained deletions from the server, including the next page", async () => {
  const next = "00000000-0000-4000-8000-000000000009";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("?cursor="))
        return json({
          items: [{ eventId: next, savedTitle: "Deleted appointment" }],
          nextCursor: null,
        });
      if (url.endsWith("/event-deliveries"))
        return json({
          items: [{ eventId, savedTitle: "Queued event" }],
          nextCursor: eventId,
        });
      return json({
        ...receipt,
        eventId: next,
        localRevision: null,
        targets: [
          {
            ...target,
            action: "delete",
            status: "unconfirmed",
            issue: "unconfirmed",
          },
        ],
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <ApplicationNotifications
        userId="owner"
        calendars={[]}
        events={[]}
        onOpenConnections={vi.fn()}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /^Notifications/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /Deleted appointment/ }),
  );
  await screen.findByText(/Delivery unconfirmed/);
  expect(screen.getByText("Retained delivery records")).toBeTruthy();
});

it("hides cached receipts and actions when refreshed authorization is refused", async () => {
  let revoked = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      revoked ? json({ error: "Access removed" }, 403) : json(receipt),
    ),
  );
  mount();
  await screen.findByRole("button", { name: "Review changes" });
  revoked = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  await screen.findByText(/Could not verify delivery/);
  expect(screen.queryByRole("button", { name: "Review changes" })).toBeNull();
  expect(screen.queryByText(/Work · google/)).toBeNull();
});

it("shows occurrence cancellation and civil anchors and confirms the master revision", async () => {
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/conflict"))
        return json({
          ...preview,
          masterRevision: 7,
          local: scoped,
          remote: { ...scoped, isCanceled: false },
        });
      if (url.endsWith("/resolve")) {
        body = JSON.parse(String(init?.body));
        return json(receipt, 202);
      }
      return json(receipt);
    }),
  );
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Review changes" }),
  );
  const comparison = await screen.findByRole("dialog", {
    name: "Review remote changes",
  });
  expect(within(comparison).getByText("Cancelled")).toBeTruthy();
  expect(within(comparison).getByText("Active")).toBeTruthy();
  expect(
    within(comparison).getAllByText(/Europe\/Prague · 2026-09-07T12:00:00.000/),
  ).toHaveLength(2);
  expect(within(comparison).queryByText("Does not repeat")).toBeNull();
  fireEvent.click(
    within(comparison).getByRole("button", { name: "Apply saved changes" }),
  );
  await waitFor(() => expect(body?.expectedMasterRevision).toBe(7));
});

it("shows personal reminders and keeps the exact confirmation after a failed request", async () => {
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/conflict")) return json({ ...preview, reminderResolution: {
      desired: { useDefault: false, overrides: [{ method: "popup", minutes: 15 }] },
      remote: { provider: "google", useDefault: true, overrides: [] }, stateVersion: "a".repeat(64),
    } });
    if (url.endsWith("/resolve")) { requests.push(JSON.parse(String(init?.body))); return requests.length === 1 ? json({ error: "Temporary failure" }, 503) : json(receipt, 202); }
    return json(receipt);
  }));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Review changes" }));
  const comparison = await screen.findByRole("dialog", { name: "Review remote changes" });
  expect(within(comparison).getByText("popup · 15 minutes before start")).toBeTruthy();
  expect(within(comparison).getByText("Calendar defaults")).toBeTruthy();
  expect(within(comparison).queryByText("Remote title")).toBeNull();
  expect(within(comparison).getByText(/Musubi reminders stay unchanged/)).toBeTruthy();
  fireEvent.click(within(comparison).getByRole("button", { name: "Apply saved reminders" }));
  await screen.findByRole("alert");
  fireEvent.click(within(comparison).getByRole("button", { name: "Apply saved reminders" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0].expectedReminderStateVersion).toBe("a".repeat(64));
  expect(requests[0]).not.toHaveProperty("reminders");
});

it("compares only the own RSVP response and freezes the full native preview for retry", async () => {
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/conflict")) return json({ ...preview, rsvpResolution: { desired: "accepted", remote: "declined", baselineVersion: "c".repeat(64) } });
    if (url.endsWith("/resolve")) { requests.push(JSON.parse(String(init?.body))); return requests.length === 1 ? json({ error: "Temporary failure" }, 503) : json(receipt, 202); }
    return json(receipt);
  }));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Review changes" }));
  const comparison = await screen.findByRole("dialog", { name: "Review remote changes" });
  expect(within(comparison).getByText("Accept")).toBeTruthy(); expect(within(comparison).getByText("Decline")).toBeTruthy();
  expect(within(comparison).queryByText("Remote title")).toBeNull();
  expect(within(comparison).getByText(/Email delivery cannot be verified/)).toBeTruthy();
  fireEvent.click(within(comparison).getByRole("button", { name: "Send saved response" }));
  await screen.findByRole("alert");
  fireEvent.click(within(comparison).getByRole("button", { name: "Send saved response" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]).toEqual(requests[0]); expect(requests[0].expectedRsvpBaselineVersion).toBe("c".repeat(64));
  expect(requests[0]).not.toHaveProperty("attendees"); expect(requests[0]).not.toHaveProperty("response");
});


it("confirms the displayed following-deletion cut and retains it across an ambiguous retry", async () => {
  const scopeResolution = { kind: "following-delete", originalStart: { kind: "instant", value: "2026-09-07T10:00:00.000Z" } };
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/conflict")) return json({ ...preview, scopeResolution });
    if (url.endsWith("/resolve")) {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) throw new Error("Lost response");
      return json(receipt, 202);
    }
    return json(receipt);
  }));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Review changes" }));
  const comparison = await screen.findByRole("dialog", { name: "Review remote changes" });
  expect(within(comparison).getByText("Delete this and following")).toBeTruthy();
  expect(within(comparison).getByText(/Original start: 2026-09-07/)).toBeTruthy();
  expect(within(comparison).getByText(/Earlier occurrences remain/)).toBeTruthy();
  expect(within(comparison).queryByRole("button", { name: "Apply saved changes" })).toBeNull();
  fireEvent.click(within(comparison).getByRole("button", { name: "Delete following occurrences" }));
  await within(comparison).findByText(/Could not reach the server/);
  fireEvent.click(within(comparison).getByRole("button", { name: "Delete following occurrences" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[0].expectedScopeResolution).toEqual(scopeResolution);
  expect(requests[1]).toEqual(requests[0]);
});

it("confirms the displayed whole-series deletion and retains it across an ambiguous retry", async () => {
  const scopeResolution = { kind: "series-delete" };
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/conflict")) return json({ ...preview, scopeResolution, action: "delete", local: null, localRevision: null });
    if (url.endsWith("/resolve")) {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) throw new Error("Lost response");
      return json(receipt, 202);
    }
    return json(receipt);
  }));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Review changes" }));
  const comparison = await screen.findByRole("dialog", { name: "Review remote changes" });
  expect(within(comparison).getByText("Entire series")).toBeTruthy();
  expect(within(comparison).getByText(/This removes the entire remote series/)).toBeTruthy();
  expect(within(comparison).queryByRole("button", { name: "Apply saved changes" })).toBeNull();
  fireEvent.click(within(comparison).getByRole("button", { name: "Delete entire series" }));
  await within(comparison).findByText(/Could not reach the server/);
  fireEvent.click(within(comparison).getByRole("button", { name: "Delete entire series" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[0].expectedScopeResolution).toEqual(scopeResolution);
  expect(requests[1]).toEqual(requests[0]);
});

it("confirms the displayed following split and its future series and retains it across an ambiguous retry", async () => {
  const scopeResolution = { kind: "following-update", newSeriesId: "00000000-0000-4000-8000-000000000099", originalStart: { kind: "instant", value: "2026-09-07T10:00:00.000Z" } };
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/conflict")) return json({ ...preview, scopeResolution, splitFuture: { ...content, title: "Saved future title", recurrence: "RRULE:FREQ=WEEKLY;COUNT=4" } });
    if (url.endsWith("/resolve")) {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) throw new Error("Lost response");
      return json(receipt, 202);
    }
    return json(receipt);
  }));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Review changes" }));
  const comparison = await screen.findByRole("dialog", { name: "Review remote changes" });
  expect(within(comparison).getByText("Saved future series")).toBeTruthy();
  expect(within(comparison).getByText("Saved future title")).toBeTruthy();
  expect(within(comparison).getByText("Change this and following")).toBeTruthy();
  expect(within(comparison).getByText(/Original start: 2026-09-07/)).toBeTruthy();
  expect(within(comparison).getByText(/two steps/)).toBeTruthy();
  expect(within(comparison).queryByRole("button", { name: "Apply saved changes" })).toBeNull();
  fireEvent.click(within(comparison).getByRole("button", { name: "Apply following changes" }));
  await within(comparison).findByText(/Could not reach the server/);
  fireEvent.click(within(comparison).getByRole("button", { name: "Apply following changes" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[0].expectedScopeResolution).toEqual(scopeResolution);
  expect(requests[1]).toEqual(requests[0]);
});


it("refuses a split confirmation that omits the saved future comparison", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => json(url.endsWith("/conflict") ? { ...preview, scopeResolution: { kind: "following-update", originalStart: { kind: "instant", value: "2026-09-07T10:00:00.000Z" }, newSeriesId: "00000000-0000-4000-8000-000000000099" } } : receipt)));
  mount(); fireEvent.click(await screen.findByRole("button", { name: "Review changes" }));
  const button = await screen.findByRole("button", { name: "Apply following changes" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
});

it("confirms only the future series after source acknowledgement with a frozen retry", async () => {
  const scopeResolution = { kind: "following-create", newSeriesId: "00000000-0000-4000-8000-000000000099", originalStart: { kind: "instant", value: "2026-09-07T10:00:00.000Z" } };
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/conflict")) return json({ ...preview, action: "create", remote: null, remoteEtag: null, scopeResolution });
    if (url.endsWith("/resolve")) { requests.push(JSON.parse(String(init?.body))); if (requests.length === 1) throw new Error("Lost response"); return json(receipt, 202); }
    return json(receipt);
  }));
  mount(); fireEvent.click(await screen.findByRole("button", { name: "Review changes" }));
  const comparison = await screen.findByRole("dialog", { name: "Review remote changes" });
  expect(within(comparison).getByText("Saved future series")).toBeTruthy();
  expect(within(comparison).getByText(/The earlier series is already saved/)).toBeTruthy();
  expect(within(comparison).queryByText(/two steps/)).toBeNull();
  fireEvent.click(within(comparison).getByRole("button", { name: "Finish future series" }));
  await within(comparison).findByText(/Could not reach the server/);
  fireEvent.click(within(comparison).getByRole("button", { name: "Finish future series" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[0]).toMatchObject({ expectedScopeResolution: scopeResolution, expectedRemoteExists: false, expectedRemoteEtag: null });
  expect(requests[1]).toEqual(requests[0]);
});

it("refuses future-only confirmation without the saved future content", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => json(url.endsWith("/conflict") ? { ...preview, local: null, scopeResolution: { kind: "following-create", originalStart: { kind: "instant", value: "2026-09-07T10:00:00.000Z" }, newSeriesId: "00000000-0000-4000-8000-000000000099" } } : receipt)));
  mount(); fireEvent.click(await screen.findByRole("button", { name: "Review changes" }));
  expect((await screen.findByRole("button", { name: "Finish future series" }) as HTMLButtonElement).disabled).toBe(true);
});

it("compares CalDAV event alarms and freezes the explicit alarm proof across retry", async () => {
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/conflict")) return json({ ...preview, caldavAlarmResolution: { desired: { minutesBeforeStart: null }, remote: { minutesBeforeStart: 20 }, stateVersion: "a".repeat(64) } });
    if (url.endsWith("/resolve")) { requests.push(JSON.parse(String(init?.body))); if (requests.length === 1) throw new Error("Lost response"); return json(receipt, 202); }
    return json(receipt);
  }));
  mount(); fireEvent.click(await screen.findByRole("button", { name: "Review changes" }));
  const comparison = await screen.findByRole("dialog", { name: "Review remote changes" });
  expect(within(comparison).getByText("Saved CalDAV event alarm")).toBeTruthy();
  expect(within(comparison).getByText("Display 20 minutes before start")).toBeTruthy();
  expect(within(comparison).queryByText("Saved Google reminders")).toBeNull();
  fireEvent.click(within(comparison).getByRole("button", { name: "Apply saved event alarm" }));
  await within(comparison).findByText(/Could not reach the server/);
  fireEvent.click(within(comparison).getByRole("button", { name: "Apply saved event alarm" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[0].expectedReminderStateVersion).toBe("a".repeat(64));
  expect(requests[1]).toEqual(requests[0]);
});

it("explicitly discards an unsupported saved CalDAV alarm without requesting a native resolution", async () => {
  const writes: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/discard-alarm")) { writes.push(JSON.parse(String(init?.body))); return json({ ...receipt, targets: [{ ...target, provider: "caldav", status: "not-needed", alarmDiscarded: true }] }); }
    return json({ ...receipt, targets: [{ ...target, provider: "caldav", ...(writes.length ? { status: "not-needed", alarmDiscarded: true } : { alarmDiscardRevision: 2 }) }] });
  }));
  mount(); fireEvent.click(await screen.findByRole("button", { name: "Discard saved alarm change" }));
  const dialog = await screen.findByRole("dialog", { name: "Discard saved alarm change" });
  expect(within(dialog).getByText(/does not undo a change/)).toBeTruthy();
  expect(writes).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole("button", { name: "Discard saved alarm change" }));
  await waitFor(() => expect(writes).toEqual([{ expectedRevision: 2 }]));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Discard saved alarm change" })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Refresh status" })));
});

it("announces a failed alarm discard inside its confirmation and retries the same revision", async () => {
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/discard-alarm")) {
      writes.push(JSON.parse(String(init?.body)));
      if (writes.length === 1) throw new TypeError("lost response");
      return json(receipt);
    }
    return json({ ...receipt, targets: [{ ...target, provider: "caldav", alarmDiscardRevision: 2 }] });
  }));
  mount();
  const trigger = await screen.findByRole("button", { name: "Discard saved alarm change" });
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Discard saved alarm change" });
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })));
  fireEvent.click(within(dialog).getByRole("button", { name: "Discard saved alarm change" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("Could not reach the server");
  fireEvent.click(within(dialog).getByRole("button", { name: "Discard saved alarm change" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Discard saved alarm change" })).toBeNull());
  expect(writes).toEqual([{ expectedRevision: 2 }, { expectedRevision: 2 }]);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Refresh status" })));
});

it("closes a stale alarm discard, refreshes its revision and returns focus before a new confirmation", async () => {
  const writes: unknown[] = [];
  let revision = 2;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/discard-alarm")) {
      writes.push(JSON.parse(String(init?.body)));
      if (writes.length === 1) { revision = 3; return json({ error: "changed" }, 409); }
      return json(receipt);
    }
    return json({ ...receipt, targets: [{ ...target, provider: "caldav", alarmDiscardRevision: revision }] });
  }));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Discard saved alarm change" }));
  const dialog = await screen.findByRole("dialog", { name: "Discard saved alarm change" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Discard saved alarm change" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Discard saved alarm change" })).toBeNull());
  expect(screen.getByRole("alert").textContent).toContain("Check the refreshed status");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Refresh status" })));
  fireEvent.click(screen.getByRole("button", { name: "Discard saved alarm change" }));
  const fresh = await screen.findByRole("dialog", { name: "Discard saved alarm change" });
  expect(within(fresh).queryByRole("alert")).toBeNull();
  fireEvent.click(within(fresh).getByRole("button", { name: "Discard saved alarm change" }));
  await waitFor(() => expect(writes).toEqual([{ expectedRevision: 2 }, { expectedRevision: 3 }]));
});

it("returns focus after cancelling a lost discard response whose refreshed receipt removes the trigger", async () => {
  let discarded = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/discard-alarm")) { discarded = true; throw new TypeError("lost response"); }
    return json({ ...receipt, targets: [{ ...target, provider: "caldav", ...(discarded ? { status: "not-needed", alarmDiscarded: true } : { alarmDiscardRevision: 2 }) }] });
  }));
  mount();
  const trigger = await screen.findByRole("button", { name: "Discard saved alarm change" });
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Discard saved alarm change" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Discard saved alarm change" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("Could not reach the server");
  await waitFor(() => expect(trigger.isConnected).toBe(false));
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  await waitFor(() => expect(cancel.hasAttribute("disabled")).toBe(false));
  fireEvent.click(cancel);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Discard saved alarm change" })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Refresh status" })));
});
it("explicitly adopts a provider family locally and preserves the preview on retry", async () => {
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/conflict")) return json({ ...preview, action: "create", graphCreateAdoption: { stateVersion: "a".repeat(64), occurrenceCount: 3 } });
    if (url.endsWith("/resolve")) { bodies.push(JSON.parse(String(init?.body))); return bodies.length === 1 ? json({ error: "offline" }, 503) : json(receipt); }
    return json({ ...receipt, targets: [{ ...target, provider: "microsoft", action: "create" }] });
  }));
  mount(); await screen.findByText(/Remote changes need review/);
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  const dialog = await screen.findByRole("dialog", { name: "Review remote changes" });
  expect(within(dialog).queryByRole("button", { name: "Recreate remote copy" })).toBeNull();
  expect(within(dialog).getByText(/No provider write is sent/)).toBeTruthy();
  expect(bodies).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole("button", { name: "Use provider version" }));
  await within(dialog).findByText(/offline/);
  fireEvent.click(within(dialog).getByRole("button", { name: "Use provider version" }));
  await screen.findByText(/Provider version accepted in Musubi. No provider write was sent/);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0]).toEqual({ kind: "graph-create-adoption", mutationID: expect.any(String), expectedRevision: 2, stateVersion: "a".repeat(64) });
});

it("checks a dispatched Graph pull conflict without offering a new response or resolution", async () => {
  let checked = false;
  const fetcher = vi.fn(async (input: string) => {
    if (String(input).endsWith("/retry")) checked = true;
    return json({ ...receipt, targets: [{ ...target, provider: "microsoft", status: checked ? "unconfirmed" : "conflict", graphRsvpPhase: checked ? "absent" : "accepted" }] });
  });
  vi.stubGlobal("fetch", fetcher); mount();
  fireEvent.click(await screen.findByRole("button", { name: "Check response" }));
  await screen.findByText(/Outlook meeting copy unavailable/);
  expect(screen.queryByRole("button", { name: "Review changes" })).toBeNull();
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/retry"))).toHaveLength(1);
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("/resolve") || String(url).includes("/provider-rsvp"))).toBe(false);
});

it("states the whole-series scope before applying a saved CalDAV alarm", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => json(url.endsWith("/conflict") ? { ...preview, caldavAlarmResolution: { scope: "series", desired: { minutesBeforeStart: 30 }, remote: { minutesBeforeStart: 20 }, stateVersion: "a".repeat(64) } } : receipt)));
  mount(); fireEvent.click(await screen.findByRole("button", { name: "Review changes" }));
  const comparison = await screen.findByRole("dialog", { name: "Review remote changes" });
  expect(within(comparison).getByText(/This applies to every occurrence in the series/)).toBeTruthy();
  expect(within(comparison).getByRole("button", { name: "Apply saved series alarm" })).toBeTruthy();
  expect(within(comparison).queryByRole("button", { name: "Apply saved event alarm" })).toBeNull();
});

it("checks an uncertain Graph create conflict using its original operation without adopting", async () => {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/retry")) calls.push({ url, body: JSON.parse(String(init?.body)) });
    return json({ ...receipt, targets: [{ ...target, provider: "microsoft", action: "create", status: "conflict", graphCreateCheck: true }] });
  }));
  mount();
  const check = await screen.findByRole("button", { name: "Check creation" });
  expect(screen.getByRole("button", { name: "Review changes" })).toBeTruthy();
  fireEvent.click(check);
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toEqual({ url: expect.stringContaining(`/delivery/${operationId}/retry`), body: {} });
  expect(screen.queryByRole("dialog", { name: "Review remote changes" })).toBeNull();
});

it("keeps the additive creation-check capability private to available owned receipts", () => {
  const parsed = EventDeliveryTargetSchema.parse({ ...target, provider: "microsoft", action: "create", status: "conflict", graphCreateCheck: true });
  expect(eventDeliveryRetryLabel(parsed)).toBe("Check creation");
  expect(eventDeliveryActions(parsed)).toEqual({ retry: true, review: true });
  expect(eventDeliveryActions({ ...parsed, owned: false }).retry).toBe(false);
  expect(eventDeliveryActions({ ...parsed, connected: false }).retry).toBe(false);
  expect(eventDeliveryActions({ ...parsed, graphCreateCheck: undefined }).retry).toBe(false);
  expect(EventDeliveryTargetSchema.safeParse({ ...parsed, graphCreateCheck: "true" }).success).toBe(false);
});
