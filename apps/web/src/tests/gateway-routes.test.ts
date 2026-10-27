import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The gateway lists the web client's routes instead of catching everything,
// because `/` belongs to an optional marketing site. That list is a second
// place to edit when a route is added, and forgetting it fails silently: the
// new page reaches the marketing site and 404s there, in production only.
const here = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.join(here, "../routes");
const CADDYFILE = path.join(here, "../../../../ops/gateway/Caddyfile");
const DEV_COMPOSE = path.join(here, "../../../../docker-compose.dokploy.dev.yml");

const WEB_MATCHER = /@webclient path ([^\n]+)\n\s*handle @webclient \{\n\s*reverse_proxy \{env\.WEB_UPSTREAM\}/;

// TanStack file routes that produce no URL of their own.
const NOT_A_ROUTE = new Set(["__root", "index"]);

// Routes the apex is welcome to answer instead. `/favicon.ico` exists here only
// to return 204, which is worse than the icon a marketing site serves.
const APEX_MAY_OWN = new Set(["favicon.ico"]);

/** First URL segment of a TanStack file route: `e.$token.tsx` → `e`. */
function firstSegment(entry: string) {
  const name = entry.replace(/\.(tsx|ts)$/, "");
  // `[.]` escapes a literal dot, so hide it before splitting on the separator.
  const [first] = name.replaceAll("[.]", "\0").split(".");
  return first.replaceAll("\0", ".");
}

function claimedSegments() {
  const segments = new Set<string>();
  for (const entry of readdirSync(ROUTES_DIR, { withFileTypes: true })) {
    const name = entry.name;
    // A leading `-` marks a file the router ignores; the rest are co-located
    // styles and tests.
    if (name.startsWith("-") || name.endsWith(".css")) continue;
    if (!entry.isDirectory() && !/\.(tsx|ts)$/.test(name)) continue;
    const segment = entry.isDirectory() ? name : firstSegment(name);
    if (NOT_A_ROUTE.has(segment) || APEX_MAY_OWN.has(segment)) continue;
    segments.add(segment);
  }
  return [...segments].sort();
}

function gatewayPaths() {
  const matched = WEB_MATCHER.exec(readFileSync(CADDYFILE, "utf8"));
  if (!matched) throw new Error("no web-client handle block in the Caddyfile");
  return matched[1].trim().split(/\s+/);
}

describe("gateway routes", () => {
  it("routes every web client route away from the marketing upstream", () => {
    const paths = gatewayPaths();
    // A wildcard covers `/x`, `/x/` and everything under it; an exact matcher
    // covers only the string it is, so it has to be spelled both ways or a
    // stray trailing slash leaves the app.
    const uncovered = claimedSegments().filter(
      (segment) =>
        !paths.includes(`/${segment}/*`) &&
        !(paths.includes(`/${segment}`) && paths.includes(`/${segment}/`)),
    );

    expect(uncovered).toEqual([]);
  });

  it("keeps the apex on the marketing upstream", () => {
    expect(gatewayPaths()).not.toContain("/");
    expect(readFileSync(CADDYFILE, "utf8")).toContain(
      "reverse_proxy {env.MARKETING_UPSTREAM}",
    );
  });

  it("resolves replaced containers through Docker DNS at request time", () => {
    const caddyfile = readFileSync(CADDYFILE, "utf8");
    expect(caddyfile).toContain("reverse_proxy {env.API_UPSTREAM}");
    expect(caddyfile).toContain("reverse_proxy {env.WEB_UPSTREAM}");
    expect(caddyfile).not.toMatch(/\{\$(?:API|WEB|MARKETING)_UPSTREAM/);
  });

  it("sends the development apex to the app when no marketing site exists", () => {
    expect(readFileSync(DEV_COMPOSE, "utf8")).toContain(
      "MARKETING_UPSTREAM: musubi-web-internal:3000",
    );
  });

  it("routes both public mobile associations to the API", () => {
    const source = readFileSync(CADDYFILE, "utf8");
    for (const route of ["apple-app-site-association", "assetlinks.json"])
      expect(source).toContain(`handle /.well-known/${route} {\n\t\treverse_proxy {env.API_UPSTREAM}`);
  });

  it("keeps the mutable worker outside upstream asset cache policy", () => {
    const source = readFileSync(CADDYFILE, "utf8");
    const worker = source.indexOf("handle /app/sw.js {");
    expect(worker).toBeGreaterThan(-1);
    expect(worker).toBeLessThan(source.indexOf("@webclient path"));
    expect(source).toContain('header_down Cache-Control "no-store, no-cache, must-revalidate"');
    expect(source).toContain('header_down CDN-Cache-Control "no-store"');
    expect(source).toContain('header_down Cloudflare-CDN-Cache-Control "no-store"');
  });
});
