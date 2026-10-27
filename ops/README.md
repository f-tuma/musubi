# PostgreSQL backup verification

`backup-postgres.sh` creates a custom-format archive from the selected Compose
stack. Before using it, select the correct Docker daemon/context, Compose file
and `COMPOSE_PROJECT_NAME`. Stop all application writers/consumers for a release
baseline and retain the dump checksum privately. See the current
[release runbook](../docs/releases/0.2.12-readiness.md) for maintenance and recovery.

`verify-postgres-backup.sh /absolute/path/to/backup.dump` restores a trusted
custom-format PostgreSQL dump, optionally wrapped in gzip, into a newly created
isolated container. Plain SQL text is not a supported input. Docker, GNU
`timeout` (or `gtimeout` on macOS), gzip and standard core utilities are required.

The helper uses no published port, host data mount or container network. It
places `PGDATA` on its own tmpfs, waits for the final PostgreSQL server over TCP
([the image's temporary init server disables TCP](https://github.com/docker-library/postgres/blob/master/docker-entrypoint.sh)),
and sends the dump through stdin. Cleanup stops and removes only the validated
full ID [returned by this invocation's successful create](https://docs.docker.com/reference/cli/docker/container/create/);
it never force-removes a name. [Anonymous volumes associated with that owned
container are removed too](https://docs.docker.com/reference/cli/docker/container/rm/).
The private working directory is removed on normal/trappable exit paths.

Creation failures, malformed/uncertain responses and cleanup failures return a
nonzero status. Inspect only the printed unique label or exact owned ID when
reconciling an uncertain result; do not broaden cleanup to matching names or
unrelated containers. A killed process or lost Docker response can leave an
owned resource for operator inspection.

The default image is `postgres:17-alpine` for existing local usage. For release
evidence set `MUSUBI_RESTORE_IMAGE` to an approved immutable PostgreSQL image
digest compatible with the dump. Creation/start/query calls and cleanup have
finite timeouts. Readiness has at most 30 TCP probes. Restore/decompression and
preservation SQL each default to 900 seconds; `MUSUBI_RESTORE_TIMEOUT_SECONDS`
accepts 1 through 86400. A timeout is a failure, not proof of an invalid backup.

## Compare preservation evidence

A successful restore plus a nonempty public schema does **not** prove source
data preservation. Capture a reviewed read-only SQL query's deterministic output
from the stopped source immediately before taking the dump. Include its ordered
migration journal and the relevant content-free table/queue aggregates. Use
explicit ordering, time zone and date formatting consistently.

Set both `MUSUBI_RESTORE_COUNTS_SQL` and `MUSUBI_RESTORE_EXPECTED_COUNTS` to run
that same SQL against the isolated restore and require an exact byte comparison.
An optional `MUSUBI_RESTORE_COUNTS_OUTPUT` saves the restored output at a fresh
private path for inspection, including on mismatch. An existing file/symlink is
never replaced. For example, after selecting the actual dump and approved image:

```sh
MUSUBI_RESTORE_IMAGE='postgres@sha256:<approved-image-digest>' \
MUSUBI_RESTORE_COUNTS_SQL='/private/release/preservation.sql' \
MUSUBI_RESTORE_EXPECTED_COUNTS='/private/release/source-counts.txt' \
MUSUBI_RESTORE_COUNTS_OUTPUT='/private/release/restored-counts.txt' \
./ops/verify-postgres-backup.sh '/private/release/musubi-<actual-timestamp>.dump'
```

Keep the SQL, baseline, restored output, dump/checksum and logs private. Agreement
proves only the supplied checks, not every application/provider behavior or the
restorability of media/configuration/keys. A DB restore does not undo already
delivered provider writes.

## Fast development checks

```sh
pnpm test:behavior --suite postgres-restore --scenario create-failure --json
pnpm test:behavior --suite postgres-restore --json
node --test scripts/verify-postgres-backup.test.mjs
```

The JSON driver executes the shipped shell helper with Docker/sleep command
ports replaced by strict ordered receipts. It never contacts a Docker daemon.
It covers resource ownership, deadlines/signals, archive failures and comparison
failures; it does not establish actual PostgreSQL or production restore success.
