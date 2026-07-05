import { ReactNode, useEffect } from "react";
import { KeyboardAvoidingView, ScrollView, Text, View } from "react-native";
import { usePathname } from "expo-router";
import { colors, fonts, styles } from "@/constants/theme";
import { setOnboardingRoute } from "@/lib/onboardingState";

// Shared frame for the onboarding steps: progress dots, kanji header,
// keyboard handling, bottom action row. Also records the current route so a
// re-entry (e.g. after an OAuth round-trip) resumes at the same step.
export function OnboardingScaffold({ step, kanji, title, subtitle, actions, children }: {
  step: 1 | 2 | 3;
  kanji: string;
  title: string;
  subtitle: string;
  actions: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  useEffect(() => { setOnboardingRoute(pathname); }, [pathname]);

  return (
    <View style={styles.screen}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
          <View style={{ flexDirection: "row", gap: 6, justifyContent: "center", paddingTop: 16 }}>
            {[1, 2, 3].map((s) => (
              <View key={s} style={{
                width: s === step ? 18 : 6, height: 6, borderRadius: 3,
                backgroundColor: s === step ? colors.fg2 : colors.line3,
              }} />
            ))}
          </View>

          <View style={{ alignItems: "center", paddingTop: 32, paddingBottom: 28, gap: 12 }}>
            <Text style={{ fontFamily: fonts.kanji, fontSize: 52, color: colors.fg3 }}>{kanji}</Text>
            <Text style={{ fontFamily: fonts.serif, fontSize: 30, color: colors.fg }}>{title}</Text>
            <Text style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.fg3, textAlign: "center", paddingHorizontal: 32 }}>
              {subtitle}
            </Text>
          </View>

          {children}
        </ScrollView>

        <View style={styles.screenActions}>
          {actions}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
