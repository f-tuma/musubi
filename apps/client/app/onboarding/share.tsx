import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { Calendar } from "@musubi/types";
import { OnboardingScaffold } from "@/components/OnboardingScaffold";
import CreateCalendarModal from "@/components/calendar/CreateCalendarModal";
import InvitesModal from "@/components/calendar/InvitesModal";
import { Btn } from "@/components/ui/Btn";
import { showToast } from "@/components/ui/Toast";
import { colors, fonts, styles } from "@/constants/theme";
import { useApi } from "@/services/api";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useSettingsStore } from "@/store/useSettingsStore";
import * as haptics from "@/lib/haptics";
import { userFacingError } from "@/lib/network";

// Onboarding step 4 — show the core Musubi loop once: create a calendar, then
// land directly in its invite-link sheet. It is deliberately skippable.
export default function OnboardingShare() {
  const api = useApi();
  const settings = useSettingsStore();
  const addCalendar = useCalendarsStore(s => s.addCalendar);
  const [createVisible, setCreateVisible] = useState(false);
  const [inviteVisible, setInviteVisible] = useState(false);
  const [inviteCalendar, setInviteCalendar] = useState<Calendar | null>(null);
  const [finishing, setFinishing] = useState(false);
  const pendingInvite = useRef<Calendar | null>(null);

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
      console.error("Onboarding finish failed:", e);
      showToast({ message: userFacingError(e, "You can continue; onboarding will sync later.") });
    } finally {
      settings.setOnboarded(true);
      haptics.success();
      setFinishing(false);
      router.replace("/(tabs)");
    }
  };

  const closeCreate = () => {
    setCreateVisible(false);
    const calendar = pendingInvite.current;
    pendingInvite.current = null;
    if (!calendar) return;
    setInviteCalendar(calendar);
    // The create sheet has completed its own exit before onClose runs. Give
    // React one frame to remove it, then mount the invite sheet above the page.
    setTimeout(() => setInviteVisible(true), 32);
  };

  return (
    <>
      <OnboardingScaffold
        step={4}
        kanji="共"
        title="Plan together"
        subtitle="Create a separate calendar for a partner, family, team, or trip — then share one link."
        actions={
          <>
            <Btn label="Back" variant="secondary" style={{ flex: 1 }} onPress={() => router.back()} />
            <Btn
              label={inviteCalendar ? "Finish" : "Not now"}
              style={{ flex: 2 }}
              onPress={finish}
              loading={finishing}
            />
          </>
        }
      >
        <View style={styles.fieldContainer}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 14 }}>
            <View style={{
              width: 38,
              height: 38,
              borderRadius: 19,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: colors.bg3,
            }}>
              <Feather name="users" size={17} color={colors.fg2} />
            </View>
            <View style={{ flex: 1, gap: 5 }}>
              <Text style={{ fontFamily: fonts.sansMedium, fontSize: 15, color: colors.fg }}>
                Your first shared calendar
              </Text>
              <Text style={{ fontFamily: fonts.sans, fontSize: 12, lineHeight: 17, color: colors.fg3 }}>
                Choose a name and color. Musubi will open an invite link you can send right away.
              </Text>
            </View>
          </View>
          <View style={{ marginTop: 18 }}>
            <Btn
              label={inviteCalendar ? "Create another" : "Create & invite"}
              icon={<Feather name="send" size={14} color={colors.bg3} />}
              onPress={() => setCreateVisible(true)}
            />
          </View>
        </View>

        <View style={[styles.fieldContainer, { flexDirection: "row", alignItems: "center", gap: 12 }]}>
          <Feather name="link" size={16} color={colors.fg3} />
          <Text style={{ flex: 1, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17, color: colors.fg3 }}>
            Already invited? Open the link you received — Musubi will take you straight to the calendar preview.
          </Text>
        </View>
      </OnboardingScaffold>

      <CreateCalendarModal
        visible={createVisible}
        musubiOnly
        onClose={closeCreate}
        onCreate={(calendar) => addCalendar(calendar, api)}
        onCreated={(calendar) => { pendingInvite.current = calendar; }}
        onEdit={async () => { }}
      />
      <InvitesModal
        calendar={inviteCalendar}
        visible={inviteVisible}
        onClose={() => setInviteVisible(false)}
      />
    </>
  );
}
