import CalendarDetail from "@/components/calendar/CalendarDetailModal";
import CreateCalendarModal from "@/components/calendar/CreateCalendarModal";
import SyncCalendarModal from "@/components/calendar/SyncCalendarModal";
import { colors, fonts, styles } from "@/constants/theme";
import { Calendar, providerFlavor } from "@musubi/types";
import { useApi } from "@/services/api";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useEventsStore } from "@/store/useEventsStore";
import { Feather, Ionicons } from "@expo/vector-icons";
import { useMemo, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useRefreshData } from "@/hooks/useRefreshData";


function ProviderIcon({ provider }: { provider?: string | null }) {
  if (provider === "google") return <Ionicons name="logo-google" size={13} color={colors.fg3} />;
  if (provider === "apple") return <Ionicons name="logo-apple" size={14} color={colors.fg3} />;
  if (provider === "caldav") return <Ionicons name="cloud" size={14} color={colors.fg3} />;
  return <Feather name="calendar" size={13} color={colors.fg3} />; // native Musubi
}

export default function CalendarsTab() {
  const api = useApi();
  const { calendars, addCalendar, removeCalendar, updateCalendar } = useCalendarsStore();
  const { events } = useEventsStore();
  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [syncModalVisible, setSyncModalVisible] = useState(false);
  const [calendarDetailVisible, setCalendarDetailVisible] = useState(false);
  const [prefilledCalendar, setPrefilledCalendar] = useState<Calendar | null>(null);

  const refresh = useRefreshData();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => {
    setRefreshing(true);
    try { await refresh(); } catch (e) { console.error(e); }
    finally { setRefreshing(false); }
  };

  const eventCountByCal = useMemo(() => {
    const map: Record<string, number> = {};
    events.forEach(e => {
      e.calendars.forEach(calId => {
        map[calId] = (map[calId] ?? 0) + 1;
      });
    });
    return map;
  }, [events]);

  // Group calendars: native Musubi first, then one section per connected account.
  const { native, accounts } = useMemo(() => {
    const native: Calendar[] = [];
    const map = new Map<string, { provider: string; accountId: string; label: string; calendars: Calendar[] }>();
    const counts: Record<string, number> = {};
    for (const c of calendars) {
      if (!c.provider || !c.accountId) { native.push(c); continue; }
      const key = `${c.provider}:${c.accountId}`;
      if (!map.has(key)) {
        counts[c.provider] = (counts[c.provider] ?? 0) + 1;
        const flavor = providerFlavor(c);
        const name = flavor === "google" ? "Google" : flavor === "apple" ? "iCloud" : flavor === "caldav" ? "CalDAV" : c.provider;
        const label = c.accountLabel || `${name} Account ${counts[c.provider]}`;
        map.set(key, { provider: c.provider, accountId: c.accountId, label, calendars: [] });
      }
      map.get(key)!.calendars.push(c);
    }
    return { native, accounts: [...map.values()] };
  }, [calendars]);

  const handleOpenCalendar = (calendar: Calendar) => {
    setPrefilledCalendar(calendar);
    setCalendarDetailVisible(true);
  };

  const handleDisconnect = (provider: string, accountId: string, label: string) => {
    Alert.alert(
      `Disconnect ${label}?`,
      "Its calendars and their events will be removed from Musubi.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: async () => {
            try { await api.disconnectAccount(provider, accountId); await onRefresh(); }
            catch (e) { console.error(e); Alert.alert("Could not disconnect."); }
          },
        },
      ],
    );
  };

  const renderRow = (c: Calendar) => (
    <Pressable key={c.id} onPress={() => handleOpenCalendar(c)}>
      <View style={[styles.container, { overflow: "hidden", flexDirection: "row", justifyContent: "space-between", gap: 18 }]}>
        <View style={styles.calendarCircle}>
          <View style={[styles.calendarCircleInner, { backgroundColor: c.color }]} />
        </View>
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <Text style={{ fontFamily: fonts.sansMedium, color: colors.fg2 }}>{c.name}</Text>
          <Text style={{ fontFamily: fonts.sans, color: colors.fg3, fontSize: 10 }}>{c.members.length} members · {eventCountByCal[c.id] ?? 0} events</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <ProviderIcon provider={providerFlavor(c)} />
          <Feather name="chevron-right" size={14} color={colors.fg4} />
        </View>
      </View>
      <View style={{ height: 1, backgroundColor: colors.line }} />
    </Pressable>
  );

  const SectionHeader = ({ title, onDisconnect }: { title: string; onDisconnect?: () => void }) => (
    <Pressable
      disabled={!onDisconnect}
      onPress={onDisconnect}
      style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingVertical: 8, backgroundColor: colors.bg1 }}
    >
      <Text style={{ fontFamily: fonts.sansMedium, fontSize: 11, color: colors.fg3, letterSpacing: 0.5, textTransform: "uppercase" }}>{title}</Text>
      {onDisconnect ? <Feather name="log-out" size={13} color={colors.fg4} /> : null}
    </Pressable>
  );

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={{ fontFamily: fonts.serif, fontSize: 26, color: colors.fg }}>
          Calendars
        </Text>
      </View>
      <View style={[styles.modalButtons, { backgroundColor: colors.bg }]}>
        <Pressable style={styles.btnPrimary} onPress={() => setCreateModalVisible(true)}>
          <Feather size={14} name="plus" color={colors.bg3} />
          <Text style={styles.btnPrimaryText}>Create Calendar</Text>
        </Pressable>
        <Pressable style={styles.btnSecondary} onPress={() => setSyncModalVisible(true)}>
          <Feather size={14} name="refresh-cw" color={colors.fg2} />
          <Text style={styles.btnSecondaryText}>Sync Calendar</Text>
        </Pressable>
      </View>
      <ScrollView refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        <View style={{ height: 1, backgroundColor: colors.line }} />

        {native.length > 0 && (
          <>
            <SectionHeader title="Musubi" />
            {native.map(renderRow)}
          </>
        )}

        {accounts.map((acc) => (
          <View key={`${acc.provider}:${acc.accountId}`}>
            <SectionHeader
              title={acc.label}
              onDisconnect={() => handleDisconnect(acc.provider, acc.accountId, acc.label)}
            />
            {acc.calendars.map(renderRow)}
          </View>
        ))}
      </ScrollView>
      <CreateCalendarModal
        visible={createModalVisible}
        onCreate={(calendar) => addCalendar(calendar, api)}
        onClose={() => setCreateModalVisible(false)}
        onEdit={async (c) => { await updateCalendar(c, api); }}
      />
      <SyncCalendarModal
        visible={syncModalVisible}
        onClose={() => setSyncModalVisible(false)}
        onConnected={onRefresh}
      />
      <CalendarDetail
        calendar={prefilledCalendar}
        visible={calendarDetailVisible}
        onClose={() => setCalendarDetailVisible(false)}
        onEdit={(cal) => setPrefilledCalendar(cal)}
        onDelete={(calendar) => {
          setPrefilledCalendar(null);
          removeCalendar(calendar, api);
        }}
      />
    </View>
  );
}
