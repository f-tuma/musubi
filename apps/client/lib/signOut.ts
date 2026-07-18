import { GoogleSignin } from "@react-native-google-signin/google-signin";
import { router } from "expo-router";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useEventsStore } from "@/store/useEventsStore";
import { cacheClearAll } from "@/services/eventsCache";
import { clearAllEventNotifications } from "@/services/notifications";
import { resetOnboardingRoute } from "@/lib/onboardingState";
import { clearAgendaWidget } from "@/services/agendaWidget";

// THE sign-out sequence — Settings (user action), account delete and session
// expiry recovery all route through here so no path forgets a cleanup step:
// stores → launcher widget → SQLite mirror → scheduled notifications → native
// Google session → Better Auth session → welcome screen.
export async function signOutAndReset(authClient: { signOut: () => Promise<unknown> }) {
  useCalendarsStore.getState().loadCalendars([]);
  useEventsStore.getState().loadEvents([]);
  resetOnboardingRoute(); // next account starts onboarding at step 1, not mid-flow
  // Remove private agenda data from the launcher as soon as local state is gone.
  await clearAgendaWidget();
  await cacheClearAll();
  await clearAllEventNotifications();
  // Clear the natively-cached Google account so the next sign-in shows the
  // account picker again instead of silently reusing the last account.
  try { await GoogleSignin.signOut(); } catch { /* not signed in via Google */ }
  await authClient.signOut(); // must finish before next sign-in, else B links onto A's session
  router.replace("/(auth)/welcome");
}

// ── Session expiry hand-off ───────────────────────────────────────────────────
// services/api.ts can't reach authClient/router hooks, so it just *notifies*;
// the signed-in layout registers the actual handler. Fires once per session —
// a burst of parallel 401s runs the recovery a single time.

let expiredHandler: (() => void) | null = null;
let fired = false;

export function onSessionExpired(handler: () => void) {
  expiredHandler = handler;
  fired = false; // new registration = new session, re-arm
  return () => { if (expiredHandler === handler) expiredHandler = null; };
}

export function notifySessionExpired() {
  if (fired || !expiredHandler) return;
  fired = true;
  expiredHandler();
}
