import { colors, fonts } from '@/constants/theme';
import { LoadingOverlay } from '@/components/LoadingOverlay';
import { useServer } from '@/contexts/ServerContext';
import { useConnectToEventStream } from '@/hooks/useEventsStream';
import { Feather } from '@expo/vector-icons';
import { Tabs, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getOnboardingRoute } from '@/lib/onboardingState';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useRefreshData } from '@/hooks/useRefreshData';
import { useEventsStore } from '@/store/useEventsStore';
import { useCalendarsStore } from '@/store/useCalendarsStore';
import { cacheGetAllEvents, cacheGetCalendars } from '@/services/eventsCache';
import { select } from '@/lib/haptics';
import { onSessionExpired, signOutAndReset } from '@/lib/signOut';
import { GlobalEventModals } from '@/components/calendar/GlobalEventModals';
import { startAgendaWidgetSync } from '@/services/agendaWidget';


export default function TabLayout() {
  const { apiUrl, isLoading, authClient } = useServer();

  // Expired session → any API call 401s → run the full sign-out flow once and
  // land on welcome, instead of every screen failing silently.
  useEffect(() => onSessionExpired(() => {
    signOutAndReset(authClient).catch(e => console.warn("Session expiry recovery failed:", e));
  }), [authClient]);
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

  // The native Android widget reads a compact persistent snapshot rather than
  // depending on a live React process. Start only after the cache hydrate so a
  // cold launch never replaces the last useful widget data with an empty store.
  useEffect(() => {
    if (!dataReady) return;
    return startAgendaWidgetSync();
  }, [dataReady]);

  // First sign-in (any method incl. Google): settings arrive with
  // onboarded=false → hand over to onboarding, resuming at the last step the
  // user reached (an OAuth connect round-trip lands back here mid-flow).
  const onboarded = useSettingsStore(s => s.onboarded);
  useEffect(() => {
    // `as any`: expo-router's typed routes regenerate on the next dev run
    if (dataReady && !onboarded) router.replace(getOnboardingRoute() as any);
  }, [dataReady, onboarded]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Tabs
        // Android back from any tab returns to Home first, then backgrounds —
        // instead of hiding the app immediately.
        backBehavior="initialRoute"
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

      <GlobalEventModals />
      <LoadingOverlay ready={dataReady} />
    </GestureHandlerRootView>
  );
}
