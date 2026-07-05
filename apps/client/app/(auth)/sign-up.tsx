import { colors, fonts, styles } from "@/constants/theme";
import { useServer } from "@/contexts/ServerContext";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { View, Text, TextInput, Alert, KeyboardAvoidingView, Platform } from "react-native";
import { Btn } from "@/components/ui/Btn";
import { success, warn } from "@/lib/haptics";


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

  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const confirmPasswordRef = useRef<TextInput>(null);

  const router = useRouter();

  const handleSignUp = async () => {
    const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    const validEmail = isValidEmail(email);
    const hasName = name.length >= 2;
    const strongPassword = password.length >= 8;
    const passwordMatching = password === confirmPassword;

    if (!hasName) setNameError("The name has to be at least two characters long...");
    else setNameError("");

    if (!validEmail) setEmailError("Email is invalid, please check...");
    else setEmailError("");

    if (!strongPassword) setPasswordError("password has to be at lease 8 characters long...");
    else setPasswordError("");

    if (!passwordMatching) setConfirmPasswordError("The passwords are not matching...");
    else setConfirmPasswordError("");

    if (hasName && validEmail && strongPassword && passwordMatching) {
      setIsLoading(true);
      try {
        const result = await authClient.signUp.email({ email, password, name });
        if (result.error) {
          setIsLoading(false);
          warn();
          Alert.alert("Sign Up Failed", result.error.message);
        } else {
          success();
          router.replace("/(tabs)");
        }
      } catch (e: any) {
        setIsLoading(false);
        warn();
        Alert.alert("Sign Up Failed", e?.message ?? "An unexpected error occurred.");
      }
    }
  };

  return (
    <View style={styles.screen}>
      <KeyboardAvoidingView behavior="padding" style={{ justifyContent: "space-between", flex: 1 }}>
        <View style={[{ gap: 28 }, styles.container]}>
          <View>
            <Text style={{ color: colors.fg3 }}>Create account · 1 of 3</Text>
            <Text style={{ color: colors.fg, fontFamily: fonts.serif, fontSize: 28 }}>
              Begin simply
            </Text>
            <Text style={{ color: colors.fg2, fontFamily: fonts.serif, fontSize: 16 }}>
              Your email and a passphrase. That is all.
            </Text>
          </View>
          <View style={{ gap: 16 }}>
            <View style={{ borderBottomWidth: 1, borderColor: colors.line }}>
              <Text style={{ color: colors.fg3, fontSize: 12 }}>NAME</Text>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="John Anon"
                placeholderTextColor={colors.fg4}
                style={styles.textInput}
                autoCapitalize="words"
                autoCorrect={false}
                textContentType="name"
                autoComplete="name"
                returnKeyType="next"
                onSubmitEditing={() => emailRef.current?.focus()}
              />
              {nameError ? <Text style={styles.errorText}>{nameError}</Text> : null}
            </View>
            <View style={{ borderBottomWidth: 1, borderColor: colors.line }}>
              <Text style={{ color: colors.fg3, fontSize: 12 }}>EMAIL</Text>
              <TextInput
                ref={emailRef}
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
                textContentType="newPassword"
                autoComplete="new-password"
                returnKeyType="next"
                onSubmitEditing={() => confirmPasswordRef.current?.focus()}
              />
              {passwordError ? <Text style={styles.errorText}>{passwordError}</Text> : null}
            </View>
            <View style={{ borderBottomWidth: 1, borderColor: colors.line }}>
              <Text style={{ color: colors.fg3, fontSize: 12 }}>CONFIRM PASSPHRASE</Text>
              <TextInput
                ref={confirmPasswordRef}
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secureTextEntry={true}
                placeholder="..."
                placeholderTextColor={colors.fg4}
                style={styles.textInput}
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="newPassword"
                autoComplete="new-password"
                returnKeyType="done"
                onSubmitEditing={handleSignUp}
              />
              {confirmPasswordError ? <Text style={styles.errorText}>{confirmPasswordError}</Text> : null}
            </View>
          </View>
        </View>
        <View style={styles.modalButtonsColumn}>
          <Btn
            label="Continue"
            loading={isLoading}
            onPress={handleSignUp}
          />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
