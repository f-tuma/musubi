import { createAuthClient } from "better-auth/react";
import { expoClient } from "@better-auth/expo/client";
import { apiUrl } from "@/constants/url";
import * as SecureStore from "expo-secure-store";


export let authClient = createAuthClient({
  baseURL: apiUrl,
  plugins: [
    expoClient({
      scheme: "musubi",
      storagePrefix: "musubi",
      storage: SecureStore,
    })
  ]
});

export function updateAuthClient() {
  authClient = createAuthClient({
    baseURL: apiUrl,
    plugins: [
      expoClient({
        scheme: "musubi",
        storagePrefix: "musubi",
        storage: SecureStore,
      })
    ]
  });
}
