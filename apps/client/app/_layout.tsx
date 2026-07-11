import { ServerProvider, useServer } from '@/contexts/ServerContext';
import { useEffect, useRef, useState } from 'react';
import { View, useColorScheme } from 'react-native';
import { useSettingsStore } from '@/store/useSettingsStore';
import { applyTheme, activeScheme } from '@/constants/theme';
import { Stack, SplashScreen, useRouter, usePathname } from 'expo-router';
import { useFonts } from 'expo-font';
import { InterTight_400Regular, InterTight_500Medium } from '@expo-google-fonts/inter-tight';
import { NotoSerif_400Regular } from '@expo-google-fonts/noto-serif';
import { ShipporiMinchoB1_400Regular } from '@expo-google-fonts/shippori-mincho-b1';
import { colors, styles } from '@/constants/theme';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ToastHost } from '@/components/ui/Toast';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import semver from "semver";
import Constants from "expo-constants";
import UpdateRequiredModal from "@/components/UpdateRequiredModal";
import { registerForPushNotificationsAsync } from '@/services/notifications';
import { apiVersion } from '@/constants/url';
import * as Linking from 'expo-linking';
import { File } from 'expo-file-system';
import { parseICS } from '@/lib/ics';
import { useImportStore } from '@/store/useImportStore';

import { useMigrations } from 'drizzle-orm/expo-sqlite/migrator';
import { db } from '@/services/db';
import migrations from '@/drizzle/migrations';

SplashScreen.preventAutoHideAsync();

// An .ics opened via the OS ("Open in Musubi") arrives as a file/content/http
// URL. Read it, parse the first event, and stash it for the calendar screen.
async function readIcs(url: string): Promise<string | null> {
  try {
    if (url.startsWith('http')) return await (await fetch(url)).text();
    return await new File(url).text(); // file:// (iOS inbox, Android file) + content:// (SAF)
  } catch {
    // ponytail: some Android OEMs reject File.text() on content://; fetch as fallback.
    try { return await (await fetch(url)).text(); } catch { return null; }
  }
}

async function handleIncomingUrl(url: string | null) {
  if (!url) return;
  // Only .ics imports here — app-links (/invite) stay with expo-router.
  const isIcs = /\.ics(\?|$)/i.test(url) || url.startsWith('content:') || url.startsWith('file:');
  if (!isIcs) return;
  const text = await readIcs(url);
  const draft = text ? parseICS(text) : null;
  if (draft) useImportStore.getState().setPending(draft);
}

function AppContent() {
  const { success: migrated, error: migError } = useMigrations(db, migrations);
  useEffect(() => {
    if (migError) console.error("Migration failed:", migError);
  }, [migError]);

  const { isLoading, authClient, apiUrl } = useServer();
  const router = useRouter();

  const [loaded, error] = useFonts({
    InterTight_400Regular,
    InterTight_500Medium,
    NotoSerif_400Regular,
    ShipporiMinchoB1_400Regular,
  });

  const { data: session, isPending } = authClient.useSession();

  const [versionChecked, setVersionChecked] = useState(false);
  const [updateRequired, setUpdateRequired] = useState(false);
  const [requiredVersion, setRequiredVersion] = useState("");

  useEffect(() => {
    if (!apiUrl) {
      setVersionChecked(true);
      return;
    }
    fetch(`${apiUrl}/api/${apiVersion}/server`)
      .then(r => r.json())
      .then(({ minClientVersion }: { minClientVersion: string }) => {
        const clientVersion = Constants.expoConfig?.version ?? "0.0.0";
        if (semver.lt(clientVersion, minClientVersion)) {
          setRequiredVersion(minClientVersion);
          setUpdateRequired(true);
        }
      })
      .catch(() => { })
      .finally(() => setVersionChecked(true));
  }, [apiUrl]);

  const ready = (loaded || !!error) && !isPending && !isLoading && versionChecked && migrated;

  const everReady = useRef(false);
  if (ready) everReady.current = true;

  const navigated = useRef(false);
  const pathname = usePathname();
  useEffect(() => {
    if (!ready || navigated.current || updateRequired) return;
    navigated.current = true;
    // Cold start via a deep link (invite/[token], …) already landed on its
    // route — replacing it with the tabs would close the screen under the user.
    if (session && pathname.startsWith('/invite')) return;
    router.replace(session ? '/(tabs)' : '/(auth)/welcome');
  }, [ready, updateRequired]);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  // Handle .ics files opened via the OS (cold start + while running).
  useEffect(() => {
    Linking.getInitialURL().then(handleIncomingUrl);
    const sub = Linking.addEventListener('url', ({ url }) => handleIncomingUrl(url));
    return () => sub.remove();
  }, []);

  if (!everReady.current) return null;

  if (updateRequired) {
    return (
      <UpdateRequiredModal
        currentVersion={Constants.expoConfig?.version ?? "0.0.0"}
        requiredVersion={requiredVersion}
      />
    );
  }

  return (
    <Stack screenOptions={{ statusBarStyle: activeScheme === 'dark' ? 'light' : 'dark', navigationBarHidden: true, headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
  );
}

function AppLoader() {
  const { apiUrl } = useServer();

  // Theme comes straight from the settings store, which seeds itself
  // SYNCHRONOUSLY from the local SQLite snapshot (see useSettingsStore) — the
  // very first frame is already in the last-known theme, no flash of the
  // system theme (or a blank window) while anything loads.

  // Resolve the theme: user preference wins, "system" follows the device.
  const deviceScheme = useColorScheme();
  const themePref = useSettingsStore(s => s.theme);
  const scheme = themePref === 'system' ? (deviceScheme === 'light' ? 'light' : 'dark') : themePref;

  // Swap the palette BEFORE children render. Plain call, NOT useMemo — the
  // React Compiler assumes memo callbacks are pure and eliminates unused ones,
  // which silently dropped this side effect. Idempotent, so calling every
  // render is fine; key={scheme} below remounts the tree to repaint.
  applyTheme(scheme);

  useEffect(() => {
    SystemUI.setBackgroundColorAsync(colors.bg);
  }, [scheme]);

  return (
    <SafeAreaView key={scheme} style={styles.screen} edges={['top', 'left', 'right']}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <AppContent key={apiUrl ?? 'loading'} />
      </View>
    </SafeAreaView>
  );
}

export default function RootLayout() {

  useEffect(() => {
    registerForPushNotificationsAsync();
  }, []);


  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ServerProvider>
        <AppLoader />
      </ServerProvider>
      <ToastHost />
    </GestureHandlerRootView>
  );
}
