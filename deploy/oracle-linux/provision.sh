#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
domain=${1:?Pass the HTTPS hostname}
[[ $domain =~ ^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$ ]] || exit 1
[[ $(uname -m) == aarch64 ]] || { echo 'ARM64 host required.' >&2; exit 1; }
directory=$(cd -- "$(dirname -- "$0")" && pwd)
dnf module install -y postgresql:16/server
install -d -m 0755 /opt/personal-hub /srv/personal-hub/releases
install -d -m 0755 /etc/personal-hub
if ! id hub >/dev/null 2>&1; then useradd --system --home-dir /srv/personal-hub --shell /sbin/nologin hub; fi
if ! id hub-caddy >/dev/null 2>&1; then useradd --system --home-dir /var/lib/personal-hub-caddy --shell /sbin/nologin hub-caddy; fi
# hub cannot write its root-owned home; give npm installs their own cache.
install -d -o hub -g hub -m 0700 /var/cache/personal-hub/npm
printf 'cache=/var/cache/personal-hub/npm\nupdate-notifier=false\nfund=false\n' >/srv/personal-hub/.npmrc
chmod 0644 /srv/personal-hub/.npmrc
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
cd "$work"
node_version=24.21.0
node_archive="node-v$node_version-linux-arm64.tar.xz"
curl -fsSLO "https://nodejs.org/dist/v$node_version/$node_archive"
curl -fsSLO "https://nodejs.org/dist/v$node_version/SHASUMS256.txt"
awk -v file="$node_archive" '$2 == file' SHASUMS256.txt | sha256sum --check --strict -
tar -xJf "$node_archive" -C /opt/personal-hub
ln -sfn "node-v$node_version-linux-arm64" /opt/personal-hub/node
export PATH=/opt/personal-hub/node/bin:/usr/sbin:/usr/bin:/sbin:/bin
caddy_version=2.11.7
caddy_archive="caddy_${caddy_version}_linux_arm64.tar.gz"
curl -fsSLO "https://github.com/caddyserver/caddy/releases/download/v$caddy_version/$caddy_archive"
curl -fsSLO "https://github.com/caddyserver/caddy/releases/download/v$caddy_version/caddy_${caddy_version}_checksums.txt"
awk -v file="$caddy_archive" '$2 == file' "caddy_${caddy_version}_checksums.txt" | sha512sum --check --strict -
tar -xzf "$caddy_archive" caddy
install -m 0755 caddy /opt/personal-hub/caddy
if [[ ! -f /var/lib/pgsql/data/PG_VERSION ]]; then postgresql-setup --initdb; fi
systemctl enable --now postgresql
role_count=$(runuser -u postgres -- psql -Atqc "SELECT count(*) FROM pg_roles WHERE rolname='hub'")
if [[ $role_count == 0 ]]; then
  runuser -u postgres -- createuser hub
fi
database_count=$(runuser -u postgres -- psql -Atqc "SELECT count(*) FROM pg_database WHERE datname='hub'")
if [[ $database_count == 0 ]]; then
  runuser -u postgres -- createdb --owner=hub hub
fi
if [[ ! -f /etc/personal-hub/hub.env ]]; then
  umask 077
  {
    echo NODE_ENV=production
    echo API_HOST=127.0.0.1
    echo API_PORT=3001
    echo 'DATABASE_URL=postgresql://hub@localhost/hub?host=/var/run/postgresql'
    echo "WEB_ORIGINS=https://$domain"
    echo LOG_LEVEL=info
    echo 'AI_PROVIDER_PROFILES=[]'
    printf 'SETUP_TOKEN='
    openssl rand -hex 32
  } > /etc/personal-hub/hub.env
fi
printf 'HUB_DOMAIN=%s\n' "$domain" > /etc/personal-hub/caddy.env
chmod 0600 /etc/personal-hub/hub.env
chmod 0644 /etc/personal-hub/caddy.env
install -m 0644 "$directory/Caddyfile" /etc/personal-hub/Caddyfile
for unit in personal-hub.service personal-hub-caddy.service personal-hub-backup.service personal-hub-backup.timer; do
  install -m 0644 "$directory/$unit" "/etc/systemd/system/$unit"
done
install -m 0755 "$directory/backup.sh" /usr/local/sbin/personal-hub-backup
systemctl daemon-reload
/opt/personal-hub/node/bin/node --version
/opt/personal-hub/node/bin/npm --version
psql --version
/opt/personal-hub/caddy version
echo 'Provisioned. Setup token is stored only in the root-readable server environment file.'
