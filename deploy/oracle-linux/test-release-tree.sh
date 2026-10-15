#!/usr/bin/env bash
set -euo pipefail
directory=$(cd -- "$(dirname -- "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
release="$work/release"
mkdir -p "$release/node_modules/.bin" "$release/apps/api" "$release/packages/contracts"
printf 'synthetic\n' > "$release/apps/api/entry.js"
chmod -R u=rwX,go=rX "$work"
if ! ln -s ../../apps/api/entry.js "$release/node_modules/.bin/hub-entry" 2>/dev/null; then
  echo 'SKIP: this host cannot create Unix symlinks; run fixture on Linux.'
  exit 0
fi
[[ -L $release/node_modules/.bin/hub-entry ]] || {
  echo 'SKIP: this host copies symlinks; run fixture on Linux.'; exit 0;
}
ln -s ../packages/contracts "$release/node_modules/contracts"
bash "$directory/check-release-tree.sh" "$release" "$EUID"
chmod o+w "$release/apps/api/entry.js"
if bash "$directory/check-release-tree.sh" "$release" "$EUID" 2>/dev/null; then
  echo 'Writable-file check failed.' >&2; exit 1;
fi
chmod o-w "$release/apps/api/entry.js"
ln -s "$work" "$release/node_modules/escape"
if bash "$directory/check-release-tree.sh" "$release" "$EUID" 2>/dev/null; then
  echo 'External-link check failed.' >&2; exit 1;
fi
rm -- "$release/node_modules/escape"
ln -s missing "$release/node_modules/broken"
if bash "$directory/check-release-tree.sh" "$release" "$EUID" 2>/dev/null; then
  echo 'Broken-link check failed.' >&2; exit 1;
fi
echo 'Release tree fixtures passed: npm links, writable file, escaped link, broken link.'
