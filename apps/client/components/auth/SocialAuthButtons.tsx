import { colors, fonts } from "@/constants/theme";
import { useServer } from "@/contexts/ServerContext";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Platform, Text, View } from "react-native";
import { Btn } from "@/components/ui/Btn";
import { warn } from "@/lib/haptics";
import { GoogleSignin, isSuccessResponse } from "@react-native-google-signin/google-signin";
import * as AppleAuthentication from "expo-apple-authentication";
import Svg, { Path } from "react-native-svg";
import { fetchWithTimeout, userFacingError } from "@/lib/network";
import { takePendingInviteHref } from "@/lib/pendingInvite";

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

// Google/Apple sign-in buttons, gated on what the (possibly self-hosted)
// server supports — shared by the dedicated sign-in and sign-up screens.
// Social sign-in doubles as sign-up, which is why both screens show these.
// `separatorLabel` renders an "── or ──" divider under the buttons (only when
// at least one button is visible).
export default function SocialAuthButtons({ separatorLabel }: { separatorLabel?: string }) {
  const { authClient, apiUrl } = useServer();
  const router = useRouter();
  const [socials, setSocials] = useState<string[]>([]);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [appleBusy, setAppleBusy] = useState(false);

  // Ask the server which social logins it supports and show only those
  // buttons. Refetches when the user points at a new server.
  useEffect(() => {
    if (!apiUrl) return;
    fetchWithTimeout(`${apiUrl}/api/v1/server`)
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
          alert(userFacingError(error, "Google sign-in failed."));
        } else {
          router.replace((await takePendingInviteHref() ?? "/(tabs)") as any);
        }
      } else {
        warn();
        alert(`Not success: ${response?.type}`);
      }
    } catch (e: any) {
      warn();
      alert(userFacingError(e, "Google sign-in failed."));
    } finally {
      setGoogleBusy(false);
    }
  };

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
      // Apple returns the name ONLY on the first authorization, and NOT inside
      // the token — forward it in `user.name` so Better Auth sets it on the new
      // user (which then pre-fills the onboarding name). Nothing to forward on
      // later sign-ins; the name is already stored. Apple never returns a photo.
      const fn = credential.fullName;
      const nameProvided = !!(fn?.givenName || fn?.familyName);
      // ponytail: no nonce — signature + audience + 1h maxAge already verified
      // server-side; add a nonce round-trip if replay hardening is needed.
      const { error } = await authClient.signIn.social({
        provider: "apple",
        idToken: {
          token: credential.identityToken,
          ...(nameProvided && {
            user: { name: { firstName: fn?.givenName ?? undefined, lastName: fn?.familyName ?? undefined } },
          }),
        },
      });
      if (error) {
        warn();
        alert(userFacingError(error, "Apple sign-in failed."));
      } else {
        router.replace((await takePendingInviteHref() ?? "/(tabs)") as any);
      }
    } catch (e: any) {
      if (e?.code === "ERR_REQUEST_CANCELED") return; // user backed out — not an error
      warn();
      alert(userFacingError(e, "Apple sign-in failed."));
    } finally {
      setAppleBusy(false);
    }
  };

  const showGoogle = socials.includes("google");
  const showApple = Platform.OS === "ios" && socials.includes("apple");
  if (!showGoogle && !showApple) return null;

  return (
    <View style={{ gap: 12 }}>
      {/* No hardcoded background — secondary follows the theme, so the
          label stays readable in both light and dark mode. */}
      {showGoogle && (
        <Btn
          label="Continue with Google"
          variant="secondary"
          icon={<GoogleG size={18} />}
          loading={googleBusy}
          onPress={handleGoogle}
        />
      )}
      {showApple && (
        <Btn
          label="Continue with Apple"
          variant="secondary"
          icon={<AppleLogo size={18} />}
          loading={appleBusy}
          onPress={handleApple}
        />
      )}
      {separatorLabel && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 4 }}>
          <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
          <Text style={{ color: colors.fg3, fontFamily: fonts.serif, fontSize: 14 }}>{separatorLabel}</Text>
          <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
        </View>
      )}
    </View>
  );
}
