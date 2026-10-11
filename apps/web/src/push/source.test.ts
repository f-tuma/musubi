import { runInNewContext } from "node:vm";
import { BRAND_ASSETS } from "~/brand";
import { serviceWorkerSource } from "~/push/source";

function worker(windows: Array<{ url: string; focus?: () => Promise<void> }> = []) {
  const handlers = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const skipWaiting = vi.fn();
  const claim = vi.fn().mockResolvedValue(undefined);
  runInNewContext(serviceWorkerSource, {
    self: {
      addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
      skipWaiting,
      registration: { showNotification },
      clients: { claim, openWindow, matchAll: vi.fn().mockResolvedValue(windows) },
    },
  });
  return { handlers, showNotification, openWindow, skipWaiting, claim };
}

it("executes the emitted worker and shows the shared PNG without changing reminder fields", () => {
  const { handlers, showNotification } = worker();
  const waitUntil = vi.fn();
  handlers.get("push")!({ data: { json: () => ({ title: "Dentist", body: "In 10 minutes", eventID: "event-1", tag: "occurrence-1" }) }, waitUntil });
  expect(showNotification).toHaveBeenCalledWith("Dentist", {
    body: "In 10 minutes", data: { eventID: "event-1" }, tag: "occurrence-1", icon: BRAND_ASSETS.notificationIcon,
  });
  expect(waitUntil).toHaveBeenCalledOnce();
});

it("ignores empty or invalid payloads and keeps the existing default body", () => {
  const { handlers, showNotification } = worker();
  const waitUntil = vi.fn();
  for (const data of [undefined, { json: () => { throw new Error("invalid JSON"); } }, { json: () => null }, { json: () => ({ body: "no title" }) }]) {
    handlers.get("push")!({ data, waitUntil });
  }
  expect(showNotification).not.toHaveBeenCalled();
  handlers.get("push")!({ data: { json: () => ({ title: "Reminder" }) }, waitUntil });
  expect(showNotification).toHaveBeenCalledWith("Reminder", expect.objectContaining({ body: "", icon: BRAND_ASSETS.appleTouchIcon }));
});

it("still claims clients and focuses the existing app when a notification is clicked", async () => {
  const focus = vi.fn().mockResolvedValue(undefined);
  const { handlers, openWindow, skipWaiting, claim } = worker([{ url: "https://musubi.pro/app/p/personal/month", focus }]);
  handlers.get("install")!({});
  expect(skipWaiting).toHaveBeenCalledOnce();
  const waitUntil = vi.fn();
  handlers.get("activate")!({ waitUntil });
  expect(claim).toHaveBeenCalledOnce();
  const close = vi.fn();
  handlers.get("notificationclick")!({ notification: { close }, waitUntil });
  await waitUntil.mock.calls.at(-1)![0];
  expect(close).toHaveBeenCalledOnce();
  expect(focus).toHaveBeenCalledOnce();
  expect(openWindow).not.toHaveBeenCalled();
});

it("opens the app when there is no existing app window", async () => {
  const { handlers, openWindow } = worker([{ url: "https://musubi.pro/" }]);
  const waitUntil = vi.fn();
  handlers.get("notificationclick")!({ notification: { close: vi.fn() }, waitUntil });
  await waitUntil.mock.calls[0]![0];
  expect(openWindow).toHaveBeenCalledWith("/app");
});
