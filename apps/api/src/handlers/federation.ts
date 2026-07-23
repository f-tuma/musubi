import { Request, Response } from "express";
import { z } from "zod";
import {
  addCalendarMember, consumeInvite, createExternalUser, deleteMusubiAccount,
  getCalendar, getCalendarIDFromToken, getMusubiAccounts, getUserByTokenHash,
  replaceMemberToken, rotateMemberToken, upsertMusubiAccount,
} from "@musubi/db";
import { BadRequestError, UnauthorizedError } from "@musubi/types";
import { decryptSecret, encryptSecret } from "../sync/crypto";
import { bearerMemberToken, hashMemberToken, issueMemberToken } from "../federation_tokens";
import { canonicalHttpOrigin } from "../federation_origin";

// Federation (Musubi ↔ Musubi), v1: an invite token doubles as the cross-server
// capability. A user from another server accepts an invite here and becomes a
// NATIVE member through a "shadow account" — a normal `user` row (isExternal)
// carrying their profile. Roles, permissions, member management and event
// attribution then work unchanged; the only new mechanics are this accept
// handshake and member-token authentication (see middleware/require_auth.ts).

const FederationProfileSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  homeServer: z.string().trim(),
  image: z.string().max(2048).nullish(),
});

/**
 * POST /api/v1/federation/accept — public (the invite token IS the credential).
 * Body: { token, profile: { name, email, homeServer, image? } }
 * Verifies the invite, creates a shadow user, adds them as a viewer and issues
 * a bearer member token. An existing shadow identity is reused only when the
 * caller proves control by presenting its current member token. Unverified
 * profile fields therefore cannot bind to somebody else's memberships.
 */
export async function handlerFederationAccept(req: Request, res: Response) {
  const { token, profile } = req.body ?? {};
  if (!token || typeof token !== "string") throw new BadRequestError("Missing invite token...");

  const parsedProfile = FederationProfileSchema.safeParse(profile);
  if (!parsedProfile.success) throw new BadRequestError("Profile needs a valid name, email and homeServer...");
  const { name, email, image } = parsedProfile.data;
  const homeServer = canonicalHttpOrigin(parsedProfile.data.homeServer);
  if (!homeServer) throw new BadRequestError("homeServer must be an http(s) origin...");

  // Same semantics as the native join: token must exist (expired ones are
  // purged hourly); throws NotFound otherwise.
  const calendarID = await getCalendarIDFromToken(token);

  const currentToken = bearerMemberToken(req.headers.authorization);
  let shadow;
  if (currentToken) {
    const proved = await getUserByTokenHash(hashMemberToken(currentToken));
    const provedHome = proved?.homeServer
      ? canonicalHttpOrigin(proved.homeServer)
      : null;
    if (!proved || !proved.isExternal || provedHome !== homeServer) {
      throw new UnauthorizedError("The existing federation credential is invalid.");
    }
    shadow = proved;
  } else {
    // The submitted profile is display-only on first contact. Never look up an
    // existing shadow by these unverified claims.
    shadow = await createExternalUser({ name, email, image, homeServer });
  }

  const added = await addCalendarMember(shadow.id, calendarID); // viewer; conflict-safe on re-accept
  if (added.length > 0) await consumeInvite(token); // burn a use only on a NEW membership

  const issued = issueMemberToken();
  if (currentToken) {
    const rotated = await rotateMemberToken(
      shadow.id,
      hashMemberToken(currentToken),
      issued.tokenHash,
    );
    if (!rotated) {
      throw new UnauthorizedError("The federation credential was already rotated.");
    }
  } else {
    await replaceMemberToken(shadow.id, issued.tokenHash);
  }

  const calendar = await getCalendar(calendarID);
  res.status(200).json({
    memberToken: issued.raw,
    memberTokenExpiresAt: issued.expiresAt.toISOString(),
    userID: shadow.id,
    calendar,
  });
}

/** Exchange a still-valid member token for a fresh 90-day credential. */
export async function handlerFederationRotateToken(req: Request, res: Response) {
  const currentToken = bearerMemberToken(req.headers.authorization);
  const external = req.user as typeof req.user & { isExternal?: boolean };
  if (!currentToken || !external?.isExternal) {
    throw new UnauthorizedError("A federated member token is required.");
  }

  const issued = issueMemberToken();
  const rotated = await rotateMemberToken(
    external.id,
    hashMemberToken(currentToken),
    issued.tokenHash,
  );
  if (!rotated) {
    throw new UnauthorizedError("The federation credential was already rotated.");
  }

  res.status(200).json({
    memberToken: issued.raw,
    memberTokenExpiresAt: issued.expiresAt.toISOString(),
  });
}

// ── Home side: the user's connections to OTHER Musubi servers ────────────────
// Stored here (member token AES-GCM encrypted, same key as CalDAV passwords) so
// the connection roams: accepting an invite on one device federates them all.

/** GET /api/v1/users/connections/musubi — the caller's federated connections. */
export async function handlerGetMusubiAccounts(req: Request, res: Response) {
  const rows = await getMusubiAccounts(req.user!.id);
  res.status(200).json({
    // decrypted only for the authenticated owner, over TLS — the client needs
    // the raw token to talk to the origin server directly
    accounts: rows.map(r => ({ server: r.server, userID: r.remoteUserID, token: decryptSecret(r.encryptedToken) })),
  });
}

/** POST /api/v1/users/connections/musubi — store/refresh one connection. */
export async function handlerSaveMusubiAccount(req: Request, res: Response) {
  const { server, userID, token } = req.body ?? {};
  if (!server || !userID || !token) throw new BadRequestError("server, userID and token are required...");
  const origin = canonicalHttpOrigin(server);
  if (!origin) throw new BadRequestError("server must be an http(s) origin...");
  await upsertMusubiAccount(req.user!.id, origin, userID, encryptSecret(token));
  res.sendStatus(200);
}

/** DELETE /api/v1/users/connections/musubi — drop a connection. */
export async function handlerDeleteMusubiAccount(req: Request, res: Response) {
  const { server } = req.body ?? {};
  if (!server) throw new BadRequestError("server is required...");
  const origin = canonicalHttpOrigin(server);
  if (!origin) throw new BadRequestError("server must be an http(s) origin...");
  await deleteMusubiAccount(req.user!.id, origin);
  res.sendStatus(200);
}

/**
 * GET /invite/:token — a tiny HTML hand-off page every Musubi server serves for
 * its own invite links. Deep-links into the app via the custom scheme WITH the
 * origin server attached, so cross-server invites don't depend on any one
 * domain's verified app links.
 */
export function handlerInvitePage(origin: string) {
  return (req: Request, res: Response) => {
    const token = String(req.params.token ?? "");
    if (!/^[0-9a-f-]{16,64}$/i.test(token)) { res.status(400).send("Invalid invite."); return; }
    const appUrl = `musubi://invite/${token}?server=${encodeURIComponent(origin)}`;
    res.status(200).type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Musubi invite</title>
<style>body{font-family:system-ui;background:#0c0c0e;color:#e8e4d9;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center}a{color:#c8553d;font-size:1.2rem}p{color:#a09c92}</style>
</head><body><div>
<h1>結び</h1>
<p>You've been invited to a Musubi calendar.</p>
<p><a href="${appUrl}">Open in the Musubi app</a></p>
<p>Don't have it? Get Musubi on <a href="https://play.google.com/store/apps/details?id=dev.frgtn.musubi">Google Play</a>.</p>
<script>location.href=${JSON.stringify(appUrl)};</script>
</div></body></html>`);
  };
}
