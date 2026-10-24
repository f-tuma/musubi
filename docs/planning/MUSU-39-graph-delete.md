# MUSU-39 · Graph guarded personal DELETE

This C07 slice shares one already-claimed Microsoft Graph personal, timed,
nonrecurring DELETE between Musubi and the independent reference host. The
profile remains `guarded-preflight / read-write-gap / observe-only` for unresolved
possible acceptance. Native `W/"…"` ETags remain weak, unmodified values. The
best-effort `If-Match` header is not compare-and-swap or an atomic guarantee.

The existing [accepted Outlook limitation](../audits/outlook-guarded-delete-20260921.md)
includes a real probe where Graph deleted after a concurrent edit following the
last GET. Tests deliberately preserve this race rather than simulating CAS.
Microsoft documents normal calendar-scoped deletion and meeting cancellation
side effects; this slice excludes meetings and never calls permanent deletion.
[Delete event](https://learn.microsoft.com/en-us/graph/api/event-delete?view=graph-rest-1.0).

## Admission and capability boundaries

The existing `microsoft-personal-event@1` codec and DELETE body-null plan remain
unchanged. Before any preparation, session or transport, the runtime captures
and validates the admitted projection, action/provider/serializer, side effects,
row binding, target address, prior facts, attempt ordinal, resolution evidence
and host policy. Logical account identity remains distinct from the captured
physical OAuth connection incarnation. Generic operation IDs remain opaque.

The portable profile excludes all-day, recurrence/occurrences, meetings,
attendees and specialized operations. Genuine unsupported host families keep
their existing route. A registered nominal Graph DELETE family enters full
kernel validation; malformed selected data cannot fall back to another writer.
Legacy and unregistered custom adapters remain on their existing path.

The storage-free `@musubi/provider-microsoft` uses explicit session, HTTP, clock,
telemetry and host mutation-fence ports. Exact target reads require complete 200
responses with matching native ID; only exact 404 means absence. HTTP 410 and
cancelled resources are not absence. Redirected/differently scoped responses and
partial reads are refused. Requests have bounded signals and metrics contain no
native identities, content or credentials.

Every fresh preflight checks the current write grant, `/me` identity, exact owned
editable calendar, complete personal single-instance shape and the exact accepted
native weak ETag. The final mutation reopens an attested same-incarnation session,
rechecks the grant and executes the host authority/lease fence after credentials.
The native read/write gap remains explicit.

## Wire and outcome policies

| Case | Musubi | Reference |
| --- | --- | --- |
| Fresh attempt | Exact delivery GET, two me/calendar/event guard passes, one DELETE, fresh verification GET | Exact delivery GET, one guard pass, one DELETE, fresh verification GET |
| Initial exact 404 | Existing host authority/mapping checks, then ACK without a native mutation | Current reference authority/binding checks, then ACK without a native mutation |
| Native guard 404 | Preserve both Musubi passes; only the final pass controls dispatch/absence | One guarded pass controls dispatch/absence |
| DELETE 204 or 404 | Record acceptance in attempt facts, then require fresh exact GET 404 before ACK | Durably record acceptance, then require fresh exact GET 404 before ACK |
| Lost/ambiguous DELETE | Retain uncertainty; observe during a later claim | Observe in the remaining attempt budget; never a second DELETE |
| Recovery finds a present resource | HOLD with comparison even at the same weak ETag; no resend | HOLD; no resend |
| Conclusive not-written 429 without inherited uncertainty | Existing Retry-After retry may perform a new guarded attempt | Permanent dispatch marker prevents a second DELETE |
| Existing uncertainty followed by a known rejection | Preserve inherited uncertainty | Preserve monotonic dispatch and native facts |
| Explicit new resolution | Existing host comparison/CAS admits a distinct intent; only its first attempt at the captured weak ETag can send | Unsupported; pending barrier and original immutable intent remain |

`facts.possibleDispatch` records the dispatch boundary crossed within the current
attempt. Musubi's next claim carries its unresolved uncertainty, rather than a
monotonic count of every conclusively rejected historical request. Its known
429 retry policy is preserved, including rechecking authority and native guards.
An ambiguous 500/lost response remains observe-only. The reference host chooses
a stricter durable one-shot rule even after known rejection. Neither policy
converts presence at the same version into replay authority after uncertainty.

Acceptance, remote absence and host settlement are independent. Musubi records
native acceptance within the active attempt; its existing outbox does not
durably store the Graph 204/404 status. After a crash it conservatively resumes
with uncertainty. Only reference's ledger durably retains that acceptance status
across restart, as proved by its installed-image kill/restart cases.
An exact GET 404
never fabricates provider acceptance, a projection, validator or global canonical
delete. A failed verification preserves previously accepted/uncertain attempt facts and
cannot become a not-written retry. Every shared completion requires exact 404.

## Musubi host authority and normalization

Musubi keeps its source/grant/privacy/incarnation, predecessor, lease, retained
pull/tombstone and exact mapping checks. DELETE retains its existing scoped
authority after allowed local unlink/canonical edits; the bridge does not add
UPDATE revision-equality rules. Atomic completion remains the existing host SQL
transaction and checks cancellation again after waiting locks.

A host validation port executes the actual existing native normalizer before a
delivery read can authorize preflight and during conflict comparison. This
preserves the prior malformed subject/body/location/removal floor without
copying Musubi normalization into the kernel. It does not persist a new snapshot.
Raw verification remains separate, matching the old writer.

Paired tests found a real unsafe intermediate behavior: a matching-version
response with `body.content=42` threw in the old normalizer after one GET, while
the extracted path initially reached DELETE. The host validation port and fresh/
recovery malformed-content regressions now block before preflight or mutation.

The attempt lifecycle bounds preparation, credentials, HTTP, evidence and ACK.
Heartbeat/timeout guards fence signal-ignoring continuations, including host
normalization and the durable before-dispatch fence. A known committed atomic
ACK wins a racing timeout/finish. Private shadow replay accepts saved native
facts only and has no credential, HTTP or storage capabilities.

## Reference storage and compatibility

`schema-graph-delete.sql` runs after the existing schema/delete/create migrations.
It adds immutable connection/operation provider and endpoint-profile metadata.
Existing Google operations are stamped solely from their saved action; payload,
accepted validator, revision, epochs, attempts, table identities and pending
barrier remain unchanged. Existing CLI commands remain Google-specific.

Dedicated `seed-graph-delete` and `admit-graph-delete` capture the weak native ETag
and the existing Microsoft write scope. Admission atomically tombstones the
current canonical incarnation and saves its pinned operation. Provider/profile
selection precedes action dispatch and current authority checks. Graph cannot
enter a Google runner or completion port.

Under existing operation/authority locks, `markDispatch` refuses a Graph operation
whose durable dispatch marker is already true. It never resets that marker to
retry. Graph absence completion accepts only exact 404 and preserves native
acceptance/rejection/uncertainty separately. Reference has no new resolution,
supersession or general predecessor-queue feature in this slice.

## Source and local verification

- New provider: 20 injected-port cases. Shared runtime: 75 cases including 14 new
  Graph kernel cases for snapshotting, invalid input, resolution, ignored signals,
  lease loss, normalization, atomic ACK races and pure replay.
- Graph JSON: 23 scenarios plus 6 harness regressions. Root orchestrator: 16
  regressions; CI inventory: 11. Aggregate behavior corpus: 44 scenarios, zero
  failures/errors, 4.476 seconds in the recorded development run.
- Musubi: 124 actual PostgreSQL/HTTP cases including paired old/shared requests,
  host outcomes, recovery, resolution, source/privacy/lease/ABA, retained pull
  conflicts, waiting-lock rollback, malformed content and actual SIGKILL/restart.
  Original Microsoft DELETE integrations passed with encoder ON and OFF; original
  native DELETE, pinned transport and all 88 API unit scripts passed.
- Reference: 12 Graph pure, 10 PostgreSQL and 17 process/HTTP/SIGKILL/CLI cases.
  Existing Google 63 pure, 65 PostgreSQL and 65 process cases passed after migration.
  Populated upgrade preserves pending Google CREATE/UPDATE/DELETE and their history.
- Workspace typecheck, lint, contracts and release metadata checks passed. Existing
  mobile lint warnings remain non-errors; required web zero-warning lint passed.

Installed-image, final running-app and current-head CI evidence are recorded
separately when completed. Local fixtures use only owned loopback endpoints and
nonce databases; no live Microsoft/Google account acceptance is claimed. Source
completion is not registry publication, production deployment, or completion of
remaining C07 CREATE/DAV/other provider gates.

### Local installed API proof

Local image `musubi-c07-graph-delete-api:proof` has Docker image/index identity
`sha256:c5e3b8197c6b5491940e88ad7124518bda99b11f8d9ba707d2a676b4b5c17248`.
All 407 installed production TS/SQL files match frozen and current source;
source fingerprint is `d96f6efc06d4d23030e7f06bfc034606f6fc18089c60d857edad5a708ba2bac2`.
The context fingerprint includes tests and documentation; after the build only
the API integration-test corpus and provider README changed. All 407 production
TS/SQL files still match byte-for-byte.
The non-root container runs without source mounts. An empty nonce database
applied all 86 migrations through `0085_graph_read_coverage`, with the latest
SQL hash matching source. Startup and effective configuration confirm encoder
ON by default without an override.

Seventeen real HTTP checks passed: public health/capabilities, unauthenticated
rejection, real Better Auth signup/password login/cookie session, calendar/event
CRUD, idempotent replay and stale-revision rejection. No auth bypass or direct
user seeding was used. The fixture had zero external accounts/outbox targets,
SMTP or push and disabled background sync. This installed API smoke does not
claim a live or installed Graph DELETE; the actual native path is separately
proved by the paired PostgreSQL/HTTP and process corpus.

Its own API container and nonce databases were removed. The image is local QA
evidence; it was not pushed to a registry or deployed to production. See the
[sanitized API summary](./evidence/MUSU-39-graph-delete/api-installed-summary.json).

### Local installed reference upgrade/crash proof

Old local image `sha256:f019aa6b428f518c7b98c64747b3798161ea5aa161c08c1f8978aff33fd2eb28`
upgraded to new Docker image/index
`sha256:528b899fe815b37bbc065090a156dcf936222074a20c0f34e6af02746c00d7d4`.
The platform manifest/config identities are recorded separately in the summary.
All 105 installed TS/SQL files, including 63 runtime files, match frozen/current
source. Canonical source manifests are
`c31993f39b193fcf144f5bff409a5541cec2580c88c9731556da55c7fcaa15e9` and
`330c4f9126eca7cfb4eb2576a1351b78c9571837862bbd3d6057985952905c58`.
The complete 25-package inventory contains no Musubi DB/auth/config or mobile
framework dependency.

Five installed-image cases passed using 40 owned native fixture requests:

1. Pending Google CREATE/UPDATE/DELETE and three interrupted attempts migrated
   without changing normalized historical rows, payloads, epochs, receipts,
   counts or any of the 15 table/index OIDs; all three actions then ACKed.
2. Container SIGKILL after durable dispatch marking but before native HTTP:
   zero DELETE, repeated present GET-only HOLD, then exact404 ACK uncertain.
3. Accepted204 then SIGKILL during verification: one DELETE, restart GET404
   ACK retaining accepted/status204.
4. Lost reply then SIGKILL during verification: one DELETE, restart GET404
   ACK retaining uncertain/null acceptance status.
5. Known429 honored its delay and retained the stricter reference one-shot
   marker; present restart only read, later404 ACK retained rejected evidence.

Repeated delivery after ACK was unclaimed and made no HTTP requests. The fixtures
route only known provider URLs to owned loopback, preserve logical response URLs
and offer no real-network fallback. Production source was installed into images,
not mounted from the checkout. All owned CLI containers and nonce databases were
removed and absence-verified. See the [sanitized reference summary](./evidence/MUSU-39-graph-delete/reference-installed-summary.json).

### Final running-web confirmation

After fast, database/process and installed-image checks, the aggregate JSON
command passed 44/44 scenarios with zero errors in 4.301 seconds. The running
web app then replayed all eight desktop/light and narrow/dark UI cases in
15.1 seconds, with exact synthetic API receipts, no unexpected runtime/console
errors or horizontal overflow. Its fixtures do not replace the installed real
login/HTTP proof or native PostgreSQL/HTTP corpus above.

The first cold Vite run caught one dynamic-client-import error during initial
dependency optimization. After that optimization completed, the unchanged full
suite passed cleanly; no error allowlist, retry setting or assertion was relaxed.
The Browser plugin is unavailable here, so this used the existing Playwright
workflow. Screenshots/traces remain temporary artifacts outside the repository.
