# C09 DAV routing material and composed read proof

The process cache retains only three validated route strings: root, principal
and calendar home. It stores no client, authorization header, credential, ACL,
calendar inventory, cursor, coverage or resource body. Each attempt creates a
fresh client with its own signal, sticky discovery failure and read-local maps.

The host reads the owned physical account on each attempt. Cache identity binds
the exact six-microsecond PostgreSQL credential revision, private encrypted-row
fingerprint and guarded-network policy. A fresh row check precedes publication.
Tickets prevent an older concurrent attempt from publishing or evicting newer
material. The cache has 256 entries and a five-minute monotonic lifetime;
collection reads do not renew the endpoint-discovery lifetime.

Authoritative `listCalendars` and calendar creation always perform fresh endpoint
discovery. Collection sessions may reuse routing material, but still fetch the
current collection inventory and report support. Every actual target traverses
the existing DNS, TLS, pinning and redirect boundary. Missing collections and
failed discovery invalidate the relevant ticket. Cached routing cannot prove
absence or access retirement.

The request-scope port re-enters a fresh verified account budget scope for each
client request. Native SDK bridges additionally retain an exact private session
binding for their HTTP decorator. The historical operation envelope's numeric
DAV timestamp remains its documented millisecond floor; this adds no monotonic
credential ABA guarantee. Typed quota deferral survives tsdav endpoint fallback,
incremental-sync fallback and specialized writer error conversion.

Reservations precede existing final mutation callbacks at split CREATE, series
DELETE, series PUT, alarm PUT, task CREATE/UPDATE/DELETE, RSVP PUT and organizer
PUT/DELETE. They name the exact canonical URL and method of that physical send.
Existing markers are retained if later admission refuses the send. Shared
portable kernels and host settlement have separate budget gates.

## Reproducible local gates

`pnpm test:behavior --suite caldav-discovery --scenario warm-routes --json`
exercises the production cache with clock and fresh-binding/material ports.
The complete suite has 11 cases, including owner/account isolation, precise
credential and policy changes, stale success/failure, expiry and bounded
eviction. Adjacent harness tests reject malformed scenarios and verify that
credentials and cursor state cannot enter routing material. These are not SQL
or native HTTP evidence.

`pnpm exec tsx apps/api/src/sync/caldav_discovery_material.test.ts` uses a closed
loopback HTTP server and the actual guarded tsdav client. Uncached session
discovery takes six HTTP calls per invocation; a warm material session takes
two, retaining fresh collection and report reads. Authoritative refresh still
takes six. Fresh ACL checks, moved home, credential rotation, cancellation,
failed discovery and current network-policy refusal are checked separately.

With the ordinary synthetic integration environment and a migrated disposable
PostgreSQL database, run:

```sh
pnpm exec tsx apps/api/src/sync/caldav_discovery_material.integration.test.ts
```

This gate uses the actual adapter, `initializeSyncEngine(['pull'])`, global
coordinator and database. Initial account discovery takes seven native calls,
a warm complete resource fetch takes four, and the composed initial sync takes
eleven. Fresh ACL denial takes seven calls and reads no private resources.
It verifies exact cursor/dirty ACK, credential rotation and mid-request changes,
private event/task retirement and restoration, incomplete discovery, persisted
deferral with zero-HTTP immediate retry, and complete absence removal. For the
last removal check, the fixture expires only its owned SQL due time and restarts
the coordinator: SQL time adjustment does not expire a valid in-memory refusal
hint. This proves fresh guarded inventory after coordinator restart, not
same-instance clock expiry. It also
holds account A's actual response while B finishes a full sync, and enqueues
another A discovery during that pull: another real discovery and collection ACK
must run. Equal native IDs in the two accounts retain separate canonical rows.

This composition gate deliberately does not bootstrap provider budgets. Actual
budget counting, cooldown persistence, mutation permission and native deadline
gates are separate. These local proofs establish neither live DAV server
certification nor publication or production deployment.
