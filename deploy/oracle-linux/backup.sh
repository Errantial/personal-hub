#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
umask 077
destination=/var/backups/personal-hub
install -d -m 0700 "$destination"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dump="$destination/$stamp.dump"
[[ ! -e "$dump" ]] || { echo 'Backup name already exists.' >&2; exit 1; }
runuser -u postgres -- pg_dump --format=custom --dbname=hub > "$dump.partial"
pg_restore --list "$dump.partial" >/dev/null
mv -- "$dump.partial" "$dump"
install -m 0600 /etc/personal-hub/hub.env "$destination/$stamp.env"
sha256sum "$dump" > "$dump.sha256"
echo "Backup completed: $stamp"
