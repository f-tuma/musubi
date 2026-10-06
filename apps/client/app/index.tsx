import { Redirect, useLocalSearchParams } from 'expo-router';
import { useServer } from '@/contexts/ServerContext';

export default function Index() {
  const { authClient } = useServer();
  const { data: session } = authClient.useSession();
  // Preserve native widget actions when a cold start lands on the root route.
  const { time, calendarWidgetId, view, eventId, occurrenceStart, widgetAdd, widgetRefresh } = useLocalSearchParams<{
    time?: string;
    calendarWidgetId?: string;
    view?: string;
    eventId?: string;
    occurrenceStart?: string;
    widgetAdd?: string;
    widgetRefresh?: string;
  }>();

  if (session) return (
    <Redirect
      href={{
        pathname: "/(tabs)",
        params: {
          ...(time ? { time } : {}),
          ...(calendarWidgetId ? { calendarWidgetId } : {}),
          ...(view ? { view } : {}),
          ...(eventId ? { eventId } : {}),
          ...(occurrenceStart ? { occurrenceStart } : {}),
          ...(widgetAdd ? { widgetAdd } : {}),
          ...(widgetRefresh ? { widgetRefresh } : {}),
        },
      }}
    />
  );
  return <Redirect href="/(auth)/welcome" />;
}
