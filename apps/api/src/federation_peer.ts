import { logger } from "@musubi/config";
import { isCompatibleVersion, MIN_PEER_VERSION } from "@musubi/types";
import { federationFetch } from "./federation_origin";

const PEER_TIMEOUT_MS = 8_000;

/**
 * What another Musubi server says it is.
 *
 * `version` is null when the server answered but named no version, which means
 * something older than the field or something that is not Musubi at all.
 * A compatible version is required before sending product requests.
 */
export type Peer = { version: string | null };

export async function readPeer(origin: string): Promise<Peer | null> {
  try {
    const response = await federationFetch(`${origin}/api/v1/server`, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    return { version: typeof body.version === "string" ? body.version : null };
  } catch {
    // Unreachable, slow, or not JSON is not evidence of compatibility.
    return null;
  }
}

/**
 * Why this server will not federate with that one, or null when it will.
 *
 * K06 requires a coordinated peer upgrade: legacy writes lack event revisions.
 * Unknown versions fail closed without deleting existing connections/cache.
 */
export async function peerTooOld(origin: string): Promise<string | null> {
  const peer = await readPeer(origin);

  if (!peer?.version) {
    logger.warn("federation.peer.unversioned", { server: origin });
    return `That server's version could not be verified. Federation needs Musubi ${MIN_PEER_VERSION} or newer.`;
  }
  if (isCompatibleVersion(peer.version, MIN_PEER_VERSION)) return null;

  logger.warn("federation.peer.too_old", {
    minimum: MIN_PEER_VERSION,
    server: origin,
    version: peer.version,
  });
  return (
    `That server runs Musubi ${peer.version}. Connecting needs ` +
    `${MIN_PEER_VERSION} or newer — its owner has to update it first.`
  );
}
