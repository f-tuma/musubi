import type { Request, Response } from "express";
import { z } from "zod";
import {
	createExternalUser,
	deleteMusubiAccount,
	getCalendar,
	getMusubiAccounts,
	getUserByTokenHash,
	joinCalendarFromInvite,
	replaceMemberToken,
	rotateMemberToken,
	upsertMusubiAccount,
} from "@musubi/db";
import { BadRequestError, CLIENT_VERSION_HEADER, isCompatibleVersion, MIN_PEER_VERSION, PRODUCT_VERSION, UnauthorizedError } from "@musubi/types";
import { decryptSecret, encryptSecret } from "../sync/crypto";
import {
	bearerMemberToken,
	hashMemberToken,
	issueMemberToken,
} from "../federation_tokens";
import { assertPublicOrigin, canonicalHttpOrigin, federationFetch } from "../federation_origin";
import { peerTooOld } from "../federation_peer";
import { config, logger } from "@musubi/config";

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
	if (!isCompatibleVersion(req.get(CLIENT_VERSION_HEADER), MIN_PEER_VERSION)) {
		return res.status(426).json({ error: "PeerUpgradeRequired", minPeerVersion: MIN_PEER_VERSION,
			message: `Federation requires Musubi ${MIN_PEER_VERSION} or newer on both servers.` });
	}
	const { token, profile } = req.body ?? {};
	if (!token || typeof token !== "string")
		throw new BadRequestError("Missing invite token...");

	const parsedProfile = FederationProfileSchema.safeParse(profile);
	if (!parsedProfile.success)
		throw new BadRequestError(
			"Profile needs a valid name, email and homeServer...",
		);
	const { name, email, image } = parsedProfile.data;
	const homeServer = canonicalHttpOrigin(parsedProfile.data.homeServer);
	if (!homeServer)
		throw new BadRequestError("homeServer must be an http(s) origin...");

	const currentToken = bearerMemberToken(req.headers.authorization);
	let shadow;
	if (currentToken) {
		const proved = await getUserByTokenHash(hashMemberToken(currentToken));
		const provedHome = proved?.homeServer
			? canonicalHttpOrigin(proved.homeServer)
			: null;
		if (!proved || !proved.isExternal || provedHome !== homeServer) {
			throw new UnauthorizedError(
				"The existing federation credential is invalid.",
			);
		}
		shadow = proved;
	} else {
		// The submitted profile is display-only on first contact. Never look up an
		// existing shadow by these unverified claims.
		shadow = await createExternalUser({ name, email, image, homeServer });
	}

	const { calendarID } = await joinCalendarFromInvite(shadow.id, token);

	const issued = issueMemberToken();
	if (currentToken) {
		const rotated = await rotateMemberToken(
			shadow.id,
			hashMemberToken(currentToken),
			issued.tokenHash,
		);
		if (!rotated) {
			throw new UnauthorizedError(
				"The federation credential was already rotated.",
			);
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
export async function handlerFederationRotateToken(
	req: Request,
	res: Response,
) {
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
		throw new UnauthorizedError(
			"The federation credential was already rotated.",
		);
	}

	res.status(200).json({
		memberToken: issued.raw,
		memberTokenExpiresAt: issued.expiresAt.toISOString(),
	});
}

// ── Home side: the user's connections to OTHER Musubi servers ────────────────
// Stored here (member token AES-GCM encrypted, same key as CalDAV passwords) so
// the connection roams: accepting an invite on one device federates them all.
//
// The token itself never leaves this process (ADR-005): clients list connections
// through `/federation/connections`, create one through `/federation/connect`,
// and reach the origin through the gateway.

const REMOTE_TIMEOUT_MS = 20_000;

/** Validate a client-supplied server origin before this API fetches it. */
async function safeRemoteOrigin(value: unknown): Promise<string> {
	if (typeof value !== "string" || !value.trim()) {
		throw new BadRequestError("server is required...");
	}
	const origin = canonicalHttpOrigin(value.trim());
	if (!origin) throw new BadRequestError("server must be an http(s) origin...");
	// Unlike the gateway, this origin comes from the request, so the SSRF guard is
	// the only thing standing between it and the internal network.
	try {
		await assertPublicOrigin(origin);
	} catch (error) {
		throw new BadRequestError(
			error instanceof Error ? error.message : "Unreachable server origin.",
		);
	}
	return origin;
}

/**
 * GET /api/v1/federation/preview?server=&token= — fetch another server's public
 * invite preview on the caller's behalf.
 *
 * Browsers cannot read it directly (no CORS on the origin server), and the
 * preview is what the join screen renders before anyone commits.
 */
export async function handlerFederationPreview(req: Request, res: Response) {
	const origin = await safeRemoteOrigin(req.query.server);
	const token = String(req.query.token ?? "");
	if (!/^[0-9a-f-]{16,64}$/i.test(token)) {
		throw new BadRequestError("token must be a valid invite token...");
	}

	let upstream: globalThis.Response;
	try {
		upstream = await federationFetch(`${origin}/api/v1/calendars/tokens/${token}`, {
			headers: { accept: "application/json" },
			redirect: "manual",
			signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
		});
	} catch {
		throw new BadRequestError("That Musubi server could not be reached.");
	}

	const payload = await upstream.text();
	res.status(upstream.status).type("application/json").send(payload);
}

/**
 * POST /api/v1/federation/connect — accept an invite on ANOTHER Musubi server.
 *
 * The handshake runs here, not in the client: the member token it returns is
 * encrypted straight into `musubi_accounts` and never sent to the browser
 * (ADR-005). An existing connection's token is presented as proof so the origin
 * reuses our shadow account instead of creating a second one.
 */
export async function handlerFederationConnect(req: Request, res: Response) {
	const origin = await safeRemoteOrigin(req.body?.server);
	const token = req.body?.token;
	if (!token || typeof token !== "string") {
		throw new BadRequestError("token is required...");
	}
	if (origin === canonicalHttpOrigin(config.api.url)) {
		throw new BadRequestError(
			"That invite belongs to this server — join it directly.",
		);
	}

	// Asked before the handshake, so an old peer is turned away by name rather
	// than through "that server rejected the invite", which explains nothing.
	const tooOld = await peerTooOld(origin);
	if (tooOld) throw new BadRequestError(tooOld);

	const existing = (await getMusubiAccounts(req.user!.id)).find(
		(row) => row.server === origin,
	);
	const headers = new Headers({
		accept: "application/json",
		[CLIENT_VERSION_HEADER]: PRODUCT_VERSION,
		"content-type": "application/json",
	});
	if (existing) {
		headers.set(
			"authorization",
			`Bearer ${decryptSecret(existing.encryptedToken)}`,
		);
	}

	let upstream: globalThis.Response;
	try {
		upstream = await federationFetch(`${origin}/api/v1/federation/accept`, {
			body: JSON.stringify({
				profile: {
					email: req.user!.email,
					homeServer: config.api.url,
					image: req.user!.image ?? null,
					name: req.user!.name,
				},
				token,
			}),
			headers,
			method: "POST",
			redirect: "manual",
			signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
		});
	} catch {
		throw new BadRequestError("That Musubi server could not be reached.");
	}

	const payload = (await upstream.json().catch(() => null)) as {
		calendar?: unknown;
		memberToken?: string;
		message?: string;
		userID?: string;
	} | null;

	if (!upstream.ok || !payload?.memberToken || !payload.userID) {
		logger.warn("federation.connect.rejected", {
			server: origin,
			status: upstream.status,
		});
		throw new BadRequestError(
			payload?.message ?? "That server rejected the invite.",
		);
	}

	await upsertMusubiAccount(
		req.user!.id,
		origin,
		payload.userID,
		encryptSecret(payload.memberToken),
	);

	// Deliberately no token in the response.
	res.status(200).json({ calendar: payload.calendar ?? null, server: origin });
}

/**
 * GET /api/v1/federation/connections — the caller's federated connections
 * WITHOUT the credential. This is what browser clients use: they reach the
 * connected servers through the gateway, so they never need the raw token
 * (ADR-005). `id` is the gateway's `:connectionId`.
 */
export async function handlerGetFederationConnections(
	req: Request,
	res: Response,
) {
	const rows = await getMusubiAccounts(req.user!.id);
	res.status(200).json(
		rows.map((row) => ({
			id: row.id,
			// Host only — a full origin is noisy as a UI label.
			label: row.server.replace(/^https?:\/\//, "").replace(/[/:].*$/, ""),
			remoteUserID: row.remoteUserID,
			server: row.server,
		})),
	);
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
		if (!/^[0-9a-f-]{16,64}$/i.test(token)) {
			res.status(400).send("Invalid invite.");
			return;
		}
		const appUrl = `musubi://invite/${token}?server=${encodeURIComponent(origin)}`;
		res
			.status(200)
			.type("html")
			.send(`<!doctype html>
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
