import CalendarDetail from "@/components/calendar/CalendarDetailModal";
import { CalendarGroup, ReorderableCalendarList } from "@/components/calendar/ReorderableCalendarList";
import { useSettingsStore } from "@/store/useSettingsStore";
import CreateCalendarModal from "@/components/calendar/CreateCalendarModal";
import SyncCalendarModal from "@/components/calendar/SyncCalendarModal";
import { colors, fonts, styles } from "@/constants/theme";
import { Calendar, providerFlavor } from "@musubi/types";
import { useApi } from "@/services/api";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useEventsStore } from "@/store/useEventsStore";
import { Feather, Ionicons } from "@expo/vector-icons";
import { useMemo, useState } from "react";
import { Alert, RefreshControl, ScrollView, Text, View } from "react-native";
import { useRefreshData } from "@/hooks/useRefreshData";
import { Tap } from "@/components/ui/Tap";
import { Btn } from "@/components/ui/Btn";
import { Empty } from "@/components/ui/Empty";
import { confirm } from "@/lib/confirm";
import { warn } from "@/lib/haptics";


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

  const settings = useSettingsStore();
  const { calendarOrder, setCalendarOrder } = settings;

  // Group calendars: native Musubi first, then one section per connected account.
  // Rows and account groups follow the user's saved drag order; the default
  // (personal) calendar is pinned to the very top.
  const groups = useMemo<CalendarGroup[]>(() => {
    const orderIdx = (id: string) => {
      const i = calendarOrder.indexOf(id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const native: Calendar[] = [];
    const map = new Map<string, CalendarGroup>();
    const counts: Record<string, number> = {};
    for (const c of calendars) {
      if (!c.provider || !c.accountId) { native.push(c); continue; }
      const key = `${c.provider}:${c.accountId}`;
      if (!map.has(key)) {
        counts[c.provider] = (counts[c.provider] ?? 0) + 1;
        const flavor = providerFlavor(c);
        const name = flavor === "google" ? "Google" : flavor === "apple" ? "iCloud" : flavor === "caldav" ? "CalDAV" : c.provider;
        const label = c.accountLabel || `${name} Account ${counts[c.provider]}`;
        map.set(key, { key, title: label, provider: c.provider, accountId: c.accountId, calendars: [] });
      }
      map.get(key)!.calendars.push(c);
    }
    native.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0) || orderIdx(a.id) - orderIdx(b.id));
    const accounts = [...map.values()];
    for (const g of accounts) g.calendars.sort((a, b) => orderIdx(a.id) - orderIdx(b.id));
    accounts.sort((a, b) =>
      Math.min(...a.calendars.map(c => orderIdx(c.id))) - Math.min(...b.calendars.map(c => orderIdx(c.id))));
    const result: CalendarGroup[] = [];
    if (native.length) result.push({ key: "native", title: "Musubi", native: true, calendars: native });
    result.push(...accounts);
    return result;
  }, [calendars, calendarOrder]);

  // Persist a new drag order: local store first (instant), then the server.
  const persistOrder = (ids: string[]) => {
    setCalendarOrder(ids);
    api.saveSettings({
      showKanji: settings.showKanji,
      notificationsOnByDefault: settings.notificationsOnByDefault,
      defaultCalendarView: settings.defaultCalendarView,
      weekStartsOn: settings.weekStartsOn,
      timeLocale: settings.timeLocale,
      theme: settings.theme,
      onboarded: settings.onboarded,
      calendarOrder: ids,
    }).catch((e) => console.error("Order save failed:", e));
  };

  const handleOpenCalendar = (calendar: Calendar) => {
    setPrefilledCalendar(calendar);
    setCalendarDetailVisible(true);
  };

  const handleDisconnect = (provider: string, accountId: string, label: string) => {
    confirm(
      {
        title: `Disconnect ${label}?`,
        message: "Its calendars and their events will be removed from Musubi.",
        confirmLabel: "Disconnect",
      },
      async () => {
        try { await api.disconnectAccount(provider, accountId); await onRefresh(); }
        catch (e) { console.error(e); warn(); Alert.alert("Could not disconnect."); }
      },
    );
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={{ fontFamily: fonts.serif, fontSize: 26, color: colors.fg }}>
          Calendars
        </Text>
      </View>
      <View style={[styles.modalButtons, { backgroundColor: colors.bg }]}>
        <Btn
          label="Create Calendar"
          icon={<Feather size={14} name="plus" color={colors.bg3} />}
          onPress={() => setCreateModalVisible(true)}
        />
        <Btn
          label="Sync Calendar"
          variant="secondary"
          icon={<Feather size={14} name="refresh-cw" color={colors.fg2} />}
          onPress={() => setSyncModalVisible(true)}
        />
      </View>
      <ScrollView showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        <View style={{ height: 1, backgroundColor: colors.line }} />

        {calendars.length === 0 && <Empty kanji="暦" text="No calendars yet" />}

        <ReorderableCalendarList
          groups={groups}
          eventCount={eventCountByCal}
          onOpen={handleOpenCalendar}
          onDisconnect={(g) => handleDisconnect(g.provider!, g.accountId!, g.title)}
          onReorder={persistOrder}
        />
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
