import { colors, fonts, styles } from "@/constants/theme";
import { useRouter } from "expo-router";
import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import InputModal from "@/components/TextInputModal";
import * as SecureStore from "expo-secure-store";
import { updateAuthClient } from "@/services/auth-client";
import { updateApiUrl } from "@/constants/url";


export default function Welcome() {
  const [apiServer, setApiServer] = useState(SecureStore.getItem("API_URL"));
  const [inputModalVisible, setInputModalVisible] = useState(false);
  const router = useRouter();

  const testApiUrl = async (value: string) => {
    let result;

    try {
      result = await fetch(`${value.toLowerCase()}/api/server/ok`);
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

  const handleSetServer = (server: string) => {
    SecureStore.setItem("API_URL", server.toLowerCase());
    updateApiUrl();
    updateAuthClient();
    setApiServer(server.toLowerCase());
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top", "left", "right"]}>
      <View style={{ alignItems: "center", justifyContent: "space-between", flex: 1, paddingTop: 60, paddingBottom: 60 }}>
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
          <Pressable
            style={styles.btnPrimary}
            onPress={() => router.push("/(auth)/sign-up")}
          >
            <Text style={styles.btnPrimaryText}>
              Create account
            </Text>
          </Pressable>
          <Pressable
            style={styles.btnSecondary}
            onPress={() => router.push("/(auth)/sign-in")}
          >
            <Text style={styles.btnSecondaryText}>
              Login
            </Text>
          </Pressable>
          <Pressable
            style={styles.btnSecondary}
            onPress={() => setInputModalVisible(true)}
          >
            <Text style={styles.btnSecondaryText}>
              Server: {apiServer}
            </Text>
          </Pressable>
          <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg4, textAlign: "center" }}>
            By continuing you accept the terms and
            our quiet privacy promise.
          </Text>
        </View>
      </View >
      <InputModal
        visible={inputModalVisible}
        placeholder="https://your.api.server"
        onClose={() => setInputModalVisible(false)}
        onTest={(value) => testApiUrl(value)}
        onConfirm={handleSetServer}
      />
    </SafeAreaView >
  );
}
