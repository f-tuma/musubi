#!/bin/sh
set -eu
umask 077

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 /path/to/custom-format-backup.dump[.gz]" >&2
  exit 1
fi

musubi_backup_file=$1
if [ ! -r "$musubi_backup_file" ] || [ ! -s "$musubi_backup_file" ]; then
  echo "Backup is missing, unreadable, or empty: $musubi_backup_file" >&2
  exit 1
fi

musubi_database="musubi_restore_check"
musubi_image=${MUSUBI_RESTORE_IMAGE:-postgres:17-alpine}
musubi_restore_seconds=${MUSUBI_RESTORE_TIMEOUT_SECONDS:-900}
musubi_counts_sql=${MUSUBI_RESTORE_COUNTS_SQL:-}
musubi_expected_counts=${MUSUBI_RESTORE_EXPECTED_COUNTS:-}
musubi_counts_output=${MUSUBI_RESTORE_COUNTS_OUTPUT:-}
musubi_owned_id=

case "$musubi_restore_seconds" in
  ''|*[!0-9]*) echo "MUSUBI_RESTORE_TIMEOUT_SECONDS must be 1..86400." >&2; exit 1 ;;
esac
if [ "${#musubi_restore_seconds}" -gt 5 ] || [ "$musubi_restore_seconds" -lt 1 ] || [ "$musubi_restore_seconds" -gt 86400 ]; then
  echo "MUSUBI_RESTORE_TIMEOUT_SECONDS must be 1..86400." >&2
  exit 1
fi
if command -v timeout > /dev/null 2>&1; then
  musubi_timeout=timeout
elif command -v gtimeout > /dev/null 2>&1; then
  musubi_timeout=gtimeout
else
  echo "GNU timeout (or gtimeout) is required for bounded restore and cleanup." >&2
  exit 1
fi

if [ -n "$musubi_counts_sql$musubi_expected_counts$musubi_counts_output" ]; then
  if [ -z "$musubi_counts_sql" ] || [ -z "$musubi_expected_counts" ] ||
     [ ! -r "$musubi_counts_sql" ] || [ ! -s "$musubi_counts_sql" ] ||
     [ ! -r "$musubi_expected_counts" ] || [ ! -s "$musubi_expected_counts" ]; then
    echo "Set readable, nonempty MUSUBI_RESTORE_COUNTS_SQL and MUSUBI_RESTORE_EXPECTED_COUNTS together." >&2
    exit 1
  fi
  if [ -n "$musubi_counts_output" ] && { [ -e "$musubi_counts_output" ] || [ -L "$musubi_counts_output" ]; }; then
    echo "MUSUBI_RESTORE_COUNTS_OUTPUT must be a fresh private output path." >&2
    exit 1
  fi
fi

musubi_work_dir=$(mktemp -d "${TMPDIR:-/tmp}/musubi-restore-check.XXXXXXXXXX")

cleanup_restore_container() {
  musubi_exit_code=$?
  trap - EXIT HUP INT TERM
  if [ -n "$musubi_owned_id" ]; then
    # Stop first, without forced removal. On uncertainty leave this exact ID for
    # inspection instead of broadening cleanup to a name or another resource.
    if ! "$musubi_timeout" --kill-after=5s 20s docker stop -t 10 "$musubi_owned_id" > /dev/null 2>&1; then
      echo "Could not confirm stop of owned restore container $musubi_owned_id; inspect that ID." >&2
      musubi_exit_code=1
    elif ! "$musubi_timeout" --kill-after=5s 20s docker rm --volumes "$musubi_owned_id" > /dev/null 2>&1; then
      echo "Could not remove owned restore container $musubi_owned_id; inspect that ID." >&2
      musubi_exit_code=1
    fi
  fi
  rm -rf -- "$musubi_work_dir"
  exit "$musubi_exit_code"
}
trap cleanup_restore_container EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Detect format before creating anything. A complete decompression must succeed
# before pg_restore starts; a pipeline must not hide a failed gzip producer.
musubi_magic=$(od -An -tx1 -N5 "$musubi_backup_file" | tr -d ' \n')
case "$musubi_magic" in
  5047444d50) musubi_restore_input=$musubi_backup_file ;;
  1f8b*)
    musubi_restore_input="$musubi_work_dir/backup.dump"
    "$musubi_timeout" --kill-after=5s "${musubi_restore_seconds}s" gzip -cd -- "$musubi_backup_file" > "$musubi_restore_input"
    if [ "$(od -An -tx1 -N5 "$musubi_restore_input" | tr -d ' \n')" != 5047444d50 ]; then
      echo "Expected a PostgreSQL custom-format dump, optionally wrapped in gzip." >&2
      exit 1
    fi
    ;;
  *) echo "Expected a PostgreSQL custom-format dump, optionally wrapped in gzip." >&2; exit 1 ;;
esac
if [ -n "$musubi_counts_sql" ]; then
  cp -- "$musubi_counts_sql" "$musubi_work_dir/preservation.sql"
  cp -- "$musubi_expected_counts" "$musubi_work_dir/source-counts.txt"
fi

musubi_nonce=$(basename "$musubi_work_dir")
echo "Creating isolated restore container with label musubi.restore-check=$musubi_nonce." >&2
# No caller-supplied name or production mount. A failed create never authorizes
# cleanup, even if a name collides or the daemon's response is uncertain.
musubi_created_id=$("$musubi_timeout" --kill-after=5s 30s docker create \
  --network none \
  --label "musubi.restore-check=$musubi_nonce" \
  --tmpfs /var/lib/postgresql/data \
  --env PGDATA=/var/lib/postgresql/data \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  --env POSTGRES_DB="$musubi_database" \
  "$musubi_image")
case "$musubi_created_id" in
  ''|*[!a-f0-9]*) echo "Create did not return a valid full container ID; reconcile the labelled resource read-only." >&2; exit 1 ;;
esac
if [ "${#musubi_created_id}" -ne 64 ]; then
  echo "Create did not return a valid full container ID; reconcile the labelled resource read-only." >&2
  exit 1
fi
musubi_owned_id=$musubi_created_id
"$musubi_timeout" --kill-after=5s 30s docker start "$musubi_owned_id" > /dev/null

musubi_attempt=0
# The official image's temporary initialization server has TCP disabled. Socket
# readiness can otherwise race database creation and the final server restart.
until "$musubi_timeout" --kill-after=5s 5s docker exec "$musubi_owned_id" \
  pg_isready -h 127.0.0.1 -t 1 -U postgres -d "$musubi_database" > /dev/null 2>&1; do
  musubi_attempt=$((musubi_attempt + 1))
  if [ "$musubi_attempt" -ge 30 ]; then
    echo "Temporary PostgreSQL did not become ready." >&2
    exit 1
  fi
  sleep 1
done

"$musubi_timeout" --kill-after=5s "${musubi_restore_seconds}s" docker exec -i "$musubi_owned_id" pg_restore \
  --exit-on-error --no-owner --no-acl \
  -U postgres -d "$musubi_database" < "$musubi_restore_input"

musubi_table_count=$("$musubi_timeout" --kill-after=5s 30s docker exec "$musubi_owned_id" psql \
  -X -v ON_ERROR_STOP=1 -U postgres -d "$musubi_database" -Atc \
  "select count(*) from information_schema.tables where table_schema = 'public';")

case "$musubi_table_count" in
  ''|0|*[!0-9]*)
    echo "Restore completed without any public tables." >&2
    exit 1
    ;;
esac

if [ -n "$musubi_counts_sql" ]; then
  "$musubi_timeout" --kill-after=5s "${musubi_restore_seconds}s" docker exec -i "$musubi_owned_id" psql \
    -X -v ON_ERROR_STOP=1 -P pager=off -U postgres -d "$musubi_database" \
    < "$musubi_work_dir/preservation.sql" > "$musubi_work_dir/restored-counts.txt"
  if [ -n "$musubi_counts_output" ]; then
    # Atomic no-clobber creation: an existing file or symlink is never replaced.
    if ! (set -C; cat "$musubi_work_dir/restored-counts.txt" > "$musubi_counts_output"); then
      echo "Could not create the fresh preservation output; the existing destination was not replaced." >&2
      exit 1
    fi
  fi
  if ! cmp -s "$musubi_work_dir/source-counts.txt" "$musubi_work_dir/restored-counts.txt"; then
    echo "Restored preservation output differs from the supplied stopped-source baseline." >&2
    exit 1
  fi
  echo "Restored preservation output matches the supplied baseline."
else
  echo "Source journal/count comparison remains required; table presence alone is not preservation proof."
fi
echo "Restore completed in an isolated database ($musubi_table_count public tables)."
