#!/bin/sh
set -eu

umask 077

musubi_repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
musubi_compose_file=${MUSUBI_COMPOSE_FILE:-"$musubi_repo_root/docker-compose.selfhost.yml"}
musubi_backup_dir=${MUSUBI_BACKUP_DIR:-"$musubi_repo_root/backups"}
musubi_retention_days=${MUSUBI_BACKUP_RETENTION_DAYS:-14}

case "$musubi_retention_days" in
  ''|*[!0-9]*)
    echo "MUSUBI_BACKUP_RETENTION_DAYS must be a whole number." >&2
    exit 1
    ;;
esac

case "$musubi_backup_dir" in
  ''|/)
    echo "Refusing to use an empty or root backup directory." >&2
    exit 1
    ;;
esac

if [ ! -f "$musubi_compose_file" ]; then
  echo "Compose file not found: $musubi_compose_file" >&2
  exit 1
fi

mkdir -p -- "$musubi_backup_dir"

musubi_timestamp=$(date -u +%Y%m%dT%H%M%SZ)
musubi_backup_file="$musubi_backup_dir/musubi-$musubi_timestamp.dump"
musubi_partial_file="$musubi_backup_file.partial"

cleanup_partial_backup() {
  rm -f -- "$musubi_partial_file"
}
trap cleanup_partial_backup EXIT HUP INT TERM

docker compose -f "$musubi_compose_file" exec -T db sh -ceu \
  'pg_dump -Fc --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > "$musubi_partial_file"

if [ ! -s "$musubi_partial_file" ]; then
  echo "PostgreSQL produced an empty backup." >&2
  exit 1
fi

# Reject a truncated or invalid custom-format dump before publishing it.
docker compose -f "$musubi_compose_file" exec -T db pg_restore --list \
  < "$musubi_partial_file" > /dev/null

mv -- "$musubi_partial_file" "$musubi_backup_file"
find "$musubi_backup_dir" -type f -name 'musubi-*.dump' \
  -mtime "+$musubi_retention_days" -delete

echo "Backup created: $musubi_backup_file"
