import { Stack } from "expo-router";
import { colors } from "@/constants/theme";

// Each onboarding step is its own route: hardware back pops a step natively,
// and an OAuth round-trip can't reset local step state.
export default function OnboardingLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
  );
}
