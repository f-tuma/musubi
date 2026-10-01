import { PageDocumentSchema, PRODUCT_VERSION, type PageDocument } from "@musubi/types";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { authClient, notifyAuthExpired } from "~/auth/auth-client";
import { reconnectDelay } from "./backoff";
import { getServerOrigin, queryKeys } from "./query-keys";
import { acceptEventNotice, eventNoticeKey, type EventChangeNotice } from "~/notifications/model";

// Merge a realtime Page into the cached list, keeping it idempotent: a strictly
// newer revision replaces, an equal/older one is ignored. That drops the echo of
// the change the originating tab already applied, and keeps two tabs converged.
export function upsertPageIntoList(
  list: PageDocument[],
  page: PageDocument,
): PageDocument[] {
  const existing = list.find((item) => item.id === page.id);
  if (!existing) return sortPages([...list, page]);
  if (existing.revision >= page.revision) return list;
  return sortPages(list.map((item) => (item.id === page.id ? page : item)));
}

function sortPages(pages: PageDocument[]): PageDocument[] {
  return pages.sort(
    (left, right) =>
      left.position - right.position ||
      right.revision - left.revision ||
      left.createdAt.getTime() - right.createdAt.getTime(),
  );
}

type RealtimeMessage = { type?: string; payload?: Record<string, unknown> };

// One stream per document, so one place to reach it from. Sign-out has to close
// it *before* clearing the cache: a socket that is still open answers the next
// server nudge by refetching, which would repopulate the departing account's
// calendar into a cache that was just emptied.
let closeActive: (() => void) | undefined;

export function closeRealtimeStream() {
  closeActive?.();
}

/** Re-read account data without clearing cached data or changing the active screen. */
export async function refreshServerData(queryClient: QueryClient, userId: string) {
  const origin = getServerOrigin();
  const results = await Promise.allSettled([
    ["availability", origin, userId],
    queryKeys.calendars(origin, userId),
    queryKeys.tasks(origin, userId),
    queryKeys.federated(origin, userId),
    queryKeys.pages(origin, userId),
    queryKeys.settings(origin, userId),
    queryKeys.reminders(origin, userId),
    queryKeys.announcements(origin, userId),
    ["events", origin, userId],
    ["delivery", origin, userId],
  ].map(queryKey => queryClient.invalidateQueries({ queryKey }, { throwOnError: true })));
  const failure = results.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

// Same-origin SSE. The browser `EventSource` can't set a bearer header, so this
// relies on the Better Auth cookie session the web already uses. Cross-session
// cache updates flow through here.
//
// The socket reconnects on its own; the *data* does not. Anything emitted while
// this tab was away is gone, because there is no durable event log to replay
// from — so every successful connect ends with a refresh, which
// `07-realtime-offline-federation.md:35` names as the authority after a
// reconnect. Without it the cache silently diverges after any blip.
export function useServerStream(userId: string) {
  const queryClient = useQueryClient();
  const origin = getServerOrigin();

  useEffect(() => {
    if (typeof window === "undefined" || userId === "anonymous") return;

    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let closed = false;
    const pagesKey = queryKeys.pages(origin, userId);
    const settingsKey = queryKeys.settings(origin, userId);
    const remindersKey = queryKeys.reminders(origin, userId);
    const tasksKey = queryKeys.tasks(origin, userId);
    const calendarsKey = queryKeys.calendars(origin, userId);
    const federatedKey = queryKeys.federated(origin, userId);
    // Event ranges share this prefix; a prefix match invalidates every window.
    const deliveryPrefix = ["delivery", origin, userId] as const;
    const eventsPrefix = ["events", origin, userId] as const;

    function applyPage(raw: unknown) {
      const parsed = PageDocumentSchema.safeParse(raw);
      if (!parsed.success) {
        void queryClient.invalidateQueries({ queryKey: pagesKey });
        return;
      }
      queryClient.setQueryData<PageDocument[]>(pagesKey, (current) =>
        upsertPageIntoList(current ?? [], parsed.data),
      );
    }

    function handleMessage(event: MessageEvent<string>) {
      let message: RealtimeMessage;
      try {
        message = JSON.parse(event.data) as RealtimeMessage;
      } catch {
        return;
      }

      const noticesKey = eventNoticeKey(origin, userId);
      const previous = queryClient.getQueryData<EventChangeNotice[]>(noticesKey) ?? [];
      const next = acceptEventNotice(previous, message, userId);
      if (next !== previous) queryClient.setQueryData(noticesKey, next);

      switch (message.type) {
        case "page_created":
        case "page_updated":
          applyPage(message.payload?.page);
          break;
        case "page_removed":
          queryClient.setQueryData<PageDocument[]>(pagesKey, (current) =>
            (current ?? []).filter((page) => page.id !== message.payload?.id),
          );
          break;
        case "settings_updated":
          void queryClient.invalidateQueries({ queryKey: settingsKey });
          break;
        // This user changed a reminder rule somewhere else. Only their own
        // connections get this frame, and refetching is what makes "an hour
        // before" set on the phone reach the tab that will actually ring.
        case "reminders_updated":
          void queryClient.invalidateQueries({ queryKey: remindersKey });
          break;
        // Something changed on a connected Musubi server. Its rows live in the
        // federation snapshot, so refetch that rather than patching local caches.
        case "federated_sync":
          void queryClient.invalidateQueries({ queryKey: deliveryPrefix });
          void queryClient.invalidateQueries({ queryKey: federatedKey });
          break;
        case "calendar_updated":
        case "calendar_removed":
          void queryClient.invalidateQueries({ queryKey: tasksKey });
          void queryClient.invalidateQueries({ queryKey: calendarsKey });
          void queryClient.invalidateQueries({ queryKey: eventsPrefix });
          void queryClient.invalidateQueries({ queryKey: deliveryPrefix });
          break;
        case "event_created":
        case "event_updated":
        case "event_removed":
        case "attendance_changed":
          void queryClient.invalidateQueries({ queryKey: eventsPrefix });
          void queryClient.invalidateQueries({ queryKey: deliveryPrefix });
          break;
        case "external_sync":
          void queryClient.resetQueries({ queryKey: ["availability", origin, userId] });
          void queryClient.invalidateQueries({ queryKey: tasksKey });
          void queryClient.invalidateQueries({ queryKey: calendarsKey });
          void queryClient.invalidateQueries({ queryKey: eventsPrefix });
          void queryClient.invalidateQueries({ queryKey: deliveryPrefix });
          break;
        default:
          break;
      }
    }

    function open() {
      if (closed) return;

      source = new EventSource(`/api/stream?clientVersion=${PRODUCT_VERSION}`);
      source.onmessage = handleMessage;

      source.onopen = () => {
        attempt = 0;
        // Also runs on the very first connect, where it costs one refetch of
        // data the queries were fetching anyway and keeps one code path.
        void refreshServerData(queryClient, userId).catch(() => undefined);
      };

      source.onerror = () => {
        // `EventSource` retries by itself, but on its own schedule and without
        // ever refreshing. Taking the socket over means one policy: our backoff,
        // and a refresh every time it comes back.
        source?.close();
        if (closed) return;
        attempt += 1;

        // A closed socket says nothing about why. An expired session looks
        // exactly like a flaky network here, and retrying that forever is the
        // loop `07-realtime-offline-federation.md:56-61` forbids — so ask once
        // who we are, and stop if the answer is nobody.
        void authClient
          .getSession()
          .then((result) => {
            if (closed) return;
            if (result.data) {
              retry = setTimeout(open, reconnectDelay(attempt));
              return;
            }
            closed = true;
            notifyAuthExpired();
          })
          .catch(() => {
            // The session request failed too, so the server is unreachable
            // rather than refusing us. Keep trying.
            if (!closed) retry = setTimeout(open, reconnectDelay(attempt));
          });
      };
    }

    function close() {
      closed = true;
      if (retry) clearTimeout(retry);
      source?.close();
      if (closeActive === close) closeActive = undefined;
    }

    open();
    closeActive = close;

    return close;
  }, [origin, queryClient, userId]);
}
