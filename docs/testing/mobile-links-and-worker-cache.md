# Mobile domain links and notification-worker caching

## Android association

The API serves `GET /.well-known/assetlinks.json` publicly, beside the iOS
association endpoint. The reference gateway sends both paths to the API.
Set `ANDROID_APP_LINKS_SHA256` on the API to the public SHA-256 fingerprint from
**Play Console → App integrity / App signing → App signing key certificate**.
Use the certificate for the app distributed by Play, not the EAS upload key or
any local/debug certificate. Multiple comma-separated colon-delimited
fingerprints support Play signing-key rotation; values are normalized to upper
case and deduplicated.

There is no built-in production fingerprint. Unset/blank configuration returns
404. A malformed value fails API startup instead of publishing a partial or
invalid association. The certificate's provenance remains an operator acceptance
condition: syntactic validation cannot prove a supplied fingerprint belongs to
the app distributed by Play.

The statement names `dev.frgtn.musubi` and delegates URL handling. The installed
Android manifest still limits verified HTTPS links to `musubi.pro/invite`.
Publishing a statement on another self-hosted domain does not add that domain
to the installed application's intent filters. Browser invitation handling
remains available independently.

Before accepting verified App Links, check the canonical HTTPS URL without auth
or redirects, its JSON media type and exact app-signing fingerprint. Install the
actual Play-distributed candidate, run Android domain verification and open a
real designated invite. A fixture certificate or EAS-signed sideload does not
prove Play association.

```sh
adb shell pm verify-app-links --re-verify dev.frgtn.musubi
adb shell pm get-app-links dev.frgtn.musubi
```

## Worker origin policy and external caches

The actual `/app/sw.js` route and reference gateway return:

```text
Cache-Control: no-store, no-cache, must-revalidate
CDN-Cache-Control: no-store
Cloudflare-CDN-Cache-Control: no-store
```

Nitro explicitly dispatches GET/HEAD at this path to its `ssr` Vite service
through the public `fetchViteEnv` API. Start's existing route remains the single
response implementation. This avoids Nitro's development asset heuristic
mistaking `.js` / native `serviceworker` requests for static Vite files; no
request headers or private framework flags are rewritten. The same bridge is
included in the production build.

Push registration uses `updateViaCache: "none"` for its `/app/` scope. This
controls the browser's worker-script update cache, not CDN cache or application
data. The notification worker has no application-shell fetch cache.

These source changes cannot override every external configuration. Cloudflare
Cache Response Rules and Edge Cache TTL settings can take precedence over
origin headers, and Browser Cache TTL can rewrite the browser-facing header.
For `http.host eq "musubi.pro" and http.request.uri.path eq "/app/sw.js"`, the
operator must ensure cache eligibility bypasses caching, browser TTL respects
the origin and no response rule rewrites the policy. Apply equivalent policy
for any other served origin. Scope changes and any single-URL invalidation to
the worker; do not change caching for all hashed assets or purge everything.

After deploying the actual source/gateway, verify both inside the gateway and
at the public canonical URL. Confirm response headers and worker bytes on
repeated requests. A fresh query URL alone does not establish the canonical
URL's freshness. Cloudflare normally consumes its own CDN header, so its absence
from the public response is not itself a failure; verify the effective browser
and CDN behavior. Record the real deployed source/digests and the external rule
decision separately from local tests. No CDN change or production deployment
is performed by the test commands below.

## Development verification

```sh
pnpm test:behavior --suite web-edge --scenario worker-response-bypasses-caches --json
pnpm test:behavior --suite web-edge --json
pnpm test:behavior --suite app-links --scenario unconfigured-is-not-associated --json
pnpm test:behavior --suite app-links --json
pnpm --filter @musubi/api exec tsx src/handlers/android_assetlinks.test.ts
pnpm --filter @musubi/web exec playwright test worker-cache.spec.ts
```

The fast drivers exercise the production worker route/registration,
configuration parser and Android handler. Only browser registration and
Express response/configuration ports are replaced. The API test also binds an
owned ephemeral HTTP listener and checks real responses plus malformed-config
startup. These fixtures do not prove Play certificate provenance, external CDN
policy, production deployment or real-device association.

The final Playwright check requests the actual running worker route, verifies
the sign-in page remains usable and activates/updates the worker in Chromium.
It does not intercept the worker script. Browser registration is checked
separately from the fast production-call option assertion; no real push
subscription, user account or remote notification is created by that test.

Primary references:
[Android website association](https://developer.android.com/training/app-links/configure-assetlinks),
[worker registration](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/register),
[Nitro handler configuration](https://nitro.build/config#handlers),
[Cloudflare CDN cache-control precedence](https://developers.cloudflare.com/cache/concepts/cdn-cache-control/).
