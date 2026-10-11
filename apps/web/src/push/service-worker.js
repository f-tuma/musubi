/* global self, NOTIFICATION_ICON */

// The only part of Musubi that runs when nobody has the app open.
//
// Deliberately tiny and dependency-free: the shared icon URL is prepended (see
// `routes/app/sw[.]js.ts`), never bundled, and a syntax error here is a feature
// that silently stops working for everyone whose browser cached it.

self.addEventListener("install", () => {
  // Take over without waiting for every old tab to close. There is no cached
  // app shell to keep consistent — the worker only shows notifications — so the
  // usual reason to wait does not apply.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  // A push with no data is a wake-up from nowhere we recognise. Showing an
  // empty notification would be worse than ignoring it — but note that some
  // browsers punish a push handler that shows nothing at all by revoking the
  // subscription, so this stays a deliberate, narrow case.
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }
  if (!payload || !payload.title) return;

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body ?? "",
      data: { eventID: payload.eventID },
      icon: NOTIFICATION_ICON,
      // The occurrence id. A reminder re-sent after a restart replaces the
      // banner already on screen instead of stacking a second copy.
      tag: payload.tag,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  // Focus a tab that is already open rather than piling up new ones — somebody
  // clicking a reminder wants their calendar, not their eighth copy of it.
  event.waitUntil(
    self.clients
      .matchAll({ includeUncontrolled: true, type: "window" })
      .then((clients) => {
        for (const client of clients) {
          if (client.url.includes("/app") && "focus" in client) {
            return client.focus();
          }
        }
        return self.clients.openWindow("/app");
      }),
  );
});
