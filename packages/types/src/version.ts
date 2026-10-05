/**
 * The product version, mirrored from the root manifest.
 *
 * Not imported from `package.json`: the API ships as a `pnpm deploy` closure
 * with no repository root above it, so there is nothing to import at runtime.
 * `scripts/verify-release.mjs` asserts this string matches instead — the drift
 * it now prevents is real, this file's predecessor sat two releases behind the
 * product it claimed to be.
 */
export const PRODUCT_VERSION = "0.2.2";

/**
 * The oldest web/native requester this server will serve.
 *
 * Raising it locks every older install out until its owner updates from the
 * store, so it moves only when a release genuinely cannot serve them — see
 * `docs/releasing.md`.
 */
export const MIN_CLIENT_VERSION = "0.2.0";
export const CLIENT_VERSION_HEADER = "x-musubi-client-version";

export function isCompatibleVersion(value: unknown, minimum: string): value is string {
 return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value) &&
  value.split(".").every((part) => Number.isSafeInteger(Number(part))) &&
  compareVersions(value, minimum) >= 0;
}

/**
 * The oldest Musubi server this one will federate with.
 *
 * Federation is a fourth clock: the server at the other end updates when its
 * owner feels like it, and nothing here can make that happen. Refusing at
 * connect time, by name, beats a handshake that fails later for reasons nobody
 * can read — see `docs/releasing.md`.
 */
export const MIN_PEER_VERSION = "0.2.0";

/**
 * Order two X.Y.Z versions. Negative when `left` is older.
 *
 * Numeric on purpose: compared as strings, "0.1.10" sorts before "0.1.9".
 * Anything unparsable ranks as 0, so a malformed version reads as ancient
 * rather than as newer than everything.
 */
export function compareVersions(left: string, right: string): number {
 const rank = (version: string) =>
  version.split(".").map((part) => Number(part) || 0);
 const a = rank(left);
 const b = rank(right);
 for (let index = 0; index < 3; index += 1) {
  const difference = (a[index] ?? 0) - (b[index] ?? 0);
  if (difference !== 0) return difference;
 }
 return 0;
}
