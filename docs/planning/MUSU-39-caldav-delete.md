# MUSU-39 · CalDAV conditional personal DELETE

This bounded C07 slice shares the already-claimed CalDAV personal, timed,
nonrecurring DELETE between Musubi and the independent reference host.
`@musubi/provider-caldav` owns native XML/ICS parsing, fresh capability evidence,
guarded HTTP and one logical conditional DELETE invocation. `@musubi/sync-runtime` owns the
bounded attempt lifecycle and immutable admitted target. SQL authority,
credentials, leases and atomic settlement remain host responsibilities.

CREATE, UPDATE, recurrence, meetings, resolution/supersession and remaining C07
provider gates are outside this slice. Existing unsupported host families retain
their original routes. Nominal selected DELETE operations must pass full kernel
validation; malformed data cannot fall back to another writer.

## Native profiles and wire policies

| Boundary | Musubi `existing-caldav` | Reference `strict-reference` |
| --- | --- | --- |
| Resource | Original accepted-UID master selection; existing extra masters/overrides and orphan-attendee behavior | Direct child URL, one timed nonrecurring VEVENT without attendees; no scheduling METHOD |
| Components | Preserve existing native compatibility | Traverse every branch: VEVENT only VALARM, VTIMEZONE only STANDARD/DAYLIGHT, no further children; required core fields checked |
| Unknown properties | Preserve native bytes | Preserve native bytes, including valid VTIMEZONE and VALARM |
| Transport | Existing guarded redirects, at most five, with per-hop DNS validation/pinning and cross-origin Authorization stripping | Same guarded leaf; redirects refused |
| Fresh personal attempt | Resource GET, collection ACL PROPFIND, full preflight resource GET, DELETE | Same native guard pass, DELETE, then exact resource GET |
| ORGANIZER | Two additional principal/address PROPFINDs; existing ownership evidence governs refusal | Same organizer checks; meetings unsupported |
| DELETE 200/201/204/404 | Record attempt-local native acceptance, then existing atomic host ACK | Durably record acceptance, then require fresh exact GET 404 before ACK |
| Initial/recovery GET 404 | Exact scoped absence may ACK after host checks | Exact scoped absence may ACK after host checks |
| Preflight GET 404 | Capability evidence error; never ACK | Capability evidence error; never ACK |
| HTTP 410 or cancelled resource | Not absence | Not absence |

Both profiles use the original immutable resource URL, provider UID and strong
native ETag. Weak or changed ETags cannot authorize mutation. Native opaque ETag
bytes are preserved, including valid empty quoted values. No server-assigned URL
alias is adopted as a new target. Generic Musubi aliases are allowed by the
existing transport, so that profile does not claim an exact final response URL.
ACL matching still uses the original requested collection href.

Fresh collection `all`, `write` or `unbind` evidence is required. Missing ACL
does not grant DELETE, including for iCloud. The separate existing iCloud content
UPDATE exception is unchanged. All DNS addresses are checked before an actual
address is pinned on each hop. A conditional redirect cannot turn a mutation
into GET success. Each actual leaf contributes one bounded metric without native
IDs, content or credentials; no duplicate network policy was added in the hosts.

## Recovery and evidence

DAV recovery differs from Graph's observe-only policy. An interrupted attempt
may repeat the same original conditional DELETE after an exact UID/version read,
fresh privilege checks and current host fences. Uncertainty remains sticky;
neither a retry nor a known rejection erases inherited possible acceptance.
There is at most one logical provider DELETE invocation within one attempt;
generic guarded redirects can add HTTP hops preserving DELETE and If-Match.
Reference's within-attempt readback yields conflict if the resource is still
present after an ambiguous write. Musubi defers that observation; a later claim
may conditionally retry. This slice adds no automatic resolution or reopening
of the reference pending barrier.

Known 400/401/403/410 and 412 refusals are not-written (412 conflicts). Existing
429 and 408 not-written retry hints remain native DAV policy. Unexpected 2xx,
202, 5xx and lost replies are ambiguous. Raw parsing, UTF-8 and transport failures
retain their distinct existing Musubi classifications; wrapping them all as a
known refusal would change retry behavior.

Native acceptance, scoped absence and host completion are independent facts.
Musubi's existing outbox does not durably retain the native acceptance status;
after a crash it conservatively resumes from its unresolved uncertainty.
Reference retains acceptance durably. Exact GET 404 never invents native
acceptance, a validator, a projection or a global canonical delete.

## Host authority and storage

Musubi keeps its source/grant/privacy, account incarnation, predecessor, lease,
retained pull/tombstone, exact mapping and cancellation checks. DELETE retains
its existing authority after allowed local unlink/canonical edits; no UPDATE
revision-equality rule is imposed. The actual existing CalDAV normalizer runs
before the initial decision and conflict reread. The bridge does not copy that
normalizer into the kernel or persist an extra snapshot.

The account port captures an owned physical CalDAV account ID and
`updatedAt.getTime()` revision, checking owner/revision before and after Basic
credential decryption. This timestamp is an opaque existing revision floor,
not a new monotonic generation or full ABA guarantee. CalDAV does not acquire an
invented OAuth grant. Preparation, DNS, credentials, HTTP, evidence and ACK share
bounded attempt/heartbeat guards, including signal-ignoring continuations and
late lease loss. A known committed atomic ACK wins a racing timeout.

Reference adds a forward SQL migration after the Google/Graph migrations. It
extends provider/profile checks, captures immutable operation UID and adds
binding UID to source-generation fencing. Basic ciphertext changes advance its
own integer connection generation. Existing Google payloads, epochs, attempts,
history and table identities are preserved. Repeated migration with CalDAV rows
must work; the earlier Graph migration no longer reinstalls its narrower check.
This is a forward-upgrade claim, not an old-binary downgrade guarantee.

Dedicated CalDAV seed/admission commands save the exact native UID, URL and
strong validator, with encrypted strict Basic credential JSON and empty OAuth
scope. Existing expiry is a local reference validity policy, not DAV password
expiry. The reference CLI requires a canonical UUID because it invokes the real
codec; shared runtime operation IDs remain opaque. Private-network access is an
explicit host policy, false by default. No test route, source-mounted runtime or
real-network fixture fallback is introduced.

## Source verification

- Provider: 22 injected-port tests; unchanged legacy parser bytes and original
  client/discovery/privilege/content compatibility tests pass.
- Shared runtime: 89 kernel tests, including 14 CalDAV cases for immutable
  target/policy capture, UID/version binding, host normalization, ignored signals,
  late leases, atomic ACK races and private pure replay.
- CalDAV JSON: 32 scenarios and 7 harness regressions. They exercise the actual
  codec, runtime, XML/ICS parser and guarded transport with DNS/HTTP leaf fixtures.
  Nested VEVENT refusal reproduced a real RED before the strict-profile fix and
  passes through the runner with zero DELETE and no ACK.
- Musubi: 154 actual PostgreSQL/HTTP cases, including paired old/shared four/six
  call flows, native statuses, redirects/metrics, owned-account revision fences,
  source/privacy/lease/predecessor/retained-pull/lock guards and actual process
  SIGKILL/restart. Existing provider writes, pinned transport and CalDAV scope
  integrations pass; all 88 prior API unit scripts and the new compatibility
  unit test pass.
- Reference: 13 CalDAV pure, 10 PostgreSQL and 26 process/HTTP cases. Existing
  Google/Graph suites pass after migration. Valid time zone/alarm fixtures and
  nested-resource refusal are exercised through the real runner and processes.
- Workspace typecheck, lint, query runtime, contracts, release metadata and peer
  checks pass. All workspace unit stages pass, including 89 API scripts and
  841 web tests. The first aggregate invocation stopped at an existing API test
  requiring `ENVIRONMENT=test` because the local shell defaulted to `dev`;
  API/DB/web stages were then run explicitly in the CI test environment without
  modifying assertions. Existing mobile lint warnings remain non-errors;
  required zero-warning web lint passes.

Installed-image, final running-app and current-head CI results are separate
evidence. Controlled local endpoints do not certify live iCloud or arbitrary
CalDAV services. This work does not publish an image, deploy production or close
the remaining C07 gates.

### Local installed API proof

Image `musubi-c07-caldav-delete-api:proof` has local Docker image/index identity
`sha256:8e97c975d0639e473912b1ef04d43d5af4293f548fee6963a8816fd103de5fe1`.
Its platform manifest and config digests are recorded separately. All 418
installed production TS/SQL files match frozen/current source byte-for-byte;
the production manifest fingerprint is
`60700eae574925db09a9ebc9c50d1525401fd5045b1077dc8b1db95838c7c88f`.
The 813-file credential-free build context has fingerprint
`bc053fea6ccd50973abd615fe62a9d429dcef26fbee711ffa6b60a75bd9ab546`.

The non-root container runs without source mounts. An empty nonce database
applied all 86 migrations through `0085_graph_read_coverage`; the latest hash
matches source. Encoder ON is the default with no override. Runtime uses
`NODE_ENV=production` and `ENVIRONMENT=test`.

Seventeen real HTTP checks passed: two public health/capability checks, one
unauthenticated rejection, three real Better Auth signup/login/cookie checks and
eleven authenticated canonical calendar/event checks including CRUD, idempotent
replay and stale revision refusal. No authentication bypass or direct user
seeding was used. There were zero OAuth/DAV accounts, external calendars or
outbox rows; SMTP/push were off and background delivery was disabled.

This installed API smoke does not exercise a native DAV DELETE. That path is
proved separately by the 154-case source PostgreSQL/HTTP corpus. The owned API
container and nonce database were removed and absence-verified. The image stays
local, without registry publication or production deployment. See the
[sanitized API summary](./evidence/MUSU-39-caldav-delete/api-installed-summary.json).

### Local installed reference upgrade/crash proof

The old Graph image
`sha256:528b899fe815b37bbc065090a156dcf936222074a20c0f34e6af02746c00d7d4`
upgraded to `musubi-c07-caldav-reference:proof`, local Docker image/index
`sha256:767b0c785ed21f1c315c429d1d2db58333976b835295313e0dcbb2c67e62e0bc`.
Platform manifest/config identities are separate fields in the evidence.
All 124 installed TS/SQL files match frozen/current source, including 74
production files. Their canonical manifests are
`6975c55095f9cfe563f0c318d53efe2aabf171d01eeb6a636d20ccd5a5edafde` and
`02cde1385761a953f194adad76ef804d0e879461d60cdddbc59c49edc2ecf608`.
The complete 30-package inventory includes the DAV parser/network dependencies
and excludes Musubi DB/auth/config and mobile frameworks.

Ten cases passed through 57 installed CLI invocations, 69 native fixture requests
and five actual container SIGKILLs (exit 137), in 39.053 seconds:

1. Pending Google CREATE/UPDATE/DELETE and Graph DELETE, including four
   interrupted attempts, preserved row hashes, payloads, epochs, receipts,
   history, counts and all 15 table/index OIDs. All four then ACKed in the new image.
2. Two further migrations with populated DAV rows preserved their data and OIDs.
3. Default private-network denial stopped before HTTP; explicit normal policy
   allowed the bounded loopback fixture, with valid time zones and alarms.
4. An uncertain DELETE followed by SIGKILL replayed only the same URL/UID/strong
   ETag after fresh guards; two conditional DELETEs total, marker never cleared.
5. Changed ETag conflicted after restart, without resend or rebasing.
6. Changed UID held after restart, without resend or adoption.
7. Accepted 204 then SIGKILL during verification resumed with GET 404 only,
   retained durable acceptance and made one DELETE total.
8. Lost reply then SIGKILL during verification resumed with GET 404 only,
   retained uncertainty/null acceptance and made one DELETE total.
9. Nested VEVENT held after GET/PROPFIND/GET, with zero DELETE and no ACK.
10. Known 429 retained its delay and original conditional retry, without clearing
    the durable dispatch marker.

Repeated deliveries after ACK were unclaimed and issued no HTTP. Production
source was installed in read-only, non-root images without source mounts. A
test-only fetch preload routes fixed logical HTTPS loopback targets to the owned
HTTP fixture, preserves logical response URLs and has no external fallback or
DNS override. Shared guards, Basic credential ports, runtime, SQL and SIGKILL
are real installed code; this proves neither external DNS/TLS nor live providers.

Owned CLI containers and nonce databases were removed and absence-verified.
See the [sanitized reference summary](./evidence/MUSU-39-caldav-delete/reference-installed-summary.json).

### Final running-web confirmation

After source, database/process and installed-image checks, the unchanged web
suite passed all eight cases in 14.1 seconds. It opens the task page, opens the
inspector and replays title editing with preserved content, rejected-write draft
preservation, read-only controls and cancel-delete with zero writes. Fixtures
replace auth/API responses at the browser HTTP boundary; actual API login/CRUD
and DAV delivery remain the separate proofs above.

| Check | Result |
| --- | --- |
| Environment | Chromium, `http://127.0.0.1:3000`, desktop 1280×900/light and narrow 390×844/dark |
| Route identity and meaningful content | PASS: exact task route, Tasks region and inspector |
| Framework overlay and runtime/console health | PASS: no overlay or unexpected errors in final full run |
| Interactions and native HTTP serialization | PASS: exact ordered synthetic methods/bodies/counts and rendered outcomes |
| Layout and screenshots | PASS: no horizontal overflow; inspected desktop edit and narrow draft-preservation screenshots |

The first cold run passed six cases and caught two dynamic client-module import
errors during initial Vite dependency optimization. After optimization the
unchanged complete suite passed; no source, assertions, error allowlist, retry
setting or test limits were changed. Both logs and failure traces are retained
outside the repository. Browser plugin was unavailable, so the existing
Playwright workflow was used:

```sh
pnpm --silent test:behavior:browser --workers=2 --output=/tmp/musu39-caldav-final-browser-after-eof
```

Final screenshots are `/tmp/musubi-behavior-edit-preserves-content-desktop.png`
and `/tmp/musubi-behavior-conflict-keeps-draft-narrow.png`; all eight screenshots
are attached to `/tmp/musu39-caldav-final-browser-after-eof`. Fast aggregate evidence
is `/tmp/musu39-caldav-final-behavior.json`: 76/76, zero failures/errors in
4.965 seconds, including 32 CalDAV scenarios in 340 ms. Owned QA PostgreSQL,
CLI/API containers and nonce databases have been removed; these are local
verification artifacts, without publication or production deployment.
