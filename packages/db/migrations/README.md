# Migration numbering (D#94)

One global, merge-monotonic sequence: a fresh install and a database
upgraded merge by merge apply migrations in the same order.

## R1. Merge-monotonic

Every migration file a PR adds must sort strictly after every migration
file already on the PR's base -- `origin/main` at merge time, re-checked
at every rebase. Numbers continue as one global four-digit sequence from
the current maximum (`0600` &rarr; `0601`, `0602`, ...), whatever the
epic. The per-epic hundred ranges (`01xx` D#3, `02xx` D#4, `03xx` D#5,
`04xx` D#7, `05xx` D#8, `06xx` D#31, `07xx` D#45) are **retired for new
files**. Existing files keep their names.

`packages/db/scripts/check-migration-order.sh [--base <ref>]` enforces
this in CI (wired into `scripts/check.sh`). `<base>` defaults to
`${MIGRATION_ORDER_BASE:-origin/main}`. The sort threshold -- the
greatest `.sql` name already on the base, which every added file must
clear -- is read from `<base>`'s own tip (`git ls-tree
<base>:packages/db/migrations`), not from `git merge-base HEAD <base>`;
the merge base is used only to scope which files this branch itself
added, modified, deleted or renamed. Reading the threshold from the
merge base instead of the base's own tip would let an un-rebased branch
pass against an outdated maximum -- exactly the race R3 exists to
prevent. The check fails closed -- exit 2, naming the ref or path it
could not read -- if `<base>` can't be resolved, or if `<base>`'s
migrations tree can't be listed. It then refuses (exit 1, naming the
file) any added migration file that:

- sorts at or before the greatest `.sql` name already on `<base>`,
- doesn't match `^[0-9]{4}_[a-z0-9_]+\.sql$`,
- shares a four-digit prefix with another file on `HEAD`,
- is a rename or edit of an existing file -- unless the edit is
  explicitly allowed via `MIGRATION_ORDER_ALLOW_EDIT=<file>[,<file>...]`
  for a Spec-approved, scoped edit (D#81/#92's own `0001`/`0200` bracket
  edits are the precedent), or
- is added, or an existing file is turned into, a symlink (git mode
  `120000`) -- the migration runner follows symlinks when it reads a
  file, so a symlink can silently redirect what actually runs under a
  given name.

Locally, the `<base>` ref itself (for example a not-recently-fetched
`origin/main`) can be stale, which can only make this check *miss* a
violation -- a stale ref's own tip can only be equal to or behind the
true current maximum, never ahead of it -- never invent one against an
up-to-date `<base>`. In CI, `MIGRATION_ORDER_BASE` is set to `HEAD^1` on
the merge/push commit, which is the authority and, being read directly
rather than through a merge-base, is never behind itself.

### Running against a `git clone --revision=<sha>` tree

`scripts/check.sh` (and this check within it) needs a resolvable
`<base>`. A tree built with `git clone --shared --revision=<sha>` (as
`scripts/lib/verify-tree.sh`'s `verify_tree_build` does for Gate 1) has
only the one revision and no `origin/main` to fall back on, so running
`scripts/check.sh` in such a tree requires `MIGRATION_ORDER_BASE` to be
set explicitly to a ref or sha that tree can actually resolve. This is
a documentation note, not a behavior change -- the script's default and
fail-closed behavior are unchanged.

## R2. A migration number written in a Spec is advisory

The executor takes the next free number when the PR is opened, and says
so in the PR body. Numbers written into an already-frozen Spec (for
example an old `03xx`-range number) are void once this rule takes
effect -- take the next free number instead.

## R3. Two PRs racing for the same number

The second PR to merge rebases and renumbers. R1's check refuses it
otherwise, because its file would no longer sort after `main`'s newest.

## Why R1, not "ranges plus sort after your dependencies"

- R1 makes lexical order equal merge order for every file from now on.
  Fresh and live apply orders are then identical by construction, and
  that can be checked mechanically from file names alone.
- A dependency rule needs judgment a name check can't verify.
- The catalog-parity check (below) can't see order-dependent privilege
  effects on its own -- R1 removes the question rather than testing for
  it on every PR.
- A side effect: the `INHERIT` window D#81/#92 opened between `0001` and
  `0200` is closed for good. No new file can ever sort inside it again.

## Fresh-versus-upgrade parity

`packages/db/scripts/test-neon-shape.sh` proves a fresh install and a
database upgraded merge-by-merge produce the same schema. Besides its
D#81 Neon-shape and historical-late-migration assertions, it includes a
D#94 check that migrates the PR's base chain, re-runs the migration
runner pointed at `HEAD` (so only the files this PR added apply), and
diffs the result against a fully fresh `HEAD` migration with
`neon-shape-catalog.sql`. It shares `check-migration-order.sh`'s own
base resolution (`MIGRATION_ORDER_BASE`, same fail-closed behavior).

## Safety record: `0002`-`0006`, `0008`, `0010`, `0011`

These files were merged under the old per-epic-range scheme, before R1
existed, and sort before `0100`-`0600` by filename even though several
of them (`0005`, `0006`, `0008`, `0010`, `0011`) actually landed on
`main` *after* `0100`-`0600` did. That is exactly the divergence R1
exists to prevent -- but no database has ever run in that order:

- Every test, CI and `globalSetup` database is migrated fresh, so it
  always applies the full chain in filename order.
- No hosted or production database exists yet at all (D#81's own
  finding), so no live database has ever received these files in merge
  order either.

Because no database with the alternative (merge) order has ever existed,
the merged files are safe to leave named as they are, and there is
nothing to prove against a real upgrade path -- only against history.
`packages/db/scripts/replay-merge-order.sh --base origin/main` is that
proof: it orders every file present on `origin/main` by the commit that
first added it (merge order), applies that order to one throwaway
database and lexical order to another, and diffs the two catalogs with
`neon-shape-catalog.sql`. An empty diff means merge order and lexical
order are interchangeable for every file already on `main` -- which is
exactly the safety record above, demonstrated rather than asserted. It
is a historical audit, not a per-PR gate: it needs full git history,
which CI's shallow (`fetch-depth: 2`) checkout doesn't have, so it is
**not** wired into `scripts/check.sh`. Run it by hand after adding new
migrations, or whenever the safety record needs re-proving.

The migration runner (`packages/db/src/migrate.ts`) ignores any file
that doesn't end in `.sql`, so this README and any other non-`.sql` file
in this directory are never picked up as migrations.
