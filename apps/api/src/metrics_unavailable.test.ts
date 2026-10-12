import assert from "node:assert/strict";
// A separate process/registry is intentional: cold failure cannot reuse a prior cache.
process.env.DATABASE_URL = "postgresql://unused:unused@127.0.0.1:1/unavailable";
process.env.ENVIRONMENT = "test";
process.env.BETTER_AUTH_URL = "http://localhost:7531";
process.env.DEV_AUTH_COOKIE_PREFIX = "";
async function main() {
  const { metricsRegistry } = await import("./metrics");
  const start = performance.now();
  const exported = await metricsRegistry.metrics();
  assert.ok(performance.now() - start < 6500, "database outage must not exhaust the scrape timeout");
  assert.match(exported, /musubi_usage_snapshot_success\{[^\n]*\} 0/);
  assert.match(exported, /musubi_delivery_snapshot_success\{[^\n]*\} 0/);
  assert.match(exported, /musubi_delivery_snapshot_timestamp_seconds\{[^\n]*\} 0/);
  assert.ok(!/musubi_(event|task)_outbox_operations\{/.test(exported), "cold queue failure does not fabricate an empty queue");
  assert.match(exported, /musubi_users_total\{[^\n]*\} Na[nN]/);
  assert.match(exported, /# HELP musubi_http_requests_total/);
  console.log("cold database outage: operational metrics still export within the scrape deadline");
}
void main();
