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
import { Tap } from "@/components/ui/Tap";
import { success, warn } from "@/lib/haptics";
import { Avatar } from "@/components/Avatar";
import { pickAvatarBase64 } from "@/lib/avatar";
import { Feather } from "@expo/vector-icons";
import { GoogleSignin } from "@react-native-google-signin/google-signin";
import { cacheClearAll } from "@/services/eventsCache";
import { clearAllEventNotifications } from "@/services/notifications";

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
    timeFormat, setTimeFormat,
    dateFormat, setDateFormat,
    theme, setTheme,
    onboarded,
  } = useSettingsStore();

  const [confrimDeleteVisible, setConfirmDeleteVisible] = useState(false);
  const [nameModalVisible, setNameModalVisible] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const userSession = authClient.useSession();

  const changeAvatar = async () => {
    setAvatarBusy(true);
    try {
      const base64 = await pickAvatarBase64();
      if (!base64) return; // cancelled
      const url = await api.uploadAvatar(base64);
      await authClient.updateUser({ image: url });
      success();
    } catch (e) {
      warn();
      console.error("Avatar upload failed:", e);
    } finally {
      setAvatarBusy(false);
    }
  };

  const changeName = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === userSession.data?.user.name) return;
    try {
      await authClient.updateUser({ name: trimmed });
      success();
    } catch (e) {
      warn();
      console.error("Name update failed:", e);
    }
  };

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
      showKanji, notificationsOnByDefault, defaultCalendarView, weekStartsOn, timeFormat, dateFormat, theme, onboarded,
      ...patch,
    }).catch((e) => { warn(); console.error("Settings save failed:", e); });
  };

  const handleSignOut = async () => {
    loadCalendars([]);
    loadEvents([]);
    await cacheClearAll();
    await clearAllEventNotifications();
    await clearGoogleSession();
    await authClient.signOut(); // must finish before next sign-in, else B links onto A's session
    router.replace('/(auth)/welcome');
  };

  const handleUserDelete = async () => {
    loadCalendars([]);
    loadEvents([]);
    await api.deleteUser();
    await cacheClearAll();
    await clearAllEventNotifications();
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
      <ScrollView showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {/* Who you are — tap the avatar to change the photo, tap the name to rename. */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14, padding: 20, borderBottomWidth: 1, borderColor: colors.line }}>
          <Tap onPress={changeAvatar} disabled={avatarBusy} scaleTo={0.95}>
            <View style={{ opacity: avatarBusy ? 0.5 : 1 }}>
              <Avatar name={userSession.data?.user.name ?? "?"} image={userSession.data?.user.image} size={52} />
              <View style={{
                position: "absolute", right: -3, bottom: -3,
                width: 20, height: 20, borderRadius: 10,
                backgroundColor: colors.fill, alignItems: "center", justifyContent: "center",
                borderWidth: 2, borderColor: colors.bg1,
              }}>
                <Feather name="camera" size={10} color={colors.onFill} />
              </View>
            </View>
          </Tap>
          <Tap onPress={() => setNameModalVisible(true)} scaleTo={1} style={{ flex: 1, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={{ fontFamily: fonts.serif, fontSize: 19, color: colors.fg }}>
                {userSession.data?.user.name}
              </Text>
              <Feather name="edit-2" size={12} color={colors.fg4} />
            </View>
            <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg3 }}>
              {userSession.data?.user.email}
            </Text>
            <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.fg4 }}>
              {apiUrl?.slice(8)}
            </Text>
          </Tap>
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
          label="Time Format"
          value={timeFormat}
          options={["24h", "12h"]}
          onChange={v => {
            setTimeFormat(v as "12h" | "24h");
            save({ timeFormat: v as "12h" | "24h" });
          }}
        />
        <SettingRowOptions
          label="Date Format"
          value={dateFormat}
          options={["dmy", "mdy", "ymd"]}
          labels={{ dmy: "D/M/Y", mdy: "M/D/Y", ymd: "Y-M-D" }}
          onChange={v => {
            setDateFormat(v as "dmy" | "mdy" | "ymd");
            save({ dateFormat: v as "dmy" | "mdy" | "ymd" });
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
        <View style={{ paddingHorizontal: 16, paddingBottom: 32, gap: 10 }}>
          <Btn label="Sign Out" variant="secondary" onPress={handleSignOut} />
          <Btn
            label="Delete Account"
            variant="destructive"
            onPress={() => setConfirmDeleteVisible(true)}
          />
        </View>
      </ScrollView >
      <InputModal
        visible={nameModalVisible}
        title="Display name"
        placeholder={userSession.data?.user.name ?? "Your name"}
        onClose={() => setNameModalVisible(false)}
        onConfirm={changeName}
      />
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
