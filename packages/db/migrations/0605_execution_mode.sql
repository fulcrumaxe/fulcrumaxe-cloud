-- Renamed from 0007_execution_mode.sql, then from 0603_execution_mode.sql
-- (PR #85 fix round 4, Team Lead ruling on D#94 R1): 0603 was reserved
-- for this PR when 0604_session_epoch.sql (#96) merged, but by the time
-- this fix round rebased, 0604 was already main's newest -- 0603 would
-- have sorted BEFORE it by filename while landing AFTER it in real
-- merge order, which is exactly the out-of-order shape 0011's own prior
-- bug took (see test-neon-shape.sh's LATE_MIGRATIONS comment). Taking
-- 0605 -- the next free number above main's newest at rebase time --
-- keeps filename order and merge order in agreement, so this file needs
-- no late-migration-list entry of its own. This file has never run
-- against a hosted or production database (only ever exercised inside
-- this open PR's own throwaway test clusters), so renumbering it again
-- is safe -- migrate.ts applies migrations in filename order, and no
-- `schema_migrations` row anywhere names either prior filename. It does
-- not replace, or transfer ownership of, any `platform_ops`-owned
-- object (it only CREATEs two new trigger functions and ADDs columns/
-- constraints to existing app-owned tables), so it does not need #92's
-- per-file `platform_ops` INHERIT-TRUE bracket -- that bracket only
-- matters for a file that must `ALTER FUNCTION ... OWNER TO
-- platform_ops` or `CREATE OR REPLACE` an already-`platform_ops`-owned
-- function, neither of which this file does.
--
-- D#2 H09b (correction C10): the ExecutionTarget seam routes a run by
-- DATA, never by environment -- `runtime/src/select.ts` picks the
-- production runner whenever any `VERCEL*` variable is set, which could
-- never choose a non-sandbox target in the cloud. `repos.execution_mode`
-- is the column `startAgentRun` reads instead.
--
-- The column is `text NOT NULL DEFAULT 'sandbox'` with a NAMED CHECK
-- constraint that allows only `'sandbox'` today. C10: "D#6 widens the
-- CHECK when RunnerTarget lands." An unregistered/unknown mode value can
-- never even be written (the CHECK fails closed at the database), and
-- packages/runner/src/executionTarget.ts's resolver independently fails
-- closed in application code for the same reason -- belt and suspenders,
-- not redundant: the CHECK protects every future writer of this column
-- (including ones outside packages/runner), the resolver protects
-- against a mode value that's legal at the database layer today but has
-- no registered ExecutionTarget (there is none such in v1, but D#6 will
-- widen the CHECK before it ships RunnerTarget, so the two can briefly
-- disagree mid-rollout).
--
-- "the same shape a repo meant to run locally can't have its code sent
-- to our sandbox because the schema changed before the registry did" --
-- the CHECK is what makes that a database-level guarantee, not just an
-- application-code one.
ALTER TABLE repos
  ADD COLUMN execution_mode text NOT NULL DEFAULT 'sandbox';

ALTER TABLE repos
  ADD CONSTRAINT repos_execution_mode_check CHECK (execution_mode IN ('sandbox'));

-- D#2 H09b (correction C10, for C11/H14): `agent_runs.head_sha` -- the PR
-- head SHA a reviewer run actually checked out, so H14's merge gate can
-- bind each review verdict to a specific commit instead of trusting a
-- label. NULL for every run that isn't tied to a specific head (most
-- roles); `startAgentRun` is the only writer, and only at INSERT time --
-- nothing ever updates it afterwards (H09b pass/fail 17).
ALTER TABLE agent_runs
  ADD COLUMN head_sha text NULL;

-- PR #85 fix round (both reviews, item 4; CWE-636/362/672): cancelRun used
-- to (a) route by `COALESCE(r.execution_mode, 'sandbox')`, silently
-- treating a NULL/unresolvable mode as "sandbox" instead of failing
-- closed, and (b) reconstruct the sandbox identity (repo id, PR number)
-- by joining agent_runs -> work_items -> repos at CANCEL time, which can
-- come back NULL (a deleted repo: `work_items.repo_id`'s own FK is
-- `ON DELETE SET NULL`) or diverge from what dispatch actually used (a
-- work_item's `gh_number` edited after dispatch). Both are "the row this
-- cancel call acts on can drift or vanish out from under it" bugs.
--
-- `startAgentRun` now persists what admit/dispatch actually resolved and
-- used, ONCE, at INSERT time -- immune to a later repo delete or a
-- work_item's `gh_number` changing, so `cancelRun` never needs that join
-- for routing or sandbox-identity purposes again. `sandbox_name`
-- (0001_core.sql) already exists and was simply never written by this
-- package until now; `sandboxNameFor` is a pure function of
-- (role, runId, repoId, pr), so persisting `dispatch_repo_id`/
-- `dispatch_pr_number` is sufficient for a later cancel to recompute the
-- exact same name `dispatch` used -- see targets/sandboxTarget.ts.
--
-- All three are NULL-able with NO default and NO foreign key:
--   * NULL with no default (not "NOT NULL DEFAULT 'sandbox'" the way
--     `repos.execution_mode` is) is deliberate -- a default here would
--     just move the exact fail-open bug this migration fixes from
--     application SQL into the schema. A row with no persisted identity
--     (a pre-migration row, a hand-seeded test fixture) must fail closed
--     at read time (see cancelRun.ts's fallback path), never silently
--     resolve to "sandbox".
--   * `dispatch_repo_id` has NO ongoing foreign key to `repos(id)` on
--     purpose: a persisted SNAPSHOT of "which repo dispatch used" must
--     survive that repo later being deleted, which is exactly the
--     "deleted repo" scenario this fix round adds a test for. A live FK
--     would force a choice between two wrong answers -- either it blocks
--     deleting a repo forever once any run has ever dispatched against
--     it (no ON DELETE action), or `ON DELETE SET NULL` erases the very
--     identity this column exists to preserve the moment the repo is
--     gone, defeating the whole point of persisting it. Fix round 2
--     (must-fix 2 below) closes the cross-tenant hole a missing FK left
--     open a different way: a ONE-TIME ownership check at INSERT, not a
--     live constraint -- see `agent_runs_dispatch_repo_same_tenant`
--     below.
ALTER TABLE agent_runs
  ADD COLUMN execution_mode text NULL;

ALTER TABLE agent_runs
  ADD COLUMN dispatch_repo_id uuid NULL;

ALTER TABLE agent_runs
  ADD COLUMN dispatch_pr_number bigint NULL;

-- ---------------------------------------------------------------------
-- PR #85 fix round 2, must-fix 2 (security re-review of 1781b3b, finding
-- 2; CWE-639/284/915): app_user's grant on agent_runs is the original
-- table-wide UPDATE (0001_core.sql), and packages/db/test/
-- agent-runs-run-events-spend-privileges.test.ts (D#2605 H02 round 8,
-- "decision 1: keep UPDATE, drop DELETE") deliberately keeps it
-- table-wide -- H09b2's own mid-run metering is expected to UPDATE
-- tokens_in/tokens_out/usd/envelope directly as a run progresses, with
-- no fixed column list this migration could safely narrow to. A
-- column-scoped GRANT (the approach 0005/0008 use for account_members/
-- invitations) is the wrong tool here for exactly that reason: it would
-- either break that already-decided contract or have to guess H09b2's
-- future column list today.
--
-- What actually needs to become unwritable is narrower than "every
-- column": role, execution_mode, dispatch_repo_id and dispatch_pr_number
-- specifically -- the four that name WHICH sandbox a cancel targets and
-- HOW. Demonstrated live: an app_user session in account A updated its
-- own run's role to 'executor' and dispatch_repo_id to account B's repo
-- id, and its own cancelRun call then stopped B's live sandbox. A forged
-- INSERT naming B's repo id was accepted the same way (closed separately
-- below, by the same-tenant trigger).
--
-- This BEFORE UPDATE trigger makes exactly those four columns WRITE-ONCE:
-- any UPDATE that would actually CHANGE one of them (`IS DISTINCT FROM`,
-- so re-sending the same value -- e.g. a caller that re-supplies every
-- column on every write -- is not a change) is refused, regardless of
-- role or RLS; every column NOT in this list keeps behaving exactly as
-- before, including for platform_ops or any other role. The ONLY
-- legitimate writer of these four columns in this codebase is
-- insertAgentRun's own INSERT (packages/runner/src/runStatusWriter.ts) --
-- writeRunStatus's one UPDATE touches only `status`/`updated_at` -- so a
-- trigger that blocks every UPDATE of these four columns unconditionally
-- costs nothing today and closes the whole class going forward. This
-- also satisfies "NULL is not allowed once dispatched" for
-- execution_mode: a dispatched (non-NULL) value can never be written
-- again at all, let alone nulled back out.
-- PR #85 fix round 3, should-fix 3: pin search_path on both trigger
-- functions below, matching 0005/0008's own precedent (0005:
-- current_member_role() etc; 0008: audit_write()/audit_write_system()),
-- so neither ever resolves an unqualified name through a caller-
-- influenced search_path. Not exploitable today -- app_user has no TEMP
-- privilege (`CREATE TEMP TABLE` fails 42501, verified) and can CREATE in
-- no schema -- but the tenant check below should not depend on those two
-- grants staying revoked forever.
CREATE FUNCTION agent_runs_dispatch_identity_write_once()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role
     OR NEW.execution_mode IS DISTINCT FROM OLD.execution_mode
     OR NEW.dispatch_repo_id IS DISTINCT FROM OLD.dispatch_repo_id
     OR NEW.dispatch_pr_number IS DISTINCT FROM OLD.dispatch_pr_number
  THEN
    RAISE EXCEPTION 'agent_runs.role/execution_mode/dispatch_repo_id/dispatch_pr_number are write-once and may not be changed after insert (run %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_runs_dispatch_identity_write_once
  BEFORE UPDATE ON agent_runs
  FOR EACH ROW
  EXECUTE FUNCTION agent_runs_dispatch_identity_write_once();

-- The INSERT half. Unlike the UPDATE grant above, a column-level INSERT
-- grant only lets a writer OMIT a column and take its DEFAULT -- it
-- cannot restrict what value an INCLUDED column may hold, and none of
-- role/execution_mode/dispatch_repo_id/dispatch_pr_number has a default
-- that would make sense here (insertAgentRun always supplies real
-- values). What actually made the forged INSERT possible is that
-- dispatch_repo_id had no relationship to repos at all: any UUID,
-- including one naming a row in a DIFFERENT account, was accepted.
--
-- This trigger ties dispatch_repo_id to repos THROUGH account_id, but
-- only at the moment of INSERT -- see the "no ongoing foreign key"
-- comment above for why a live FK is the wrong tool here. No SECURITY
-- DEFINER: it runs as the inserting role (app_user), so its own SELECT
-- against repos is already scoped by repos' own tenant_isolation RLS
-- policy to the caller's app.account_id -- a row naming another
-- tenant's repo is invisible to this query regardless of the explicit
-- account_id predicate below, which is belt-and-suspenders, not the
-- only thing enforcing this. A NULL dispatch_repo_id (the "no persisted
-- identity" case discussed above) is exempt, exactly like every other
-- optional identity column in this schema.
CREATE FUNCTION agent_runs_dispatch_repo_same_tenant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.dispatch_repo_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.repos WHERE id = NEW.dispatch_repo_id AND account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'agent_runs.dispatch_repo_id % does not name a repos row in account %',
      NEW.dispatch_repo_id, NEW.account_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_runs_dispatch_repo_same_tenant
  BEFORE INSERT ON agent_runs
  FOR EACH ROW
  EXECUTE FUNCTION agent_runs_dispatch_repo_same_tenant();

-- execution_mode: NULL keeps its existing meaning (no persisted identity
-- -- a legacy/pre-migration/hand-seeded row, see this file's header
-- above) and 'sandbox' is the only non-NULL legal value in v1 -- D#6
-- widens this the same way repos_execution_mode_check is widened, in
-- lockstep with EXECUTION_TARGETS (packages/runner/src/
-- executionTarget.ts).
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_execution_mode_check
  CHECK (execution_mode IS NULL OR execution_mode IN ('sandbox'));

-- role: kept a broad, extensible string on purpose
-- (packages/runner/src/types.ts's own `Role` doc comment: adding a role
-- must never need a migration) -- this is a FORMAT guard, not an enum,
-- so it can never go stale as roles/cards are added or renamed. Every
-- role name in packages/roles/src/manifest.ts today, and every role
-- value any [pg] test in this repo seeds onto agent_runs, is a
-- lower-case, hyphen-separated identifier; this rejects the empty
-- string, whitespace, and anything shaped like an injection/markup
-- payload rather than a role name. `role` is also now covered by the
-- UPDATE revoke above, so this only ever runs at INSERT.
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_role_format_check
  CHECK (role ~ '^[a-z][a-z0-9_-]*$');
