import { subscribePush, unsubscribePush } from "~/api/resources";

/**
 * Getting this browser onto the server's push list, and off it again.
 *
 * Everything here is best-effort and reversible. Push is an improvement on
 * in-tab reminders, never a prerequisite: a browser with no service worker
 * support, a denied permission, or a server with no VAPID keys all end up in
 * the same place, which is the app ringing for itself while it is open.
 */

const SERVICE_WORKER_URL = "/app/sw.js";

export function pushSupported() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

/**
 * VAPID keys travel as base64url; `applicationServerKey` wants raw bytes.
 *
 * Hand-rolled rather than pulled from a library: it is six lines, and adding a
 * dependency to the browser bundle for one base64 variant is not a trade.
 */
function decodeKey(base64Url: string) {
  const padded = base64Url.padEnd(
    base64Url.length + ((4 - (base64Url.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function registration() {
  return navigator.serviceWorker.register(SERVICE_WORKER_URL, {
    scope: "/app/",
    updateViaCache: "none",
  });
}

/** Is this browser already on the list? Cheap enough to ask on every load. */
export async function currentSubscription() {
  if (!pushSupported()) return null;
  try {
    const existing = await navigator.serviceWorker.getRegistration("/app/");
    return (await existing?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Subscribe, assuming permission is already granted.
 *
 * The permission prompt belongs where the user is switching reminders ON, not
 * here — see `requestReminderPermission`. This function is the plumbing that
 * runs after they said yes.
 */
export async function subscribeToPush(publicKey: string) {
  if (!pushSupported()) return false;

  try {
    const worker = await registration();
    await navigator.serviceWorker.ready;

    const subscription =
      (await worker.pushManager.getSubscription()) ??
      (await worker.pushManager.subscribe({
        applicationServerKey: decodeKey(publicKey),
        // Chrome refuses anything else, and it is the honest setting: every
        // push this server sends carries a notification the user will see.
        userVisibleOnly: true,
      }));

    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.auth || !json.keys?.p256dh) return false;

    await subscribePush({
      endpoint: json.endpoint,
      keys: { auth: json.keys.auth, p256dh: json.keys.p256dh },
    });
    return true;
  } catch {
    // A blocked worker, a push service that will not issue an endpoint, an
    // offline tab. None of it is worth an error in the user's face: the in-tab
    // reminders they already had keep working.
    return false;
  }
}

/**
 * The same digest the server publishes for its own rows.
 *
 * SHA-256 of the endpoint, hex. Lets a browser find itself in a list that
 * carries no endpoints — which is the only safe way to answer "does the server
 * still have me?", since an endpoint is a capability URL.
 *
 * Null where `crypto.subtle` is missing. It needs a secure context, and so does
 * push itself, so the two are absent together and the check says "unknown"
 * rather than inventing an answer.
 */
export async function fingerprintEndpoint(endpoint: string) {
  if (typeof crypto === "undefined" || !crypto.subtle) return null;
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(endpoint),
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

/**
 * Tell the server about a subscription this browser is already holding.
 *
 * The server drops a subscription the moment a push comes back 404 or 410, and
 * the browser is never told. Its `PushSubscription` object survives, so
 * `currentSubscription()` still answers — and the tab, seeing itself as pushed
 * to, declines to arm its own timers. The server will not push because the row
 * is gone; the tab will not schedule because it believes the server will. Both
 * paths off, no error anywhere, until something remounts the app.
 *
 * `subscribePush` upserts on the endpoint, so saying it again is free when the
 * row is still there and restores it when it is not.
 *
 * Best-effort on purpose: a failure here leaves things exactly as they were,
 * which is what they would have been without this call.
 */
export async function reregisterPush(subscription: PushSubscription) {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.auth || !json.keys?.p256dh) return false;

  try {
    await subscribePush({
      endpoint: json.endpoint,
      keys: { auth: json.keys.auth, p256dh: json.keys.p256dh },
    });
    return true;
  } catch {
    return false;
  }
}

/** Come off the list, on this browser, and tell the server so it stops sending. */
export async function unsubscribeFromPush() {
  const subscription = await currentSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  // Server first: a browser that unsubscribed locally but stayed on the list
  // would have the server pushing at a dead endpoint until it 410s.
  await unsubscribePush({ endpoint }).catch(() => undefined);
  await subscription.unsubscribe().catch(() => undefined);
}
