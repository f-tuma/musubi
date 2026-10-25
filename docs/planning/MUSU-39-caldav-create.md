# MUSU-39 · CalDAV conditional personal CREATE

This C07 slice shares an already-claimed CalDAV personal, timed, nonrecurring
CREATE between Musubi and the independent reference host. The original operation
UUID owns a stable resource URL, UID and admitted full VCALENDAR string. Native
acceptance, exact resource observation and atomic host adoption remain separate.

`If-None-Match: *` makes PUT conditional on there being no current representation;
the origin must evaluate it before mutation and return 412 when the condition is
false. Local fixtures prove the emitted condition and outcomes, not arbitrary
server compliance. [RFC 9110 §13.1.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2).
CalDAV also defines collection UID conflict rules; this slice does not adopt a
different resource from a server-reported conflict href.
[RFC 4791 §5.3.2.1](https://www.rfc-editor.org/rfc/rfc4791.html#section-5.3.2.1).

## Frozen identity and admission

The unchanged `caldav-personal-event@1` codec supplies `createResource`, a full
VCALENDAR, plus the selected VEVENT and its normalized projection. The kernel
validates original canonical UUID, body/projection agreement, VEVENT profile,
empty sparse-property list, physical UID and exact planned locator before any
preparation, credentials, DNS or HTTP. It sends `createResource` verbatim; neither
`replacementComponent` nor a freshly serialized current event is a CREATE body.

Identity preserves the existing literal helper: append a slash only when absent,
then `musubi-<original UUID>.ics`; UID is `musubi-<original UUID>`. Native aliases,
Location headers or conflict hrefs never replace that stored identity. A known
URL differs from Graph's unknown-ID reservation. Source operation IDs remain
UUIDs; native resource identity is neither a new random ID nor an attempt ID.

The native helper can retain a derived URL longer than 2048 characters, but the
existing portable v1 envelope still limits its resource locator to 2048. The
over-limit case is explicitly held by the actual decoder with zero preparation,
sessions, DNS and HTTP. This slice does not widen the protocol or invent fallback.

All-day, recurrence, meetings, explicit modeled-time and specialized host families
keep their existing routes. Nominal selected malformed operations cannot invoke
a second writer. Supported CREATE payloads remain the bounded codec profile.

## Explicit native profiles and wire behavior

| Boundary | Musubi `existing-caldav` | Reference `strict-reference` |
| --- | --- | --- |
| Fresh flow | Collection ACL PROPFIND → conditional PUT → provider-response ACK | Same ACL/PUT, then exact readback before adoption/ACK |
| Create privilege | Fresh collection `all`, `write` or `bind` | Same requirement; no missing-ACL exception |
| Initial resource GET / organizer discovery | Neither is added | Neither is added before CREATE |
| PUT body and condition | Full original ICS and `If-None-Match: *` | Same immutable body and condition |
| Accepted PUT | Existing 200/201/204; strong-or-null response ETag, no repair GET | Record acceptance first, then require strong normalized readback |
| Recovery | Exact planned GET; actual existing CREATE normalizer | Exact direct-child GET; complete strict personal component tree and portable projector |
| Redirects | Existing guarded follow behavior | Refused |
| Recovery 404 | Fresh ACL then same conditional PUT may proceed | Same conditional retry policy, with durable marker retained |
| Recovery 410 | Error; never replay evidence | Error; never replay evidence |
| Known PUT 412 | Conflict/not-written; no automatic same-attempt GET/adoption | Same native refusal; no automatic read/adoption |

Fresh CREATE does not import DELETE's resource/organizer preflight. ACL empty
privileges deny; missing, malformed or non-207 evidence remains unknown, including
ACL 401/403. Transient ACL 408/429/5xx retains its existing retry classification.
The native guarded transport validates all resolved addresses and pins an actual
address at every hop. It preserves PUT/body/condition on 301/302/307/308, refuses a
conditional mutation becoming GET via 303, strips cross-origin Authorization and
keeps the five-redirect cap. Metrics count each actual leaf exactly once. One
logical PUT invocation can therefore contain multiple guarded HTTP PUT hops.

Strong ETags remain native opaque bytes, including a valid empty quoted value.
Weak, malformed, missing and empty-header values normalize to null. No validator
is repaired or synthesized. CalDAV specifies that transformed PUT content cannot
return a strong ETag; Musubi preserves nullable acceptance without an extra GET.
[RFC 4791 §5.3.4](https://www.rfc-editor.org/rfc/rfc4791.html#section-5.3.4).
Unexpected successful statuses, 5xx and lost replies are ambiguous. Existing
not-written classifications remain, including PUT 408/429 retry hints and the
other known native refusals. Provider error details never become public metadata.

## Recovery, normalization and uncertainty

After unresolved possible acceptance, only an exact recovery GET 404 authorizes
another attempt's original conditional PUT. A conclusively not-written Musubi
408/429 retry retains its existing fresh ACL → PUT route without a recovery GET;
the reference host's sticky dispatch marker still requires recovery observation.
A present resource must have the expected UID/master and physical
structure, complete 200/no Content-Range and fatal UTF-8 decoding before actual
host normalization. Content type is not newly required by Musubi. Matching
normalized projection can ACK without PUT and with a nullable API version;
changed content, wrong UID, cancelled or unreadable data cannot adopt or replay.

Musubi's actual CREATE normalizer is reused by legacy and shared paths. It
validates native fields before rejecting CANCELLED; the DELETE/read helper has
a different order and is not substituted. The kernel compares the normalized
seven-field projection without copying the API parser. Fresh PUT success does
not normalize an event body that was never returned.

Reference uses the production portable ICS projector: UTC or a unique
resource-owned VTIMEZONE is evidence, while floating/ambient timezone fallback,
unproven ORGANIZER, meetings, recurrence, nested components and cancelled content
are refused. Valid alarms/timezones and unknown properties remain untouched in
the saved native resource. Its CLI retains the canonical HTTPS/direct-child,
trailing-slash collection floor; generic Musubi no-slash/alias behavior is separate.
Reference seed/admission rejects fractional-second or empty-optional-text loss
instead of silently changing its independent canonical content.

There is at most one logical PUT per attempt. After ambiguity, Musubi defers
observation; reference may observe within the remaining budget. Within-attempt
readback 404 never sends another PUT. A later interrupted/held claim may retry
after exact 404 and fresh guards; no new identity/body or unconditional overwrite
is introduced. Known terminal conflict remains behind the pending barrier.

A known refusal of this conditional retry does not settle an older ambiguous
PUT. The current error retains its native status/outcome/delay, while historical
provider uncertainty and possible dispatch remain sticky. Known acceptance also
survives a later refusal. A later matching GET may confirm an unresolved write
without inventing a received acceptance response. A previously known-rejected-only
operation cannot adopt a matching resource merely because it exists.

Musubi preserves the conservative host boundary before the second Basic lookup,
separately from native dispatch facts. Current source checks precede that flag;
owned account ID/user/timestamp checks surround decryption and a live authority/
lease fence still runs afterward. Timestamp capture is an existing opaque
revision floor, not a new monotonic connection or full ABA guarantee. CalDAV has
no invented OAuth grant. Source/privacy/revision/predecessor, pull/tombstone,
scope occupancy and atomic ACK checks remain host-owned.

## Independent storage and forward migration

Reference reserves the known URL and UID in `event_id`, `ical_uid` and
`accepted_uid`, under immutable `create_profile='caldav-personal-event-create-v1'`.
Reserved version/baseline are null. It uses its own integer credential/source/
privacy/canonical generations and encrypted Basic credentials with empty scope.
Graph's null admitted ID and candidate/raw-version sidecars remain unchanged.

DAV-only acceptance-status columns retain 200/201/204 alongside strong-or-null
protocol acceptance. Later conditional success may advance the known response;
earlier attempt history survives, and a failed retry does not erase acceptance
or inherited uncertainty. Dispatch markers never clear. Graph's permanent
one-shot rule is not copied onto conditional DAV retries.

Under existing connection/object/binding/operation locks, completion checks the
live owned claim, source/credential/privacy/canonical epochs, exact immutable
URL/UID/plan/projection, recorded accepted-or-uncertain dispatch and strong
normalized readback. It atomically sets baseline/version/presence and ACKs.
Collisions, stale source, cancellation and waiting-lock abort roll back adoption.

Earlier Graph CREATE migration checks cannot narrow the later DAV profiles on
full replay. The final migration preserves all generation and immutable trigger
bodies, six old profiles, Graph unknown/adopted-null reservations and historical
values/epochs/OIDs. This is a forward-upgrade claim, not old-binary downgrade or
concurrent mixed-version rollout evidence. No resolution, supersession or general
predecessor-queue feature is added.

## Verification evidence

Fast scenarios run real codec/kernel/provider functions. Explicit data-only host
projection fixtures cover selected generic compatibility cases at the existing
normalization port and are labelled in reports; they do not claim execution of
the API normalizer. The paired API corpus exercises that actual normalizer.
Source checks, installed-image proof, final running-web confirmation and CI are
recorded separately when complete. Local fixtures do not establish live CalDAV,
external DNS/TLS, registry publication or production deployment. C07 requires a
final acceptance audit after its bounded provider slices merge.

The smallest CREATE loop is:

```sh
pnpm test:behavior --suite caldav-create --scenario fresh-create --json
pnpm test:behavior --suite caldav-create --json
```

| Source verification | Result |
| --- | --- |
| All seven fast behavior suites | 182 passed, zero failures/errors |
| CalDAV CREATE JSON / harness | 53 / 9 passed |
| CalDAV provider, including existing DELETE | 35 passed; 13 CREATE |
| Shared runtime kernel | 122 passed; 17 new CREATE |
| Actual paired API PostgreSQL/HTTP corpus | 192 passed |
| Reference pure / PostgreSQL storage / process-HTTP | 115 / 111 / 181 passed; new CREATE 15 / 14 / 42 |

The full reference corpus passed before the final projector regression; its
additional pure and process cases then passed in the final 15/14/42 CREATE rerun.
The independent review found an ambient timezone alias resolving to ICAL's UTC
singleton could bypass the resource-owned-zone check. A provider test reproduced
that defect before the fix. Explicit native TZID is now checked before the UTC
shortcut; provider, JSON and real reference-runner/process regressions cover the
refusal and retain valid embedded-zone behavior. API normalization is unchanged.

Workspace `pnpm test` passed after the fix with `ENVIRONMENT=test` and an inert
database URL, including all 122 kernel tests and the final CREATE harness.
Workspace typecheck, lint, release metadata, route/realtime contracts, peer
dependencies and query runtime checks passed. Final provider/reference focused
typechecks also cover the added regressions. The database suite inventory remains
part of the required CI checks; local proof does not bypass it.

The [installed API summary](evidence/MUSU-39-caldav-create/api-installed-summary.json)
records a frozen 840-file credential-free build context and 429 byte-equal
production TS/SQL files inside the local image. Its mount-free, nonroot process
applied all 86 migrations from an empty database, with the v1 encoder enabled
by default and no override. Seventeen actual HTTP checks cover public metadata,
unauthenticated refusal, real Better Auth signup/login/cookie session, canonical
calendar/event CRUD, idempotency, stale revision refusal and readback. This smoke
does not exercise installed native DAV delivery; the paired source corpus and
independent reference proof have their own scopes. No external account/target,
outbox delivery, SMTP or push was configured; owned container and nonce database
absence were verified afterward.

The [installed reference summary](evidence/MUSU-39-caldav-create/reference-installed-summary.json)
records a frozen 178-file context, 151 byte-equal installed source files (85
production), and the complete 30-package dependency closure without Musubi
database/auth/config/mobile packages. Twenty-two cases used 117 actual installed
CLI calls, 110 native fixture requests and seven Docker SIGKILL exits (137),
finishing in 86.883 seconds. The old Graph CREATE image and new DAV CREATE image
ran serially. All six older pending profiles delivered after upgrade; original
rows/payloads/epochs/receipts/history and 15 table/index OIDs survived, including
Graph unknown reservations and an adopted null validator. Repeated migration
also preserved reserved and adopted DAV rows.

Native installed cases cover full-ICS conditional PUT, known URL/UID adoption,
GET-only recovery after acceptance or lost reply, interrupted exact-404 replay,
status history and both directions of known-rejection/uncertainty recovery.
Weak readback, 410, known 412, changed UID/content, nested/unsupported components
and ambient timezone evidence cannot adopt. The test preload replaces only the
native HTTP leaf with a fixed owned loopback destination; persistence pauses
observe actual installed SQL COMMIT without changing writes or authority checks.
No production fixture hook or source mount is added. All 34 artifact hashes and
byte lengths across the two installed summaries were independently verified.

Final running-web confirmation used `frontend-testing-debugging` with regular
Playwright because the Browser plugin was unavailable. The flow was tasks route
→ open inspector → execute the same four JSON interaction scenarios → verify
saved content, retained conflict draft, read-only controls or cancelled deletion.
At `http://127.0.0.1:3000`, all eight cases passed on the first run in 14.5 seconds:
1280×900/light and 390×844/dark. Assertions verified route identity, meaningful
Tasks content, no page errors/framework overlay/horizontal overflow, and no
unexpected console errors (only the exact intentional HTTP 409 diagnostic).
Desktop saved-content and narrow conflict-draft screenshots were visually
inspected. UI HTTP fixtures do not prove real auth, database or DAV behavior;
those boundaries have the separate evidence above. No UI source changed.

```sh
pnpm test:behavior:browser --workers=2 --output=/tmp/musu39-caldav-create-final-browser
```

Temporary evidence: `/tmp/musu39-caldav-create-final-browser.log`,
`/tmp/musu39-caldav-create-final-browser/evidence-desktop.png` and
`/tmp/musu39-caldav-create-final-browser/evidence-narrow.png`. The test web server
port was verified absent afterward. Both nonce databases and their containers
were removed; the root-owned `musubi-dav-create-qa-20261025` PostgreSQL container
was then stopped and its absence verified. Local proof images remain local.
Neither these checks nor their OCI digests establish registry publication,
production rollout or live-provider acceptance.

The source slice still requires current-head CI and merge. Then C07 needs its
cross-family acceptance/rollout audit before checklist completion or C08 unlock;
this document does not close those gates.
