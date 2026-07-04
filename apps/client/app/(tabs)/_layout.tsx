import { colors, fonts } from '@/constants/theme';
import { LoadingOverlay } from '@/components/LoadingOverlay';
import { useServer } from '@/contexts/ServerContext';
import { useConnectToEventStream } from '@/hooks/useEventsStream';
import { Feather } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useRefreshData } from '@/hooks/useRefreshData';
import { useEventsStore } from '@/store/useEventsStore';
import { useCalendarsStore } from '@/store/useCalendarsStore';
import { cacheGetAllEvents, cacheGetCalendars } from '@/services/eventsCache';
import { select } from '@/lib/haptics';


export default function TabLayout() {
  const { apiUrl, isLoading } = useServer();
  const refresh = useRefreshData();
  const { loadEvents } = useEventsStore();
  const { loadCalendars } = useCalendarsStore();
  const [dataReady, setDataReady] = useState(false);

  useEffect(() => {
    // Server context is still hydrating — keep overlay visible
    if (isLoading) return;

    // No server URL configured — show the app empty rather than loading forever
    if (!apiUrl) {
      setDataReady(true);
      return;
    }

    const load = async () => {
      try {
        // instant render from the local cache (calendars too, so activeCals is
        // populated and events aren't filtered out), then sync over the network
        const [cachedCals, cachedEvents] = await Promise.all([cacheGetCalendars(), cacheGetAllEvents()]);
        loadCalendars(cachedCals);
        loadEvents(cachedEvents);
        setDataReady(true);
        await refresh();
      } catch (e: any) {
        console.error("Could not fetch initial data:", e?.message, e?.status, e);
      } finally {
        setDataReady(true);
      }
    };
    load();
  }, [apiUrl, isLoading]);

  useConnectToEventStream();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Tabs
        screenListeners={{ tabPress: () => select() }}
        screenOptions={{
          tabBarStyle: {
            backgroundColor: colors.bg1,
            borderTopColor: colors.line,
            borderTopWidth: 1,
            height: 70,
          },
          tabBarItemStyle: {
            paddingVertical: 5,
          },
          tabBarActiveTintColor: colors.fg,
          tabBarInactiveTintColor: colors.fg3,
          tabBarLabelStyle: {
            fontFamily: fonts.sans,
            fontSize: 10,
            letterSpacing: 0.4,
          },
          headerShown: false,
        }}
      >
        <Tabs.Screen name="index" options={{
          title: "Home",
          headerShown: false,
          tabBarIcon: ({ color }) => <Feather size={20} name='calendar' color={color} />,
        }} />
        <Tabs.Screen name="calendars" options={{
          title: "Calendars",
          headerShown: false,
          tabBarIcon: ({ color }) => <Feather size={20} name='layers' color={color} />,
        }} />
        <Tabs.Screen name="agenda" options={{
          title: "Agenda",
          headerShown: false,
          tabBarIcon: ({ color }) => <Feather size={20} name='list' color={color} />,
        }} />
        <Tabs.Screen name="settings" options={{
          title: "Settings",
          headerShown: false,
          tabBarIcon: ({ color }) => <Feather size={20} name='settings' color={color} />,
        }} />
      </Tabs>

      <LoadingOverlay ready={dataReady} />
    </GestureHandlerRootView>
  );
}
