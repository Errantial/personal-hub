#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
umask 077
/usr/local/sbin/personal-hub-backup
dump=$(find /var/backups/personal-hub -maxdepth 1 -name '*.dump' -type f | sort | tail -1)
[[ -n $dump ]] || exit 1
sha256sum --check "$dump.sha256"
database="hub_restore_check_$(date -u +%Y%m%d%H%M%S)_$RANDOM"
[[ $database =~ ^hub_restore_check_[0-9]+_[0-9]+$ ]] || exit 1
runuser -u postgres -- createdb "$database"
trap 'runuser -u postgres -- dropdb --if-exists "$database"' EXIT
runuser -u postgres -- pg_restore --exit-on-error --no-owner --dbname="$database" < "$dump"
query="SELECT string_agg(name || ':' || checksum, ',' ORDER BY name) FROM schema_migrations"
original=$(runuser -u postgres -- psql -d hub -Atqc "$query")
restored=$(runuser -u postgres -- psql -d "$database" -Atqc "$query")
[[ -n $original && $original == "$restored" ]] || { echo 'Migration manifest mismatch.' >&2; exit 1; }
runuser -u postgres -- psql -d "$database" -v ON_ERROR_STOP=1 -qc "CREATE TABLE restore_probe (receipt text); INSERT INTO restore_probe VALUES ('synthetic-restore-check');"
smoke=$(mktemp)
trap 'rm -f -- "$smoke"; runuser -u postgres -- dropdb --if-exists "$database"' EXIT
runuser -u postgres -- pg_dump --format=custom --dbname="$database" > "$smoke"
runuser -u postgres -- psql -d "$database" -v ON_ERROR_STOP=1 -qc 'DROP TABLE restore_probe;'
runuser -u postgres -- pg_restore --exit-on-error --no-owner --table=restore_probe --dbname="$database" < "$smoke"
receipt=$(runuser -u postgres -- psql -d "$database" -Atqc 'SELECT receipt FROM restore_probe')
[[ $receipt == synthetic-restore-check ]] || exit 1
echo 'Restore verified in an isolated database: schema manifest and synthetic receipt match.'
