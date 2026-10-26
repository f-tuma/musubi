import { AsyncLocalStorage } from "node:async_hooks";
import { Counter, Histogram, Registry } from "prom-client";
import { budgetAttemptSignal, dispatchProviderHttp } from "./provider_budget";

type ProviderCallContext = {
  provider: string;
  family: "event" | "task";
};

const context = new AsyncLocalStorage<ProviderCallContext | undefined>();
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
/** A queued shared refresh retains only its original bounded labels, never a pump sibling's context. */
export function captureProviderCallMetrics() {
  const captured = context.getStore();
  return <T>(run: () => Promise<T>): Promise<T> => context.run(captured, run);
}

/** Explicit provider telemetry port; only the caller's delivery scope labels it. */
export function recordProviderHttpRequest(method: string, status: number | "network-error" | "aborted", durationMs: number) {
  const scope = context.getStore();
  if (!scope) return;
  const boundedStatus = typeof status === "number"
    ? Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : "unknown"
    : status;
  const labels = { ...scope, method: methods.has(method) ? method : "OTHER", status: boundedStatus };
  requests.inc(labels);
  duration.observe(labels, Math.max(0, durationMs) / 1000);
}

/** Only wrap the leaf network dispatch, never an OAuth-retrying fetch helper. */
export async function observedProviderRequest(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const signal = budgetAttemptSignal(init?.signal ?? (input instanceof Request ? input.signal : undefined));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  let used = false, open = true;
  try {
    return await dispatchProviderHttp({ url: input instanceof Request ? input.url : String(input), method, signal }, async beforeRaw => {
      if (!open || used) throw new Error("Provider HTTP capability is closed or already used.");
      used = true; signal?.throwIfAborted();
      if (beforeRaw && beforeRaw() !== undefined) throw new TypeError("Provider HTTP admission must be synchronous.");
      const startedAt = performance.now(); let status: number | "network-error" | "aborted" = "network-error";
      try { const response = await fetchImpl(input, { ...init, ...(signal ? { signal } : {}) }); status = response.status; return response; }
      catch (error) { if (signal?.aborted || error instanceof Error && error.name === "AbortError") status = "aborted"; throw error; }
      finally { recordProviderHttpRequest(methods.has(method) ? method : "OTHER", status, performance.now() - startedAt); }
    });
  } finally { open = false; }
}

// Resolve global fetch at call time, retaining existing fake-provider test seams.
export const observedProviderFetch: typeof fetch = (input, init) =>
  observedProviderRequest(globalThis.fetch, input, init);
