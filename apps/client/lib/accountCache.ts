import * as SecureStore from "expo-secure-store";
import { normalizeServerUrl } from "./serverUrl";
import { resetLocalAccountState } from "./signOut";

export type AccountCacheOwner = string | null;
const OWNER_KEY = "musubi_account_cache_owner";
let queue: Promise<void> = Promise.resolve();
let pending: { owner: AccountCacheOwner; promise: Promise<void> } | null = null;

export function accountCacheOwner(apiUrl: string, userId?: string | null): AccountCacheOwner {
  return userId ? JSON.stringify([normalizeServerUrl(apiUrl), userId]) : null;
}

/** No signed-in UI may read the global mirror until this owner is prepared. */
export function prepareAccountCache(owner: AccountCacheOwner) {
  if (pending?.owner === owner) return pending.promise;
  const promise = queue.then(async () => {
    const stored = await SecureStore.getItemAsync(OWNER_KEY);
    // Retain a proven actor's mirror for offline restarts. Signed-out starts
    // always erase account data before welcome, even if a former session expired
    // while the app was closed and the normal tab sign-out handler never ran.
    if (owner !== null && stored === owner) return;
    await resetLocalAccountState({ requireNotificationCancellation: true });
    await SecureStore.setItemAsync(OWNER_KEY, owner ?? "null");
  });
  queue = promise.catch(() => undefined);
  pending = { owner, promise };
  const clear = () => { if (pending?.promise === promise) pending = null; };
  void promise.then(clear, clear);
  return promise;
}
