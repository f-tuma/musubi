# Shared tasks

Status: design proposal based on the task, event and provider audit. No task
schema, API or runtime changes are implemented by this document.

Working branch: `codex/shared-tasks`, based on `ui/shadcn-tailwind` at
`c8747c689e51eccbb9ea31488684fb1b3bfc0d1e`. The UI migration is still a separate
open PR; feature work needs its shared component system.

## Product contract

The owner selected the event ownership model:

- One logical task has one ID, content, status, completion time and progress.
- It has one home calendar and can be linked into several calendars or provider
  task collections. Those links represent the same task, not independent copies.
- Reading requires membership in at least one linked calendar. Changing content
  or completing the task requires `editTasks` on its home calendar.
- Editing a destination calendar permits linking, removing its link or making an
  independent copy; it does not grant shared-content editing.
- A fork creates a new identity and home. Removing a secondary link does not
  delete the shared task. Global deletion is controlled by the home.
- Linking does not automatically change a provider's native sharing or ACLs.

Home unlink, calendar deletion and origin-access retirement need explicit
server policies. Do not silently promote an arbitrary secondary provider to home
or grant it content authority.

## Existing support and gaps

Tasks already share through membership of one calendar, with viewer reads and
owner/editor writes. The current model has a mandatory `tasks.calendarID` with a
cascading FK. The update handler rejects moving to another calendar. See
[schema](../../packages/db/src/schema.ts),
[task queries](../../packages/db/src/queries/tasks.ts),
[task handlers](../../apps/api/src/handlers/tasks.ts) and
[role permissions](../../packages/types/src/permissions.ts).

`external_tasks` already stores provider IDs, ETags and UIDs per collection.
However, outbound lookup and acknowledgement omit the local calendar/source
scope, so different accounts exposing the same external list can be confused.
Task delivery writes one destination after the local mutation and logs failures
without a receipt. Import overwrites the normalized task snapshot; provider
delete/reset sweep tombstones the entire task. These paths must change before
multiple destinations are enabled. See
[external queries](../../packages/db/src/queries/external.ts) and
[sync engine](../../apps/api/src/sync/engine.ts).

`sequence` is provider/iCalendar metadata, not a concurrency revision.
`providerReadRetiredGeneration` is a privacy fence, not revision CAS; preserve its
protection while making source retirement aware of individual projections. See
[CalDAV read-access contract](caldav-read-access.md).

## Model and migration

Add `originCalendarID`, a server-owned positive `revision`, and
`calendar_tasks(taskID, calendarID)` with a unique pair and indexes in both
directions. Keep canonical content on `tasks`. Scope each provider mapping by
local calendar and captured source/connection identity, in addition to its remote
address. Store that projection's accepted validator, projected-field baseline
and delivery state separately from the canonical task.

Backfill preserves every task UUID, provider ID, ETag, UID and tombstone. Set
home to the old `calendarID`, insert its first membership and start revision at
1 independently of `sequence`. Never merge existing tasks by title, due date or
UID. Check existing mapping cardinality before adding new constraints.

Use an expand/backfill/cutover migration. Update all writers, imports and calendar
lifecycle operations before enabling extra links. The old cascading home FK must
not hard-delete shared identity or pending delivery evidence. Removing the home
calendar needs an explicit global-tombstone or home-transfer policy before
activation; never implicitly reassign home. A temporary wire
`calendarID` alias can preserve old reads; it is not the authority for new
permissions, membership or fanout. Old clients must not write without the new
revision precondition or reset memberships through a full DTO update.

## Writes, delivery and inbound changes

Content/status PATCH, link, unlink, delete and fork require `expectedRevision`.
Authorize source visibility and destination rights freshly. Perform canonical
CAS, membership/tombstone changes and immutable delivery-intent insertion in one
DB transaction with a consistent task/link/source lock order. Call providers
after commit. Return a truthful distinction between local commit and delivery.

Use the proven event invariants without inserting task operations into an
event-only table or pretending tasks are events: operation/mutation identity,
captured destination and version, predecessor ordering, leases, conflict
snapshots, retained deletion addresses and guarded acknowledgements. See
[event write boundary](event-write-boundary.md),
[outbox worker](event-outbox-worker.md) and
[delivery recovery](event-delivery-status.md).

Only the home source can authoritatively change canonical content. Accepted
home changes enqueue fanout to other destinations and exclude the source.
Secondary echoes acknowledge their own projection; secondary edits never
silently overwrite the shared task. Compare supported fields against the
projection baseline so lossy serialization cannot erase richer canonical data.
Provider-side removal of a secondary copy must not globally delete the task.

An uncertain CREATE remains `unconfirmed` until provider-specific recovery can
prove its identity. Do not retry blindly and create another remote task. Check
provider conditional-write capabilities explicitly rather than assuming every
task endpoint supports the event contract.

Source privacy remains authoritative: loss of a secondary source must not
redact all other task views; home-source read retirement must protect shared
views, cached details and notification titles. Stale clients and late responses
must not resurrect retired or deleted content.

## Provider destinations

| Provider | Destination and limits |
| --- | --- |
| Musubi | Native task-capable calendar with existing member roles. |
| Google | Google Tasks list, not Google Calendar. Only two task statuses and a date-only scheduled day; no public recurrence field. Preserve richer Musubi fields. |
| Microsoft | To Do list, not an Outlook event calendar. API supports timezone-aware dates, recurrence and five statuses; our current mapper does not preserve them all. Keep unproven shared/non-owner writes disabled. |
| CalDAV | Collection with discovered VTODO support and verified access. Preserve resource URL, UID, ETag, alarms and unrelated properties. Identical UIDs across foreign accounts are not proof of shared identity. |

Google's `due` is documented as a scheduled day, not a deadline, and discards
time. Do not silently translate it into a claim of exact Musubi deadline
fidelity. Microsoft provider IDs can change when a task moves to another list.
Use explicit projection capabilities and account scope for both providers.

Primary references: [Google Task resource](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks),
[Google task creation](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/insert),
[Microsoft todoTask](https://learn.microsoft.com/en-us/graph/api/resources/todotask?view=graph-rest-1.0),
[Microsoft todoTaskList](https://learn.microsoft.com/en-us/graph/api/resources/todotasklist?view=graph-rest-1.0),
[CalDAV RFC 4791](https://www.rfc-editor.org/rfc/rfc4791) and
[iCalendar RFC 5545](https://www.rfc-editor.org/rfc/rfc5545).

## Clients and notifications

Expose one task ID, home, readable memberships, revision and action
capabilities. Never leak names of unreadable calendars. Update web/native
filters, search, dated-task projection, detail and kanban to use readable
memberships and render a logical task once. A readable secondary link must work
even when home is absent from the reader's calendar list.

Content editing and completion use home rights; membership/copy actions use
destination rights. Keep home selection in creation and sharing actions in the
detail menu, following the existing event anatomy and shared shadcn components.
Use `editTasks` consistently; do not infer it from `editEvents`.

Add member-scoped task SSE with trustworthy actor ID, task ID and revision;
invalidate both web and native task stores. Add a typed task source/action to the
[notification contract](../ui/notifications.md). Retain IDs/revisions rather
than private content, and resolve titles through current authorized reads.
Task delivery recovery needs its own truthful domain contract. The existing
session-only activity boundary remains until a durable activity journal exists.

Client identities remain server-origin scoped. Audit federation task routes and
peer capability negotiation before enabling cross-instance writes: a local
junction cannot reference a calendar stored in another instance.

## Implementation order and activation checks

1. Canonical membership/home model, backfill, privacy-safe reads and revision
   contracts; update every writer under an activation gate.
2. Scoped provider mappings, task outbox/recovery, origin-authoritative pull,
   source retirement and projection-preserving fanout.
3. Web/native sharing actions, permissions, deduplication, task SSE and
   notification/recovery adapters; then enable multiple destinations.
4. Extend recurring-task behavior only after defining one authoritative
   occurrence generator. Independent provider repeaters can otherwise create
   different next tasks; existing CalDAV recurrence patches also need review.

Verify before activation: home vs secondary rights; two concurrent writers;
duplicate link; unlink racing delete; inaccessible home with a readable link;
different accounts exposing the same remote list; echo before ACK; loss of a
CREATE response; worker restart; source read loss/restoration; late responses
after deletion; preservation of rich fields after Google projection; shared
completion with two provider copies; keyboard/focus and both themes. Extend
existing task API, provider integration, task-calendar projection, web/native
task, notification and Radicale round-trip tests for these cases.
