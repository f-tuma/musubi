import { colors, fonts, styles } from "@/constants/theme";
import { CalendarWithEvents } from "@musubi/types";
import { useApi } from "@/services/api";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useServer } from "@/contexts/ServerContext";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, View, Text, StyleSheet } from "react-native";
import { Avatar } from "@/components/Avatar";
import { Btn } from "@/components/ui/Btn";
import { success } from "@/lib/haptics";
import { acceptRemoteInvite, fetchRemoteCalendarPreview } from "@/services/federation";
import { useRefreshData } from "@/hooks/useRefreshData";

export default function Invite() {
  const api = useApi();
  const { authClient, apiUrl } = useServer();
  const { loadCalendars } = useCalendarsStore();
  const { token, server } = useLocalSearchParams();
  const router = useRouter();
  const refresh = useRefreshData();

  // Cross-server invite: the link carries the calendar's origin server (the
  // invite page appends ?server=). Accepting runs the federation handshake
  // there instead of the native join here.
  const remoteServer = typeof server === "string" && server && server !== apiUrl ? server : null;

  const { data: session } = authClient.useSession();
  const [calendarData, setCalendarData] = useState<CalendarWithEvents | null>(null);
  const [isAccepting, setIsAccepting] = useState(false);

  useEffect(() => {
    const fetchCalendar = async () => {
      const data = remoteServer
        ? await fetchRemoteCalendarPreview(remoteServer, token as string)
        : await api.getCalendarFromToken(token as string);
      setCalendarData(data);
    };
    fetchCalendar();
  }, []);

  // If the current user is already a member of this calendar, skip the invite
  // screen entirely and drop them into the app. (Cross-server: members there
  // are shadow ids, so this never matches — re-accepting is conflict-safe.)
  useEffect(() => {
    if (!calendarData || !session?.user.id || remoteServer) return;
    const alreadyMember = calendarData.members.some(m => m.id === session.user.id);
    if (alreadyMember) {
      router.replace("/(tabs)");
    }
  }, [calendarData, session]);

  return (
    <View style={styles.screen}>

      <ScrollView contentContainerStyle={{ paddingBottom: 24 }} showsVerticalScrollIndicator={false}>

        <View style={local.hero}>
          <View style={{ marginBottom: 20 }}>
            <View style={[local.calendarIcon, { backgroundColor: colors.bg3, borderColor: calendarData?.color ?? colors.line2 }]}>
              <Text style={[local.calendarIconText, { color: calendarData?.color }]}>
                {calendarData?.name?.charAt(0).toUpperCase() ?? '…'}
              </Text>
            </View>
          </View>
          <Text style={[local.invitedBy, { color: colors.fg3 }]}>YOU ARE INVITED TO JOIN</Text>
          <Text style={[local.calendarName, { color: colors.fg }]}>{calendarData?.name ?? '…'}</Text>
          <Text style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.fg3 }}>{calendarData?.members?.length} members</Text>
        </View>

        {calendarData?.members?.length! > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>MEMBERS</Text>
            <View style={local.membersRow}>
              <View style={local.avatarStack}>
                {calendarData?.members?.slice(0, 4).map((m) => (
                  <View key={m.id} style={[local.avatarStackItem, { borderColor: colors.bg }]}>
                    <Avatar name={m.name} image={m.image} size={34} />
                  </View>
                ))}
                {calendarData?.members?.length! > 4 && (
                  <View style={[local.avatarStackItem, { borderColor: colors.bg }]}>
                    <View style={[local.avatar, { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.bg3, borderColor: colors.line2 }]}>
                      <Text style={[local.avatarText, { fontSize: 11, color: colors.fg2 }]}>+{calendarData?.members?.length! - 4}</Text>
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
        <Btn
          label="Decline"
          variant="secondary"
          onPress={() => {
            router.canGoBack() ? router.back() : router.replace("/(tabs)");
          }}
        />
        <Btn
          label="✓  Accept invitation"
          style={{ flex: 2 }}
          loading={isAccepting}
          onPress={async () => {
            setIsAccepting(true);
            if (remoteServer) {
              // Federation handshake on the origin server: shadow account +
              // member token; the full refresh then pulls the shared calendar.
              const { account } = await acceptRemoteInvite(remoteServer, token as string, {
                name: session?.user.name ?? "Musubi user",
                email: session?.user.email ?? "",
                image: session?.user.image ?? null,
                homeServer: apiUrl!,
              });
              // Persist the connection on the HOME server so every signed-in
              // device inherits it. Best-effort: if it fails, this device still
              // works from its local registry.
              try { await api.saveMusubiAccount(account); }
              catch (e) { console.warn("Storing the federated connection on the home server failed:", e); }
              await refresh();
            } else {
              await api.acceptInvite(calendarData?.id!, token as string);
              loadCalendars(await api.getCalendars());
            }
            success();
            router.canGoBack() ? router.back() : router.replace("/(tabs)");
          }}
        />
      </View>
    </View>
  );
}

const local = StyleSheet.create({
  hero: {
    alignItems: 'center',
    paddingTop: 36,
    paddingBottom: 28,
    paddingHorizontal: 24,
  },
  // colors applied inline — the theme can swap at runtime
  calendarIcon: {
    width: 88,
    height: 88,
    borderRadius: 44,
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
    marginBottom: 8,
  },
  calendarName: {
    fontFamily: fonts.serif,
    fontSize: 34,
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
    borderRadius: 20,
  },
  avatar: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  avatarText: {
    fontFamily: fonts.sansMedium,
  },
});
