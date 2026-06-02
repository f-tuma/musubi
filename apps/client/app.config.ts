const expoConfig = {
  name: "Musubi",
  slug: "musubi",
  owner: "frgtn",
  version: "0.0.4",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: "musubi",
  userInterfaceStyle: "automatic",

  ios: {
    "supportsTablet": true,
    "bundleIdentifier": "dev.frgtn.musubi",
    "infoPlist": {
      "ITSAppUsesNonExemptEncryption": false
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
    "expo-font",
    "expo-web-browser",
    "expo-build-properties",
    "expo-image"
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

