import { createContext, useContext, useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { createClient } from "@/services/auth-client";
import { defaultUrl } from "@/constants/url";
import { normalizeServerUrl } from "@/lib/serverUrl";
import { resetLocalAccountState } from "@/lib/signOut";
import { recordServerDiagnostic } from "@/lib/serverDiagnostics";
import { prepareAuthStorage } from "@/lib/authStorageUpgrade";

type ServerContextType = {
  apiUrl: string;
  authClient: ReturnType<typeof createClient>;
  setNewServerUrl: (url: string) => Promise<void>;
}

const ServerContext = createContext<ServerContextType | null>(null);

export function ServerProvider({ children }: { children: React.ReactNode }) {
  const [server, setServer] = useState<{
    apiUrl: string;
    authClient: ReturnType<typeof createClient>;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const getApiUrl = async () => {
      const retrievedApiUrl = await SecureStore.getItemAsync("API_URL");
      const url = normalizeServerUrl(retrievedApiUrl ?? defaultUrl);
      recordServerDiagnostic(`selected ${url} (stored: ${retrievedApiUrl ?? "none"})`);
      await prepareAuthStorage();
      if (cancelled) return;
      setServer({ apiUrl: url, authClient: createClient(url) });
    };
    void getApiUrl().catch(error => {
      if (!cancelled) console.error("Could not prepare local account storage:", error);
    });
    return () => { cancelled = true; };
  }, []);

  const setNewServerUrl = async (url: string) => {
    const normalized = normalizeServerUrl(url);
    recordServerDiagnostic(`switch ${server?.apiUrl ?? "none"} → ${normalized}`);
    // A server is an account boundary: never display one server's cached data
    // or reuse its Better Auth session on another.
    await resetLocalAccountState();
    await SecureStore.setItemAsync("API_URL", normalized);
    setServer({ apiUrl: normalized, authClient: createClient(normalized) });
  };

  if (!server) return null;

  return (
    <ServerContext.Provider value={{ ...server, setNewServerUrl }}>
      {children}
    </ServerContext.Provider>
  );
}

export function useServer() {
  const context = useContext(ServerContext);
  if (!context) throw new Error("useServer must be used within a ServerProvider");
  return context;
}


