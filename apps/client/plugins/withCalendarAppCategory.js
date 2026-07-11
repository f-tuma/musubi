// Registers Musubi as a calendar application on Android.
//
// Android marks an app as "a calendar app" (Settings → Default apps → Calendar,
// assistant "open calendar", some launchers/choosers) when the launcher activity
// declares android.intent.category.APP_CALENDAR in its MAIN/LAUNCHER intent
// filter — exactly how Google Calendar's manifest does it:
//
//   <intent-filter>
//     <action android:name="android.intent.action.MAIN" />
//     <category android:name="android.intent.category.DEFAULT" />
//     <category android:name="android.intent.category.LAUNCHER" />
//     <category android:name="android.intent.category.APP_CALENDAR" />
//   </intent-filter>
//
// Expo's declarative `android.intentFilters` can only add *new* <intent-filter>
// blocks; it can't add a category to the auto-generated launcher filter. So we
// reach into the manifest here. (.ics file opening is handled separately by the
// text/calendar VIEW filters in app.config.ts.)
const { withAndroidManifest, AndroidConfig } = require("@expo/config-plugins");

const MAIN = "android.intent.action.MAIN";
const LAUNCHER = "android.intent.category.LAUNCHER";
const ADD = ["android.intent.category.DEFAULT", "android.intent.category.APP_CALENDAR"];

module.exports = function withCalendarAppCategory(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    for (const activity of app.activity ?? []) {
      for (const filter of activity["intent-filter"] ?? []) {
        const isMain = (filter.action ?? []).some((a) => a.$["android:name"] === MAIN);
        const isLauncher = (filter.category ?? []).some((c) => c.$["android:name"] === LAUNCHER);
        if (!isMain || !isLauncher) continue;
        filter.category = filter.category ?? [];
        for (const name of ADD) {
          if (!filter.category.some((c) => c.$["android:name"] === name)) {
            filter.category.push({ $: { "android:name": name } });
          }
        }
      }
    }
    return cfg;
  });
};
