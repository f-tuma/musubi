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
scripts fail collection instead of being silently skipped. The 107 suites recorded
on 15 October 2026 are spread across four jobs using measured median durations
from `scripts/ci-db-timings.json`, preserving their original relative order within
each job. Each suite reports its duration separately. New suites receive a
15-second estimate (above the recorded 75th percentile of about 13.3 seconds).

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

## Timing artifacts

Every job uploads its selected test list and timing results, including on failure:

- `database-timings-N`: `db-results.json`, one duration and exit code per suite.
- `web-timings-N`: `web-results.json`, the standard Playwright JSON report.

When a shard becomes substantially slower, refresh the baselines from successful
runs. Match web tests by browser project, path relative to the Playwright test
directory, and full title path; do not use line numbers. Database identities remain
the expanded workspace test paths.

## Reproduce a timing refresh

`scripts/ci-timings.mjs` uses only Node's standard library and the existing
Playwright collector. Install the workspace's frozen dependencies first. Download
all eight timing artifacts and save their GitHub provenance for each chosen run:

```sh
set -euo pipefail
timings_dir="$(mktemp -d)"
for run in 38648695477 38699859322 38699939142 38705288280; do
  mkdir -p "$timings_dir/$run"
  gh run download "$run" --repo f-tuma/musubi --dir "$timings_dir/$run" \
    --pattern 'database-timings-*' --pattern 'web-timings-*'
  gh api "repos/f-tuma/musubi/actions/runs/$run" > "$timings_dir/$run/run.json"
  gh api --paginate "repos/f-tuma/musubi/actions/runs/$run/artifacts?per_page=100" \
    --jq '.artifacts[]' | jq -s '{artifacts: .}' > "$timings_dir/$run/artifacts.json"
done
node scripts/ci-timings.mjs db 2026-10-15 "$timings_dir"/* > scripts/ci-db-timings.json
node scripts/ci-timings.mjs web 2026-10-15 "$timings_dir"/* > scripts/ci-web-timings.json
```

Retain the downloaded reports with the run/artifact metadata when longer-lived
reproduction is needed; GitHub timing artifacts have seven-day retention. Each
baseline records run ID/attempt/source SHA, artifact ID and SHA256 of both the
report and selected list. Refreshing reads local files and the current inventory;
it does not execute tests or contact providers.

The importer requires four complete, unambiguous shard artifacts from each
completed successful run. It verifies each report against its selected list and
rejects duplicate selections across shards or repeated source runs. Failed DB
results, skipped/expected-failure web cases and all retried web cases are excluded
from samples. Medians reduce the influence of unusually slow successful runs.
Obsolete identities are pruned against the current inventory; new or unmeasured
tests remain present with the runtime fallback. The refresh replaces the old web
baseline's 330 entries, including 13 obsolete identities, with 373 current clean
measurements. No test inventory is derived from a timing file.

## Expected balance and acceptance

The four successful source runs above supplied 32 timing artifacts. Applying the
new medians to the unchanged current inventory gives this offline model:

| Inventory | Slowest old shard's weighted work | Slowest new shard's weighted work |
| --- | ---: | ---: |
| Database, 107 suites | 385.8 seconds | 298.0 seconds |
| Web, 374 cases | 789.1 seconds | 736.9 seconds |

These sums are serial case weights, not measured job wall time. Web workers run
concurrently; startup, browser/server setup, queues and retries are also outside
this model. Verify actual job durations and all existing checks on the next CI
run before claiming elapsed-time savings. The four database services, sequential
suite execution, Playwright workers/retries and selection guards stay unchanged.

`node --test scripts/ci-shards.test.mjs` checks complete partitions, inventory
expansion, unknown tests and obsolete weights, duplicate detection, failed/retried
sample exclusion, provenance rejection and incomplete Playwright selections.
