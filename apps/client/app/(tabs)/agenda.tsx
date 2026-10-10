import { Redirect, useLocalSearchParams } from "expo-router";

// Preserve widget and notification links while Agenda lives in Home.
export default function AgendaRoute() {
  const { eventId, occurrenceStart, widgetRefresh } = useLocalSearchParams<{ eventId?: string; occurrenceStart?: string; widgetRefresh?: string }>();
  return <Redirect href={{ pathname: "/", params: { view: "agenda", ...(eventId ? { eventId } : {}), ...(occurrenceStart ? { occurrenceStart } : {}), ...(widgetRefresh ? { widgetRefresh } : {}) } }} />;
}
