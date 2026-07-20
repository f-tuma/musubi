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

  // --- token-at-rest encryption interop with Better Auth (tokenCrypto) ---
  const { symmetricEncrypt, symmetricDecrypt } = await import("better-auth/crypto");
  const secret = "test-secret-0123456789abcdefABCDEF";

  // Round-trips with a plain string key — the single-secret setup Musubi uses,
  // where Better Auth's secretConfig IS the secret string.
  const plain = "1//0gL9-refresh_token.value";
  const ciphertext = await symmetricEncrypt({ key: secret, data: plain });
  assert.equal(await symmetricDecrypt({ key: secret, data: ciphertext }), plain);

  // Mirror of tokenCrypto.isLikelyEncrypted: our bare-hex ciphertext is detected,
  // but real OAuth tokens (with / . _ -) are NOT — so pre-encryption plaintext
  // passes through untouched instead of being fed to a doomed decrypt.
  const likelyEncrypted = (t: string) => t.startsWith("$ba$") || (t.length % 2 === 0 && /^[0-9a-f]+$/i.test(t));
  assert.equal(likelyEncrypted(ciphertext), true);
  assert.equal(likelyEncrypted("1//0gL9-refresh_token.value"), false);
  assert.equal(likelyEncrypted("ya29.a0AfB_xyz-token"), false);

  console.log("oauth revoke + token-crypto self-check: OK");
}

main().catch((e) => { console.error(e); process.exit(1); });
