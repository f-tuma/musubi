/** Private routing hints only. A hit is never collection, ACL or cursor proof. */
export type CaldavDiscoveryMaterial = Readonly<{
  rootUrl: string;
  principalUrl: string;
  homeUrl: string;
}>;

export type CaldavMaterialBinding = Readonly<{
  userID: string;
  accountID: string;
  credentialRevision: string;
  credentialFingerprint: string;
  policyFingerprint: string;
}>;

export type CaldavMaterialSession = Readonly<{
  material?: CaldavDiscoveryMaterial;
  commit(material: CaldavDiscoveryMaterial): void;
  invalidate(): void;
}>;

/** Copy only the three route scalars; never retain a DAV account/client. Every
 * target still passes the current guarded network boundary when it is used. */
export function copyCaldavDiscoveryMaterial(value: CaldavDiscoveryMaterial): CaldavDiscoveryMaterial {
  const copied = {} as { -readonly [K in keyof CaldavDiscoveryMaterial]: string };
  for (const key of ["rootUrl", "principalUrl", "homeUrl"] as const) {
    const raw = value[key];
    if (typeof raw !== "string" || raw.length > 8192) throw new Error("Invalid CalDAV routing material.");
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
      throw new Error("Invalid CalDAV routing material.");
    copied[key] = url.href;
  }
  return Object.freeze(copied);
}

/** Process-local, bounded cache. Fresh binding is read by the host on every
 * begin. A ticket prevents an old/failed concurrent attempt from publishing or
 * evicting a newer binding. Expiry uses monotonic time and grants no authority. */
export function createCaldavDiscoveryMaterialCache({
  capacity = 256,
  ttlMs = 300_000,
  now = () => performance.now(),
}: { capacity?: number; ttlMs?: number; now?: () => number } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isFinite(ttlMs) || ttlMs <= 0)
    throw new Error("Invalid CalDAV routing cache configuration.");
  type Entry = { binding: string; ticket: object; expiresAt: number; material?: CaldavDiscoveryMaterial };
  const entries = new Map<string, Entry>();
  const clock = () => {
    const value = now();
    if (!Number.isFinite(value) || value < 0) throw new Error("Invalid CalDAV routing cache clock.");
    return value;
  };
  return {
    begin(binding: CaldavMaterialBinding, { refresh = false }: { refresh?: boolean } = {}): CaldavMaterialSession {
      for (const value of Object.values(binding)) {
        if (typeof value !== "string" || !value || value.length > 8192)
          throw new Error("Invalid CalDAV routing cache binding.");
      }
      const key = JSON.stringify([binding.userID, binding.accountID]);
      const incarnation = JSON.stringify([binding.credentialRevision, binding.credentialFingerprint, binding.policyFingerprint]);
      const currentTime = clock(), prior = entries.get(key), ticket = {};
      const material = !refresh && prior?.binding === incarnation && prior.expiresAt > currentTime
        ? prior.material : undefined;
      const entry: Entry = { binding: incarnation, ticket, material, expiresAt: material ? prior!.expiresAt : 0 };
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > capacity) entries.delete(entries.keys().next().value!);
      let closed = false;
      return Object.freeze({
        ...(material ? { material: copyCaldavDiscoveryMaterial(material) } : {}),
        commit(value: CaldavDiscoveryMaterial) {
          if (closed || entries.get(key)?.ticket !== ticket) return;
          const owned = copyCaldavDiscoveryMaterial(value);
          entry.material = owned;
          // A collection read does not re-prove principal/home routing. Only
          // actual endpoint discovery starts a new lifetime for those hints.
          entry.expiresAt = material ? entry.expiresAt : clock() + ttlMs;
          closed = true;
        },
        invalidate() {
          closed = true;
          if (entries.get(key)?.ticket === ticket) entries.delete(key);
        },
      });
    },
  };
}
