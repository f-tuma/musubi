import { Redirect } from 'expo-router';
import { useServer } from '@/contexts/ServerContext';

export default function Index() {
  const { authClient } = useServer();
  const { data: session } = authClient.useSession();

  if (session) return <Redirect href="/(tabs)" />;
  return <Redirect href="/(auth)/welcome" />;
}
