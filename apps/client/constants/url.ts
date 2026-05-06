import * as SecureStore from "expo-secure-store";


export let apiUrl = SecureStore.getItem("API_URL")!;

export function updateApiUrl() {
  apiUrl = SecureStore.getItem("API_URL")!;
}
