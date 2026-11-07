# CalDAV series: complete resource evidence and conditional delivery

This document records incremental implementation and test evidence. Later sections
supersede earlier “next step” or slice-specific unsupported notes. For the current
supported scope and remaining boundaries, see the
[core remaining-work matrix](../audits/calendar-core-remaining-work.md).

The default-off `EVENT_TIME_EDITS_ENABLED` capability has an internal
`readCaldavSeries` adapter method. It reads the complete calendar object with its
accepted strong ETag and retains the original UTF-8 body, including detached
components, folded lines, alarms, timezone definitions and extension properties.
The body is private server-side evidence; it must not be logged or returned to
clients. This method does not enqueue or perform a scope write.

Preflight checks account ownership, a matching imported event calendar, resource
membership in that collection, DAV write-content privilege, complete GET and the
previously accepted resource ETag. It rejects weak/missing or changed validators,
encoded path traversal/separators and redirects on both PROPFIND and GET,
projected/partial bodies, unexpected UIDs, duplicate component identities,
duplicate scalar properties, meetings and scheduling METHOD resources. The
existing temporal importer still rejects unsupported RANGE/masterless resources
and recurring timed nominal-day durations. Exactly one recurring live master and
the complete local child set must match content, original identity, cancellation
and explicit civil time model. Zoned, floating and all-day representations are
covered. Empty/missing local children do not silently omit provider exceptions.

This evidence differs from a sequence of Google master/child reads: CalDAV stores
the recurrence family in a single calendar object. The internal content writer preserves
untouched bytes and conditionally PUTs that same object using its accepted ETag.
[RFC 4791, section 5.3.4](https://www.rfc-editor.org/rfc/rfc4791#section-5.3.4)
specifies strong calendar-object validators. A local Radicale test confirms that
changing a detached child's title changes the resource ETag and a subsequent
master-title PUT with the old ETag receives 412 without altering that child.
This local result is not iCloud or every-server acceptance.

## Validation and remaining work

Unit tests cover exact original bytes, moved/cancelled children, zoned/floating/
all-day models, incomplete local families, inconsistent identities, stale content,
weak validators, ambiguous scalar properties and meeting/scheduling refusal.
The Radicale integration exercises the actual adapter through PostgreSQL and HTTP:
accepted full read, account and feature-gate refusal, stale resource rejection,
fragment target refusal, missing local child refusal, and the conditional-PUT
concurrency counterexample that Google could not protect. The synthetic collection
is removed after the test. Existing delta/reset/revival/deletion tests still pass.

## Internal content writer

`prepareCaldavSeriesWrite` accepts only master title, description and location.
It validates the complete baseline and patches its original body, preserving
child components, civil times, recurrence, cancellation, alarms and extensions.
The private input records the accepted reference, baseline family, original body,
patch and desired body. Delivery rebuilds that desired body before any GET/PUT;
a forged replacement cannot widen the operation to another field or child.

The default-off `writeCaldavSeries` adapter rechecks account ownership, the active
imported event calendar, collection membership and DAV write privilege. A fresh
complete GET must either match the complete desired resource (recovery/no-op),
or match both the complete baseline and its original strong ETag. Only the latter
permits a PUT with that exact `If-Match`. No GET silently rebases the write.
A successful PUT is followed by another complete GET; its strong ETag and complete
content become evidence only after the whole desired resource matches. A changed
child, alarm or unknown property therefore prevents confirmation even when the
master's projected fields match. No redirects are followed on any scoped request.

Comparison unfolds physical iCalendar lines and ignores property order between
different property names. It compares original values without typed parser
coercion. Parameter spelling/order, repeated-property order and subcomponent order
remain significant conservatively. Server transformations
outside those serialization differences leave the write unconfirmed; this is not
permission to discard or reconstruct unknown data. A 412 is a conflict without a
confirmed write. Lost connections, applied 503 responses and failed post-write
reads stay unconfirmed. Retrying the same private input first reconciles the whole
resource and does not repeat an already applied PUT. These bodies must never be
included in delivery DTOs, conflict previews, receipts, notifications or logs.

Synthetic HTTP tests cover zoned, floating and all-day families with moved and
cancelled children, conditional success, safe baseline retry, applied-503 and lost
response recovery, concurrent child edits, changed alarms/extensions, stale or
weak validators, partial/invalid UTF-8 responses, redirects and tampered intents.
Radicale additionally exercises real adapter authorization, disabled feature gate,
content updates, child/extension/alarm preservation and repeated delivery against
an actual calendar server. The adapter alone does not change local rows or mappings.

## Scoped transaction and durable delivery

The authenticated scope endpoint now accepts personal CalDAV `series/update`
requests for master title, description and location behind the same default-off
flag. It first reads the complete accepted resource outside a DB transaction.
The commit then rechecks master/child revisions and content, complete membership,
sole authoritative calendar links, connection identity, native component mappings
and ETags. A changed context saves neither a local draft nor an operation receipt.
A successful commit saves the master revision, one private resource outbox intent
and the idempotent operation receipt together. Unchanged children keep their own
content and revisions. Same-operation concurrent requests/replays create no second
intent; a no-op produces no outbox row.

Only a complete personal family owned by the connected user is supported. Shared
copies, multiple target mappings, retained local child tombstones, unresolved
family delivery and retained provider deletion observations are refused. Existing
meeting/time/recurrence/following/occurrence refusals remain in force. This bounded
contract does not claim every CalDAV series can already be edited.

The typed worker rechecks the complete committed local context before delivery
and after the provider confirms the complete desired resource. Short transactions
lock calendar lifecycle, resource identity, master, sorted children, mappings and
finally the leased outbox row. All component mapping validators and the completed
receipt advance together. A stale local child, changed mapping/membership, retained
deletion, disconnected destination or expired/replaced lease cannot produce a
partial acknowledgement. Lease expiry at settlement rolls back mapping changes.
Known temporal families cannot fall through the generic single-event ACK.

Complete inbound resource sync still rejects a family with pending local delivery
before updating any component or advancing its cursor. After the family ACK, the
normal pull accepts the echo without duplicating definitions or revising unchanged
children. Both the original and desired raw resource remain private outbox input;
HTTP receipts and conflict endpoints do not expose them. Unexpected provider
preparation errors are replaced with a safe typed error before reaching HTTP
logging; raw parser lines, stacks and causes are not propagated. Generic
single-event conflict hydration and ACK remain unavailable for this typed intent.

## Explicit master-content conflict resolution

The existing authorized conflict GET/confirmation POST now has a typed CalDAV
branch. It reads the whole current resource with a strong ETag after rechecking
account ownership, active destination and DAV resource write privilege. A fresh
baseline can adopt only master title, description and location. Child definitions,
cancellation, time model and recurrence must still match the complete saved local
family. Embedded VTIMEZONE definitions are compared as unfolded physical lines
against the durable original resource: the IANA civil projection alone cannot
prove that embedded offsets or transition rules stayed unchanged. Changed, added
or removed definitions are refused. New private alarms/extensions stay in the
fresh resource bytes and are preserved by the eventual master-content patch.

The public comparison contains only the existing master content/time DTO, never
raw calendars, alarms or extensions. Confirming the displayed remote ETag keeps
the latest saved local master content (title, description and location). The
handler obtains fresh provider evidence again. A short transaction rechecks the
whole local family, revisions, membership, mappings, retained deletions and exact
outbox state; it advances all mapping baseline ETags and saves one replacement
resource intent atomically. The local draft and child revisions remain unchanged.
Concurrent confirmation with the same mutation ID returns the same replacement.
A stale preview or changed local context does not supersede the original intent.

The worker still conditionally writes the complete resource. A later provider
change cannot silently rebase the replacement. Only verified whole-resource ACK
settles all mappings and releases the explicitly superseded CalDAV history, so a
later normal scope edit can proceed. Changed child content/time, removed resources,
meetings, disconnected destinations and unsupported temporal changes remain
unavailable for this bounded resolution; they require additional reconciliation,
not a master-only overwrite. This does not bypass the iCloud unknown-permission
blocker documented below.

Authenticated HTTP/PostgreSQL tests cover concurrent replay, no-op, preparation
races, zoned/all-day/floating delivery, applied-503 recovery, concurrent remote child
changes, changed local children/mappings, replaced leases, retained tombstones,
inbound refusal/echo and generic ACK/resolution refusal. Actual local Radicale also
exercises scoped preparation, durable enqueue, worker delivery and all-component
ACK through a real calendar server. No production flag, version or minimum client
is changed. A subsequent authorized [live iCloud probe](../audits/calendar-icloud-series-live-acceptance.md)
confirmed the internal transport behavior for zoned, all-day and floating master
content edits, complete-resource replay/recovery and concurrent child 412. It did
not establish end-to-end acceptance: a follow-up authenticated zoned scope request
was refused with unknown write permission because resource PROPFIND yielded no
`current-user-privilege-set` evidence. No scope commit or worker ACK followed.
Trustworthy iCloud resource authorization, end-to-end acceptance and resource-aware
conflict resolution remain open; the permission guard stays in place.

## Existing detached occurrence content

The authenticated scope operation also accepts content-only `occurrence`
updates for an existing, active detached definition. The original occurrence
identity and its revision must match the complete imported family. Generated
occurrences, cancellation/revival, time edits and following splits remain
unsupported by this slice.

The private write identifies the target local definition and reconstructs only
its SUMMARY/DESCRIPTION/LOCATION changes. The full resource is verified before
and after editing; master, unrelated exceptions, cancellation, alarms, timezones
and unknown physical properties retain their original bytes. No organizer or
attendee scheduling resource is admitted. Complete resource write privileges
and a strong ETag remain mandatory, including for iCloud.

The scope transaction advances the family revision and selected child revision
and queues one resource intent. Before send and at ACK, its canonical desired
family must equal the actual locked family; all mapping validators advance
atomically. An ambiguous applied PUT is recognized from the complete desired
resource without another write. Existing master-content conflict resolution
explicitly refuses occurrence intents until their own preview contract exists.

Fake HTTP and scoped HTTP/DB tests cover zoned/all-day/floating moved definitions,
concurrent replay, provider conflict, applied 503, preserved sibling cancellation
and byte-for-byte master preservation. A real local Radicale round-trip verifies
native occurrence content and retry. This is not live iCloud application
acceptance and does not enable production flags.

## Cancel an existing detached occurrence

An explicit `occurrence` delete may now cancel an existing active definition.
It replaces only the selected VEVENT's STATUS with CANCELLED; its UID,
RECURRENCE-ID, time, content and subcomponents remain intact. It neither deletes
the shared resource nor modifies the master or sibling components. Cancellation
cannot be combined with a content patch or target the master through this path.

The same frozen revision, native privilege, full-resource ETag, transactional
family update and ACK proof apply. Pull retains the cancellation definition so
the original generated occurrence cannot reappear. Retry after an applied 503
recognizes the complete cancelled resource without another PUT. Generated
occurrence cancellation and revival require subsequent explicit support.

Fake HTTP and scoped DB tests cover zoned/all-day/floating cancellation,
concurrent replay, lost response and native race. Local Radicale additionally
verifies STATUS:CANCELLED, unchanged time and repeat delivery. No scheduling
resources or real iCloud accounts are written by these tests.

## Native generated occurrence definition

The internal conditional writer can now append a detached definition for a generated
occurrence. The shared scope planner proves membership and the exact permitted
content change or cancellation before any transport. The new component clones the
master's physical bytes, preserving alarms and unknown properties, then replaces
DTSTART/DTEND and RECURRENCE-ID and removes recurrence generators. Zoned, all-day
and floating identities are covered. Existing components remain byte-for-byte
unchanged. Full-resource evidence and If-Match recovery prevent duplicate appends.

Fake HTTP tests cover all three time models, applied-503 recovery and malformed or
duplicate definition refusal. Radicale exercises new content and cancellation
components with retry. This is an internal transport capability: public scope
transactions still require an existing detached definition. Atomic creation of the
local child and its external mapping is the next integration step. No provider
flags or iCloud privilege requirements change.

## Generated occurrence scope transaction

Public occurrence content/cancellation scope now accepts an unmaterialized member
with `expectedOccurrenceRevision: null`. Preparation freezes the planner-selected
child ID. Commit rechecks the entire original family and stores the new child,
calendar membership, deterministic native mapping, root revision and one resource
outbox intent in a single transaction. The mapping initially retains the accepted
resource ETag; only a complete family ACK advances every validator together.

Pending resource pulls are refused, including an old body that omits the new
component. An applied 503 is recovered by full GET without another PUT. Completed
pulls reuse the prepared child identity. DB regressions cover all three time kinds,
content/cancellation, preflight races, remote child races and a tombstone collision
that rolls back all local writes. Radicale verifies the scope-to-worker-to-echo
path for new content and cancellation. Reviving a cancelled definition, time edits
and following scopes remain separate work; iCloud unknown privileges stay closed.

## Restore a cancelled detached occurrence

An explicit occurrence update at the cancelled child's current revision restores
that same definition as `STATUS:CONFIRMED`, optionally changing supported content
fields. Its original identity, time and other native properties stay intact; no
component is removed and no generated fallback is substituted. Full-resource
If-Match and ACK rules still apply. Repeating the original operation replays the
receipt; cancelling an already-cancelled definition remains unsupported.

Fake HTTP tests exercise all three time models and applied-503 recovery. DB tests
cover restoration, revision checks, remote races, accepted echo and subsequent
edits; Radicale verifies the durable scope/worker/import path. This is restricted
to personal series with positive resource write privileges, not meeting scheduling.

## Existing occurrence time edit

An occurrence update can change an existing definition's explicit start and end
within its current time kind and IANA zone. The writer replaces only DTSTART,
DTEND and obsolete DURATION, preserving RECURRENCE-ID, master, sibling definitions,
alarms and other native properties. Optional content changes and restoration use
the same transaction and complete resource proof. Changing time kind/zone, a
master's time or a generated slot's time remains unsupported in this slice.

Fake HTTP and DB tests cover zoned/all-day/floating, durable JSON serialization,
applied-503 recovery, stale provider ETags, unchanged original identity and accepted
echo. Radicale confirms the scope/worker/import round trip. Provider flags and
positive resource privilege requirements remain unchanged.

## Generated occurrence time edit

A generated occurrence can now be materialized directly at its requested time,
within the master's time kind and IANA zone. The planner separately proves the
original recurrence slot and the desired definition. Native RECURRENCE-ID is built
from that original slot, never from the moved DTSTART. The existing atomic child,
mapping and resource intent transaction handles persistence and delivery.

Fake HTTP and DB tests cover zoned/all-day/floating moves, applied 503, full-resource
conflicts and echo identity. Radicale verifies the first generated slot moved away
from its original date through scope, worker and import. Master/following time and
time-kind/zone changes remain separate work. Flags and privilege gates are unchanged.

## Series time edit preserving detached content

A series update can move its explicit start/end within the existing time kind and
IANA zone. The shared planner shifts original recurrence identities while retaining
each detached definition's own time, content and cancellation. Native writes alter
master DTSTART/DTEND/DURATION and the affected RECURRENCE-ID properties only.
Dated additions/exclusions that cannot be partitioned exactly remain refused.

The scope transaction remaps deterministic child addresses atomically. Temporary
addresses inside the transaction avoid collisions when adjacent identities move
into each other's old slots; no temporary address is committed. A target tombstone
rolls back events, mappings and intent together. Pending pulls stay blocked and
only full-resource ACK advances all validators. Time conflicts do not enter the
master-content-only resolution flow.

Fake HTTP, DB and Radicale cover time kinds, adjacent identity remapping, preserved
exception times, applied 503, stale ETags, rollback and echo. Following/delete and
time-kind/zone changes remain separate work. Flags and privileges are unchanged.

## Recurrence rule update

A series update can replace one RRULE while preserving all detached definitions.
The shared planner requires every existing original identity to remain a member of
the new rule; orphaning an override or cancellation is refused before commit.
Native replacement retains RRULE extension parameters and every other property
and component. COUNT/UNTIL updates share the same resource CAS, replay and atomic
ACK. Dated RDATE/EXDATE rewrites remain unsupported; the bounded recurrence
removal contract below covers a lone personal master.

Fake HTTP covers count/until for all time kinds and applied-503 recovery. DB tests
cover native delivery, remote races, rejected orphaning with no local writes and
accepted echo. Radicale extends a shifted series and verifies unchanged detached
rows. Recurrence conflicts are excluded from content-only resolution. No flags,
versions or privilege requirements change.

Editor-generated bare rules and reordered clauses are normalized to the native
RRULE representation before commit. The final scope transaction binds that
representation to the original request using only clause-order/prefix and known
INTERVAL=1/WKST=MO equivalence. Duplicate or dropped unknown clauses are refused.
Bare daily, weekly and monthly editor formats are covered, and confirmed imports
do not rewrite the canonical recurrence or increment its revision.

## Conditional series deletion transport

The internal deletion adapter requires positive collection `unbind` privileges,
account/calendar ownership and a complete personal-series baseline. Immediately
before DELETE it compares the entire resource and its accepted strong ETag, then
sends If-Match. Only a subsequent GET 404 confirms deletion; a 204 response alone
does not. Retry recognizes an already-absent resource without repeating DELETE.
Concurrent edits, recreated resources and unreadable post-write state are never
reported as a confirmed deletion.

Fake HTTP tests cover all time kinds, applied 503/lost responses, races, recreated
resources, unavailable readback, malformed/stale baseline and the disabled flag.
Radicale confirms collection permission, conditional deletion and retry. This is
transport evidence only: public series deletion and atomic local tombstone/outbox
ACK wiring are the next slice. No flags or production capabilities are enabled.

## Worker authority recheck

Every CalDAV family context now requires the actor's current local edit grant,
including the worker's preflight and final ACK transactions. The native PUT/DELETE
executors expose a pre-mutation checkpoint after remote reads. The resource worker
uses it to recheck destination, family, local grant and active lease immediately
before PUT. A revoked grant blocks that mutation; revocation after PUT prevents
ACK and leaves the accepted validators unchanged. The deletion checkpoint is ready
for its upcoming durable worker integration.

DB HTTP regressions revoke the grant during GET and after PUT. The first sends no
PUT, and neither case advances validators. A transport regression also verifies
that a failed deletion checkpoint sends no DELETE.

## Durable whole-series deletion

The series/delete endpoint prepares the complete native resource under positive
collection unbind permission. Its final scope transaction rechecks the family and
atomically tombstones the master and every detached definition, increments each
revision once and appends one root deletion intent. All accepted mappings remain
until delivery is confirmed.

The worker rechecks the entire tombstoned family, destination, edit grant and lease
before DELETE and before ACK. Only confirmed remote absence removes every family
mapping and completes the receipt in one transaction; generic single-event ACK is
not allowed. Applied 503 recovery reads absence without repeating DELETE. A remote
edit, changed local definition, revoked grant or lost lease leaves mappings intact.
An incoming deletion while delivery is uncertain is retained as an echo candidate.

A completed deletion receipt rejects later imports of its old accepted resource
version, including a snapshot fetched before the DELETE. An observation without a
validator is also refused for that deleted address. A genuinely new resource version
can be imported normally; identical-validator recreation cannot be distinguished
from a stale snapshot and is conservatively ignored. This barrier depends on keeping
the completed receipt, as with other durable recovery evidence.

HTTP/DB regressions cover zoned, all-day and floating families, authenticated scope,
replay, applied 503, provider/local/preparation races, grant revocation, lease loss,
generic ACK refusal and stale-snapshot non-resurrection. Radicale exercises the
scope transaction, worker, full mapping removal, retry and subsequent sync. Following
scope and deletion conflict resolution remain unavailable. Flags remain disabled.

Independent review added a retention guard for the complete unresolved deletion
family: scheduled tombstone cleanup cannot remove the rows/mappings needed for
recovery. After confirmed completion ordinary cleanup is allowed, while the durable
receipt still blocks stale imports. A partial address/version index (migration
0068) supports that lookup without scanning unrelated completed outbox history.
The DB regression ages a pending family past retention, runs cleanup, completes
delivery, runs cleanup again and confirms that an old snapshot cannot revive it.

A delayed unmapped deletion delta for the completed operation is recognized as its
own echo, so it does not install a permanent address tombstone on a later resource
incarnation. A pending create at that address retains the existing deletion fence.
The regression recreates the family under a new ETag after that delayed delta and
successfully edits/delivers it again with new local identities.
The echo check includes exact detached addresses retained in the receipt's mapping
set, using the indexed root resource address first. A full sweep that captured
those mappings before ACK must not leave child-address tombstones either.

## Native following deletion

The private resource writer can truncate a single RRULE at a later original slot.
It uses the shared scope planner to calculate the retained count and removes only
those complete detached components whose original identity is at or after the cut.
Earlier exceptions retain every byte, even if their actual time was moved past the
cut. The master changes only its RRULE; alarm/extension bytes and RRULE parameters
survive. COUNT and UNTIL inputs share this exact partition. The first slot requires
the existing whole-resource DELETE path, not an empty recurring resource.

The ordinary full-resource If-Match/readback/recovery protocol also covers this
intent. Fake HTTP tests exercise all three time kinds, JSON persistence, 503/lost
response recovery, concurrent child changes and mixed/stale intent refusal. Radicale
confirms the actual conditional truncation and repeat delivery. This slice is only
the private native transport; public following scope, local tombstones, retained
mapping reconciliation and the durable ACK are the next integration step.

## Durable following deletion

The public following/delete scope now delegates its first slot to whole-resource
DELETE; a later slot enqueues one conditional resource update. The scope transaction
commits the shortened master, future child tombstones and one outbox together.
Pending mappings remain intact. A complete ACK checks the retained and removed
families, removes only the deleted mappings and advances all retained ETags in one
transaction. Grant/lease/family checks and lost-response recovery remain mandatory.

Completed truncation receipts also reject their old accepted resource version on
import. Migration 0069 broadens the indexed version barrier, and delayed sweeps
recognize removed exception addresses from the receipt. Historical unmapped
tombstones do not block subsequent edits or deletion of the retained family. Every
unresolved CalDAV family operation protects its recovery evidence from cleanup.

A fresh provider restoration of a removed definition reuses its tombstone ID only
when a completed truncation receipt binds that exact address and local identity,
its authority/membership is unchanged, and it has no other mapping or pending write.
Local recreation after extending the rule freezes the retired definition's ID at
preflight and rechecks it during commit. Revision and echo behavior remain stable.
The optional retired-definition context is omitted for empty history, preserving
compatibility with already queued pre-truncation operations.

HTTP/DB covers first/later slots, all time kinds, atomic tombstones/mappings,
503 recovery, provider/local races, revoked grant and expired lease, cleanup,
stale-snapshot refusal, subsequent editing/deletion, provider restoration and
local recreation/cancellation under the same identity. Radicale exercises the
scope/worker/ACK path and subsequent sync. Following update/split and a dedicated
following conflict resolution remain unavailable. No flags or versions change.

Review regressions also cover ordinary master-content conflict resolution after a
truncation. Retired definitions remain private history, while a newly deleted active
child still invalidates that preview. A series time shift that would collide with
another retired original identity is explicitly refused before provider preparation
and again during the final transaction, rather than failing a uniqueness constraint.

## Native split preparation and conditional creation

The private following/update builder derives two resource bodies from one accepted
complete family. Its source step is the existing conditional truncation. The new
resource has a frozen UUID-derived URL/UID, a new recurring master and the future
exceptions reparented by original identity. Content/time changes apply to the new
master; exception content, actual time, cancellation and unknown bytes survive.
When the new master moves, only those exceptions' RECURRENCE-ID changes. COUNT/UNTIL
partitioning uses the shared planner. First-slot/no-op edits, changed time kind/zone,
unsupported patch fields and non-VEVENT/VTIMEZONE components require another path.

Creation content is validated without inventing an accepted ETag. Before IO the
executor reconstructs the whole preparation and rejects changed private input. It
uses If-None-Match: * and confirms a complete matching GET with a real strong ETag.
An already matching resource recovers an ambiguous create without another PUT;
foreign content, races and transformed/unreadable readback cannot become success.
The adapter requires the connected account, imported calendar ownership, positive
collection bind permission and the disabled-by-default write flag. A pre-mutation
checkpoint lets the future worker recheck its local authority and lease.

Fake HTTP covers all three time kinds, time shifts, COUNT/UNTIL, preserved private
bytes, JSON roundtrip, lost/503 responses, address races, weak/unreadable readback,
tampered input and disabled/checkpoint refusals. Radicale confirms actual bind,
conditional creation, recovery and cleanup. This is private transport only: no
public following update, distributed atomicity, canonical reparenting or durable
multi-step completion is claimed. Those are the next integration slice.

Recurrence patches are canonicalized before split planning, after validating that
prefix/clause ordering and omitted known defaults preserve the same rule. A direct
RED/GREEN regression and independent review caught the former mismatch between the
planned recurrence string and ICAL serialization; bare editor syntax and INTERVAL=1
now produce a matching planned/native family without dropping unknown clauses.


## Private split transaction and dependency journal

A server-only `caldavSplit` preparation can atomically save the shortened master,
a new master and reparented future definitions, with one scope replay receipt and
two outbox rows. Canonical intent is rebuilt from the original request and full
accepted context; changed revisions, account bindings, exception content or an
invented creation validator abort the transaction. The new resource UUID is frozen.
The creation row explicitly depends on the source update across event identities.

Whole-resource and individual-component pulls cannot import either unresolved
address as a second family. The existing unmapped-delete fence recognizes the new
URL before its mapping exists. Generic ACK, conflict resolution and delivery reject
this private journal; the public following-update endpoint remains unsupported.
Specialized delivery, phase-specific ACK, remote recovery and permission preflight
must land before exposing it. No provider call is made by the transaction.

Database coverage includes three time kinds, time/recurrence changes, simultaneous
replay, rollback after a second-row identity collision, stale preparation, private
input tampering, dependency claiming, both import paths and an unmapped delete.
Existing past exceptions and all accepted mappings stay unchanged at enqueue.

A reset/delete observation also fences every mapped component owned by a pending
resource journal, including split-reparented exceptions. It records a conflict on
the resource operation without tombstoning saved local definitions. This same
protection applies to existing series PUT/DELETE journals; child-first deletion
and an empty reset snapshot are covered by database regressions.

Superseded journals are excluded from deletion observation routing; their
replacement marker survives a reset. The active replacement receives the conflict
and can be explicitly reconciled again. Expected component-removal echoes do not
clear a retained conflict and cannot acknowledge a write on their own.


## Durable split delivery and independent family ACK

The private journal now has a specialized worker. Before truncating the source it
rebuilds the complete native split, requires resource write and collection bind,
and checks that the reserved destination is absent or already exactly desired.
Only the accepted source ETag can authorize its PUT. A complete readback and an
atomic family/lease check remove old future mappings and advance retained mappings.
The dependent create then uses If-None-Match and full native readback; one ACK inserts
all new family mappings together. No generic ACK can settle either step.

Both phases recheck current local permission, family revisions, mappings,
destination, observed deletions and lease immediately before mutation and at ACK.
Lost/applied 503 replies recover without another PUT. The new-family step checks
its own canonical state and the completed source receipt; it permits independent
edits to the retained old family after the first ACK. There is no distributed
atomicity claim: the future family stays locally visible and pending between steps.

Completed source receipts fence stale old-resource snapshots and delayed removals.
Tests cover both recovery phases, resource collision, bind/grant/lease/local races,
private native tampering, stable echo identities and independent old-family edits.
Radicale covers both conditional writes with synchronization between their ACKs.
Public following update and its preflight bridge still remain closed; flags and
versions are unchanged.


## Public following-update scope

With the default-off time-edit capability enabled, the authenticated scope endpoint
now accepts a personal CalDAV following update. Complete source evidence and
resource write permission are checked first; a real split additionally requires
collection bind and a checked, frozen destination. The local commit repeats its
full context and address checks under locks. A newly observed deletion, existing
destination mapping, reused identity or stale family prevents saving either half.
The source UID cannot be reused for the new resource.

A later cut queues the two-step journal. The first occurrence uses the existing
single-resource series update; a real no-op records only its replay receipt.
Concurrent HTTP retries may prepare different UUIDs, but exactly one scope receipt
wins and freezes both outbox steps. Responses report local commitment, never
provider delivery. Existing cancellation/content preservation and same-kind,
same-zone time restrictions remain in force; meeting scheduling stays unsupported.

Authenticated HTTP/DB coverage includes zoned/all-day/floating, first-slot and no-op,
time and bare/default recurrence patches, concurrent replay, bind/write unknown or
denied, grant/local races, target collision and root/child deletion observations
before commit. Radicale exercises the same preflight bridge and both durable ACKs
with an intervening sync. Live iCloud unknown resource privilege is still refused;
no flag, product version or compatibility minimum is changed.

Equivalent supported RRULE spelling/defaults are normalized consistently before
routing and commit. An unchanged following occurrence time keeps the empty plan
after complete evidence validation; it never becomes a master time shift. HTTP
regressions cover default-clause no-ops and an unchanged time on an UNTIL-bounded
series with a late exception. Both record a receipt without outbox rows or PUTs.


## Existing occurrence content conflict resolution

An existing active detached occurrence's content-only journal can now use the
public fresh preview/confirm flow. The server derives the selected child from
the saved scope intent. The preview shows that child's saved/current content,
original slot and civil time; the resource root revision still versions the
journal. No client-supplied native target or new DTO field is accepted.

The native read may adopt content only for that child. Master content, other
children, time, recurrence, cancellation, original identity and embedded
VTIMEZONE definitions must still match. Fresh unknown native properties remain
private and are preserved in the full replacement. Confirmation locks the root,
children and mappings, rechecks the accepted family and permissions, and
atomically replaces the journal while advancing all resource validators. The
selected child cannot change between the saved intent and the replacement.
The canonical draft and its revisions do not change during confirmation.

HTTP/DB evidence covers zoned, all-day and floating children, authenticated
preview/confirmation, concurrent replay, repeated conflict, stale validator,
local child revision and permission races, target tampering, changed native
identity/time/other content, complete ACK/echo and lost-response recovery without
a second PUT. Pure native fixtures additionally verify preserved child/master
projections and unknown properties. Local Radicale also executes a real
resource conflict, the explicit replacement, worker ACK and stable echo. Existing web/native comparison renderers
already display the original occurrence identity through the unchanged DTO.
Generated definitions, revival/cancellation, time/RRULE, following and split
conflict reconciliation remain separate work. iCloud's unknown resource
privileges and all activation/version gates are unchanged.


## Saved time and RRULE conflict confirmation

The same explicit comparison also supports a saved series time/RRULE intent or
an existing active occurrence time intent. Native evidence starts from the
original committed baseline rather than comparing the old provider time with
the already-updated local draft. The fresh read may adopt selected content; its
time, rule, original identities and all other definitions must still match that
baseline. A competing native structural edit remains unavailable for this flow.

Preparation reapplies the exact saved time and recurrence patch to that fresh
baseline. Confirmation checks those fields against the original journal as
well as retaining the selected target. It cannot substitute another civil time,
zone, rule or scope. The complete planned family, including rekeyed original
identities, must still match the locked canonical state before delivery/ACK.
The preview shows saved and native time/recurrence through the existing DTO;
confirmation changes no canonical draft or revision.

HTTP/DB fixtures cover series/occurrence time and series RRULE in all three time
kinds, combined edits, repeated/concurrent confirmation, lost response recovery,
stale validator, local revision/grant/lease races, time/rule proof tampering and
native structure/other-child refusal. A change to another child after PUT stays
an uncertain conflict with no ACK or automatic overwrite. Full echo checks
preserve canonical IDs/revisions and accepted component mapping identities.
Local Radicale additionally verifies a combined time/RRULE conflict on a
previously split family, complete worker ACK and unchanged identities after sync.
Generated/revival/cancellation, following/split reconciliation and adoption of
competing provider time/rule changes remain separate work. Flags, versions and
iCloud resource privilege requirements are unchanged.


## Generated, cancellation and revival conflict confirmation

Explicit confirmation also retains generated definition, occurrence cancellation
and revival intents. The saved target, new-definition snapshot, cancellation
choice, time and rule must match the original journal during the locked commit.
An altered target/definition or revoked source cannot create a replacement.

Generated and cancellation preflights retain every accepted canonical field of
the original native resource. Fresh private extension/alarm bytes may be
preserved, but another native definition, changed master/child content or changed
temporal structure is not silently adopted. A generated preview derives the
original slot from the verified original master rule; it does not invent a
physical native child. Revival can compare fresh content of the existing
cancelled definition while its original identity, time and cancelled baseline
remain fixed. The prepared write restores the saved active definition.

The unchanged comparison DTO exposes the occurrence's original identity and
saved/native cancellation state. The canonical draft and UUIDs/revisions stay
fixed across confirmation; full worker evidence and atomic family ACK settle
the result. A repeated conflict preserves the same generated ID, and a lost
response is reconciled without a second PUT or duplicate definition.

Native and authenticated HTTP/DB regressions cover three time kinds, generated
content/time/cancellation, existing cancellation and revival (including time),
stale/repeated/concurrent confirmation, permission/local revision races,
new-definition/target/cancel tampering and foreign native content/identity.
Local Radicale exercises generated creation, cancellation and revival through
real ETag conflicts, explicit replacement and stable echo. Existing web/native
comparison renderers consume the existing cancellation/identity fields.
Following deletion, whole-resource deletion and split conflict reconciliation
remain separate work. This neither changes iCloud's privilege contract nor
activates flags, versions or live user-account operations.

### Following deletion conflict confirmation

A saved partial `following` deletion can now be explicitly confirmed after a
resource ETag conflict. Fresh native evidence must still match every accepted
canonical definition, time, rule and cancellation state before the original
cut. Only uninterpreted native properties may differ; those fresh bytes are
preserved. The same original slot and expected occurrence revision are reapplied
to the original full baseline. Competing known native edits remain unsupported.

The preview carries `scopeResolution: { kind: "following-delete", originalStart }`.
Both clients label the action **Delete following occurrences**, show the original
cut and explain that earlier occurrences remain. Confirmation requires the exact
`expectedScopeResolution`, including on replay. Older clients that omit it cannot
confirm a destructive scope they do not display. This adds no version/minimum
change and leaves the time-edit flag off by default.

The transaction rechecks the complete family, including exactly the expected
child tombstones and their revisions/content, permissions, mappings and latest
operation. It replaces the intent without editing the saved draft or incrementing
revisions. The specialized worker performs conditional PUT and full native ACK.
A completed replacement also fences accepted ETags of its exact superseded
following-delete ancestors: delayed old snapshots cannot resurrect removed
children. A pending replacement is not an ACK, and a genuinely new remote ETag
can still represent an intentional restoration.

Evidence includes authenticated HTTP preview/confirmation and older-client or
changed-cut refusal, three time kinds, stale/local/permission/proof races,
repeated conflicts, lost responses, every ancestor snapshot and a new-version
restoration. A disposable Radicale round trip verifies native conflict,
confirmation and stable echo. Web/native unit tests cover the displayed cut and
frozen retry; Chromium checks desktop light and narrow dark, keyboard/focus,
accessibility and exact submitted scope. Physical native and live-provider
acceptance remain separate. Whole-resource deletion and split conflict resolution
remain unsupported.

### Whole-series deletion conflict confirmation

Whole-resource series deletion now has its own explicit conflict confirmation.
Fresh evidence uses positive **collection unbind** authorization; missing resource
write permission does not disable a separately proven delete capability. The
same resource/UID, complete original canonical family, time/rule/cancellation
state and VTIMEZONE evidence must remain intact. Fresh uninterpreted native bytes
are retained in the private deletion baseline. Known competing edits still
require reconciliation; they are not silently included in the deletion.

`scopeResolution: { kind: "series-delete" }` distinguishes deletion of the entire
series from a partial following cut. Web/native clients explicitly say **Delete
entire series** and include all occurrences and exceptions in the confirmation.
The local preview is absent because the saved family is already deleted. Exact
scope confirmation is required on both submission and replay, so an older or
changed-scope request cannot confirm it.

The transaction locks and verifies the original master and every tracked child,
including their saved tombstones, revisions, content, calendar links, mappings
and permissions. It advances all accepted ETags and appends one immutable
replacement. The delete worker recognizes only its exact superseded deletion
chain, repeats source and native unbind checks, performs conditional DELETE and
requires full-resource absence before removing mappings and acknowledging the
chain. Completed deletion receipts also fence exact superseded accepted ETags;
a genuinely new remote resource version may be imported as a new family.

Evidence: authenticated HTTP preview/confirmation and old-client/changed-scope
refusal; all three time kinds; root/child tombstone, revision, permission and
private-proof races; native content/time refusal; missing resource write versus
missing/revoked unbind; repeated conflicts, lost responses, stale ancestor
snapshots and new-resource recreation; disposable Radicale DELETE conflict and
404/stable sync; web/native frozen confirmation tests; desktop light and narrow
dark Chromium keyboard/focus, accessibility and request checks. No physical
native or live-account acceptance is implied. Split conflict resolution remains
open, and production flags and client versions are unchanged.


### Split operation identity and native identity

A split's new canonical master UUID and native resource URL/UID stay frozen in
its prepared journal. The source and creation delivery rows now each have their
own operation UUID. The worker verifies the paired journal, event identity,
explicit native address, action/position and dependency; it no longer requires
the creation operation UUID to equal the new master UUID. Existing journals using
the older shared UUID remain valid.

An unmapped native deletion recognizes the creation row through its exact saved
CalDAV split address and matching journal creation-operation ID, independently
of the row-ID-derived legacy URL. Root and detached-child deletion observations
still prevent ACK; full-resource and component pulls still cannot import an
unacknowledged split family. The native URL never changes across retries.

HTTP/DB coverage exercises independent IDs throughout both phases, legacy journal
compatibility, root deletion before delivery and during CREATE, child deletion,
lost responses, interleaved pulls and complete mapping ACK. The disposable
Radicale split round trip uses the independent operation IDs. This is groundwork
for replacing a conflicted pair while preserving its family identity; it does
not enable split conflict confirmation by itself.

### Split source conflict confirmation before the first ACK

A source conflict can now replace the entire still-unacknowledged split pair.
The companion creation must be genuinely unattempted and pending. Fresh source
proof preserves every original canonical definition/time/rule and VTIMEZONE;
known native changes, missing bind/write permission or a different resource at
the frozen future address refuse the comparison. Both native bodies are rebuilt
from the fresh accepted evidence and the exact saved split request while keeping
the future canonical UUID, native URL/UID and all post-edit revisions unchanged.

The comparison includes the saved earlier series, current remote source and saved
future series. `scopeResolution` carries `following-update`, the original cut and
`newSeriesId`; both clients explicitly show the two-step operation and require the
future comparison before enabling confirmation. Submission and replay require the
exact displayed scope. Older clients cannot confirm an undisplayed split.

Confirmation locks both resources and all new component addresses, both roots,
children, accepted mappings, permissions and pair rows, then repeats the complete
pair proof. It cancels only the exact old pair/ancestors and appends two replacement
rows under one mutation identity with the original future identity and a new
source/create dependency. It does not change the canonical draft. Native I/O stays
outside this transaction.

Source ACK releases only the superseded source rows, so earlier-series edits may
resume. Creation ACK still requires the paired completed source receipt and the
unchanged future family; only then does it release the superseded creation rows.
Native deletion observations and pending full/component pulls continue to fence
both phases. Completed source receipts retain ancestor ETag fences against a
delayed pre-cut snapshot, including after repeated explicit conflicts.

HTTP/DB evidence covers authenticated confirmation, exact concurrent replay,
three time kinds, old-client/changed-scope/stale preview refusal, changes to either
root or a moved child, restored/deleted heads, grant loss, creation lease and
private-proof races, native structure/collision/bind refusal, repeated conflicts,
lost source/creation responses, native deletion during CREATE, independent old
family edits and stable two-resource echoes. Radicale verifies a real source
ETag conflict, paired replacement, both native ACKs and interleaved sync. Web/native
unit tests cover the displayed future series, frozen retry and missing-future
refusal; Chromium exercises desktop light/narrow dark, keyboard/focus,
accessibility and exact scope submission.

This deliberately does not resolve a creation conflict after source ACK, rewrite
an unrelated native resource, choose a different future address or adopt competing
native structural edits. Those contracts remain open. Live-account/physical QA,
iCloud privilege evidence, flags and versions are unchanged.

### Future-only recovery after acknowledged source

An unresolved creation can now receive explicit confirmation after its paired
source operation has completed. The comparison uses `following-create`, the
original cut and the frozen future canonical ID. It shows the saved future series
and the current destination, and states that the earlier series is already saved.
Both clients submit the exact displayed scope; a missing or different scope is
refused. Confirmation does not repeat the source cut.

This bounded recovery accepts only an absent reserved URL or a complete resource
matching the desired future bytes under the existing conservative whole-resource
comparison. A different body, UID, alarm, extension or timezone remains a conflict.
There is no overwrite, alternate address, structural adoption or inferred native
ownership from a matching title. Native reads require current ownership, active
mirror and collection bind evidence. Existing strong validators, complete UTF-8
reads and redirect refusals remain in force.

The private replacement journal references its immutable completed source and the
original creation operation. It preserves the future UUID, native URL/UID,
component identities, desired bytes and local revisions. Repeated confirmations
replace only creation ancestry. The source receipt, its result and its retained
pre-cut ETag fences remain untouched. Earlier-family edits may proceed after source
ACK and do not invalidate an otherwise unchanged future family.

Preview, confirmation and worker checks require the complete unchanged future
family, destination grant, absence of native mappings and absence of root/child
deletion observations. Commit locks future resource/component addresses, canonical
rows, mappings and journal ancestry; provider I/O remains outside the transaction.
The replacement has its own confirmation mutation and operation identity. Exact
replay returns that operation. The worker conditionally creates with
`If-None-Match: *`, or reconciles the complete already-applied resource without a
second PUT. All mappings, lease settlement and release of superseded creation rows
are atomic. A changed or expired lease cannot partially acknowledge components.

Regression coverage lives in the CalDAV scope HTTP/PostgreSQL suite, synthetic
transport suite, both client comparison suites and disposable Radicale test. It
includes three time models, collision refusal, absent and already-applied reads,
concurrent/repeated confirmation, stale scope/preview, future definition/grant/proof
races, lost response, deletion during CREATE, independent source edits and stable
native echoes. Test commands and completed validation are recorded with the change.
Live-account/physical QA, iCloud privilege evidence, flags and versions are unchanged.

Validation for this batch: the complete CalDAV scope PostgreSQL/HTTP suite passes
with 23 future-only cases; disposable Radicale verifies recovery after a prior
source-pair replacement, collision refusal, conditional creation and stable sync.
Chromium passes desktop light and narrow dark comparison, keyboard/focus, axe,
overflow and exact submission checks. Web comparison tests pass (15), native
comparison tests pass (23), and the wire contract, API typecheck with existing
library declarations skipped, web typecheck and targeted web lint pass. The full
native typecheck still reports the unrelated Node URL overload in
`contexts/serverStartup.spec.ts:4`.

Targeted commands (with the repository's disposable test environment loaded):

```sh
node --import tsx apps/api/src/sync/caldav_scope.integration.test.ts
RADICALE_URL=http://127.0.0.1:55232/ node --import tsx apps/api/src/sync/adapters/caldav.radicale.integration.test.ts
# From apps/web, with a local web server at PLAYWRIGHT_ORIGIN:
../../node_modules/.bin/playwright test --project=chromium --workers=1 -g 'K12 future-only split confirmation'
```


## Removing recurrence from a lone personal master

Series scope accepts an explicit `recurrence: null` for a live personal master
with exactly one RRULE and a known zoned, floating or all-day time model. Active,
cancelled and retired exception definitions or extra component mappings are
refused, as are RDATE/EXDATE, duplicate rules, and a simultaneous time edit or
time-kind/zone conversion. No child is silently discarded or reparented.

The existing full-resource writer removes only the RRULE physical property.
The root UUID, native URL and UID, DTSTART, DTEND or DURATION, VTIMEZONE, alarms,
extensions and all untouched bytes remain intact. Explicit title/description/
location changes retain the existing property-delta contract. The original rule
and native bytes remain frozen in the durable baseline; the desired canonical
root becomes one event with null recurrence and no series/original identity.

Fresh positive DAV write-content evidence and the accepted strong ETag authorize
one conditional PUT. Full-resource readback and the existing lease, source and
canonical-state checks settle the same root mapping atomically. Lost responses
recover from the exact desired resource without repeating the mutation. Partial
readback, stale ETags, revoked grants and local/lease races cannot acknowledge it.
The generic one-event ACK still cannot settle this typed resource intent.

Pending pulls remain fenced. After ACK, complete-resource and component pulls
with the retired baseline ETag cannot restore the old rule; missing validators
also fail closed. A subsequent fresh native version can still be imported.
Ordinary one-off echo retains UUIDs and revisions. Removal conflicts remain an
explicit unresolved conflict; the existing recurring structure confirmation does
not automatically rebase a saved one-off onto a changed remote series.

Parser/fake HTTP regressions cover all three time kinds, exact byte preservation,
malformed/exception refusal and uncertain recovery. Synthetic database coverage
adds canonical/mapping identity, immutable intent, replay, pending and stale pull
fences, permission/CAS/local/lease races and retired exception refusal. The local
Radicale suite exercises full preparation, conditional PUT, one-off ACK and echo,
including retained DURATION and alarms. No production flag, version, dependency
or live-provider acceptance changes with this batch.

## Explicit finite series conversion to UTC

The existing web/native Event time zone input can save a whole-series change
from a known non-UTC zone to `UTC`, using exactly the displayed local dates and
times. This is a wall-clock choice: a Prague 09:00 daily series spanning spring
DST changes from 08:00Z / 07:00Z to 09:00Z on every date. It does not preserve the
old occurrence instants. The master retains its original local anchor even when
the editor opens a later generated occurrence. Draft validation checks only the
explicit clock choice; the complete footprint is proved against the stored master
at scope admission, never by restarting COUNT at a displayed occurrence.

This first slice requires one personal non-meeting VEVENT, no live or retired
detached definitions, one finite COUNT RRULE, 1–366 occurrences wholly within
730 days, and a positive fixed duration within one civil day. Source and target
footprints must agree on every local start/end. Independent civil enumeration
refuses gaps, folds, skipped slots and duration changes. Other target zones,
UNTIL/unbounded rules, RDATE/EXDATE, floating/all-day/type conversions, concurrent
content/recurrence changes and simultaneous local time shifts remain refused.
The existing explicit time-edit flag remains off by default.

The native writer changes only DTSTART/DTEND (or the replaced duration encoding)
and preserves every unrelated resource byte, including alarms and extensions.
It neither invents nor deletes VTIMEZONE. If the source resource embeds a matching
VTIMEZONE, all accepted source endpoints must also agree with its native offsets;
contradictory or duplicate definitions are refused. Positive resource write
privilege and the accepted strong ETag are required at the existing write gates.

The existing typed series journal retains the exact target time intent and raw
before/after resource proof. CAS, unknown-response replay, atomic family ACK and
pull barriers apply unchanged. Explicit conflict recovery uses the same native
address/UID and the saved UTC intent. It accepts refreshed private extensions
only while every original canonical time, rule and content field stays equal;
changed native content/time cannot silently become part of this zone-only edit.
Local/source/revision/lease and stale preview guards remain in force.

Verification lives in `caldav-series-zone.test.ts` (calendar package),
`caldav_series_zone.test.ts` (native serializer), the registered CalDAV scope
HTTP/DB suite, and the existing Radicale suite. Scope scenarios cover public
admission, lost response, fresh conflict proof, changed native time refusal,
active/retired definitions, disabled writes, absent positive privilege, local
CAS, immutable target intent, stable mapping identity and pull echo. The native
Radicale scenario creates only a disposable resource and verifies real
conditional conflict/recovery, preserved private data and stale PUT refusal.
The native `AddEventModal.spec.ts` composer regression exercises the actual input,
All events callback and local reminder scheduling from the saved master.
Browser cases `K12 explicit UTC whole-series` exercise the existing input and
explicit whole-series full editor in light desktop and dark narrow layouts. These are mocked API
browser checks, not live iCloud or physical native acceptance. No live provider
or production flag was activated for this batch.
## Restore imported all-day exclusions

A finite personal all-day series can restore selected dates already recorded in
native EXDATE properties. This complements occurrence cancellation: adding a new
exclusion remains the existing cancellation operation; an imported EXDATE has no
visible occurrence or cancelled child to revive. Existing web and native
recurrence editors list recognized excluded dates and stage a Restore action.
The user saves the whole-series draft through the existing scope endpoint.

This slice accepts one all-day VEVENT, one unchanged finite COUNT RRULE, and
explicit `EXDATE;VALUE=DATE` values only. There may be multiple properties or
comma-separated dates; duplicates, malformed dates, RDATE, unknown parameters,
non-DATE exclusions, live/retired detached definitions, meetings, and simultaneous
content, time or RRULE changes are refused. Every original exclusion must belong
to the complete base footprint: at most 366 dates within 730 days. A save can
remove only existing exclusions, with exact retained property/value ordering.
It cannot add exclusions, invent slots or change DTSTART/DTEND/UID/addresses.
The existing explicit time-edit feature flag remains default-off, and positive
resource write privilege plus a strong accepted ETag remain required.

The serializer validates every unfolded raw DATE as exactly eight digits and a
real calendar date, including retained values, and rejects repeated dates across
properties before initial preparation or a recovery confirmation. Canonical ICAL
normalization or projection deduplication cannot substitute for that raw proof.
The serializer changes only affected EXDATE property spans. Unchanged property
bytes, including folded remaining exclusions, alarms and private extensions,
never pass through serialization. A changed folded property may be refolded or
unfolded; unrelated spans remain exact. The journal records the full before/after
resource and typed recurrence patch. Existing local/source/lease fences, pending
pull protection, same-address conditional PUT, uncertain-response replay, atomic
ACK and stable echo apply. Explicit recovery retains the original selected-date
intent and all original canonical content/time/rule/exclusion evidence. Fresh
private extensions may be preserved; changed canonical native evidence, stale
preview validators or a different selected subset cannot authorize a write.

Evidence: `exdate-restoration.test.ts` checks strict syntax, selected subsets and
finite date membership and restoration of an excluded DTSTART without COUNT
replenishment; `caldav_exdates.test.ts` verifies physical byte preservation and
rejects truncated, impossible and duplicated raw values. Registered scope HTTP/Postgres tests cover public admission, lost
responses, conflicts, active/retired definitions, malformed/duplicate/foreign
dates (including malformed retained tokens and newly duplicated native properties
during recovery), excluded DTSTART restoration with stable family/mapping identity,
changed RRULE, permissions, revision races, stale previews and modified private
proof subsets. The real disposable Radicale scenario verifies imported
DATE restoration, concurrent private edits, immutable conflict recovery, stable
mapping/ACK/echo and stale ETag refusal. Native composer and web editor tests
exercise existing actions and exact scope payloads; browser cases
`K12 imported all-day exclusion restoration` cover desktop light and narrow dark
layouts with keyboard focus returned to Repeat after a row disappears.

This does not activate a live provider or prove physical native/iCloud
acceptance. Timed exclusions, new EXDATE additions, RDATE changes and families
with detached definitions remain separate work.

The bounded all-day writer also supports reversible addition/removal of one
single-value DATE RDATE on a finite personal master, retaining the original RRULE
COUNT and anchor. See [single additional date contract and evidence](caldav-rdate-writes.md).

## iCloud personal master-content authorization (2026-09-10)

The user approved a bounded alternative to affirmative pre-write DAV privilege
proof. `ICLOUD_PERSONAL_CONTENT_WRITES_ENABLED` defaults to false. On this series
path it also requires `EVENT_TIME_EDITS_ENABLED`; the
[legacy one-off path](#icloud-legacy-one-off-content-updates-2026-11-07) does not.
It is restricted to verified HTTPS iCloud CalDAV
account and destination hosts and whole-series personal master title, description
and location updates. It does not enable time, recurrence, occurrence/following,
alarm, scheduling, creation or deletion operations.

An exact resource's explicit 404 property status for
`DAV:current-user-privilege-set` may defer authorization to the conditional PUT.
This is not a positive privilege grant. Explicit denial, HTTP failures, malformed
or incomplete property responses and foreign destinations remain refused. Local
account ownership, active calendar linkage, resource membership and complete
personal family validation remain required. Scope eligibility is passed explicitly
for preparation and re-derived from the durable write at delivery; no persisted
permission assertion can authorize a different operation.

The existing strong ETag `If-Match`, complete baseline comparison, preservation of
exceptions and unrelated content, full desired-resource readback and uncertain
outcome recovery remain mandatory. Provider 401/403 is not successful delivery.
Master-content conflict-resolution reads may use the same narrowly validated
saved operation; structural and occurrence resolution keep strict preflight. This capability is not production activation. The subsequent bounded live
[HTTP scope/outbox acceptance](../audits/calendar-icloud-series-live-acceptance.md#accepted-authenticated-personal-master-content-path-2026-09-10) passed for all three time models.

Here “personal” means a complete resource without organizer, attendees or
scheduling METHOD, accessed through the owning Musubi account and active source
link. It is not proof that the provider calendar has never been shared. Shared
calendar behavior is not accepted by this slice; the server remains responsible
for enforcing access on each conditional write.

Validation: the focused permission suite covers origin/scope and DAV response
boundaries. The disposable PostgreSQL fake-provider integration exercises actual
adapter admission/delivery/resolution, native meeting refusal, scope enqueue and
worker ACK, post-PUT membership revocation without ACK, provider 403/412, and
ambiguous complete-resource recovery. Existing CalDAV scope regressions and the
full project check also pass. These tests intercept provider DNS/HTTP and do not
constitute live iCloud acceptance.

## iCloud legacy one-off content updates (2026-11-07)

Incident repair, approved design v4. The legacy `PATCH /api/v1/events` content
path (title, description, location) can update a timed one-off event without an
explicit time model (legacy-unknown time) on a verified iCloud destination. This
covers origin iCloud events and Musubi-created mirrors. The only gate is
`ICLOUD_PERSONAL_CONTENT_WRITES_ENABLED` (default false); `EVENT_TIME_EDITS_ENABLED`
is not consulted and stays independent. Known-time, scope and series, alarm,
RSVP, organizer, create, delete, Google, Microsoft and non-iCloud CalDAV
behaviour is unchanged. With the flag off, every observed iCloud response is
refused before commit exactly as in 0.2.18. Turning the flag on is a separate,
verified operational step; neither this code nor its reviews activate it.

**Eligibility** (never a refusal; re-derived at handler and worker preflight,
nothing persisted). All of these must hold, otherwise the unchanged strict
legacy preflight runs:

- a content-only patch with no scope intent;
- a pinned plan limited to SUMMARY, DESCRIPTION and LOCATION;
- a canonical event that is not recurring, not a series member or occurrence,
  has no attendees, is not a meeting and is not cancelled;
- a mapping with a UID and a strong ETag;
- verified HTTPS iCloud account, collection and resource hosts.

**Refusals**, in order, for eligible requests:

1. Ownership: owned account, exactly one event link for the collection, its
   current enabled row, and the event on that calendar. Otherwise `unknown`.
2. The link owner's role allows `editEvents`. Otherwise `denied`.
3. A strict resource URL inside the collection. Otherwise `unknown`, with no
   request sent.
4. Resource ACL: a grant takes the existing strict path; an explicit set without
   it is `denied`; anything except an explicit empty 404 propstat is `unknown`;
   408, 429 and 5xx stay transient.
5. A fresh collection privilege set that satisfies the discovery predicate
   (create, update or delete). A read-only or empty set is `denied`; missing,
   malformed or an HTTP error is `unknown`. This is necessary, never sufficient:
   it is not inherited authorization for the resource.
6. A complete GET with the accepted strong ETag and UID, then the strict
   personal shape. Any ORGANIZER, METHOD, ATTENDEE, recurrence property, extra
   or nested component, malformed VALARM or VTIMEZONE, or an all-day DATE value
   is `unsupported`. Finally a dry run of the exact preserving transformation.

The guarded transport's exact redirect refusal on these reads becomes
`unknown`. Aborts, timeouts and every other untyped error keep their existing
handling.

**Delivery.** Every legacy update of an iCloud-class destination takes this
path, whatever the flag says:

- strict URL and redirect refusal;
- a GET that must return the accepted strong ETag;
- `If-Match` PUT;
- a complete readback whose own strong ETag is the only one adopted. A PUT
  response ETag is never adopted.

Outcomes:

- PUT 403 is `blocked`;
- PUT 412 is `conflict`;
- a 5xx, an unexpected 2xx or a network failure is `unconfirmed`;
- after acceptance, a readback mismatch, readback error, redirect or non-strong
  readback ETag is `unconfirmed` (`provider-write-failed`), not a conflict.

The committed request answers 502 `event-delivery-unconfirmed` (409 for a
conflict) with `localCommitted: true`.

**Reconciliation.** The next due attempt of an `unconfirmed` row reads first:

- a matching desired projection with a strong ETag completes without a PUT;
- a changed validator is a conflict;
- an unchanged strong validator gets a full re-preflight and one conditional PUT.

The host also guards iCloud-class CalDAV update delivery reads. A present
observation without a strong ETag, or a missing account, stays `unconfirmed`:
no ACK and no PUT. A write is never repeated blindly. Other providers, delete
rows, validator refresh and conflict previews are unaffected.

**Limits.**

- Legacy all-day iCloud one-offs remain unsupported; that is a separate future
  slice.
- iCloud has never been observed returning a weak or missing ETag on these
  reads. If it did so permanently, the row would stay `unconfirmed` and retry
  with backoff capped at one hour. Watch for persistent `unconfirmed` /
  `provider-write-failed` iCloud rows in delivery status.
- If iCloud rewrites bytes on PUT, an edit first answers 502 and completes on
  the next due attempt by reconciliation.
- Unobserved live: read-only shared collections, a PUT ETag, readback byte
  stability, and a collection PROPFIND with `redirect: "error"`.

**Rollback:** unset the flag and redeploy.

- New legacy updates are refused with 403 before commit.
- Committed `pending` or `retry` rows re-run preflight and settle as
  `blocked/provider-permission-unknown`. Local content then stays ahead of
  iCloud until the user acts.
- `unconfirmed` rows reconcile by read first.
- Completed rows remain.

**Validation:**

- an adapter matrix at the DNS, pinned-leaf and DB-module ports;
- `event-delivery` JSON cases for runtime and host outcomes, including the
  strong-ETag seam;
- a disposable PostgreSQL integration from `handlerUpdateEvent` through inline
  delivery, worker re-derivation, reconciliation and production link disable.

All provider HTTP is synthetic. This is not live iCloud acceptance.

## Personal one-off content edits (0.1.8)

The scope endpoint also accepts `series/update` for a personal, non-recurring
CalDAV root with an explicit time model. This narrow path changes only title,
notes and location. Compact and full web editors and the native editor use the
same durable operation instead of the legacy event PATCH.

Admission requires the authoritative owner, exact calendar/resource mapping,
no live or retired children, and fresh resource evidence. Native ORGANIZER or
ATTENDEE properties still reject this personal-write path. The existing iCloud
personal-content authorization fallback applies only under its documented
conditions. Time, recurrence, calendar moves and deletion are not admitted by
this one-off path.

Conditional PUT retains UID, native time properties, alarms and unrelated bytes.
A full read-back acknowledges delivery; a lost response is verified before any
retry, and a conflict requires explicit fresh confirmation. Operation replay,
local revisions and dispatch-time authority checks remain in force. Integration
tests cover zoned, floating and all-day content, lost response, conflict
resolution, stale revision and refusal of unsupported edits or permissions.
