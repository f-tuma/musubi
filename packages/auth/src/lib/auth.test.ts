import assert from "node:assert/strict";
import { getCookies } from "better-auth/cookies";
import { microsoft } from "better-auth/social-providers";
import { withVerifiedLanding } from "./verified_landing";

// The installed auth library owns cookie naming. An unset override must keep
// deployed sessions usable; an explicit dev prefix must isolate every cookie
// returned by the factory without changing its lifetime or security attributes.
const defaultCookies = getCookies({ baseURL: "http://localhost:7531" });
const unsetCookies = getCookies({ baseURL: "http://localhost:7531", advanced: { cookiePrefix: undefined } });
assert.deepEqual(unsetCookies, defaultCookies);
assert.equal(defaultCookies.sessionToken.name, "better-auth.session_token");
assert.equal(defaultCookies.sessionToken.attributes.maxAge, 7 * 24 * 60 * 60);
for (const baseURL of ["http://localhost:7531", "https://musubi.example.com"]) {
  const before = getCookies({ baseURL });
  const isolated = getCookies({ baseURL, advanced: { cookiePrefix: "musubi-browser-qa" } });
  for (const key of Object.keys(before) as (keyof typeof before)[]) {
    assert.equal(isolated[key].name, before[key].name.replace("better-auth", "musubi-browser-qa"));
    assert.deepEqual(isolated[key].attributes, before[key].attributes);
  }
}

// Better Auth builds the link itself, so this is string surgery on somebody
// else's URL — the case worth pinning is that it only touches the default.
const base = "https://musubi.example.com/api/auth/verify-email?token=abc123";

// No callback chosen: send the browser to the page this API serves, or an
// API-only server ends a successful verification on a 404.
assert.equal(
  withVerifiedLanding(`${base}&callbackURL=%2F`),
  `${base}&callbackURL=%2Femail-verified`,
);

// A caller that asked for somewhere specific — the web client sending people
// back to the page they signed up on — keeps it.
assert.equal(
  withVerifiedLanding(`${base}&callbackURL=%2Flogin%3Fverified%3D1`),
  `${base}&callbackURL=%2Flogin%3Fverified%3D1`,
);

// An unescaped slash and an empty value are the same "nowhere in particular".
assert.equal(
  withVerifiedLanding(`${base}&callbackURL=/`),
  `${base}&callbackURL=%2Femail-verified`,
);
assert.equal(
  withVerifiedLanding(`${base}&callbackURL=`),
  `${base}&callbackURL=%2Femail-verified`,
);

// Stored Microsoft accounts and every sync row are keyed by the 1.6 `sub`; the
// pnpm patch must survive Better Auth bumps or returning users get new accounts.
assert.equal(
  microsoft({ clientId: "c", clientSecret: "s" }).accountSubject({ tokens: {}, profile: { sub: "pairwise-sub", oid: "directory-oid" } as never }),
  "pairwise-sub",
);

console.log("auth verification landing self-check: OK");
