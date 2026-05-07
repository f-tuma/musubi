import { ServerProvider, useServer } from '@/contexts/ServerContext';
import { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { SplashScreen } from 'expo-router';
import { useFonts } from 'expo-font';
import { InterTight_400Regular, InterTight_500Medium } from '@expo-google-fonts/inter-tight';
import { NotoSerif_400Regular } from '@expo-google-fonts/noto-serif';
import { ShipporiMinchoB1_400Regular } from '@expo-google-fonts/shippori-mincho-b1';


SplashScreen.preventAutoHideAsync();

function AppContent() {

  const { isLoading, authClient } = useServer();

  const [loaded, error] = useFonts({
    InterTight_400Regular,
    InterTight_500Medium,
    NotoSerif_400Regular,
    ShipporiMinchoB1_400Regular,
  });

  const router = useRouter();
  const segments = useSegments();
  const inAuthGroup = segments[0] === "(auth)";
  const inInviteGroup = segments[0] === "invite";

  const { data: session, isPending } = authClient.useSession();

  useEffect(() => {
    if ((loaded || error) && !isPending && !isLoading) {
      SplashScreen.hideAsync();
    }
  }, [loaded, error, isPending, isLoading]);

  useEffect(() => {
    if (isPending || !loaded) return;
    if (!session && !inAuthGroup && !inInviteGroup) {
      router.replace("/(auth)/welcome");
    }
    if (session && inAuthGroup) {
      router.replace("/(tabs)");
    }
  }, [session, loaded, isPending, inAuthGroup]);

  if (!loaded && !error || isPending) return null;

  return (
    < Stack screenOptions={{ headerShown: false }} />
  );
}

function AppLoader() {
  const { apiUrl } = useServer();
  return <AppContent key={apiUrl ?? 'loading'} />;
}

export default function RootLayout() {
  return (
    <ServerProvider>
      <AppLoader />
    </ServerProvider>
  );
}
