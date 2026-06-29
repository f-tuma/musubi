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
import { useEffect, useState } from "react";
import { View, Text, ScrollView, Pressable } from "react-native";


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
  } = useSettingsStore();

  const [confrimDeleteVisible, setConfirmDeleteVisible] = useState(false);
  const userSession = authClient.useSession();
  const [settingsChanged, setSettingsChanged] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [googleCalendarLinked, setGoogleCalendarLinked] = useState(false);

  useEffect(() => {
    const setGCStatus = async () => {
      const gStatus = await api.checkGoogleStatus();
      console.log(gStatus);
      setGoogleCalendarLinked(gStatus.calendarConnected);
    }
    setGCStatus();
  }, [])

  const handleSave = async (settings: Settings) => {
    setIsSaving(true);
    console.log(settings);
    // LOG
    await api.saveSettings(settings);
    setSettingsChanged(false);
    setIsSaving(false);
  };

  const handleSignOut = () => {
    loadCalendars([]);
    loadEvents([]);
    authClient.signOut();
    router.replace('/(auth)/welcome');
  };

  const handleUserDelete = () => {
    loadCalendars([]);
    loadEvents([]);
    api.deleteUser();
    authClient.signOut();
    router.replace('/(auth)/welcome');
  }

  const handleGoogleConnect = async () => {
    const { error, data } = await authClient.linkSocial({
      provider: "google",
      scopes: ["https://www.googleapis.com/auth/calendar"],
      callbackURL: "/(tabs)",   // kam se v appce vrátit po úspěchu
    });
    alert(`ERROR: ${JSON.stringify(error)} \nDATA: ${JSON.stringify(data)}`);
  };

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
      <ScrollView>
        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: 16,
            borderBottomWidth: 1,
            borderTopWidth: 1,
            borderColor: colors.line,
            gap: 16
          }}
        >
          <Text
            style={{
              fontSize: 16,
              color: colors.fg2,
              textDecorationLine: "underline"
            }}
          >
            User Info
          </Text>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ fontSize: 14, color: colors.fg2 }}>
              Name:
            </Text>
            <Text style={{ fontSize: 14, color: colors.fg2 }}>
              {userSession.data?.user.name}
            </Text>
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ fontSize: 14, color: colors.fg2 }}>
              Email:
            </Text>
            <Text style={{ fontSize: 14, color: colors.fg2 }}>
              {userSession.data?.user.email}
            </Text>
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ fontSize: 14, color: colors.fg2 }}>
              Server:
            </Text>
            <Text style={{ fontSize: 14, color: colors.fg2 }}>
              {apiUrl?.slice(8)}
            </Text>
          </View>
        </View>
        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: 16,
            borderBottomWidth: 1,
            borderTopWidth: 1,
            borderColor: colors.line,
            gap: 16
          }}
        >
          <Text
            style={{
              fontSize: 16,
              color: colors.fg2,
              textDecorationLine: "underline"
            }}
          >
            Sync
          </Text>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ fontSize: 14, color: colors.fg2, alignSelf: "center" }}>
              Google Calendar:
            </Text>
            <Pressable
              style={{ borderColor: colors.line3, borderWidth: 1, paddingVertical: 8, paddingHorizontal: 12 }}
              onPress={googleCalendarLinked ? api.revogeGoogleConnection : handleGoogleConnect}
            >
              <Text style={{ fontSize: 14, color: googleCalendarLinked ? colors.accent : colors.fg2 }}>
                {googleCalendarLinked ? "Google Connected" : "Connect Google"}
              </Text>
            </Pressable>
          </View>
        </View>
        <SettingRowToggle
          label="Show Kanji"
          toggle={showKanji}
          onToggle={() => {
            setShowKanji(showKanji ? false : true);
            setSettingsChanged(true);
          }}
        />
        <SettingRowOptions
          label="Default Calendar View"
          value={defaultCalendarView}
          options={["month", "week", "day"]}
          onChange={v => {
            setDefaultCalendarView(v as CalendarView);
            setSettingsChanged(true);
          }}
        />
        <SettingRowOptions
          label="Week Starts on"
          value={weekStartsOn}
          options={["sunday", "monday"]}
          onChange={v => {
            setWeekStartsOn(v as "monday" | "sunday");
            setSettingsChanged(true);
          }}
        />
        <SettingRowOptions
          label="Time Locale"
          value={timeLocale}
          options={["cs-CZ", "en-UK"]}
          onChange={v => {
            setTimeLocale(v as "en-UK" | "cs-CZ");
            setSettingsChanged(true);
          }}
        />
        <SettingRowToggle
          label="Notifications On by Default"
          toggle={notificationsOnByDefault}
          onToggle={() => {
            setNotificationsOnByDefault(notificationsOnByDefault ? false : true);
            setSettingsChanged(true);
          }}
        />
        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: 16,
            borderBottomWidth: 1,
            borderTopWidth: 1,
            borderColor: colors.line,
            gap: 16
          }}
        >
          <Pressable
            style={styles.btnPrimary}
            onPress={handleSignOut}
          >
            <Text style={styles.btnPrimaryText}>
              Sign Out
            </Text>
          </Pressable>
          <Pressable
            style={styles.btnRemove}
            onPress={() => setConfirmDeleteVisible(true)}
          >
            <Text style={styles.btnPrimaryText}>
              Delete Account
            </Text>
          </Pressable>
        </View>
      </ScrollView >
      {settingsChanged &&
        <Pressable
          style={[styles.fab, isSaving && { backgroundColor: colors.line }]}
          disabled={isSaving}
          onPress={() => handleSave({
            showKanji,
            notificationsOnByDefault,
            defaultCalendarView,
            weekStartsOn,
            timeLocale,
          })}
        >
          <Text style={{ color: colors.bg, fontSize: 16, lineHeight: 30 }}>Save Settings</Text>
        </Pressable>
      }
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
