import { useMemo, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { colors, fonts, styles } from "@/constants/theme";
import { appColors } from "@/constants/colors";
import { useApi } from "@/services/api";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { Btn } from "@/components/ui/Btn";
import { Tap } from "@/components/ui/Tap";
import { OnboardingScaffold } from "@/components/OnboardingScaffold";
import ColorPickerModal from "@/components/ColorPickerModal";

// Onboarding step 2 — personalize the auto-created personal calendar.
export default function OnboardingCalendar() {
  const api = useApi();
  const { calendars, localUpdateCalendar } = useCalendarsStore();

  const personal = useMemo(() => calendars.find(c => c.isDefault), [calendars]);
  const [calName, setCalName] = useState<string | null>(null); // null = untouched
  const [color, setColor] = useState<string | null>(null);
  const shownName = calName ?? personal?.name ?? "Personal";
  const shownColor = color ?? personal?.color ?? appColors[1].color;
  const [pickerOpen, setPickerOpen] = useState(false);
  const isCustomColor = !appColors.some(c => c.color === shownColor);

  const continueNext = () => {
    if (personal && (calName !== null || color !== null)) {
      const updated = { ...personal, name: shownName.trim() || "Personal", color: shownColor };
      api.updateCalendar(updated).catch((e) => console.error("Calendar update failed:", e));
      localUpdateCalendar(updated);
    }
    router.push("/onboarding/sync" as any);
  };

  return (
    <OnboardingScaffold
      step={2}
      kanji="暦"
      title="Your calendar"
      subtitle="We made you a personal calendar. Make it yours."
      actions={
        <>
          <Btn label="Back" variant="secondary" style={{ flex: 1 }} onPress={() => router.back()} />
          <Btn label="Continue" style={{ flex: 2 }} onPress={continueNext} />
        </>
      }
    >
      <View style={styles.fieldContainer}>
        <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Name & color</Text>
        <TextInput
          value={shownName}
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
            {/* Custom color — opens the picker; shows the picked color once chosen. */}
            <Tap
              onPress={() => setPickerOpen(true)}
              style={{
                width: 32, height: 32, borderRadius: 16,
                backgroundColor: isCustomColor ? shownColor : "transparent",
                borderWidth: isCustomColor ? 2 : 1,
                borderColor: isCustomColor ? colors.fg : colors.line3,
                alignItems: "center", justifyContent: "center",
              }}
            >
              {!isCustomColor && <Text style={{ color: colors.fg3, fontSize: 18, lineHeight: 20 }}>+</Text>}
            </Tap>
          </View>
        </ScrollView>
        <ColorPickerModal
          visible={pickerOpen}
          value={shownColor}
          onConfirm={setColor}
          onClose={() => setPickerOpen(false)}
        />
        <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.fg4, marginTop: 10 }}>
          This calendar is yours alone and always stays with your account.
        </Text>
      </View>
    </OnboardingScaffold>
  );
}
