#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
release=$(realpath -e -- "${1:?Pass the staged release directory}")
commit=${2:?Pass the full tested commit hash}
tree=${3:?Pass the full tested tree hash}
applied=${4:?Pass the applied migration manifest JSON}
[[ $release == /srv/personal-hub/releases/* && -d $release && ! -L $1 ]] || exit 1
directory=$(cd -- "$(dirname -- "$0")" && pwd)
node=/opt/personal-hub/node/bin/node
# Production configuration is never loaded or copied into the release.
[[ $(stat -c '%U:%a' /etc/personal-hub/hub.env) == root:600 ]] || {
  echo 'Production environment must remain root-owned mode 0600.' >&2; exit 1;
}
[[ $("$node" -p 'process.versions.node.split(".")[0]') == 24 ]] || exit 1
# Reject writable artifacts; dependency resolution happens under the actual users.
bash "$directory/check-release-tree.sh" "$release" 0
"$node" "$directory/release-check.mjs" verify "$release" "$commit" "$tree"
"$node" "$directory/release-check.mjs" migrations "$release" "$applied"
runuser -u hub -- env -i PATH=/opt/personal-hub/node/bin:/usr/bin:/bin \
  "$node" --input-type=module - "$release" <<'JS'
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const manifest = JSON.parse(await readFile(`${root}/release-manifest.json`, 'utf8'));
for (const path of Object.keys(manifest.files)) await access(`${root}/${path}`, constants.R_OK);
// app.js defines the application; unlike server.js it neither starts workers nor
// opens the database. Its import resolves the production dependency graph.
await import(pathToFileURL(`${root}/apps/api/dist/app.js`).href);
await import(pathToFileURL(`${root}/packages/contracts/dist/index.js`).href);
JS
runuser -u hub-caddy -- env -i PATH=/usr/bin:/bin /bin/bash -s -- "$release" <<'SH'
set -euo pipefail
cd -- "$1/apps/web/dist"
[[ -r index.html && -r sw.js ]]
# Capture traversal failure too; process-substitution errors do not fail a loop.
files=$(find . -type f -print)
while IFS= read -r file; do [[ -r $file ]]; done <<< "$files"
SH
echo 'Staged artifact, service-user imports, static readability and migration preflight passed.'
echo 'No database migration, activation, readiness check or provider request was performed.'
