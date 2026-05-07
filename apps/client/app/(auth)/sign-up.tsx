import { colors, fonts, styles } from "@/constants/theme";
import { useServer } from "@/contexts/ServerContext";
import { useRouter } from "expo-router";
import { useState } from "react";
import { View, Text, TextInput, Pressable, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";


export default function SignUp() {
  const { authClient } = useServer();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [isLoading, setIsLoading] = useState(false);

  const [nameError, setNameError] = useState("");
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [confirmPasswordError, setConfirmPasswordError] = useState("");

  const router = useRouter();

  const handleSignUp = async () => {
    const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    let strongPassword: boolean = false;
    let passwordMatching: boolean = false;
    let hasName: boolean = false;
    let validEmail: boolean = isValidEmail(email);

    if (name.length < 2) {
      setNameError("The name has to be at least two characters long...");
    } else {
      setNameError("");
      hasName = true;
    }
    if (!validEmail) {
      setEmailError("Email is invalid, please check...");
    } else {
      setEmailError("");
    }
    if (password.length < 8) {
      setPasswordError("password has to be at lease 8 characters long...");
    } else {
      setPasswordError("");
      strongPassword = true;
    }
    if (password !== confirmPassword) {
      setConfirmPasswordError("The passwords are not matching...");
    } else {
      setConfirmPasswordError("");
      passwordMatching = true;
    }

    if (hasName && validEmail && strongPassword && passwordMatching) {
      setIsLoading(true);
      try {
        const result = await authClient.signUp.email({ email: email, password: password, name: name })
        if (result.error) {
          setIsLoading(false);
          Alert.alert("Sign Up Failed", result.error.message);
        } else {
          router.replace("/(tabs)");
        }
      } catch (e: any) {
        setIsLoading(false);
        Alert.alert("Sign Up Failed", e?.message ?? "An unexpected error occurred.");
      }
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={["top", "left", "right"]}>
      <View style={{ justifyContent: "space-between", flex: 1, paddingBottom: 28 }}>
        <View style={[{ gap: 28 }, styles.container]}>
          <View>
            <Text style={{ color: colors.fg3 }} >
              Create account · 1 of 3
            </Text>
            <Text style={{ color: colors.fg, fontFamily: fonts.serif, fontSize: 28 }} >
              Begin simply
            </Text>
            <Text style={{ color: colors.fg2, fontFamily: fonts.serif, fontSize: 16 }} >
              Your email and a passphrase. That is all.
            </Text>
          </View>
          <View style={{ gap: 16 }}>
            <View style={{ borderBottomWidth: 1, borderColor: colors.line }}>
              <Text style={{ color: colors.fg3, fontSize: 12 }} >
                NAME
              </Text>
              <TextInput
                placeholder="John Anon"
                onChangeText={v => setName(v)}
                placeholderTextColor={colors.fg4}
                style={styles.textInput}
              />
              {nameError ? <Text style={styles.errorText}>{nameError}</Text> : null}
            </View>
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
            <View style={{ borderBottomWidth: 1, borderColor: colors.line }}>
              <Text style={{ color: colors.fg3, fontSize: 12 }} >
                CONFIRM PASSPHRASE
              </Text>
              <TextInput
                secureTextEntry={true}
                placeholder="..."
                onChangeText={v => setConfirmPassword(v)}
                placeholderTextColor={colors.fg4}
                style={styles.textInput}
              />
              {confirmPasswordError ? <Text style={styles.errorText}>{confirmPasswordError}</Text> : null}
            </View>
          </View>
        </View>
        <View style={styles.modalButtonsColumn}>
          <Pressable
            style={isLoading ? [styles.btnPrimary, { backgroundColor: colors.line }] : styles.btnPrimary}
            onPress={() => handleSignUp()}
            disabled={isLoading}
          >
            <Text style={styles.btnPrimaryText}>
              Continue
            </Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView >
  );
}
