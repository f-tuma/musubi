import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskDeliverySchema, type TaskDeliveryTarget } from "@musubi/types";
import { afterEach, expect, it, vi } from "vitest";
import { TaskDeliveryDialog, taskDeliveryCanRetry } from "./TaskDeliveryDialog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const target: TaskDeliveryTarget = { operationId: "11111111-1111-4111-8111-111111111111", calendarId: "mirror", calendarName: "Shared calendar", provider: "caldav", action: "create", status: "unconfirmed", revision: 4, owned: true, issue: "unconfirmed", updatedAt: new Date() };
it("never offers retry for uncertain create, unsupported recovery, conflicts or another member's destination", () => {
  expect(taskDeliveryCanRetry(target)).toBe(false);
  for (const issue of ["write-unsupported", "permission-unknown", "destination-unavailable", "conflict", "unconfirmed", "recovery-unavailable"] as const) expect(taskDeliveryCanRetry({ ...target, status: "blocked", issue })).toBe(false);
  expect(taskDeliveryCanRetry({ ...target, status: "not-written", issue: "delivery-failed", owned: false })).toBe(false);
  expect(taskDeliveryCanRetry({ ...target, status: "not-written", issue: "delivery-failed" })).toBe(true);
});
it("recovers a proven not-written target and hides private destination data after access loss", async () => {
  let revoked = false;
  let delivery = TaskDeliverySchema.parse({ taskId: "shared-task", localRevision: 4, targets: [{ ...target, status: "not-written", issue: "delivery-failed" }] });
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("/retry")) delivery = { ...delivery, targets: [{ ...delivery.targets[0]!, status: "completed", issue: null }] };
    return new Response(JSON.stringify(revoked ? { error: "Access removed" } : delivery), { status: revoked ? 403 : 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><TaskDeliveryDialog taskId={delivery.taskId} userId="me" onClose={vi.fn()} /></QueryClientProvider>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByText("Delivered", { exact: true })).toBeTruthy());
  expect(fetch.mock.calls.some(([url]) => url.endsWith(`/delivery/${target.operationId}/retry`))).toBe(true);
  revoked = true;
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(screen.queryByText(target.calendarName!)).toBeNull());
  expect(screen.getByText("Could not load task delivery.")).toBeTruthy();
  client.clear();
});
