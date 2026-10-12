import assert from "node:assert/strict";
import { createServer } from "node:http";
import { observedProviderFetch, observedProviderRequest, providerHttpMetricsRegistry, withProviderCallMetrics } from "./provider_http_metrics";

async function main() {
  let received = 0;
  let hangingStarted: () => void = () => {};
  const server = createServer((req, res) => {
    received++;
    if (req.url?.startsWith("/hang")) { hangingStarted(); return; }
    const status = req.method === "PROPFIND" ? 207 : req.method === "PATCH" ? 412 : 429;
    res.writeHead(status);
    res.end("private-provider-content");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const privateURL = `${origin}/private-calendar-id?access_token=private-token`;
  try {
    await observedProviderFetch(privateURL);
    const requests = providerHttpMetricsRegistry.getSingleMetric("musubi_provider_http_requests_total")!;
    assert.equal((await requests.get()).values.length, 0, "non-delivery provider traffic is outside this counter");

    await Promise.all([
      withProviderCallMetrics("google", "event", async () => {
        const response = await observedProviderFetch(privateURL);
        assert.equal(response.status, 429);
        assert.equal(await response.text(), "private-provider-content", "observer preserves original response body");
      }),
      withProviderCallMetrics("microsoft", "task", async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal((await observedProviderFetch(privateURL, { method: "PATCH" })).status, 412);
      }),
      withProviderCallMetrics("caldav", "task", async () => {
        assert.equal((await observedProviderFetch(new Request(privateURL, { method: "PROPFIND" }))).status, 207);
      }),
    ]);

    const failure = new Error("private-address network failed");
    await withProviderCallMetrics("google", "task", () => assert.rejects(
      observedProviderRequest(async () => { throw failure; }, privateURL),
      error => error === failure,
    ));
    const controller = new AbortController();
    const started = new Promise<void>(resolve => { hangingStarted = resolve; });
    await withProviderCallMetrics("google", "event", async () => {
      const request = observedProviderFetch(`${origin}/hang/private-event-id`, { signal: controller.signal });
      await started;
      controller.abort();
      await assert.rejects(request, error => error instanceof Error && error.name === "AbortError");
    });
    const beforePreAborted = received;
    await withProviderCallMetrics("google", "event", () => assert.rejects(
      observedProviderFetch(privateURL, { signal: AbortSignal.abort() }),
    ));
    assert.equal(received, beforePreAborted, "pre-aborted request does not reach provider");

    await withProviderCallMetrics("private-provider-id", "event", () => observedProviderRequest(
      async () => new Response(null, { status: 200 }), privateURL, { method: "private-method" },
    ));
    const byLabels = (a: { labels: unknown }, b: { labels: unknown }) => JSON.stringify(a.labels).localeCompare(JSON.stringify(b.labels));
    const counts = (await requests.get()).values.map(({ labels, value }) => ({ labels, value })).sort(byLabels);
    assert.deepEqual(counts, [
      { labels: { provider: "google", family: "event", method: "GET", status: "429" }, value: 1 },
      { labels: { provider: "caldav", family: "task", method: "PROPFIND", status: "207" }, value: 1 },
      { labels: { provider: "microsoft", family: "task", method: "PATCH", status: "412" }, value: 1 },
      { labels: { provider: "google", family: "task", method: "GET", status: "network-error" }, value: 1 },
      { labels: { provider: "google", family: "event", method: "GET", status: "aborted" }, value: 1 },
      { labels: { provider: "unknown", family: "event", method: "OTHER", status: "200" }, value: 1 },
    ].sort(byLabels));
    const exported = await providerHttpMetricsRegistry.metrics();
    assert.ok(!/private-|access_token|127\.0\.0\.1/.test(exported), "no provider content, URL, method or identifiers become labels");
    assert.match(exported, /musubi_provider_http_request_duration_seconds_count\{provider="google",family="event",method="GET",status="429"\} 1/);
    console.log("provider HTTP metrics: concurrent delivery scopes, real responses, network failures, cancellation and bounded labels passed");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
