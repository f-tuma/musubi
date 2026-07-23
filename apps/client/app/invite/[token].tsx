import { colors, fonts, styles } from "@/constants/theme";
import { CalendarWithEvents } from "@musubi/types";
import { expandRecurringEvents } from "@musubi/calendar";
import { useApi } from "@/services/api";
import { useServer } from "@/contexts/ServerContext";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, View, Text, StyleSheet } from "react-native";
import { Avatar } from "@/components/Avatar";
import { Btn } from "@/components/ui/Btn";
import { success, warn } from "@/lib/haptics";
import { acceptRemoteInvite, fetchRemoteCalendarPreview } from "@/services/federation";
import { useRefreshData } from "@/hooks/useRefreshData";
import { Feather } from "@expo/vector-icons";
import { userFacingError } from "@/lib/network";
import { showToast } from "@/components/ui/Toast";
import { rememberPendingInvite } from "@/lib/pendingInvite";

// How far ahead the "WHAT'S ON IT" preview looks.
const PREVIEW_WINDOW_DAYS = 30;

export default function Invite() {
  const api = useApi();
  const { authClient, apiUrl } = useServer();
  const { token, server, afterAuth } = useLocalSearchParams<{
    token?: string | string[];
    server?: string | string[];
    afterAuth?: string | string[];
  }>();
  const router = useRouter();
  const refresh = useRefreshData();
  const inviteToken = typeof token === "string" ? token : token?.[0];
  const inviteServer = typeof server === "string" ? server : server?.[0];
  const restoredAfterAuth = afterAuth === "1" || (Array.isArray(afterAuth) && afterAuth[0] === "1");

  // Cross-server invite: the link carries the calendar's origin server (the
  // invite page appends ?server=). Accepting runs the federation handshake
  // there instead of the native join here.
  const remoteServer = inviteServer && inviteServer !== apiUrl ? inviteServer : null;

  const { data: session, isPending: isSessionPending } = authClient.useSession();
  const [calendarData, setCalendarData] = useState<CalendarWithEvents | null>(null);
  const [isAccepting, setIsAccepting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [acceptError, setAcceptError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  // A calendar preview is private. Remember the invite before leaving this
  // route, then continue exactly where the user started after authentication.
  useEffect(() => {
    if (isSessionPending || session || restoredAfterAuth || !inviteToken) return;
    let cancelled = false;
    rememberPendingInvite({
      token: inviteToken,
      ...(inviteServer ? { server: inviteServer } : {}),
    })
      .catch(error => console.warn("Could not remember the invitation:", error))
      .finally(() => {
        if (!cancelled) router.replace("/(auth)/welcome");
      });
    return () => { cancelled = true; };
  }, [isSessionPending, session, restoredAfterAuth, inviteToken, inviteServer, router]);

  useEffect(() => {
    if (!session || !inviteToken) return;
    let cancelled = false;
    const fetchCalendar = async () => {
      setIsLoading(true);
      setLoadError("");
      try {
        const data = remoteServer
          ? await fetchRemoteCalendarPreview(remoteServer, inviteToken)
          : await api.getCalendarFromToken(inviteToken);
        if (!cancelled) setCalendarData(data);
      } catch (error) {
        if (!cancelled) {
          setCalendarData(null);
          setLoadError(userFacingError(error, "This invitation could not be loaded."));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    fetchCalendar();
    return () => { cancelled = true; };
    // `api` is intentionally omitted: useApi returns a fresh facade each render.
  }, [session, remoteServer, inviteToken, loadAttempt]);

  // If the current user is already a member of this calendar, skip the invite
  // screen entirely and drop them into the app. (Cross-server: members there
  // are shadow ids, so this never matches — re-accepting is conflict-safe.)
  useEffect(() => {
    if (!calendarData || !session?.user.id || remoteServer) return;
    const alreadyMember = calendarData.members.some(m => m.id === session.user.id);
    if (alreadyMember) {
      router.replace("/(tabs)");
    }
  }, [calendarData, session, remoteServer, router]);

  // The server sends raw events — expand recurrences into real occurrences
  // (a daily event previews as separate days, like the agenda) and sort.
  const previewEvents = useMemo(() => {
    if (!calendarData?.events) return [];
    const from = new Date();
    const to = new Date(from.getTime() + PREVIEW_WINDOW_DAYS * 86400_000);
    return expandRecurringEvents(calendarData.events, from, to)
      .sort((a, b) => a.start.getTime() - b.start.getTime());
  }, [calendarData]);

  const closeInvite = () => {
    if (restoredAfterAuth || !router.canGoBack()) router.replace("/(tabs)");
    else router.back();
  };

  if (isSessionPending || !session) return null;

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
          {isLoading ? (
            <ActivityIndicator size="small" color={colors.fg3} style={{ marginTop: 6 }} />
          ) : loadError ? (
            <View style={[local.errorCard, { borderColor: colors.line2, backgroundColor: colors.bg1 }]}>
              <Feather name="wifi-off" size={18} color={colors.accent} />
              <Text style={[local.errorText, { color: colors.fg2 }]}>{loadError}</Text>
              <Btn label="Try again" variant="secondary" onPress={() => setLoadAttempt(v => v + 1)} />
            </View>
          ) : (
            <Text style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.fg3 }}>{calendarData?.members?.length} members</Text>
          )}
        </View>

        {!loadError && calendarData?.members?.length! > 0 && (
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

        {!loadError && previewEvents.length > 0 && <View style={styles.section}>
          <Text style={styles.sectionLabel}>WHAT&apos;S ON IT</Text>
          {previewEvents.map((event) => (
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
        </View>}

      </ScrollView>

      {!!acceptError && <Text style={[local.acceptError, { color: colors.accent }]}>{acceptError}</Text>}
      <View style={styles.screenActions}>
        <Btn
          label="Decline"
          variant="secondary"
          onPress={closeInvite}
        />
        <Btn
          label="✓  Accept invitation"
          style={{ flex: 2 }}
          loading={isAccepting}
          disabled={!calendarData || isLoading || !!loadError}
          onPress={async () => {
            setIsAccepting(true);
            setAcceptError("");
            try {
              if (remoteServer) {
                // Federation handshake on the origin server: shadow account +
                // member token; the full refresh then pulls the shared calendar.
                const { account } = await acceptRemoteInvite(remoteServer, inviteToken!, {
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
              } else {
                await api.acceptInvite(calendarData!.id, inviteToken!);
              }

              // Acceptance already succeeded. A failed follow-up sync must not
              // leave the user thinking it did not; cached data catches up later.
              try { await refresh(remoteServer ? undefined : { full: true }); }
              catch (e) {
                console.warn("Post-invite refresh failed:", e);
                showToast({ message: "Invitation accepted — calendars will sync when you are back online." });
              }
              success();
              closeInvite();
            } catch (error) {
              warn();
              setAcceptError(userFacingError(error, "The invitation could not be accepted."));
            } finally {
              setIsAccepting(false);
            }
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
  errorCard: {
    width: "100%",
    alignItems: "center",
    gap: 12,
    marginTop: 18,
    padding: 18,
    borderWidth: 1,
    borderRadius: 14,
  },
  errorText: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 19,
    textAlign: "center",
  },
  acceptError: {
    fontFamily: fonts.sans,
    fontSize: 12,
    textAlign: "center",
    paddingHorizontal: 20,
    paddingVertical: 8,
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
