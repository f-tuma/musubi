import { createServer } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { logger } from "@musubi/config";

const registry = new Registry();
registry.setDefaultLabels({ service: "api" });

collectDefaultMetrics({
  prefix: "musubi_",
  register: registry,
});

const httpRequests = new Counter({
  name: "musubi_http_requests_total",
  help: "Total number of completed Musubi API HTTP requests.",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

const httpRequestDuration = new Histogram({
  name: "musubi_http_request_duration_seconds",
  help: "Duration of Musubi API HTTP requests in seconds.",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

const httpRequestsInFlight = new Gauge({
  name: "musubi_http_requests_in_flight",
  help: "Number of Musubi API HTTP requests currently being processed.",
  labelNames: ["method"] as const,
  registers: [registry],
});

const KNOWN_HTTP_METHODS = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
]);

function metricMethod(method: string) {
  return KNOWN_HTTP_METHODS.has(method) ? method : "OTHER";
}

function metricRoute(req: Request) {
  // Registered patterns keep cardinality bounded and prevent identifiers or
  // invite/auth tokens from becoming metric labels.
  return typeof req.route?.path === "string" ? req.route.path : "<unmatched>";
}

export function middlewareMetrics(req: Request, res: Response, next: NextFunction) {
  const method = metricMethod(req.method);
  const startedAt = process.hrtime.bigint();
  let observed = false;

  httpRequestsInFlight.inc({ method });

  const observe = () => {
    if (observed) return;
    observed = true;

    const status = res.writableEnded ? String(res.statusCode) : "aborted";
    const labels = { method, route: metricRoute(req), status };
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;

    httpRequests.inc(labels);
    httpRequestDuration.observe(labels, durationSeconds);
    httpRequestsInFlight.dec({ method });
  };

  res.once("finish", observe);
  res.once("close", observe);
  next();
}

export function startMetricsServer(port: number) {
  const server = createServer(async (req, res) => {
    const path = req.url?.split("?", 1)[0];
    if (req.method !== "GET" || path !== "/metrics") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found\n");
      return;
    }

    try {
      const metrics = await registry.metrics();
      res.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": registry.contentType,
      });
      res.end(metrics);
    } catch (error) {
      logger.error("metrics.scrape.failed", { error });
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Metrics collection failed\n");
    }
  });

  server.on("error", (error) => {
    logger.error("metrics.server.failed", { port, error });
  });
  server.listen(port, "0.0.0.0", () => {
    logger.info("metrics.server.started", { port, path: "/metrics" });
  });

  return server;
}

export { registry as metricsRegistry };
