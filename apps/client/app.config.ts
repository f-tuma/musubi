const expoConfig = {
  name: "Musubi",
  slug: "musubi",
  owner: "frgtn",
  version: "0.0.16",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: "musubi",
  userInterfaceStyle: "automatic",

  ios: {
    "supportsTablet": true,
    "bundleIdentifier": "dev.frgtn.musubi",
    "usesAppleSignIn": true,
    "infoPlist": {
      "ITSAppUsesNonExemptEncryption": false,
      // Nabídne Musubi v "Otevřít v…" pro .ics soubory/pozvánky (iOS neumí víc — default kalendář nelze).
      "CFBundleDocumentTypes": [
        {
          "CFBundleTypeName": "Calendar Event",
          "LSHandlerRank": "Alternate",
          "LSItemContentTypes": ["com.apple.ical.ics", "public.calendar"]
        }
      ]
    }
  },
  android: {
    "package": "dev.frgtn.musubi",
    "adaptiveIcon": {
      "backgroundColor": "#050507",
      "foregroundImage": "./assets/images/android-icon-foreground.png",
      "backgroundImage": "./assets/images/android-icon-background.png",
      "monochromeImage": "./assets/images/android-icon-monochrome.png"
    },
    "predictiveBackGestureEnabled": false,
    "intentFilters": [
      {
        "action": "VIEW",
        "autoVerify": true,
        "data": [
          {
            "scheme": "https",
            "host": "musubi.frgtn.dev",
            "pathPrefix": "/invite"
          }
        ],
        "category": ["BROWSABLE", "DEFAULT"]
      },
      {
        // Otevření .ics souboru/pozvánky → Musubi v chooseru (uživatel dá "Vždy" = de facto default).
        "action": "VIEW",
        "category": ["DEFAULT", "BROWSABLE"],
        "data": [
          { "scheme": "content", "mimeType": "text/calendar" },
          { "scheme": "file", "mimeType": "text/calendar" },
          { "scheme": "https", "mimeType": "text/calendar" },
          { "scheme": "http", "mimeType": "text/calendar" }
        ]
      },
      {
        // Datumové/hodinové widgety otevírají kalendář přes
        // content://com.android.calendar/time/<millis> (AOSP filtr, mimeType
        // time/epoch) — bez něj se Musubi v jejich chooseru nenabízí.
        // (Kategorie APP_CALENDAR na launcher aktivitě řeší plugins/withCalendarAppCategory.)
        "action": "VIEW",
        "category": ["DEFAULT"],
        "data": [
          { "scheme": "content", "host": "com.android.calendar", "mimeType": "time/epoch" }
        ]
      }
    ]
  },
  web: {
    "output": "static",
    "favicon": "./assets/images/favicon.png"
  },
  plugins: [
    "expo-router",
    [
      "expo-sqlite",
      {},
    ],
    [
      "expo-splash-screen",
      {
        "image": "./assets/images/splash-icon.png",
        "imageWidth": 200,
        "resizeMode": "contain",
        "backgroundColor": "#050507",
        "dark": {
          "backgroundColor": "#050507"
        }
      }
    ],
    "expo-secure-store",
    "@react-native-community/datetimepicker",
    "@react-native-google-signin/google-signin",
    "expo-font",
    "expo-web-browser",
    [
      "expo-build-properties",
      {
        // @react-native-google-signin pulls AppCheckCore, whose Swift code
        // imports GoogleUtilities/RecaptchaInterop — those pods don't ship
        // module maps, so as static libs the build fails. Force module maps
        // for just those two (CocoaPods' own suggested fix).
        "ios": {
          "extraPods": [
            { "name": "GoogleUtilities", "modular_headers": true },
            { "name": "RecaptchaInterop", "modular_headers": true }
          ]
        }
      }
    ],
    "expo-image",
    "./plugins/withCalendarAppCategory"
  ],
  experiments: {
    "typedRoutes": true,
    "reactCompiler": true
  },
  extra: {
    eas: {
      projectId: "4e24bdfa-490c-4c3e-9a76-7abef4efa823",
    },
  }
}

export default expoConfig;

