# MUSU-40 · Task compatibility lifecycle

Source implementation and native/process acceptance are complete; independent
review and installed evidence remain separate gates. This document records a
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
