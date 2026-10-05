# EVENT outbox worker

K08b adds recovery to the persisted K07 intents and K08a create identities. This
is at-least-attempted delivery with provider-specific reconciliation, not a
distributed transaction or an exactly-once claim.

Current generic EVENT recovery scope reviewed for **v0.2.2 on 2026-10-05**.
Specialized organizer, recurrence and RSVP journals have their own conditional
write, dispatch-marker and acknowledgement rules; they do not inherit permission
to resend from the generic recovery description below. See the
[capability matrix](../../packages/docs/src/content/docs/operations/capabilities.mdx)
for their supported scopes and separate acceptance status.

The request path and background tick call one dispatcher. The existing API
process runs a non-overlapping tick every 15 seconds, at most 40 candidates and
four concurrent deliveries. Disabling external sync disables background ticks.
An unsuccessful predecessor blocks later operations on its original connection
generation. Older revisions can be acknowledged only when the persisted target
successor chain covers the newer local revision. A completed predecessor can
advance the captured validator; it cannot replace a newer accepted inbound one.

Claims use `FOR UPDATE SKIP LOCKED`, a random token and a 120-second lease.
Provider work has a 45-second deadline, cancellation signals and lease renewal.
Expired attempts enter reconciliation. Completion checks the token and actual
wall-clock lease under locks, then commits the provider mapping and receipt in
one transaction. An expired or displaced worker cannot acknowledge another
attempt, including after waiting for a DB lock. No HTTP runs in that transaction.

- Create recovery verifies K08a operation identity and projected content.
  Missing Google/CalDAV objects may be retried with the same conditional identity.
  Missing Graph objects after an ambiguous attempt remain blocked; no unbounded
  `transactionId` retention is assumed. Ambiguous legacy unmarked creates block.
- Update recovery reads current content. The captured strong ETag permits a
  conditional retry for Google/CalDAV; bounded Outlook personal title/notes/location
  PATCH preserves its exact accepted native weak `@odata.etag` instead. Matching
  intended projected content permits acknowledging the observed result. Other
  content is a conflict. A fresh ETag alone never rebases an edit. Outlook's
  generic writer still refuses time, meetings, recurrence and shared-calendar
  writes; specialized journal paths remain separate.
- Delete recovery accepts observed absence. Google/CalDAV require the accepted
  strong ETag before retrying a surviving resource; a changed resource conflicts.
  Outlook personal DELETE instead uses the owner's explicitly accepted
  non-atomic fresh permission/kind/version preflight: live Graph ignored stale
  `If-Match`. An ambiguous Outlook deletion only reads afterward, even if the
  surviving version is unchanged. A new, explicitly confirmed current comparison
  may create a fresh delete intent that sends once; retry/crash of that intent
  again uses read-only recovery. This is not CAS or permission for unconditional
  retries. [Guarded-delete evidence](../audits/outlook-guarded-delete-20260921.md).
- Transient failures back off with jitter and respect `Retry-After`. Permission,
  reconnect and unsupported writes block. Unconfirmed operations retain their
  ambiguity even while waiting for the next reconciliation attempt.

Pull holds the event lock before inspecting outbound state. An accepted old
ETag is a no-op. Own in-flight echo preserves newer local content; other incoming
content is retained in `remote_snapshot` as a conflict before the cursor advances.
Create operation markers are scoped to the original provider/account/calendar
connection and deterministic resource identity where available, preventing an
unmapped echo from creating a second Musubi event. Late echoes of removed local
identities are retained without resurrecting them. Echo snapshots also retain
provider-owned metadata that is not accepted into the local projection.

`external_event_tombstones` retains unmapped delete addresses, including opaque
Graph IDs. A resource-identity fence serializes these observations with first
mapping acceptance. A delete arriving before create ACK therefore cannot be
skipped by the cursor and followed by a false successful create receipt. The
connection owns these tombstones and removes them on disconnect. Like create
receipts, they are not pruned while that connection can have ambiguous work.

Authoritative inbound changes append derived-target intents in their own local
transaction. The originating provider is excluded. Non-origin authority rules
remain intact. Calendar removal cancels unfinished jobs, preserving whether a
request was already ambiguous. Already-sent HTTP cannot be rolled back by a
disconnect; an old result cannot recreate the removed mapping or target.
Successful derived deletes remove their accepted mappings. A subsequent
authoritative revival enqueues a new create identity after that delete rather
than attempting to update its removed resource.

Recovery compares the adapter's serialized projection, persisted before the
attempt, including CalDAV second precision, all-day date boundaries, Graph text
normalization and recurrence serialization. It does not compare raw local
timestamps against a lossy provider representation.

`musubi_event_outbox_operations` and `musubi_event_outbox_oldest_seconds` expose
bounded provider/state labels. Payloads and snapshots remain private DB records,
never log fields or metric labels. Owner deletion cascades them. Receipts are
retained because deleting create identity evidence would make later echoes and
ambiguous retries unsafe; no automatic success-receipt pruning is enabled.

Validation uses disposable PostgreSQL and local HTTP fixtures: lost create
responses with all three adapters, restart and two claimers, pending echo before
mapping, lease expiry during lock wait, timeout after commit, retry delay,
permission refusal, queued create/update/delete, update reconciliation,
retained pull conflict, authoritative fan-out and disconnect cancellation.
K15 live-account compatibility remains a separate gate. K09 adds client-visible
delivery state and explicit resolution; background delivery does not manufacture
successful receipts for blocked/conflicting operations.
