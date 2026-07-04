import { useEventsStore } from "@/store/useEventsStore";
import Constants from "expo-constants";
import { useEffect } from "react";
import EventSource from "react-native-sse";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useServer } from "@/contexts/ServerContext";

const apiUrl = Constants.expoConfig?.extra?.apiUrl;

export function useConnectToEventStream() {
  const { authClient } = useServer();
  const { localAddEvent, localUpdateEvent, localRemoveEvent, localRemoveCalendarEvents } = useEventsStore();
  const { localUpdateCalendar, localRemoveCalendar } = useCalendarsStore();

  useEffect(() => {
    let sse: EventSource;

    const connect = async () => {
      const { data } = await authClient.getSession();
      const token = data?.session?.token;
      sse = new EventSource(`${apiUrl}/api/stream`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      sse.addEventListener("message", (event) => {
        if (event.data) {
          const data = JSON.parse(event.data);

          const toEvent = (p: any) => ({ ...p, start: new Date(p.start), end: new Date(p.end) });

          switch (data.type) {
            case "event_created":
              localAddEvent(toEvent(data.payload));
              break;
            case "event_updated":
              localUpdateEvent(toEvent(data.payload));
              break;
            case "event_removed":
              localRemoveEvent(toEvent(data.payload));
              break;
            case "calendar_updated":
              localUpdateCalendar(data.payload);
              break;
            case "calendar_removed":
              localRemoveCalendar(data.payload);
              localRemoveCalendarEvents(data.payload.id);
              break;
            default:
              console.warn(`Uknown event type: ${data.type}`);
          }
        }
      });
    }
    connect();
    return () => sse?.close();
  }, []);
}
