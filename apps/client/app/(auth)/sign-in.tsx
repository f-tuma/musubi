import InputModal from "@/components/TextInputModal";
import { colors, fonts, styles } from "@/constants/theme";
import { useServer } from "@/contexts/ServerContext";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, Alert, KeyboardAvoidingView, Platform, ScrollView } from "react-native";
import { Btn } from "@/components/ui/Btn";
import { success, warn } from "@/lib/haptics";
import SocialAuthButtons from "@/components/auth/SocialAuthButtons";
import { fetchWithTimeout, userFacingError } from "@/lib/network";
import { takePendingInviteHref } from "@/lib/pendingInvite";
import { showToast } from "@/components/ui/Toast";

export default function SignIn() {
  const { authClient, apiUrl } = useServer();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Password reset needs the server to send email. Assume it can until told
  // otherwise (old servers omit the flag), then hide "Forgotten password?" if
  // this server has no SMTP configured.
  const [emailEnabled, setEmailEnabled] = useState(true);
  useEffect(() => {
    if (!apiUrl) return;
    fetchWithTimeout(`${apiUrl}/api/v1/server`)
      .then((r) => r.json())
      .then(({ email }) => setEmailEnabled(email !== false))
      .catch(() => { });
  }, [apiUrl]);

  const [isPasswordResetVisible, setIsPasswordResetVisible] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");

  const passwordRef = useRef<TextInput>(null);

  const router = useRouter();

  const handleSignIn = async () => {
    const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    const validEmail = isValidEmail(email);
    const hasPassword = !!password;

    if (!validEmail) setEmailError("Email is invalid, please check...");
    else setEmailError("");

    if (!hasPassword) setPasswordError("Enter password...");
    else setPasswordError("");

    if (validEmail && hasPassword) {
      setIsLoading(true);
      try {
        const result = await authClient.signIn.email({ email, password });
        if (result.error) {
          warn();
          Alert.alert("Sign In Failed", userFacingError(result.error, "Check your email and passphrase."));
          setIsLoading(false);
        } else {
          success();
          router.replace((await takePendingInviteHref() ?? "/(tabs)") as any);
        }
      } catch (e: any) {
        setIsLoading(false);
        warn();
        Alert.alert("Sign In Failed", userFacingError(e));
      }
    }
  };

  const handlePasswordReset = async (email: string) => {
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new Error("Enter a valid email address.");
    }

    const result = await authClient.requestPasswordReset({ email: normalized });
    if (result.error) {
      throw new Error(userFacingError(result.error, "Could not send the reset email."));
    }

    success();
    showToast({ message: "If an account exists for this email, a reset link is on its way." });
  };

  return (
    <View style={styles.screen}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: "space-between" }}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
        >
          <View style={[{ gap: 28 }, styles.container]}>
            <View>
              <Text style={{ color: colors.fg3 }}>Welcome back</Text>
              <Text style={{ color: colors.fg, fontFamily: fonts.serif, fontSize: 28 }}>
                Pick up where you left off
              </Text>
            </View>
            {/* Same as sign-up: people whose account IS a Google/Apple account
                land here too — don't make them hunt for the button. */}
            <SocialAuthButtons separatorLabel="or with email" />
            <View style={{ gap: 16 }}>
              <View style={{ borderBottomWidth: 1, borderColor: colors.line }}>
                <Text style={{ color: colors.fg3, fontSize: 12 }}>EMAIL</Text>
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  placeholderTextColor={colors.fg4}
                  style={styles.textInput}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="emailAddress"
                  autoComplete="email"
                  accessibilityLabel="Email"
                  returnKeyType="next"
                  onSubmitEditing={() => passwordRef.current?.focus()}
                />
                {emailError ? <Text style={styles.errorText}>{emailError}</Text> : null}
              </View>
              <View style={{ borderBottomWidth: 1, borderColor: colors.line }}>
                <Text style={{ color: colors.fg3, fontSize: 12 }}>PASSPHRASE</Text>
                <TextInput
                  ref={passwordRef}
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry={true}
                  placeholder="At least 8 characters"
                  placeholderTextColor={colors.fg4}
                  style={styles.textInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="password"
                  autoComplete="current-password"
                  accessibilityLabel="Passphrase"
                  returnKeyType="done"
                  onSubmitEditing={handleSignIn}
                />
                {passwordError ? <Text style={styles.errorText}>{passwordError}</Text> : null}
              </View>
            </View>
          </View>
          <View style={styles.modalButtonsColumn}>
            {emailEnabled && (
              <Btn
                label="Forgotten password?"
                variant="secondary"
                disabled={isLoading}
                onPress={() => setIsPasswordResetVisible(true)}
              />
            )}
            <Btn
              label="Continue"
              loading={isLoading}
              onPress={handleSignIn}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      <InputModal
        visible={isPasswordResetVisible}
        placeholder="your@email.com"
        title="Reset your password"
        keyboardType="email-address"
        autoCapitalize="none"
        onConfirm={handlePasswordReset}
        onClose={() => setIsPasswordResetVisible(false)}
      />
    </View>
  );
}
