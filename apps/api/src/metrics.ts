import { createServer } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { logger } from "@musubi/config";
import { db, account, events, session, user, calendars } from "@musubi/db";
import { count, countDistinct, eq, gt, isNull } from "drizzle-orm";
import { sseStats } from "./handlers/stream";

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

const externalSyncFailures = new Counter({
  name: "musubi_external_sync_failures_total",
  help: "Total number of failed external calendar synchronization operations.",
  labelNames: ["stage", "provider"] as const,
  registers: [registry],
});

export type ExternalSyncFailureStage = "account" | "discovery" | "push" | "scheduler";

const KNOWN_SYNC_PROVIDERS = new Set(["caldav", "google", "microsoft", "all"]);

export function recordExternalSyncFailure(
  stage: ExternalSyncFailureStage,
  provider: string,
) {
  externalSyncFailures.inc({
    stage,
    provider: KNOWN_SYNC_PROVIDERS.has(provider) ? provider : "unknown",
  });
}

// --- Usage snapshots (DB-backed gauges) --------------------------------------
// Current-state counts only; Grafana derives "added in last 7d" with PromQL
// (`delta(musubi_events_total[7d])`). Prometheus stores the time series, so we
// never query a time window here — just COUNT(*).

type UsageSnapshot = {
  users: number;
  events: number;
  calendars: number;
  activeUsers: number;
  activeSessions: number;
  syncAccounts: { provider: string; status: string; value: number }[];
};

// ponytail: cache 60s — scrape runs ~every 15s, no need to hit the DB 4×/min.
let usageCache: UsageSnapshot | null = null;
let usageCachedAt = 0n;
const USAGE_TTL_NS = 60_000_000_000n;

async function usageSnapshot(): Promise<UsageSnapshot> {
  const now = process.hrtime.bigint();
  if (usageCache && now - usageCachedAt < USAGE_TTL_NS) return usageCache;

  const live = new Date();
  const [users, evts, cals, activeUsers, activeSessions, syncAccounts] =
    await Promise.all([
      db.select({ v: count() }).from(user).where(eq(user.isExternal, false)),
      db.select({ v: count() }).from(events).where(isNull(events.deletedAt)),
      db.select({ v: count() }).from(calendars),
      db
        .select({ v: countDistinct(session.userId) })
        .from(session)
        .where(gt(session.expiresAt, live)),
      db.select({ v: count() }).from(session).where(gt(session.expiresAt, live)),
      db
        .select({
          provider: account.providerId,
          status: account.syncStatus,
          v: count(),
        })
        .from(account)
        .groupBy(account.providerId, account.syncStatus),
    ]);

  usageCache = {
    users: users[0].v,
    events: evts[0].v,
    calendars: cals[0].v,
    activeUsers: activeUsers[0].v,
    activeSessions: activeSessions[0].v,
    syncAccounts: syncAccounts.map((r) => ({
      provider: r.provider,
      status: r.status,
      value: r.v,
    })),
  };
  usageCachedAt = now;
  return usageCache;
}

// A single collect() drives every usage gauge so the snapshot (and its cache)
// is computed once per scrape instead of once per metric.
new Gauge({
  name: "musubi_users_total",
  help: "Local (non-federated) user accounts registered on this server.",
  registers: [registry],
  async collect() {
    const s = await usageSnapshot();
    this.set(s.users);
  },
});

new Gauge({
  name: "musubi_events_total",
  help: "Live (non-deleted) events stored on this server.",
  registers: [registry],
  async collect() {
    this.set((await usageSnapshot()).events);
  },
});

new Gauge({
  name: "musubi_calendars_total",
  help: "Calendars stored on this server.",
  registers: [registry],
  async collect() {
    this.set((await usageSnapshot()).calendars);
  },
});

new Gauge({
  name: "musubi_active_users",
  help: "Distinct users with a currently valid (non-expired) session.",
  registers: [registry],
  async collect() {
    this.set((await usageSnapshot()).activeUsers);
  },
});

new Gauge({
  name: "musubi_active_sessions",
  help: "Currently valid (non-expired) sessions.",
  registers: [registry],
  async collect() {
    this.set((await usageSnapshot()).activeSessions);
  },
});

new Gauge({
  name: "musubi_sync_accounts",
  help: "Linked accounts by provider (google | microsoft | caldav | credential) and sync status.",
  labelNames: ["provider", "status"] as const,
  registers: [registry],
  async collect() {
    this.reset();
    for (const { provider, status, value } of (await usageSnapshot()).syncAccounts) {
      this.set({ provider, status }, value);
    }
  },
});

// Live SSE (Server-Sent Events) connections — in-memory, so read directly with
// no cache. Shows real-time connection load; peaks are visible as the max of
// the time series in Grafana.
new Gauge({
  name: "musubi_sse_connections",
  help: "Currently open Server-Sent Events (live update) connections.",
  registers: [registry],
  collect() {
    this.set(sseStats().connections);
  },
});

new Gauge({
  name: "musubi_sse_users",
  help: "Distinct users with at least one open SSE connection.",
  registers: [registry],
  collect() {
    this.set(sseStats().users);
  },
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
