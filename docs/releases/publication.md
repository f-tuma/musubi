# API/web publication and reused main Quality

The publication workflow builds API/web images for an explicitly approved full
commit SHA. It reuses the **completed Quality execution for that exact commit
from a trusted push to main**. PR Quality and post-merge main Quality still run
all 21 jobs, including real Android APK/AAB builds and both shipped DEX scans.

The new publication contract is **nine own jobs plus evidence of 21 main
Quality jobs**. It is neither 29 newly executed publication jobs nor 21 skipped
tests. Earlier release receipts using the old 29-job contract remain historical
evidence and must not be rewritten into this schema.

## Execution and permissions

| Publication job | Work performed |
| --- | --- |
| Quality provenance | Read GitHub Actions metadata and freeze the exact main Quality proof |
| prepare | Recheck the pinned proof, release metadata and absence of the requested tag/release |
| Build api (amd64), Build api (arm64) | Publish the two native API build indexes by digest |
| Build web (amd64), Build web (arm64) | Publish the two native web build indexes by digest |
| Publish api manifest, Publish web manifest | Assemble each version/latest index only after all four builds succeed |
| release | Recheck the exact proof immediately before the fresh deployment tag, then strictly create the release |

The provenance and preparation jobs have `contents: read` and `actions: read`.
The release job adds `contents: write` for the existing tag/release operation.
No Actions write permission, new PAT, fork checkout or new credential scope is
needed. The existing Docker credentials remain confined to image publication.
The `production-release` concurrency group serializes these publishers. It
does not serialize main pushes, Quality reruns or other actors changing tags.

## What the Quality gate proves

`scripts/quality-proof.mjs` accepts only the trusted `f-tuma/musubi` repository,
the expected repository identity, a manual publication from main, and a checkout
whose HEAD equals both the captured workflow SHA and the full
`expected_source_sha`. The consumer run ID, consumer attempt, version and
publication workflow identity are bound into the saved receipt.

The gate finds one unambiguous Quality push run for the exact source and main
branch. It checks workflow identity/path, execution and head repository, run
identity/attempt, completion and success. It then reads that run's
[attempt-specific jobs endpoint](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt)
and requires the exact 21 unique expected job names and IDs. Every job must have
the same source, run and attempt and a completed successful result. The Android
job must additionally contain successful native build and shipped DEX steps.

The run, selected candidate and workflow are read again after job enumeration.
Pending, failed, skipped, missing, duplicate or extra jobs fail closed, as do
wrong provenance, ambiguous candidates and metadata changing between reads.
There is no fallback to another green run. A partial rerun cannot borrow green
jobs from an older attempt; reuse requires all 21 jobs in the accepted current
attempt. A later complete attempt is eligible only for a newly collected proof,
not as a silent replacement for an already pinned attempt.

Main may advance while builds run. That never changes the approved captured
source: all checkouts, image revision labels, proof bindings and the eventual
direct tag continue to use the original full SHA. The workflow does not resolve
the moving branch name into a replacement candidate.

## Immutable receipts and the final sample

The first gate writes canonical `quality-proof.json`. The SHA256 of those exact
bytes, accepted main run ID and attempt pass through job outputs. The same
publication uploads `quality-proof-RUN_ID-PUBLICATION_ATTEMPT`; artifact overwrite
is disabled. Preparation and the release job download that named artifact and
require its canonical bytes and SHA256 to match the independently passed outputs.
They also check the source, consumer run/attempt and selected main run/attempt.
An artifact alone is not release authorization.

Within `release-guard.mjs tag`, tag/release absence checks finish first. The exact
saved Quality proof is then checked against fresh GitHub metadata immediately
before the non-force tag push. A different attempt, new candidate, changed proof
or no-longer-green result stops this path before the push.

Successful revalidation writes a separate `quality-recheck.json` receipt with
the source, consumer and main run/attempt IDs, pinned proof hash and sample time.
It is retained as `quality-recheck-RUN_ID-PUBLICATION_ATTEMPT`. It records the
final **read-only sample**, not successful tag creation or a running deployment.
GitHub does not provide this code with an atomic lock against a rerun that starts
after the last sample. The receipt therefore states that limit explicitly.

The existing tag/release guard remains authoritative for the fresh tag and
strict release create. An uncertain push or a lost release-creation reply still
requires read-only reconciliation. Never retry the whole workflow blindly,
delete/recreate the tag, force it, adopt another publisher's tag or update an
existing release to make the workflow appear successful.

## Operator use and read-only verification

Keep the existing operator trigger, backup/restore, maintenance, old-consumer
stop and recovery prerequisites from the selected release runbook. This CI
change does not supply those observations. The GitHub tag remains the reported
API and web deployment trigger, and an API/web release does not require a native
store release unless the selected scope promises one.

After the change is merged, its exact main Quality run must finish all 21 jobs
before a future authorized publication can use it. No experiment release or
production tag is required to validate this implementation milestone.

For a future completed publication, record the actual full source SHA, actual
publication run ID and version in the following task-specific variables. Use a
fresh output path and the existing GitHub CLI authentication with read access:

```sh
node scripts/verify-publication.mjs \
  --source "$MUSUBI_RELEASE_SOURCE_SHA" \
  --run-id "$MUSUBI_RELEASE_RUN_ID" \
  --version "$MUSUBI_RELEASE_VERSION" \
  --output "$MUSUBI_RELEASE_EVIDENCE"
```

This command only reads metadata and downloads evidence; it does not dispatch,
rerun, push, tag, release, deploy or write to the registry. It refuses to overwrite
the output file. It requires GitHub CLI, Node 22 and Python 3's standard library.
No archive contents are executed or extracted onto the filesystem.

The verifier requires all nine current-attempt publication jobs, both actual
same-publication evidence ZIPs, their GitHub archive SHA256 digests, canonical
contained JSON and exact consumer/source bindings. It checks the linked main
run/attempt and actual 21 jobs again, the native build/DEX evidence, the pre-tag
receipt and the direct commit tag and final GitHub release. Run and artifact
identities are re-read before the result is accepted. Expired, replaced,
ambiguous or unavailable artifacts leave verification incomplete; metadata alone
does not substitute for their downloaded bytes.

The [GitHub artifact archive digest](https://docs.github.com/en/rest/actions/artifacts)
is distinct from the contained JSON SHA256 and from an OCI image digest. Record
each with its meaning. A Quality rerun after publication can make this strict
current-state verifier reject the old pin; retain any earlier immutable receipt
and report the changed state instead of rewriting the earlier observation.

## Separate publication and deployment acceptance

The publication verifier does **not** replace registry acceptance. Separately
verify the API/web immutable multi-platform index digests, all four runtime OCI
source revisions, the four actual build digest artifacts and complete
runtime/attestation descriptor unions. Attestation descriptor membership is not
cryptographic verification of attestation payloads or signatures.

Neither the GitHub proof nor registry metadata proves running API/web revisions,
container/deployment IDs, Created/StartedAt or deployment/restart history,
production DB journal, backup/restore, maintenance ordering, queues, provider
recovery or authenticated smoke results. Record those independently. For a
Vardum artwork change without deployment, retain before/after runtime identities
and history spanning that test; a published image digest alone is insufficient.

Historical version-specific notes and receipts remain frozen. This document is
the current generic workflow contract, not a claim that a nine-job publication
or a new production deployment has already happened.
