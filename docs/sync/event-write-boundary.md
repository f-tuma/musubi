# EVENT delivery boundary

Current contract reviewed for **v0.2.2 on 2026-10-05**. K06 was accepted and
squash-merged in PR #119; K07 introduced the durable intent and request's first
claimed attempt now used with the [outbox worker](event-outbox-worker.md).
K06/K07 sections below preserve their original implementation/review checkpoints.
Their then-pending review, future K08 recovery and 0.2.0 product-version notes
are historical evidence, not the present implementation or release status.

The generic Outlook personal writer supports bounded title/notes/location PATCH
and explicitly accepted, preflight-guarded DELETE as described below. It still
refuses time, meeting, shared-calendar and series mutations. Separately proven
Outlook organizer, occurrence/series, move and RSVP paths do not widen that
generic writer; their current scope and dated acceptance are in the
[capability matrix](../../packages/docs/src/content/docs/operations/capabilities.mdx).
Read/create and genuinely local unlink remain available. Tasks have a
[separate ownership/delivery contract](shared-tasks.md) and are not EVENT
concurrency evidence. No production gate activation is established by this page.

## Provider contract and evidence

- Outlook personal-event content PATCH has bounded [live evidence](../audits/outlook-event-cas-20260921.md).
  Its exact native weak `@odata.etag` is preserved for title/notes/location PATCH
  and before-delete comparisons of owned, attendee-free, non-recurring,
  non-online events. It is not converted to a strong tag. DELETE ignored stale
  If-Match on both documented routes. [Guarded deletion](../audits/outlook-guarded-delete-20260921.md)
  therefore uses a fresh permission/kind/version check, with the product owner's
  explicit acceptance of the remaining GET-to-DELETE race. An ambiguous attempt
  is observed read-only; another DELETE requires a new explicitly confirmed
  intent. This is not atomic conflict protection and does not enable time,
  meeting, shared-calendar or series mutations.

- Google Calendar's [conditional modification guide](https://developers.google.com/workspace/calendar/api/guides/version-resources)
  documents exact resource `etag` in `If-Match` for update/delete and stale-version
  `412`. [Events PATCH](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch)
  preserves omitted fields; supplied arrays replace the entire array. A title
  edit sends only `{"summary":"…"}`. [Events DELETE](https://developers.google.com/workspace/calendar/api/v3/reference/events/delete)
  has no request body. Do not derive ETags from `updated`, sequence or local revision.
- CalDAV [RFC 4791 §§5.3.2–5.3.4](https://www.rfc-editor.org/rfc/rfc4791.html#section-5.3.2)
  requires strong resource ETags, conditional replacement, and support for unknown
  components/properties/parameters. [RFC 9110 §13.1.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1)
  requires strong comparison and forbids a fresh mutation on a false condition.
  Normally that is 412; HTTP permits acknowledgement of an already-applied change.
  This is a conforming-protocol contract, not certification of arbitrary servers.
- CalDAV uses complete guarded GET → selected property changes → complete PUT,
  **not** normalized-event → whole-ICS serialization, projected REPORT → PUT,
  PROPPATCH, or unconditional retries. GET's strong ETag must equal the mapping's
  previously accepted ETag. A newer read is a conflict, not permission to rebase.
  PUT uses that same GET representation/version. Partial responses and invalid
  UTF-8 are refused, never lossy-decoded and written back.
- `ical.js` selects/validates the unique master and encodes changed properties.
  `caldav_event_ical.ts` locates physical content-line spans only. All unrelated
  bytes, folded lines, property parameters, timezone definitions, alarms, unknown
  components, UID, and detached exceptions remain outside serialization. Unknown
  parameters on an edited single property are retained too. Ambiguous/malformed
  selection fails closed. DURATION is replaced by the intended DTEND when a time
  change would otherwise move the unchanged end implicitly.
- K04 restrictions remain: recurrence changes with detached CalDAV exceptions
  are refused; a legacy recurrence change without validated complete scope intent
  still requires possible-create permission. Whole-resource DELETE is whole-series
  deletion, not occurrence deletion. Organizer/collection/resource rights are
  still checked before local mutation.
- For Google and CalDAV, missing/weak/invalid validators are refused, not trimmed, repaired, quoted,
  converted from weak tags, or replaced by `*`. EVENT create/update stores only
  an actual valid response ETag. Missing/weak/malformed update response versions
  become **null**, never the old ETag or a later GET's ETag. CalDAV transformations
  cannot return a strong PUT response ETag under §5.3.4; normal authoritative sync
  must accept their content and version before another write. Google create with
  no usable returned identity is unconfirmed, not an invented mapping.
- 412 never causes an unconditional fallback. Network failures and nonfinal 2xx
  acknowledgements (e.g. 202) remain unconfirmed. Redirects cannot turn a conditional
  mutation into apparent success via GET. Google event mutations refuse redirects;
  CalDAV keeps the installed SSRF/DNS-pinning/credential-stripping boundary.

Local HTTP fixtures prove **client request construction, refusal, preservation and
state transitions only**. No real provider accounts are used or provider-side
stale-write enforcement inferred from fake HTTP.

## Existing integration seams

`apps/api/src/sync/adapter.ts` and `engine.ts` extend the existing paths, not a new
parallel delivery framework:

1. `CalendarEventWrite` supplies `action`, full server event/context (Date values),
   `calendarIDs`, optional `previous`, optional **server-computed actual**
   `EventContentPatch`, and server-only `scopeEditValidated`. Patch values take
   precedence over the event context; undefined is omitted, null is an explicit
   clear. Only existing provider-writable fields (title, description, location,
   time/all-day, recurrence) are projected. Local-only modeled fields are not
   invented as provider fields.
2. `prepareEventWrites(writes, { actorID, mutationID })` clones each operation, resolves its account and
   mapping with the **local calendar scope**, and preflights the entire known
   set before returning a closure. It captures remote IDs, accepted validators
   and UID **before unlink can remove mappings**. Same remote IDs in different
   accounts/local calendars cannot select or update each other's mapping.
3. As a temporary legacy seam, absent `patch` is computed with `diffEventContent`
   only when an actual server-read `previous` is supplied. This is payload
   preservation, **not local CAS**. A mapped update with neither is refused with
   `event-diff-unavailable`; it is never interpreted as an empty diff or a safe
   full snapshot. The old push convenience wrappers have been removed.
4. `adapter.pushUpdate(userID, accountID, externalCalendarID, externalEventID,
   event, capturedRef, actualPatch)` receives the captured expected validator and
   actual diff. `pushDelete(..., capturedRef)` needs no mapping lookup at delivery.
   Only an explicit known empty/local-only patch can produce no provider write.
5. `deliver(onlyAction?, committedRevision?)` is request-scoped and intended for **sequential** calls.
   It returns `EventDeliveryReceipt[]`. Completed actions are not resent; the first
   failure is latched and rethrown on later calls, leaving later actions unattempted.
   Create/update mapping metadata is persisted through existing scoped DB helpers.
   Returned `void` from update means no write; `{etag:null}` means a successful
   write without a reusable validator and must clear the stored ETag.

### Stable internal errors and receipts

- Preflight preserves `EventWriteError` (capability denied/unknown/unsupported),
  `ProviderAuthError`, and `ProviderEventWriteError`. Unknown preflight exceptions
  remain conservative capability-unknown refusals before mutation.
- `ProviderEventWriteError` has `code`: `provider-conflict`,
  `provider-version-unavailable`, `event-diff-unavailable`, or `provider-write-failed`;
  `outcome`: `not-written` or `unconfirmed`; and optional `providerStatus` (412 for
  an actual conditional HTTP conflict). Accepted-vs-fresh conflicts have no HTTP
  412 because no mutation request was issued. None of these claims local rollback.
- A delivery failure throws `EventDeliveryError { receipts, failure }`, never gets
  logged and swallowed as success. Receipts retain action, event/local calendar,
  provider/account and external resource scope. Status is `not-attempted`,
  `completed` (including a known no-op), `not-needed` (no mapped remote target),
  `conflict`, `not-written`, or `unconfirmed`. Mapping persistence failure after
  HTTP success is conservatively unconfirmed; this is not a distributed transaction.
- These remain **internal**. The API publishes only action, status and reason,
  never internal account/resource IDs or raw provider errors to collaborators.

K08a adds [stable create identity and read-only recovery lookup](event-create-recovery.md)
for new persisted intents. Automatic recovery still belongs to K08b.

## K07 transactional intent and first attempt

- `deliver.outbox` is passed into the create/CAS/fork DB writer. It inserts the
  target operations in the same transaction as the event and links, with the
  committed snapshot/revision. An insert failure rolls back the local mutation.
  ICS import retains its existing per-event transaction boundary. Local-only
  changes and actual no-ops need no provider operation.
- Each operation has a UUID, actor/mutation/position uniqueness, original target
  owner/account/link identity, remote calendar/object/ETag/UID, patch/snapshot,
  revision, predecessor ID, attempts and status. Delete addresses survive removal
  of ordinary mappings and event tombstones. Target-owner deletion purges payloads;
  deletion of a different actor does not erase the owner's pending work.
- An optional UUID `Idempotency-Key` supplies mutation identity and passes through
  federation proxy. Duplicate outbound slots return 409 `event-mutation-duplicate`
  before committing another change, including a fork with a different generated ID.
  There is no response replay. Missing headers generate a new identity; existing
  revision CAS still applies. This is outbound operation deduplication, not a
  universal receipt store for local-only writes or import-calendar creation.
- Delivery atomically claims `pending` as `attempting` before any remote mutation
  and executes the persisted snapshot/address/version. Only a completed/not-needed
  predecessor permits a successor's first attempt. Unmapped update/delete behind
  a pending create remains a durable intention, not a falsely completed no-op.
  A changed local revision (create/update) or replaced/disabled target is refused
  before attempting HTTP. Mapping acknowledgement retains K06 revision guards.
- The closure's transient form is retained only for preflight-only checks and
  direct adapter fixtures. Production event mutation handlers use durable intents;
  there is no independent legacy inline push alongside them.
- A process exit before claim leaves `pending`; an exit after claim leaves
  `attempting`. Neither is automatically retried in K07. Conflicts, not-written
  and unconfirmed attempts remain stored and conservatively block successors.
  K08 must implement recovery, provider-specific create identity/reconciliation,
  retry/backoff, pull coordination/fan-out and disconnect cleanup. Checks before
  HTTP do not eliminate races during HTTP. K09 owns user-visible delivery state.
  Completed payload retention also needs a deliberate cleanup policy; do not drop
  pending rows or roll back to an outbox-unaware binary while writes are active.

## Integrated API / CAS / client ordering

- Shared strict write schemas require positive `expectedRevision` on PATCH, the
  compatibility PUT alias, delete, unlink, link and fork. Creates start at server
  revision 1. Optional read revisions exist only for old caches, which cannot save.
  Scope metadata belongs to request envelopes, never Events, disk, providers or URLs.
- Handlers freshly authorize and preflight the entire known write intent, then use
  event-locked transactional CAS before calling conditional delivery. A stale local
  revision causes no local mutation and **zero remote mutations**, including no-ops.
  Omission preserves; supported explicit nullable null clears; actual no-ops do not
  advance revision or timestamp. Link changes and calendar cascades also advance
  revision under the same event-before-link/map lock order.
- Fork atomically guards the source revision and creates a fresh independent ID.
  It retains the established source-preserving endpoint behavior; there is no new
  implicit unlink/move operation. Existing source unlink/delete remains separately
  revision-guarded. Multi-request recurrence edits are not an atomic transaction.
- Prepared provider references survive local unlink. Response mapping writes are
  guarded by committed event revision and captured mapping identity/validator, so
  a delayed outbound acknowledgement cannot bless newer inbound content.
- Precommit conflicts return 409 / `localCommitted:false` and current row/revision.
  Conditional delivery failures return 409 (conflict) or 502 (unconfirmed), with
  `localCommitted:true`, current local row/revision and sanitized partial receipts.
  Local state is not falsely rolled back; notifications announce the local commit.
- Both clients capture the original occurrence, master, links and revision and
  submit only intended content changes. Web More-options authority uses a tab-local
  handoff, not URL metadata; a content-only URL without authority is nonwritable.
  Native save callbacks await success and return the actual scope boolean; Cancel
  does not call the API, change reminders or close. Delete also awaits success.
- Failed drafts retain their baseline and contents. Authoritative receipts refresh
  cache/reminders without replacing newer inbound rows or advancing the draft.
  Actual browser SSE invalidation and native SSE callbacks cross frozen composers
  in regressions. Access-loss removal frames carry a revision; if the source row
  has already been purged, native requests authoritative full reconciliation.
- PRODUCT / MIN_CLIENT / MIN_PEER stay 0.2.0, including member-token refusal and
  documented bootstrap exceptions. The wire snapshot is generated from the actual
  integrated request schemas. K01–K05 restrictions remain; K08 recovery and K12
  atomic scopes are absent. No live-provider certification, production migration
  or release is implied.

## Regression gates

K07 adds `packages/db/src/queries/event-outbox.integration.test.ts` to
`pnpm test:db:events`: insert failure rollback, a separate process exiting after
COMMIT, pending create→update→delete without mapping, stable mutation identity,
concurrent single claim, unlink/tombstone address retention and owner/actor cleanup.
The provider HTTP suite exercises actual create/link/unlink/fork routes, verifies
that provider calls see an already committed/claimed operation, rejects a repeated
fork key, persists subsequent HTTP update/delete after an ambiguous create, and
injects an outbox DB trigger failure with zero local/remote effects.
The final fresh PostgreSQL 18 migration and full DB gate are recorded in
`/tmp/musubi-k07-migrate-verified.log` and `/tmp/musubi-k07-db-verified.log`;
the final extended provider regression is in `/tmp/musubi-k07-provider-final.log`,
and root check is in `/tmp/musubi-k07-check-final.log`. These are disposable local
fixtures, not live-provider certification.


`pnpm test:db:sync` includes
`apps/api/src/sync/adapters/provider_event_writes.integration.test.ts`: actual
adapters, authenticated Express handlers, scoped DB mappings and local HTTP.
It covers title-only Google payload; exact opaque validators; missing/weak/stale
versions; 412 and unconfirmed failures; same-scoped remote IDs; complete rich/folded
CalDAV preservation; missing/transformed write versions; malformed/partial reads;
ordinary nullable/time edits; recurrence boundaries; and delete refs after unlink.
`event_capabilities.integration.test.ts` retains K04 denied/unknown/Outlook refusal
and legacy/validated recurrence-intent coverage. `caldav.test.ts` and
`caldav_client.test.ts` cover existing task/serializer and guarded transport behavior.
Run DB gates only against a newly owned disposable test database.

`event_revision.integration.test.ts` adds authenticated HTTP/DB CAS races, stale
partial drafts, versionless refusal, nullable/no-op behavior, links/fork/cascades
and tombstones. Provider HTTP tests additionally force a local revision change
during preflight (zero remote effects), partial target failure after commit and
stale mapping acknowledgement refusal. Chromium K04/K05/K06 exercises concurrent
editors, SSE, More-options, overnight preservation and local/remote/network/auth/
version failures; native composer tests run actual host callbacks, transport,
store and SSE handling with only native hosts/network/cache boundaries mocked.

## K06 historical review evidence (subsequently accepted)

- Every Event handler protects notification, cleanup and delivery after commit.
  A failed or purged latest read cannot erase `localCommitted:true`: `committed`
  retains transaction snapshots separately from optional `current`/`currentRevision`.
  `current` content and links are read in one PostgreSQL statement snapshot.
  Clients do not use `committed` as latest cache authority. Notification failure
  before delivery is unconfirmed, never invented completion. Existing reminder
  queue/deletion cleanup remains intentionally logged best-effort; actual DB
  cleanup rejection is tested and does not imply the mutation rolled back.
- ICS import retains every successful local receipt and passes each event's proven
  revision into delivery. Partial local import and partial/unconfirmed provider
  delivery return sanitized committed receipts without needing a second DB read.
  Actual delayed HTTP create ACKs across local update and unlink cannot resurrect
  mappings or acknowledge newer revisions. Empty-calendar preflight remains unchanged.
- Calendar lifecycle transaction advisory fences precede event row locks: shared
  admission, exclusive removal, complete deduplicated sets ordered by actual hash
  key (`musubi:calendar-lifecycle:` namespace). Multi-calendar removal prelocks
  the union of event rows. User lifecycle fences (`musubi:user-lifecycle:`) precede
  calendar fences and stabilize new calendars and both ownership-transfer sides.
  These are local lifecycle fences, not global/recurrence atomicity or permission.
  No provider network operation runs under them.
- Confirmed account deletion and the reachable Better Auth native callback retain
  token/session/account/hook behavior: only the adapter's exact user-ID SQL deletion
  is delegated to a fenced DB transaction. Unknown/bulk user-delete predicates fail
  closed. Surviving events affected by FK origin/link cascades advance revision;
  existing account-deletion FK retention/purge policy is unchanged. DEV-only reset
  stays DEV-only and uses the same deletion writer.
- Access-loss SSE uses the unlink transaction's captured revision, not a later relink
  revision. Web and native mutation receipts are request-fenced across intervening
  removal/full access-loss reconciliation, including success and committed errors.
  Later authoritative refresh/revival remains possible. Native commitment handling
  is independent of optional `current`, and an already-absent row is not optimistically
  recreated by saving an older draft.
- All editable URL overrides without a tab-local handoff are nonauthoritative,
  not only title/start time. Untouched nullable text, empty strings and whitespace
  survive title-only web PATCH construction; only edited text is normalized.

Fresh local evidence is recorded in `/tmp/musubi-k06-final-logs/`: full owned-PG18
DB suite (including authenticated fault and account-deletion handlers), root check
(types/tests/contracts/VERIFY/lint/build), and Chromium K04/K05/K06. Fixtures prove
local implementation behavior, not live-provider or physical-device certification.
The independent readonly recheck and final parent acceptance remain outstanding.

### Client-only recheck closure (locally verified, acceptance pending)

Native migration `0007_event_revision` adds a nullable SQLite cache column, with
no invented revision/backfill and no applied migration edits. Bootstrap keeps the
existing Expo drizzle bundled runner. Old rows remain readable but nonwritable;
only an authoritative refresh supplies revision. Both serializers preserve it.
Cache writes use synchronous transactions (the Expo driver is synchronous), retain
higher known revisions across older/unknown writes, and roll back failed replacement.
Rollback of the application can leave the additive column in place; older readers
ignore it. No destructive down migration or production migration was performed.

Native receipt evidence is per affected identity and only retained for in-flight
requests. Unrelated removals/full loads do not discard a confirmed target write.
Versioned removal defeats older receipts, not a proven newer revival. Ambiguous
full/access-loss ordering requests the real home/federated refresh; superseded
successes retain the draft rather than run stale composer reminder callbacks.
Account/server reset invalidates pending receipts and their refresh. A fork/new
server-assigned identity is not fenced by removal of its unrelated source.

Web receipts patch only individually unchanged query instances/data captured at
request start. A date/view query populated later is not patched and its absence or
removal marker cannot be transiently resurrected, even if invalidation cannot
refetch. Unchanged queries still receive normal confirmations.

Fresh SQLite/native/real-hook regressions, root check and Chromium evidence:
`/tmp/musubi-k06-client-closure-logs/`. The SQLite test adapter replaces only Expo's
platform handle and uses Node's actual SQLite with the production cache and migration
runner; it is not device certification. Prior full PostgreSQL evidence is reused
explicitly for unchanged server/shared runtime. These are the three client recheck
repairs, not acceptance of whole K06, a provider certification, or a release.
