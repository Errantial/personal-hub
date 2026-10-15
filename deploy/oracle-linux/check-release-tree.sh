#!/usr/bin/env bash
set -euo pipefail
# No recursive traversal through links: npm's workspace/.bin links are expected,
# but their existing final destinations must stay within this staged release.
release=$(realpath -e -- "${1:?Pass a release directory}")
expected_uid=${2:-0}
[[ -d $release && $expected_uid =~ ^[0-9]+$ ]] || exit 1
violations=$(find -P "$release" -xdev \
  \( ! -uid "$expected_uid" -o \( ! -type l -perm /022 \) \) -print -quit) || exit 1
[[ -z $violations ]] || {
  echo 'Staged release must have the expected owner and no writable files/directories.' >&2; exit 1;
}
while IFS= read -r -d '' link; do
  target=$(realpath -e -- "$link") || {
    echo 'Broken release symlink.' >&2; exit 1;
  }
  [[ $target == "$release/"* ]] || {
    echo 'Release symlink escapes the staged directory.' >&2; exit 1;
  }
done < <(find -P "$release" -xdev -type l -print0)
