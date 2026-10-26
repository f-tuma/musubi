# Event compatibility source acceptance

The default `pnpm test:db:event-compatibility` gate runs five bounded programs
against disposable PostgreSQL databases. It needs no Git history. The programs
invoke the actual production event executor and keep independent expected
assertions from the retained integration gates. They cover generic PG authority,
actual legacy generic Google/Graph/DAV native composition, a Google setting,
Graph scoped family content, and Google organizer notifications. The manifest
unit also checks that all thirteen specialized dispatch families retain their
original default native gates.

The generic PG fixture has 26 delivery observations, a stub adapter and zero
native HTTP requests. The separate generic-native fixture exercises eighteen
real executor deliveries and 78 logical native HTTP requests: timed and legacy
all-day CREATE, UPDATE and DELETE for Google, Graph and DAV. It deliberately disables the admission encoder to characterize
the retained v0 host profile, then restores the flag. Production configuration
still defaults the encoder to ON; a fixture override does not prove installed
default-ON behavior or change feature availability. OAuth refresh, authenticated
URI, conditional headers, exact patches, canonical data, mappings and full DAV resource
preservation have literal expected assertions. This does not claim Graph
DELETE CAS or portable native support for a host compatibility profile.

For the complete twenty-program source corpus, run from the repository root:

```sh
ENVIRONMENT=test MUSUBI_EVENT_COMPATIBILITY_CORPUS=full \
  MUSUBI_EVENT_COMPATIBILITY_OUTPUT=/tmp/event-native-new \
  node --import tsx apps/api/src/sync/event_compatibility_delivery.integration.test.ts
```

Set `DATABASE_URL` to the administrator connection of an explicitly disposable
test server. Every program uses a new nonce database, migrations and its own
pools. Cleanup requires zero sessions before `DROP DATABASE`, without FORCE.
Native calls are restricted to owned loopback fixtures; no live provider
fallback is allowed. The existing fixture's response implementation remains
authoritative. Official-address response fixtures cross a real loopback HTTP
relay before the actual native adapter/parser receives their response.

Historical differential mode is explicit and fails if the exact baseline is
unavailable. It loads the original production `event_delivery.ts` at
`8ea0d3bfe193abd701e06c15d19b5d312bdd2290`, SHA256
`63f478c91e36db4913717db759e773d260e928cc530dd0c8696112b5e39ae8b0`.
Both implementations use the same existing production DB and native adapters.
No historical business logic is embedded in the harness.

```sh
ENVIRONMENT=test MUSUBI_EVENT_COMPATIBILITY_MODE=differential \
  MUSUBI_EVENT_COMPATIBILITY_QA=1 \
  MUSUBI_EVENT_COMPATIBILITY_OUTPUT=/tmp/event-native-paired \
  node --import tsx apps/api/src/sync/event_compatibility_delivery.integration.test.ts
```

`MUSUBI_EVENT_COMPATIBILITY_SUITE` selects a manifest program. The full corpus
retains every original fixture assertion, including DAV whole-resource series
edits/splits/deletions, Graph family CREATE/DELETE/content/cancellation, the
move coordinator, reminders and provider-specific RSVP/organizer policies.
The added Google RSVP recovery characterization explicitly expects a second
conditional PATCH for an unapplied reconciling row at the unchanged original
baseline, and GET-only recovery when already desired. That old Google policy
is an open no-resend gap, not proof of a universal observe-only policy.

Actual process acceptance is opt-in and separate from routine CI:

```sh
ENVIRONMENT=test MUSUBI_EVENT_COMPATIBILITY_MODE=differential \
  MUSUBI_EVENT_COMPATIBILITY_QA=1 MUSUBI_EVENT_COMPATIBILITY_PROCESS=1 \
  MUSUBI_EVENT_COMPATIBILITY_OUTPUT=/tmp/event-process-paired \
  node --import tsx apps/api/src/sync/event_compatibility_delivery.integration.test.ts
```

Four production delivery profiles are tested at four boundaries each: Google
organizer, Graph occurrence content, DAV organizer, and DAV split-source whole
resource. The original fixture/provider process survives. Its executor child
is killed with SIGKILL before the native event mutation; after native response
headers and before any body chunk reaches the executor; before the SQL
completion update; or after the real ACK transaction COMMIT and before its
caller receives completion. For notification profiles the first cut follows
the permanent possible-notification marker; DAV split retains its existing
resource-specific conditional recovery. Only the dead lease is expired before starting a separate actual executor.
Raw receipts contain distinct killed/restarted process IDs and exit signals.

The pre-send notification checkpoint requires durable `startedAt`; raw-response
checkpoint also requires absent `acceptedAt`. OAuth POST cannot satisfy a
mutation checkpoint. The process bridge sends headers immediately and streams
body chunks/errors separately. At the raw-header cut it deliberately defers all
body chunks until executor death; raw transport receipts assert that zero body
chunks reached the actual executor. Earlier complete-buffered response cuts
remain development characterization, even where all sixteen cuts passed; they
are not streaming raw-header acceptance. These boundaries distinguish possible
notification, known adapter acceptance and observed outcome. Committed ACK
recovery performs no native replay. Resource recovery verifies existing DAV conditional behavior. This
also preserves Graph's stricter raw-response outcome: a lost `acceptedAt`
callback leaves an applied family update unconfirmed, without canonical ACK
or another PATCH. Full native family equality cannot invent that acceptance.
This does not strengthen existing event ACK APIs with a cancellation signal
they do not expose, or prove cancellation rollback while waiting on an ACK
database lock. A separate process receipt asserts the entire twelve-relation
state after SIGKILL equals the checkpoint state before expiring the dead lease.
Each relation snapshot comes from one PostgreSQL statement and therefore one
MVCC snapshot. Outstanding delivery observations drain before the existing
fixture removes its user. These checks prevent fixture cleanup or mixed-time
table reads from being mistaken for a production state change.

Each raw receipt retains full logical native request/response bytes, the relay
ledger, every delivery result, canonical/mapping/outbox/family/journal snapshots,
and exact source manifests. The production manifest includes API host, runtime,
ports/types, shared ownership helper, adapters and DB sources. A separate
manifest hashes fixture/helper/harness sources, including the process executor.
Final runs require both manifests to remain stable throughout the program and
the corpus. `MUSUBI_EVENT_COMPATIBILITY_ALLOW_INTERMEDIATE=1` permits explicitly
labelled development characterization only; it is not final acceptance.

Old/new comparison normalizes only the following generated fixture metadata;
raw receipts always retain original values:

- Owned loopback origins become server-creation-order aliases. SQL and Node/
  WebCrypto opaque fixture UUIDs are deterministically seeded in both modes,
  so identities and derived resource/witness hashes remain comparable.
- Host clock/lease fields named `created_at`, `updated_at`, `createdAt`,
  `updatedAt`, `attempted_at`, `attemptedAt`, `lease_until`, `leaseUntil`,
  `lease_token`, `leaseToken`, `next_attempt_at`, `nextAttemptAt`, `observed_at`,
  `observedAt`, `provider_state_observed_at`, `providerStateObservedAt`,
  `startedAt`, `acceptedAt`, `completedAt`, `deleted_at`, and `deletedAt` become
  a marker only when their value is a string at an explicitly rooted host
  relation: a SQL table-row,
  outbox-return row, payload event snapshot, Graph context family/mapping/
  membership/source row, intent dispatch or host remote-snapshot relation.
  Coordinator SQL expiry clocks are treated the same way. A similarly named
  `payload.event` nested below native baseline or unknown provider data is not a
  host relation. Native provider baseline/identity/unknown fields with those
  names stay exact. Within genuine rooted outbox payloads, RSVP clock
  exceptions are limited to `payload.rsvp.graphDispatch.startedAt`,
  `payload.rsvp.graphDispatch.acceptedAt`, and
  `payload.rsvp.caldavDelivery.startedAt`. Other policy fields, unknown CalDAV
  `acceptedAt`, and native lookalikes remain exact. Null/presence remains
  meaningful.
- Serializer-generated iCalendar DTSTAMP property clock digits become a marker
  only within the component that the captured operation and actual serializer
  are proven to own. A complete VCALENDAR wire resource alone is insufficient:
  an unrelated or preserved sibling component must keep its DTSTAMP exact.
  Arbitrary notes and native JSON fields containing DTSTAMP also stay exact.
  Every other resource byte, native DTSTART/DTEND, original slot, canonical
  millisecond timestamp, validator, request body and conditional request header
  remains exact.
- Response transport headers Date, Connection and Keep-Alive are omitted
  from normalized comparison. Native JSON response bodies remain exact;
  iCalendar bodies allow only the component-owned DTSTAMP rule above.
- Table row order is sorted; delivery and native request order remain intact.
  Concurrent same-operation locked-claim callers keep every raw observation,
  and compare their exact settled durable state plus the full shared native
  ledger as one cohort. This accounts only for the unlocked observational
  pending/attempting/completed read race; it cannot discard a missing caller,
  mutation or final stored-state difference.

Serializer clock ownership has a separate raw proof. For CalDAV organizer
admission the worker calls the actual `caldavOrganizerDesired` factory with
the saved generated stamp and requires its complete result to equal the saved
desired object. A `serializerClocks` receipt retains the operation ID, exact
resource URL, UID, stamp, desired resource and resource hash. Its
`generatedProperty` must follow the actual create action or proven reschedule.
The comparator binds this proof to the actual rooted outbox payload and that
operation's native wire interval and exact resource URL. Before any wire clock
exception, the captured owned PUT body must equal the whole rebuilt resource
byte-for-byte. Only that PUT and later exact-URL response echoes can qualify.
Only the unique VEVENT with that UID,
no RECURRENCE-ID, and the matching direct DTSTAMP property qualifies. Preserved
siblings, other UIDs, recurrence components and arbitrary lookalike payloads
remain exact. The helper splices the proven property digits without
reserializing any other resource bytes. The generic CalDAV event serializer
emits no generated DTSTAMP
and gains no clock exception from being enclosed in a VCALENDAR.

Graph family/move request versions include host row creation/update clocks.
For each captured request the worker calls the applicable actual production
Graph version function and requires exact equality to its raw version.
The receipt retains the complete input, raw version and recomputed production
hash. Content uses the actual `graphContentVersion`, including native exception
evidence; cancellation uses `graphMeetingVersion`. Move proof also independently
validates the nested `initial.version` content witness before its outer
witness. Comparison independently verifies that raw cryptographic relation before
using a derived version recomputed with only the declared host context row
clocks normalized. Native baseline, identity, validators and original slots
are unchanged. A changed or unproven raw request version is refused. These
comparison values are never written back to an operation, database or provider.

The only address-order comparison exception is the named `delete-sweep-echo`
fixture case. Its actual scoped PostgreSQL UPDATE evidence is recorded with
actor/account/source ownership and the complete admitted mapping, UID and
original slot, and enters the ledger only after COMMIT. Before comparing,
the harness requires exactly one committed observation for every admitted
resource member, with no missing, duplicate or foreign member and no changed
identity/tag/deleted evidence. The raw returned and persisted selected snapshot
must equal the actual last committed echo byte-for-byte. Only this proven
last-choice snapshot compares the full sorted scoped evidence set, allowing
the existing unordered resource sweep to choose a different last member.
The original selected address and commit sequence remain in the raw receipt.
Other native addresses, provider fields and ordering keep their exact comparison.

A final evidence digest counts completed raw receipts, not console success lines
or expected matrix sizes. Full new-only, historical differential and streaming
process results are reported separately. Process summaries may include an
ordinary fixture prefix; distinct `processReceipt` objects and killed/restarted
process IDs establish the actual SIGKILL/recovery count. Earlier failed fixture
assertions, failed comparison or witness attempts, buffered characterization,
and mixed-source or mixed-harness runs remain preserved with their own paths
and hashes. They do not contribute to final acceptance totals. A missing summary,
missing raw receipt or unstable manifest remains incomplete. If a development
self-snapshot was overwritten, the evidence index records that fact and any
exact-hash recovery separately; it does not treat current replacement bytes as
the original historical artifact.

The harness and these source receipts are separate from image publication,
installation, browser verification and deployment evidence.
