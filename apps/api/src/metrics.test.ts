// The other half of observability: not "does the server export metrics" but
// "does anything still read the ones it exports".
//
// A dashboard panel whose metric was renamed does not error. It draws an empty
// graph, which looks exactly like a quiet system. An alert rule whose metric was
// renamed does not fire — ever — and nothing tells you, because a rule that
// never matches and a rule that never triggers are the same silence. Both are
// the failure you only discover during the incident they were meant to catch.
//
// So the committed dashboards and alert rules are read as a contract against the
// registry, alongside the two properties of the HTTP metrics that keep them
// usable at all: bounded label cardinality, and no secrets in the labels.
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import type { Request, Response } from "express";

// `@musubi/config` reads the root .env at import time and refuses to load
// without these. Same three the CI workflow provides; defaulted here so the
// file also runs on a machine with no .env at all.
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.ENVIRONMENT ??= "test";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";

const ops = new URL("../../../ops/", import.meta.url);
const grafanaDir = new URL("grafana/", ops);
const alertsFile = new URL("prometheus/musubi-alerts.yml", ops);

/**
 * Suffixes Prometheus derives rather than the application declaring them.
 *
 * A histogram registered as `x` is scraped as `x_bucket`, `x_sum` and `x_count`,
 * so a dashboard naming `x_bucket` is naming a metric that does exist.
 */
const DERIVED_SUFFIX = /_(bucket|count|sum|total_created|created)$/;

/**
 * Series Prometheus itself supplies, which no application registry contains.
 * `up` is the scrape's own verdict and is what the "is it alive" alert reads.
 */
const PROMETHEUS_OWN = new Set(["up"]);

async function main() {
  const { metricRoute, metricsRegistry, middlewareMetrics, boundedOutboxRows } = await import("./metrics");

  const registered = new Set(
    metricsRegistry.getMetricsAsArray().map((metric) => metric.name),
  );

  // A registry that came back empty would wave every reference through.
  assert.ok(
    registered.size > 20,
    `the metrics registry holds only ${registered.size} metrics, which cannot be right`,
  );

  // -------------------------------------------------------------------------
  // Every metric a dashboard or an alert reads still exists
  // -------------------------------------------------------------------------

  const exists = (name: string) =>
    registered.has(name) ||
    registered.has(name.replace(DERIVED_SUFFIX, "")) ||
    PROMETHEUS_OWN.has(name);

  /** Metric names in a PromQL expression: identifiers outside `{…}` and `"…"`. */
  const metricsIn = (expression: string) =>
    expression
      // Label matchers and string literals hold names that are values, not
      // series — `job="musubi-api"`, `status=~"5.."`.
      .replace(/\{[^}]*\}/g, " ")
      .replace(/"[^"]*"/g, " ")
      .match(/\b[a-z_][a-z0-9_]*\b/g)
      ?.filter(
        (token: string) =>
          token.startsWith("musubi_") || PROMETHEUS_OWN.has(token),
      ) ?? [];

  const referenced = new Map<string, string[]>();
  const reference = (name: string, where: string) => {
    const seen = referenced.get(name) ?? [];
    if (!seen.includes(where)) seen.push(where);
    referenced.set(name, seen);
  };

  for (const entry of readdirSync(grafanaDir)) {
    if (!entry.endsWith(".json")) continue;
    const dashboard = JSON.parse(
      readFileSync(new URL(entry, grafanaDir), "utf8"),
    );
    const expressions: string[] = [];
    (function collect(node: unknown) {
      if (Array.isArray(node)) return node.forEach(collect);
      if (!node || typeof node !== "object") return;
      const expr = (node as { expr?: unknown }).expr;
      if (typeof expr === "string") expressions.push(expr);
      Object.values(node).forEach(collect);
    })(dashboard);

    assert.ok(
      expressions.length > 0,
      `ops/grafana/${entry} has no panel queries — the dashboard shape changed ` +
        "and this check is no longer reading it",
    );
    for (const expression of expressions) {
      for (const name of metricsIn(expression)) {
        reference(name, `ops/grafana/${entry}`);
      }
    }
  }

  const alerts = readFileSync(alertsFile, "utf8");
  const rules = [...alerts.matchAll(/- alert:\s*(\S+)([\s\S]*?)(?=\n {6}- alert:|$)/g)];
  assert.ok(
    rules.length >= 4,
    `only ${rules.length} alert rules were parsed out of musubi-alerts.yml — ` +
      "the file shape changed and this check is no longer reading it",
  );

  for (const [, name, body] of rules) {
    const expression = body.match(/\n\s*expr:\s*(.+)/)?.[1] ?? "";
    assert.ok(expression, `alert ${name} has no expr`);
    for (const metric of metricsIn(expression)) {
      reference(metric, `alert ${name}`);
    }

    // An alert nobody can route or read is one nobody acts on.
    assert.match(
      body,
      /\n\s*severity:\s*\S+/,
      `alert ${name} has no severity label, so nothing can route it`,
    );
    assert.match(
      body,
      /\n\s*summary:\s*\S+/,
      `alert ${name} has no summary annotation, so the page says only its name`,
    );
  }

  const dangling = [...referenced]
    .filter(([name]) => !exists(name))
    .map(([name, where]) => `  ${name} — read by ${where.join(", ")}`);

  assert.deepEqual(
    dangling,
    [],
    [
      "",
      "Dashboards and alerts read metrics this server does not export:",
      "",
      ...dangling,
      "",
      "A renamed metric does not error anywhere. The panel draws an empty graph",
      "that looks like a quiet system, and the alert never fires. Either restore",
      "the name in apps/api/src/metrics.ts or update ops/ to match.",
      "",
    ].join("\n"),
  );

  // The reverse is not an error — a metric may exist before anything reads it —
  // but knowing the number is how you notice ops/ drifting behind the code.
  const unread = [...registered].filter(
    (name) => name.startsWith("musubi_") && !referenced.has(name),
  );

  // -------------------------------------------------------------------------
  // The `route` label stays bounded, and keeps tokens out
  // -------------------------------------------------------------------------

  // Express fills `req.route` only for a matched route, and the pattern is what
  // it holds — never the concrete URL. That is what keeps an invite token out of
  // a metric label and the label set finite.
  assert.equal(
    metricRoute({ route: { path: "/api/v1/calendars/:id" } } as Request),
    "/api/v1/calendars/:id",
  );
  // Nothing matched: a 404 probe, or a token URL that hit no handler. The URL
  // itself must not become the label — unbounded cardinality, and secrets in it.
  assert.equal(
    metricRoute({
      originalUrl: "/api/v1/calendars/tokens/s3cr3t-invite-token",
      url: "/api/v1/calendars/tokens/s3cr3t-invite-token",
    } as Request),
    "<unmatched>",
  );
  assert.equal(metricRoute({} as Request), "<unmatched>");

  const response = Object.assign(new EventEmitter(), { writableEnded: true, statusCode: 200 });
  middlewareMetrics({ method: "PUT", headers: {"user-agent": "Mozilla/5.0 (iPhone) Mobile Safari/604"},
    user: {id: "private-user-id"}, route: {path: "/api/v1/tasks/:taskId"} } as Request,
    response as unknown as Response, () => {});
  response.emit("finish"); response.emit("close");
  const product = await metricsRegistry.getSingleMetric("musubi_product_requests_total")!.get();
  assert.equal(product.values.length, 1);
  assert.equal(product.values[0].value, 1, "finish plus close must not double count");
  assert.deepEqual(product.values[0].labels, {feature: "tasks", method: "PUT", outcome: "success", device: "mobile"});
  assert.ok(!JSON.stringify(product).includes("private-user-id"));

  const sanitized = boundedOutboxRows([
    { provider: "private-provider-a", status: "pending", count: 2, ageSeconds: 10, dueCount: 1, dueLagSeconds: 4 },
    { provider: "private-provider-b", status: "pending", count: 3, ageSeconds: 20, dueCount: 2, dueLagSeconds: 2 },
  ]);
  assert.deepEqual(sanitized.find(row => row.provider === "unknown" && row.status === "pending"),
    { provider: "unknown", status: "pending", count: 5, ageSeconds: 20, dueCount: 3, dueLagSeconds: 4 },
    "bounded provider categories must aggregate rather than overwrite colliding rows");
  assert.equal(sanitized.find(row => row.provider === "google" && row.status === "pending")?.count, 0,
    "empty healthy queues have explicit zero values");
  assert.ok(!JSON.stringify(sanitized).includes("private-provider"));

  console.log(
    `Observability contract verified: ${referenced.size} series read by ops/, ` +
      `${registered.size} exported` +
      (unread.length > 0 ? `, ${unread.length} exported but unread` : ""),
  );
}

// The registry keeps a database pool alive for its usage gauges, so the process
// would not exit on its own.
main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
