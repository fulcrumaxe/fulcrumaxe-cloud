# Importing fulcrumaxe workspace from jpos

`fulcrumaxe workspace` is a modified copy (a fork) of the fulcrumaxe-os
frontend, imported once from a pinned `jpos` commit and then maintained here.
`jpos` itself is never changed, and no PR is ever opened against it (D#37,
owner decision, comment 18493387). This document is the procedure for that
import and for every later re-import.

## Who runs this, and where

Only the **Team Lead** touches the local `<jpos-checkout>`. Executors never do: an
executor's worktree is isolated by design, and the sandbox blocks writes
outside it. The importer itself (`import.mjs`) never reads `<jpos-checkout>`
either -- it only ever reads a tar file it is handed.

## Step 1: the Team Lead produces the tar

From the main checkout, not from any executor's worktree:

```bash
git -C <jpos-checkout> merge-base --is-ancestor <sha> origin/main
```

This must succeed (exit 0) before anything else runs: it proves `<sha>` is
really on `jpos`'s `main` history, not an abandoned branch or a local-only
commit. Then:

```bash
git -C <jpos-checkout> archive --format=tar -o <scratch>/jpos-<sha>.tar <sha> \
  crates/fulc-shell/assets
```

The pathspec at the end (`crates/fulc-shell/assets`) limits the archive to
the importer's anchor (security review finding E5): everything the tar
contains is a regular file under that path, or a directory/pax-header entry,
so there is nothing left in the tar for a reader with access to it to see
outside the anchor -- the allowlist then controls what actually gets
*extracted* from that already-narrowed set. A pathspec-limited `git archive`
still writes the pax global `comment=<commit>` record (verified empirically:
`comment` is a property of the archive as a whole, not of any one path in
it), so the sha pin below keeps working unchanged. `import.mjs` also refuses
any tar that contains a regular file outside the anchor, so an un-narrowed
tar -- one produced without this pathspec -- is rejected outright rather
than silently accepted.

`<scratch>` is a Team-Lead-owned scratch directory, never a location inside
an executor's worktree. `git archive` reads the object store for `<sha>`,
never the working tree -- so untracked files such as `.env`,
`.env.bak-quotefix`, `prod.env` and `local.env` cannot enter the
tar even if they exist on disk at `<jpos-checkout>`. The tar it writes also
carries a pax global header recording `<sha>` as its `comment` record; the
importer checks that record against the `--sha` you pass it and refuses the
tar if they disagree, so the tar cannot be silently swapped for a different
commit's output between being produced and being imported.

Compute the tar's own sha256 and record it alongside `<sha>` and the origin
URL -- the importer's `--tar-sha256` flag pins the tar's bytes the same way
`--sha` pins its recorded commit id, so a tar swapped in transit after this
step (even one whose commit id still matches, if its producer forged that
too) is caught rather than silently imported:

```bash
sha256sum <scratch>/jpos-<sha>.tar
```

Record the origin URL at the same time -- the Team Lead knows it.
The Team Lead hands the executor: the tar's path, `<sha>`, its sha256, and
the origin URL.

## Step 2: the executor runs the importer

From inside the executor's own worktree, with no environment inherited:

```bash
env -i PATH="$PATH" node apps/workspace/import/import.mjs \
  --tar <scratch>/jpos-<sha>.tar \
  --sha <sha> \
  --tar-sha256 <sha256 of the tar> \
  --origin <origin-url> \
  --out apps/workspace/shell \
  --checked-by "<who ran the merge-base check above>"
```

The importer:

1. Refuses if `--tar` is a directory, isn't a tar file, `--tar-sha256`
   isn't exactly 64 hex characters or doesn't match the tar's own sha256,
   `--sha` isn't 40 hex characters, the tar's own recorded commit id is
   missing or doesn't match `--sha`, or the tar contains a regular file
   outside the `crates/fulc-shell/assets/` anchor.
2. Extracts only the paths listed in `allowlist.txt` (anchored at
   `crates/fulc-shell/assets/` inside the tar) into `--out`. Every other tar
   entry -- `.env` files, `secrets/`, the terminal, the file manager, and
   anything else not on the allowlist -- is never written to disk. Every
   selected path and its content are also checked against the same
   secret/dotfile rules `checks.mjs` re-audits afterward, *before* any file
   is written: a hit on any one of them refuses the whole import, with
   nothing written.
3. Stages the write into a temporary directory next to `--out` and renames
   it into place in one step, so a mid-run failure never leaves a partial
   tree, and a re-import never leaves a file from the previous import that
   upstream has since removed.
4. Writes `BUILD-INFO.json` next to `--out` (by default,
   `apps/workspace/BUILD-INFO.json`) recording `jpos_sha`, `origin_url`,
   `ancestor_of_main_checked_by`, the tar's own sha256, `imported_at`, and a
   `sha256` for every extracted file.

Then run the checks the build will run, so failures surface before a PR:

```bash
node apps/workspace/import/checks.mjs --import apps/workspace/shell
```

This must exit 0. If it doesn't, the allowlist or the tar is wrong --
fix the allowlist (never hand-edit past the check) and re-run the import.

## `--verify`: re-checking an imported tree against its tar

```bash
node apps/workspace/import/import.mjs --verify --tar <scratch>/jpos-<sha>.tar \
  --tar-sha256 <sha256 of the tar>
```

`--tar-sha256` is required, exactly as it is for a plain import: pass the
same independently-known sha256 you recorded for this tar in Step 1, not a
value read back out of `BUILD-INFO.json`. `--verify` refuses immediately if
the tar's actual bytes don't match it, *before* looking at `BUILD-INFO.json`
at all -- otherwise the only thing pinning the tar's bytes would be a field
carried by the very tree being verified, which a re-signed tar and a
rewritten `BUILD-INFO.json` can satisfy together trivially.

Re-derives the allowlisted set from the tar and checks: the tar's own
sha256 matches the `--tar-sha256` you passed, the tar's pax global header
commit id matches `BUILD-INFO.json`'s `jpos_sha`, the tar has no regular
file outside the anchor, every file `BUILD-INFO.json` or the tar knows
about is a regular file on disk that is byte-identical to the tar's copy of
it, and -- walking the *whole* `--root` tree with `lstat` (never following a
symlink) -- that there is no on-disk path under `--root` that isn't in
`BUILD-INFO.json`'s file list, and no non-regular entry (a symlink, FIFO,
socket, ...) anywhere under it. A file only ever listed in `BUILD-INFO.json`'s
`added` array does not get a pass here: `added` exists so a fork's own new
files don't trip `checks.mjs`'s allowlist rule, but it was never part of the
pinned tar, so it fails the byte-equality claim `--verify` makes. Exits 0
only when all of that holds -- this is how a later mechanical step confirms
the committed tree still matches the tar it was built from, without trusting
`BUILD-INFO.json` alone.

## `--status`: what has drifted since import

```bash
node apps/workspace/import/import.mjs --status \
  --build-info apps/workspace/BUILD-INFO.json \
  --root apps/workspace/shell
```

Lists every imported file whose current sha256 no longer matches
`BUILD-INFO.json` (`MODIFIED:` -- this is the fork's delta: code changed
here, on top of the import) and every file under `--root` that
`BUILD-INFO.json` doesn't know about at all (`ADDED:` -- new files this repo
introduced since the import, that are also listed in `BUILD-INFO.json`'s own
`added` array so `checks.mjs --import`'s allowlist rule doesn't flag them).

## Re-import review

A re-import is a **deliberate, owner-requested** PR, never something an
executor starts on its own initiative. It picks up a newer pinned jpos
commit and carries the fork's own changes forward on top of it:

1. Run `import.mjs --status` against the *current* `BUILD-INFO.json` first,
   and keep that output -- it is the fork's delta, and it is what step 4
   re-applies.
2. Produce a new tar for the newer `<sha>` exactly as in Step 1, and run the
   importer exactly as in Step 2, against a **clean** `apps/workspace/shell`.
   This re-extracts the allowlist from the new upstream commit.
3. Diff the newly imported tree against what `git` has recorded for the
   *previous* import (by `BUILD-INFO.json`'s old `files` map): every
   allowlisted file whose upstream bytes changed needs to be listed in the
   PR description, because a reviewer needs to see exactly what upstream
   changed, not just that an import happened.
4. Re-apply the fork's delta from step 1 as reviewed code -- these are hand
   changes, not a mechanical copy, since the surrounding upstream code may
   have moved.
5. Update `BUILD-INFO.json` (the importer already did this in step 2; do not
   hand-edit it afterward).
6. This PR requires **both** a code-reviewer **and** a security-reviewer
   pass, plus a green WS-C runtime "Claude Code" gate and the WS-C
   route-inventory test, before it can merge. A normal import PR (one
   reviewer) is not enough for a re-import.

## Why the importer reads no environment

`import.mjs`, `tar.mjs`, `checks.mjs` and `rules.mjs` never reference
`process.env` -- `grep -n "process.env" apps/workspace/import/*.mjs` prints
nothing. Every input they need (`--tar`, `--sha`, `--tar-sha256`, `--origin`,
`--out`, `--build-info`, `--allowlist`, `--checked-by`, `--root`) comes from
an explicit CLI flag. Combined with running the import under
`env -i PATH="$PATH"` (so nothing in the invoking shell's environment reaches
the importer either) and reading the tar's own bytes rather than the `jpos`
working tree, an accidental credential leak through this tool is not just
discouraged, it has no path to happen.
