import { ReactNode } from "react";
import { ActivityIndicator, Text, ViewStyle } from "react-native";
import { colors, styles } from "@/constants/theme";
import { Tap } from "./Tap";

type Props = {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "destructive";
  icon?: ReactNode;
  disabled?: boolean;
  /** Shows a spinner and blocks presses — wire to your in-flight state. */
  loading?: boolean;
  style?: ViewStyle;
};

// The app button: theme variant + press feel + haptic + busy state in one place.
export function Btn({ label, onPress, variant = "primary", icon, disabled, loading, style }: Props) {
  // Resolved at render, not module scope — styles/colors mutate on theme switch.
  const v = {
    primary: { box: styles.btnPrimary, text: styles.btnPrimaryText, spinner: colors.onFill },
    secondary: { box: styles.btnSecondary, text: styles.btnSecondaryText, spinner: colors.fg2 },
    destructive: { box: styles.btnRemove, text: styles.btnPrimaryText, spinner: colors.onFill },
  }[variant];
  const blocked = disabled || loading;
  return (
    <Tap
      onPress={onPress}
      disabled={blocked}
      haptic={variant === "destructive" ? "warn" : "tap"}
      style={[blocked ? styles.btnDisabled : v.box, style]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!blocked, busy: !!loading }}
    >
      {loading ? <ActivityIndicator size="small" color={v.spinner} /> : icon}
      <Text style={v.text}>{label}</Text>
    </Tap>
  );
}
