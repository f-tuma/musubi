import { Redirect, useLocalSearchParams } from 'expo-router';
import { useServer } from '@/contexts/ServerContext';

export default function Index() {
  const { authClient } = useServer();
  const { data: session } = authClient.useSession();
  // Android calendar VIEW intent (routed via +not-found) — forward the target
  // time to the home tab so the calendar opens at that date.
  const { time, calendarWidgetId } = useLocalSearchParams<{
    time?: string;
    calendarWidgetId?: string;
  }>();

  if (session) return (
    <Redirect
      href={{
        pathname: "/(tabs)",
        params: {
          ...(time ? { time } : {}),
          ...(calendarWidgetId ? { calendarWidgetId } : {}),
        },
      }}
    />
  );
  return <Redirect href="/(auth)/welcome" />;
}
