// Native Google Sign-In on iOS needs the iOS OAuth client id AND its reversed
// form as a URL scheme, or @react-native-google-signin can't determine the
// clientID at runtime. With options the plugin takes the no-Firebase path (adds
// the scheme); without them it falls back to the Firebase-plist path (a no-op
// here). Fall back to the bare plugin when the env is unset so a build without
// the id still succeeds — iOS Google sign-in just stays off until it's provided.
const iosGoogleClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
const googleSignInPlugin = iosGoogleClientId
  ? ["@react-native-google-signin/google-signin", {
    iosUrlScheme: `com.googleusercontent.apps.${iosGoogleClientId.replace(/\.apps\.googleusercontent\.com$/, "")}`,
  }]
  : "@react-native-google-signin/google-signin";

const expoConfig = {
  name: "Musubi",
  slug: "musubi",
  owner: "frgtn",
  version: "0.0.19",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: "musubi",
  userInterfaceStyle: "automatic",

  ios: {
    "supportsTablet": true,
    "bundleIdentifier": "dev.frgtn.musubi",
    "usesAppleSignIn": true,
    // iOS 18 can switch app icons with the system appearance. Keep the warm
    // paper mark for light mode and the original sumi version for dark mode.
    "icon": {
      "light": "./assets/images/icon-light.png",
      "dark": "./assets/images/icon.png"
    },
    // Universal links: an https invite link opens the app directly instead of
    // bouncing through Safari. Needs the matching apple-app-site-association
    // file served at each domain's /.well-known/ (see API handler). EAS syncs
    // the Associated Domains capability to the App ID at build time.
    "associatedDomains": ["applinks:musubi.pro", "applinks:dev.musubi.pro"],
    "infoPlist": {
      "ITSAppUsesNonExemptEncryption": false,
      // We drive the status bar style at runtime from the app theme (root Stack
      // statusBarStyle) — iOS only honors that with this set to YES.
      "UIViewControllerBasedStatusBarAppearance": true,
      // Required whenever CFBundleDocumentTypes is declared (Apple ITMS-90737).
      // We import .ics into a calendar (read a copy), never edit the original in
      // place → NO. iOS hands us a sandbox copy of the opened file.
      "LSSupportsOpeningDocumentsInPlace": false,
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
    // Avatars come only from the system photo picker. Block the camera and
    // microphone permissions that expo-image-picker otherwise contributes.
    "blockedPermissions": [
      "android.permission.CAMERA",
      "android.permission.RECORD_AUDIO",
      "android.permission.SYSTEM_ALERT_WINDOW"
    ],
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
            "host": "musubi.pro",
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
        "image": "./assets/images/splash-icon-light.png",
        "imageWidth": 200,
        "resizeMode": "contain",
        "backgroundColor": "#f4f1e8",
        "dark": {
          "image": "./assets/images/splash-icon.png",
          "backgroundColor": "#050507"
        }
      }
    ],
    "expo-secure-store",
    "@react-native-community/datetimepicker",
    googleSignInPlugin,
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
    [
      "expo-image-picker",
      {
        "photosPermission": "Allow Musubi to choose a profile picture.",
        "cameraPermission": false,
        "microphonePermission": false
      }
    ],
    "./plugins/withCalendarAppCategory",
    "expo-sharing"
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
