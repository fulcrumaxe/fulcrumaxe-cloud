#!/bin/sh
# Compares the assets of the DRAFT release for a tag with the files the build produced, byte for byte (D#6 R6-5). POSIX sh; needs `gh`,
# GITHUB_REPOSITORY and a token.
#
#   release-verify-draft.sh <tag> <files dir> <scratch dir>
#
# A draft can wait hours for the owner's approval, and anyone with write access could swap an asset in that time (install.sh is trusted
# by HTTPS to GitHub, not by the signed metadata). The sign job runs this just before publishing. Exit 0 only when there is exactly one
# draft for the tag and it holds exactly the same file names with exactly the same bytes; anything else, including any API error, is 1.
set -eu

[ "$#" -eq 3 ] || { echo "usage: release-verify-draft.sh <tag> <files dir> <scratch dir>" >&2; exit 2; }
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
tag=$1
files=$2
scratch=$3
refuse() {
  echo "release-verify-draft: $1" >&2
  exit 1
}

ids=$(gh api "repos/$GITHUB_REPOSITORY/releases" --paginate --jq ".[] | select(.draft and .tag_name == \"$tag\") | .id") || refuse "could not list the releases"
[ -n "$ids" ] && [ "$(printf '%s\n' "$ids" | wc -l)" -eq 1 ] || refuse "expected exactly one draft release for $tag"
assets=$(gh api "repos/$GITHUB_REPOSITORY/releases/$ids" --jq '.assets[] | "\(.id) \(.name)"') || refuse "could not read the draft's assets"

mkdir -p "$scratch"
names=
while read -r asset_id name; do
  [ -n "$asset_id" ] || continue
  case $name in */* | .*) refuse "unexpected asset name" ;; esac
  gh api -H "Accept: application/octet-stream" "repos/$GITHUB_REPOSITORY/releases/assets/$asset_id" >"$scratch/$name" || refuse "could not download $name"
  [ -f "$files/$name" ] || refuse "the draft holds $name, which the build did not produce"
  cmp -s "$files/$name" "$scratch/$name" || refuse "$name differs from the built file"
  names="$names $name"
done <<EOF
$assets
EOF

for built in "$files"/*; do
  case " $names " in *" $(basename "$built") "*) ;; *) refuse "the draft is missing $(basename "$built")" ;; esac
done
