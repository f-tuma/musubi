import { Redirect, usePathname } from "expo-router";

// Catch-all for deep links that don't match a route. The app declares itself a
// calendar app (APP_CALENDAR), so Android hands it system calendar intents like
// content://com.android.calendar/time/<epoch-ms> — expo-router sees them as
// musubi://com.android.calendar/time/<ms>. Route those to the calendar at that
// date; anything else lands on the root redirect (never the Unmatched Route
// screen, which also hung cold starts on an infinite splash).
export default function NotFound() {
  const pathname = usePathname();
  const ms = pathname.match(/\/time\/(\d{10,})/)?.[1];
  if (ms) return <Redirect href={{ pathname: "/", params: { time: ms } }} />;
  return <Redirect href="/" />;
}
