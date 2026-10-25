# Independent sync reference host

C05–C07 / MUSU-37–39 runs bounded Google personal event CREATE, UPDATE and DELETE profiles, a separate Microsoft guarded personal DELETE profile and a CalDAV conditional personal DELETE profile with its own
PostgreSQL ledger. It uses the C04 native provider ports, the C06 shared `@musubi/sync-runtime`
already-claimed runner and the published v1 schema/plan validator, with no dependency on Musubi DB, auth, app config or API.
Its content model is `ReferenceContent`, not a Musubi Event or Task.

This is an extraction fixture and CLI. It is not the future Calendar Relay
service. It has no account onboarding, OAuth refresh, scheduler, public API,
meeting/recurrence/task support. Google CREATE reserves a new personal, nonrecurring timed event using an immutable operation UUID and exact UTC time endpoints. Google DELETE targets an existing exact native address with a strong accepted validator. Microsoft DELETE uses its original native weak ETag for a guarded preflight, with observe-only recovery and no CAS guarantee. Only `name`, `notes` and
`place` can be changed on an existing personal nonrecurring timed event. The
accepted time endpoints use canonical UTC instants and remain unchanged.

## Configuration and commands

The executable reads only `REFERENCE_DATABASE_URL`,
`REFERENCE_CREDENTIAL_KEY` (64 hexadecimal characters), and optional
`REFERENCE_ALLOW_PRIVATE_NETWORK` (`true` or `false`, default `false`) for its
CalDAV network policy. Use its own database;
`migrate` applies only the five reference tables, never Musubi migrations.
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
| `deliver` | `{operationId}` | Claim and run one bounded attempt |
| `show` | `{operationId}` | Inspect operation, capture, receipt and binding without credentials |

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
Provider metrics count requests whose dispatch reaches the telemetry boundary.
They are not a durable exactly-once audit across a process kill inside HTTP.

[Milestone evidence and next gate](../../docs/planning/MUSU-37-independent-host.md)
