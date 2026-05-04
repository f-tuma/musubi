import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.relative(__dirname, "../../.env") })

const expoConfig = {
  name: "Musubi",
  slug: "musubi",
  owner: "frgtn",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: "musubi",
  userInterfaceStyle: "automatic",
  newArchEnabled: true,
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
      "backgroundColor": "#E6F4FE",
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
        "backgroundColor": "#ffffff",
        "dark": {
          "backgroundColor": "#000000"
        }
      }
    ],
    "expo-secure-store",
    "@react-native-community/datetimepicker",
    "expo-font",
    "expo-web-browser"
  ],
  experiments: {
    "typedRoutes": true,
    "reactCompiler": true
  },
  extra: {
    apiUrl: process.env.API_URL,
    eas: {
      projectId: "38c1b679-ef45-47ee-b644-36000f3c55a6",
    },
  }
}

export default expoConfig;

