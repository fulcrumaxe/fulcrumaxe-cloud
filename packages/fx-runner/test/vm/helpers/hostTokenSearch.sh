#!/usr/bin/env bash
# Searches the helper's host directories, as root, for one token. Used by the real-VM job test through `sudo -n` on a dispatched
# hosted runner (D#587 3c-v); it is not part of the product and nothing installs it on a user's machine.
#
#   fx-host-token-search [dir ...]        the token is the first line of standard input
#
# With no directory it searches the helper's two root-only places: the jail root (the per-VM jails, their disks and sockets) and the
# snapshot directory (guest memory). The token is read from standard input and handed to grep on a pipe, so it is in no argument list
# (`ps` shows none), no file this script writes and no line it prints. It prints only counts and paths:
#
#   control=found           a planted copy of the token in a directory of this script's own was found (the search works)
#   dir=<path> files=<n>    each searched directory and how many regular files grep could have looked in (a vacuous pass shows 0)
#   result=clean            nothing holds the token          (exit 0)
#   result=found            a file holds it; the paths follow, one `hit=<path>` each (exit 1)
#   error=<what>            the search could not be trusted (exit 2 or 3)
set -euo pipefail
umask 077

IFS= read -r token || true
if [ "${#token}" -lt 16 ]; then
  echo "error=no token (a first line of at least 16 characters is needed on standard input)"
  exit 2
fi
dirs=("$@")
if [ "${#dirs[@]}" -eq 0 ]; then dirs=(/var/lib/fx-vm /var/lib/fx-vm-snapshots); fi

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

# -a: a disk image is binary; -F: the token is text, not a pattern; -D skip: no device, pipe or socket is read; -r does not follow links.
# grep answers 0 for a match, 1 for none and 2 for an error (an unreadable directory counts), and all three are told apart here.
search() {
  local rc=0
  printf '%s\n' "$token" | grep -rlaF -D skip -f - -- "$1" > "$scratch/out" 2> "$scratch/err" || rc=$?
  return "$rc"
}

# the control: the same search over a directory holding the token must find it, and must find nothing in one that does not
mkdir "$scratch/control"
printf 'x%sx' "$token" > "$scratch/control/planted"
printf 'no token here' > "$scratch/control/other"
rc=0
search "$scratch/control" || rc=$?
if [ "$rc" -ne 0 ] || [ "$(cat "$scratch/out")" != "$scratch/control/planted" ]; then
  echo "error=the control search did not find the planted token (grep exit $rc)"
  exit 3
fi
echo "control=found"

found=0
for dir in "${dirs[@]}"; do
  if [ ! -d "$dir" ]; then
    echo "error=$dir is not a directory"
    exit 3
  fi
  if ! find "$dir" -type f > "$scratch/list" 2> "$scratch/err"; then
    echo "error=$dir could not be listed: $(head -n 3 "$scratch/err")"
    exit 3
  fi
  files="$(wc -l < "$scratch/list")"
  echo "dir=$dir files=$files"
  rc=0
  search "$dir" || rc=$?
  case "$rc" in
    0)
      found=1
      sed 's/^/hit=/' "$scratch/out"
      ;;
    1) ;;
    *)
      echo "error=the search of $dir failed (grep exit $rc): $(head -n 3 "$scratch/err")"
      exit 3
      ;;
  esac
done

if [ "$found" -eq 1 ]; then
  echo "result=found"
  exit 1
fi
echo "result=clean"
