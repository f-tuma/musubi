import InputModal from "@/components/TextInputModal";
import { colors, fonts, styles } from "@/constants/theme";
import { useServer } from "@/contexts/ServerContext";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { View, Text, TextInput, Alert, KeyboardAvoidingView, Platform } from "react-native";
import { Btn } from "@/components/ui/Btn";
import { success, warn } from "@/lib/haptics";

export default function SignIn() {
  const { authClient } = useServer();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

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
          Alert.alert("Sign In Failed", result.error.message);
          setIsLoading(false);
        } else {
          success();
          router.replace("/(tabs)");
        }
      } catch (e: any) {
        setIsLoading(false);
        warn();
        Alert.alert("Sign In Failed", e?.message ?? "An unexpected error occurred.");
      }
    }
  };

  const handlePasswordReset = async (email: string) => {
    authClient.requestPasswordReset({ email });
  };

  return (
    <View style={styles.screen}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ justifyContent: "space-between", flex: 1 }}>
        <View style={[{ gap: 28 }, styles.container]}>
          <View>
            <Text style={{ color: colors.fg3 }}>Welcome back</Text>
            <Text style={{ color: colors.fg, fontFamily: fonts.serif, fontSize: 28 }}>
              Pick up where you left off
            </Text>
          </View>
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
                returnKeyType="done"
                onSubmitEditing={handleSignIn}
              />
              {passwordError ? <Text style={styles.errorText}>{passwordError}</Text> : null}
            </View>
          </View>
        </View>
        <View style={styles.modalButtonsColumn}>
          <Btn
            label="Forgotten password?"
            variant="secondary"
            disabled={isLoading}
            onPress={() => setIsPasswordResetVisible(true)}
          />
          <Btn
            label="Continue"
            loading={isLoading}
            onPress={handleSignIn}
          />
        </View>
      </KeyboardAvoidingView>
      <InputModal
        visible={isPasswordResetVisible}
        placeholder="your@email.com"
        title="Enter your account email..."
        onConfirm={handlePasswordReset}
        onClose={() => setIsPasswordResetVisible(false)}
      />
    </View>
  );
}
