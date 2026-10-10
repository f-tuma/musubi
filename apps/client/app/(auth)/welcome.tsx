import { colors, fonts, styles } from "@/constants/theme";
import { useRouter } from "expo-router";
import { useState } from "react";
import { View, Text, Linking, KeyboardAvoidingView, ScrollView } from "react-native";
import InputModal from "@/components/TextInputModal";
import { Btn } from "@/components/ui/Btn";
import { useServer } from "@/contexts/ServerContext";
import { normalizeServerUrl } from "@/lib/serverUrl";
import { fetchWithTimeout, userFacingError } from "@/lib/network";
import semver from "semver";
import Svg, { Path } from "react-native-svg";

const requiredServerVersion = "0.1.3";

// The two arms of the knot, same paths as the web app's BrandMark — drawn
// rather than loaded so each arm can take a theme colour.
function BrandMark({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Path fill={colors.fg} d="M21.984 39.22a15.8 15.8 0 0 1-4.196.564c-8.708 0-15.778-7.07-15.778-15.778S9.08 8.228 17.788 8.228c1.138 0 2.248.121 3.318.35a18 18 0 0 0-6.58 6.79 18 18 0 0 0-1.032 2.219c-2.068 1.386-3.43 3.745-3.43 6.42s1.362 5.032 3.43 6.419a7.7 7.7 0 0 0 2.912 1.181 8 8 0 0 0 1.382.123 7.72 7.72 0 0 0 6.223-3.149 7.7 7.7 0 0 0 1.148-2.26c.23-.731.354-1.509.354-2.315s-.124-1.583-.354-2.314a5.6 5.6 0 0 1 .581-.987 5.57 5.57 0 0 1 4.494-2.275 5.6 5.6 0 0 1 1 .089 5.5 5.5 0 0 1 1.533.518c.518 1.563.8 3.233.8 4.97s-.282 3.406-.8 4.969a15.7 15.7 0 0 1-1.151 2.631 15.86 15.86 0 0 1-7.605 6.9 16 16 0 0 1-2.027.712" />
      <Path fill={colors.accent} d="M26.038 8.793a15.8 15.8 0 0 1 4.196-.565c8.708 0 15.778 7.07 15.778 15.778s-7.07 15.778-15.778 15.778a15.8 15.8 0 0 1-3.318-.35 18 18 0 0 0 6.58-6.79 18 18 0 0 0 1.032-2.218c2.068-1.387 3.43-3.745 3.43-6.42s-1.362-5.033-3.43-6.42a7.7 7.7 0 0 0-2.912-1.18 8 8 0 0 0-1.382-.124 7.72 7.72 0 0 0-6.223 3.15 7.7 7.7 0 0 0-1.148 2.26 7.7 7.7 0 0 0-.354 2.314c0 .806.124 1.584.354 2.315a5.6 5.6 0 0 1-.581.986 5.57 5.57 0 0 1-5.493 2.187 5.5 5.5 0 0 1-1.534-.518c-.518-1.563-.8-3.234-.8-4.97s.282-3.406.8-4.969a15.7 15.7 0 0 1 1.151-2.631 15.86 15.86 0 0 1 7.605-6.901 16 16 0 0 1 2.027-.712" />
    </Svg>
  );
}

export default function Welcome() {
  const { apiUrl, setNewServerUrl } = useServer();

  const [inputModalVisible, setInputModalVisible] = useState(false);
  const router = useRouter();

  const testApiUrl = async (value: string) => {
    let result;

    try {
      result = await fetchWithTimeout(`${normalizeServerUrl(value)}/api/v1/server/ok`);
    } catch (err) {
      return { ok: false, error: userFacingError(err, "Could not reach this server. Check the URL and try again.") }
    }

    if (result.ok) {
      const data = await result.json();
      if (data.ok && semver.valid(data.version) && semver.gte(data.version, requiredServerVersion)) {
        return { ok: true, error: "" };
      }
      if (data.ok) {
        return {
          ok: false,
          error: `This server runs ${data.version ?? "an old build"}; Musubi ${requiredServerVersion} is required.`,
        };
      }
    }

    return { ok: false, error: "Invalid Api Server Url..." };
  }

  return (
    <View style={styles.screen}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ alignItems: "center", justifyContent: "space-between", flexGrow: 1, paddingTop: 60, gap: 28 }}>
        <View style={{ alignItems: "center", justifyContent: "center", gap: 12 }}>
          <BrandMark size={96} />
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
                Linking.openURL("https://musubi.pro/terms/");
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
                Linking.openURL("https://musubi.pro/privacy/");
              }}
            >
              {" privacy policy."}
            </Text>
          </Text>
        </View>
      </ScrollView>
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
