import { AsyncLocalStorage } from "node:async_hooks";
import { Counter, Histogram, Registry } from "prom-client";

type ProviderCallContext = {
  provider: string;
  family: "event" | "task";
};

const context = new AsyncLocalStorage<ProviderCallContext>();
export const providerHttpMetricsRegistry = new Registry();
const requests = new Counter({
  name: "musubi_provider_http_requests_total",
  help: "Actual HTTP dispatches within event/task delivery, including preflight, observation and OAuth refresh; not delivery attempts.",
  labelNames: ["provider", "family", "method", "status"] as const,
  registers: [providerHttpMetricsRegistry],
});
const duration = new Histogram({
  name: "musubi_provider_http_request_duration_seconds",
  help: "Time until provider HTTP response headers or transport failure during delivery; excludes response body parsing.",
  labelNames: ["provider", "family", "method", "status"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [providerHttpMetricsRegistry],
});

const methods = new Set([
  "GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE",
  "PROPFIND", "PROPPATCH", "REPORT", "MKCALENDAR", "MKCOL", "COPY", "MOVE",
  "LOCK", "UNLOCK", "ACL",
]);

/** Scope labels to the accepted delivery. No account/object address is retained. */
export function withProviderCallMetrics<T>(
  provider: string,
  family: ProviderCallContext["family"],
  run: () => Promise<T>,
): Promise<T> {
  return context.run({ provider: ["caldav", "google", "microsoft"].includes(provider) ? provider : "unknown", family }, run);
}

/** Only wrap the leaf network dispatch, never an OAuth-retrying fetch helper. */
export async function observedProviderRequest(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const scope = context.getStore();
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  // Fetch on an already-aborted signal cannot dispatch a network request.
  if (!scope || signal?.aborted) return fetchImpl(input, init);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const startedAt = performance.now();
  let status = "network-error";
  try {
    const response = await fetchImpl(input, init);
    status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
      ? String(response.status) : "unknown";
    return response;
  } catch (error) {
    if (signal?.aborted || error instanceof Error && error.name === "AbortError") status = "aborted";
    throw error;
  } finally {
    const labels = { ...scope, method: methods.has(method) ? method : "OTHER", status };
    requests.inc(labels);
    duration.observe(labels, Math.max(0, performance.now() - startedAt) / 1000);
  }
}

// Resolve global fetch at call time, retaining existing fake-provider test seams.
export const observedProviderFetch: typeof fetch = (input, init) =>
  observedProviderRequest(globalThis.fetch, input, init);
