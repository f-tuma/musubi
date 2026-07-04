import { ServerProvider, useServer } from '@/contexts/ServerContext';
import { useEffect, useMemo, useRef, useState } from 'react';
import { View, useColorScheme } from 'react-native';
import { useSettingsStore } from '@/store/useSettingsStore';
import { applyTheme, activeScheme } from '@/constants/theme';
import { Stack, SplashScreen, useRouter } from 'expo-router';
import { useFonts } from 'expo-font';
import { InterTight_400Regular, InterTight_500Medium } from '@expo-google-fonts/inter-tight';
import { NotoSerif_400Regular } from '@expo-google-fonts/noto-serif';
import { ShipporiMinchoB1_400Regular } from '@expo-google-fonts/shippori-mincho-b1';
import { colors, styles } from '@/constants/theme';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import semver from "semver";
import Constants from "expo-constants";
import UpdateRequiredModal from "@/components/UpdateRequiredModal";
import { registerForPushNotificationsAsync } from '@/services/notifications';

import { useMigrations } from 'drizzle-orm/expo-sqlite/migrator';
import { db } from '@/services/db';
import migrations from '@/drizzle/migrations';

SplashScreen.preventAutoHideAsync();

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
    fetch(`${apiUrl}/api/server`)
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
  useEffect(() => {
    if (!ready || navigated.current || updateRequired) return;
    navigated.current = true;
    router.replace(session ? '/(tabs)' : '/(auth)/welcome');
  }, [ready, updateRequired]);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

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

  // Resolve the theme: user preference wins, "system" follows the device.
  const deviceScheme = useColorScheme();
  const themePref = useSettingsStore(s => s.theme);
  const scheme = themePref === 'system' ? (deviceScheme === 'light' ? 'light' : 'dark') : themePref;

  // Swap the palette BEFORE children render (useMemo runs during render);
  // key={scheme} below remounts the tree so every style re-reads it.
  useMemo(() => applyTheme(scheme), [scheme]);

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
    <ServerProvider>
      <AppLoader />
    </ServerProvider>
  );
}
