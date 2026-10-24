# MUSU-39 · Google personal CREATE

This C07 slice covers pinned-v1 personal, timed, nonrecurring Google events in
Musubi and the independent reference host. Graph/DAV, meetings/attendees,
recurrence/occurrences, all-day and specialized operations keep their existing
routes. C07 as a whole remains open.

## Admitted identity and immutable data

The CREATE profile uses the host's stable, canonical lowercase UUID
`operationId`. `commandId` still identifies a host command, `hostObjectId` the
canonical object and `attemptId` one lease attempt. Generic UPDATE/DELETE
operation IDs remain opaque; their contracts are not tightened.

Before any preparation, credentials, transport or renewal, CREATE validates:

```text
operationId == nativePlan.body.extendedProperties.private.musubiOperationID
"musubi" + operationId-without-hyphens
  == nativePlan.body.id == envelope.locator.resourceId == nativeTarget.eventId
```

Musubi's CREATE row may have `externalEventID=null` before adoption, while its
envelope already contains the planned native ID. The generic decoder's CREATE
binding rule remains unchanged. Logical provider account IDs and physical OAuth
row IDs stay deliberately distinct.

The existing `encodeEventV1` produces the saved full body and accepted projection.
The shared runtime decodes and deeply captures that plan, target, policy and
prior evidence synchronously before the first await. Retries never call the
current mapper or generate a new UUID. Both content and serialized field order
are retained. The provider also validates its own strict input boundary.

## Action-specific evidence and host policies

CREATE has separate provider read/acceptance types and completion ports.
UPDATE's strong-validator read and DELETE's absence evidence remain unchanged.

| Case | Musubi | Reference |
| --- | --- | --- |
| Fresh CREATE | Exact calendar ACL preflight, one POST, provider-response ACK | Same preflight/POST, then exact owned readback before ACK |
| POST returns missing/weak ETag with the correct ID | Preserve actual nullable validator | Readback must supply a real strong validator before adoption |
| Ambiguous POST response | Retain uncertainty; defer recovery to a later claim | Observe in the remaining attempt budget; no second POST in that attempt |
| Recovery finds matching ID, marker and complete accepted content | Adopt without POST; preserve nullable/empty notes/location equivalence | Require literal content, strong validator and accepted/uncertain dispatch evidence |
| Recovery returns exact 404 | Fresh authority/ACL guards may send the same saved ID/body | Same identity/body rule |
| 410, cancelled, wrong ID/marker or changed content | Conflict, no resend | Conflict, no resend |
| POST 400/409 | Existing rejected/not-written classification; no automatic GET/adoption | Retain rejection; no automatic adoption |
| POST 429 | Preserve Retry-After | Preserve Retry-After; a later 404 may permit the same-ID write |

A successful exact GET proves remote content, not provider acceptance of this
attempt. Prior accepted/rejected/uncertain facts remain independent. Reference
does not promote a known rejected CREATE directly into adoption in this slice;
it retains the observed evidence and HOLDs without resend. A fresh accepted POST
after a permitted 404 can complete normally.

One already-owned host claim enters one finite runtime lifecycle. It covers
prepare, session refresh, preflight, dispatch, observation, evidence and atomic
ACK. The host rechecks its authority and lease after credentials immediately
before mutation. Ignored cancellation cannot acquire a late HTTP/evidence/ACK
capability; a known committed atomic ACK remains authoritative.

## Host storage and authority

Musubi retains its existing source/grant/privacy/revision fences, retained
tombstone check, pull adoption and atomic outbox/mapping completion. An opted-in
real Google adapter selects the shared writer only for the supported admitted
profile. Legacy, custom unregistered and unsupported operations retain their
current route; a selected shared operation never falls back to a second writer.

Reference applies `schema-create.sql` after its existing schema/delete migrations.
It reserves a new binding with deterministic target identity and no fabricated
ETag/baseline. CREATE admission and the accepted immutable operation use the same
UUID. The canonical lifecycle must be active and the destination reserved.

`completeCreate` checks current generations, real strong readback, dispatch
evidence and live lease under the existing transaction/locks. It atomically
stores the confirmed projection/validator, changes reserved→present, increments
the binding source generation and ACKs. A subsequent UPDATE captures that new
generation. UPDATE/DELETE keep their present-destination/strong-validator gates.

History, scope occupancy, table identities, FKs and existing accepted payloads
survive migration. An absent binding after DELETE cannot become a new reservation.
The supported sequence is serial CREATE→UPDATE→DELETE after each prior ACK;
unresolved CREATE→DELETE, a general predecessor graph, discovery and pull/inbox
remain separate scopes. Reference cannot prove Musubi duplicate-import behavior.

## Verification evidence

Fast JSON scenarios execute the actual runtime and provider through synthetic
ports. Targeted unit tests additionally cover identity mismatches, snapshot
mutation, nullable validators, host policy differences, ignored signals, atomic
ACK races and capability-free shadow decisions.

Host acceptance uses owned loopback HTTP and isolated PostgreSQL data. Production
provider URLs are routed only inside the test harness, with logical response URLs
preserved; real redirect checks remain enabled. No live provider credentials or
production database are used. Process, installed-image and publication evidence
are recorded separately after they actually complete.

Source completion does not imply publication, production deployment, live Google
acceptance or completion of the remaining C07 provider families.

### Source and local acceptance — 24 October 2026

- Provider: 45 tests; shared runtime: 61 kernel tests including 14 CREATE cases.
  CREATE JSON: 12 scenarios and 5 harness regressions; root orchestrator: 15
  regressions. The aggregate fast command covers 21 scenarios including web UI.
- API: 68 actual PostgreSQL/HTTP CREATE cases, paired against the existing
  executor where applicable, plus real SIGKILL/restart fixtures. All 88 API unit
  scripts passed. Existing shared UPDATE/DELETE integration suites (14/55 cases)
  and adjacent admission, pinned transport and provider recovery suites passed.
- Reference: 15 CREATE pure, 14 CREATE PostgreSQL and 19 CREATE process/CLI cases.
  Existing 48 pure, 51 storage and 46 process cases also passed after migration.
- Whole-workspace typecheck, lint, route/realtime contracts and release metadata
  checks passed. The existing mobile lint warnings remain non-errors; web's
  required zero-warning lint passed. Required CI runs separately for the final PR.
- Final fast aggregate: 21/21 scenarios, zero errors, 4.087 seconds. After the
  installed API proof, the running web app replay passed all 8 desktop/light and
  narrow/dark cases in 14.4 seconds with synthetic API receipts. This web check
  confirms integration/layout; it does not substitute for the real HTTP/DB and
  provider-boundary evidence above.

Review added explicit meeting exclusion and regression tests for a mismatched
coherent all-day/recurring pinned plan against a timed host payload. The registered
nominal family now enters the kernel before full profile validation; invalid
data blocks with zero credentials/HTTP instead of selecting the old writer.
Genuine all-day/recurring host profiles keep their existing path. UUID/marker/
locator mismatches were already blocked by Musubi's unchanged DB decoder; new
host-level regressions confirm that existing floor.

Installed reference QA used the previous C07 image
`sha256:63340082526ecc11ce95d4165e8ae734a785e14050d586f5c9f681d68dc28404`
and new local image
`sha256:f019aa6b428f518c7b98c64747b3798161ea5aa161c08c1f8978aff33fd2eb28`.
All 91 installed TS/SQL files matched the frozen source; 57 runtime files have
manifest `d536988d9c91e9cd1e3819d6ee1c812569152e7f3d729641a35ffb7fe95f4d17`.
The 24-entry package inventory excludes Musubi DB/auth/config and mobile
frameworks. Three installed-image cases passed: old pending UPDATE through the
additive upgrade with unchanged table identities/payload, one lost CREATE reply
and killed container followed by GET-only adoption, and serial UPDATE/DELETE.
The CREATE case issued exactly one POST and preserved uncertain provider evidence.
See [reference summary](./evidence/MUSU-39-google-create/reference-installed-summary.json).

Installed API QA used new local image
`sha256:4c6a03696f27504c096f6cbd26ab281278c04ea43c53a7fdf1cc37ad98b652bc`.
All 401 production TS/SQL files matched the frozen and current source without
source mounts. An empty isolated database applied all 86 migrations through
`0085_graph_read_coverage`; startup and effective config confirmed encoder
default ON without an override. Seventeen real HTTP checks passed, including
unauthenticated rejection, real Better Auth signup/password login/cookie session,
calendar/event CRUD, idempotent replay and stale-revision rejection. There was
no auth bypass or direct user seeding. No external accounts/outbox targets,
SMTP or push were configured; this smoke does not prove a Google write.
See [API summary](./evidence/MUSU-39-google-create/api-installed-summary.json).

Both installed proofs used owned loopback fixtures/nonce databases. Their own
application containers and databases were removed. The image hashes describe
local Docker evidence, not a registry publication or production deployment.
