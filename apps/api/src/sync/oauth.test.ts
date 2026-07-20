// Runnable self-check (no framework): `npx tsx src/sync/oauth.test.ts` from
// apps/api. Dummy env so @musubi/config (pulled in transitively) can load; set
// before the dynamic import (tsx emits CJS, so a static import would hoist).
import assert from "node:assert";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.ENVIRONMENT ??= "dev";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";

async function main() {
  const { revokeGoogleToken } = await import("./oauth");

  const realFetch = globalThis.fetch;
  const calls: { url: string; method?: string; body: string }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), method: init?.method, body: String(init?.body) });
    return { ok: true } as Response;
  }) as typeof fetch;

  try {
    // Encodes url-unsafe token chars via URLSearchParams (old `token=${t}` did not).
    await revokeGoogleToken("a/b+c=d");
    assert.equal(calls[0].url, "https://oauth2.googleapis.com/revoke");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].body, "token=a%2Fb%2Bc%3Dd");

    // Two connected accounts → each revoke carries its OWN token, no bleed.
    await revokeGoogleToken("token-account-A");
    await revokeGoogleToken("token-account-B");
    assert.equal(calls[1].body, "token=token-account-A");
    assert.equal(calls[2].body, "token=token-account-B");

    // Never throws when the revoke endpoint is unreachable — local disconnect
    // must still proceed.
    globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
    await assert.doesNotReject(revokeGoogleToken("whatever"));
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log("oauth revoke self-check: OK");
}

main().catch((e) => { console.error(e); process.exit(1); });
