#!/bin/sh
# Builds this platform's fx-runner executable twice, each time into a FRESH directory, and fails if the two differ (D#6 R6-5).
#
#   release-build.sh <work dir> [--strip-signature]
#
# Writes <work dir>/a/ and <work dir>/b/. <work dir>/a/ is what gets released. A fresh directory matters: the release manifest hashes every
# artifact-named file in its directory, so a file left over from an earlier build would be released. --strip-signature (macOS) compares the
# builds after `codesign --remove-signature`, since ad-hoc signing is not reproducible. SOURCE_DATE_EPOCH is the commit time.
set -eu

[ "$#" -ge 1 ] || { echo "usage: release-build.sh <work dir> [--strip-signature]" >&2; exit 2; }
work=$1
strip=${2:-}
here=$(cd "$(dirname "$0")" && pwd)
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)
export SOURCE_DATE_EPOCH

for name in a b; do
  node "$here/release-check.mjs" fresh-dir "$work/$name"
  node "$here/build-sea.mjs" --out-dir "$work/$name"
done
node "$here/release-check.mjs" compare "$work/a" "$work/b" $strip
