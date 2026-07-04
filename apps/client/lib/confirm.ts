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
