# Application notifications

The toolbar bell opens one notification center. Settings Connections owns account
management; saved event delivery recovery is reached from the bell and still uses
the existing Delivery dialog, including retained deletions, pagination, retries,
conflict comparison and focus return.

## Source contract

`apps/web/src/notifications/model.ts` defines `NotificationSource`,
`AppNotification` and a typed `NotificationAction`. Each source supplies stable
subject IDs, a current readable title, one detail line, attention state and a
domain action. The collector scopes IDs by source and deduplicates repeated pages.
Discovery and lifetime belong to the source, not the presentation component.

Current adapters:

- Delivery: the authenticated, privacy-filtered `/api/v1/event-deliveries` inbox.
  SSE invalidates the existing delivery query family. An unresolved change always
  needs attention until the server resolves it. Reading cannot dismiss or delete it.
- Connections: one actionable entry per account with `reconnect_required`, opening
  Settings Connections. The entry disappears when current account data recovers.
- Event changes: an authenticated mutation includes `actorID` in its existing
  member-scoped SSE frame. Own writes, unknown actors, duplicates and older
  revisions stay silent. One latest change per event is retained, with a 100-item
  session cap. The authorized account event read is activated only after news
  arrives, so changes outside the visible date range can appear too.
- Task delivery: the sanitized `/api/v1/task-deliveries` inbox opens task delivery
  status on web and native. Retained deletes remain discoverable; Retry never
  replays an uncertain creation or overwrites an unresolved conflict.
- Task changes: authenticated task SSE carries ID, revision and actor only.
  Current authorized task reads resolve titles, with the same own-write, stale
  revision and permission-loss fences as event news. A task update says that it
  changed; its current completed status is not proof of who completed it.

Event/task notices retain IDs, revision and change kind only. Titles come from the
current authorized read after its revision catches up, never the SSE snapshot.
Unreadable, removed and permission-revoked subjects disappear; rejected inbox reads
hide cached delivery titles and offer Retry. None of these reads is written to the
offline snapshot. The read state is scoped to server origin and signed-in user,
bounded to 1,000 IDs and cleared with the authenticated QueryClient at sign-out.
Mark all as read acknowledges collaborator news while preserving outstanding failures.

## Extension and current boundary

Further activity can provide another `NotificationSource` and a typed
action to `NotificationAction`; its component and query adapter own authorization,
refresh and recovery. Add one dispatcher branch in `ApplicationNotifications`
without changing bell, unread presentation or source collection. Do not generate
notifications from every transient query error or infer an actor from creator ID.

Event/task news and read state currently last for the signed-in browser session. SSE
has no durable replay log, so changes made while the tab is closed are not listed
later. Reconnect still refreshes authoritative event and delivery data. A later
durable inbox requires a server-owned activity journal with recipient permissions,
stable cursor, subject/revision dedupe, read receipts and current visibility checks;
the source contract can consume that journal without changing the UI. Federation
delivery inboxes and unknown provider-sync actors are not represented as new
collaborator activity until their sources can identify a truthful actor.

Event details use the same live authorized notification-subject read and the
calendar's existing `DetailList`/`DetailRow` anatomy. Readable cancellations stay
visible with a Cancelled status. A removed record or rejected read immediately
removes its title and notes from the open detail, and closing returns focus to the
toolbar bell. This path is independent of the search palette's cancellation filter.

Stories live beside `NotificationCenter`; they cover loaded, empty, pending,
error, narrow, reading and keyboard focus states in both themes. Unit tests cover
source dedupe, permission loss, stale revisions, scope and lazy reads; browser
tests retain the delivery recovery flow through the new toolbar entry point.


Shared task detail and delivery stories live under `Calendar/Tasks`. Home edits
and completion use the canonical server revision; readable linked calendars do
not gain content authority. A failed independent-copy response retains its
`Idempotency-Key` for the same source revision and destination until acknowledged.
The attempt key is scoped to server origin and user and contains no task text.
New-task retries retain the draft UUID; only starting a separate draft creates a
new task identity.
Native task screens remount their local snapshot on identity changes; rejected
authorized reads remove private task text while transient network failures retain
the last readable snapshot.
