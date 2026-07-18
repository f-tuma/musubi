#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 /path/to/musubi-backup.dump-or.sql.gz" >&2
  exit 1
fi

musubi_backup_file=$1
if [ ! -r "$musubi_backup_file" ] || [ ! -s "$musubi_backup_file" ]; then
  echo "Backup is missing, unreadable, or empty: $musubi_backup_file" >&2
  exit 1
fi

musubi_container="musubi-restore-check-$$"
musubi_database="musubi_restore_check"

cleanup_restore_container() {
  docker rm --force "$musubi_container" > /dev/null 2>&1 || true
}
trap cleanup_restore_container EXIT HUP INT TERM

docker run --detach --rm \
  --name "$musubi_container" \
  --tmpfs /var/lib/postgresql/data \
  --env POSTGRES_PASSWORD=restore-check-only \
  --env POSTGRES_DB="$musubi_database" \
  postgres:17-alpine > /dev/null

musubi_attempt=0
until docker exec "$musubi_container" \
  pg_isready -U postgres -d "$musubi_database" > /dev/null 2>&1; do
  musubi_attempt=$((musubi_attempt + 1))
  if [ "$musubi_attempt" -ge 30 ]; then
    echo "Temporary PostgreSQL did not become ready." >&2
    exit 1
  fi
  sleep 1
done

if gzip -t "$musubi_backup_file" > /dev/null 2>&1; then
  gzip -cd -- "$musubi_backup_file" | docker exec -i "$musubi_container" pg_restore \
    --exit-on-error --no-owner --no-acl \
    -U postgres -d "$musubi_database"
else
  docker exec -i "$musubi_container" pg_restore \
    --exit-on-error --no-owner --no-acl \
    -U postgres -d "$musubi_database" < "$musubi_backup_file"
fi

musubi_table_count=$(docker exec "$musubi_container" psql \
  -U postgres -d "$musubi_database" -Atc \
  "select count(*) from information_schema.tables where table_schema = 'public';")

case "$musubi_table_count" in
  ''|0|*[!0-9]*)
    echo "Restore completed without any public tables." >&2
    exit 1
    ;;
esac

echo "Restore verified in an isolated database ($musubi_table_count public tables)."
