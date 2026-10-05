# Shared tasks

Tasks use the event ownership model: one canonical identity, one home calendar,
and multiple calendar memberships. This is the implementation contract shipped
in **v0.2.2**; the release branch was merged through PR #331. Reader-facing
behavior lives in the [shared-task guide](../../packages/docs/src/content/docs/guides/shared-tasks.mdx),
with the [API contract](../../packages/docs/src/content/docs/reference/api.mdx#tasks)
and [capability matrix](../../packages/docs/src/content/docs/operations/capabilities.mdx).
The web composes the shared Musubi/shadcn components. Implementation does not
establish live provider or physical-device acceptance.

## Ownership and reads

- `tasks` owns content, status, completion, a nullable `originCalendarID`, and a
  positive server `revision`. `sequence` remains independent provider metadata.
- `calendar_tasks` contains memberships. Reading requires a currently readable
  membership; only `editTasks` at home permits content edits and global deletion.
- Destination `editTasks` permits linking, unlinking that secondary membership,
  or making an independent copy. It does not grant completion authority.
- A home cannot be unlinked or silently promoted to a secondary destination.
  Removing home tombstones the logical task and queues deletes for surviving
  provider copies. Removing a secondary calendar keeps home and identity.
- Removing an account follows the existing event creator-purge policy, capturing
  deletes for surviving foreign provider destinations before FK cleanup.
- Known revoked source reads do not authorize secondary task reads. Home-source
  retirement redacts canonical private text, advances revision and the existing
  privacy generation, and invalidates other readable views. Secondary retirement
  leaves canonical content on other authorized memberships intact.
- Restored home access unlocks content edits, links and copies only after an
  authorized pull has rehydrated its canonical data and current provider
  validator. Home deletion remains separate from that content guard, using
  retained delivery addresses.

Read DTOs expose `originCalendarID`, readable `calendarIDs`, `revision` and action
`capabilities`. The compatibility `calendarID` field is a home alias, never a
secondary permission grant. The home name and unreadable memberships are not
included. A reader with only a secondary membership can still open the task.
Web/native filters, search and calendar projections deduplicate by logical task ID.

## Mutation boundary

| Route | Request | Result |
| --- | --- | --- |
| `POST /api/v1/task-mutations` | Creation fields, ID and home `calendarID` | Mutation receipt |
| `PATCH /api/v1/task-mutations/:taskId` | `{patch, expectedRevision}` | Mutation receipt |
| `PUT /api/v1/task-mutations/:taskId` | Full draft plus `expectedRevision` | Same revision fence; cannot move home |
| `POST /api/v1/task-mutations/:taskId/link` | `{calendarID, expectedRevision}` | Same task with another membership |
| `POST /api/v1/task-mutations/:taskId/fork` | `{calendarID, expectedRevision}` | New identity and home, revision 1 |
| `DELETE /api/v1/task-mutations/:taskId` | `{expectedRevision, unlinkCalendarID?}` | Global tombstone or secondary unlink |

Requests also carry `expectedProviderReadRetiredGeneration` after source
retirement. A stale revision/privacy fence returns 409 with `localCommitted:false`.
PATCH fields are strict and omitted fields do not acquire creation defaults.
Completing sets progress to 100; reopening clears completion time and progress.
Legacy writes without an authoritative revision are refused. Legacy cached task
DTOs remain readable but clients require refresh before offering mutations.

`Idempotency-Key` accepts a mutation UUID. Creation defaults to the task UUID;
other mutations receive a fresh identity when the header is omitted. The
`task_mutations` ledger prevents duplicate commits, including native-only copies.
An exact fork retry recovers the same independent copy with HTTP 201, including
when the original HTTP response was lost or the source later changed revision.
The actor-scoped receipt binds source ID, destination, expected source revision
and privacy generation without storing copied text or memberships. Reconciliation
serializes only a current authorized read of the copy; lost copy read access
returns `task:null, localCommitted:true`. Source access revocation does not revoke
an already legitimate independent copy. Replay does not enqueue another provider
write or emit another `task_created` notification. A reused key with a different
request or operation is a 409; historical receipts without a fingerprint also
remain 409. Other duplicate mutations remain 409. Clients keep the original
fork key and source fences through refresh, route navigation and server/account
round trips until acknowledgement. Only intent identifiers and fences live in
app memory, separated by server/actor scope; browser reload/app restart is not a
persisted-intent guarantee. A stale
original intent is permanently closed under that key before the API returns
`task-fork-not-committed, localCommitted:false`; only this terminal proof lets
clients release a rejected attempt and intentionally copy a refreshed source.
A generic conflict or transport error never releases an unknown pending attempt.

Preflight captures provider projection and source scope. The DB rechecks rights,
privacy generation and source admission under locks, performs CAS, changes links
or tombstone, and inserts immutable `task_outbox` intents in the same transaction.
No provider call is made while the canonical transaction is open.

Successful mutation responses contain `{task, localCommitted:true, delivery?}`.
`task` can be null if permission disappears or authorized reconciliation cannot
be read after commit; clients still close the saved draft and refresh. Deletion
also returns `id`, `revision` and `removed`. A local commit does not claim that all
provider copies have acknowledged it.

## Delivery and provider projections

Request wakeup and background scheduling share the task outbox executor.
Captured source/account IDs, accepted remote validators, immutable projections,
predecessor order, renewable leases, uncertainty and guarded mapping
acknowledgements prevent a late response from changing the task authority.
Delivery evidence survives task/calendar/source removal. Deleting the provider
account owner clears that owner's private outbox; evidence for surviving foreign
destinations remains. Leases commit before HTTP; an expired attempt must reconcile
rather than blindly repeat CREATE.

Only a home pull can change canonical content. Other pulls acknowledge their own
projection. Comparison of provider-supported fields against its accepted baseline
preserves richer canonical fields through lossy serialization. Home changes fan
out to secondary providers; a secondary deletion never globally deletes the task.
Retained delete addresses prevent late source reads from importing deleted copies
as new logical tasks.

| Provider | Destination and current boundary |
| --- | --- |
| Musubi | Native calendar with existing member roles; one identity across calendars. |
| Google | Google Tasks list. Conditional writes and two-state/date-only projections preserve richer Musubi data through baselines. An uncertain CREATE without an address cannot be retried. |
| Microsoft | To Do list owned by the connected user. Existing home writes keep the prior ETag strategy. Secondary create/update/delete is blocked until To Do conditional-write behavior is verified; its receipt reports unsupported writing. An uncertain CREATE without an address cannot be retried. |
| CalDAV | Discovered VTODO collection with verified access. Resource URL, UID and ETag retain scope; deterministic creation permits read-only reconciliation. Existing alarms and unrelated properties remain preserved. |

Provider-native ACLs are not changed by a Musubi link. Google `due` is a scheduled
calendar day and discards time; it is not exact deadline fidelity. CalDAV
timestamps use wire-format second precision without truncating canonical times.
Multiple provider projections for a recurring task are refused until a single occurrence
generator is defined; native membership and existing home recurrence remain.
Microsoft To Do has no documented conditional-write guarantee in its v1.0
update/delete route contract. A preflight read alone is not atomic CAS, and weak
ETag syntax alone is not evidence that a provider supports or rejects CAS.

Primary references: [Google Task resource](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks),
[Google conditional PATCH](https://developers.google.com/workspace/tasks/performance),
[Microsoft todoTask](https://learn.microsoft.com/en-us/graph/api/resources/todotask?view=graph-rest-1.0),
[Microsoft update](https://learn.microsoft.com/en-us/graph/api/todotask-update?view=graph-rest-1.0),
[Microsoft delete](https://learn.microsoft.com/en-us/graph/api/todotask-delete?view=graph-rest-1.0),
[CalDAV RFC 4791](https://www.rfc-editor.org/rfc/rfc4791).

## Receipts, notifications and clients

- `GET /api/v1/task-deliveries` discovers unresolved owned receipts with UUID
  keyset pagination, including retained deletes. Titles come from current
  authorized task reads; unavailable subjects use a generic title.
- `GET /api/v1/tasks/:taskId/delivery` returns sanitized per-destination status.
  Shared readers see only their readable targets; owners may inspect retained
  evidence. Payloads, remote addresses, ETags and raw provider errors stay private.
- `POST /api/v1/tasks/:taskId/delivery/:operationId/retry` re-admits the exact saved
  known-not-written operation, checking current source scope and destination
  editing rights. Conflicts, unsupported writes and uncertain CREATE are refused.
- Authenticated `task_created`, `task_updated` and `task_removed` SSE frames carry
  only task ID, revision and the actual mutation actor. Native and web task stores
  refresh; the notification center resolves current authorized titles. Provider
  pulls refresh data without inventing another human actor.

Sharing actions reuse event detail/menu anatomy and the shared shadcn components.
Readonly mirrors keep link, copy and authorized unlink actions. Native and web
both offer delivery status with the same server-validated retry boundary.
Activity notices remain session-only; durable delivery receipts survive restart.
Cross-instance task linking is not enabled: a local membership cannot reference
another Musubi instance's calendar.

## Migration and verification

Migration 0080 expands and backfills home, membership, revision, source-scoped
mapping metadata, mutation ledger and outbox. Existing UUIDs, UIDs, provider IDs,
ETags, tombstones and SEQUENCE are preserved; identical UIDs never merge tasks.
0081 adds the scoped mapping lookup index; 0082 adds a nullable fork request
fingerprint without changing historical receipt identities. 0083 records fork
commit/noncommit outcomes for safe client intent acknowledgement. All task writers and
calendar/account lifecycle paths use the new model; deploy API and current
clients together.

`pnpm test:db:tasks` runs migration preservation, DB ownership/CAS/lifecycle,
receipt authorization/retry and authenticated API scenarios. Provider integration
checks cover home/secondary pulls, scoped addresses, uncertain delivery,
projection preservation and privacy retirement. Colocated Storybook and browser
scenarios cover sharing actions, readonly mirrors, themes, focus and notifications.

## Client/API compatibility and rollout

Task read URLs retain their released DTO contract: `GET /api/v1/tasks` and
`GET /api/v1/tasks/:taskId`. Shared-task fields are additive. Mutation requests
and committed receipts belong to the distinct `/api/v1/task-mutations` namespace;
web and native clients must never fall back to a legacy write URL.

| Client | API | Mutation outcome |
| --- | --- | --- |
| Released client using `/tasks` | Released API | Released bare-Task/204 behavior. |
| Released client using `/tasks` | Shared-task API | HTTP 426 `code:task-client-upgrade-required`, `localCommitted:false`, before preflight or DB writes; retain draft and update client. |
| Shared-task client using `/task-mutations` | Released API | HTTP 404 on the absent namespace, no legacy write and no fallback; retain draft and update server. |
| Shared-task client using `/task-mutations` | Shared-task API | Revision/privacy-fenced requests and explicit committed receipts. |

The route is the protocol boundary; claiming a newer product version does not
make a legacy request safe. `MIN_CLIENT_VERSION` remains unchanged so compatible
reads and other application features stay available. The new namespace still
requires authentication, calendar authority, expected revision and privacy
admission. A 426 response is never an authorization grant or a committed receipt.

Apply task migrations before starting the shared-task API, then release web and
native clients with the new namespace. During a mixed rollout task reads remain
available, but clients and servers on opposite sides cannot write tasks. Verify
that UI errors keep the draft open and that native store builds are available
before switching production. Do not remove the retained legacy rejection routes
or relabel them as successful writes. Task read/request/receipt schemas are added
to the wire promise without altering the earlier promise or its version baseline.
`task_compatibility.integration.test.ts` mounts the production route registrar and
checks the client/API matrix, read parsing, rejected write retries and current
revision/privacy/authentication fences in a disposable database.

## Unsupported live task destinations

`Calendar.supportsTaskLinks` advertises live-link maintenance separately from
`supportsTasks`. Both clients use the same target policy. Microsoft To Do and
unknown providers are excluded from new live links; independent copies keep
their own home and remain available when ordinary task creation is supported.
The API rejects an unsupported live link before preparation or local acceptance,
and the database repeats admission under the destination source lock. Microsoft
secondary CREATE/UPDATE/DELETE stay blocked by the adapter. An already uncertain
CREATE may only be reconciled by observation, never replayed.

An earlier Microsoft secondary membership is displayed as **Unsupported link**.
Make an independent copy in a supported calendar before removing that Musubi
membership. The confirmation says that the Microsoft item remains in To Do;
manage or remove that separate item there. Unlink retains remote-address evidence
and unsupported delivery receipts, and the Retry action cannot bypass the
conditional-write requirement. Home writes and independent copies preserve
their existing provider contract; a preflight read never proves conditional write
support.
