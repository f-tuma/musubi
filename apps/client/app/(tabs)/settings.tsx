import { SettingRowOptions, SettingRowToggle } from "@/components/SettingRow";
import InputModal from "@/components/TextInputModal";
import { colors, fonts, styles } from "@/constants/theme";
import { CalendarView, Settings } from "@musubi/types";
import { useServer } from "@/contexts/ServerContext";
import { useApi } from "@/services/api";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useEventsStore } from "@/store/useEventsStore";
import { useSettingsStore } from "@/store/useSettingsStore";
import { router } from "expo-router";
import { useState } from "react";
import { View, Text, ScrollView, RefreshControl, StyleSheet } from "react-native";
import { useRefreshData } from "@/hooks/useRefreshData";
import { Btn } from "@/components/ui/Btn";
import { warn } from "@/lib/haptics";
import { Avatar } from "@/components/Avatar";
import { GoogleSignin } from "@react-native-google-signin/google-signin";
import { cacheClearAll } from "@/services/eventsCache";

// Clear the natively-cached Google account so the next sign-in shows the account
// picker again instead of silently reusing the last account.
const clearGoogleSession = async () => {
  try { await GoogleSignin.signOut(); } catch { /* not signed in via Google */ }
};


export default function SettingsTab() {
  const api = useApi();
  const { authClient, apiUrl } = useServer();
  const { loadCalendars } = useCalendarsStore();
  const { loadEvents } = useEventsStore();
  const {
    defaultCalendarView, setDefaultCalendarView,
    weekStartsOn, setWeekStartsOn,
    showKanji, setShowKanji,
    notificationsOnByDefault, setNotificationsOnByDefault,
    timeLocale, setTimeLocale,
    theme, setTheme,
  } = useSettingsStore();

  const [confrimDeleteVisible, setConfirmDeleteVisible] = useState(false);
  const userSession = authClient.useSession();

  const refresh = useRefreshData();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => {
    setRefreshing(true);
    try { await refresh(); } catch (e) { console.error(e); }
    finally { setRefreshing(false); }
  };

  // Autosave: settings persist the moment they change — no Save button to forget.
  // `patch` carries the just-changed value (store reads here would be stale).
  const save = (patch: Partial<Settings>) => {
    api.saveSettings({
      showKanji, notificationsOnByDefault, defaultCalendarView, weekStartsOn, timeLocale, theme,
      ...patch,
    }).catch((e) => { warn(); console.error("Settings save failed:", e); });
  };

  const handleSignOut = async () => {
    loadCalendars([]);
    loadEvents([]);
    await cacheClearAll();
    await clearGoogleSession();
    await authClient.signOut(); // must finish before next sign-in, else B links onto A's session
    router.replace('/(auth)/welcome');
  };

  const handleUserDelete = async () => {
    loadCalendars([]);
    loadEvents([]);
    await api.deleteUser();
    await cacheClearAll();
    await clearGoogleSession();
    await authClient.signOut();
    router.replace('/(auth)/welcome');
  }

  const testDeleteConfirm = async (v: string) => {
    if (v === userSession.data?.user.name!) {
      return { ok: true, error: "" }
    }
    return { ok: false, error: "Name does not match..." }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={{ fontFamily: fonts.serif, fontSize: 26, color: colors.fg }}>
          Settings
        </Text>
      </View>
      <ScrollView refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {/* Who you are — identity, not a form. */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14, padding: 20, borderBottomWidth: 1, borderColor: colors.line }}>
          <Avatar name={userSession.data?.user.name ?? "?"} image={userSession.data?.user.image} size={52} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontFamily: fonts.serif, fontSize: 19, color: colors.fg }}>
              {userSession.data?.user.name}
            </Text>
            <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg3 }}>
              {userSession.data?.user.email}
            </Text>
            <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.fg4 }}>
              {apiUrl?.slice(8)}
            </Text>
          </View>
        </View>

        <Text style={[styles.sectionLabel, local.sectionHeading]}>Appearance</Text>
        <SettingRowOptions
          label="Theme"
          value={theme}
          options={["system", "dark", "light"]}
          onChange={v => {
            setTheme(v as "system" | "dark" | "light");
            save({ theme: v as "system" | "dark" | "light" });
          }}
        />
        <SettingRowToggle
          label="Show Kanji"
          toggle={showKanji}
          onToggle={() => {
            setShowKanji(!showKanji);
            save({ showKanji: !showKanji });
          }}
        />
        <SettingRowOptions
          label="Default View"
          value={defaultCalendarView}
          options={["month", "week", "day"]}
          onChange={v => {
            setDefaultCalendarView(v as CalendarView);
            save({ defaultCalendarView: v as CalendarView });
          }}
        />
        <SettingRowOptions
          label="Week Starts on"
          value={weekStartsOn}
          options={["sunday", "monday"]}
          onChange={v => {
            setWeekStartsOn(v as "monday" | "sunday");
            save({ weekStartsOn: v as "monday" | "sunday" });
          }}
        />
        <SettingRowOptions
          label="Time Locale"
          value={timeLocale}
          options={["cs-CZ", "en-UK"]}
          onChange={v => {
            setTimeLocale(v as "en-UK" | "cs-CZ");
            save({ timeLocale: v as "en-UK" | "cs-CZ" });
          }}
        />

        <Text style={[styles.sectionLabel, local.sectionHeading]}>Notifications</Text>
        <SettingRowToggle
          label="On by Default"
          toggle={notificationsOnByDefault}
          onToggle={() => {
            setNotificationsOnByDefault(!notificationsOnByDefault);
            save({ notificationsOnByDefault: !notificationsOnByDefault });
          }}
        />

        <Text style={[styles.sectionLabel, local.sectionHeading]}>Account</Text>
        <View style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 10 }}>
          <Btn label="Sign Out" variant="secondary" onPress={handleSignOut} />
        </View>
        {/* Danger stays visually apart from everything else. */}
        <View style={{ marginTop: 24, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32, borderTopWidth: 1, borderColor: colors.line }}>
          <Btn
            label="Delete Account"
            variant="destructive"
            onPress={() => setConfirmDeleteVisible(true)}
          />
        </View>
      </ScrollView >
      <InputModal
        visible={confrimDeleteVisible}
        title="To delete your account, write you name..."
        placeholder={userSession.data?.user.name!}
        onClose={() => setConfirmDeleteVisible(false)}
        onTest={(value) => testDeleteConfirm(value)}
        onConfirm={handleUserDelete}
      />
    </View >
  );
}

const local = StyleSheet.create({
  sectionHeading: {
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 8,
  },
});
