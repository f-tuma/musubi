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

