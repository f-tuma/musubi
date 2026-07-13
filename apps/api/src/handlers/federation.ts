import { Request, Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import {
  addCalendarMember, consumeInvite, createExternalUser, deleteMusubiAccount, findExternalUser,
  getCalendar, getCalendarIDFromToken, getMusubiAccounts, saveMemberToken,
  upsertMusubiAccount,
} from "@musubi/db";
import { BadRequestError } from "@musubi/types";
import { decryptSecret, encryptSecret } from "../sync/crypto";

// Federation (Musubi ↔ Musubi), v1: an invite token doubles as the cross-server
// capability. A user from another server accepts an invite here and becomes a
// NATIVE member through a "shadow account" — a normal `user` row (isExternal)
// carrying their profile. Roles, permissions, member management and event
// attribution then work unchanged; the only new mechanics are this accept
// handshake and member-token authentication (see middleware/require_auth.ts).

export function hashMemberToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * POST /api/v1/federation/accept — public (the invite token IS the credential).
 * Body: { token, profile: { name, email, homeServer, image? } }
 * Verifies the invite, finds-or-creates the shadow user, adds them as a member
 * (viewer — the owner promotes via the normal member management), and issues a
 * bearer member token. The raw token is returned exactly once; only its SHA-256
 * hash is stored. Authorization stays with calendar_members — kicking the
 * member cuts access even though the token still authenticates.
 */
export async function handlerFederationAccept(req: Request, res: Response) {
  const { token, profile } = req.body ?? {};
  if (!token || typeof token !== "string") throw new BadRequestError("Missing invite token...");
  const { name, email, homeServer, image } = profile ?? {};
  if (!name || !email || !homeServer) throw new BadRequestError("Profile needs name, email and homeServer...");
  if (!/^https?:\/\//.test(homeServer)) throw new BadRequestError("homeServer must be an http(s) origin...");

  // Same semantics as the native join: token must exist (expired ones are
  // purged hourly); throws NotFound otherwise.
  const calendarID = await getCalendarIDFromToken(token);

  const shadow = await findExternalUser(homeServer, email)
    ?? await createExternalUser({ name, email, image, homeServer });

  const added = await addCalendarMember(shadow.id, calendarID); // viewer; conflict-safe on re-accept
  if (added.length > 0) await consumeInvite(token); // burn a use only on a NEW membership

  const raw = randomBytes(32).toString("hex");
  await saveMemberToken(shadow.id, hashMemberToken(raw));

  const calendar = await getCalendar(calendarID);
  res.status(200).json({ memberToken: raw, userID: shadow.id, calendar });
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
  if (!/^https?:\/\//.test(server)) throw new BadRequestError("server must be an http(s) origin...");
  await upsertMusubiAccount(req.user!.id, server, userID, encryptSecret(token));
  res.sendStatus(200);
}

/** DELETE /api/v1/users/connections/musubi — drop a connection. */
export async function handlerDeleteMusubiAccount(req: Request, res: Response) {
  const { server } = req.body ?? {};
  if (!server) throw new BadRequestError("server is required...");
  await deleteMusubiAccount(req.user!.id, server);
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
