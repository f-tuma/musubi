# MUSU-39 · Graph personal CREATE

This C07 slice shares an already-claimed Microsoft Graph personal, timed,
nonrecurring CREATE between Musubi and the independent reference host. The
admitted codec body and UUID `transactionId` are immutable. Graph assigns the
resource ID; the admitted locator remains null. Returned identity, native
acceptance, correlated observation and atomic host adoption are separate facts.

Microsoft describes `transactionId` as client correlation for retrying CREATE
and makes it immutable after creation; event IDs are read-only server values.
The reviewed documentation does not establish a deduplication lifetime,
transactionId-specific filter support, listing snapshot isolation or CREATE CAS.
This implementation does not infer those guarantees.
[Event resource](https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0).
The documented normal CREATE result is 201 plus an event body; preserving
Musubi's existing broader accepted-status behavior is a compatibility choice.
[Create event](https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0).

## Admission and native identity

The existing `microsoft-personal-event@1` codec remains unchanged. The kernel
checks the full admitted operation, row binding, allowed side effects, exact
saved body/projection, canonical operation UUID, `transactionId` equality and
explicit null resource locator before preparation, credentials or transport.
Physical OAuth identity remains distinct from the logical host account.

The selected profile excludes all-day, recurrence, meetings, explicit modeled-time
writes and specialized operations. Genuine unsupported host families retain their existing route.
Nominal registered malformed CREATEs cannot fall back to another writer.
There is no per-attempt regenerated ID, transaction ID, serializer or body.

A candidate ID learned from a POST response or a confirmed unique correlation
is captured separately. Once durable, it stays pinned across restart, even when
the provider fact remains uncertain. A later unique marker on another native ID
cannot replace it. Learning an ID from observation never manufactures a received
acceptance response.

## Explicit native profiles

| Boundary | Musubi `existing-microsoft` | Reference `strict-reference` |
| --- | --- | --- |
| Fresh preflight | Original calendar `?$select=canEdit`, any successful 2xx JSON with `canEdit===true`; default redirect following | Exact `/me` identity and exact owned editable calendar; complete nonredirected 200 reads |
| Fresh write | One POST of the exact admitted body; raw returned ID/version then host ACK | Same native POST, then complete scoped correlation readback before host adoption |
| Fresh response version | Any string, including empty or nonconditional values, or null; no extra read/normalization | Preserve raw acceptance separately; confirmation/adoption accepts the native weak-version predicate or null |
| Recovery select | Original fields and UTC preference | Additional personal-event fields and explicit text-body preference |
| Recovery personal shape | Original cancellation/recurrence and actual host normalization floor | Complete personal single-instance, no attendees/meeting/removed/draft state |
| Possible-acceptance recovery | Complete scoped listing; unique marker plus matching actual normalized projection may adopt | Same unique complete correlation, strict native profile and pinned candidate |
| Known not-written retry | Existing host policy may retry with fresh guards when no inherited uncertainty | Permanent durable dispatch marker prevents another POST, including after known 429 |

Musubi's fresh preflight does not add Graph DELETE's `/me`, owner, calendar-ID,
exact final URL or strict 200 rules. Native automatic redirects remain one
observed fetch result, matching its existing metrics boundary. POST and recovery
listing retain `redirect:error`. The reference's stronger read guards are an
explicit separate profile rather than a claim about existing Musubi behavior.

POST accepts the existing 200/201/204 statuses only when the JSON response has a
nonempty string ID. Missing/malformed success identity, unexpected successful
statuses, network errors and 5xx remain ambiguous. Other native refusals retain
the existing not-written classification, including 408, 409 and 429; 412 remains
conflict. Raw parser/normalizer failures preserve their host-local causes and
do not expose provider text in protocol metadata.

## Correlation and recovery

Recovery traverses every validated nextLink in the exact captured calendar,
rejects loops/foreign paths and caps traversal at 1,000 pages. A matching candidate
is owned before a later page await. Duplicates or an incomplete traversal cannot
confirm a candidate. Zero matches is `create-outcome-unknown`, not resource
absence and not authority for a repeat POST. Neither 404 nor 410 grants replay.
Following nextLink until it disappears is the documented complete-pagination
mechanism; it does not imply an atomic remote snapshot.
[Microsoft Graph paging](https://learn.microsoft.com/en-us/graph/paging).

The strict reference requests `outlook.body-content-type="text"` alongside UTC,
so its text projection does not depend on Graph's default HTML representation.
The existing Musubi preference and response handling remain unchanged.
[Get event request headers](https://learn.microsoft.com/en-us/graph/api/event-get?view=graph-rest-1.0).
ETag is read as the response annotation; it is not selected as an entity property.

Musubi recovery invokes the actual existing native normalizer before comparison.
The legacy and shared paths use the same helper for cancellation, recurrence,
dates, title, body and location handling. Trimming and Graph fractional-second
normalization remain actual host behavior. A malformed subject may become a
saved conflict; malformed body/location parser errors retain their raw failure
floor. Fresh ID-only success skips normalization, as before.

At most one logical CREATE invocation occurs in one attempt. Reference may
observe within its remaining budget after a lost reply; Musubi defers that
observation to a later claim. Neither host blindly repeats after unresolved
possible acceptance. Known not-written API retry policy is distinct from
reference's stricter one-shot durable marker. Inherited uncertainty is sticky.

## Host authority and independent storage

Musubi keeps the owned physical OAuth session, current incarnation and grant
checks around refresh. It retains source/privacy, revision/predecessor coverage,
retained deletion/pull, scope occupancy, live lease and atomic mapping/ACK rules.
Possible acceptance does not authorize a stale source or overwrite independently
pulled content. Attempt bounds fence ignored signals in preparation, credentials,
native HTTP, normalization, evidence and waiting transactions. A known committed
ACK is not replaced by a later timeout/finish. Private replay uses saved facts
only, without credential, network or storage capabilities.

Musubi also retains its old conservative CREATE boundary before the second
credential lookup: a failed refresh at that point can leave host uncertainty
true while native `possibleDispatch` remains false. That host flag is not a claim
that POST was sent, and conclusive native not-written statuses still retain their
retry policy. Paired tests found that the old executor could send after scope or
incarnation changed during this second refresh, only rejecting its eventual ACK.
The shared path now stops before that POST with current owned-session/grant
checks. This safer zero-POST difference is explicit; no legacy response or
returned ID is fabricated to make the two wires appear identical.

Reference adds a forward migration with immutable `create_profile` on bindings.
Only a Graph CREATE reservation has unknown/null binding resource ID; the admitted
operation's resource ID (`event_id`/locator) stays null permanently, including after adoption. Google keeps its
deterministic reserved ID and strong rules. Nonreserved bindings still require
a native ID and baseline; a Graph-created binding may retain a weak/null version.

Operations and attempts separately retain candidate ID, native acceptance status
and raw acceptance version. Raw version strings use JSON-string encoding in a
text column, so empty, NUL and unpaired UTF-16 values roundtrip without becoming
conditional validators or invalid protocol receipts. Native null stays SQL NULL.
Candidate identity and a known acceptance tuple are monotonic. An abandoned
attempt may retain its own evidence but cannot replace a successor's operation
candidate. The original admitted payload, epochs and locator are never rewritten.

Under the existing connection/object/binding/operation lock order, adoption
checks ownership/current epochs, original null locator/UUID/body/projection,
durable candidate identity and matching unique correlated readback. It atomically
sets binding ID/version/baseline/presence and ACKs. Scope collisions, stale
authority, cancellation or changed candidate roll back all provisional writes.
An uncertain POST can be adopted after confirmation without inventing acceptance.

Earlier CREATE and CalDAV migration steps stop reinstalling narrower checks
before the final migration. Existing Google/Graph DELETE/DAV operations, payloads,
epochs, receipts, history and table identities must survive forward upgrade and
repeated migration with populated Graph CREATE rows. This is not an old-binary
downgrade or concurrent mixed-version rollout guarantee.

Dedicated Graph CREATE seed/admission commands preserve the same pending barrier.
This slice adds no resolution, supersession, recurring-family adoption, task
operation, external rollout, registry publication or live-provider acceptance.

## Verification evidence

Source checks, installed-image upgrade/crash evidence and final running-web
confirmation are recorded separately below. Local controlled
fixtures do not establish live Graph behavior, external DNS/TLS or production
deployment. C07 remains open for the remaining provider gates.

### Source checks

- Provider: 35 cases, including 15 CREATE and all 20 existing DELETE tests.
- Shared runtime: 105 kernel cases, including 16 Graph CREATE cases for immutable
  UUID/null locator/body/policy, candidate pinning, host normalization, raw
  versions, complete correlation, late credentials/HTTP/normalization, lease loss,
  known ACK races and capability-free replay.
- Graph CREATE JSON: 53 scenarios and eight harness regressions. Strict text-body
  preference reproduced RED before correction and passes after it. Same/changed
  correlated candidate after uncertainty and HTML despite requested text are
  separate cases. The root registry has six suites; all 29 root/CI-inventory
  regression tests pass, including the complete 122-suite database inventory.
  Final aggregate: 129/129, zero failures/errors in 5.335 seconds; Graph CREATE
  alone is 53/53 in 349 ms (`/tmp/musu39-graph-create-final-behavior.json`).
- Musubi: 206 actual PostgreSQL/HTTP cases, including original/shared fresh and
  recovery wire/status/normalization/metrics, complete 1,000-page bounds,
  source/grant/privacy/revision/predecessor/pull/tombstone/lease/collision/ACK
  fences and real SIGKILL/restart. Five paired second-session variants
  reproduced RED, then passed after restoring the conservative host boundary;
  two explicitly retain the safer refreshed-authority zero-POST behavior.
  All 89 API unit scripts and original CREATE recovery, pinned transport,
  delivery/admission and 124-case Graph DELETE regressions pass.
- Reference: 100 pure, 97 PostgreSQL storage and 139 real process/HTTP cases,
  including 12/12/31 new Graph CREATE cases. Old migration tests compare every
  original attempt column and additionally require the new native sidecars to be
  null for historical attempts. New cases cover unknown-ID/null-version
  reservation/adoption, repeat migration, lossless raw acceptance, candidate
  mismatch after a confirmed-readback crash, scope collision, stale authority,
  waiting-ACK cancellation, native text representation and real CLI/SIGKILL.
- Whole workspace unit stages, typecheck, lint, query runtime, contracts, peer
  and release checks pass. Web unit tests: 841/841. Existing mobile lint warnings
  remain non-errors; required zero-warning web lint passes.

### Local installed API proof

Image `musubi-c07-graph-create-api:proof` has local Docker image/index identity
`sha256:c5f35f44609980f3590f1ce5284b57892ec6c60ce82ca8c01adfba7af3d8f6b3`.
Platform manifest and config digests are separate evidence fields. All 423
production TS/SQL files match frozen/current/installed bytes, with manifest
`84e8473558b02e00f883870f94f9206f05b648a4b0977e561aef100d6b6d99fd`.
The credential-free 826-file context has fingerprint
`fd7ee20aa9ba330775f651b89fb6c006c67394daa64213235736abe6f9ab4f06`;
the post-proof inventory finds no drift.

A non-root `node` container without source mounts applied all 86 migrations from
an empty nonce database through `0085_graph_read_coverage`; the latest SQL hash
matches source. It uses `NODE_ENV=production`, `ENVIRONMENT=test`, encoder ON by
default and no override. Seventeen real HTTP checks passed: two public
health/capability, one unauthenticated denial, three Better Auth
signup/login/cookie and eleven canonical calendar/event CRUD/replay/conflict
checks. There is no authentication bypass or direct user seeding.

This installed API smoke has zero OAuth/DAV accounts, external calendars and
outbox rows, no SMTP/push and disabled background delivery. It does not exercise
a native Graph POST; that path is the separate 206-case source PostgreSQL/HTTP
corpus. The owned API container and nonce database were removed and
absence-verified. The image remains local. See the
[sanitized API summary](./evidence/MUSU-39-graph-create/api-installed-summary.json).

### Local installed reference upgrade/crash proof

Old CalDAV image
`sha256:767b0c785ed21f1c315c429d1d2db58333976b835295313e0dcbb2c67e62e0bc`
upgraded to `musubi-c07-graph-create-reference:proof`, local Docker image/index
`sha256:6251ca9b5663960d32b3a5d5b60a310517bdd0903f16eefdd7dca810d117239b`.
Platform manifest and image config digests remain separate fields. All 137
installed TS/SQL files match frozen/current bytes, including 79 production files;
canonical manifests are
`f75efcdec5200635bb81db74ddf029dc530efe86dc0265fd59acd92f660e3460` and
`3a680da7c2369e38646dc59fe307d17a059b9e66a408f3cb9fd4332ec8db4f83`.
The complete 30-package inventory excludes Musubi DB/auth/config and mobile
frameworks. Containers run read-only as `node`, without source mounts.

Fourteen cases passed through 71 installed CLI invocations, 73 native fixture
requests and four actual SIGKILLs (exit 137), in 52.832 seconds:

1. Pending Google CREATE/UPDATE/DELETE, Graph DELETE and DAV DELETE with five
   interrupted attempts preserved all original row hashes, payloads, epochs,
   receipts, history, counts and 15 table/index OIDs. All five delivered in the
   new image.
2. Repeated migration preserved an unknown-ID Graph reservation.
3. Fresh strict text-body CREATE atomically adopted the assigned ID and null
   readback version, keeping the admitted native locator null.
4. Repeated migration preserved that adopted null-version binding.
5. SIGKILL after permanent dispatch marking but before POST produced zero POSTs;
   restart performed GET only and held on missing correlation.
6. Native acceptance/candidate/raw NUL and unpaired-UTF-16 version survived
   SIGKILL; GET-only restart ACKed without another POST.
7. Lost reply followed by SIGKILL recovered with GET-only unique correlation,
   preserving uncertainty and null acceptance status.
8. An uncertain candidate was committed before SIGKILL; a later unique matching
   marker on a different ID was refused without adoption or another POST.
9. Complete zero matches remained HOLD across repeated GET-only recovery.
10. Duplicate correlation preserved native acceptance and refused adoption.
11. Partial/denied correlation preserved acceptance and refused adoption.
12. HTML despite the text preference preserved acceptance and refused adoption.
13. Occupied native scope preserved the reservation and acceptance without any
    partial mapping/baseline adoption.
14. Known 429 retained its delay and permanent one-shot marker; read-only
    recovery never resent or adopted a later matching resource as an accepted write.

The restricted test preload routes only fixed native origins to owned loopback,
preserves logical response URLs and has no external fallback or DNS override.
DAV uses its normal explicit private-network policy. The candidate-commit pause
forwards the real installed `pg.Client` UPDATE/COMMIT unchanged, then notifies
only the owned control endpoint and waits before returning. This places SIGKILL
after durable evidence and before ACK without modifying production source or SQL.
Its initial data-URL import resolution error was fixed only in the temporary
preload; the full proof then reran successfully against the same frozen image.

External DNS, live TLS and live providers are outside this local proof. Owned
CLI containers and nonce databases were removed and absence-verified. See the
[sanitized reference summary](./evidence/MUSU-39-graph-create/reference-installed-summary.json).

### Final running-web confirmation

After all fast, database/process and installed-image checks, the existing
Playwright suite passed 8/8 on its first run in 24.7 seconds. It opens the task
page and inspector, then replays title editing with preserved richer content,
draft preservation after a rejected write, read-only controls and cancel-delete
with zero writes. These browser fixtures replace auth/API responses; actual
login/HTTP and native Graph execution are the separate proofs above.

| Check | Result |
| --- | --- |
| Environment | Chromium, `http://127.0.0.1:3000`; desktop 1280×900/light and narrow 390×844/dark |
| Route and meaningful content | PASS: expected task route, Tasks region and inspector |
| Overlay and runtime/console health | PASS: no framework overlay or unexpected errors |
| Interactions and HTTP serializer | PASS: exact synthetic methods, bodies, counts and rendered state |
| Layout and visual evidence | PASS: no horizontal overflow; inspected desktop edit and narrow retained-draft screenshots |

Browser plugin was unavailable, so this used the repository Playwright workflow:

```sh
pnpm --silent test:behavior:browser --workers=2 --output=/tmp/musu39-graph-create-final-browser
```

Log and all screenshot attachments remain in `/tmp/musu39-graph-create-final-browser`.
Inspected images are `/tmp/musubi-behavior-edit-preserves-content-desktop.png`
and `/tmp/musubi-behavior-conflict-keeps-draft-narrow.png`. No UI assertions,
retry settings or diagnostic allowlists changed. Owned API/CLI containers,
nonce databases, QA PostgreSQL and the Playwright web server were removed and
absence-verified. Images are local verification artifacts; current-head CI,
registry publication and production deployment remain separate evidence.
