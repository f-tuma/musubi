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
import { View, Text, ScrollView, Pressable } from "react-native";


export default function SettingsTab() {
  const api = useApi();
  const { authClient } = useServer();
  const { loadCalendars } = useCalendarsStore();
  const { loadEvents } = useEventsStore();
  const {
    defaultCalendarView, setDefaultCalendarView,
    weekStartsOn, setWeekStartsOn,
    showKanji, setShowKanji,
  } = useSettingsStore();

  const [confrimDeleteVisible, setConfirmDeleteVisible] = useState(false);
  const userSession = authClient.useSession();
  const [settingsChanged, setSettingsChanged] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async (settings: Settings) => {
    setIsSaving(true);
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
      </ScrollView>
      {settingsChanged &&
        <Pressable
          style={[styles.fab, isSaving && { backgroundColor: colors.line }]}
          disabled={isSaving}
          onPress={() => handleSave({
            showKanji,
            defaultCalendarView,
            weekStartsOn,
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
    </View>
  );
}
