import { SettingRowAction, SettingRowOptions, SettingRowToggle } from "@/components/SettingRow";
import InputModal from "@/components/TextInputModal";
import { colors, fonts, styles } from "@/constants/theme";
import { CalendarView, Settings } from "@musubi/types";
import { useServer } from "@/contexts/ServerContext";
import { useApi } from "@/services/api";
import { useSettingsStore } from "@/store/useSettingsStore";
import { useState } from "react";
import { View, Text, ScrollView, RefreshControl, StyleSheet, Linking, Platform } from "react-native";
import { useRefreshData } from "@/hooks/useRefreshData";
import { Btn } from "@/components/ui/Btn";
import { Tap } from "@/components/ui/Tap";
import { success, warn } from "@/lib/haptics";
import { Avatar } from "@/components/Avatar";
import { pickAvatarBase64 } from "@/lib/avatar";
import { Feather } from "@expo/vector-icons";
import { signOutAndReset } from "@/lib/signOut";
import { showToast } from "@/components/ui/Toast";
import { userFacingError } from "@/lib/network";
import Constants from "expo-constants";

const SUPPORT_EMAIL = "hello@frgtn.dev";
const FEEDBACK_URL = "https://feedback.musubi.pro/";
const PRIVACY_URL = "https://musubi.pro/privacy/";
const TERMS_URL = "https://musubi.pro/terms/";


export default function SettingsTab() {
  const api = useApi();
  const { authClient, apiUrl } = useServer();
  const {
    defaultCalendarView, setDefaultCalendarView,
    weekStartsOn, setWeekStartsOn,
    showKanji, setShowKanji,
    notificationsOnByDefault, setNotificationsOnByDefault,
    timeFormat, setTimeFormat,
    dateFormat, setDateFormat,
    theme, setTheme,
    tabBarLabels, setTabBarLabels,
    onboarded,
  } = useSettingsStore();

  const [confrimDeleteVisible, setConfirmDeleteVisible] = useState(false);
  const [nameModalVisible, setNameModalVisible] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const userSession = authClient.useSession();
  const appVersion = Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? "unknown";
  const appBuild = Constants.nativeBuildVersion
    ?? String(Platform.OS === "android" ? Constants.expoConfig?.android?.versionCode ?? "dev" : "dev");

  const openExternal = async (url: string, fallback: string) => {
    try {
      await Linking.openURL(url);
    } catch (error) {
      warn();
      console.warn("Could not open external link:", error);
      showToast({ message: fallback });
    }
  };

  const openProblemReport = () => {
    const subject = "Musubi problem report";
    const intro = "What happened, and what did you expect instead?";
    const diagnostics = [
      `Musubi ${appVersion} (${appBuild})`,
      `${Platform.OS} ${String(Platform.Version)}`,
      `Server: ${apiUrl ?? "unknown"}`,
    ].join("\n");
    const body = `${intro}\n\n\n---\n${diagnostics}`;
    void openExternal(
      `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
      `Email us at ${SUPPORT_EMAIL}.`,
    );
  };

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
      showToast({ message: userFacingError(e, "Could not update your photo.") });
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
      showToast({ message: userFacingError(e, "Could not update your name.") });
    }
  };

  const refresh = useRefreshData();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async function runRefresh() {
    setRefreshing(true);
    try { await refresh(); }
    catch (e) {
      console.error(e);
      showToast({
        message: userFacingError(e, "Could not refresh settings."),
        actionLabel: "Retry",
        onAction: () => setTimeout(() => { void runRefresh(); }, 320),
      });
    }
    finally { setRefreshing(false); }
  };

  // Autosave: settings persist the moment they change — no Save button to forget.
  // `patch` carries the just-changed value (store reads here would be stale).
  const save = (patch: Partial<Settings>) => {
    api.saveSettings({
      showKanji, notificationsOnByDefault, defaultCalendarView, weekStartsOn, timeFormat, dateFormat, theme, onboarded, tabBarLabels,
      ...patch,
    }).catch((e) => {
      warn();
      console.error("Settings save failed:", e);
      showToast({ message: userFacingError(e, "This setting could not be saved.") });
    });
  };

  const handleSignOut = () => signOutAndReset(authClient);

  const handleUserDelete = async () => {
    try {
      await api.deleteUser(); // needs the live session — before the reset
    } catch (error) {
      warn();
      throw new Error(userFacingError(error, "Your account could not be deleted."));
    }

    success();
    try {
      await signOutAndReset(authClient);
    } catch (error) {
      // The server-side deletion already succeeded. Do not tell the user it
      // failed just because local cleanup hit a device-specific problem.
      console.warn("Account deleted, but local cleanup did not finish:", error);
      showToast({ message: "Account deleted. Restart Musubi to finish local cleanup." });
    }
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
        <Text style={styles.screenTitle}>Settings</Text>
      </View>
      <ScrollView showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {/* Who you are — tap the avatar to change the photo, tap the name to rename. */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14, padding: 20, borderBottomWidth: 1, borderColor: colors.line }}>
          <Tap
            onPress={changeAvatar}
            disabled={avatarBusy}
            scaleTo={0.95}
            accessibilityLabel="Change profile photo"
          >
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
          <Tap
            onPress={() => setNameModalVisible(true)}
            scaleTo={1}
            style={{ flex: 1, gap: 2 }}
            accessibilityLabel={`Change display name. Current name ${userSession.data?.user.name ?? "unknown"}`}
          >
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
        <SettingRowToggle
          label="Tab Labels"
          toggle={tabBarLabels}
          onToggle={() => {
            setTabBarLabels(!tabBarLabels);
            save({ tabBarLabels: !tabBarLabels });
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

        <Text style={[styles.sectionLabel, local.sectionHeading]}>Help & About</Text>
        <SettingRowAction
          label="Feedback & Roadmap"
          detail="Suggest ideas, vote, and see what is planned"
          external
          onPress={() => void openExternal(FEEDBACK_URL, "Feedback is available at feedback.musubi.pro.")}
        />
        <SettingRowAction
          label="Report a Problem"
          detail="Includes app, device, and server details"
          onPress={openProblemReport}
        />
        <SettingRowAction
          label="Privacy Policy"
          external
          onPress={() => void openExternal(PRIVACY_URL, "Privacy policy is available at musubi.pro/privacy.")}
        />
        <SettingRowAction
          label="Terms of Service"
          external
          onPress={() => void openExternal(TERMS_URL, "Terms are available at musubi.pro/terms.")}
        />
        <SettingRowAction label="Version" value={`${appVersion} (${appBuild})`} />

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
        isDelete
        title="Type your exact display name to delete your account"
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
