# Independent sync reference host

C05–C07 / MUSU-37–39 runs bounded Google personal event CREATE, UPDATE and DELETE profiles, separate Microsoft guarded personal DELETE and one-shot personal CREATE profiles, and CalDAV conditional personal CREATE/DELETE profiles with their own
PostgreSQL ledger. It uses the C04 native provider ports, the C06 shared `@musubi/sync-runtime`
already-claimed runner and the published v1 schema/plan validator, with no dependency on Musubi DB, auth, app config or API.
Its event content model is `ReferenceContent`; bounded Google Task UPDATE uses
the independent richer `ReferenceTaskContent` and four separate task ledger tables.
Addressed Google Task DELETE uses that task namespace with its own canonical
tombstone, response evidence and scoped absence ACK.

This is an extraction fixture and CLI. It is not the future Calendar Relay
service. It has no account onboarding, OAuth refresh, scheduler, public API,
meeting/recurrence support or task CREATE. Google CREATE reserves a new personal, nonrecurring timed event using an immutable operation UUID and exact UTC time endpoints. Google DELETE targets an existing exact native address with a strong accepted validator. Microsoft DELETE uses its original native weak ETag for a guarded preflight, with observe-only recovery and no CAS guarantee. Only `name`, `notes` and
`place` can be changed on an existing personal nonrecurring timed event. The
accepted time endpoints use canonical UTC instants and remain unchanged.

## Configuration and commands

The executable reads only `REFERENCE_DATABASE_URL`,
`REFERENCE_CREDENTIAL_KEY` (64 hexadecimal characters), and optional
`REFERENCE_ALLOW_PRIVATE_NETWORK` (`true` or `false`, default `false`) for its
CalDAV network policy. Use its own database;
`migrate` applies the five event tables and four task ledger tables, never Musubi migrations.
The key protects stored access tokens and strict Basic credential envelopes with AES-256-GCM and connection identity
as authenticated data. Changing the key requires an explicit credential migration.
Credentials are never written into operation envelopes or delivery receipts.

Run from the workspace with `pnpm --filter @musubi/sync-reference start <command>`
or build `docker build -f apps/sync-reference/Dockerfile -t sync-reference .`.
The image command is, for example, `docker run --rm --env-file <reference-env>
sync-reference migrate`. Commands other than `migrate` read one JSON object from
stdin, bounded to eight million bytes. Provide credentials through a private
input stream to `seed`, rather than shell arguments. Output is JSON, with bounded
HTTP outcome metrics on stderr during delivery. Invalid commands and interrupted
stdin return a safe error code.

| Command | JSON input | Meaning |
| --- | --- | --- |
| `migrate` | none | Install the standalone schema |
| `seed` | `ReferenceSeed` | Create a new connection/object/binding with an exact known native calendar/event ID, strong ETag, baseline, scoped token and expiry |
| `seed-create` | `ReferenceCreateSeed` | Bootstrap a new connection/object and reserve the deterministic native ID for one lowercase UUID `operationId`; no native ETag or baseline is asserted |
| `admit-create` | `{bindingId, expectedRevision, commandId, operationId}` | Atomically commit canonical CAS and one full immutable CREATE plan for that exact reservation |
| `admit` | `{bindingId, expectedRevision, commandId, operationId, patch}` | Atomically commit canonical CAS and immutable accepted operation |
| `admit-delete` | `{bindingId, expectedRevision, commandId, operationId}` | Atomically CAS the canonical object to tombstoned and capture one conditional DELETE |
| `seed-graph-delete` | `ReferenceGraphDeleteSeed` | Bootstrap an existing Microsoft target with explicit provider/profile, original native weak ETag, scoped token and expiry |
| `admit-graph-delete` | `{bindingId, expectedRevision, commandId, operationId}` | Atomically CAS the canonical object to tombstoned and capture one guarded Microsoft DELETE |
| `seed-caldav-delete` | `ReferenceCaldavDeleteSeed` | Bootstrap an exact HTTPS collection/resource URL, existing UID, original strong ETag and Basic credentials with explicit provider/profile |
| `admit-caldav-delete` | `{bindingId, expectedRevision, commandId, operationId}` | Atomically tombstone and capture one conditional DAV DELETE; this new reference command requires a lowercase UUID operation ID |
| `seed-graph-create` | `ReferenceGraphCreateSeed` | Reserve one Microsoft target with unknown native ID, explicit create profile and canonical UUID operation identity |
| `admit-graph-create` | `{bindingId, expectedRevision, commandId, operationId}` | Atomically commit the canonical revision and immutable Graph CREATE plan whose admitted native resource ID stays null |
| `seed-caldav-create` | `ReferenceCaldavCreateSeed` | Reserve a deterministic URL/UID from one original UUID, with explicit DAV CREATE profile and Basic credentials; no ETag or baseline |
| `admit-caldav-create` | `{bindingId, expectedRevision, commandId, operationId}` | Commit the canonical revision and original full codec ICS for that exact reserved URL/UID |
| `deliver` | `{operationId}` | Claim and run one bounded attempt |
| `show` | `{operationId}` | Inspect operation, capture, receipt and binding without credentials |
| `seed-task` | `ReferenceTaskSeed` | Bootstrap an existing exact native Google task list/task, strong ETag and full native baseline, with explicit Tasks grant and independent rich content |
| `admit-task-update` | `{bindingId, expectedRevision, commandId, operationId, patch}` | Commit task canonical CAS, full original codec target, baseline and sorted field mask; this reference helper requires a lowercase UUID operation ID |
| `admit-task-delete` | `{bindingId, expectedRevision, commandId, operationId}` | Tombstone canonical content and capture one original-address DELETE with a null body and separate baseline; lowercase UUID required |
| `deliver-task` | `{operationId}` | Claim and run the registered Google Task UPDATE or DELETE profile |
| `show-task` | `{operationId}` | Inspect task content, capture, native baseline and receipt without credentials |

`seed` is an explicit fixture/bootstrap input, not provider discovery or proof
that an arbitrary baseline is current. Delivery performs fresh native preflight
and exact readback. Use physical calendar IDs, never Google's `primary` alias.
Expired or refused credentials remain HOLD; this host does not refresh them.
Use opaque IDs of at most 2,048 characters. Content and native plans are subject
to the v1 strict JSON bounds. See [model.ts](src/model.ts) for seed/content shapes.

## Durable behavior

Admission records the accepted projection and sparse native plan once, together
with connection/source/privacy generations and canonical revision. SQL prevents
later changes to operation identity, payload or captured metadata. A command ID
is idempotent only for the same input fingerprint. One unacknowledged operation
per binding is a causal barrier; conflict resolution is outside this fixture.

The forward `schema-delete.sql` migration adds canonical `active/tombstoned`
lifecycle with a monotonic generation and native `present/absent` destination
state. The original schema, table identities, FKs, accepted UPDATE payloads and
attempt history survive. Repeating migration does not restore old authority.
UPDATE admission/delivery requires active canonical content and a present native
binding. DELETE requires the captured tombstoned incarnation and a present binding
until the atomic absence ACK; it retains historical ETag/baseline without treating
them as present. This fixture admits only one unfinished operation per binding:
UPDATE→DELETE handoff is serial after UPDATE ACK.

The forward `schema-create.sql` migration adds a distinct `reserved` destination
state and a write-once `create_operation_id`. A reservation has a null ETag and
baseline. Existing `present/absent` bindings retain their real or historical
values; UPDATE/DELETE operations retain non-null accepted validators. Only a
CREATE operation accepts a null `accepted_etag`. Repeating all migrations
preserves this distinction, accepted payloads, attempts and table identities.

`seed-create` is bootstrap, with the same private credential input boundary as
`seed`; it does not dispatch or admit an operation. Its input contains the seed
fields except `eventId` and `etag`, plus a canonical lowercase UUID
`operationId`. `admit-create` must use that same UUID. The immutable native ID is
`musubi` followed by its 32 hexadecimal UUID digits; its private
`musubiOperationID` marker, envelope, row binding and target must agree before
credentials or HTTP. A new reservation cannot reuse an `absent` destination
after DELETE. CREATE→UPDATE→DELETE is supported only serially after each ACK;
there is no pending CREATE cancellation/supersession or general causal graph.

The database owns the 120-second lease. Each delivery has a 45-second deadline
and a 20-second heartbeat owned by that shared runner. A transport ignoring
cancellation is detached at the same deadline; late callbacks cannot begin new
HTTP, evidence or ACK work. An ACK waiting on PostgreSQL locks checks the signal
inside its transaction and rolls back if it was cancelled before COMMIT. An
already committed ACK remains authoritative. Credentials and authority are checked before dispatch;
possible dispatch is persisted before POST, PATCH or DELETE. ACK updates the ETag/baseline and
operation atomically under the current attempt and all authority fences. HTTP
never runs inside a database transaction.

After possible dispatch, recovery begins with exact GET. A full accepted target
and strong ETag can confirm the binding without another PATCH. Otherwise only an
unchanged original ETag permits another fresh preflight and conditional PATCH;
a changed validator or incomplete observation cannot authorize a resend.
Successful PATCH is followed by an exact GET before ACK. This extra confirmation
is an intentional difference from the current Musubi success path.

DELETE always starts with an exact GET. Present evidence with a missing, weak or
changed ETag conflicts; unchanged strong evidence permits fresh ACL/event
preflight and conditional `If-Match` DELETE. This is action-specific: removing a
known attendee copy is allowed, while an organizer with other guests needs the
specialized organizer operation. 404/410 or cancelled exact observations can
confirm this accepted scoped deletion without dispatch. Reference success and
ambiguous replies require exact absence before ACK; Musubi may ACK an accepted
DELETE response and defers ambiguous recovery to another claim.

An absence receipt carries no ETag, content projection or invented provider
acceptance. A lost reply recovered by exact absence preserves provider uncertain;
a previous rejected mutation remains rejected. Atomic completion marks only the
binding absent under current lifecycle/source/credential/privacy/lease fences.
It is not a global provider tombstone or general pull/import implementation.

Receipts keep local commit, native provider acceptance, remote confirmation and
notification outcome separate. Lost reply plus matching readback remains
`provider=uncertain`, `remote=confirmed`. A prior rejected 429 can likewise be
ACKed by a later exact target match, with `provider=rejected` preserved, only in
a recorded recovery attempt after possible dispatch. ACK means the accepted
binding target is confirmed; it does not fabricate native HTTP acceptance.
412 stays terminal conflict, 429 honors Retry-After, and 401/403 require reconnect.
Unknown, malformed and legacy payloads are immutable HOLD before HTTP.

CREATE uses the full saved native JSON body and stable operation identity on
every permitted retry. A fresh attempt performs exact calendar ACL preflight,
one POST and exact readback. Reference adoption requires complete owned marker
and content equality, a real strong ETag, durable possible-dispatch evidence,
active canonical incarnation and all current authority/lease captures. It
atomically changes `reserved→present`, stores that baseline/ETag and ACKs the
operation. The transition advances source generation, so a later UPDATE captures
the newly confirmed binding. A stale CREATE cannot ACK twice.

A lost POST reply is observed within the same bounded attempt when time remains;
after restart it begins with exact GET. A matching owned target confirms delivery
without another POST while preserving `provider=uncertain`. Exact 404 may permit
another POST only with the same immutable ID/body after fresh guards. 410,
cancelled resources, foreign markers, changed content and weak/missing validators
do not authorize adoption or another write. HTTP 409 remains a rejected CREATE,
without automatic GET/adoption. A rejected receipt is not promoted to adoption
merely because an owned matching resource appears later; the host retains HOLD.
After 429 and its Retry-After, an exact 404 can permit a fresh same-ID POST whose
new acceptance may complete. These restrictions are reference host policy;
Musubi's separately accepted success and recovery policy remains distinct.

## Microsoft guarded DELETE

The Microsoft slice accepts only an owned, writable calendar and a complete
personal timed `singleInstance`: not cancelled/draft, no attendees, recurrence,
parent or online meeting. `seed-graph-delete` takes the normal seed fields plus
`provider: "microsoft"` and
`endpointProfile: "microsoft-personal-event-delete-v1"`. Its `etag` is the exact
native weak `W/"…"` value; a strong tag or `changeKey` is not a substitute.
The current credential must grant the exact `Calendars.ReadWrite` scope token.
Bootstrap is not fresh provider evidence; delivery verifies the current identity,
calendar ownership/access and native personal shape before sending.

The forward `schema-graph-delete.sql` migration adds immutable connection and
operation providers and an immutable operation endpoint profile. Existing rows
are explicitly stamped with their original Google provider/action profile
without rewriting payloads, validators, epochs or receipts. An INSERT trigger
preserves existing Google SQL and CLI defaults; Microsoft requires explicit
metadata. Invalid explicit metadata cannot select a Google fallback. Existing
Google CREATE/UPDATE/DELETE admissions remain Google-only.

This profile is `guarded-preflight`, with an acknowledged GET-to-DELETE race.
The native weak ETag is compared immediately before dispatch, and `If-Match`
is retained only as best effort. It does not make DELETE conditional CAS.
One already-owned claim uses the shared finite deadline/heartbeat and one native
guard pass. A 204 or 404 DELETE response is recorded independently; ACK always
requires a later exact scoped GET 404. HTTP 410 and a cancelled native object
do not stand in for that absence proof. The confirmed binding becomes absent
while retaining its historical weak ETag and baseline.

Possible dispatch is persisted before DELETE. After that marker, every later
claim only observes: even a still-present event at the identical native version
does not authorize another DELETE. This includes a killed process before HTTP,
lost replies, rejected 429 responses and unavailable readback. The store's
locked `markDispatch` also refuses a second send for the operation. Verified
absence can finish with prior accepted, uncertain or rejected evidence intact;
it never fabricates provider acceptance or an ETag.

Reference has no explicit resolution/supersession feature in this slice. A
present target stays HOLD, its canonical object remains tombstoned, and the
existing pending-binding barrier prevents a new intent. There is no force/retry
flag, marker reset or admitted-validator rewrite. Musubi's separately admitted
first-attempt resolution flow remains a host-owned policy and is not exposed
by this reference CLI. Google conditional recovery remains unchanged.

## Microsoft one-shot personal CREATE

`seed-graph-create` takes explicit `provider: "microsoft"`,
`endpointProfile: "microsoft-personal-event-create-v1"`, `connectionId`,
`objectId`, `bindingId`, physical `calendarId`, lowercase UUID `operationId`,
`accessToken`, `expiresAt`, `scope`, `content` and optional `privacyLabel`.
The current OAuth scope must contain the exact `Calendars.ReadWrite` token.
No event ID, ETag or baseline is asserted for this reservation. Bootstrap is
not fresh native permission or ownership evidence.

Admission uses the actual v1 Microsoft encoder. Its operation UUID fixes
`transactionId` and the complete timed nonrecurring JSON body. The encoder's
Microsoft projection normalizes nullable text while this host retains its own
`ReferenceContent`. The required codec context time is inert for this serializer;
it creates no timestamp or native identity. The immutable operation locator and
SQL `event_id` remain NULL forever, including after completion. Graph's returned
ID belongs to separate native evidence and eventually the binding.

An immutable binding `create_profile` distinguishes this reservation from
Google's deterministic native ID. Only the Microsoft CREATE profile may reserve
an unknown ID or retain a present/absent binding with nullable native validator.
Atomic adoption installs the returned ID, exact confirmed projection and original
weak-or-null readback ETag, then ACKs and advances this host's source generation.
Old Google strong-validator and reservation rules remain unchanged. Earlier
migrations preserve later provider/profile constraints when rerun; populated
upgrade and repeat-migrate tests include adopted Graph rows with NULL ETags.

Fresh reference delivery proves the current Microsoft principal, exact editable
calendar and matching owner. This is deliberately stricter than Musubi's existing
single calendar permission request. It sends one POST with no conditional header,
persists native acceptance before verification, then completes the entire scoped
collection listing and requires exactly one `transactionId` match. Strict listing
requests UTC and plain-text body representation; HTML despite that preference is
not normalized by this reference host. The ETag annotation is read from the
response, not named as a selectable Graph property.

Native candidate ID, acceptance status and raw response validator are durable
operation/attempt sidecars. The validator column contains `JSON.stringify`
encoded text (SQL NULL means native NULL), so empty, malformed, NUL and unpaired
UTF-16 strings round-trip honestly. Only the new Graph CREATE DTO decodes this
metadata. It is never installed as a conditional validator in the shared receipt.
Readback separately requires a real native weak ETag or explicit NULL. A prior
accepted or uncertain provider fact remains separate from remote confirmation.

Candidate identity is monotonic. Neither stale attempts nor a later different
unique ID can rewrite it. A confirmed uncertain read can capture a candidate
without inventing an accepted POST response; that candidate also fences restart
recovery after a process dies before ACK. Scope occupancy collisions, stale
leases, changed source/connection/privacy/canonical authority and cancelled
waiting transactions refuse adoption without a partial binding update. Actual
native evidence remains durable independently of failed host ACK.

Possible dispatch is a permanent one-shot marker, including a killed worker
before HTTP, uncertain replies and known rejected 429 responses. Restart recovery
only reads the complete collection; zero matches, duplicate markers, incomplete
listing, changed content/identity or unsupported native scope never authorize a
second POST. Retry-After still delays the next observation. This reference also
keeps a rejected response on HOLD if a matching resource later appears; it does
not manufacture native acceptance or provide resolution/supersession. The existing
pending-binding barrier prevents another intent while the outcome is unresolved.

## CalDAV conditional personal DELETE

`seed-caldav-delete` requires `provider: "caldav"`,
`endpointProfile: "caldav-personal-event-delete-v1"`, `connectionId`, `objectId`,
`bindingId`, `calendarUrl`, `resourceUrl`, `uid`, `etag`, `username`, `password`,
`expiresAt`, and `content` (optional `privacyLabel`). The resource is one exact
canonical HTTPS direct child of the captured collection. UID is mandatory and
never inferred from a filename or host object. Unknown fields, OAuth token/scope
inputs and weak ETags are refused. Content uses UTC timed endpoints at second
precision; nullable empty text that the existing codec would normalize is
refused instead of silently changing the accepted projection.

This new reference command requires a canonical lowercase UUID `operationId`
because it uses the actual portable v1 encoder. That is a reference admission
constraint, not a portable runtime identity rule; existing Google/Microsoft
identities remain unchanged. The encoder receives an inert required context
time that DELETE does not serialize. No provider/receipt timestamp is invented.

Basic credentials are stored only as a strict encrypted
`{kind:"basic",username,password}` connection envelope. The connection has an
empty OAuth scope. `expiresAt` is this independent host's local credential
valid-until policy, not an OAuth or provider expiry. The distinct session port
constructs the Basic authorization header and never falls back to a bearer
session. CLI delivery uses the shared guarded DNS-pinned transport with public
network policy by default; private-address access requires the explicit local
reference option above. The runtime refuses missing dedicated transport or
completion capabilities before credentials or HTTP.

The admitted native plan, accepted UID, collection/resource URL and original
strong ETag remain immutable. Binding UID/URL changes advance this host's own
integer source generation; changes to Basic credential ciphertext advance its
connection generation. These are local reference floors and do not describe a
global guarantee for Musubi's separately owned CalDAV connection timestamps.

Fresh delivery proves exact collection DAV `all`, `write` or `unbind` privilege,
then reads a complete resource at the original UID and strong ETag. The strict
profile requires exactly one timed nonrecurring VEVENT, no attendees, and no
ambiguous organizer identity. Physically valid unmodified VTIMEZONE/VALARM data
may remain in the native resource. Missing/unknown ACL is refused; there is no
iCloud missing-ACL compatibility. Redirects, collection escapes, changed UID or
validator cannot select a new resource or advance the admitted version.

Possible dispatch is persisted before HTTP and never cleared to enable retry.
Unlike the Microsoft one-shot gate, an interrupted DAV claim may retry the same
conditional DELETE after exact present observation and another fresh authority
preflight prove the same UID/URL/original ETag. Rejected 429 responses retain
Retry-After; a later retry still uses the original `If-Match`. This does not
create a resolution/supersession feature. A completed attempt whose retained
resource produces terminal conflict keeps the pending-binding barrier.

Native DELETE acceptance (200/201/204/404) remains separate from confirmation.
Reference ACK always needs a later exact resource GET404, including recovery.
HTTP410, cancelled resources and empty/malformed DAV responses cannot prove
absence. The absent binding retains historical UID/ETag/baseline. Lost-reply
recovery preserves uncertainty, and initial absence invents no native acceptance.

## CalDAV conditional personal CREATE

`seed-caldav-create` requires `provider: "caldav"`,
`endpointProfile: "caldav-personal-event-create-v1"`, `connectionId`, `objectId`,
`bindingId`, `calendarUrl`, `operationId`, `username`, `password`, `expiresAt` and
`content` (optional `privacyLabel`). `admit-caldav-create` takes `bindingId`,
`expectedRevision`, `commandId` and that original `operationId`. Unknown fields,
caller-supplied native URL/UID/ETag, OAuth inputs and resolution intents are refused.

The reference requires a canonical HTTPS collection URL ending in `/`, matching
its existing strict DAV DELETE address floor. The canonical lowercase UUID fixes `musubi-{UUID}` and the exact direct-child URL
`{calendarUrl}/musubi-{UUID}.ics`. The reserved binding retains that known identity,
its immutable CREATE profile and no validator or baseline. This is distinct from
Google's known native ID and Graph's unknown-ID reservation; Graph's permanently
NULL admitted ID and weak-or-null adopted validator remain unchanged. Admission
uses the real CalDAV event encoder, saves its complete original `createResource`
and verifies exact projection agreement. Second-precision UTC endpoints and
nonempty-or-null optional text prevent silent wire normalization. Retry never
rebuilds ICS or sends only the replacement VEVENT component.

The existing reference Basic credential envelope, empty scope, own integer
connection/source generations and local credential-valid-until policy apply.
Strict delivery uses the dedicated DNS-pinned transport, exact collection
`all`, `write` or `bind` privilege, and no redirects. It sends `If-None-Match: *`
to the original URL. Native PUT 200/201/204 and its strong-or-null response ETag
are durable evidence before verification. DAV-only operation/attempt status
columns retain this history; Graph candidate and raw acceptance columns are not
reused. A later conditional acceptance may have a newer status/validator, while
an unsuccessful retry cannot erase an earlier accepted fact.

Reference ACK requires a complete exact-URL GET, the admitted UID, matching actual
normalized timed nonrecurring personal content and a real strong readback ETag.
Physical validation permits valid resource-owned VTIMEZONE and VALARM data, but
refuses extra/nested events, attendees, cancelled resources and unproven organizer
identity. The portable projector does not use floating or ambient timezone
fallbacks. Strong readback, baseline, reserved-to-present adoption and ACK commit
atomically under current authority and lease fences. Adoption advances the source
generation once. A later serial DAV DELETE can use the captured real identity;
this slice adds no DAV UPDATE, recreation or supersession workflow.

Possible dispatch is never cleared. Restart recovery may GET404, prove fresh bind
authority and retry the same conditional URL/UID/full body, including after earlier
native acceptance. This is a native conditional policy, not Graph's one-shot rule.
Matching recovery GET can adopt only accepted or uncertain dispatch; a previously
rejected CREATE stays on HOLD with evidence and no resend if a resource appears.
Older unknown PUT outcomes remain uncertain if a later conditional retry is
known rejected; a later matching GET can still confirm that older uncertainty.
Known 412 is terminal conflict without same-attempt readback. A readback404 after a
PUT does not trigger a second PUT in that attempt. HTTP410 cannot authorize retry.
Unresolved or terminal-conflict intent retains the pending-binding barrier.

Full-chain migration reruns preserve the later DAV CREATE checks before older
Graph migration statements execute. Existing six-profile payloads, attempts,
receipts, epochs, Graph reservations/adopted NULL validators, and table/index OIDs
remain intact. No Musubi database, auth, configuration or UI package participates.

## Verification

`pnpm --filter @musubi/sync-reference test` runs pure admission and injected-port
runner fixtures. `pnpm --filter @musubi/sync-reference run test:db` uses an
explicit disposable `REFERENCE_DATABASE_URL`. In CI only, `ENVIRONMENT=test`
plus `DATABASE_URL` permits the test bootstrap to create and drop a nonce-owned
independent database; the runtime CLI does not accept those aliases.

The process corpus kills real child processes, including inside admission before
COMMIT, then restarts from the same database. It covers lost reply, exact readback
failures, connection/source/privacy ABA, lease takeover and unknown payloads.
The CREATE storage corpus starts with populated C05/C07 UPDATE/DELETE rows and
attempt history, then verifies forward migration and an existing UPDATE ACK.
It also covers reserved-target constraints, serial handoff, stale ACK, rejected
adoption, caller mutation and cancellation while waiting for a PostgreSQL lock.
CREATE process fixtures kill admission and delivery at actual checkpoints,
verify one POST across lost-reply recovery and preserve pinned body hashes.
The CalDAV storage corpus upgrades populated Google CREATE/UPDATE/DELETE and
Microsoft DELETE history, reruns migration with DAV rows, and checks immutable
UID/URL/validator, Basic credentials, UID/URL/credential ABA, stale leases and
waiting-lock cancellation. Its process corpus kills actual admission/delivery
processes, proves same-version conditional retry after interrupted dispatch,
refuses changed UID/version and unsupported scope, and verifies exact absence
without disclosing native alarms/extensions or credentials.
The Graph CREATE storage/process corpora preserve all older Google/Graph/DAV
profiles through migration, enforce unknown admitted identity and one-shot
recovery, test nullable readback and lossless raw acceptance metadata, and kill
actual workers before/after dispatch, candidate persistence and atomic ACK.
The DAV CREATE storage/process corpora preserve all six earlier profiles and
Graph unknown/adopted NULL identities through repeated migration. They test
conditional PUT body equality, response-versus-readback evidence, native status
history, authority ABA, stale ACK, cancelled lock waits and real SIGKILL recovery
before/after PUT without importing Graph one-shot behavior.
Provider metrics count requests whose dispatch reaches the telemetry boundary.
They are not a durable exactly-once audit across a process kill inside HTTP.

[Milestone evidence and next gate](../../docs/planning/MUSU-37-independent-host.md)

## Google Task UPDATE

This separate C08 host gate updates an already addressed, nonrecurring,
unassigned Google Task. It has its own `reference_task_objects`,
`reference_task_bindings`, `reference_task_operations` and
`reference_task_attempts`; the only shared storage is the private encrypted
connection record. No task is represented as an event with invented times.
The seven event profiles and their admitted payloads, histories, source epochs,
Graph unknown-ID reservations and adopted nullable validators retain their
existing schema and behavior. The additive task migration runs last and is
repeatable over populated event and task histories.

`ReferenceTaskContent` stores `name`, nullable `notes`, `state` (`todo`, `doing`,
`done`), a full nullable UTC `dueAt`, and `importance` (`low`, `normal`, `high`).
Admission adapts that content through the real `encodeTaskV1` serializer. Its
Google target has exactly `title`, `notes`, two-state `status`, and day-only
`due`; the richer canonical values remain unchanged by a native ACK. The
original complete baseline, full target and sorted changed-field mask are
frozen together. A title-only change sends only title. A rich-only change may
have an empty mask and confirm through reads with no PATCH or invented native
acceptance. The original strong ETag and baseline are never rebased from a new
remote version. There is one unfinished operation per binding, including HOLD
and conflict; no predecessor graph or resolution/supersession feature is added.

The reference policy deliberately requires **all four target fields** to match
an exact strong-tagged readback. If a concurrent actor changes untouched notes
after a title PATCH, reference refuses ACK and retains the real accepted native
fact and original binding baseline. It does not write a fictional desired
baseline. Musubi's separately accepted saved-patch readback and lossy home/secondary
semantics remain its own host policy. This reference gate does not claim those
policies are interchangeable.

`seed-task` requires explicit `provider: "google"` and
`endpointProfile: "google-task-update-v1"`, a physical task-list/task ID, the
four-field native baseline, token, expiry and exact
`https://www.googleapis.com/auth/tasks` scope token. Calendar or readonly Tasks
grants do not authorize this family. Bootstrap is an input assertion, not fresh
provider evidence. Credentials are rechecked before native dispatch and ACK,
with the independent integer connection/source/privacy/lifecycle generations.
A new physical credential identity needs a new connection or explicit retirement/
reconnection; replacing a non-null encrypted token alone is not an incarnation
change. There is no reference OAuth refresh. The real codec requires a UUID
context, so this new reference admission command requires a lowercase UUID;
portable UPDATE operation identities remain opaque. Commands/idempotency keys
are task-scoped, separate from event commands.

Fresh nonempty delivery uses native GET, fresh preflight GET, final writer GET,
one original-validator conditional PATCH and exact readback GET. A possible
dispatch is durable before PATCH. After a lost reply, recovery can ACK a full
matching target through GET only while retaining `provider=uncertain`. Otherwise
only the unchanged original baseline and original strong ETag allow another
conditional attempt, with the same immutable body. 404/410 never confirm UPDATE.
412 is terminal conflict; Retry-After delays the next claim. A known rejected
response stays rejected if a later recorded recovery read fully confirms the
target; no acceptance is fabricated. An earlier accepted/uncertain fact survives
a later failed or rejected retry.

Task-specific `native_acceptance_status` columns record actual 200/201/204
before success-body parsing, independently of a usable response validator.
A malformed body, missing tag or failed verification cannot revoke that fact.
An interrupted process can restore it without guessing from a result ref.
An empty-mask GET-only ACK retains `provider=not-dispatched`. Task ACK updates
only the real native baseline/ETag and operation atomically under the owned
DB-clock lease and all current authority fences; waiting cancellation or lease
expiry rolls back provisional writes. Canonical content is not reconstructed
from the lossy provider projection. Native HTTP never runs inside those locks.

Old event executables cannot process task commands/rows; there is no automatic
event fallback. Only serial forward migration/worker replacement is covered,
not downgrade or mixed-version task workers. This local extraction fixture is
not production activation, deployment, or full C08 acceptance.

## Addressed Google Task DELETE

Use `seed-task` to bootstrap an existing native task with its original strong
validator/full baseline, then `admit-task-delete` to commit the canonical
`tombstoned` incarnation and one `google-task-delete-v1` operation. Bootstrap
keeps its existing `google-task-update-v1` input shape; it does not admit UPDATE
or prove fresh native evidence. An ACKed UPDATE can be followed serially by
DELETE. CREATE, missing-address dependencies, hierarchy, assignment, resolution
and supersession remain outside this gate. The one-unfinished-operation barrier
includes HOLD/conflict, with no implicit resurrection after absence.

The real Task codec produces a DELETE plan with `body:null`. DELETE has no fake
UPDATE projection/mask: those fields are null only for this action. Its original
native baseline is captured separately and immutably alongside the physical task
list/task ID, ETag and source/private/connection/canonical generations. Rich
canonical content stays unchanged. The additive final migration preserves all
eight preceding event/Task UPDATE profiles, sidecars, payloads, epochs/history
and table/index identities. Repeating the full chain over DELETE rows does not
narrow action/profile constraints or remove baseline immutability.

Two DELETE-only op/attempt sidecars distinguish actual `200..299` HTTP responses
from absence-only DELETE `404/410` responses. UPDATE's response contract stays
`200|201|204`. Generic provider receipt `accepted` for DELETE means a successful
request response/fulfillment: only `delete_acceptance_status` attests actual2xx
HTTP acceptance. `delete_response_absence_status` attests raw DELETE404/410,
without claiming accepted HTTP or an applied mutation. Earlier2xx remains known
across a later absence-only response. GET absence creates neither response
sidecar nor dispatch marker.

Reference requires an actual scoped GET404 or410 before ACK, even after DELETE
returned2xx/404/410. The strict provider checks exact logical URL, redirects and
partial responses before classifying absence. Initial or writer-final GET can
prove absence without sending DELETE; typed completion identifies its initial/writer/
readback source. A200 `deleted:true` task is outside this strict profile, as are
assigned native tasks. Musubi's direct ACK after its original successful DELETE
response remains a separate API policy.

Fresh delivery uses initial GET, preflight GET, writer-final GET, at most one
original-validator conditional DELETE and a confirmation GET. After an unknown
reply, only the unchanged original baseline and strong ETag permit conditional
replay; the native address is never rebased. Any known response fulfillment,
whether actual2xx or DELETE404/410, makes reference recovery observe-only while
the task is still present. Lost reply plus GET absence retains uncertain; a
known rejection stays rejected when a later GET confirms absence. Earlier
uncertainty/acceptance survives later retry failures.412 is terminal;429 honors
Retry-After. No provider CAS guarantee is added.

Absence ACK atomically changes only binding presence to `absent` and ACKs the
operation. Historical ETag/baseline, `active` grant and source generation remain:
deleting a native task is not source retirement. UPDATE requires a present
binding and active canonical task. Dispatch/evidence/finish/ACK check DB-clock
lease ownership after awaited locks, with final credential validity on dispatch
and ACK. Cancellation or false final settlement rolls back provisional writes;
HTTP never runs under these locks. Only the bounded independent host gate is
proven; production activation/deployment and full C08 acceptance remain separate.
