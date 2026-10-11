#!/usr/bin/env bash
# fetch-pin.sh <path in lock.json> <destination>: downloads the pinned URL and deletes the file, failing, if its sha256 differs.
# The path is a jq path to an object with `url` and `sha256`, for example `.tools.crane` or `.kernel.amd64`.
set -euo pipefail
lock="$(dirname "${BASH_SOURCE[0]}")/lock.json"
url="$(jq -er "$1.url" "$lock")"
sha="$(jq -er "$1.sha256" "$lock")"
curl -fsSL --retry 3 -o "$2" "$url"
echo "$sha  $2" | sha256sum -c - >/dev/null || { rm -f "$2"; echo "fetch-pin: sha256 mismatch for $1" >&2; exit 1; }
