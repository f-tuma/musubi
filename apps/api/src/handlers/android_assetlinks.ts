import type { RequestHandler } from "express";

/** The same public domain association boundary as iOS AASA, without auth. */
export function createAndroidAssetLinksHandler(fingerprints: readonly string[]): RequestHandler {
  return (_, res) => {
    // Never retain an unconfigured 404 or a superseded signing association.
    res.set({
      "Cache-Control": "no-store",
      "CDN-Cache-Control": "no-store",
      "Cloudflare-CDN-Cache-Control": "no-store",
    });
    if (!fingerprints.length) { res.sendStatus(404); return; }
    res.status(200).type("application/json").json([{
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: "dev.frgtn.musubi",
        sha256_cert_fingerprints: [...fingerprints],
      },
    }]);
  };
}
