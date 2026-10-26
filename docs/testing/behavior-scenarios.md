# Fast behavior scenarios

Use small JSON scenarios while editing. Run the affected flow through the
application after the fast loop passes. The drivers execute production code;
fixtures supply its dependencies at the existing boundaries.

```sh
pnpm test:behavior --list
pnpm test:behavior --suite google-delete --scenario already-absent --json
pnpm test:behavior --suite google-create --scenario fresh-create --json
pnpm test:behavior --suite google-rsvp-delivery --scenario started-unchanged-is-read-only --json
pnpm test:behavior --suite google-task-update --scenario fresh-title-update --json
pnpm test:behavior --suite google-task-delete --scenario fresh-delete --json
pnpm test:behavior --suite google-task-create --scenario fresh-create --json
pnpm test:behavior --suite google-task-update --scenario deferred-update-keeps-null-admission --json
pnpm test:behavior --suite google-task-delete --scenario deferred-delete-keeps-null-plan --json
pnpm test:behavior --suite microsoft-delete --scenario lost-reply-restart-present --json
pnpm test:behavior --suite microsoft-create --scenario fresh-create --json
pnpm test:behavior --suite caldav-delete --scenario fresh-delete --json
pnpm test:behavior --suite caldav-create --scenario fresh-create --json
pnpm test:behavior --suite task-delivery --scenario ack-signal-forwarded --json
pnpm test:behavior --suite task-inspector --scenario conflict-keeps-draft
pnpm test:behavior --json
# Last: real routing, components, HTTP client, query cache and browser layout.
pnpm test:behavior:browser
```

Use `--list` for exact scenario ids. Unknown arguments, unknown ids, malformed
suites, skipped tests, mismatched requests and unconsumed fixtures fail with a
nonzero exit code. JSON mode writes one aggregate JSON report to stdout, with
per-suite results and elapsed time. `failed` counts failed scenarios; `errors`
separately counts runner or harness failures, which also cause a nonzero exit.
Reports and temporary browser artifacts are
not committed. The root runner can also be called as
`node scripts/test-behavior.mjs` with the same options.

| Suite | Production code exercised | Replaced boundary | Services needed |
| --- | --- | --- | --- |
| `google-delete` | Claimed delivery runtime, Google provider preflight/conditional DELETE/recovery | Host persistence/lease/credential ports, HTTP responses and clock | None |
| `google-create` | Admitted codec identity/body, CREATE delivery runtime and provider preflight/write/recovery | Host persistence/lease/credential ports, ordered HTTP responses and clock | None |
| `google-task-update` | Actual Task codec, claimed UPDATE kernel, original NULL causal admission, predecessor proof, saved mask and native provider | Host preparation/lease/credential/ACK ports, ordered HTTP receipts and clock | None |
| `google-task-delete` | Actual Task DELETE codec, original NULL causal admission, scoped reads, conditional DELETE and explicit no-resource completion | Host preparation/lease/credential/ACK ports, ordered native receipts and clock | None |
| `google-task-create` | Actual Task CREATE codec, generated-address kernel, list proof, POST and scoped readback | Host preparation/lease/credential/ACK ports, ordered native receipts and clock | None |
| `microsoft-delete` | Admitted Graph DELETE codec, guarded runtime, native weak version, owned-calendar preflight and exact absence | Host persistence/lease/credential ports, ordered HTTP responses and clock | None |
| `microsoft-create` | Admitted Graph transaction/body, bounded CREATE runtime, native permission/POST/scoped listing and candidate identity | Host persistence/lease/normalization/credential ports, ordered HTTP responses and clock | None |
| `caldav-delete` | Admitted DAV DELETE codec, runtime, real XML/ICS parsing, privilege/organizer preflight and conditional DELETE | Host persistence/lease/credential ports, DNS, pinned HTTP leaf responses and clock | None |
| `caldav-create` | Admitted full ICS/URL/UID, CREATE runtime, bind ACL/conditional PUT and exact resource recovery | Host persistence/lease/normalization/credential ports, DNS, pinned HTTP leaf responses and clock | None |
| `google-rsvp-delivery` | Actual Google RSVP native adapter, primary identity, minimal conditional PATCH and full desired observation | Strict ordered HTTP receipts, authorized-token callback and private before-write callback; no DB fallback | None; no DB authority or native-network claim |
| `task-delivery` | Actual existing task executor, codec/decoder, stored patch selection, recovery and ACK/finish arguments | Existing DB/config module exports and adapter data receipts via test-only Node module mocks | None; no DB/native HTTP claim |
| `task-inspector` | React inspector/editor, capability checks, task serializer and HTTP client | Seeded context and HTTP receipts | None; Vitest/jsdom |
| Browser confirmation | Running web app, router, task queries/cache and inspector/editor; same JSON commands and receipts | Auth/API responses at the browser HTTP boundary | Web dev server and Chromium |

The sync suite covers a conditional write, exact absence without mutation,
version conflict before mutation, lost response followed by read-only observation,
and `Retry-After` without immediate replay. Its bounded summary asserts every
request method and validator, completion evidence and dispatch uncertainty.

The CREATE suite covers frozen planned IDs and bodies, nullable ETag handling,
matching GET-only adoption, exact 404 same-ID retry, 410/cancelled/marker/content
conflicts, 409 rejection, 429 delay and lost-reply observation. All POST bytes
must equal the admitted native plan. These tests do not establish host SQL
adoption, source authorization or live Google semantics.

The UI suite covers editing a title while retaining richer data and revision
fences, preserving a draft after a rejected write, read-only capability controls,
and canceling deletion with zero writes. Browser confirmation runs all four cases
on desktop/light and narrow/dark. It also checks page errors, console errors,
framework overlays and horizontal overflow, and saves screenshots in the system
temporary directory with attachments in the Playwright results. The intentional
HTTP 409 receipt is allowed only as its exact browser resource diagnostic;
unexpected console and page errors still fail.

The Graph suite preserves the nine-call Musubi flow and the reference host's
single guard pass. It covers strict 404 absence, weak native versions, changed
final preflight, lost reply and GET-only restart, acceptance followed by failed
verification, first-attempt resolution and the accepted read/write-gap race.
Unresolved possible acceptance never permits replay merely because the event
still exists at the same version. A captured reference dispatch marker remains
one-shot even after a known 429 rejection; Musubi's existing conclusive
not-written retry policy is separately proved by actual host integration tests.

The CalDAV suite preserves Musubi's generic guarded transport and its four-call
personal flow (six calls when organizer evidence is needed). The reference
profile restricts native resources to one timed nonrecurring event, checks the
whole component tree and requires a final exact GET 404. Cases cover strong
native validators, UID binding, privileges, redirects, DNS pinning, credential
stripping, status classification and conditional recovery. Unlike Graph,
interrupted DAV recovery may resend the original conditional request after
fresh guards; inherited uncertainty is retained. The two hosts' explicit native
profiles and acceptance/ACK policies are tested separately.

The Graph CREATE suite keeps the admitted native locator null and uses the
provider-assigned ID only as a returned/correlated fact. It covers original
fresh permission/POST behavior, raw nullable versions, complete pagination,
duplicate/missing/unsafe observations, native refusal and lost replies. Unique
matching correlation can adopt; zero or incomplete results never grant another
POST. Separate profiles preserve Musubi's actual normalizer and wire while the
reference requires owned-calendar/personal/text-body readback. Durable candidate
identity and uncertainty remain distinct from native acceptance.

The DAV CREATE suite freezes full VCALENDAR bytes and deterministic URL/UID,
then exercises bind ACL and `If-None-Match: *` PUT. Exact recovery 404 may permit
the same conditional write; 410 and known 412 do not grant replay/adoption.
It distinguishes strong-or-null native acceptance from strict strong readback,
retains older uncertainty after a known retry refusal and covers DNS/redirect
guards. Declared data-only host projection fixtures are labelled separately
from the portable production ICS projector; real API normalization has paired
SQL/HTTP coverage.

The task delivery suite executes `apps/api/src/sync/task_delivery.ts` itself.
It verifies all six ACK branches pass the same attempt signal and the old native
reference captured before adapter awaits. Cases also cover false ACK settlement,
copied observed ref/projection, saved field masks, achieved recovery, empty patch
and a late readback that cannot reach ACK. The runner supplies the pinned Node
module-mock flags; application code does not load the fixture modules. These
scenarios do not prove PostgreSQL rollback, native provider wire or a new shared
task runtime. The separate `task-ack` DB and `task_ack_delivery` API integration
suites exercise actual transactions and lock/deadline races.

The Google task UPDATE suite exercises the new shared boundary directly. An
already addressed task sends the frozen changed fields through the existing
GET/GET/GET/PATCH/GET flow; an empty mask stops after two GETs. Recovery may
confirm achieved fields from one GET, while conditional replay still requires
the original tag and complete saved baseline. The API uses patch-achieved
readback and its existing permissive native response profile. The independent
reference host uses full-target readback and a stricter native profile.
Accepted HTTP status, usable returned validator and confirmed readback are
separate facts; a later 429 cannot erase older acceptance or uncertainty.
Fixtures also cover refresh only for delivery GETs, malformed responses and
assigned/deleted-resource refusals under their explicit profiles. Native JSON
ports do not prove live Google conditional enforcement or host SQL authority;
the separate paired API and reference storage/process suites cover those local
boundaries. See [the C08 task gate](../planning/MUSU-40-google-task-update.md).

The Google task DELETE suite preserves the API's three reads followed by one
conditional DELETE and direct native-response ACK. Initial or writer-final
GET absence completes without a DELETE; permission-read absence still reaches
the writer-final GET. The stricter reference completion requires actual GET
404/410. DELETE response 404/410 is distinct from accepted 2xx and from GET
absence; both raw response facts survive later failures independently. A
successful writer return is retained separately for the API's existing coarse
settlement policy. Cases exercise bodyless any-2xx success, original validators,
assigned tasks, read401 boundaries, lost responses, sticky history, and
reference observe-only recovery after any known response. See [DELETE scope and
local proof](../planning/MUSU-40-google-task-delete.md).

The Google task CREATE suite keeps the admitted resource address null and sends
exactly the saved four-field body. Raw HTTP acceptance, parsed response address,
complete awaited writer result and confirmed GET remain distinct. API fixtures
preserve the existing list GET/POST/task GET/parser/auth floors; reference fixtures
persist earlier candidate facts and require strict full-target readback. Unknown
response without an address never POSTs or searches again. Recovery always checks
the full target, even when ordinary API readback uses a saved partial mask.
JSON-time cancellation is separate from cancellation after the writer returned.
See [CREATE scope and proof](../planning/MUSU-40-google-task-create.md).

## Add or debug a case

- Sync data: `packages/sync-runtime/src/behavior/google-delete.json`.
- Existing server task delivery: `apps/api/src/sync/behavior/task-delivery.json`.
  Driver/validator: `google-delete.ts` in the same directory. Each case declares
  ordered HTTP exchanges and a complete expected observable summary. A transport
  mismatch remains a test failure even if production recovery catches the error.
- CREATE data: `packages/sync-runtime/src/behavior/google-create.json`.
  Its adjacent driver builds admission through the real codec, then invokes the
  same already-claimed runtime used by Musubi and the reference host. Use
  `pnpm --filter @musubi/sync-runtime test:scenarios:create --json` for its native
  bounded wire/outcome summary.
- UI data: `apps/web/src/tests/behavior/task-inspector.json`.
  Contract/receipts: adjacent `task-inspector.ts`; headless driver:
  `task-inspector.scenarios.test.tsx`; browser adapter: `apps/web/e2e/behavior.spec.ts`.
  Seed uses the real task schema. Steps use accessible names and a fixed set of
  click/fill/assert actions. Mutation count/methods are exact; `body` assertions
  recursively match the specified fields so incidental optional fields may vary.
  Include every content/authority field whose preservation matters to the case.
- Graph data: `packages/sync-runtime/src/behavior/microsoft-delete.json`.
  Its adjacent driver invokes the actual codec, runtime and native provider.
  Every ordered exchange asserts method, exact path, Prefer and native If-Match;
  final summaries separate acceptance, presence/absence, dispatch and host ACK.
  Run `pnpm --filter @musubi/sync-runtime test:scenarios:microsoft-delete --json`
  for the native report. These port scenarios do not prove Musubi normalization,
  SQL authority or explicit-resolution admission; actual paired host tests do.
- CalDAV data: `packages/sync-runtime/src/behavior/caldav-delete.json`.
  Its adjacent driver invokes the real codec/runtime/provider and replaces only
  DNS and the pinned HTTP leaf. Ordered exchanges assert native bytes, UID,
  validators, PROPFIND kinds, redirect behavior and per-hop metrics. Run
  `pnpm --filter @musubi/sync-runtime test:scenarios:caldav-delete --json`
  for its bounded native report. Host SQL authority, normalization, account
  revision checks and durable crash recovery have separate integration tests.
- Graph CREATE data: `packages/sync-runtime/src/behavior/microsoft-create.json`.
  Its adjacent driver invokes the actual codec, shared kernel and provider, with
  complete ordered paths/headers/body hashes, marker/assigned-ID/version facts,
  metrics and host completion expectations. Run
  `pnpm --filter @musubi/sync-runtime test:scenarios:microsoft-create --json`
  for the native report. Actual Musubi normalization/SQL/pull and independent
  reference reservation/adoption/crash behavior have separate integration tests.
- DAV CREATE data: `packages/sync-runtime/src/behavior/caldav-create.json`.
  Its adjacent driver invokes the actual codec, kernel, native XML/ICS provider
  and guarded transport with pinned leaf fixtures. Summaries assert full-body
  hashes, original URL/UID, condition, auth presence, per-hop metrics, native
  evidence, projection-port choice and exact host outcomes. Run
  `pnpm --filter @musubi/sync-runtime test:scenarios:caldav-create --json`
  for its native report. Host SQL authority, actual API conversion and durable
  reference migration/crash behavior remain separate integration evidence.

Edit the JSON, select the exact id, and inspect the JSON result. Add a small typed
driver when testing a different domain boundary. Keep domain decisions in the
production implementation; a second implementation would make the tests agree
with their own assumptions. Do not import the API bootstrap or add test routes,
backdoors, production flags, dynamic code evaluation or real-network fallback.
Use synthetic data, never saved tokens or private provider payloads.

All headless suites and their harness regression tests run in the existing unit
checks. Browser cases are discovered by the existing Playwright CI shards. No
required check is removed or renamed, and no dependency is added.

## What the evidence means

Fast checks prove the selected behavior against controlled dependency contracts.
Browser confirmation additionally proves that the behavior is wired into the
rendered application, including its real HTTP serializer and cache lifecycle.
It does not prove server authorization, database transactions, provider semantics,
deployment or native device behavior. Changes to those boundaries still need
their existing DB/provider/device checks. The browser plugin is unavailable in
this environment, so confirmation uses the repository's regular Playwright setup.

## Sources and alternatives

Shopify's [Native is now the future of mobile at Shopify](https://shopify.engineering/back-to-native)
(10 September 2026), especially “Enabling fast feedback loops”, describes
headless application logic exposed through state/actions CLI and later simulator
confirmation. This implementation applies that principle to Musubi's existing
ports and React components; it is a bounded first slice, not a general CLI for
every screen. Shopify's Helix is described as an internal workflow in that article.

The existing FOSS stack—[Vitest](https://vitest.dev/guide/),
[Testing Library](https://testing-library.com/docs/react-testing-library/intro/)
and [Playwright](https://playwright.dev/docs/intro)—already supports this slice.
[Mock Service Worker](https://mswjs.io/docs/quick-start) is an option if shared
network handlers become useful across more Node/browser fixtures.
[fast-check commands](https://fast-check.dev/docs/advanced/model-based-testing/)
are an option for generated, replayable action sequences. Neither is required for
these explicit scenarios; introducing another test platform has no benefit here.


Google RSVP native scenarios distinguish possible dispatch, full result
observation and unknown notification delivery. A fresh typed private intent may
attempt one PATCH only after its host commits the permanent started marker.
Started and markerless historical intents recover with GET only. Historical
markerless queued operations also hold even if never attempted; this is a
conservative upgrade policy, not evidence that they were sent. A manual retry
keeps that same policy. An explicit resolution with a fresh native preview and a
new operation ID is a separate admission and receives its own fresh permission.

The independent `google_rsvp_barrier.integration.test.ts` gate in
`test:db:events` uses actual PostgreSQL transactions, closed loopback native HTTP
and owned child processes. It proves original-claim/source/grant/lease fences,
real lock-wait cancellation, marker COMMIT with a lost or cancelled reply, and
SIGKILL restart at dispatch/readback/ACK boundaries. It requires a migrated test
database and does not use Git or an historical executor. These source tests are
separate from image, deployment and live-provider evidence. Rollout must retire
old workers before new workers consume historical pending intents: an old
worker does not enforce the new private sidecar.


The Google RSVP native ingress owns its entire evidence object before reading
identity, baseline, response or original occurrence slot. It uses the shared
iterative descriptor clone, preserving legacy Dates and undefined values without
adding v1 admission size/depth limits. Native JSON probes reject root/nested
accessors, inherited prototypes, callbacks and cycles before credentials or HTTP,
and retain original baseline/slot data when a credential callback mutates the
caller object. These are native boundary probes; host dispatch permission still
comes from the permanent database marker described above.
