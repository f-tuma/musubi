import { readFileSync } from "node:fs";
import { test as base, expect, type BrowserContext, type Route, type TestInfo } from "@playwright/test";
import { BRAND_ASSETS } from "../src/brand";

// BrandMark masks its arms with two images from the external brand host. Tests
// must not depend on that host answering, so these exact two URLs are served
// from the arm geometry that BrandMark itself renders before the images load.
// Any other request to the host fails the test instead of reaching upstream.
const BRAND_HOST = "https://vardum.com/**";

function armPaths(): Record<"inkPath" | "accentPath", string> {
  const source = readFileSync(new URL("../src/components/BrandMark.tsx", import.meta.url), "utf8");
  const found: Partial<Record<"inkPath" | "accentPath", string[]>> = {};
  for (const match of source.matchAll(/const (inkPath|accentPath) = "([^"]+)";/g)) {
    (found[match[1] as "inkPath" | "accentPath"] ??= []).push(match[2]);
  }
  if (found.inkPath?.length !== 1 || found.accentPath?.length !== 1) {
    throw new Error(`BrandMark.tsx must define inkPath and accentPath exactly once each; found ${JSON.stringify(found)}`);
  }
  return { inkPath: found.inkPath[0], accentPath: found.accentPath[0] };
}

const arms = armPaths();
const markSvg = (path: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><path d="${path}"/></svg>`;
const served = new Map<string, string>([
  [BRAND_ASSETS.logoInk, markSvg(arms.inkPath)],
  [BRAND_ASSETS.logoAccent, markSvg(arms.accentPath)],
]);

type RouteRecord = { url: string; method: string; action: "fulfilled" | "aborted"; count: number };

export type ExternalBrandFixture = {
  /** Attaches the route record and fails on any request outside the two known marks. */
  finish(testInfo: TestInfo, name?: string): Promise<void>;
};

export async function installExternalBrandFixture(context: BrowserContext): Promise<ExternalBrandFixture> {
  const records = new Map<string, RouteRecord>();
  const unexpected: string[] = [];
  const record = (url: string, method: string, action: RouteRecord["action"]) => {
    const key = `${action} ${method} ${url}`;
    const entry = records.get(key) ?? { url, method, action, count: 0 };
    entry.count++;
    records.set(key, entry);
  };

  await context.route(BRAND_HOST, async (route: Route) => {
    const request = route.request();
    const body = request.method() === "GET" ? served.get(request.url()) : undefined;
    if (body === undefined) {
      unexpected.push(`${request.method()} ${request.url()}`);
      record(request.url(), request.method(), "aborted");
      await route.abort("blockedbyclient");
      return;
    }
    record(request.url(), request.method(), "fulfilled");
    await route.fulfill({ status: 200, contentType: "image/svg+xml", body });
  });

  return {
    async finish(testInfo, name = "external-brand-routes") {
      await testInfo.attach(name, {
        body: JSON.stringify({ routes: [...records.values()], unexpected }, null, 2),
        contentType: "application/json",
      });
      expect(unexpected, "requests to the external brand host outside the served marks").toEqual([]);
    },
  };
}

export const test = base.extend<{ externalBrand: ExternalBrandFixture }>({
  externalBrand: [
    async ({ context }, use, testInfo) => {
      const fixture = await installExternalBrandFixture(context);
      await use(fixture);
      await fixture.finish(testInfo);
    },
    { auto: true },
  ],
});

export { expect };
