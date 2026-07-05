import { useMemo, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { colors, fonts, styles } from "@/constants/theme";
import { appColors } from "@/constants/colors";
import { useApi } from "@/services/api";
import { useServer } from "@/contexts/ServerContext";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useSettingsStore } from "@/store/useSettingsStore";
import { useRefreshData } from "@/hooks/useRefreshData";
import { Btn } from "@/components/ui/Btn";
import { Tap } from "@/components/ui/Tap";
import { Avatar } from "@/components/Avatar";
import SyncCalendarModal from "@/components/calendar/SyncCalendarModal";
import { pickAvatarBase64 } from "@/lib/avatar";
import * as haptics from "@/lib/haptics";
import { Feather } from "@expo/vector-icons";

// Three-step onboarding, shown once after the first sign-in (email or Google):
//   1. who you are — display name + avatar (Google users can override both)
//   2. your personal calendar — name & color
//   3. bring your schedule — optional external connections
// Finishing flips settings.onboarded on the server.
export default function Onboarding() {
  const api = useApi();
  const { authClient } = useServer();
  const refresh = useRefreshData();
  const { calendars, localUpdateCalendar } = useCalendarsStore();
  const settings = useSettingsStore();
  const { data: session } = authClient.useSession();

  const [step, setStep] = useState<1 | 2 | 3>(1);

  // step 1 — profile
  const [name, setName] = useState<string | null>(null);       // null = untouched
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const shownName = name ?? session?.user.name ?? "";

  // step 2 — personal calendar
  const personal = useMemo(() => calendars.find(c => c.isDefault), [calendars]);
  const [calName, setCalName] = useState<string | null>(null);
  const [color, setColor] = useState<string | null>(null);
  const shownCalName = calName ?? personal?.name ?? "Personal";
  const shownColor = color ?? personal?.color ?? appColors[1].color;

  // step 3 — sync
  const [syncVisible, setSyncVisible] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const connected = calendars.some(c => c.provider);

  const pickAvatar = async () => {
    setAvatarBusy(true);
    try {
      const base64 = await pickAvatarBase64();
      if (!base64) return; // cancelled
      const url = await api.uploadAvatar(base64);
      await authClient.updateUser({ image: url });
      setAvatarUri(url);
    } catch (e) {
      haptics.warn();
      console.error("Avatar upload failed:", e);
    } finally {
      setAvatarBusy(false);
    }
  };

  const saveProfileAndContinue = async () => {
    setProfileBusy(true);
    try {
      const trimmed = shownName.trim();
      if (trimmed && trimmed !== session?.user.name) {
        await authClient.updateUser({ name: trimmed });
      }
    } catch (e) {
      haptics.warn();
      console.error("Profile update failed:", e); // don't trap them — fixable later
    } finally {
      setProfileBusy(false);
      setStep(2);
    }
  };

  const saveCalendarAndContinue = async () => {
    if (personal && (calName !== null || color !== null)) {
      const updated = { ...personal, name: shownCalName.trim() || "Personal", color: shownColor };
      api.updateCalendar(updated).catch((e) => console.error("Calendar update failed:", e));
      localUpdateCalendar(updated);
    }
    setStep(3);
  };

  const finish = async () => {
    setFinishing(true);
    try {
      await api.saveSettings({
        showKanji: settings.showKanji,
        notificationsOnByDefault: settings.notificationsOnByDefault,
        defaultCalendarView: settings.defaultCalendarView,
        weekStartsOn: settings.weekStartsOn,
        timeLocale: settings.timeLocale,
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

  const Header = ({ kanji, title, subtitle }: { kanji: string; title: string; subtitle: string }) => (
    <View style={{ alignItems: "center", paddingTop: 32, paddingBottom: 28, gap: 12 }}>
      <Text style={{ fontFamily: fonts.kanji, fontSize: 52, color: colors.fg3 }}>{kanji}</Text>
      <Text style={{ fontFamily: fonts.serif, fontSize: 30, color: colors.fg }}>{title}</Text>
      <Text style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.fg3, textAlign: "center", paddingHorizontal: 32 }}>
        {subtitle}
      </Text>
    </View>
  );

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
        {/* progress dots */}
        <View style={{ flexDirection: "row", gap: 6, justifyContent: "center", paddingTop: 16 }}>
          {[1, 2, 3].map((s) => (
            <View key={s} style={{
              width: s === step ? 18 : 6, height: 6, borderRadius: 3,
              backgroundColor: s === step ? colors.fg2 : colors.line3,
            }} />
          ))}
        </View>

        {step === 1 && (
          <>
            <Header kanji="結" title="Welcome to Musubi" subtitle="First — how should others see you?" />

            <View style={{ alignItems: "center", paddingBottom: 8 }}>
              <Tap onPress={pickAvatar} disabled={avatarBusy} scaleTo={0.95}>
                <View style={{ opacity: avatarBusy ? 0.5 : 1 }}>
                  <Avatar name={shownName || "?"} image={avatarUri ?? session?.user.image} size={96} />
                  <View style={{
                    position: "absolute", right: -2, bottom: -2,
                    width: 30, height: 30, borderRadius: 15,
                    backgroundColor: colors.fill, alignItems: "center", justifyContent: "center",
                    borderWidth: 2, borderColor: colors.bg,
                  }}>
                    <Feather name="camera" size={14} color={colors.onFill} />
                  </View>
                </View>
              </Tap>
              <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.fg4, marginTop: 10 }}>
                Tap to add a photo (optional)
              </Text>
            </View>

            <View style={styles.fieldContainer}>
              <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Display name</Text>
              <TextInput
                value={shownName}
                onChangeText={setName}
                placeholder="Your name"
                placeholderTextColor={colors.fg4}
                autoCapitalize="words"
                style={[styles.fieldValueBig, { fontFamily: fonts.sans }]}
              />
              <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.fg4, marginTop: 8 }}>
                This is the name calendar members will see.
              </Text>
            </View>
          </>
        )}

        {step === 2 && (
          <>
            <Header kanji="暦" title="Your calendar" subtitle="We made you a personal calendar. Make it yours." />

            <View style={styles.fieldContainer}>
              <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Name & color</Text>
              <TextInput
                value={shownCalName}
                onChangeText={setCalName}
                placeholder="Personal"
                placeholderTextColor={colors.fg4}
                autoCapitalize="words"
                style={[styles.fieldValueBig, { fontFamily: fonts.sans }]}
              />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 12 }}>
                <View style={{ flexDirection: "row", gap: 12 }}>
                  {appColors.map((c) => (
                    <Tap
                      key={c.color}
                      onPress={() => setColor(c.color)}
                      style={{
                        width: 32, height: 32, borderRadius: 16,
                        backgroundColor: c.color,
                        borderWidth: shownColor === c.color ? 2 : 0,
                        borderColor: colors.fg,
                      }}
                    />
                  ))}
                </View>
              </ScrollView>
              <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.fg4, marginTop: 10 }}>
                This calendar is yours alone and always stays with your account.
              </Text>
            </View>
          </>
        )}

        {step === 3 && (
          <>
            <Header kanji="繋" title="Bring your schedule" subtitle="See your existing events alongside Musubi's." />

            <View style={styles.fieldContainer}>
              <Text style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.fg2, marginBottom: 12 }}>
                {connected
                  ? "Connected — your events will appear after the first sync."
                  : "Connect Google or Apple/iCloud. You can also do this anytime later from the Calendars tab."}
              </Text>
              <Btn
                label={connected ? "Connect another calendar" : "Connect a calendar"}
                variant="secondary"
                icon={<Feather name="refresh-cw" size={14} color={colors.fg2} />}
                onPress={() => setSyncVisible(true)}
              />
            </View>
          </>
        )}
      </ScrollView>

      <View style={styles.screenActions}>
        {step > 1 && (
          <Btn label="Back" variant="secondary" style={{ flex: 1 }} onPress={() => setStep(step === 3 ? 2 : 1)} />
        )}
        {step === 1 && <Btn label="Continue" onPress={saveProfileAndContinue} loading={profileBusy} />}
        {step === 2 && <Btn label="Continue" style={{ flex: 2 }} onPress={saveCalendarAndContinue} />}
        {step === 3 && <Btn label="Start using Musubi" style={{ flex: 2 }} onPress={finish} loading={finishing} />}
      </View>

      <SyncCalendarModal
        visible={syncVisible}
        onClose={() => setSyncVisible(false)}
        onConnected={() => { refresh().catch(() => { }); }}
      />
    </View>
  );
}
