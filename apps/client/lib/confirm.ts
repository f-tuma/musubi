import { ActionSheetIOS, Alert, Platform } from "react-native";
import { warn } from "@/lib/haptics";

type Options = {
  title: string;
  message?: string;
  confirmLabel: string;      // e.g. "Delete", "Remove", "Transfer"
  destructive?: boolean;     // default true — that's what confirms are for
};

// The one way to ask "are you sure?". iOS gets the native action sheet
// (the platform idiom for destructive choices), Android gets the native
// alert. Both lead with a warning haptic.
// Multi-choice variant — e.g. recurring delete scope ("this / following / all").
// iOS action sheet; Android alert with tap-outside as cancel.
export function chooseOption(
  title: string,
  message: string | undefined,
  options: { label: string; destructive?: boolean; onPress: () => void }[],
  quiet = false, // pickers (view switch…) shouldn't buzz like destructive choices
) {
  if (!quiet) warn();
  if (Platform.OS === "ios") {
    const destructiveIdx = options.findIndex(o => o.destructive);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        message,
        options: ["Cancel", ...options.map(o => o.label)],
        cancelButtonIndex: 0,
        destructiveButtonIndex: destructiveIdx >= 0 ? destructiveIdx + 1 : undefined,
      },
      (i) => { if (i > 0) options[i - 1].onPress(); },
    );
  } else {
    Alert.alert(
      title,
      message,
      options.map(o => ({
        text: o.label,
        style: o.destructive ? "destructive" as const : "default" as const,
        onPress: o.onPress,
      })),
      { cancelable: true },
    );
  }
}

export function confirm({ title, message, confirmLabel, destructive = true }: Options, onConfirm: () => void) {
  warn();
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        message,
        options: ["Cancel", confirmLabel],
        cancelButtonIndex: 0,
        destructiveButtonIndex: destructive ? 1 : undefined,
      },
      (i) => { if (i === 1) onConfirm(); },
    );
  } else {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: confirmLabel, style: destructive ? "destructive" : "default", onPress: onConfirm },
    ]);
  }
}
