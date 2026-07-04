import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

// One voice for the whole app. Semantic names so callsites read as intent,
// and the mapping (or platform tuning) lives in exactly one place.
// Works on both platforms — modern Android handles impact haptics fine.
const enabled = Platform.OS === "ios" || Platform.OS === "android";

/** Light tick — taps, toggles, pill selections. */
export function tap() {
  if (enabled) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

/** Selection change — moving through options, snapping. */
export function select() {
  if (enabled) Haptics.selectionAsync();
}

/** Medium thump — primary actions, long-press, drag thresholds. */
export function thump() {
  if (enabled) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
}

/** Something worked — saved, connected, joined. */
export function success() {
  if (enabled) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

/** Careful — destructive confirms, errors. */
export function warn() {
  if (enabled) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
}
