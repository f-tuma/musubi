import * as SecureStore from "expo-secure-store";

// Whether the user has already seen the Google Calendar data-use disclosure.
// Google requires it before the first authorization; once they've connected a
// Google calendar we don't show it again. A reinstall clears it, which just
// shows the disclosure once more — acceptable.
const GOOGLE_DISCLOSURE_KEY = "musubi_google_disclosure_ack";

export async function hasSeenGoogleDisclosure(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(GOOGLE_DISCLOSURE_KEY)) === "1";
  } catch {
    return false;
  }
}

export async function markGoogleDisclosureSeen(): Promise<void> {
  try {
    await SecureStore.setItemAsync(GOOGLE_DISCLOSURE_KEY, "1");
  } catch {
    // Non-fatal: worst case the disclosure shows again next time.
  }
}
