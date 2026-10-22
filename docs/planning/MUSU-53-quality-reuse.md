# MUSU-53 — reuse exact-source main Quality during publication

This is a separate CI implementation milestone. It removes the third complete
Quality execution from a release while retaining actual PR and main Quality.
It adds no provider behavior, release version, migration, production tag, native
store publication or Vardum artwork change.

## Why this precedes more sharding

The completed 16 October PR/main profiles had Quality wall times of 518/768s,
with Android finishing last at 512/765s. Both had a real partial Gradle archive
restore, 363 FROM-CACHE and 583 executed tasks; all 12 CMake build and 12 configure
tasks still executed. More DB/API/web shards alone would not have reduced the
whole-run wall time in those two observations. They are a bounded profile, not
future percentiles or a measured saving from this change.

MUSU-53 avoids repeating the entire already-accepted main Quality during
publication. MUSU-54 remains the separate Android/native cache measurement and
optimization task. C07's next core slice remains Google personal CREATE with
stable identity and no-duplicate lost-reply recovery.

## Implementation boundary

- A dedicated provenance job replaces the reusable Quality invocation. The
  publication contract becomes nine own jobs plus a linked immutable proof of
  all 21 actual main Quality jobs; existing PR/main checks retain their names,
  native ABIs, APK/AAB and shipped DEX coverage.
- The collector requires trusted repository/workflow/event/branch provenance,
  the exact approved full SHA, the current run and attempt and the complete
  unique successful job set. The attempt-specific API prevents accidental
  mixing of old successful jobs with a partial rerun.
- Canonical proof bytes, SHA256 and run/attempt are pinned through outputs and a
  same-consumer artifact. The final tag guard verifies that receipt and fresh
  metadata after absence checks and before the existing non-force tag push.
- Main movement cannot retarget the captured approved source. Concurrent
  publishers remain serialized, while a later external Quality rerun remains a
  documented last-sample race rather than an invented atomic guarantee.
- A separate read-only verifier checks the nine publication jobs, both actual
  downloaded evidence ZIPs and their digests, exact linked main21 evidence,
  final revalidation receipt and direct source tag/release. It cannot treat old
  29-job publications as the new schema or use artifact metadata alone as file
  evidence. Historical receipts and helpers remain unchanged.

Detailed operator contract and verification command:
[API/web publication](../releases/publication.md).

## Validation and completion gates

The test suites exercise the current-attempt provenance contract, source and
consumer bindings, native build/DEX evidence, ambiguous or newer candidates,
partial reruns, failed/skipped/missing/extra/duplicate jobs, malformed/incomplete
responses, artifact/hash replacement and changes between reads. Publication
verifier tests use actual in-memory ZIP files, including unsafe members and
noncanonical JSON, without contacting a provider or publishing anything.

Release-guard integration tests must establish that a failed final Quality
sample prevents every tag push and that the final sample/receipt precede the
fresh push. An uncertain push still has the existing reconciliation behavior.
Actionlint checks workflow syntax; independent review checks the nine-job
dependency, permissions and same-attempt artifact bindings. The Quality
inventory test checks the separate full 21-job main coverage.

Completion requires independent skeptical approval of the final source before
PR, green current-head checks and an ordinary squash merge to main. The actual
post-merge main Quality run remains a separate observed result. Validation of
this milestone does not include a production publication: the first live nine-job
release and registry/runtime acceptance belong to a future explicitly selected
candidate. No wall-time improvement is claimed until comparable runs exist.
