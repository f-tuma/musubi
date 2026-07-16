import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { colors, fonts, styles } from "@/constants/theme";
import { providerFlavor } from "@musubi/types";
import { useApi } from "@/services/api";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useSettingsStore } from "@/store/useSettingsStore";
import { useRefreshData } from "@/hooks/useRefreshData";
import { Btn } from "@/components/ui/Btn";
import { OnboardingScaffold } from "@/components/OnboardingScaffold";
import SyncCalendarModal from "@/components/calendar/SyncCalendarModal";
import * as haptics from "@/lib/haptics";
import { Feather, Ionicons } from "@expo/vector-icons";

// Onboarding step 3 — connect external calendars. Finishing flips
// settings.onboarded on the server.
export default function OnboardingSync() {
  const api = useApi();
  const refresh = useRefreshData();
  const { calendars } = useCalendarsStore();
  const settings = useSettingsStore();

  const [syncVisible, setSyncVisible] = useState(false);
  const [finishing, setFinishing] = useState(false);

  // Refresh whenever this step gains focus — the OAuth round-trip lands back
  // here and the freshly synced calendars should show up in the list.
  useFocusEffect(useCallback(() => { refresh().catch(() => { }); }, []));

  // One row per connected account, with the provider's icon + account label.
  const accounts = useMemo(() => {
    const map = new Map<string, { flavor: string | null; label: string }>();
    for (const c of calendars) {
      if (!c.provider || !c.accountId) continue;
      const key = `${c.provider}:${c.accountId}`;
      if (!map.has(key)) {
        map.set(key, { flavor: providerFlavor(c), label: c.accountLabel || c.provider });
      }
    }
    return [...map.values()];
  }, [calendars]);

  const finish = async () => {
    setFinishing(true);
    try {
      await api.saveSettings({
        showKanji: settings.showKanji,
        notificationsOnByDefault: settings.notificationsOnByDefault,
        defaultCalendarView: settings.defaultCalendarView,
        weekStartsOn: settings.weekStartsOn,
        timeFormat: settings.timeFormat,
        dateFormat: settings.dateFormat,
        theme: settings.theme,
        onboarded: true,
      });
    } catch (e) {
      console.error("Onboarding finish failed:", e); // flag retries on next settings save
    } finally {
      settings.setOnboarded(true);
      haptics.success();
      setFinishing(false);
      router.replace("/(tabs)");
    }
  };

  const ProviderIcon = ({ flavor }: { flavor: string | null }) => {
    if (flavor === "google") return <Ionicons name="logo-google" size={16} color={colors.fg2} />;
    if (flavor === "apple") return <Ionicons name="logo-apple" size={17} color={colors.fg2} />;
    return <Ionicons name="cloud" size={16} color={colors.fg2} />;
  };

  return (
    <OnboardingScaffold
      step={3}
      kanji="繋"
      title="Bring your schedule"
      subtitle="See your existing events alongside Musubi's."
      actions={
        <>
          <Btn label="Back" variant="secondary" style={{ flex: 1 }} onPress={() => router.back()} />
          <Btn label="Start using Musubi" style={{ flex: 2 }} onPress={finish} loading={finishing} />
        </>
      }
    >
      <View style={styles.fieldContainer}>
        <Btn
          label={accounts.length > 0 ? "Connect another calendar" : "Connect a calendar"}
          variant="secondary"
          icon={<Feather name="refresh-cw" size={14} color={colors.fg2} />}
          onPress={() => setSyncVisible(true)}
        />
        <Text style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.fg2, marginTop: 12, textAlign: "center" }}>
          {accounts.length > 0
            ? "Connected — events will appear after the first sync."
            : "Connect Google or Apple/iCloud. You can also do this anytime later from the Calendars tab."}
        </Text>
      </View>
      {accounts.length > 0 && (
        <View style={[styles.fieldContainer, { gap: 10 }]}>
          {accounts.map((a) => (
            <View key={a.label} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <ProviderIcon flavor={a.flavor} />
              <Text style={{ fontFamily: fonts.sans, fontSize: 14, color: colors.fg, flex: 1 }} numberOfLines={1}>
                {a.label}
              </Text>
              <Feather name="check" size={16} color={colors.fg3} />
            </View>
          ))}
        </View>
      )}

      <SyncCalendarModal
        visible={syncVisible}
        onClose={() => setSyncVisible(false)}
        onConnected={(provider) => {
          refresh({ full: true, providerSync: provider !== "caldav" }).catch(() => { });
        }}
        callbackURL="/onboarding/sync"
      />
    </OnboardingScaffold>
  );
}
