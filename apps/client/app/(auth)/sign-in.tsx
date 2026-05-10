import InputModal from "@/components/TextInputModal";
import { colors, fonts, styles } from "@/constants/theme";
import { useServer } from "@/contexts/ServerContext";
import { useRouter } from "expo-router";
import { useState } from "react";
import { View, Text, TextInput, Pressable, Alert, Modal } from "react-native";


export default function SignIn() {
  const { authClient } = useServer();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [isPasswordResetVisible, setIsPasswordResetVisible] = useState(false);

  const [isLoading, setIsLoading] = useState(false);

  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");

  const router = useRouter();

  const handleSignIn = async () => {
    const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    let hasPassword: boolean = false;
    let validEmail: boolean = isValidEmail(email);

    if (!validEmail) {
      setEmailError("Email is invalid, please check...");
    } else {
      setEmailError("");
    }
    if (!password) {
      setPasswordError("Enter password...");
    } else {
      setPasswordError("");
      hasPassword = true;
    }

    if (validEmail && hasPassword) {
      setIsLoading(true);
      try {
        const result = await authClient.signIn.email({ email: email, password: password })
        if (result.error) {
          Alert.alert("Sign In Failed", result.error.message);
          setIsLoading(false);
        } else {
          router.replace("/(tabs)");
        }
      } catch (e: any) {
        setIsLoading(false);
        Alert.alert("Sign In Failed", e?.message ?? "An unexpected error occurred.");
      }
    }
  };

  const handlePasswordReset = async (email: string) => {
    authClient.requestPasswordReset({ email });
  }

  return (
    <View style={styles.screen}>
      <View style={{ justifyContent: "space-between", flex: 1 }}>
        <View style={[{ gap: 28 }, styles.container]}>
          <View>
            <Text style={{ color: colors.fg3 }} >
              Welcome back
            </Text>
            <Text style={{ color: colors.fg, fontFamily: fonts.serif, fontSize: 28 }} >
              Pick up where you left off
            </Text>
          </View>
          <View style={{ gap: 16 }}>
            <View style={{ borderBottomWidth: 1, borderColor: colors.line }}>
              <Text style={{ color: colors.fg3, fontSize: 12 }} >
                EMAIL
              </Text>
              <TextInput
                placeholder="you@example.com"
                onChangeText={v => setEmail(v)}
                placeholderTextColor={colors.fg4}
                style={styles.textInput}
              />
              {emailError ? <Text style={styles.errorText}>{emailError}</Text> : null}
            </View>
            <View style={{ borderBottomWidth: 1, borderColor: colors.line }}>
              <Text style={{ color: colors.fg3, fontSize: 12 }} >
                PASSPHRASE
              </Text>
              <TextInput
                secureTextEntry={true}
                placeholder="At least 8 characters"
                onChangeText={v => setPassword(v)}
                placeholderTextColor={colors.fg4}
                style={styles.textInput}
              />
              {passwordError ? <Text style={styles.errorText}>{passwordError}</Text> : null}
            </View>
          </View>
        </View>
        <View style={styles.modalButtonsColumn}>
          <Pressable
            style={isLoading ? styles.btnDisabled : styles.btnSecondary}
            disabled={isLoading}
            onPress={() => setIsPasswordResetVisible(true)}
          >
            <Text style={styles.btnSecondaryText}>
              Forgotten password?
            </Text>
          </Pressable>
          <Pressable
            style={isLoading ? styles.btnDisabled : styles.btnPrimary}
            disabled={isLoading}
            onPress={handleSignIn}
          >
            <Text style={styles.btnPrimaryText}>
              Continue
            </Text>
          </Pressable>
        </View>
      </View>
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
