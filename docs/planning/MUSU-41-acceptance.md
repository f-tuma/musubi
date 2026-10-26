# MUSU-41 / C09 — fair work and actual provider HTTP budgets

Status: implementation and integration in progress. This is not final acceptance,
publication, live-provider certification or deployment evidence. C08 is published
by [PR #387](https://github.com/f-tuma/musubi/pull/387), squash `e75d5c7`.

## Work and authority

One singleton API coordinator covers enabled discovery/collection pulls, event
and task deliveries, and Outlook move advancement. Direct delivery wakeups enter
the same coordinator. Background enablement retains independent/legacy/disabled
recovery and the existing pull interval. Disabling a background schedule does not
disable authorized direct request wakeups.

The four execution slots are shared across families. Selection rotates account,
lane and family heads before the SQL limit. Retained delivery rows are not hidden
by joins to a live source or credential. Candidate identities and collision hints
select work; existing outbox claims, predecessors, resource/family fences and
source authority still decide whether it may execute.

Discovery remains complete account-level inventory. Collection jobs reuse the
existing real import paths: Google/Graph events, native task lists, and one DAV
mixed-component stream with its existing shared cursor. Incomplete discovery
never becomes authoritative absence. Graph keeps its complete atomic window and
tracked-family apply. Non-Graph imports keep per-item commits and their partial
SSE invalidations.

`sync_read_work` stores physical connection/source/configuration captures and
decimal-string PostgreSQL bigint dirty generations. An enqueue during a pull
increments requested generation without consuming it in the active ACK. Final
cursor CAS and the captured generation's ACK share a transaction. Per-item and
discovery effects revalidate after their lock waits. The ephemeral
`SyncReadWorkExecution` carries an explicit AbortSignal; it is never serialized
into the durable capture.

Retired read metadata is distinct from successful completion. Fresh current
enqueue may reactivate it without resetting counters or removing a persisted
cooldown. Optional task unavailability remains pending with a typed durable
deferral; it does not falsely ACK unread generations or become an account failure
merely because another manual sync requested a newer generation.

## HTTP admission and waiting

Provider SDK HTTP ports have one optional dispatch decorator around their guarded
one-shot raw send. Legacy HTTP uses the same host budget before its existing raw
telemetry span. Pages, read-401 recovery, OAuth token requests, discovery, preflight,
mutation, readback and DAV redirect hops are separate actual dispatches. Refusal
before a raw send produces no HTTP count or fabricated provider status. Raw
response-header timing excludes admission, persistence and response-body parsing.

Budget keys are private scheduling metadata. Account rate identity uses the
physical connection row and survives grant/credential rotation. Authentication
and mutation reservations retain the current full incarnation. Provider and
application scopes are shared; no verified tenant exists in the current schema,
so no tenant identity is inferred from email, opaque account IDs or token payloads.
Preconnection DAV verification and best-effort revocation have explicit scopes.

Configured token buckets are local operator limits, not official quota figures.
`EXTERNAL_PROVIDER_BUDGETS_JSON` overrides the provider/application/account
dimensions per provider; `EXTERNAL_PROVIDER_BUDGET_NAMESPACE` scopes the private
deployment keys. Defaults are explicit local policy: provider/application burst
16 with 8 tokens per second, account burst 4 with 2 tokens per second.
Each configured local refill must provide at least one token per 15 seconds.
The host retains a native continuation for a single budget wait of at most
15 seconds; longer server cooldowns return the original deferral and exact due
time to durable work. This releases logical capacity and does not shorten the
provider's Retry-After. The storage-free runtime permits other host policies.
Cold buckets start empty and gain only process-monotonic credit. Observed
Retry-After cooldowns use a separate durable scope table with max updates and a
fresh DB clock after lock waits. A failed post-header persistence operation keeps
the real response/acceptance facts, closes the shared dispatch gate and schedules
a bounded retry outside workers. Uncommitted observations have an explicit crash
gap; persisted cooldowns are the restart guarantee.

Waiting must preserve native pagination and authentication continuations while
releasing the execution slot, account and temporary advisory collision holds.
Resumption reacquires a fair permit and revalidates the actual lease, source and
signal. Persistent predecessor/family journals retain their authority. The
continuation pool remains bounded. Pulls use a 90-second lack-of-progress
watchdog, renewed by actual HTTP and DB progress, instead of a total inventory
deadline. Explicit budget parking pauses only that watchdog; lease renewal and
cancellation remain active. A stalled request/body or DB wait is still bounded.
Process death retries from the committed cursor without treating partial paging
as complete coverage. Existing write attempts retain their 45-second deadline.
OAuth singleflight must own an independent bounded refresh job and cancellation;
one waiter's cancellation cannot cancel another waiter's refresh.

Direct physical-account previews also use ephemeral regular jobs in that same
pool. Preconnection and revocation use explicit application capability groups;
neither creates a fake persisted account. Dependency headroom is reserved for
refresh jobs, so parked regular jobs cannot consume every logical admission.
The API bounds regular logical work at four and auxiliary refresh work at four,
with at most four execution slots held across both groups.
Overload returns a bounded control deferral instead of silently queueing an
unbounded request or executing a failed request's late capability.

## DAV and verification

See [DAV material and call-count proof](MUSU-41-dav-material.md). Only reusable
root/principal/home routing material is cached. Credentials, clients, signals,
read-local maps, collection inventory, ACLs and cursors remain fresh. Complete
account discovery still rechecks routes and authority. The private binding uses
the actual SQL microsecond revision and encrypted-credential/server/user digest;
it does not invent a monotonic DAV ABA guarantee.

Fast production scenarios are available through `pnpm test:behavior --list`;
start with `--suite fair-work --scenario account-a-429-b-ready` or
`--suite caldav-discovery --scenario warm-routes`. They replace explicit dependency
ports and do not prove PostgreSQL, installed closure, authentication or live
provider behavior.

The checked-in DB suites cover dirty enqueue/claim/lease/rebind, real lock waits,
process kill/restart, scope cooldowns, fair SQL selection, stale-metadata
retirement and parked claim timing. The queued DAV integration exercises the real
engine with PostgreSQL and controlled native HTTP, including a blocked A while B
finishes, a new dirty generation during A's pull, and actual access retirement.

Final source checks, installed API/reference validation, running application
confirmation, independent exact-commit approval, current-head CI, squash/main
verification and later joint deployment remain separate gates. No blanket
old-binary rollback or mixed-worker guarantee is asserted, including the C08
Google RSVP private marker boundary.
