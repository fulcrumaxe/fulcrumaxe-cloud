#!/bin/sh
# Moves the signed update metadata to and from the `tuf-metadata` release (D#6 R6-5). POSIX sh; needs `gh` and GITHUB_REPOSITORY (and a token for publish).
#
#   release-metadata.sh fetch   <dir> [true|false]   download the current metadata files into <dir>. The third argument says whether this
#                                                    is the FIRST release (default false).
#   release-metadata.sh publish <dir>                upload every file in <dir>, TIMESTAMP LAST: a client reads timestamp.json first, so every
#                                                    file it points to is already there when it appears
#
# Fetch fails closed. Only an HTTP 404 from the API means "there is no metadata release"; a network error, a rate limit, an auth error or
# a 5xx stops the job. And even a 404 is accepted only when the caller said this is the first release; otherwise a missing release stops
# the job, so a failed read can never start the metadata again at version 1 and overwrite the live files. A first release is refused when
# a metadata release already exists. What fetch downloads is never trusted on its own: the caller runs `tuf-release.mjs check
# --trusted-root` on it before signing.
set -eu

TAG=tuf-metadata
usage() {
  echo "usage: release-metadata.sh <fetch|publish> <dir> [true|false]" >&2
  exit 2
}
{ [ "$#" -eq 2 ] || [ "$#" -eq 3 ]; } || usage
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
command=$1
dir=$2
first=${3:-false}
case $first in true | false) ;; *) usage ;; esac

case $command in
  fetch)
    mkdir -p "$dir"
    if answer=$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$TAG" 2>&1); then
      if [ "$first" = true ]; then
        echo "release-metadata: a first release was requested, but the $TAG release already exists" >&2
        exit 1
      fi
      gh release download "$TAG" --repo "$GITHUB_REPOSITORY" --dir "$dir" --pattern '*.json'
      [ -f "$dir/timestamp.json" ] || { echo "release-metadata: the $TAG release has no timestamp.json" >&2; exit 1; }
    elif printf '%s' "$answer" | grep -q 'HTTP 404'; then
      if [ "$first" != true ]; then
        echo "release-metadata: there is no $TAG release; if this is the first release, say so explicitly" >&2
        exit 1
      fi
    else
      echo "release-metadata: could not read the $TAG release; stopping rather than treating it as absent" >&2
      exit 1
    fi
    ;;
  publish)
    [ -f "$dir/timestamp.json" ] || { echo "release-metadata: $dir has no timestamp.json" >&2; exit 1; }
    if ! gh release view "$TAG" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
      gh release create "$TAG" --repo "$GITHUB_REPOSITORY" --title "Update metadata" --notes "Signed update metadata for fx-runner. Do not edit by hand." --latest=false
    fi
    for file in "$dir"/*.json; do
      [ "$(basename "$file")" = timestamp.json ] && continue
      gh release upload "$TAG" "$file" --repo "$GITHUB_REPOSITORY" --clobber
    done
    gh release upload "$TAG" "$dir/timestamp.json" --repo "$GITHUB_REPOSITORY" --clobber
    ;;
  *) usage ;;
esac
