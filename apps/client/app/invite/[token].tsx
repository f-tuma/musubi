import { colors, fonts, styles } from "@/constants/theme";
import { Calendar } from "@/constants/types";
import { useApi } from "@/services/api";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, TouchableOpacity, View, Text, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

function Avatar({ label, size = 36 }: { label: string; size?: number }) {
  return (
    <View style={[local.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[local.avatarText, { fontSize: size * 0.38 }]}>{label.charAt(0).toUpperCase()}</Text>
    </View>
  );
}

export default function Invite() {
  const api = useApi();
  const { loadCalendars } = useCalendarsStore();
  const { token } = useLocalSearchParams();
  const router = useRouter();

  const [calendarData, setCalendarData] = useState<Calendar | null>(null);

  useEffect(() => {
    const fetchCalendar = async () => {
      const data = await api.getCalendarFromToken(token as string);
      setCalendarData(data);
    };
    fetchCalendar();
  }, []);

  return (
    <SafeAreaView style={styles.screen}>

      <ScrollView contentContainerStyle={{ paddingBottom: 24 }} showsVerticalScrollIndicator={false}>

        <View style={local.hero}>
          <View style={{ marginBottom: 20 }}>
            <View style={[local.calendarIcon, { borderColor: calendarData?.color ?? colors.line2 }]}>
              <Text style={[local.calendarIconText, { color: calendarData?.color }]}>
                {calendarData?.name?.charAt(0).toUpperCase() ?? '…'}
              </Text>
            </View>
          </View>
          <Text style={local.invitedBy}>YOU ARE INVITED TO JOIN</Text>
          <Text style={local.calendarName}>{calendarData?.name ?? '…'}</Text>
          <Text style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.fg3 }}>{calendarData?.members?.length} members</Text>
        </View>

        {calendarData?.members?.length! > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>MEMBERS</Text>
            <View style={local.membersRow}>
              <View style={local.avatarStack}>
                {calendarData?.members?.slice(0, 4).map((m) => (
                  <View key={m.id} style={local.avatarStackItem}>
                    <Avatar label={m.name} size={34} />
                  </View>
                ))}
                {calendarData?.members?.length! > 4 && (
                  <View style={local.avatarStackItem}>
                    <View style={[local.avatar, { width: 34, height: 34, borderRadius: 17 }]}>
                      <Text style={[local.avatarText, { fontSize: 11 }]}>+{calendarData?.members?.length! - 4}</Text>
                    </View>
                  </View>
                )}
              </View>
            </View>
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>WHAT'S ON IT</Text>
          {calendarData?.events?.map((event) => (
            <View key={event.id} style={styles.timelineRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.timelineDay}>{event.start.toLocaleString("en-UK", { day: "2-digit" })}</Text>
                <Text style={styles.timelineMonth}>{event.start.toLocaleString("en-UK", { month: "long" })}</Text>
              </View>
              <View style={{ flexDirection: 'row', flex: 4 }}>
                <View style={{ width: 1, backgroundColor: event.color ?? colors.line2, alignSelf: 'stretch' }} />
                <View style={{ paddingLeft: 16, justifyContent: 'center' }}>
                  <Text style={styles.timelineTitle}>{event.title}</Text>
                  <View style={{ flexDirection: "row", gap: 4 }}>
                    <Text style={styles.timelineMeta}>
                      {event.start.toLocaleString("en-UK", { hour: "2-digit", minute: "2-digit" })}
                    </Text>
                    <Text style={styles.timelineMeta}>-</Text>
                    <Text style={styles.timelineMeta}>
                      {event.end.toLocaleString("en-UK", { hour: "2-digit", minute: "2-digit" })}
                    </Text>
                  </View>
                </View>
              </View>
            </View>
          ))}
        </View>

      </ScrollView>

      <View style={styles.screenActions}>
        <TouchableOpacity
          style={styles.btnSecondary} onPress={() => {
            router.canGoBack() ? router.back() : router.replace("/(tabs)");
          }}
        >
          <Text style={styles.btnSecondaryText}>Decline</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btnPrimary, { flex: 2 }]}
          onPress={async () => {
            await api.acceptInvite(calendarData?.id!);
            loadCalendars(await api.getCalendars());
            router.canGoBack() ? router.back() : router.replace("/(tabs)");
          }}
        >
          <Text style={styles.btnPrimaryText}>✓  Accept invitation</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView >
  );
}

const local = StyleSheet.create({
  hero: {
    alignItems: 'center',
    paddingTop: 36,
    paddingBottom: 28,
    paddingHorizontal: 24,
  },
  calendarIcon: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: colors.bg3,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  calendarIconText: {
    fontSize: 36,
    fontFamily: fonts.serif,
  },
  invitedBy: {
    fontFamily: fonts.sansMedium,
    fontSize: 10,
    letterSpacing: 2,
    color: colors.fg3,
    marginBottom: 8,
  },
  calendarName: {
    fontFamily: fonts.serif,
    fontSize: 34,
    color: colors.fg,
    marginBottom: 6,
  },
  membersRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  avatarStack: {
    flexDirection: 'row',
  },
  avatarStackItem: {
    marginRight: -8,
    borderWidth: 2,
    borderColor: colors.bg,
    borderRadius: 20,
  },
  avatar: {
    backgroundColor: colors.bg3,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.line2,
  },
  avatarText: {
    fontFamily: fonts.sansMedium,
    color: colors.fg2,
  },
});
