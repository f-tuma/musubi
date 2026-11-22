import type { Request, Response } from "express";
import { config } from "@musubi/config";
import { appleWebSignInEnabled } from "@musubi/auth";
import { canSendEmail } from "@musubi/emails";
import { MIN_CLIENT_VERSION, PRODUCT_VERSION } from "@musubi/types";

// Which social logins this server can actually perform — a provider counts only
// when its credentials are configured. Lets self-hosted clients render just the
// buttons that will work against their server (see welcome screen).
//
// Which flow a provider is set up for differs by platform, so this list is what
// the server accepts and each client takes what it can use. Google is both: the
// phone verifies an identity token against the web client id, the browser does a
// redirect (which also needs the secret). Microsoft is redirect-only. Apple is
// the phone alone — it is configured for the native token flow with a bundle id
// and no web Services ID, so a browser has nothing to redirect to and the web
// client filters it out.
function enabledSocials(): string[] {
  const socials: string[] = [];
  if (config.social.googleWebClientID) socials.push("google");
  if (config.social.microsoftClientID && config.social.microsoftClientSecret) socials.push("microsoft");
  if (config.social.appleClientID) socials.push("apple");
  return socials;
}

// The same question for a browser, which needs more: a redirect flow cannot
// finish without the secret, and Apple's browser flow is a whole separate
// registration (Services ID + .p8 key) from the app's.
//
// A second field rather than a changed `socials`, because the released phone app
// reads that one as a flat list and must keep seeing what it can do.
function enabledWebSocials(): string[] {
  const socials: string[] = [];
  if (config.social.googleWebClientID && config.social.googleClientSecret) socials.push("google");
  if (config.social.microsoftClientID && config.social.microsoftClientSecret) socials.push("microsoft");
  if (appleWebSignInEnabled) socials.push("apple");
  return socials;
}

// Same idea for calendar sync — the client's "Sync a Calendar" modal shows
// only providers this server can actually run. OAuth sync needs the secret
// too (refresh flow); CalDAV needs the key that encrypts stored passwords.
function enabledSyncProviders(): string[] {
  const providers: string[] = [];
  if (config.social.googleWebClientID && config.social.googleClientSecret) providers.push("google");
  if (config.social.microsoftClientID && config.social.microsoftClientSecret) providers.push("microsoft");
  if (config.security.caldavEncKey) providers.push("caldav");
  return providers;
}

export function handlerServerStatus(_: Request, res: Response) {
  res.status(200).json({ ok: true, version: PRODUCT_VERSION });
}

export function handlerServer(_: Request, res: Response) {
  res.status(200).json({
    version: PRODUCT_VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
    socials: enabledSocials(),
    socialsWeb: enabledWebSocials(),
    syncProviders: enabledSyncProviders(),
    googleAvailability: config.api.googleAvailabilityEnabled,
    // Snapshot established during startup, so capability discovery never waits
    // for an external SMTP server.
    email: canSendEmail(),
    // Whether a new account has to confirm its address before it can sign in.
    // The client cannot infer this from a refused sign-in — "wrong password" and
    // "not confirmed yet" look the same from outside — so it is said here.
    emailVerificationRequired: config.security.requireEmailVerification,
    // False only when nobody can register, so clients drop "create account".
    // An allowlist keeps it true: the server, not the client, knows who is on it.
    signUp: config.security.signUpAllowlist?.length !== 0,
    // The VAPID public key, or null where this install has no keys. A browser
    // needs it to subscribe at all, and its absence is the honest way to say
    // "this server never pushes" — the client then keeps its own in-tab
    // reminders instead of offering something that will not arrive.
    pushPublicKey: config.push.vapidPublicKey || null,
  });
}

// Apple universal links: iOS fetches this to learn which app owns which paths
// on this domain, so an https invite link opens the app directly (no Safari
// bounce). Must be HTTPS, application/json, no redirect. 404 until APPLE_TEAM_ID
// is set so a misconfigured server doesn't advertise a bogus app.
export function handlerAppleAppSiteAssociation(_: Request, res: Response) {
  const teamID = config.social.appleTeamID;
  if (!teamID) { res.sendStatus(404); return; }
  res.status(200).type("application/json").json({
    applinks: {
      details: [
        { appIDs: [`${teamID}.dev.frgtn.musubi`], components: [{ "/": "/invite/*", comment: "Calendar invite" }] },
      ],
    },
  });
}

