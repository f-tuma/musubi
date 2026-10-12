import { DAV, CALDAV, davMultistatus, davName, successfulDavProperty, type DavNode } from "./caldav_properties";
import { createGuardedCaldavFetch } from "./caldav_client";
import { ProviderEventWriteError, providerRetryAfterMs } from "./event_write";

const fetch = createGuardedCaldavFetch();

/** Only explicit successful propstats for the exact requested resource count. */
async function properties(url: string, authorization: string, names: string[], signal?: AbortSignal, redirect: RequestRedirect = "follow") {
  const response = await fetch(url, { method: "PROPFIND", headers: { authorization, depth: "0", "content-type": "application/xml", "cache-control": "no-cache" }, body: `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>${names.map(name => `<${name}/>`).join("")}</d:prop></d:propfind>`, signal, redirect });
  if (response.status === 429 || response.status === 408 || response.status >= 500)
    throw new ProviderEventWriteError("provider-write-failed", "not-written", response.status, providerRetryAfterMs(response));
  if (response.status !== 207 || response.headers.has("content-range")) return undefined;
  let rows;
  try { rows = davMultistatus(await response.text(), url); } catch { signal?.throwIfAborted(); return undefined; }
  const matching = rows.filter(row => row.href === new URL(url).href);
  return matching.length === 1 && matching[0]!.status === undefined ? matching[0] : undefined;
}

export async function caldavEventPrivileges(url: string, authorization: string, signal?: AbortSignal, redirect: RequestRedirect = "follow") {
  return (await caldavEventWritePermission(url, authorization, signal, redirect)).privileges;
}

/** Missing is deliberately narrower than unknown: only an explicit, empty DAV
 * property with 404 status is evidence that this server omits resource ACLs.
 * HTTP denial, malformed XML, absent properties and denied propstats stay unknown.
 * Throttling, request timeout and server failures propagate as transient read
 * errors with Retry-After; they cannot prove a missing or denied write grant. */
export async function caldavEventWritePermission(url: string, authorization: string, signal?: AbortSignal, redirect: RequestRedirect = "follow"): Promise<{ privileges: Set<string> | undefined; missing: boolean }> {
  const response = await properties(url, authorization, ["d:current-user-privilege-set"], signal, redirect);
  const property = response?.properties.get(davName(DAV, "current-user-privilege-set"));
  if (property?.status === 404 && !property.value.text && !property.value.children.length)
    return { privileges: undefined, missing: true };
  const value = response && successfulDavProperty(response, DAV, "current-user-privilege-set");
  return { privileges: value && !value.text ? parseEventPrivileges(value) : undefined, missing: false };
}

function parseEventPrivileges(value: DavNode): Set<string> | undefined {
  const result = new Set<string>();
  for (const privilege of value.children) {
    if (privilege.name !== davName(DAV, "privilege") || privilege.text || privilege.children.length !== 1) return undefined;
    const child = privilege.children[0]!;
    if (child.text || child.children.length) return undefined;
    // Preserve the existing write helper vocabulary, but only for DAV namespace.
    if (child.name.startsWith(`{${DAV}}`)) result.add(child.name.slice(DAV.length + 2).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()));
    else if (child.name === davName(CALDAV, "read-free-busy")) result.add("readFreeBusy");
    else return undefined; // An unrecognized namespace is not evidence of absence.
  }
  return result;
}

export function caldavReadAccess(privileges: Set<string> | undefined) {
  if (!privileges) return { read: null, readFreeBusy: null };
  const read = privileges.has("all") || privileges.has("read");
  return { read, readFreeBusy: read || privileges.has("readFreeBusy") };
}

export function caldavAllows(
  privileges: Set<string> | undefined,
  action: "create" | "update" | "delete",
): boolean | undefined {
  if (!privileges) return undefined;
  return privileges.has("all") || privileges.has("write") || privileges.has(
    action === "create" ? "bind" : action === "delete" ? "unbind" : "writeContent",
  );
}

export async function caldavOrganizerAddresses(url: string, authorization: string, signal?: AbortSignal) {
  const response = await properties(url, authorization, ["d:current-user-principal"], signal);
  const principalNode = response && successfulDavProperty(response, DAV, "current-user-principal");
  const href = principalNode?.children.length === 1 && principalNode.children[0]!.name === davName(DAV, "href") ? principalNode.children[0]!.text : undefined;
  if (!href) return undefined;
  const principal = new URL(href, url);
  if (principal.origin !== new URL(url).origin) return undefined;
  const addresses = await properties(principal.href, authorization, ["c:calendar-user-address-set"], signal);
  const node = addresses && successfulDavProperty(addresses, CALDAV, "calendar-user-address-set");
  return node?.children.filter((child: DavNode) => child.name === davName(DAV, "href") && !child.children.length).map((child: DavNode) => child.text.replace(/^mailto:/i, "").toLowerCase());
}
