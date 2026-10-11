#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "This pinned binary setup currently supports Linux x86_64 only." >&2
  exit 1
fi

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
archive_path="${TMPDIR:-/tmp}/brewlog-crsqlite-v0.16.3.zip"
expected_sha="8f6fd31a2be2ba8c3101aad067a504a2e63c8e9b51cc4ace786009c02e7ecbae"
url="https://github.com/vlcn-io/cr-sqlite/releases/download/v0.16.3/crsqlite-linux-x86_64.zip"

curl -fsSL "$url" -o "$archive_path"
printf '%s  %s\n' "$expected_sha" "$archive_path" | sha256sum --check --status
mkdir -p "$root_dir/vendor"
unzip -o -q "$archive_path" crsqlite.so -d "$root_dir/vendor"
echo "Installed vendor/crsqlite.so"
