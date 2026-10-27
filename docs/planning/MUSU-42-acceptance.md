# MUSU-42 / C10 — standalone candidate and conformance

The current runtime is accepted locally at source
`fb36100c151bb75323573be8cc9afd9fd689261b`, tree
`0d54cbc311100fbe66d3f835144767fbf2911378`, on 27 October 2026. A fresh archive
and installed corpus include the scheduler lost-wake correction found during PR
CI. The subsequent test-support source `0b77e4e` changes seven API integration
fixture/helper files only, with separate actual PostgreSQL verification. Final
running-web acceptance passed 22/22 with four actual visual checks. Independent
final PR review, all required checks on the final head, protected source
publication and later joint production deployment remain separate gates. The
[packet manifest](evidence/MUSU-42-sync-alpha/packet-manifest.json) indexes the
current and historical evidence by exact bytes.

The [current installed reconciliation](evidence/MUSU-42-sync-alpha/current-installed-summary.json)
and [source binding](evidence/MUSU-42-sync-alpha/current-runtime-to-test-support-binding.json)
identify the active candidate. The original `8e5e202` archive and its 427-case
reports are historical after the production scheduler change; they are not
relabelled as evidence for the current runtime.

The [alpha packet](../sync-alpha/README.md) defines a private preinstalled
Node 22/Linux source-ESM snapshot: six portable libraries and an independent
PostgreSQL reference host, with exact TSX and separate compiler/test material.
The tested runtime was Node `v22.23.4`, Linux x64, TSX `4.23.12`, pnpm `11.8.0`
and tooling TypeScript `6.0.3`; the builder ran on host Node, without a build base
image. This does not establish a plain-Node JavaScript, reinstallable npm,
browser, Deno, Bun or other-platform contract, or a public support/version policy.

The **current archive** is 15,083,927 bytes, SHA-256
`35dc0a0c83c1ffc48ecd744a7d33f2dee258b02cd5572e21b3ff2e347639bd91`.
Its candidate-manifest SHA-256 is
`238de80b13ae557b3c432b7fb607c38025277c97c9e43c7749bbc45a3782c5ee`,
and payload digest is
`d542cca4cb70a46375f8a3c46d6c1c930f57b88527cc8356137032cd33d867ac`.
Packaging selected-source archive `ddb48ee5…` and full-repository workspace/web
archive `d34b6dda…` have different scopes and hashes. Both identify exact `fb36100`;
neither is the candidate archive hash above.

Production source and SQL match the tracked source. Conformance production
mirrors use actual installed runtime bytes. Fourteen owned manifests retain
source/raw/normalized hashes and importer-specific resolution checks. Eight
manager-metadata files move to provenance rather than being presented as a
relocatable reinstall recipe. Artifact verification checks 3,589 files and
70 runtime/tooling/mirror package entries. The independent whole-root
immutability inventories contain 3,591 entries and remained unchanged at both
the produced and freshly relocated roots.

| Boundary | Current actual result | Evidence |
| --- | --- | --- |
| Portable source corpus | 431/431 required IDs; zero failure, skip or TODO | Exact `fb36100`; [source report](evidence/MUSU-42-sync-alpha/current-source-deterministic.json) |
| Pure host compatibility | 211/211 required IDs; zero failure, skip or TODO | Exact `fb36100`; [host report](evidence/MUSU-42-sync-alpha/current-source-host-compat.json) |
| External installed consumer | Six imports, strict typecheck and CLI missing-own-config hold, with clean home/cwd | [Artifact verification](evidence/MUSU-42-sync-alpha/current-produced-artifact.json); actual relocated installed modes repeat verification |
| Installed portable corpus | 431/431 required IDs; exact source/candidate binding, unchanged inventory | [Receipt](evidence/MUSU-42-sync-alpha/current-installed-deterministic.json) and complete conformance sidecar |
| Installed PostgreSQL/process corpus | 23/23 required modules, no failure/skip/TODO; every required cleanup complete | [Receipt](evidence/MUSU-42-sync-alpha/current-installed-reference-db.json) and [reconciliation](evidence/MUSU-42-sync-alpha/current-installed-summary.json) |
| Full workspace and JSON | Fresh `pnpm check`; 602/602 scenarios in 17 suites | Exact full `fb36100` archive; [root receipt](evidence/MUSU-42-sync-alpha/current-root-receipt.json) |
| Actual Musubi host storage/native | All six host DB programs and the normal provider-budget integration passed after 87 migrations | [Current root summary](evidence/MUSU-42-sync-alpha/current-root-summary.json); the original 10-second malformed-header deadline remains unchanged |
| Later API test-support cleanup | Six normal programs, 257 reported cases; eight registered prefixes use actual PG; 58 invalid inputs refuse before SQL; API typecheck passed | Exact seven later files; [proof](evidence/MUSU-42-sync-alpha/current-six-fixture-cleanup-proof.json) |
| Final running web | Two consecutive complete 22/22 passes, no automatic retries; latest run has 26 fresh screenshots, four actually viewed | Exact fresh `fb36100` Web copy; [summary](evidence/MUSU-42-sync-alpha/current-browser-summary.json) and [visual review](evidence/MUSU-42-sync-alpha/current-browser-visual-review.json) |

The reference corpus invokes production stores, kernels, adapters and CLI/process
paths with sanitized native HTTP fixtures. It covers crash, lease, populated
upgrade, retirement, CREATE adoption, causal work and paired-account boundaries.
Musubi coverage/echo/home authority has its separate actual host DB gate. The
pure host lane and standalone CLI are not a general standalone pull/import host.
Required named assertions/completion evidence and exact case IDs reconcile with
the manifest; loading a test module alone is insufficient.

The installed reference cleanup completed for every required module. Its normal
child fixture journals record their DROP operations; observer metadata must not
be described as extra parent-recovery DROP calls. The current
[owned-QA retirement receipt](evidence/MUSU-42-sync-alpha/current-qa-retirement.json)
records the actual final empty-database/client probe, closed observer pool,
normal stop/removal and exact-container absence before final browser acceptance.
User QA on 55437 remained untargeted.

The first current-runtime browser attempt passed 20/22. Its two retained traces
show HTTP504 `Outdated Optimize Dep` for optimized dependency modules while Vite
renewed its cold cache. That [failed attempt](evidence/MUSU-42-sync-alpha/current-browser-cold-start-failure.json)
remains separate. The identical complete suite then passed on the populated
cache without source, assertion or automatic-retry changes. At the user's
explicit request, a third complete run also passed 22/22; its new receipt and
four fresh actual visual checks are the final evidence. The
[three-attempt history](evidence/MUSU-42-sync-alpha/current-browser-attempt-history.json)
retains the previous successful receipt and its actual visual review byte-for-byte.
All three attempts reaped all four owned process groups and left the 2,309 tracked source entries
unchanged. The optional 90-second optimizer setup diagnostic is not counted as
an application or browser test. Root actually viewed the fresh task desktop
light/narrow dark and CalDAV RSVP light/dark images; current image hashes retain
their own identities, without borrowing historical image equality.

## Corrections, chronology and source boundaries

[CI810](evidence/MUSU-42-sync-alpha/ci810-independent-audit.json) passed 20/21 jobs;
its reference-account fixture failed before SQL because ordinary CI provides
`DATABASE_URL` while the fixture required `REFERENCE_DATABASE_URL`. The explicit
reference URL still takes precedence, with test-only fallback guarded by
`ENVIRONMENT=test`. The current fresh installed 23-module corpus includes the
corrected fixture. CI810's own installed archive remains a separate historical
identity.

[CI811](evidence/MUSU-42-sync-alpha/ci811-failure-audit.json) passed 19/21 jobs;
two fixtures failed an immediate session-count cleanup assertion after preceding
behavior assertions. Their session owners/states were not captured. Actual
PostgreSQL regression proves a delayed owned disconnect can outlive `Pool.end`,
while a persistent client must be refused and retained. The shared fixture helper
requires actual zero clients before plain DROP and catalog absence. Its
[initial actual proof](evidence/MUSU-42-sync-alpha/ci811-cleanup-execution.json)
and the [six later fixture proofs](evidence/MUSU-42-sync-alpha/current-six-fixture-cleanup-proof.json)
retain these boundaries without force-drop, backend termination or fixed-sleep
acceptance. Pool trackers, creation guards and behavior assertions remain intact.

[CI812](evidence/MUSU-42-sync-alpha/ci812-failure-audit.json) then passed its cleanup
regressions and strict final cleanup, but timed out at the unchanged malformed
Retry-After preview deadline. Its final budget summary and standalone alpha were
not reached. Independent production-port reproductions found a scheduler
lost-wake bug: eligibility could cross during selection/wake scanning/timer
arming, or during an asynchronous host lookup. The exact original CI wait path
was not captured; this separate deterministic bug is not labelled a CI trace.

The [actual fast red/green proof](evidence/MUSU-42-sync-alpha/ci812-fair-work-fast-proof.json)
and [independent review](evidence/MUSU-42-sync-alpha/current-runtime-provisional-review.json)
cover the correction: one eligibility sample per selection, a matching future
scan, and host hints retained against their prelookup cutoff. An acquired future
wake still arms when it becomes due before timer creation. Already-due account,
collision and capacity waits, and repeated stale hints, do not spin. Four new
required JSON cases raise portable conformance from 427 to 431 and full JSON from
598 to 602. Fair-work 19/19, actual named unit assertions 15/15, parser 11/11 and
runtime typecheck passed before the fresh archive/installed gates above. No
fixture deadline, claim, lease, source authority or required check was relaxed.

The [latest binding](evidence/MUSU-42-sync-alpha/current-runtime-to-test-support-binding.json)
checks all actual `ARCHIVE_PATHS`: none changes between runtime source `fb36100`
and later test-support `0b77e4e`. All 307 selected archive inputs remain exact.
The whole API tree has seven subsequent fixture/helper edits; no unchanged-whole-
API-tree claim is made. The fresh full workspace/602/host-six/budget results stay
on `fb36100`, and the six later programs are separately verified on their new
bytes. Historical `d3a8867` full-check/598 and `8e5e202` 427/23 results remain
frozen history. Failed CI810/811/812 runs remain failed; none authorizes merging
the new final PR head.

## Distribution and deployment limits

The original MIT license and copyright remain intact. Actual dependency
provenance covers 30 production packages, 70 total package entries, 34 unique
names and 21 retained deduplicated license/notice texts. Missing license text
fails verification; same-package MIT README fallbacks require complete clauses,
and TypeScript's included third-party notice remains retained. This is evidence
for owner distribution review, not a legal compatibility opinion.

The ten supported profiles retain their concrete provider/API, object,
role/grant, validator, retry and side-effect limits. Google CREATE's conservative
capability descriptor, Graph weak-ETag/non-CAS behavior, DAV protocol-fixture scope,
host-only specialized/legacy families and C08's barrier-aware rollback floor
remain explicit. Local HTTP/DB and synthetic browser fixtures do not establish
live-provider quotas, notification delivery, production flags, deployed behavior
or physical-device acceptance. Public naming/version/license/support/private
contact decisions remain proposals for human review. No registry publication or
production rollout was performed; production activation is the later joint step.
