import { useTaskRefreshStore } from "@/store/useTaskRefreshStore";
import { useDeliveryRefreshStore } from "@/store/useDeliveryRefreshStore";
import { useEventsStore } from "@/store/useEventsStore";
import { CLIENT_VERSION_HEADER, PRODUCT_VERSION } from "@musubi/types";
import { useEffect, useRef } from "react";
import EventSource from "react-native-sse";
import * as Network from "expo-network";
import { recordServerDiagnostic } from "@/lib/serverDiagnostics";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useAttendeesStore } from "@/store/useAttendeesStore";
import { useServer } from "@/contexts/ServerContext";
import { useRefreshData } from "@/hooks/useRefreshData";
import { serializeEventRefresh } from "@/lib/eventSync";

export function useConnectToEventStream() {
  // apiUrl comes from ServerContext (SecureStore-backed, self-host aware) — the
  // same origin every other request uses, so the SSE stream tracks a custom
  // server URL too.
  const { authClient, apiUrl } = useServer();
  const {
    localAddEvent,
    localUpdateEvent,
    localRemoveEvent,
    localRemoveCalendarEvents,
  } = useEventsStore();
  const { localUpdateCalendar, localRemoveCalendar } = useCalendarsStore();
  const setAttendees = useAttendeesStore((s) => s.setAttendees);
  // "external_sync" = the server's scheduled provider sync found changes → run a
  // silent delta refresh (WITHOUT re-triggering the provider sync — that'd loop).
  // Ref so the SSE effect doesn't resubscribe every render. Refreshes from all
  // hook instances share one queue, so reconnect catch-up cannot race launch.
  const refresh = useRefreshData();
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  const silentRefresh = async (full = false) => {
    useDeliveryRefreshStore.getState().refresh();
    useTaskRefreshStore.getState().refresh();
    try {
      await refreshRef.current({ providerSync: false, full });
    } catch (e) {
      console.warn("SSE-triggered refresh failed:", e);
    }
  };
  const applyLiveMutation = (mutation: () => void | Promise<void>) => {
    void serializeEventRefresh(async () => {
      await mutation();
    }).catch((e) => console.warn("SSE event apply failed:", e));
  };

  // Offline → online (airplane mode off, wifi back): sync right away instead
  // of waiting out the SSE retry cycle. Refs only inside — mount-once is safe.
  useEffect(() => {
    let wasOffline = false;
    const sub = Network.addNetworkStateListener(
      ({ isConnected, isInternetReachable }) => {
        const offline = isConnected === false || isInternetReachable === false;
        if (wasOffline && !offline) silentRefresh(true);
        wasOffline = offline;
      },
    );
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!apiUrl) return;
    const sources: EventSource[] = [];
    let cancelled = false;

    const handleMessage = (event: { data?: string | null }) => {
      if (!event.data) return;
      let data: any;
      try {
        data = JSON.parse(event.data);
      } catch {
        console.warn("Ignoring malformed SSE message.");
        return;
      }

      if (["event_created", "event_updated", "event_removed", "calendar_updated", "calendar_removed"].includes(data.type))
        useDeliveryRefreshStore.getState().refresh();

      const toEvent = (p: any) => ({
        ...p,
        start: new Date(p.start),
        end: new Date(p.end),
      });

      switch (data.type) {
        case "task_created":
        case "task_updated":
        case "task_removed":
          useTaskRefreshStore.getState().refresh();
          break;
        case "event_created":
          applyLiveMutation(() => localAddEvent(toEvent(data.payload)));
          break;
        case "event_updated":
          applyLiveMutation(() => localUpdateEvent(toEvent(data.payload)));
          break;
        case "event_removed":
          if (
            !Number.isSafeInteger(data.payload?.revision) ||
            data.payload.revision < 1
          ) {
            // An access-loss frame may refer to an already purged row. Reconcile
            // authoritatively instead of evicting a possibly newer cached event.
            silentRefresh(true);
          } else
            applyLiveMutation(() => localRemoveEvent(toEvent(data.payload)));
          break;
        case "calendar_updated":
          useTaskRefreshStore.getState().refresh();
          applyLiveMutation(() => {
            localUpdateCalendar(data.payload);
          });
          break;
        case "calendar_removed":
          useTaskRefreshStore.getState().refresh();
          applyLiveMutation(async () => {
            localRemoveCalendar(data.payload);
            await localRemoveCalendarEvents(data.payload.id);
          });
          break;
        case "attendance_changed":
          setAttendees(data.payload.eventID, data.payload.attendees);
          break;
        case "external_sync":
          silentRefresh();
          break;
        case "settings_updated":
          refreshRef
            .current({ settingsOnly: true })
            .catch((e) => console.warn("Settings refresh failed:", e));
          break;
        // Another device of this user changed a reminder rule. Only that user's
        // own connections receive it, and rescheduling is the whole point:
        // "remind me an hour before" set on the laptop has to reach the phone
        // that will actually ring.
        case "reminders_updated":
          silentRefresh();
          break;
        // A connected Musubi server changed something; the home server relays it
        // (ADR-005). Remote rows are pulled per server, so refresh rather than
        // patching a payload from a foreign origin into the local stores.
        case "federated_sync":
          silentRefresh();
          break;
        default:
          console.warn(`Uknown event type: ${data.type}`);
      }
    };

    const subscribe = (url: string, token: string) => {
      const sse = new EventSource(`${url}/api/stream`, {
        headers: {
          Authorization: `Bearer ${token}`,
          [CLIENT_VERSION_HEADER]: PRODUCT_VERSION,
        },
      });
      // The library auto-reconnects every pollingInterval (5s) after an error or
      // clean stream end. Every open after the first catches up lost frames.
      // ponytail: full home snapshot; add link tombstones if this becomes costly.
      let opened = false;
      let disconnected = false;
      // Written into the same ring buffer the request log reads. A stream that
      // opens and never delivers looks exactly like a quiet calendar, and the
      // diagnostics screen had no way to tell those apart.
      sse.addEventListener("error", () => {
        if (!disconnected) recordServerDiagnostic("× SSE /api/stream");
        disconnected = true;
      });
      sse.addEventListener("open", () => {
        recordServerDiagnostic("← SSE /api/stream");
        if (opened || disconnected) silentRefresh(true);
        opened = true;
        disconnected = false;
      });
      sse.addEventListener("message", handleMessage);
      sources.push(sse);
    };

    // One stream, to the home server. Federated servers used to get a stream
    // each (member token as bearer); since ADR-005 the home server subscribes to
    // them on our behalf and relays their events as `federated_sync`, so remote
    // calendars stay live without this device holding a credential — and a
    // freshly accepted server starts streaming immediately instead of on the
    // next app start.
    const connect = async () => {
      const { data } = await authClient.getSession();
      const token = data?.session?.token;
      if (cancelled || !token) return;
      subscribe(apiUrl, token);
    };
    connect();
    return () => {
      cancelled = true;
      sources.forEach((s) => s.close());
    };
  }, [apiUrl, authClient]);
}
