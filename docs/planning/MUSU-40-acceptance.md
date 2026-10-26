# MUSU-40 · C08 implementation and local acceptance

Implementation and bounded source/local-installed/application acceptance are
complete at the reviewed d501 source, recorded on 26 October 2026. The publication
gate remains open: independent final evidence/tree approval, current-head PR
checks, squash merge and main verification. Registry publication and production
deployment have not occurred. The full core goal continues through C09 and C10
after C08; deployment remains the requested joint later step.

The literal roadmap gate is: “Převést task a stávající specialized event dispatch
orchestrace po rodinách. Gate: zachované home authority, original slots, provider
proof a no-resend RSVP/organizer policy.” Task slices are already recorded in main
through PRs #380–385. The remaining change extracts actual event orchestration
once into `@musubi/sync-runtime`, then makes a separate intentional Google RSVP
policy change. Historical extraction parity and that policy change have distinct
evidence. Shared host compatibility does not imply new portable provider support.

## Source identity and scope

The independently source/image-cleared head is
`d50152b569e47d3ce8ee90c6db1050db699a6f05`, tree
`bbab7fd1b1d90527e997a728b6c99667b06e5dce`. Its production fingerprint is
`f98fdd62c2ca13e43b0a2f3379053d825c83f4083868be70f906f3c2b9cd242f`
(364 files), and execution-harness fingerprint is
`219799bda4e2dca87ec083888b18927708ff3f20d6b978ab23b596fcbd333089`
(173 files). The exact source gate and later image/context bindings are indexed
in [source-summary.json](evidence/MUSU-40-event-compatibility/source-summary.json). This source/image clearance does
not stand in for final PR acceptance. Later documentation-only commits do not
change the actual image-build source identities reported here.

The normal canonical workspace check passed at combined head `06d08da`; its
production bytes equal the integrated Google barrier source and current approved
production. All 556 JSON cases in thirteen suites passed with zero failures or
errors in 9,912 ms. The later bounded clock-input addendum has separate actual
manifest20 and existing API type-check receipts. Current-head CI remains a later
gate. This audit ran no application, source tests, network, database, or container
commands: its collector reads and hashes completed reports and raw artifacts.

The shared runner owns one bounded attempt/heartbeat and lifecycle ordering.
The API retains authoritative claims, source/privacy/grant checks, native
parsers/serializers and SQL transactions. Prepared/native data are independently
owned without evaluating accessors; Dates, milliseconds, undefined values and
legacy rich content remain intact. Portable selection keeps precedence, and
malformed selected pinned data HOLDs rather than selecting a compatibility
fallback. Extraction does not force retained-v0 input through a v1 encoder.

The actual first-match specialized order remains:
`graphOccurrenceContent`, `graphMeetingCancellation`, `organizer`,
`reminderInstance`, `graphSeriesDeletion`, `graphSeriesCreate`, `caldavAlarm`,
`caldavSplit`, `caldavSeriesDeletion`, `caldavSeries`, `googleOccurrence`, `rsvp`,
`reminderEdit`. Generic leftovers retain Google/Graph/DAV CREATE/UPDATE/DELETE
and their existing legacy/all-day inputs. Known event-time metadata still
refuses before generic adapter preflight, including DELETE. Top-level `timeEdit`
and `graphOccurrence` remain reserved selection/admission guard keys; they are
not new implemented writer families. Real Graph content uses
`graphOccurrenceContent`, while Graph RSVP has its own nested occurrence input.

## Portable and host compatibility boundaries

The independent reference host actually supports these ten endpoint profiles:

| Object/provider | Supported actions | Boundary |
| --- | --- | --- |
| Google personal event | CREATE, UPDATE, DELETE | Existing bounded personal timed/nonrecurring profiles; deterministic CREATE ID and strong-validator UPDATE/DELETE |
| Microsoft personal event | CREATE, DELETE | Existing one-shot CREATE and guarded-preflight DELETE; native weak validator does not establish CAS |
| CalDAV personal event | CREATE, DELETE | Existing URL/UID and strong conditional resource profiles |
| Google task | CREATE, UPDATE, DELETE | Existing task profiles and separate durable causal-intent queue |

There is no portable generic Microsoft or CalDAV UPDATE profile in this matrix.
Specialized event families, VTODO lifecycle, To Do lifecycle, and retained-v0
Google inputs share lifecycle through host/native ports. They retain their
existing capability limits. No task hierarchy/reorder/move, new recurring task
write support, new meeting scope, unsupported time model, or To Do conditional
CAS is inferred from another provider’s tests.

Task evidence retains home authority, secondary echo/deletion behavior, richer
canonical values and exact milliseconds despite native precision loss. Existing
home recurrence remains permitted where it was already permitted; secondary
non-delete recurrence and secondary To Do live writes retain their refusals.
Paired predecessor ID/tag/baseline and the original NULL admitted addresses
remain authoritative. Missing-address legacy DELETE can acknowledge local
absence under its existing policy. The task ACK gate retains its own proven
lease/ref CAS, cancellation and rollback guarantees.

Event source/native evidence covers these actual host scopes:

| Family | Retained authority/proof |
| --- | --- |
| Google reminders and instance reminders | Defaults/off/custom limits, exact stored original slot, unrelated content preserved |
| Google personal occurrence | Generated/stored zoned or all-day slot, original master and cancellation/edit boundaries |
| DAV alarms | Eligible simple DISPLAY alarm and complete resource preservation |
| DAV series/resource | Occurrence update/restore, RDATE/EXDATE/rule/date/time/conversion, following-delete truncation and narrow iCloud personal-content eligibility |
| DAV whole-resource deletion and following split | Original URL/UID/resource and strong tags; first-slot whole-deletion delegation; journaled two-step split without blind uncertain replay |
| Graph family CREATE/adoption | Bounded family, correlation and complete family ACK; failed family ACK does not invent a master-only result reference |
| Graph family deletion | Tracked family/survivor proof and observe-only uncertain recovery |
| Graph occurrence/series content/time | Original slots, exceptions/cancellations and existing personal/organizer representation limits |
| Graph move coordinator | At most twenty unique children ordered by original start; one admitted child per tick, stopped journal remains stopped after late ACK; coordinator sends no provider mutation |
| Organizer Google/Graph/DAV | Durable possible-notification marker, native acceptance and remote confirmation separated from unknown notification delivery; no uncertain resend |
| Graph recurring meeting cancellation | Existing finite family/occurrence scopes and guarded profile; no new CAS claim |
| RSVP Google/Graph/DAV | Actor/baseline/original-slot/family checks; Graph/DAV permanent observe-only markers; Google barrier described below |

The generic PG-stub fixture has 26 observations and zero native requests. The
separate actual generic-native fixture has eighteen observations and 78 native
requests across all three providers/actions, including timed and legacy all-day
inputs. Fixture-only encoder OFF forces retained-v0 coverage; it is not a product
default change. The canonical installed application separately confirms encoder
default ON without an override.

## Historical extraction and comparison evidence

[historical-parity-summary.json](evidence/MUSU-40-event-compatibility/historical-parity-summary.json) verifies the
completed **twenty old/new pairs**, forty raw receipts and their saved normalized
whole-wire/full-state equality. Per label there are 1,168 delivery observations,
13,058 logical native requests and 7,588 actual loopback relay requests. The old
executor is the immutable `8ea0d3b` production source, SHA
`63f478c91e36db4913717db759e773d260e928cc530dd0c8696112b5e39ae8b0`.
The extracted production fingerprint is `fe4464…568ea` throughout.

This is a composite with three actual execution cohorts, not one uniform run:

| Actual source head | Actual harness | Programs |
| --- | --- | --- |
| `4001d606` | `1f6e84ce…` | Generic, generic-native, Google reminders, instance reminders, occurrence and DAV resource: six |
| `aecb2c55` | `e5878744…` | DAV alarms, three organizer providers, Google RSVP/recovery, Graph RSVP and DAV RSVP: eight |
| `e6c2c308` | `0a5100df…` | Graph CREATE/DELETE/content/series-content/meeting-cancel/move: six |

Graph CREATE controls the native reader’s existing
`fetchMicrosoftChanges.options.now` argument for its nineteen rolling read
windows. In this controlled-input profile, on-disk production/fixture source and
native instance content remain unchanged; the archived executed adapter module
contains only the proven `options.now` insertion. It must not be presented as
default wall-clock parity. The current
strict policy also has a separate default-clock twenty-program source run at
`06d08da`/harness `fbb3df69…`, with 1,168 observations and 13,056 native requests;
its production fingerprint equals current `f98fdd62…`.

The separate pre-policy new-only twenty-program run and sixteen streaming
old/new process pairs retain their actual `4001d606`/`1f6e84ce…` identity. The
process evidence contains 32 actual SIGKILL executor processes and 32 recovery
executor processes. It verifies the complete twelve-relation snapshot after the
kill equals the checkpoint before dead-lease expiry. At raw-response cuts the
actual transport sent headers and zero body chunks. Older fully buffered cuts
are characterization only. These observations are not additional twenty-program
cases and are not relabelled as the newer Google policy or installed image.

Comparison exceptions require raw production witnesses first. Actual Graph
version hashes are rebuilt from their exact raw family input before the derived
comparison changes rooted host clocks. Alarm versions prove the complete raw
seven-element tuple, including full before-ICS, before normalizing only the
receipt-owned resource origin; copied resolution versions must equal the same
operation’s raw witness. Generated DAV DTSTAMP comparison is limited to an
actual serializer-rebuilt, operation/URL/UID-owned component and exact resource
bytes; foreign siblings, native metadata, unknown properties and native content
are never blanked. The sole bounded unordered deletion-echo comparison requires
the complete admitted owned set, actual successful COMMIT ledger, paired exact
last committed raw snapshot and every member’s original slot/ID/tag. Atomic MVCC
snapshots and observation drains precede fixture cleanup. These are evidence
comparison rules; they do not change production dispatch policy.

Prior failed fixture/harness attempts remain preserved and excluded from passed
totals. The historical v1 normalization self-snapshot was overwritten by a
reviewer replay and its exact original bytes are unrecoverable. Its original
receipt, log and probe remain retained; the overwritten source is explicitly
excluded from historically verified artifact totals. No replacement bytes are
represented as that source.

## Installed API and independent reference evidence

[api-installed-summary.json](evidence/MUSU-40-event-compatibility/api-installed-summary.json) binds the completed
installed controller and its final successful launcher/cleanup receipt to API
image index `sha256:4b93de02…f375`, platform `sha256:64b3d033…e149`, config
`sha256:59fb4071…693b`. The d501 COPY context contains 922 files; 691 unique
production/test source hashes were verified.

The actual installed twenty-program new-only full controller passed with 1,168
observations, 13,056 logical native requests and 7,586 loopback relay requests.
It uses approved harness `219799bd…`, including the declared controlled Graph
clock input. The unchanged retained task33, pinned transport and Google58
programs also passed. Google58 includes five actual installed-child
SIGKILL/restart checkpoints. The controller uses a byte-identical API copy from
read-only `/app`, installed workspace modules, and a separate read-only compiler
tool mount; no host product source or new product dependency is supplied.
Before/after API/workspace/migration/compiler checks passed. Its two test mounts
are recorded, and its exact owned role has zero sessions before plain database
drop; the role and container are verified absent.

The separate canonical production-layout application proof runs the immutable
image at unchanged `/app` with **zero mounts**. It passed seventeen real HTTP
checks, including real signup, password login and cookie session without bypass,
canonical event CAS/stale refusal, and 86 empty-database migrations. There were
zero configured external provider accounts. Encoder default ON was observed
without an override. Cleanup verifies the owned container and nonce DB absent.
This is actual application/authentication evidence; it is not live-provider
delivery certification or the final browser flow.

[reference-installed-summary.json](evidence/MUSU-40-event-compatibility/reference-installed-summary.json) binds the
independent reference image index `sha256:74f3770e…498f`, platform
`sha256:8b7d7886…8984`, config `sha256:dcace294…107a`. It was built from source
`06d08da`/tree `ee9e4ddb`; all 261 COPY paths are independently equal to approved
current d501 source and the frozen context fingerprint `55899829…1cac`.
Attestation verifies 230 files, including 128 production files, thirty named
packages, and zero forbidden Musubi DB/auth/config, Better Auth, mobile or
TypeScript packages. The runtime is non-root/read-only with zero source mounts.

The installed reference corpus actually passed 161 pure cases, 207 storage cases
and 287 native/process cases. Its separate seventeen-case old-to-new/custom
upgrade proof executed 219 installed CLI invocations and 166 fixture HTTP
requests across the existing ten endpoint profiles and causal queue. Eleven old
pending operations, 28 original relation/index OIDs and five existing queue
relations are preserved; no endpoint profile is added. Full populated migration
repeats and task response/absence/uncertainty/rich-content facts are checked.
Both reference cleanup reports and the final verification verify owned nonce
removal without FORCE and absence of owned workers. The first final-verification
tool attempt failed because it used an obsolete historical source-root literal;
the versioned active-v2 tool corrected only that literal to canonical root and
passed the same checks. The failed log is retained separately. These counts are
different units and must not be
combined into a fabricated provider-request or parity-case total.

The independent [evidence review](evidence/MUSU-40-event-compatibility/independent-review-summary.json) verifies the
actual OCI index/platform/config chains, all archive blob hashes and installed
source equality. Its raw review covers 704 bound artifacts; its final V6/reference
addendum covers 55. These are separately scoped review inventories, not additive
test-case or unique-artifact totals. The reviews did not rerun containers, DB
queries, providers or application flows and do not grant final PR approval.

## Final running application and browser

The final [browser report](evidence/MUSU-40-event-compatibility/browser-summary.json) passed 22 of 22 existing
Playwright cases on the first attempt in 38.6 seconds, at source d501. It covers
task draft/conflict/read-only/cancel behavior, Google/Graph/DAV RSVP retry,
reminder/alarm conflict confirmation, organizer update and partial/stopped
occurrence moves. The browser plugin was unavailable, so the existing repository
Playwright Chromium setup was used. HTTP/API fixtures establish UI behavior;
the independent authentication, SQL and native evidence above establish their
respective boundaries.

Root visually inspected four screenshots: a 1280×900 light task draft, a 390×844
dark task draft, and 390×900 dark RSVP/move views. The reported rendered controls,
draft preservation, retry IDs/request bodies and partial results passed; no
unexpected console/page error, framework overlay or task horizontal overflow
was observed. Document title was not explicitly asserted. No UI code changed.
The committed report retains screenshot hashes and local artifact paths; PNGs
and large archives are not included in this evidence packet.

Browser execution followed the recorded [root QA retirement](evidence/MUSU-40-event-compatibility/root-qa-retirement.json):
only the default `postgres` DB remained, there were zero other client sessions,
and the owned QA server/container was removed. The user QA service on port 55437
was left untouched. This is local application evidence, separate from PR checks,
registry publication and production deployment.

## Mandatory Google policy and retained capability floor

Extraction alone preserved the old Google RSVP behavior: desired-state GET could
confirm, otherwise exact full-baseline equality permitted another original
If-Match PATCH even on reconciliation. The separately accepted policy change
introduces a strict private versioned sidecar and one durable permission marker
before PATCH. Markerless legacy rows, including never-dispatched pending rows,
are conservatively GET-only HOLD. Same-intent manual retry cannot reset consumed
permission or grant permission to an old markerless row. An explicit new
resolution operation may receive a fresh sidecar after fresh baseline/source/
actor guards; it is a new admitted operation, not a permission reset on the old
row. Recovery of the original uncertain operation remains read-only.
Claim/source/grant/privacy/revision/lease checks and cancellation of
the marker transaction have their own actual source/PG/native/process evidence.
Native HTTP acceptance, confirmed desired state, and unknown notification
delivery remain distinct facts.

The separate installed old-pending queue upgrade now has its own successful V6
result and cleanup receipt in
[google-installed-upgrade-summary.json](evidence/MUSU-40-event-compatibility/google-installed-upgrade-summary.json).
The old image `sha256:8a71cd3e…9b15c` made four real admissions, with three actual
attempts and three PATCH requests, then stopped completely before the new d501
image ran. The new reader made twenty GETs and zero mutations. Three legacy
cases remained HOLD/unconfirmed across six manual retries; the already-desired
case completed. Complete original payloads and native resources are retained,
no private Google send permission was synthesized, and notification delivery
remains unknown. Both installed source inventories remain unchanged; the nonce
database has zero sessions before plain DROP, with container/server/admin
cleanup verified.

After each delivery/retry, the exact source-bound worker calls production
`getEventSnapshot` and deep-compares the complete canonical value, including
timestamps, with the original. Saved raw cases emit the original canonical
only. Canonical-after retention therefore has successful actual-worker
assertion evidence; it is not an independently emitted after-canonical snapshot.

V4 failed in Docker stdin plumbing before admission; V5 failed old-image
admission because Better Auth received its default secret. Their failed results
and verified cleanup are retained and excluded from successful totals. V6 changes
only explicit synthetic auth configuration in reviewed test tools; its 65 pure
tool checks and exact image/tree execution approval are separately pinned. This
is a bounded sequential old-to-new upgrade proof. Older Google RSVP binaries do
not understand the sidecar. This audit promises neither universal binary
rollback nor an unproved mixed old/new rollout; the final compatibility packet
must state supported readers and concrete downgrade/drain conditions.

The legacy/specialized event ACK APIs retain their existing capability floor.
An attempt guard before entering completion does not prove cancellation rollback
while an already entered SQL pool/lock wait is underway. Existing claim/source/
privacy/lease/DB-clock fences and committed-ACK authority remain host policy.
Task ACK and the bounded C06 portable Google route keep their own stronger tested
signal/rollback guarantees. Those guarantees are not borrowed for every legacy
host event family. This retained limitation is separate from the mandatory
Google RSVP no-resend policy.

## Remaining gates

The exact raw-report hashes and versioned FS-only accounting are in
[raw-artifact-manifest.json](evidence/MUSU-40-event-compatibility/raw-artifact-manifest.json). The earlier 261-artifact
accounting is retained, with final browser/QA-retirement and independent-review
receipts added by hash. [pending-gates.json](evidence/MUSU-40-event-compatibility/pending-gates.json) records the
deliberately open items:

1. Independent final audit, compatibility packet and exact final tree approval.
2. PR publication, all required current-head checks, squash merge and main-tree
   verification by root.

C08 publication/main verification, production deployment, registry publication
and completion of the full C01–C10 objective are not claimed. C09 fair scheduling/provider budgets
and C10 reproducible standalone alpha/conformance remain subsequent core work;
the requested joint production deployment is a separate later step.
