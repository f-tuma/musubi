# MUSU-40 · Task compatibility lifecycle

Source implementation, native/process acceptance, independent source review,
installed upgrade/crash proof and final running-app checks are complete. Final
PR approval and current-head CI remain separate gates. This document records a
host-only extraction, not deployment evidence or a new portable provider profile.

`runClaimedTaskCompatibility` in `packages/sync-runtime` owns the remaining
claimed task lifecycle once. The API keeps claim/decode, source and privacy
checks, paired predecessor queries, native parsers/writers and atomic mapping
ACK/finish transactions. Existing portable Google CREATE/UPDATE/DELETE kernels
are selected first. A selected malformed pinned operation is blocked before any
compatibility preparation; it is never reinterpreted as v0.

Preparation returns `blocked`, `not-needed` or `ready`. Ready data identifies
the original decoded claim, home/secondary authority, a host-only Google
predecessor CREATE, Google task, To Do home/refusal or VTODO resource family,
pinned-v1/retained-v0 representation, paired historical reference/baseline,
immutable native target/saved mask, current dispatch permission and response-only
or deterministic task-UUID recovery address policy. The whole prepared value is
snapshotted before native I/O using own data descriptors; callbacks/accessors are
refused without running them, and canonical Dates retain their milliseconds.
Native calls receive separate task copies. Retained v0 recurrence,
oversize content and unproven DAV UID inputs never pass through `encodeTaskV1`.

The runner preserves initial read → save mask → achieved recovery → dispatch
permission → original pair check → native preflight → empty-mask ACK → existing
writer → saved-mask readback. Reconciling CREATE performs exact full-target
read-only recovery first. A missing Google/To Do response address remains HOLD;
DAV can observe its existing deterministic task-UUID URL/UID. Initial DELETE
absence can ACK without a native mutation.

One runtime attempt owns the deadline and lease heartbeat. Native writer return
and possible dispatch are separate facts. In particular, a void DELETE writer
may fulfill after proving absence without dispatch; fulfillment does not claim
HTTP acceptance. The existing API persists response references only after the
whole native writer fulfills. ACK still receives the active signal and paired
expected mapping; its lease/source/privacy/CAS/rollback transaction stays in DB.

Home recurrence, richer canonical fields and exact canonical milliseconds stay
in the task snapshot. Native projections retain their existing precision and
losses. Secondary non-delete recurrence remains refused; To Do secondary writes
remain refused by the existing adapter. This extraction adds neither To Do CAS
nor a second native implementation.

Pure evidence uses the existing real `task-delivery` JSON driver plus direct
runtime tests. All 59 JSON scenarios (including the unchanged original 19), 15
fail-closed harness checks and 14 compatibility runtime tests pass. Existing
portable Google task unit gates, runtime typecheck and API source typecheck also
pass. JSON provider/profile fixtures exercise actual `deliverTaskOutbox` with
dependency ports; they do not prove SQL, authentication or real provider behavior.

Source PostgreSQL evidence on 26 October 2026 preserves all six existing task
delivery, ACK, released-task compatibility, pinned transport, optional task and
Microsoft task-read gates. ACK includes four actual transaction cases; Microsoft
read completeness includes 42 cases. Each nonce database had zero remaining
sessions before DROP without FORCE.

The historical differential loads the actual production executor at `a143002`
(task delivery source SHA256
`5267f74c671d7ab0a66a5a5c4de9d56b731d71f6ffd9f439ac5c12769c5b90bd`),
then runs the old and extracted production executors with the same actual
Google/To Do/VTODO adapters, nonce PostgreSQL and closed loopback HTTP. All 33
paired native cases compare methods, URLs, headers, complete bodies/resources,
outbox/mapping snapshots and exact canonical milliseconds. All 24 paired
SIGKILL/restart cases distinguish raw native response, complete awaited writer
return before readback, observed readback before ACK and actual ACK COMMIT.
Unaddressed Google/To Do CREATE remains HOLD after process loss; deterministic
VTODO recovery and committed ACK remain authoritative. No uncertain mutation is
replayed. All owned pools close and nonce databases drop without FORCE.

`pnpm test:db:task-compatibility` runs the deterministic new-only native gate in
CI with independent expected wire/status/mapping/canonical assertions; it needs
no historical Git objects. Explicit historical acceptance uses
`MUSUBI_TASK_COMPATIBILITY_MODE=differential MUSUBI_TASK_COMPATIBILITY_QA=1`
with the same test entry. It fails if the requested baseline is unavailable and
also runs the process cases. Installed browser/upgrade evidence, publication and
production deployment remain separate.


## Frozen source and workspace checks

After causal PR #384 merged as `c42fe4c`, the compatibility branch was rebased
onto that verified main. Independent skeptical review gave SOURCE APPROVE +
IMAGE CLEAR for head `8ea0d3bfe193abd701e06c15d19b5d312bdd2290`, tree
`440029cb442eab552c595f27b70c623333627a79`. Sixteen reviewed files stayed
byte-identical to the original 17-file source manifest; the only rebase
resolution updated the inventory's causal status to Main, PR #384.

Root then verified all 426 scenarios in eleven JSON suites, 34 runner/inventory
checks and the entire `ENVIRONMENT=test pnpm check`: release metadata, contracts,
peers, query runtime, workspace types, unit tests, lint and registered builds.
The registered workspace build passed its web and docs tasks from Turbo cache; the API and
reference production closures have their separate installed-image evidence.

CI inventory contains 141 DB suites exactly once. Existing timing import
provenance now points to successful causal Quality run `40319133795` at head
`451f79f`: 140 measured suites and the new suite's existing 15-second fallback.
The four planned partitions are 396992/397613/397697/396945 ms. No workflow,
required check, assertion or timeout is disabled or increased.

The compatibility scope also includes all retained-v0 Google task actions,
home recurrence and native values outside pinned-v1 admission limits. The
unchanged selector may use existing host writers when a portable adapter is
unavailable. A missing-address legacy DELETE can confirm local absence; this
is not a native GET404 or proof of provider acceptance. These profiles stay
explicit in the family inventory.


## Installed API and reference closure

[API summary](evidence/MUSU-40-task-compatibility/api-installed-summary.json)
proves all899 approved/current/frozen COPY paths and495 unique installed
source paths:458 production/support entries comprise456 production sources
and two behavior helpers;39 test/behavior entries overlap in two paths. The
image runs as node without source mounts or external accounts. Empty startup
applied86 migrations with the default encoder ON and no override;17 actual
Better Auth/signup/login/cookie-session and canonical CRUD assertions passed
with the standard Origin. Fifteen installed suites passed385 numbered cases
(33new compatibility,352retained) plus six unnumbered retained gates.

The installed API crash proof compares24 checkpoint pairs: Google/To Do/VTODO
CREATE and UPDATE at raw response, full writer return, observed readback and
actual ACK COMMIT. Each pair kills the old causal image and recovers in the new
image, then compares with new→new recovery. There are96 actual Docker worker
commands and48 SIGKILL exit137 receipts. Exact wire, native mutation count,
outbox/mapping and rich canonical state agree; no uncertain mutation is replayed.
An inherited empty Git-baseline placeholder in raw fixture output is explicitly
disclosed; actual old/new image identities and command receipts establish this
installed proof. It does not reuse the source Git differential as its baseline.

API index is `sha256:8a71cd3e00317a43ebdbb905b8ed678e91a2a1a6de8d3c004172272a56d9b15c`,
manifest `sha256:cab0f747f13b2c9459aaeb2cc035db572e50644ab74a996c527500302a233c42`,
config `sha256:bf8c4111d665b1110f8c5a07bfcc8e5c36c5e57f10bb11e155a1487d21a864e1`.

[Reference summary](evidence/MUSU-40-task-compatibility/reference-installed-summary.json)
is a package-closure regression, not a new To Do/VTODO portable implementation.
All257 context,226 TS/SQL and125 production sources match;30 named dependencies
contain no host-only closure. The final serial installed corpus passed161pure,
207storage and287native-process cases with command exit0. Seventeen separate
upgrade probes used219 actual CLI commands,166 native fixture requests and
seven container SIGKILLs. Ten old profiles,11pending operations, exact rows,
history/epochs and all33 existing OIDs (28original+five queue relations) survive
upgrade and repeated populated migration. No new reference profile or schema
is introduced.

Reference index is `sha256:a7817d7854db0cf88df7a53ca6983fa05ba01702496ab0f9f4a0e64ca2b3a995`,
manifest `sha256:9adaf703f16c6e64fae9061042345b5c6f12ddec40251e02db966c7c493edadc`,
config `sha256:85aecbff98c3625cfe40c11c1eeace00b5ca7ccb1ab6d78186c42b0ffcd86f90`.

Independent layer review streamed every OCI blob, descriptor/config chain and
uncompressed diffID from API14, reference12 and old-reference12 blobs. Direct
overlay bytes and symlink/hardlink resolution confirm API495, reference226 and
old-reference221 source paths. Both old/new archives remain available. Root
rehashes40 source,152 API and634 reference artifact pairs, the separate reference
manifest, five browser/cleanup receipts and the independent OCI review receipt.

Prior harness failures remain disclosed: an initial successful17HTTP smoke
exited during delayed session cleanup and was fully rerun; the first reference
corpus completed all tests but its global nonce inventory saw a concurrent own
upgrade probe, so the entire corpus was repeated serially. Final commands and
all cleanup checks passed. No production assertion or authority guard was relaxed.

## Final application and remaining C08 work

[Browser summary](evidence/MUSU-40-task-compatibility/browser-summary.json)
records8/8 first-attempt passes in14.0seconds through the running web app, with
desktop1280×900/light and narrow390×844/dark. Both screenshots were visually
inspected: readable inspector, no clipping/overlay or unexpected page/console
error; only the expected conflict409 is allowed. Editing preserves richer
content, conflict keeps the draft, mirrors remain read-only and canceled DELETE
sends no mutation. The runner verifies route and Tasks region; it does not
explicitly assert document title. Fixtures do not establish real auth/DB/provider
behavior, which has separate installed/native evidence above.

All task-owned containers and nonce DBs were removed; shared port55443 was absent
in two polls before the browser run at12:37UTC. User QA identity/ports remained
unchanged. Later event QA belongs to the subsequent slice.

C08 remains open for specialized/generic event extraction, Graph move parity,
a dedicated Google RSVP permanent recovery barrier and final cross-family audit.
The independent audit found that the old Google RSVP writer may send another
conditional PATCH after an unapplied503 if the baseline remains unchanged. The
event parity extraction must characterize that actual behavior, not claim an
already-satisfied blanket no-resend policy. This gap requires a separate tested
policy fix before C08 can close. No registry publication, live-provider
certification or production deployment occurred.
