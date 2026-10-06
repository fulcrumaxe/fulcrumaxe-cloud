-- D#2 H13c (correction C27): the production `resolveSandboxRun` for the
-- GitHub proxy (H13b, #140) needs two things `main` doesn't have yet --
-- flagged in #140's own description rather than worked around:
--
--   1. A `platform_ops` SELECT grant on `agent_runs` (the proxy resolves a
--      verified `sandbox_name` claim with NO account_id to scope a
--      tenant-scoped connection by -- same "identity resolution before
--      tenant is known" shape 0613 already uses for `installations`/
--      `repos`, see that file's own header).
--   2. Storage for a repo's GitHub owner/name STRINGS. `repos` has only
--      the numeric `gh_repo_id` (0001_core.sql) -- nothing to put in the
--      URL path or `decide()`'s `InstallationTarget` the proxy already
--      builds.
--
-- Numbering: originally landed as 0614 (D#94 R1), when `origin/main` @
-- e014360 (#140) ended at 0613_work_items_provenance_set_once.sql and no
-- open PR claimed a migration number. Fix round 1: `main` has since
-- moved (0616_api_tokens.sql, #152) past that number, and 0617/0618 are
-- claimed by other open PRs (#155, #148) -- renumbered to 0619 so this
-- still sorts after everything currently on `main` (D#94 R1's
-- merge-monotonic ordering rule).
--
-- UNIQUE(gh_installation_id) (the #135/H13a security review's own
-- condition, restated in C27): NOT added here. `installations` has no
-- writer anywhere in this codebase yet (`grep -rn "INSERT INTO
-- installations"` outside test/seed helpers returns nothing --
-- provisioning is H06's, not landed). This file's own writer (below)
-- never touches `installations` at all -- it UPDATEs `repos.gh_owner`/
-- `gh_name` for a repo row that already exists, keyed by
-- (account_id, gh_repo_id), which `repos` already has a real UNIQUE-
-- equivalent access path for via its own `(account_id, id)` uniqueness
-- and the tenant_isolation policy. So this migration is not "the first
-- write a tenant can reach" for `gh_installation_id` -- there is still no
-- writer this PR ships that could be the first INSERT to prove unique
-- against.
--
-- Fix round 1 correction (security review NEEDS-FIX, D#2 C27): an
-- earlier draft of this paragraph went further and said the condition
-- "does not fire here" -- full stop. That overstated it. This migration
-- is what makes `gh_installation_id` load-bearing for the first time:
-- runResolver.ts's query reads it off whichever `installations` row its
-- account-scoped join lands on and hands it straight to GitHub as the
-- token-mint target (CWE-639). A duplicate anywhere in the table --
-- however it got there, not only through a writer this PR ships -- lets
-- that value belong to the wrong account regardless of which row the
-- join picked, so the exposure is very much live here even though this
-- file adds no writer. `runResolver.ts` now closes that gap itself, with
-- an explicit `NOT EXISTS` guard at query time (see its own header) --
-- belt-and-braces until S1 lands the real constraint.

-- ---------------------------------------------------------------------
-- 1. GitHub owner/repo-name storage on `repos`.
-- ---------------------------------------------------------------------
-- Nullable, no default -- a repos row with no stored name is exactly the
-- "not yet named" state the resolver's own deny case (H13c-4 "missing
-- name") reads as a deny, not a guess. Format-checked at the database
-- (belt) as well as by the writer below (suspenders): GitHub's own login
-- grammar for `gh_owner` (alnum, single internal hyphens, no leading/
-- trailing hyphen, 1-39 chars -- this covers both user and org logins,
-- which share one grammar) and the same repo-name-segment grammar
-- eventMapper.ts's own REPO_FULL_NAME_RE already uses for `full_name`
-- (alnum plus `.`, `_`, `-`, 1-100 chars) for `gh_name`.
ALTER TABLE repos
  ADD COLUMN gh_owner text NULL;

ALTER TABLE repos
  ADD COLUMN gh_name text NULL;

ALTER TABLE repos
  ADD CONSTRAINT repos_gh_owner_format_check
  CHECK (gh_owner IS NULL OR gh_owner ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$');

ALTER TABLE repos
  ADD CONSTRAINT repos_gh_name_format_check
  CHECK (gh_name IS NULL OR gh_name ~ '^[A-Za-z0-9._-]{1,100}$');

-- ---------------------------------------------------------------------
-- 2. platform_ops read access for the production resolver.
-- ---------------------------------------------------------------------
-- `agent_runs` has NO platform_ops policy yet (0001_core.sql only grants
-- `tenant_isolation` TO app_user, and the table is FORCE ROW LEVEL
-- SECURITY, so even the owner is subject to RLS -- platform_ops is
-- NOBYPASSRLS, same as app_user, see 0001_core.sql's role creation). The
-- resolver runs BEFORE any tenant is known (the whole reason it needs
-- platform_ops, not withTenant), so its policy is unconditional, same
-- shape as 0613's own installations/repos policies and 0001_core.sql's
-- ledger/audit_log platform_ops_read_access.
CREATE POLICY platform_ops_read_access ON agent_runs
  FOR SELECT TO platform_ops
  USING (true);

-- Column-scoped: exactly what runResolver.ts's query reads --
-- `sandbox_name` (the WHERE key), `role`/`status` (the decision inputs),
-- `dispatch_repo_id` (the join to `repos`) and `account_id` (the same-
-- tenant join guard below). `id` is not read -- the resolver never
-- returns or logs a run id -- so it is not granted either, even though
-- an earlier draft of this task expected it; "exactly the columns the
-- resolver reads" is the actual criterion (H13c-1), not that list.
-- Everything else on this table -- `envelope`, `tokens_in`/`tokens_out`/
-- `usd`, `cc_session_id`, `head_sha`, etc -- stays unreadable to
-- platform_ops: none of it is needed to resolve a sandbox identity, and
-- `envelope` in particular can carry model output text that has no
-- business crossing into the proxy's own trust boundary.
GRANT SELECT (account_id, role, status, sandbox_name, dispatch_repo_id)
  ON agent_runs TO platform_ops;

-- `repos`: 0613 already granted (id, account_id, gh_repo_id) for H13a's
-- own tenant resolution. This adds exactly the four more columns the
-- run resolver reads: `installation_id` (to join `installations`),
-- `product` (`ResolvedSandboxRun.product`, `decide()`'s own input), and
-- the two new name columns. No `work_items` grant: the resolver uses
-- `agent_runs.dispatch_repo_id` (0605's dispatch-time snapshot) directly,
-- never a `work_items` join (see runResolver.ts's own header for why --
-- same reasoning 0605 itself documents for why `cancelRun` stopped
-- needing that join). It reads no `work_items` column, so C27's
-- conditional grant does not fire.
GRANT SELECT (installation_id, gh_owner, gh_name, product)
  ON repos TO platform_ops;

-- `installations`: 0613 already granted (id, account_id,
-- gh_installation_id) -- `gh_installation_id` is exactly the field
-- `ResolvedSandboxRun.installationId` needs, and the policy already
-- exists. No change needed here.
