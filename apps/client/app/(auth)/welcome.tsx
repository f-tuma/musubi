import { colors, fonts, styles } from "@/constants/theme";
import { useRouter } from "expo-router";
import { useState } from "react";
import { View, Text, Linking, KeyboardAvoidingView, Platform } from "react-native";
import InputModal from "@/components/TextInputModal";
import { Btn } from "@/components/ui/Btn";
import { warn } from "@/lib/haptics";
import { useServer } from "@/contexts/ServerContext";
import { GoogleSignin, isSuccessResponse } from "@react-native-google-signin/google-signin";
import Svg, { Path } from "react-native-svg";

GoogleSignin.configure({
  webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
});

function GoogleG({ size = 18 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <Path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <Path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <Path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </Svg>
  );
}

export default function Welcome() {
  const { authClient } = useServer();
  const [googleBusy, setGoogleBusy] = useState(false);
  const handleGoogle = async () => {
    const wc = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
    setGoogleBusy(true);
    try {
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      const response = await GoogleSignin.signIn();
      if (isSuccessResponse(response)) {
        if (!response.data.idToken) {
          warn();
          alert(`idToken NULL — webClientId=${wc ?? "UNDEFINED"}`);
          return;
        }
        const { error } = await authClient.signIn.social({
          provider: "google",
          idToken: { token: response.data.idToken },
        });
        if (error) {
          warn();
          alert(`Server error: ${error.message ?? JSON.stringify(error)}`);
        } else {
          router.replace("/(tabs)");
        }
      } else {
        warn();
        alert(`Not success: ${response?.type}`);
      }
    } catch (e: any) {
      warn();
      alert(`Native error: code=${e?.code} ${e?.message ?? String(e)}`);
    } finally {
      setGoogleBusy(false);
    }
  };

  const { apiUrl, setNewServerUrl } = useServer();
  const [inputModalVisible, setInputModalVisible] = useState(false);
  const router = useRouter();

  const testApiUrl = async (value: string) => {
    let result;

    try {
      result = await fetch(`${value.toLowerCase()}/api/v1/server/ok`);
    } catch (err) {
      return { ok: false, error: "Invalid URL..." }
    }

    if (result.ok) {
      const data = await result.json();
      if (data.ok) {
        return { ok: true, error: "" };
      }
    }

    return { ok: false, error: "Invalid Api Server Url..." };
  }

  return (
    <View style={styles.screen}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
      <View style={{ alignItems: "center", justifyContent: "space-between", flex: 1, paddingTop: 60 }}>
        <View style={{ alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: colors.fg, fontSize: 72, fontFamily: fonts.serif }}>
            結び
          </Text>
          <Text style={{ color: colors.fg3 }}>
            MUSUBI
          </Text>
        </View>
        <View style={{ alignItems: "center", justifyContent: "center", gap: 12 }}>
          <Text style={{ color: colors.fg, fontSize: 28, fontFamily: fonts.serif, textAlign: "center", lineHeight: 32, paddingBottom: 8 }}>
            To tie a knot{"\n"}with your closest...
          </Text>
          <Text style={{ color: colors.fg3, fontSize: 16, fontFamily: fonts.serif, textAlign: "center" }}>
            A quiet, shared space for time — {"\n"}
            for two, or for a small circle of trust.
          </Text>
        </View>
        <View style={styles.modalButtonsColumn}>
          {/* No hardcoded background — secondary follows the theme, so the
              label stays readable in both light and dark mode. */}
          <Btn
            label="Continue with Google"
            variant="secondary"
            icon={<GoogleG size={18} />}
            loading={googleBusy}
            onPress={handleGoogle}
          />
          <Btn
            label="Create account"
            onPress={() => router.push("/(auth)/sign-up")}
          />
          <Btn
            label="Login"
            variant="secondary"
            onPress={() => router.push("/(auth)/sign-in")}
          />
          <Btn
            label={`Server: ${apiUrl}`}
            variant="secondary"
            onPress={() => setInputModalVisible(true)}
          />
          <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg4, textAlign: "center" }}>
            By continuing you accept the
            <Text
              style={{
                color: colors.fg3
              }}
              onPress={() => {
                Linking.openURL("https://musubi.frgtn.dev/terms/");
              }}
            >
              {" terms of service "}
            </Text>
            and our
            <Text
              style={{
                color: colors.fg3
              }}
              onPress={() => {
                Linking.openURL("https://musubi.frgtn.dev/privacy/");
              }}
            >
              {" privacy policy."}
            </Text>
          </Text>
        </View>
      </View >
      </KeyboardAvoidingView>
      <InputModal
        visible={inputModalVisible}
        title="Api Server URL..."
        placeholder="https://your.api.server"
        onClose={() => setInputModalVisible(false)}
        onTest={(value) => testApiUrl(value)}
        onConfirm={setNewServerUrl}
      />
    </View>
  );
}
