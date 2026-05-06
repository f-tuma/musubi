import { SettingRowOptions, SettingRowToggle } from "@/components/SettingRow";
import { colors, fonts, styles } from "@/constants/theme";
import { Settings } from "@/constants/types";
import { api } from "@/services/api";
import { authClient } from "@/services/auth-client";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useEventsStore } from "@/store/useEventsStore";
import { useSettingsStore } from "@/store/useSettingsStore";
import { useState } from "react";
import { View, Text, ScrollView, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";


export default function SettingsTab() {
  const { loadCalendars } = useCalendarsStore();
  const { loadEvents } = useEventsStore();
  const {
    defaultCalendarView, setDefaultCalendarView,
    weekStartsOn, setWeekStartsOn,
    showKanji, setShowKanji,
  } = useSettingsStore();

  const userSession = authClient.useSession();
  const [settingsChanged, setSettingsChanged] = useState(false);

  const handleSave = async (settings: Settings) => {
    await api.saveSettings(settings);
    setSettingsChanged(false);
  };

  const handleSignOut = () => {
    loadCalendars([]);
    loadEvents([]);
    authClient.signOut();
  };

  return (
    <SafeAreaView style={styles.screen} edges={["top", "left", "right"]}>
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
          <Pressable
            style={styles.btnRemove}
            onPress={handleSignOut}
          >
            <Text style={styles.btnPrimaryText}>
              Sign Out
            </Text>
          </Pressable>
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
            setDefaultCalendarView(v);
            setSettingsChanged(true);
          }}
        />
        <SettingRowOptions
          label="Week Starts on"
          value={weekStartsOn}
          options={["sunday", "monday"]}
          onChange={v => {
            setWeekStartsOn(v);
            setSettingsChanged(true);
          }}
        />
      </ScrollView>
      {settingsChanged &&
        <Pressable
          style={styles.fab}
          disabled={!settingsChanged}
          onPress={() => handleSave({
            showKanji,
            defaultCalendarView,
            weekStartsOn,
          })}
        >
          <Text style={{ color: colors.bg, fontSize: 16, lineHeight: 30 }}>Save Settings</Text>
        </Pressable>
      }
    </SafeAreaView >
  );
}
