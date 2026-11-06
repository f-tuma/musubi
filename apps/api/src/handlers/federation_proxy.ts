import { getMusubiAccounts } from "@musubi/db";
import { BadRequestError, CLIENT_VERSION_HEADER, MIN_PEER_VERSION, NotFoundError } from "@musubi/types";
import { peerTooOld } from "../federation_peer";
import { Request, Response } from "express";
import { logger } from "@musubi/config";
import { assertPublicOrigin, canonicalHttpOrigin, federationFetch } from "../federation_origin";
import { connectionMemberToken } from "../federation_connections";

// Federation gateway (ADR-005). Clients never hold the member token: they call
// their OWN server with their normal session and this forwards the request to
// the origin server with the decrypted credential attached.
//
//   ANY /api/v1/federation/s/:connectionId/api/v1/...  ->  {server}/api/v1/...
//
// The target origin comes from the caller's own `musubi_accounts` row, never
// from the request — that is what keeps this from being an open proxy.
// Authorization still happens on the origin server via calendar_members; this
// only carries authentication.

const UPSTREAM_TIMEOUT_MS = 20_000;
// Defense in depth, not a security boundary: a member token already authenticates
// every requireAuth route on the origin, so the user could reach these paths
// directly. Keeping the gateway to /api/v1 stops it proxying /api/auth/*.
const ALLOWED_PREFIX = "/api/v1/";

function upstreamPath(req: Request): string {
  // Express 5 named wildcard: string or array of segments depending on match.
  const raw = (req.params as Record<string, unknown>).rest;
  const joined = Array.isArray(raw) ? raw.join("/") : String(raw ?? "");
  return joined.replace(/^\/+/, "");
}

/**
 * Build the upstream URL for a client-supplied path, or throw.
 *
 * Both checks run on the RESOLVED url, never on the raw string: `api/v1/../../x`
 * passes a naive prefix test but normalizes to `/x`, and `//evil.com/...` would
 * silently change host.
 */
export function gatewayTarget(origin: string, path: string, query = ""): URL {
  let target: URL;
  try {
    target = new URL(`${origin}/${path.replace(/^\/+/, "")}${query}`);
  } catch {
    throw new BadRequestError("The gateway path is not a valid URL.");
  }

  if (target.origin !== origin) {
    throw new BadRequestError("The gateway path must stay on the connected server.");
  }
  if (!target.pathname.startsWith(ALLOWED_PREFIX)) {
    throw new BadRequestError("Only /api/v1 paths can be reached through the gateway.");
  }
  return target;
}

export async function handlerFederationProxy(req: Request, res: Response) {
  const connectionId = req.params.connectionId as string;
  const accounts = await getMusubiAccounts(req.user!.id);
  const account = accounts.find((row) => row.id === connectionId);
  if (!account) throw new NotFoundError("Federated connection not found.");

  const origin = canonicalHttpOrigin(account.server);
  if (!origin) throw new BadRequestError("This connection has an invalid server origin.");

  const query = req.originalUrl.includes("?")
    ? req.originalUrl.slice(req.originalUrl.indexOf("?"))
    : "";
  const target = gatewayTarget(origin, upstreamPath(req), query);

  await assertPublicOrigin(origin);
  const incompatible = await peerTooOld(origin);
  if (incompatible) return res.status(426).json({
    error: "PeerUpgradeRequired", message: incompatible,
    minPeerVersion: MIN_PEER_VERSION, requestId: req.requestId,
  });

  // Only what the origin needs. The home session cookie is deliberately dropped
  // and Authorization is replaced with the member token.
  const headers = new Headers({
    accept: req.get("accept") ?? "application/json",
    // Rotates the credential first when it is close to expiry — clients no
    // longer own that lifecycle.
    authorization: `Bearer ${await connectionMemberToken(req.user!.id, account, origin)}`,
  });
  const clientVersion = req.get(CLIENT_VERSION_HEADER);
  if (clientVersion) headers.set(CLIENT_VERSION_HEADER, clientVersion);
  const mutationID = req.get("Idempotency-Key");
  if (mutationID) headers.set("Idempotency-Key", mutationID);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  if (hasBody) headers.set("content-type", "application/json");

  let upstream: globalThis.Response;
  try {
    upstream = await federationFetch(target, {
      body: hasBody && req.body !== undefined ? JSON.stringify(req.body) : undefined,
      headers,
      method: req.method,
      redirect: "manual", // a redirect must not carry the credential elsewhere
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn("federation.gateway.unreachable", {
      connectionId: account.id,
      error: error instanceof Error ? error.message : String(error),
      server: origin,
    });
    // 502: the caller's request was fine, the origin server was not.
    return res.status(502).json({
      error: "FederatedServerUnreachable",
      message: "The connected Musubi server could not be reached.",
      requestId: req.requestId,
      server: origin,
    });
  }

  // Relay only the content type — never upstream cookies or auth headers.
  const contentType = upstream.headers.get("content-type");
  if (contentType) res.setHeader("Content-Type", contentType);
  const payload = await upstream.text();
  return res.status(upstream.status).send(payload);
}
