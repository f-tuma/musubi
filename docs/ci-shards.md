# CI test shards

`Quality` runs database integration and web end-to-end tests in four separate
jobs each. A database job has its own Postgres service and applies every committed
migration to an empty database. Suites within that job run sequentially.

Preview a job's selection from the repository root:

```sh
node scripts/ci-shards.mjs db 1/4 --list
node scripts/ci-shards.mjs web 1/4 --list
```

Omit `--list` to execute it. Database jobs need the same environment and migrated
Postgres as `pnpm test:db`; the local command `pnpm test:db` still runs everything.
Web jobs keep the existing Playwright configuration, fixtures, retries and browser.

## Coverage and balancing

The database inventory expands the existing `test:db` package scripts. Adding a
suite there includes it in CI automatically. Unsupported commands or recursive
scripts fail collection instead of being silently skipped. The 153 suites at the
7 November 2026 refresh are spread across four jobs using measured median durations
from `scripts/ci-db-timings.json`, preserving their original relative order within
each job. Each suite reports its duration separately. Unmeasured suites receive a
15-second placement estimate (above the recorded 75th percentile of about 13.3 seconds).

Shard 1 also runs the frozen standalone candidate and installed conformance step
after its suites. The timing file records that step's measured median as a reserved
load for shard 1 of 4 (`reservations.reservedMs`), so the planner starts shard 1 at
that load and gives it fewer suites. The workflow, step order and the conformance
step itself are unchanged; the reservation only changes which suites shard 1 runs.
It is applied only to four-shard plans; other totals print
`reserved weights: none for N shard(s) (recorded for 4)`.

Web tests are collected with Playwright, including generated cases and nested
groups. `scripts/ci-web-timings.json` records medians from clean successful first attempts
in the linked CI runs. Long tests are assigned first to the least loaded shard;
tests with no recorded duration receive the existing six-second estimate. New or
renamed tests remain included. Durations affect placement only, never whether a
test runs. The current 374-test inventory has 373 measured identities and one
existing conditional skip, which retains its fallback rather than a zero weight.

The runner checks that every inventory entry occurs once and verifies each
generated `--test-list` against Playwright before executing it. This matters because
Playwright accepts a test list that matches nothing without failing the command.

## Planner output and timing artifacts

Database planning prints estimates, never measurements:

```text
db: 153 total suites/tests; shard 1/4: 20
Timing coverage: 153/153 measured, 0 fallback at 15000 ms, 0 obsolete; recorded 2026-11-07 (10 runs)
Estimated load ms per shard (suites + reserved): 595906 (58906 + 537000 reserved), 595942, 595011, 594986
```

When suites are unmeasured it adds `Unmeasured suites (15000 ms estimate): <ids>`;
without recorded reservations it adds `No reserved weights recorded`. Under GitHub
Actions each condition also raises one `::notice` per database job, so up to four
per run. A notice is not a failure. Web planning output is unchanged.

Every job uploads its selected test list and timing results, including on failure:

- `database-timings-N`: `db-results.json`, the measured duration and exit code of
  each suite that ran, plus `shard-plan.json`, the estimate (`estimate: true`,
  coverage, fallback IDs and per-shard suite, reserved and combined milliseconds).
  Compare the two to see how far the plan was from what actually ran. The
  conformance step's measured duration is in the jobs API, not in these files.
- `web-timings-N`: `web-results.json`, the standard Playwright JSON report.

Match web tests by browser project, path relative to the Playwright test
directory, and full title path; do not use line numbers. Database identities remain
the expanded workspace test paths.

## Missing, stale and invalid timings

Timing data affects placement only, never selection: every suite of the live
inventory is selected exactly once, whatever the file contains. None of these is
fatal: any coverage from 0 to 100 %, renamed or moved suites (old IDs become
obsolete, new IDs use the fallback), an empty `durationsMs`, expired CI artifacts,
missing `reservations` or a reservation recorded for another shard total. The
planner reports coverage, lists the fallback IDs and raises the notices above.

The planner (`loadTimingFile`, used for both the db and web files) fails before
collecting tests, creating output or starting a process only when the file is
unreadable or not JSON, is not an object, has no `durationsMs` object, holds any
non-numeric, non-finite or non-positive duration (obsolete IDs included), or has a
malformed `reservations` object (`{ total, reservedMs, basis }`, one non-negative
integer per shard). Restore the last importer output from git or rerun the importer.

The planner tolerates a file without `reservations`, but the committed file is held
to more: `node --test scripts/ci-shards.test.mjs` requires current importer output
(schema 2, a positive shard-1 reservation that equals the median of the recorded
per-run step durations) and that the actual CLI prints and applies it. Those tests
check internal consistency, not coverage or age.

A reservation that leaves a shard without suites is rejected. With the current
weights that happens only if the reservation grows beyond about 614 seconds (a
third of the suite total); it would fail the pull request that commits such a
refresh, not unrelated runs.

**Bootstrap.** After a rename, inventory growth or artifact expiry, the next run
plans with the fallback, runs every suite and uploads new-ID results. Any completed
successful run is a valid importer source; ten newest is the recommendation, one
is enough. No weight is typed by hand and no suite is skipped.

## Reproduce a timing refresh

`scripts/ci-timings.mjs` uses only Node's standard library and the existing
Playwright collector. Install the workspace's frozen dependencies first. Choose
completed, successful first attempts of `Quality`, then download the timing
artifacts and save their GitHub provenance, including the run attempt's jobs:

```sh
set -euo pipefail
timings_dir="<durable directory>"
for run in <run IDs>; do
  mkdir -p "$timings_dir/$run"
  gh run download "$run" --repo f-tuma/musubi --dir "$timings_dir/$run" \
    --pattern 'database-timings-*' --pattern 'web-timings-*'
  gh api "repos/f-tuma/musubi/actions/runs/$run" > "$timings_dir/$run/run.json"
  gh api --paginate "repos/f-tuma/musubi/actions/runs/$run/artifacts?per_page=100" \
    --jq '.artifacts[]' | jq -s '{artifacts: .}' > "$timings_dir/$run/artifacts.json"
  attempt="$(jq .run_attempt "$timings_dir/$run/run.json")"
  gh api "repos/f-tuma/musubi/actions/runs/$run/attempts/$attempt/jobs?per_page=100" \
    > "$timings_dir/$run/jobs.json"
done
(cd "$timings_dir" && find . -type f ! -name SHA256SUMS | sort | xargs sha256sum > SHA256SUMS)
node scripts/ci-timings.mjs db <YYYY-MM-DD> "$timings_dir"/<run IDs> > scripts/ci-db-timings.json
node scripts/ci-timings.mjs web <YYYY-MM-DD> "$timings_dir"/<run IDs> > scripts/ci-web-timings.json
```

These commands only read from GitHub. GitHub timing artifacts have seven-day
retention, so keep the downloaded directories, metadata and `SHA256SUMS` in a
durable location and record its path and hash in the pull request. Reviewers
rerun the importer on those directories and compare bytes; CI cannot repeat that
check after the artifacts expire. Each baseline records run ID/attempt/source SHA,
artifact ID and SHA256 of both the report and selected list. Refreshing reads local
files and the current inventory; it does not execute tests or contact providers.

The importer requires four complete, unambiguous shard artifacts from each
completed successful run. It verifies each report against its selected list and
rejects duplicate selections across shards or repeated source runs. Failed DB
results, skipped/expected-failure web cases and all retried web cases are excluded
from samples. Medians reduce the influence of unusually slow successful runs.
Obsolete identities are pruned against the current inventory; new or unmeasured
tests remain present with the runtime fallback. No test inventory is derived from
a timing file.

For database imports, `jobs.json` must contain exactly one `Database integration
(1/4)` job whose `run_id`, `head_sha` and `run_attempt` match `run.json` and which
succeeded, with exactly one successful `Frozen standalone candidate and installed
conformance` step. Its duration from the step timestamps is stored per source
(`sources[].reservation`); the median becomes `reservations.reservedMs[0]`. The
database file is schema version 2; the web file stays schema version 1.

## Expected balance and acceptance

The 7 November 2026 refresh used the ten newest successful first attempts
available then (runs 42267168855 to 42372307201). Applied to the unchanged
153-suite inventory, the offline estimate moves shard 1 from 38 to 20 suites,
because its conformance step (median 537 seconds) now counts as planned work:

| Plan | Shard 1 | Shards 2–4 |
| --- | --- | --- |
| Before: 26 October weights, no reservation | 38 suites, 467 s planned, plus conformance not counted | 38–39 suites, 467 s each |
| After: refreshed weights, reservation | 20 suites, 59 s + 537 s reserved = 596 s | 44–45 suites, 595–596 s each |

These are serial estimates, not measured job wall time. A replay of earlier runs
suggested the slowest database job could finish about five minutes sooner, with
Android then usually the last job; that is a simulation, not a result. Setup time,
runner speed and ordering effects are outside the model, and there is no guarantee
of a speedup. Measure actual job and step durations on later ordinary CI runs and
compare `shard-plan.json` with `db-results.json` before claiming savings. The four
database services, sequential suite execution, the frozen conformance step,
Playwright workers/retries and selection guards stay unchanged.

`node --test scripts/ci-shards.test.mjs` checks complete partitions, reservation
placement and validation, inventory expansion, unknown tests and obsolete weights,
coverage reporting, timing-file validation, duplicate detection, failed/retried
sample exclusion, provenance and jobs binding, the actual database CLI's lists and
accounting, the workflow binding and the committed file's consistency. `pnpm check`
and `pnpm test` do not run it; it runs in each of the eight CI database and web jobs
before planning, and locally only when invoked directly.
