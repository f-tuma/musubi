// Error-tracking events leave the process, so they get the same rule as logs:
// no bearer secrets. These are the places Musubi puts one in a URL.
// Invite links, member tokens and Better Auth reset links carry the secret in
// the path; route patterns (`:token`, `$token`) are left readable.
const SECRET_SEGMENT = /\/(invite|tokens|reset-password)\/[^/?#\s"':$][^/?#\s"']*/g;
// OAuth codes, verification and reset tokens travel in query strings/fragments.
const URL_SUFFIX = /((?:https?:\/\/|\/)[^\s"'?#]*)[?#][^\s"']*/g;
const SENSITIVE_KEY = /(authorization|cookie|password|passwd|passphrase|secret|token)/i;
const QUERY_KEYS: Record<string, true> = { query_string: true, "http.query": true, "url.query": true };
// Click breadcrumbs and INP/LCP spans name DOM elements with these attributes,
// and Musubi's labels carry event titles, calendar and user names.
const ELEMENT_LABEL = /\[(?:aria-label|title|alt|name)="[\s\S]*?"\]/g;

/**
 * Sentry SDK v11 `dataCollection`: its defaults send request bodies, headers,
 * cookies and stack-frame variables. Calendar content, credentials and personal
 * data stay out of events; route, status, timing and stack traces remain.
 */
export const TELEMETRY_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [] as [],
  urlQueryParams: false,
  databaseQueryData: false,
  stackFrameVariables: false,
};

export function scrubTelemetryString(value: string) {
  return value
    .replace(ELEMENT_LABEL, "")
    .replace(SECRET_SEGMENT, "/$1/[redacted]")
    .replace(URL_SUFFIX, "$1");
}

/** Redacts secrets in place from a Sentry event, transaction, breadcrumb or log, and returns it. */
export function scrubTelemetry<T>(value: T): T {
  walk(value, new WeakSet());
  return value;
}

/**
 * `beforeBreadcrumb`. Console breadcrumbs hold the logged objects themselves
 * (`data.arguments`), which the app still uses, so they are dropped rather
 * than scrubbed in place; the joined message remains.
 */
export function scrubBreadcrumb<T extends { category?: string; data?: unknown }>(breadcrumb: T): T {
  if (breadcrumb.category === "console") delete breadcrumb.data;
  return scrubTelemetry(breadcrumb);
}

function walk(node: unknown, seen: WeakSet<object>) {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    // SDK-internal request/scope objects; never serialized into the envelope.
    if (key === "sdkProcessingMetadata") continue;
    const value = record[key];
    if (QUERY_KEYS[key] === true) delete record[key];
    else if (SENSITIVE_KEY.test(key) && value != null && value !== "") record[key] = "[redacted]";
    else if (typeof value === "string") record[key] = scrubTelemetryString(value);
    else walk(value, seen);
  }
}
