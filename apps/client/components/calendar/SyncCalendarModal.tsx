import { colors, fonts, styles } from "@/constants/theme";
import { useServer } from "@/contexts/ServerContext";
import { useApi } from "@/services/api";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { useState } from "react";
import { Text, Modal, Pressable, ScrollView, View, TextInput, Alert, Linking } from "react-native";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated from "react-native-reanimated";
import { Ionicons } from "@expo/vector-icons";
import { Tap } from "@/components/ui/Tap";
import { Btn } from "@/components/ui/Btn";
import * as haptics from "@/lib/haptics";

const ICLOUD_URL = "https://caldav.icloud.com";

type Step = "providers" | "apple" | "caldav";

type Props = {
  visible: boolean;
  onClose: () => void;
  onConnected: () => void;
  /** Where the OAuth round-trip lands — onboarding passes its own step so
   *  connecting doesn't dump the user into the app. */
  callbackURL?: string;
};

export default function SyncCalendarModal({ visible, onClose, onConnected, callbackURL = "/(tabs)" }: Props) {
  const { authClient } = useServer();
  const api = useApi();

  const [step, setStep] = useState<Step>("providers");
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const closeSequence = () => {
    onClose();
    setStep("providers");
    setServerUrl("");
    setUsername("");
    setPassword("");
    setError("");
    setIsLoading(false);
  };

  const { slideStyle, fadeStyle, gesture, handleClose } = useModalAnimation(visible, closeSequence);

  const handleGoogle = async () => {
    setIsLoading(true);
    try {
      const { error } = await authClient.linkSocial({
        provider: "google",
        scopes: ["https://www.googleapis.com/auth/calendar"],
        callbackURL,
      });
      if (error) throw new Error(error.message ?? "Google connect failed");
      haptics.success();
      onConnected();
      handleClose();
    } catch (e: any) {
      haptics.warn();
      Alert.alert("Google connect failed", e?.message ?? "An unexpected error occured.");
    } finally {
      setIsLoading(false);
    }
  };

  // Shared for Apple (fixed iCloud server) and generic CalDAV.
  const handleCaldav = async (url: string) => {
    if (!url || !username || !password) {
      setError("All fields are required.");
      return;
    }
    setIsLoading(true);
    setError("");
    try {
      await api.connectCaldav(url, username, password);
      haptics.success();
      onConnected();
      handleClose();
    } catch {
      haptics.warn();
      setError("Could not connect — check your credentials.");
    } finally {
      setIsLoading(false);
    }
  };

  const title =
    step === "apple" ? "Connect Apple / iCloud" : step === "caldav" ? "Connect CalDAV" : "Sync a Calendar";

  return (
    <Modal
      visible={visible}
      onRequestClose={handleClose}
      animationType="none"
      transparent={true}
      statusBarTranslucent={true}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View style={[styles.modalOverlay, fadeStyle]}>
          <Pressable style={{ flex: 1 }} onPress={handleClose} />
        </Animated.View>
        <GestureDetector gesture={gesture}>
          <Animated.View style={[styles.modalSheet, fadeStyle, slideStyle]}>
            <View style={styles.modalHandle} />
            <View style={styles.modalTitleRow}>
              <Text style={styles.modalTitle}>{title}</Text>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              {step === "providers" && (
                <View style={styles.modalButtonsColumn}>
                  <Btn
                    label="Google Calendar"
                    variant="secondary"
                    icon={<Ionicons name="logo-google" size={16} color={colors.fg2} />}
                    loading={isLoading}
                    onPress={handleGoogle}
                  />
                  <Btn
                    label="Apple / iCloud"
                    variant="secondary"
                    icon={<Ionicons name="logo-apple" size={16} color={colors.fg2} />}
                    onPress={() => setStep("apple")}
                  />
                  <Btn
                    label="Other (CalDAV)"
                    variant="secondary"
                    icon={<Ionicons name="cloud" size={16} color={colors.fg2} />}
                    onPress={() => setStep("caldav")}
                  />
                </View>
              )}

              {step === "apple" && (
                <>
                  <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4, gap: 6 }}>
                    <Text style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.fg2 }}>
                      iCloud needs an <Text style={{ fontFamily: fonts.sansMedium }}>app-specific password</Text> — not your Apple ID password.
                    </Text>
                    <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg3 }}>
                      1. Open account.apple.com → Sign-In & Security.{"\n"}
                      2. App-Specific Passwords → generate one (name it “Musubi”).{"\n"}
                      3. Paste it below with your Apple ID.
                    </Text>
                    <Tap onPress={() => Linking.openURL("https://account.apple.com")}>
                      <Text style={{ fontFamily: fonts.sansMedium, fontSize: 13, color: colors.accent }}>
                        Open account.apple.com →
                      </Text>
                    </Tap>
                  </View>

                  <View style={styles.fieldContainer}>
                    <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Apple ID</Text>
                    <TextInput
                      value={username}
                      onChangeText={setUsername}
                      autoCapitalize="none"
                      keyboardType="email-address"
                      placeholder="you@icloud.com"
                      placeholderTextColor={colors.fg4}
                      style={[styles.fieldValueBig, { fontFamily: fonts.sans }]}
                    />
                  </View>
                  <View style={styles.fieldContainer}>
                    <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>App-specific password</Text>
                    <TextInput
                      value={password}
                      onChangeText={setPassword}
                      autoCapitalize="none"
                      secureTextEntry
                      placeholder="xxxx-xxxx-xxxx-xxxx"
                      placeholderTextColor={colors.fg4}
                      style={[styles.fieldValueBig, { fontFamily: fonts.sans }]}
                    />
                  </View>
                  {error ? <Text style={styles.errorText}>{error}</Text> : null}
                  <View style={styles.modalButtonsColumn}>
                    <Btn label="Connect" loading={isLoading} onPress={() => handleCaldav(ICLOUD_URL)} />
                    <Btn label="Back" variant="secondary" onPress={() => setStep("providers")} />
                  </View>
                </>
              )}

              {step === "caldav" && (
                <>
                  <View style={styles.fieldContainer}>
                    <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Server URL</Text>
                    <TextInput
                      value={serverUrl}
                      onChangeText={setServerUrl}
                      autoCapitalize="none"
                      placeholder="https://your.caldav.server"
                      placeholderTextColor={colors.fg4}
                      style={[styles.fieldValueBig, { fontFamily: fonts.sans }]}
                    />
                  </View>
                  <View style={styles.fieldContainer}>
                    <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Username</Text>
                    <TextInput
                      value={username}
                      onChangeText={setUsername}
                      autoCapitalize="none"
                      placeholderTextColor={colors.fg4}
                      style={[styles.fieldValueBig, { fontFamily: fonts.sans }]}
                    />
                  </View>
                  <View style={styles.fieldContainer}>
                    <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Password</Text>
                    <TextInput
                      value={password}
                      onChangeText={setPassword}
                      autoCapitalize="none"
                      secureTextEntry
                      placeholderTextColor={colors.fg4}
                      style={[styles.fieldValueBig, { fontFamily: fonts.sans }]}
                    />
                  </View>
                  {error ? <Text style={styles.errorText}>{error}</Text> : null}
                  <View style={styles.modalButtonsColumn}>
                    <Btn label="Connect" loading={isLoading} onPress={() => handleCaldav(serverUrl)} />
                    <Btn label="Back" variant="secondary" onPress={() => setStep("providers")} />
                  </View>
                </>
              )}
            </ScrollView>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}
