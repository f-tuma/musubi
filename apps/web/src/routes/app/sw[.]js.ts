import { createFileRoute } from "@tanstack/react-router";
import { serviceWorkerSource } from "~/push/source";

/**
 * The push service worker, served under `/app/`.
 *
 * Not `public/sw.js` at the origin root: the gateway gives `/` to the marketing
 * site and only routes `/app/*` here (`ops/gateway/Caddyfile`), so a worker at
 * the root would 404 on the hosted install and quietly disable push. Its scope
 * is `/app/` as a result, which is all it needs — the app lives there.
 */
export const Route = createFileRoute("/app/sw.js")({
  server: {
    handlers: {
      GET: () =>
        new Response(serviceWorkerSource, {
          headers: {
            // The script and notification behavior must update together.
            // CDN-specific policy also covers intermediaries with their own TTL.
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "CDN-Cache-Control": "no-store",
            "Cloudflare-CDN-Cache-Control": "no-store",
            "Content-Type": "text/javascript; charset=utf-8",
            // Lets the worker claim the whole origin later if it ever needs to.
            "Service-Worker-Allowed": "/",
          },
        }),
    },
  },
});
