import { createAuthClient } from "better-auth/react";
import { expoClient } from "@better-auth/expo/client";
import * as SecureStore from "expo-secure-store";


export function createClient(url: string) {
  return createAuthClient({
    baseURL: url,
    plugins: [
      expoClient({
        scheme: "musubi",
        storagePrefix: "musubi",
        storage: SecureStore,
      })
    ]
  });
}
