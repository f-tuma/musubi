import { colors, fonts } from '@/constants/theme';
import { useConnectToEventStream } from '@/hooks/useEventsStream';
import { useApi } from '@/services/api';
import { useCalendarsStore } from '@/store/useCalendarsStore';
import { useEventsStore } from '@/store/useEventsStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { Feather } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';


export default function TabLayout() {
  const api = useApi();
  const { loadSettings } = useSettingsStore();
  const { loadCalendars } = useCalendarsStore();
  const { loadEvents } = useEventsStore();

  useEffect(() => {
    const fetch = async () => {
      try {
        loadSettings(await api.getSettings());
        loadCalendars(await api.getCalendars());
        loadEvents(await api.getEvents());
      } catch {
        console.error("Could not fetch calendars and events...");
      }
    };
    fetch();
  }, [])

  useConnectToEventStream();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Tabs
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
        }}
        />
        <Tabs.Screen name="calendars" options={{
          title: "Calendars",
          headerShown: false,
          tabBarIcon: ({ color }) => <Feather size={20} name='layers' color={color} />,
        }}
        />
        <Tabs.Screen name="agenda" options={{
          title: "Agenda",
          headerShown: false,
          tabBarIcon: ({ color }) => <Feather size={20} name='list' color={color} />,
        }}
        />
        <Tabs.Screen name="settings" options={{
          title: "Settings",
          headerShown: false,
          tabBarIcon: ({ color }) => <Feather size={20} name='settings' color={color} />,
        }}
        />
      </Tabs>
    </GestureHandlerRootView>
  );
}
