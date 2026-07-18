import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { colors, fonts, styles } from "@/constants/theme";
import { useApi } from "@/services/api";
import { useServer } from "@/contexts/ServerContext";
import { Btn } from "@/components/ui/Btn";
import { Tap } from "@/components/ui/Tap";
import { Avatar } from "@/components/Avatar";
import { OnboardingScaffold } from "@/components/OnboardingScaffold";
import { pickAvatarBase64 } from "@/lib/avatar";
import * as haptics from "@/lib/haptics";
import { Feather } from "@expo/vector-icons";
import { showToast } from "@/components/ui/Toast";
import { userFacingError } from "@/lib/network";

// Onboarding step 1 — who you are. Google users can override the name and
// photo that came with their account.
export default function OnboardingProfile() {
  const api = useApi();
  const { authClient } = useServer();
  const { data: session } = authClient.useSession();

  const [name, setName] = useState<string | null>(null); // null = untouched
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const shownName = name ?? session?.user.name ?? "";

  const pickAvatar = async () => {
    setAvatarBusy(true);
    try {
      const base64 = await pickAvatarBase64();
      if (!base64) return; // cancelled
      const url = await api.uploadAvatar(base64);
      await authClient.updateUser({ image: url });
      setAvatarUri(url);
    } catch (e) {
      haptics.warn();
      console.error("Avatar upload failed:", e);
      showToast({ message: userFacingError(e, "Could not upload your photo.") });
    } finally {
      setAvatarBusy(false);
    }
  };

  const continueNext = async () => {
    setBusy(true);
    try {
      const trimmed = shownName.trim();
      if (trimmed && trimmed !== session?.user.name) {
        await authClient.updateUser({ name: trimmed });
      }
    } catch (e) {
      haptics.warn();
      console.error("Profile update failed:", e); // don't trap them — fixable later
      showToast({ message: userFacingError(e, "Your profile will be saved later.") });
    } finally {
      setBusy(false);
      router.push("/onboarding/calendar" as any);
    }
  };

  return (
    <OnboardingScaffold
      step={1}
      kanji="結"
      title="Welcome to Musubi"
      subtitle="First — how should others see you?"
      actions={<Btn label="Continue" onPress={continueNext} loading={busy} />}
    >
      <View style={{ alignItems: "center", paddingBottom: 8 }}>
        <Tap onPress={pickAvatar} disabled={avatarBusy} scaleTo={0.95}>
          <View style={{ opacity: avatarBusy ? 0.5 : 1 }}>
            <Avatar name={shownName || "?"} image={avatarUri ?? session?.user.image} size={96} />
            <View style={{
              position: "absolute", right: -2, bottom: -2,
              width: 30, height: 30, borderRadius: 15,
              backgroundColor: colors.fill, alignItems: "center", justifyContent: "center",
              borderWidth: 2, borderColor: colors.bg,
            }}>
              <Feather name="camera" size={14} color={colors.onFill} />
            </View>
          </View>
        </Tap>
        <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.fg4, marginTop: 10 }}>
          Tap to add a photo (optional)
        </Text>
      </View>

      <View style={styles.fieldContainer}>
        <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Display name</Text>
        <TextInput
          value={shownName}
          onChangeText={setName}
          placeholder="Your name"
          placeholderTextColor={colors.fg4}
          autoCapitalize="words"
          style={[styles.fieldValueBig, { fontFamily: fonts.sans }]}
        />
        <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.fg4, marginTop: 8 }}>
          This is the name calendar members will see.
        </Text>
      </View>
    </OnboardingScaffold>
  );
}
