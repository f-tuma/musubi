# Fast behavior scenarios

Use small JSON scenarios while editing. Run the affected flow through the
application after the fast loop passes. The drivers execute production code;
fixtures supply its dependencies at the existing boundaries.

```sh
pnpm test:behavior --list
pnpm test:behavior --suite google-delete --scenario already-absent --json
pnpm test:behavior --suite google-create --scenario fresh-create --json
pnpm test:behavior --suite microsoft-delete --scenario lost-reply-restart-present --json
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
| `microsoft-delete` | Admitted Graph DELETE codec, guarded runtime, native weak version, owned-calendar preflight and exact absence | Host persistence/lease/credential ports, ordered HTTP responses and clock | None |
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

## Add or debug a case

- Sync data: `packages/sync-runtime/src/behavior/google-delete.json`.
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
