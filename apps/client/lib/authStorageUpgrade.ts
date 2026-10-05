import * as SecureStore from "expo-secure-store";
import { migrate } from "drizzle-orm/expo-sqlite/migrator";
import migrations from "@/drizzle/migrations";
import { db } from "@/services/db";
import { prepareAccountCache } from "./accountCache";

const STORAGE_VERSION_KEY = "musubi_auth_storage_version";
const STORAGE_VERSION = "2";

let pending: Promise<void> | null = null;

/** The new auth namespace cannot identify the owner of the old global cache. */
export function prepareAuthStorage() {
  // React may initialize a provider twice. Both must wait for the same wipe;
  // a second cleanup must never race the first newly authenticated account.
  pending ??= upgrade().finally(() => { pending = null; });
  return pending;
}

async function upgrade() {
  if (await SecureStore.getItemAsync(STORAGE_VERSION_KEY) === STORAGE_VERSION) return;
  // A fresh install has no cache tables yet. Finish the normal SQLite migrations
  // before resetting either it or the older installation's reminder receipts.
  await migrate(db, migrations);
  await prepareAccountCache(null);
  // A failed wipe must retry at the next launch, before creating any auth client
  // or allowing a different account to hydrate the previous account's data.
  await SecureStore.setItemAsync(STORAGE_VERSION_KEY, STORAGE_VERSION);
}
