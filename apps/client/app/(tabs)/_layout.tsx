import { colors, fonts } from '@/constants/theme';
import { TAB_BAR_ITEM_HEIGHT, TAB_BAR_LABEL_FONT_SIZE, TAB_BAR_TOP_INSET, tabBarBottomInset, tabBarHeight } from '@/constants/layout';
import { LoadingOverlay } from '@/components/LoadingOverlay';
import { useServer } from '@/contexts/ServerContext';
import { useConnectToEventStream } from '@/hooks/useEventsStream';
import { Feather } from '@expo/vector-icons';
import { Tabs, router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getOnboardingRoute } from '@/lib/onboardingState';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useRefreshData } from '@/hooks/useRefreshData';
import { useNotificationActions } from '@/hooks/useNotificationActions';
import { getEventLifecycle, useEventsStore } from '@/store/useEventsStore';
import { useCalendarsStore } from '@/store/useCalendarsStore';
import { cacheGetAllEvents, cacheGetCalendars, getLastSync } from '@/services/eventsCache';
import { select } from '@/lib/haptics';
import { onSessionExpired, signOutAndReset } from '@/lib/signOut';
import { GlobalEventModals } from '@/components/calendar/GlobalEventModals';
import { startAgendaWidgetSync } from '@/services/agendaWidget';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApi } from '@/services/api';
import { refreshTasks, startTaskCollectionSync, taskCollectionScope } from '@/services/taskCollection';
import { widgetCalendarsLoaded, widgetEventsFailed, widgetEventsLoaded } from '@/store/useWidgetDataStore';
import { AppState } from 'react-native';


export default function TabLayout() {
  const { apiUrl, authClient } = useServer();
  const actorId = authClient.useSession().data?.user.id;
  const scope = taskCollectionScope(apiUrl, actorId);
  const api = useApi();
  const apiRef = useRef(api);
  useEffect(() => { apiRef.current = api; }, [api]);
  const insets = useSafeAreaInsets();
  const tabBarLabels = useSettingsStore(s => s.tabBarLabels);
  const bottomInset = tabBarBottomInset(insets.bottom, tabBarLabels);

  // Expired session → any API call 401s → run the full sign-out flow once and
  // land on welcome, instead of every screen failing silently.
  useEffect(() => onSessionExpired(() => {
    signOutAndReset(authClient).catch(e => console.warn("Session expiry recovery failed:", e));
  }), [authClient]);
  const refresh = useRefreshData();
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);
  // Registers the reminder buttons and what they do. Here rather than deeper in
  // the tree because the app can be launched cold by a notification.
  useNotificationActions();
  const { loadEvents } = useEventsStore();
  const { loadCalendars } = useCalendarsStore();
  const [dataReady, setDataReady] = useState(false);

  useEffect(() => {
    const lifecycle = getEventLifecycle();
    let cancelled = false;
    const isCurrent = () => !cancelled && lifecycle === getEventLifecycle();
    const load = async () => {
      try {
        // instant render from the local cache (calendars too, so activeCals is
        // populated and events aren't filtered out), then sync over the network
        const [calendarRead, eventRead, syncRead] = await Promise.allSettled([cacheGetCalendars(), cacheGetAllEvents(), getLastSync()]);
        if (!isCurrent()) return;
        const synced = syncRead.status === 'fulfilled' && syncRead.value ? new Date(syncRead.value).getTime() : NaN;
        const knownCache = Number.isFinite(synced)
          || (calendarRead.status === 'fulfilled' && calendarRead.value.length > 0)
          || (eventRead.status === 'fulfilled' && eventRead.value.length > 0);
        if (calendarRead.status === 'fulfilled') {
          loadCalendars(calendarRead.value);
          if (knownCache) widgetCalendarsLoaded();
          if (eventRead.status === 'fulfilled') {
            loadEvents(eventRead.value);
            if (knownCache) widgetEventsLoaded(Number.isFinite(synced) ? synced : null);
          }
        }
        for (const read of [calendarRead, eventRead, syncRead])
          if (read.status === 'rejected') throw read.reason;
        setDataReady(true);
      } catch (e: any) {
        if (isCurrent()) {
          widgetEventsFailed();
          console.error("Could not hydrate initial data:", e?.message, e?.status, e);
        }
      }
      try {
        if (isCurrent()) await refreshRef.current({ full: true });
      } catch (e: any) {
        if (isCurrent()) console.error("Could not fetch initial data:", e?.message, e?.status, e);
      } finally {
        if (isCurrent()) setDataReady(true);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [apiUrl, actorId, loadCalendars, loadEvents]);

  useConnectToEventStream();

  // A failed cache read may release the screen overlay, but it cannot publish
  // an empty native snapshot. The widget service owns that separate readiness.
  useEffect(() => {
    if (!scope) return;
    const stopTasks = startTaskCollectionSync(scope, apiRef.current);
    const stopWidget = startAgendaWidgetSync(scope);
    return () => { stopWidget(); stopTasks(); };
  }, [scope]);

  useEffect(() => {
    const lifecycle = getEventLifecycle();
    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active' || lifecycle !== getEventLifecycle()) return;
      // Either endpoint can recover independently; an event error must not
      // prevent a healthy task refresh with the Tasks tab unopened.
      void Promise.allSettled([
        refreshRef.current({ providerSync: false, full: true }),
        refreshTasks(scope, apiRef.current),
      ]).then(results => {
        if (lifecycle !== getEventLifecycle()) return;
        for (const result of results)
          if (result.status === 'rejected') console.warn('Foreground refresh failed:', result.reason);
      });
    });
    return () => sub.remove();
  }, [scope]);

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
            height: tabBarHeight(insets.bottom, tabBarLabels),
            paddingTop: TAB_BAR_TOP_INSET,
            paddingBottom: bottomInset,
          },
          tabBarItemStyle: {
            height: TAB_BAR_ITEM_HEIGHT,
            paddingVertical: 0,
          },
          tabBarShowLabel: tabBarLabels,
          tabBarLabelStyle: { fontFamily: fonts.sans, fontSize: TAB_BAR_LABEL_FONT_SIZE },
          tabBarActiveTintColor: colors.fg,
          tabBarInactiveTintColor: colors.fg3,
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
        <Tabs.Screen name="agenda" options={{ href: null }} />
        <Tabs.Screen name="tasks" options={{
          title: "Tasks",
          headerShown: false,
          tabBarIcon: ({ color }) => <Feather size={20} name='check-square' color={color} />,
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
