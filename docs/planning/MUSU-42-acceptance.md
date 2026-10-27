# MUSU-42 / C10 — standalone candidate and conformance

Implementation and bounded local technical acceptance are complete at source
`8e5e202c4912748e97c02646a8969a4a02543c3c`, tree
`dd2c9c7684533f98e898dc3278331c011c313e52`, on 26 October 2026. The
[evidence packet](evidence/MUSU-42-sync-alpha/packet-manifest.json) records the
exact source, artifact, installed, database and running-web boundaries. Final PR
approval, current-head CI, protected source publication and production deployment
have separate receipts; local tests do not establish those outcomes. C09 is
published by [PR #388](https://github.com/f-tuma/musubi/pull/388), squash
`f5004674d774fc55b628497ae6ad16d003c4d680`, after all 21 current-head checks passed.

[PR #389](https://github.com/f-tuma/musubi/pull/389) is open. Its first CI run
(`Quality #810`, head `8c2d2f5`) exposed a test bootstrap mismatch: the paired
reference-account fixture required `REFERENCE_DATABASE_URL`, whereas the ordinary
database shard supplies `ENVIRONMENT=test` and `DATABASE_URL`. It failed at the
startup assertion before any database allocation. Correction `e3f619c` retains
the initial test-environment guard and explicit reference URL precedence, then
accepts the ordinary test database URL. The completed run had 20 successful jobs
and this single failure. Its installed standalone lane actually passed 427/427,
23/23 and pure host 211/211 on its own CI archive; the
[independent audit and six receipts](evidence/MUSU-42-sync-alpha/ci810-independent-audit.json)
retain that separate merge-ref identity. Its observed job log spans 19m23s,
including about ten extra minutes for standalone conformance. Commit `68f974e`
therefore gives only that database shard 30 minutes; the other shards retain 20.
The old run is not acceptance for these corrections; a newly reviewed final head
and all its required checks must pass before protected publication.

The following [Quality #811 audit](evidence/MUSU-42-sync-alpha/ci811-failure-audit.json),
on head `214d4a2`, records 19 successful jobs and two failures. Both failed an
immediate database-session cleanup assertion with one session remaining, after
their preceding behavioral assertions. The CI logs did not capture that
session's owner or state. The standalone alpha step was skipped because the
ordinary database shard failed first; no new installed 427/23 result is claimed
for that run. The corrected paired-reference fixture did pass in database shard
four, including zero sessions, plain DROP and verified absence.

Correction `92ea324` changes two API integration fixtures and adds a shared
fixture cleanup helper. It waits on fresh, bounded actual PostgreSQL session
observations, retains diagnostics on refusal and permits plain DROP only at
zero, followed by catalog absence. Normal budget integration now exercises both
a real delayed owned disconnect and bounded refusal of a persistent owned
client. No production behavior, required assertion or fingerprint rule changed.
Its [actual local proof](evidence/MUSU-42-sync-alpha/ci811-cleanup-execution.json)
and the [generic native replay](evidence/MUSU-42-sync-alpha/ci811-event-generic-proof.json)
passed; all required checks on the new final PR head remain necessary.

The [alpha packet](../sync-alpha/README.md) defines a private, preinstalled
Node 22/Linux source-ESM snapshot with exact TSX and separate compiler/test
material. It includes the six portable libraries and independent PostgreSQL
reference host. The tested host was Node `v22.23.4`, Linux x64, TSX `4.23.12`,
pnpm `11.8.0`, with TypeScript `6.0.3` in tooling. The builder ran on host Node;
`baseImage` is null. This does not certify plain-Node JavaScript, arbitrary npm,
browser, Deno, Bun, other platforms or a public support/version policy.

The produced archive is 15,077,985 bytes, SHA-256
`0d14e058cbe9df9f0ca24dcedd09d9f3eab28cc6b4dad80d7802bd3cb1aa8f88`.
Its candidate-manifest SHA-256 is
`20f39cb75fc602c25d2918c2cfa1a08ce06c9b4cf346c8d8fa2a32e54cdb71c0`,
and payload digest is
`c5a0fc7544059f489f9fabb3cfe16641bf0a5b2ac0aa3a31d1abda5550c6bf9d`.
Both the produced directory and a fresh extraction at another location passed
artifact verification. The full installed corpus ran only against that relocated
archive. Both directory inventories remained unchanged.

Packaging uses an exact tracked Git archive and frozen production/tooling
deployments. Production source and SQL match Git, and test-mirror production
bytes come from the actual installed runtime. All 14 owned manifests retain
source/raw/normalized hashes; each dependency resolves from its importing package
inside its own closure. Raw generated installation metadata is retained in
provenance. Eight manager-metadata files are removed from runnable roots rather
than treated as a relocatable reinstall recipe. The artifact contains 3,589
verified files and 70 runtime/tooling/mirror package entries.

| Boundary | Actual result | Source and evidence |
| --- | --- | --- |
| Portable source corpus | 427/427 required IDs, zero failure/skip/TODO | Exact `8e5e202`; [source proof](evidence/MUSU-42-sync-alpha/source-conformance-8e5-proof.json) |
| Pure host compatibility | 211/211 required IDs, zero failure/skip/TODO | Exact `8e5e202`; same proof, independent host lane |
| External installed consumer | Six package imports, strict typecheck and CLI missing-own-config hold passed with clean home/cwd | [Relocated artifact receipt](evidence/MUSU-42-sync-alpha/artifact-relocated.json) |
| Installed portable corpus | 427/427, exact candidate/source identity, unchanged inventory | [Installed receipt](evidence/MUSU-42-sync-alpha/installed-deterministic.json) and complete conformance sidecar |
| Installed PostgreSQL/process corpus | 23/23 required modules, zero failure/skip/TODO, every required cleanup complete | [Installed reference receipt](evidence/MUSU-42-sync-alpha/installed-reference-db.json) and [aggregate proof](evidence/MUSU-42-sync-alpha/installed-candidate-summary.json) |
| Full workspace and JSON | `pnpm check`; 598/598 scenarios in 17 suites | Historical exact `d3a8867`; [summary](evidence/MUSU-42-sync-alpha/historical-root-d3a-summary.json) |
| Actual Musubi host storage/native boundary | All six separate host DB programs passed after committed migrations | Historical exact `d3a8867`; [raw receipt](evidence/MUSU-42-sync-alpha/historical-root-d3a-receipt.json) |
| Corrected reference fixture | Unchanged RED; fallback and explicit-reference GREEN, two native cases each; pre-SQL guards and both own database cleanups passed | Exact corrected fixture bytes committed as `e3f619c`; [proof](evidence/MUSU-42-sync-alpha/ci810-cross-account-fix-proof.json) |
| Corrected API fixture cleanup | Real delayed owned backend: old immediate assertion RED, actual-zero cleanup GREEN; persistent client refused while its DB/client remained usable; full budget integration and API typecheck passed | Exact corrected bytes in `92ea324`; [proof](evidence/MUSU-42-sync-alpha/ci811-budget-cleanup-proof.json) and [execution metadata](evidence/MUSU-42-sync-alpha/ci811-cleanup-execution.json) |
| Generic native compatibility replay | 18 delivery snapshots, 78 native HTTP requests; zero sessions, plain DROP and absence passed; 2,286 inputs unchanged | [Receipt and fingerprint proof](evidence/MUSU-42-sync-alpha/ci811-event-generic-proof.json); this is the generic native slice, not a complete event-corpus rerun |
| Running web | Renewed final 22/22, zero automatic retries, 26 fresh retained screenshots; four image hashes match the four previously viewed images | Exact unchanged `8e5e202` Web source; [renewed summary](evidence/MUSU-42-sync-alpha/browser-renewed-summary.json) and [latest source binding](evidence/MUSU-42-sync-alpha/accepted-8e5-to-ci811-cleanup-binding.json) |

The historical workspace/598/host-six results are not relabelled as reruns on
`8e5e202`. The [source binding](evidence/MUSU-42-sync-alpha/workspace-d3a-to-8e5-binding.json)
verifies 16 unchanged production, API, frontend, reference source, package,
lockfile, behavior-runner and CI scopes. The seven changed paths contain only
packaging/conformance tests and metadata plus the preinstalled-snapshot guide.
Their final twelve packaging assertions, parser checks and complete source and
installed corpus passed. All final PR checks remain required for its current head.

The reference corpus calls production stores, kernels, adapters and CLI/process
paths with sanitized native HTTP fixtures. It includes crash, lease, populated
upgrade, retirement, owned CREATE adoption, causal work and paired-account
boundaries. Musubi coverage/echo/home authority has the separate actual host DB
gate; the pure host lane and standalone CLI are not promoted into a general pull
engine. Module receipts require named actual assertions/completion evidence and
independently reconcile required, selected and result IDs.

All 23 reference outer databases reached issuer-zero, plain DROP and verified
absence. All 22 child journal states were `dropped`, with zero sessions and
absence; parent recovery was false throughout. The normal fixture journal
records those child DROP operations, not additional recovery DROP calls by the
observer. The final inspection found zero nonmaintenance databases and zero
other client sessions, then closed its own pool. Root retired only its exact QA
container on port 55446 before browser testing; user QA on 55437 was untargeted.
All three web attempts reaped their owned groups and left tracked source unchanged.

The first web attempt was 21/22: its trace captured HTTP 504
`Outdated Optimize Dep` while Vite changed its cold dependency cache and reloaded.
The failed receipt/log/trace remain [separate evidence](evidence/MUSU-42-sync-alpha/browser-cold-start-failure.json).
The identical full suite then passed on the populated cache without application,
assertion or automatic-retry changes. Browser API fixtures do not prove real
authentication, SQL or provider services; those boundaries are separate.

The corrective fixture has separate actual source regression evidence: the
unchanged CI-style invocation failed, both supported URL inputs then passed the
same two native account-ownership cases, and missing test environment/admin URL
guards constructed zero pools and issued zero SQL. Each fresh own database had
zero sessions before plain DROP and verified absence. The retained
[cleanup receipt](evidence/MUSU-42-sync-alpha/ci810-final-cleanup.json) also records
zero other clients and the ended observer pool. A final actual SQL probe found
the owned QA on 55447 empty. Its subsequent stop/remove/exact-ID absence was
preserved in the PC-shutdown checkpoint; the
[retirement witness](evidence/MUSU-42-sync-alpha/corrective-qa-retirement.json)
explicitly distinguishes that operator record from retained raw command output.
The renewed full web run followed this retirement.

The [exact Git binding](evidence/MUSU-42-sync-alpha/accepted-8e5-to-corrective-binding.json)
verifies 15 Web/API/package/tooling/lock scopes unchanged from accepted
`8e5e202` to corrective `68f974e`, plus the bounded CI timeout metadata change.
The only changed selected packaging input is
the integration test fixture; the actual packaging predicate excludes it from
production and copies it into the conformance mirror. All 30 retained reference
production source/SQL files are unchanged. The original archive, its test mirror
and installed 23-module result retain their original fixture bytes. This is not
a new archive or full installed-corpus rerun on `e3f619c`; the corrected source
fixture has its separate proof and still requires new current-head CI. The web
copy remains the `8e5e202` full-repository archive, with exact unchanged frontend,
API, package, dependency and test inputs for the renewed browser run.

That `68f974e` binding is historical. The
[current binding through `92ea324`](evidence/MUSU-42-sync-alpha/accepted-8e5-to-ci811-cleanup-binding.json)
qualifies the three subsequent API test-support changes; it does not claim an
unchanged whole API tree. The actual generic native production fingerprint
contains 380 files, all byte-equal to both `214d4a2` and `92ea324`; the new helper
is included in the separate harness fingerprint by its existing `_fixture_`
rule. The budget proof separately verifies its unchanged 47 production inputs.
Generic replay inventory values use SHA256 of `file:` plus bytes, or `symlink:`
plus the literal link target; they are not raw content hashes. Its executed
runner and this interpretation are retained with the proof. Prior web results
keep their original copied `8e5e202` identity; no browser rerun after these
test-only cleanup changes is claimed.

The fresh corrective QA on 55448 was empty after both actual fixture runs:
zero nondefault databases and zero other clients, then its observer pool ended.
The [retirement receipt](evidence/MUSU-42-sync-alpha/ci811-qa-retirement.json)
retains actual stop, non-force removal and exact-ID absence command results.
User QA on 55437 remained untargeted. The local delayed-disconnect regression
models an admissible close race; it does not identify the original CI sessions.
The first probe's deadline-query timeout and the first typecheck's unsupported
`AggregateError` name remain diagnostic history, followed by passing corrected
probe/full integration/typecheck results without compiler configuration changes.

The original MIT license and copyright remain intact. The actual dependency
inventory covers 30 production packages, 70 total entries and 21 deduplicated
license/notice texts. Whole same-package MIT READMEs are retained only when the
declaration, heading, copyright and complete license clauses are present;
TypeScript's included third-party notice is retained as well. Missing text still
fails. This is provenance for owner review, not a legal compatibility opinion.

The ten supported profiles keep concrete provider/API, object, role/grant,
validator, retry and side-effect limits. Live-provider enforcement, notification
delivery and deployed behavior remain unestablished. Google CREATE's conservative
capability descriptor, Graph weak-ETag/non-CAS limits, DAV protocol-fixture scope,
host-only specialized/legacy families and the C08 barrier-aware rollback floor
remain explicit. Public naming/version/license/support/private-contact decisions
are prepared for human review; no registry publication or production rollout was
performed by this acceptance work. Production activation is the later joint step.
