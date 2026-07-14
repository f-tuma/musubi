import { colors, fonts, styles } from "@/constants/theme";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { View, Text, Linking, KeyboardAvoidingView, Platform } from "react-native";
import InputModal from "@/components/TextInputModal";
import { Btn } from "@/components/ui/Btn";
import { warn } from "@/lib/haptics";
import { useServer } from "@/contexts/ServerContext";
import { GoogleSignin, isSuccessResponse } from "@react-native-google-signin/google-signin";
import * as AppleAuthentication from "expo-apple-authentication";
import Svg, { Path } from "react-native-svg";

GoogleSignin.configure({
  webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  // Required on iOS — the native Google SDK initializes from the iOS client id
  // (the webClientId only sets the idToken audience for backend verification).
  iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
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

function AppleLogo({ size = 18, color = colors.fg }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path fill={color} d="M17.05 12.04c-.03-2.43 1.99-3.6 2.08-3.66-1.13-1.66-2.89-1.89-3.52-1.92-1.5-.15-2.93.88-3.69.88-.76 0-1.93-.86-3.17-.84-1.63.02-3.13.95-3.97 2.41-1.69 2.94-.43 7.29 1.21 9.68.8 1.17 1.76 2.48 3.01 2.43 1.21-.05 1.67-.78 3.13-.78 1.46 0 1.87.78 3.15.76 1.3-.02 2.12-1.19 2.92-2.36.92-1.35 1.3-2.66 1.32-2.73-.03-.01-2.53-.97-2.56-3.85zM14.63 4.84c.67-.81 1.12-1.94.99-3.07-.96.04-2.13.64-2.82 1.45-.62.72-1.16 1.87-1.02 2.97 1.07.08 2.17-.54 2.85-1.35z" />
    </Svg>
  );
}

export default function Welcome() {
  const { authClient, apiUrl, setNewServerUrl } = useServer();
  const [socials, setSocials] = useState<string[]>([]);
  const [googleBusy, setGoogleBusy] = useState(false);

  // Ask the (possibly self-hosted) server which social logins it supports and
  // show only those buttons. Refetches when the user points at a new server.
  useEffect(() => {
    if (!apiUrl) return;
    fetch(`${apiUrl}/api/v1/server`)
      .then(r => r.json())
      .then(({ socials }) => setSocials(Array.isArray(socials) ? socials : []))
      .catch(() => setSocials([]));
  }, [apiUrl]);

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

  const [appleBusy, setAppleBusy] = useState(false);
  const handleApple = async () => {
    setAppleBusy(true);
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!credential.identityToken) {
        warn();
        alert("No identity token from Apple");
        return;
      }
      // ponytail: no nonce — signature + audience + 1h maxAge already verified
      // server-side; add a nonce round-trip if replay hardening is needed.
      const { error } = await authClient.signIn.social({
        provider: "apple",
        idToken: { token: credential.identityToken },
      });
      if (error) {
        warn();
        alert(`Server error: ${error.message ?? JSON.stringify(error)}`);
      } else {
        router.replace("/(tabs)");
      }
    } catch (e: any) {
      if (e?.code === "ERR_REQUEST_CANCELED") return; // user backed out — not an error
      warn();
      alert(`Apple error: ${e?.message ?? String(e)}`);
    } finally {
      setAppleBusy(false);
    }
  };

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
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
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
          {socials.includes("google") && (
            <Btn
              label="Continue with Google"
              variant="secondary"
              icon={<GoogleG size={18} />}
              loading={googleBusy}
              onPress={handleGoogle}
            />
          )}
          {Platform.OS === "ios" && socials.includes("apple") && (
            <Btn
              label="Continue with Apple"
              variant="secondary"
              icon={<AppleLogo size={18} />}
              loading={appleBusy}
              onPress={handleApple}
            />
          )}
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
