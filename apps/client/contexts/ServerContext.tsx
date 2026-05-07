import { createContext, useContext, useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { createClient } from "@/services/auth-client";
import { defaultUrl } from "@/constants/url";

type ServerContextType = {
  apiUrl: string | null;
  authClient: ReturnType<typeof createClient>;
  setNewServerUrl: (url: string) => void;
  isLoading: boolean;
}

const ServerContext = createContext<ServerContextType | null>(null);

export function ServerProvider({ children }: { children: React.ReactNode }) {
  const [apiUrl, setApiUrl] = useState<string | null>(null);
  const [authClient, setAuthClient] = useState<ReturnType<typeof createClient>>(() => createClient(defaultUrl));
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const getApiUrl = async () => {
      setIsLoading(true);
      const retrievedApiUrl = await SecureStore.getItemAsync("API_URL");
      const url = retrievedApiUrl?.toLowerCase() ?? defaultUrl;
      setApiUrl(url);
      setAuthClient(() => createClient(url));
      setIsLoading(false);
    };
    getApiUrl();
  }, []);

  const setNewServerUrl = (url: string) => {
    const normalized = url.toLowerCase();
    SecureStore.setItem("API_URL", normalized);
    setAuthClient(() => createClient(normalized));
    setApiUrl(normalized);
  };

  return (
    <ServerContext.Provider value={{ apiUrl, authClient, setNewServerUrl, isLoading }}>
      {children}
    </ServerContext.Provider>
  );
}

export function useServer() {
  const context = useContext(ServerContext);
  if (!context) throw new Error("useServer must be used within a ServerProvider");
  return context;
}


