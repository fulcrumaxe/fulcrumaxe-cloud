-- D#2 H09c (correction C37): move every write of the gate-relevant
-- `agent_runs` columns off `app_user` and onto a narrow writer.
--
-- Why. The merge gate (`packages/pipeline/src/build/mergeGate.ts`) trusts
-- `agent_runs` rows as proof that a sandboxed review actually ran on a
-- given head SHA. Until now `app_user` held INSERT plus column-scoped
-- UPDATE (0611) on the columns the gate reads, so any `app_user` code path
-- could forge a passing row, rewrite a genuine `needs-fix` row's
-- `head_sha`/`status`/`runtime`/`envelope`/`created_at`, push a forged
-- row's `created_at` into the future so it outranks every later verdict,
-- or set `app.account_id` to another tenant and forge rows there. Only
-- `role` was protected (0605's write-once trigger).
--
-- This SUPERSEDES an earlier decision on purpose: 0605_execution_mode.sql
-- records D#2605 H02 round 8's "keep UPDATE" ruling, which left the table
-- open for mid-run metering. That decision predates the merge gate. From
-- here `app_user` keeps UPDATE on pure metering columns only.
--
-- Numbering: origin/main ended at 0635_parked_work_items.sql when this
-- was written (0632-0634 belong to other in-flight work).
--
-- What this file does:
--   1. Creates the NOLOGIN role agent_run_writer (0618 discussion_eraser
--      shape). It holds no table privilege at all -- only EXECUTE on the two
--      functions below. app_user is NOT a member of it. A LOGIN that the
--      runner connects as must be granted BOTH app_user (for the runner's
--      own reads and run_events/domain_events writes) and agent_run_writer;
--      creating that production login is an ops step outside this file.
--   2. Revokes app_user INSERT and UPDATE on agent_runs and re-grants
--      UPDATE on the metering allowlist only.
--   3. Adds two SECURITY DEFINER functions owned by platform_ops (test-neon-
--      shape criterion 8): agent_run_create and agent_run_set_status.
--   4. Adds a BEFORE UPDATE trigger that freezes the identity columns after
--      insert, for every role (including superuser and the definer).
--   5. Adds a BEFORE INSERT OR UPDATE write guard (security review of #205,
--      M1): platform_ops is a LOGIN that internet-facing handlers connect as
--      (gh-proxy, the Stripe webhook, the OAuth callback, the v1 API), and it
--      owns the definer functions, so it holds direct INSERT/UPDATE grants
--      below. The guard (a) refuses any INSERT and any change to status,
--      envelope or cc_session_id from a session whose session_user is
--      platform_ops -- inside the definer session_user is the runner login,
--      so the writer still works -- and (b) enforces the writer's own
--      invariants on the table itself, so they bind every non-superuser
--      session, the owner included. It also adds a CHECK on status.
--
-- platform_ops is the definer's owner, so it gets the (column-scoped)
-- privileges the function bodies need, plus INSERT/UPDATE policies that
-- require the caller's tenant context (app.account_id) to match the row.
-- Those policies alone are NOT a tenant binding (app.account_id is a
-- settable GUC); the write guard is what keeps a direct platform_ops
-- session from forging gate-relevant state.

-- ---------------------------------------------------------------------
-- 1. agent_run_writer role (hardened attributes, NOLOGIN).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_run_writer') THEN
    CREATE ROLE agent_run_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
DO $$
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    ALTER ROLE agent_run_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
DO $$
DECLARE
  r    record;
  bad  text[] := '{}';
BEGIN
  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    INTO r
    FROM pg_roles WHERE rolname = 'agent_run_writer';
  IF r.rolcanlogin THEN bad := array_append(bad, 'rolcanlogin'); END IF;
  IF r.rolsuper THEN bad := array_append(bad, 'rolsuper'); END IF;
  IF r.rolcreatedb THEN bad := array_append(bad, 'rolcreatedb'); END IF;
  IF r.rolcreaterole THEN bad := array_append(bad, 'rolcreaterole'); END IF;
  IF r.rolreplication THEN bad := array_append(bad, 'rolreplication'); END IF;
  IF r.rolbypassrls THEN bad := array_append(bad, 'rolbypassrls'); END IF;
  IF array_length(bad, 1) > 0 THEN
    RAISE EXCEPTION 'role agent_run_writer still has privileged attribute(s): %', array_to_string(bad, ', ');
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 2. app_user loses INSERT and UPDATE on agent_runs.
--
-- REVOKE at table level also removes 0611's column-level UPDATE grants.
-- UPDATE is then re-granted on the metering allowlist below -- and ONLY
-- there. None of these columns is read or filtered on by the merge gate
-- (mergeGate.ts reads id, account_id, work_item_id, head_sha, role,
-- status, runtime, envelope, created_at), and packages/db's privilege test
-- asserts the allowlist and the gate-relevant set never overlap:
--   tokens_in   -- mid-run token metering counter (H09b2)
--   tokens_out  -- mid-run token metering counter (H09b2)
--   usd         -- mid-run cost metering counter (H09b2)
-- ---------------------------------------------------------------------
REVOKE INSERT, UPDATE ON agent_runs FROM app_user;
GRANT UPDATE (tokens_in, tokens_out, usd) ON agent_runs TO app_user;

-- ---------------------------------------------------------------------
-- 3. Privileges for the definer's owner (platform_ops).
--
-- SELECT: the function bodies read id/account_id/status in their WHERE
-- clauses (0619 already granted account_id, role, status, sandbox_name,
-- dispatch_repo_id; only `id` is new). `envelope`, the metering columns
-- and cc_session_id stay unreadable to platform_ops -- the update
-- statement never reads them.
-- INSERT: every column agent_run_create supplies -- EXCLUDING created_at
-- (and updated_at), so the column DEFAULT now() always stamps them and no
-- caller-supplied value can be stored.
-- UPDATE: exactly the columns agent_run_set_status changes.
-- ---------------------------------------------------------------------
GRANT SELECT (id) ON agent_runs TO platform_ops;
GRANT INSERT (id, account_id, work_item_id, parent_run_id, role, runtime, status, head_sha,
              execution_mode, dispatch_repo_id, dispatch_pr_number, spec_version_id)
  ON agent_runs TO platform_ops;
GRANT UPDATE (status, updated_at, envelope, tokens_in, tokens_out, usd, cc_session_id)
  ON agent_runs TO platform_ops;

-- RLS: these policies apply whenever current_user is platform_ops -- which
-- includes the inside of the definer functions. They require the tenant
-- context (app.account_id) to match the row and the account to be active,
-- exactly like app_user's tenant_isolation policy, so a definer call can
-- never write a row outside the tenant context the caller established.
CREATE POLICY platform_ops_run_insert ON agent_runs
  FOR INSERT TO platform_ops
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY platform_ops_run_update ON agent_runs
  FOR UPDATE TO platform_ops
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

-- ---------------------------------------------------------------------
-- 4. Identity columns are frozen after insert, for EVERY role.
--
-- Like 0605's write-once trigger, this is not bypassed by a superuser or
-- by the definer's owner. `created_at` in particular is what orders the
-- merge gate's "latest verdict" -- a caller who could move it could make an
-- old pass outrank a newer needs-fix.
--
-- work_item_id and spec_version_id are the two exceptions-with-a-reason:
-- their composite FKs are ON DELETE SET NULL, and Postgres performs that
-- action as an UPDATE of this row from inside an RI trigger
-- (pg_trigger_depth() > 1 here). Only a change TO NULL at that depth is let
-- through, and only once the referenced parent row no longer exists (the
-- RI action fires after the parent delete) -- a direct UPDATE to NULL
-- (depth 1), or a nested one from some other trigger while the parent is
-- still there, is refused like any other change.
-- ---------------------------------------------------------------------
CREATE FUNCTION agent_runs_identity_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.runtime IS DISTINCT FROM OLD.runtime
     OR NEW.head_sha IS DISTINCT FROM OLD.head_sha
  THEN
    RAISE EXCEPTION 'agent_runs.created_at/account_id/role/runtime/head_sha are immutable after insert (run %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The parent lookups run ONLY in the nested-to-NULL case, as separate
  -- statements: they need SELECT on work_items / spec_versions, which the
  -- roles that merely update status (platform_ops inside the definer,
  -- app_user metering) do not hold, and a permission check applies to a
  -- query whether or not its sub-select is reached.
  IF NEW.work_item_id IS DISTINCT FROM OLD.work_item_id THEN
    v_ok := NEW.work_item_id IS NULL AND pg_trigger_depth() > 1;
    IF v_ok THEN
      SELECT NOT EXISTS (SELECT 1 FROM public.work_items w
                          WHERE w.account_id = OLD.account_id AND w.id = OLD.work_item_id)
        INTO v_ok;
    END IF;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'agent_runs.work_item_id is immutable after insert (run %)', OLD.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW.spec_version_id IS DISTINCT FROM OLD.spec_version_id THEN
    v_ok := NEW.spec_version_id IS NULL AND pg_trigger_depth() > 1;
    IF v_ok THEN
      SELECT NOT EXISTS (SELECT 1 FROM public.spec_versions v
                          WHERE v.account_id = OLD.account_id AND v.id = OLD.spec_version_id)
        INTO v_ok;
    END IF;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'agent_runs.spec_version_id is immutable after insert (run %)', OLD.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_runs_identity_immutable
  BEFORE UPDATE ON agent_runs
  FOR EACH ROW
  EXECUTE FUNCTION agent_runs_identity_immutable();

-- ---------------------------------------------------------------------
-- 4b. Status vocabulary. The nine values of RunStatus in
-- packages/runner/src/statusTransitions.ts (the keys of
-- RUN_STATUS_TRANSITIONS). Makes the merge gate's "unknown status counts
-- as terminal" branch unreachable instead of load-bearing.
-- ---------------------------------------------------------------------
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_known CHECK (
  status IN ('pending', 'refused_spend', 'running', 'succeeded', 'failed',
             'timed_out', 'killed_spend', 'paused', 'cancelled')
);

-- ---------------------------------------------------------------------
-- 4c. Write guard (security review of #205, M1).
--
-- (a) session_user = 'platform_ops' (a direct login, e.g. the web app's
--     gh-proxy / webhook / OAuth / API connection) may not INSERT, and may
--     not change status, envelope or cc_session_id. session_user cannot be
--     changed without superuser. Inside agent_run_create / agent_run_set_
--     status current_user is platform_ops but session_user is the runner's
--     login, so the writer is unaffected.
--
-- (b) The writer's invariants, enforced on the table so they also bind the
--     definer's owner and any ops session that is not a superuser (a
--     superuser can drop the trigger anyway, and the [pg] suites seed
--     arbitrary rows through the superuser admin connection, so superuser
--     sessions are exempt from (b) only):
--       * INSERT: status 'pending', envelope NULL;
--       * status changes follow the legal edges (= agent_run_set_status's
--         table = RUN_STATUS_TRANSITIONS);
--       * envelope may change only from NULL, in the same statement that
--         moves the run from a non-terminal to a terminal status.
--     Why a trigger and not a CHECK: a CHECK sees only NEW, and these are
--     rules about OLD -> NEW (edge legality, set-once).
-- ---------------------------------------------------------------------
CREATE FUNCTION agent_runs_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_terminal constant text[] :=
    ARRAY['refused_spend', 'succeeded', 'failed', 'timed_out', 'killed_spend', 'cancelled'];
BEGIN
  IF session_user = 'platform_ops' THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'agent_runs: platform_ops may not INSERT directly; use agent_run_create'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.envelope IS DISTINCT FROM OLD.envelope
       OR NEW.cc_session_id IS DISTINCT FROM OLD.cc_session_id
    THEN
      RAISE EXCEPTION 'agent_runs: platform_ops may not change status/envelope/cc_session_id directly; use agent_run_set_status (run %)', OLD.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  IF (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending' OR NEW.envelope IS NOT NULL THEN
      RAISE EXCEPTION 'agent_runs: a run is inserted as pending with no envelope (got status "%")', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT EXISTS (
      SELECT 1
        FROM (VALUES
          ('pending', 'refused_spend'), ('pending', 'running'), ('pending', 'paused'),
          ('pending', 'cancelled'), ('pending', 'timed_out'), ('pending', 'failed'),
          ('running', 'succeeded'), ('running', 'failed'), ('running', 'timed_out'),
          ('running', 'killed_spend'), ('running', 'cancelled'),
          ('paused', 'cancelled')
        ) AS legal (from_status, to_status)
       WHERE legal.from_status = OLD.status AND legal.to_status = NEW.status
    ) THEN
      RAISE EXCEPTION 'agent_runs: illegal status transition "%" -> "%" (run %)', OLD.status, NEW.status, OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.envelope IS DISTINCT FROM OLD.envelope THEN
    IF OLD.envelope IS NOT NULL
       OR NEW.status IS NOT DISTINCT FROM OLD.status
       OR OLD.status = ANY (v_terminal)
       OR NOT (NEW.status = ANY (v_terminal))
    THEN
      RAISE EXCEPTION 'agent_runs: envelope is set once, together with the move to a terminal status (run %)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_runs_write_guard
  BEFORE INSERT OR UPDATE ON agent_runs
  FOR EACH ROW
  EXECUTE FUNCTION agent_runs_write_guard();

-- ---------------------------------------------------------------------
-- 5. The writer functions.
--
-- Both refuse a p_account_id that is not the caller's tenant context
-- (app.account_id): the runner always runs inside withTenant, and a
-- mismatch is a bug or an attack, never a legitimate call.
-- ---------------------------------------------------------------------

-- agent_run_create: the only INSERT path. Status is always 'pending'; there
-- is no created_at parameter, so the database's now() is what gets stored.
CREATE FUNCTION agent_run_create(
  p_id                  uuid,
  p_account_id          uuid,
  p_work_item_id        uuid,
  p_parent_run_id       uuid,
  p_role                text,
  p_runtime             text,
  p_head_sha            text,
  p_execution_mode      text,
  p_dispatch_repo_id    uuid,
  p_dispatch_pr_number  bigint,
  p_spec_version_id     uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_id uuid := COALESCE(p_id, gen_random_uuid());
BEGIN
  IF p_account_id IS NULL
     OR p_account_id IS DISTINCT FROM NULLIF(current_setting('app.account_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'agent_run_create: account % is not the caller''s tenant context', p_account_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.agent_runs
    (id, account_id, work_item_id, parent_run_id, role, runtime, status, head_sha,
     execution_mode, dispatch_repo_id, dispatch_pr_number, spec_version_id)
  VALUES
    (v_id, p_account_id, p_work_item_id, p_parent_run_id, p_role, p_runtime, 'pending',
     p_head_sha, p_execution_mode, p_dispatch_repo_id, p_dispatch_pr_number, p_spec_version_id);
  RETURN v_id;
END;
$$;

-- agent_run_set_status: the only path that changes status, envelope or the
-- result columns. Compare-and-set on p_from (returns false when no row
-- matched -- another writer already moved the run), and the legal edges are
-- enforced HERE, not only in packages/runner/src/statusTransitions.ts: the
-- table below is that file's RUN_STATUS_TRANSITIONS, and a runner [pg] test
-- checks all 81 (from, to) pairs against it so the two cannot drift.
--
-- The envelope may be supplied only in the same call that moves the run to
-- a terminal status. Terminal statuses have no outgoing edge, so a run that
-- already has an envelope can never reach this UPDATE again: the envelope is
-- set once and never changes.
CREATE FUNCTION agent_run_set_status(
  p_account_id  uuid,
  p_run_id      uuid,
  p_from        text,
  p_to          text,
  p_envelope    jsonb,
  p_tokens_in   bigint,
  p_tokens_out  bigint,
  p_usd         numeric,
  p_session_id  text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_rows integer;
  v_sets text;
BEGIN
  IF p_account_id IS NULL
     OR p_account_id IS DISTINCT FROM NULLIF(current_setting('app.account_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'agent_run_set_status: account % is not the caller''s tenant context', p_account_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM (VALUES
        ('pending', 'refused_spend'), ('pending', 'running'), ('pending', 'paused'),
        ('pending', 'cancelled'), ('pending', 'timed_out'), ('pending', 'failed'),
        ('running', 'succeeded'), ('running', 'failed'), ('running', 'timed_out'),
        ('running', 'killed_spend'), ('running', 'cancelled'),
        ('paused', 'cancelled')
      ) AS legal (from_status, to_status)
     WHERE legal.from_status = p_from AND legal.to_status = p_to
  ) THEN
    RAISE EXCEPTION 'agent_run_set_status: illegal agent_runs.status transition "%" -> "%"', p_from, p_to
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_envelope IS NOT NULL
     AND p_to NOT IN ('refused_spend', 'succeeded', 'failed', 'timed_out', 'killed_spend', 'cancelled')
  THEN
    RAISE EXCEPTION 'agent_run_set_status: an envelope may only be set together with a terminal status (got "%")', p_to
      USING ERRCODE = 'check_violation';
  END IF;

  -- One atomic statement. The SET list is assembled from FIXED column-name
  -- literals only (never from a caller value), so only the columns the
  -- caller actually supplied are touched. That avoids COALESCE(col, ...) and
  -- therefore any SELECT privilege on envelope/tokens/session columns:
  -- platform_ops keeps its narrow read grant (0619) plus `id`.
  v_sets := '';
  IF p_envelope IS NOT NULL THEN v_sets := v_sets || ', envelope = $5'; END IF;
  IF p_tokens_in IS NOT NULL THEN v_sets := v_sets || ', tokens_in = $6'; END IF;
  IF p_tokens_out IS NOT NULL THEN v_sets := v_sets || ', tokens_out = $7'; END IF;
  IF p_usd IS NOT NULL THEN v_sets := v_sets || ', usd = $8'; END IF;
  IF p_session_id IS NOT NULL THEN v_sets := v_sets || ', cc_session_id = $9'; END IF;

  EXECUTE 'UPDATE public.agent_runs SET status = $1, updated_at = now()' || v_sets
       || ' WHERE account_id = $2 AND id = $3 AND status = $4'
    USING p_to, p_account_id, p_run_id, p_from, p_envelope, p_tokens_in, p_tokens_out, p_usd, p_session_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;

-- EXECUTE goes to agent_run_writer and nobody else. REVOKE FROM PUBLIC
-- first: functions are executable by PUBLIC by default.
REVOKE ALL ON FUNCTION agent_run_create(uuid, uuid, uuid, uuid, text, text, text, text, uuid, bigint, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION agent_run_set_status(uuid, uuid, text, text, jsonb, bigint, bigint, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_run_create(uuid, uuid, uuid, uuid, text, text, text, text, uuid, bigint, uuid) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION agent_run_set_status(uuid, uuid, text, text, jsonb, bigint, bigint, numeric, text) TO agent_run_writer;

-- Ownership: platform_ops (test-neon-shape criterion 8). CREATE on schema
-- public is needed at the instant of the ALTER ... OWNER TO for a non-
-- superuser migration role, and closed again immediately (same bracket as
-- 0624).
GRANT CREATE ON SCHEMA public TO platform_ops;
ALTER FUNCTION agent_run_create(uuid, uuid, uuid, uuid, text, text, text, text, uuid, bigint, uuid) OWNER TO platform_ops;
ALTER FUNCTION agent_run_set_status(uuid, uuid, text, text, jsonb, bigint, bigint, numeric, text) OWNER TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM platform_ops;
