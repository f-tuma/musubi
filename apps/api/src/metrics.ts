import { createServer } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "@musubi/config";
import { logger } from "@musubi/config";
import { account, caldavAccounts, events, session, user, calendars, tasks, externalCalendars, eventOutbox, taskOutbox, eligibleEventOutbox, eligibleTaskOutbox } from "@musubi/db";
import { count, countDistinct, eq, gt, isNull, sql } from "drizzle-orm";
import { clientFamily, clientFamilySql, providerFamily, syncStatusFamily, taskStatusFamily, priorityFamily, snapshotCache } from "./product_metrics";
import { sseStats } from "./handlers/stream";
import { providerHttpMetricsRegistry } from "./sync/provider_http_metrics";

const registry = Registry.merge([new Registry(), providerHttpMetricsRegistry]);
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
const syncDeferrals = new Counter({
  name: "musubi_sync_deferrals_total",
  help: "Account/discovery attempts deferred by explicit scheduler or provider-budget control flow, not failures.",
  labelNames: ["stage", "provider", "reason"] as const,
  registers: [registry],
});

const scheduledTaskSkips = new Counter({
  name: "musubi_scheduled_task_skips_total",
  help: "Scheduled task ticks skipped because the previous run was still active.",
  labelNames: ["task"] as const,
  registers: [registry],
});

const reminderPushes = new Counter({
  name: "musubi_reminder_pushes_total",
  help: "Web push reminders the dispatcher attempted, by outcome.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

// `gone` is not a failure: a browser that revoked permission or cleared its
// storage answers 404/410, the subscription is dropped, and that is the system
// working. Alerting on it would page somebody for a user closing a tab.
export type ReminderPushOutcome = "failed" | "gone" | "sent";

export function recordReminderPush(outcome: ReminderPushOutcome, count = 1) {
  if (count > 0) reminderPushes.inc({ outcome }, count);
}

export type ScheduledTaskName =
  | "cleanup"
  | "external_sync"
  | "event_outbox"
  | "notifications"
  | "reminders";

export function recordScheduledTaskSkip(task: ScheduledTaskName) {
  scheduledTaskSkips.inc({ task });
}

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

const SYNC_DEFERRAL_REASONS = new Set(["queued-read", "credit", "cooldown", "budget-persistence-pending", "work-capacity"]);
export function recordSyncDeferral(stage: "account" | "discovery", provider: string, reason: string) {
  syncDeferrals.inc({ stage: stage === "account" || stage === "discovery" ? stage : "unknown",
    provider: KNOWN_SYNC_PROVIDERS.has(provider) ? provider : "unknown",
    reason: SYNC_DEFERRAL_REASONS.has(reason) ? reason : "unknown" });
}

// --- Usage snapshots (DB-backed gauges) --------------------------------------
// Inventory gauges are not creation counters or daily active users.
// A separate single connection prevents monitoring from occupying request pool slots.
const inventoryPool = new Pool({ connectionString: config.db.databaseUrl, max: 1,
  connectionTimeoutMillis: 1500, idleTimeoutMillis: 10_000, query_timeout: 1500,
  allowExitOnIdle: true });
inventoryPool.on("error", () => logger.warn("metrics.inventory.connection_failed"));
const inventoryDb = drizzle(inventoryPool);

export type OutboxMetricRow = {
  provider: string;
  status: string;
  count: number;
  ageSeconds: number;
  dueCount: number;
  dueLagSeconds: number;
};

/** Monitoring reuses claim eligibility, including causal barriers and leases. */
export async function loadOutboxSnapshot() {
  return inventoryDb.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '1000ms'`);
    const eventDue = eligibleEventOutbox();
    const taskDue = eligibleTaskOutbox();
    const eventRows = await tx.select({
      provider: eventOutbox.provider,
      status: eventOutbox.status,
      count: sql<number>`count(*)::int`,
      ageSeconds: sql<number>`greatest(0, extract(epoch from clock_timestamp() - min(${eventOutbox.createdAt})))::float`,
      dueCount: sql<number>`(count(*) filter (where ${eventDue}))::int`,
      dueLagSeconds: sql<number>`coalesce(greatest(0, extract(epoch from clock_timestamp() - min(${eventOutbox.nextAttemptAt}) filter (where ${eventDue}))), 0)::float`,
    }).from(eventOutbox)
      .where(sql`${eventOutbox.status} not in ('completed', 'not-needed', 'cancelled')`)
      .groupBy(eventOutbox.provider, eventOutbox.status);
    const taskRows = await tx.select({
      provider: taskOutbox.provider,
      status: taskOutbox.status,
      count: sql<number>`count(*)::int`,
      ageSeconds: sql<number>`greatest(0, extract(epoch from clock_timestamp() - min(${taskOutbox.createdAt})))::float`,
      dueCount: sql<number>`(count(*) filter (where ${taskDue}))::int`,
      dueLagSeconds: sql<number>`coalesce(greatest(0, extract(epoch from clock_timestamp() - min(${taskOutbox.nextAttemptAt}) filter (where ${taskDue}))), 0)::float`,
    }).from(taskOutbox)
      .where(sql`${taskOutbox.status} not in ('completed', 'not-needed', 'cancelled')`)
      .groupBy(taskOutbox.provider, taskOutbox.status);
    return { eventRows, taskRows };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

const outboxes = snapshotCache(loadOutboxSnapshot, 15_000);
const outboxStates = ["pending", "attempting", "retry", "unconfirmed", "conflict", "blocked", "not-written"];
const outboxProviders = ["caldav", "google", "microsoft"];

// Sanitized categories can collide; sum counts and preserve the oldest age/lag.
export function boundedOutboxRows(rows: OutboxMetricRow[]) {
  const grouped = new Map<string, OutboxMetricRow>();
  for (const provider of outboxProviders) for (const status of outboxStates) {
    grouped.set(`${provider}:${status}`, { provider, status, count: 0, ageSeconds: 0, dueCount: 0, dueLagSeconds: 0 });
  }
  for (const row of rows) {
    const provider = outboxProviders.includes(row.provider) ? row.provider : "unknown";
    const status = outboxStates.includes(row.status) ? row.status : "unknown";
    const key = `${provider}:${status}`;
    const current = grouped.get(key) ?? { provider, status, count: 0, ageSeconds: 0, dueCount: 0, dueLagSeconds: 0 };
    current.count += row.count;
    current.ageSeconds = Math.max(current.ageSeconds, row.ageSeconds);
    current.dueCount += row.dueCount;
    current.dueLagSeconds = Math.max(current.dueLagSeconds, row.dueLagSeconds);
    grouped.set(key, current);
  }
  return [...grouped.values()];
}

for (const family of ["event", "task"] as const) {
  for (const [suffix, field, help] of [
    ["operations", "count", "Unresolved deliveries by provider and state."],
    ["oldest_seconds", "ageSeconds", "Age of oldest unresolved delivery, including work awaiting manual resolution."],
    ["due_operations", "dueCount", "Deliveries eligible for a worker claim now, excluding waiting predecessors and active leases."],
    ["due_lag_seconds", "dueLagSeconds", "Time since oldest currently eligible delivery became due; zero when none are eligible."],
  ] as const) {
    new Gauge({
      name: `musubi_${family}_outbox_${suffix}`,
      help: `${family.toUpperCase()} ${help}`,
      labelNames: ["provider", "status"] as const,
      registers: [registry],
      async collect() {
        const snapshot = await outboxes.get();
        this.reset();
        if (snapshot) for (const { provider, status, ...row } of boundedOutboxRows(snapshot[`${family}Rows`])) {
          this.set({ provider, status }, row[field]);
        }
      },
    });
  }
}
new Gauge({ name: "musubi_delivery_snapshot_success", help: "Whether latest event/task outbox monitoring refresh succeeded.", registers: [registry],
  async collect() { await outboxes.get(); this.set(Number(outboxes.healthy)); } });
new Gauge({ name: "musubi_delivery_snapshot_timestamp_seconds", help: "Unix time of last successful event/task outbox refresh; zero before first success.", registers: [registry],
  async collect() { await outboxes.get(); this.set(outboxes.lastSuccess); } });

export async function loadUsageSnapshot() {
  return inventoryDb.transaction(async (tx) => {
    // All counts see one database snapshot; the timeout bounds scrape work.
    await tx.execute(sql`set local statement_timeout = '1000ms'`);
    const live = new Date();
    const users = await tx.select({ v: count() }).from(user).where(eq(user.isExternal, false));
    const evts = await tx.select({ v: count() }).from(events).where(isNull(events.deletedAt));
    const cals = await tx.select({ v: count() }).from(calendars);
    const activeUsers = await tx.select({ v: countDistinct(session.userId) }).from(session).where(gt(session.expiresAt, live));
    const activeSessions = await tx.select({ v: count() }).from(session).where(gt(session.expiresAt, live));
    const oauth = await tx.select({ provider: account.providerId, status: account.syncStatus, v: count() }).from(account).groupBy(account.providerId, account.syncStatus);
    const caldav = await tx.select({ v: count() }).from(caldavAccounts);
    const device = clientFamilySql(sql`${session.userAgent}`, "device");
    const os = clientFamilySql(sql`${session.userAgent}`, "os");
    const browser = clientFamilySql(sql`${session.userAgent}`, "browser");
    const devices = await tx.select({ device, os, browser, v: count() }).from(session).where(gt(session.expiresAt, live)).groupBy(sql`1`, sql`2`, sql`3`);
    const taskRows = await tx.select({ status: tasks.status, priority: tasks.priority, provider: externalCalendars.provider, v: count() })
      .from(tasks).leftJoin(externalCalendars, eq(tasks.calendarID, externalCalendars.calendarID))
      .where(isNull(tasks.deletedAt)).groupBy(tasks.status, tasks.priority, externalCalendars.provider);
    const providerCalendars = await tx.select({ provider: externalCalendars.provider, disabled: externalCalendars.disabled,
      events: externalCalendars.supportsEvents, tasks: externalCalendars.supportsTasks, v: count() })
      .from(externalCalendars).groupBy(externalCalendars.provider, externalCalendars.disabled, externalCalendars.supportsEvents, externalCalendars.supportsTasks);
    return { users: users[0].v, events: evts[0].v, calendars: cals[0].v,
      activeUsers: activeUsers[0].v, activeSessions: activeSessions[0].v, devices, taskRows, providerCalendars,
      syncAccounts: [...oauth.map(r => ({ provider: providerFamily(r.provider), status: syncStatusFamily(r.status), value: r.v })),
        { provider: "caldav", status: "unmonitored", value: caldav[0].v }] };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
const usage = snapshotCache(loadUsageSnapshot);
async function usageSnapshot() { return usage.get(); }
new Gauge({ name: "musubi_usage_snapshot_success", help: "Whether the latest inventory refresh succeeded.", registers: [registry],
  async collect() { await usageSnapshot(); this.set(Number(usage.healthy)); } });
new Gauge({ name: "musubi_usage_snapshot_timestamp_seconds", help: "Unix time of last successful inventory refresh; zero before first success.", registers: [registry],
  async collect() { await usageSnapshot(); this.set(usage.lastSuccess); } });
new Gauge({ name: "musubi_sessions_by_client", help: "Unexpired sessions by coarse User-Agent hints, not online users or unique devices.",
  labelNames: ["device", "os", "browser"] as const, registers: [registry],
  async collect() { const s = await usageSnapshot(); this.reset(); if (s) for (const {v, ...labels} of s.devices) this.inc(labels, v); } });
new Gauge({ name: "musubi_tasks", help: "Non-deleted task inventory by status, RFC priority band and home calendar provider.",
  labelNames: ["status", "priority", "provider"] as const, registers: [registry],
  async collect() { const s = await usageSnapshot(); this.reset(); if (s) for (const r of s.taskRows)
    this.inc({status: taskStatusFamily(r.status), priority: priorityFamily(r.priority), provider: providerFamily(r.provider)}, r.v); } });
new Gauge({ name: "musubi_provider_calendars", help: "Discovered provider calendars by enabled state and capabilities; not sync freshness.",
  labelNames: ["provider", "state", "events", "tasks"] as const, registers: [registry],
  async collect() { const s = await usageSnapshot(); this.reset(); if (s) for (const r of s.providerCalendars)
    this.inc({provider: providerFamily(r.provider), state: r.disabled ? "disabled" : "enabled", events: String(r.events), tasks: String(r.tasks)}, r.v); } });

// All collectors await the same in-flight snapshot.
new Gauge({
  name: "musubi_users_total",
  help: "Local (non-federated) user accounts registered on this server.",
  registers: [registry],
  async collect() {
    const s = await usageSnapshot();
    this.set(s?.users ?? NaN);
  },
});

new Gauge({
  name: "musubi_events_total",
  help: "Live (non-deleted) events stored on this server.",
  registers: [registry],
  async collect() {
    this.set((await usageSnapshot())?.events ?? NaN);
  },
});

new Gauge({
  name: "musubi_calendars_total",
  help: "Calendars stored on this server.",
  registers: [registry],
  async collect() {
    this.set((await usageSnapshot())?.calendars ?? NaN);
  },
});

new Gauge({
  name: "musubi_active_users",
  help: "Distinct users with a currently valid (non-expired) session.",
  registers: [registry],
  async collect() {
    this.set((await usageSnapshot())?.activeUsers ?? NaN);
  },
});

new Gauge({
  name: "musubi_active_sessions",
  help: "Currently valid (non-expired) sessions.",
  registers: [registry],
  async collect() {
    this.set((await usageSnapshot())?.activeSessions ?? NaN);
  },
});

new Gauge({
  name: "musubi_sync_accounts",
  help: "Linked accounts by provider (google | microsoft | caldav | credential) and sync status.",
  labelNames: ["provider", "status"] as const,
  registers: [registry],
  async collect() {
    const s = await usageSnapshot();
    this.reset();
    for (const { provider, status, value } of s?.syncAccounts ?? []) {
      this.inc({ provider, status }, value);
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

// Outbound streams this server holds to federated origins (one per connected
// Musubi server per online user) — the cost side of the federated fan-in.
new Gauge({
  name: "musubi_federated_upstream_streams",
  help: "Open outbound SSE streams to federated Musubi servers.",
  registers: [registry],
  collect() {
    this.set(sseStats().federatedUpstream);
  },
});

const syncRuns = new Counter({ name: "musubi_sync_runs_total", help: "Completed account sync attempts, not individual HTTP calls.", labelNames: ["provider", "outcome"] as const, registers: [registry] });
const syncDuration = new Histogram({ name: "musubi_sync_run_duration_seconds", help: "Account synchronization duration including discovery and persistence.", labelNames: ["provider", "outcome"] as const, buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300], registers: [registry] });
const syncObjects = new Counter({ name: "musubi_sync_objects_received_total", help: "Objects received during successful calendar syncs, including repeated full reads; not unique objects.", labelNames: ["provider", "kind"] as const, registers: [registry] });
export function recordSyncRun(provider: string, outcome: "success" | "failed" | "deferred", seconds: number) {
  const labels = { provider: providerFamily(provider), outcome };
  syncRuns.inc(labels); syncDuration.observe(labels, seconds);
}
export function recordSyncObjects(provider: string, events: number, tasks: number) {
  syncObjects.inc({provider: providerFamily(provider), kind: "event"}, events);
  syncObjects.inc({provider: providerFamily(provider), kind: "task"}, tasks);
}

const productRequests = new Counter({ name: "musubi_product_requests_total",
  help: "Authenticated API requests by feature and client hint, including background traffic; not unique users or human actions.",
  labelNames: ["feature", "method", "outcome", "device"] as const, registers: [registry] });

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

export function metricRoute(req: Request) {
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

    const feature = /^\/api\/v1\/(events|tasks|calendars|pages|availability|reminders)(?:\/|$)/.exec(labels.route)?.[1];
    if (req.user && feature) productRequests.inc({ feature, method,
      outcome: status === "aborted" ? "aborted" : res.statusCode < 400 ? "success" : res.statusCode < 500 ? "rejected" : "failed",
      device: clientFamily(req.headers["user-agent"], "device") });
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
