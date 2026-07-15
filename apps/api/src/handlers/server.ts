import { Request, Response } from "express";
import { config } from "@musubi/config";

// Which social logins this server can actually perform — a provider counts only
// when its credentials are configured. Lets self-hosted clients render just the
// buttons that will work against their server (see welcome screen).
function enabledSocials(): string[] {
  const socials: string[] = [];
  if (config.social.googleWebClientID) socials.push("google");
  if (config.social.appleClientID) socials.push("apple");
  return socials;
}

export function handlerServerStatus(_: Request, res: Response) {
  res.status(200).json({ ok: true });
}

export function handlerServer(_: Request, res: Response) {
  res.status(200).json({ minClientVersion: "0.0.16", socials: enabledSocials() });
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

