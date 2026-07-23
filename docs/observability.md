# Observability

Musubi's API exposes Prometheus metrics and structured JSON logs. This document
covers what's exported, how to scrape it, and the Grafana dashboards shipped in
`ops/grafana/`.

## Metrics endpoint

The API serves Prometheus metrics on a **separate HTTP listener** from the main
app (so `/metrics` is never exposed on the public API port).

- Port: `METRICS_PORT` env var (default `9464`; set `0` to disable the server).
- Path: `GET /metrics`, bound to `0.0.0.0`.
- Registry prefix: `musubi_`, with a constant `service="api"` label.

Implemented in `apps/api/src/metrics.ts`.

## Metrics catalog

### HTTP (per-request, via middleware)

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `musubi_http_requests_total` | counter | `method`, `route`, `status` | Completed requests. `route` is the registered Express pattern (never a concrete URL — keeps tokens/ids out of labels). |
| `musubi_http_request_duration_seconds` | histogram | `method`, `route`, `status` | Request latency. |
| `musubi_http_requests_in_flight` | gauge | `method` | Requests currently being processed. |

### External calendar sync

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `musubi_external_sync_failures_total` | counter | `stage`, `provider` | Failed sync operations. `stage` ∈ `account`/`discovery`/`push`/`scheduler`; `provider` ∈ `google`/`caldav`/`microsoft`/`all`/`unknown`. |

### Usage snapshots (DB-backed gauges)

Computed on scrape via a single query snapshot cached for 60s. These are
**current-state** values only — growth over a time window is derived in Grafana
with PromQL (see below), so no time-range query runs in application code.

| Metric | Labels | Meaning |
|--------|--------|---------|
| `musubi_users_total` | — | Local (non-federated) user accounts. |
| `musubi_events_total` | — | Live (non-deleted) events. |
| `musubi_calendars_total` | — | Calendars. |
| `musubi_active_users` | — | Distinct users with a currently valid session. |
| `musubi_active_sessions` | — | Valid (non-expired) sessions. |
| `musubi_sync_accounts` | `provider`, `status` | Linked accounts by provider (`google`/`microsoft`/`caldav`/`credential`) and sync status. CalDAV/Apple lives in its own table and has no per-account sync status, so it always reports `status="active"`. |

### Live SSE connections (in-memory)

| Metric | Meaning |
|--------|---------|
| `musubi_sse_connections` | Open Server-Sent Events (live-update) connections. |
| `musubi_sse_users` | Distinct users holding at least one SSE connection. |

Per-instance values. With multiple API replicas, sum across them:
`sum(musubi_sse_connections)`.

### Node.js / process defaults

`prom-client` default metrics are exported with the `musubi_` prefix
(`musubi_process_cpu_seconds_total`, `musubi_process_resident_memory_bytes`,
`musubi_nodejs_heap_size_used_bytes`, `musubi_nodejs_eventloop_lag_p99_seconds`,
…).

## Prometheus

Scrape the metrics port under a job named **`musubi-api`** (the shipped
dashboards and alerts assume this label):

```yaml
scrape_configs:
  - job_name: musubi-api
    static_configs:
      - targets: ["musubi-api:9464"]
```

Alert rules live in `ops/prometheus/musubi-alerts.yml` (target down, 5xx surge,
external sync failures).

## Logs (Loki)

Logs are structured JSON. Every request emits `http.request.completed` with
`method`, `route`, `status`, `durationMs`, `requestId`, and `userId` when
authenticated. Level is derived from status (`apps/api/src/middleware/log_handler.ts`):

- `5xx` → `error`
- `4xx` → `warn` (client error, e.g. a rejected write — **not** counted by the
  5xx error panels/alerts; query `status=~"4.."` explicitly to see these)
- else → `info`

Dashboards filter Loki by `compose_project` (a dashboard variable) and
`service="api"`.

## Grafana dashboards

Import JSON from `ops/grafana/` (Dashboards → New → Import). They reference the
Prometheus datasource via a `DS_PROMETHEUS` variable, so they work on any
Prometheus source.

| File | Title | Purpose |
|------|-------|---------|
| `musubi-usage-dashboard.json` | Musubi — Usage | Users, events, calendars, active users/sessions, connected providers, sync health, live SSE load. |
| `musubi-api-dashboard.json` | Musubi API | Request rate, 5xx rate, latency percentiles, in-flight, memory/CPU, event-loop lag. |
| `musubi-logs-metrics-dashboard.json` | Musubi — Logs & Metrics | Combined Prometheus metrics + Loki log panels (errors, sync failures). |

### Useful PromQL

```promql
# Growth over a horizon (Prometheus stores the series; the gauge is a snapshot)
delta(musubi_events_total[7d])
delta(musubi_users_total[24h])

# Connected calendars per provider (exclude email/password logins)
sum by (provider) (musubi_sync_accounts{provider=~"google|microsoft|caldav"})

# Broken syncs (non-active) per provider
sum by (provider) (musubi_sync_accounts{status!="active"})

# 5xx error rate
sum(rate(musubi_http_requests_total{status=~"5.."}[5m])) / sum(rate(musubi_http_requests_total[5m]))
```
