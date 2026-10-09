-- D#2 SANDBOX-REAPER-2b (C85 criteria 23 and 24): the reaper's kill switch as a database setting, with its own audit.
--
-- FX_SANDBOX_REAP_MODE stays, as the ceiling. A changed environment variable reaches only new deployments, so turning the reaper
-- off through it needs a redeploy, and the reaper's deletes cannot be undone. This table is the switch that works at once: the cron
-- handler reads it at the start of every sandbox pass, and the mode in force is the stricter of the two (off < dry_run < on). A NULL
-- mode means "no override": the environment alone decides. Same shape as 0739's plan_kind_switches, which is the precedent for a
-- platform-wide switch that lives in the database.
--
-- 1. sandbox_reap_settings: ONE row, enforced by a boolean primary key that must be true, and seeded here with mode NULL. No INSERT or
--    DELETE grant for anyone, so the row can neither be added nor removed. Only platform_ops reads it or updates it, and only mode,
--    updated_by and updated_at (id is outside the grant). app_user, the runner login and sandbox_reaper hold nothing and have no
--    policy, so the table is not even visible to them.
-- 2. sandbox_reap_settings_audit: append-only. An AFTER UPDATE trigger writes one row for every change of `mode` in the same
--    transaction as the change, so no write path (a setter or a hand-typed UPDATE by platform_ops) can change the mode without leaving
--    a row. A change of mode that does not also set updated_by is refused. The row records the old and new mode, the caller's
--    free-text actor and session_user. The insert is made by a SECURITY DEFINER helper, called from the (invoker) trigger function,
--    and platform_ops holds SELECT only, so the role that changes the switch cannot insert, edit or remove an audit row. The helper
--    is owned by the dedicated NOLOGIN, member-less role sandbox_reap_audit_writer.
-- Row-level security is on for both tables (and forced). The ownership bracket is the 0618 / 0702 / 0739 one.

DO $$
DECLARE
  n text := 'sandbox_reap_audit_writer';
  r record;
  bad text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    INTO r FROM pg_roles WHERE rolname = n;
  bad := '{}';
  IF r.rolcanlogin THEN bad := array_append(bad, 'rolcanlogin'); END IF;
  IF r.rolsuper THEN bad := array_append(bad, 'rolsuper'); END IF;
  IF r.rolcreatedb THEN bad := array_append(bad, 'rolcreatedb'); END IF;
  IF r.rolcreaterole THEN bad := array_append(bad, 'rolcreaterole'); END IF;
  IF r.rolreplication THEN bad := array_append(bad, 'rolreplication'); END IF;
  IF r.rolbypassrls THEN bad := array_append(bad, 'rolbypassrls'); END IF;
  IF array_length(bad, 1) > 0 THEN
    RAISE EXCEPTION 'role % still has privileged attribute(s): %', n, array_to_string(bad, ', ');
  END IF;
END
$$;

CREATE TABLE sandbox_reap_settings (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  mode        text NULL CHECK (mode IN ('off', 'dry_run', 'on')),
  updated_by  text NOT NULL DEFAULT 'migration' CHECK (length(updated_by) BETWEEN 1 AND 200),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO sandbox_reap_settings (id, mode) VALUES (true, NULL);

ALTER TABLE sandbox_reap_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_reap_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_ops_read ON sandbox_reap_settings FOR SELECT TO platform_ops USING (true);
CREATE POLICY platform_ops_update ON sandbox_reap_settings FOR UPDATE TO platform_ops USING (true) WITH CHECK (true);
GRANT SELECT ON sandbox_reap_settings TO platform_ops;
GRANT UPDATE (mode, updated_by, updated_at) ON sandbox_reap_settings TO platform_ops;

CREATE TABLE sandbox_reap_settings_audit (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  previous_mode    text NULL CHECK (previous_mode IN ('off', 'dry_run', 'on')),
  mode             text NULL CHECK (mode IN ('off', 'dry_run', 'on')),
  actor            text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  db_session_user  text NOT NULL,
  changed_at       timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_sandbox_reap_settings_audit_changed ON sandbox_reap_settings_audit (changed_at);

-- The only writer is the SECURITY DEFINER helper below, owned by sandbox_reap_audit_writer. RLS is forced, so the insert policy names
-- that role alone: nobody else, platform_ops included, holds INSERT or a policy that would let a row in (a forged or back-dated one
-- included).
ALTER TABLE sandbox_reap_settings_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_reap_settings_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_ops_read ON sandbox_reap_settings_audit FOR SELECT TO platform_ops USING (true);
CREATE POLICY audit_writer_insert ON sandbox_reap_settings_audit FOR INSERT TO sandbox_reap_audit_writer WITH CHECK (true);
GRANT SELECT ON sandbox_reap_settings_audit TO platform_ops;
GRANT INSERT ON sandbox_reap_settings_audit TO sandbox_reap_audit_writer;

-- Attribution (0739's shape). A change of mode must say who made it: a BEFORE trigger refuses it unless the same UPDATE also set
-- updated_by, and stamps updated_at itself. `UPDATE OF updated_by` fires only when the column is in the statement's SET list, which is
-- how "was it set" is told apart from "has it a value"; the mark is transaction-local and consumed by the guard. The mark guards
-- against a forgotten updated_by, not against a deliberate caller. The free-text actor is the caller's word; the audit row also records
-- session_user, which is truthful but is the shared platform_ops login.
CREATE FUNCTION sandbox_reap_settings_mark_actor() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM set_config('fx.sandbox_reap_actor_set', 'set', true);
  RETURN NEW;
END $$;

CREATE FUNCTION sandbox_reap_settings_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  marked text := current_setting('fx.sandbox_reap_actor_set', true);
BEGIN
  PERFORM set_config('fx.sandbox_reap_actor_set', '', true);
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'sandbox_reap_settings: id cannot change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.mode IS DISTINCT FROM OLD.mode AND marked IS DISTINCT FROM 'set' THEN
    RAISE EXCEPTION 'sandbox_reap_settings: a change of mode must also set updated_by' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER sandbox_reap_settings_a_mark BEFORE UPDATE OF updated_by ON sandbox_reap_settings
  FOR EACH ROW EXECUTE FUNCTION sandbox_reap_settings_mark_actor();
CREATE TRIGGER sandbox_reap_settings_b_guard BEFORE UPDATE ON sandbox_reap_settings
  FOR EACH ROW EXECUTE FUNCTION sandbox_reap_settings_guard();

-- The trigger function is invoker-rights and owned by the migration owner, as every trigger function must be. It calls the definer,
-- which does the insert. The definer takes only the previous mode (a three-state value cannot be derived from the new one the way
-- 0739's boolean flip can); it reads the row's current mode and updated_by itself, stamps session_user and the clock, and refuses to
-- run outside a trigger (pg_trigger_depth() = 0 is a direct call). The pinned search_path and schema-qualified references are 0739's.
CREATE FUNCTION sandbox_reap_settings_audit_trg() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.mode IS DISTINCT FROM OLD.mode THEN
    PERFORM public.sandbox_reap_settings_audit_write(OLD.mode);
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION sandbox_reap_settings_audit_write(p_previous_mode text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  cur record;
BEGIN
  IF pg_trigger_depth() = 0 THEN
    RAISE EXCEPTION 'sandbox_reap_settings_audit_write: only callable from the settings trigger' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT s.mode, s.updated_by INTO cur FROM public.sandbox_reap_settings s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sandbox_reap_settings_audit_write: no settings row' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.sandbox_reap_settings_audit (previous_mode, mode, actor, db_session_user)
  VALUES (p_previous_mode, cur.mode, cur.updated_by, session_user);
END $$;
REVOKE ALL ON FUNCTION sandbox_reap_settings_audit_trg() FROM PUBLIC;
REVOKE ALL ON FUNCTION sandbox_reap_settings_audit_write(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sandbox_reap_settings_mark_actor() FROM PUBLIC;
REVOKE ALL ON FUNCTION sandbox_reap_settings_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sandbox_reap_settings_audit_write(text) TO platform_ops;

CREATE TRIGGER sandbox_reap_settings_audit AFTER UPDATE ON sandbox_reap_settings
  FOR EACH ROW EXECUTE FUNCTION sandbox_reap_settings_audit_trg();

-- The helper's owner reads the two columns it describes, and nothing else.
GRANT SELECT (mode, updated_by) ON sandbox_reap_settings TO sandbox_reap_audit_writer;
CREATE POLICY audit_writer_read ON sandbox_reap_settings FOR SELECT TO sandbox_reap_audit_writer USING (true);

-- Ownership bracket (0618 / 0702 / 0739's shape): a non-superuser migrator needs SET on the role for ALTER ... OWNER TO, and the role
-- needs CREATE on public at that instant. The membership is removed again afterwards so the role ends with no members.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'sandbox_reap_audit_writer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on sandbox_reap_audit_writer; cannot ALTER FUNCTION ... OWNER TO sandbox_reap_audit_writer';
    END IF;
    GRANT sandbox_reap_audit_writer TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO sandbox_reap_audit_writer;
ALTER FUNCTION sandbox_reap_settings_audit_write(text) OWNER TO sandbox_reap_audit_writer;
REVOKE CREATE ON SCHEMA public FROM sandbox_reap_audit_writer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE sandbox_reap_audit_writer FROM CURRENT_USER;
  END IF;
END
$$;

-- 3. runner_follow_up_run (0754): a follow-up that meets a reaper claim waits instead of ending the work item.
--
-- The definer creates the follow-up child through agent_run_create, which since 0761 raises FXR01 ('sandbox_reaping') while the reaper
-- holds an unexpired claim on the sandbox the child would reuse. 0754's catch-all (WHEN OTHERS) answered that `not_eligible`: the parent had
-- already been moved to `failed` by the caller, so the work item ended with no child. This re-creates the function (CREATE OR REPLACE:
-- owner runner_lease_definer and the EXECUTE grant for agent_run_writer are kept) with the body 0754 gave it and ONE added clause, which
-- re-raises FXR01 so the caller's transaction rolls back and the lease sweep tries again on a later tick. Nothing else changed.
-- The migrator takes the owning role for the statement, as 0754 and 0761 do, and gives it up again.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'runner_lease_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_lease_definer; cannot replace runner_follow_up_run';
    END IF;
    GRANT runner_lease_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION runner_follow_up_run(p_parent_run_id uuid)
RETURNS TABLE (outcome text, child_id uuid, item_id uuid, limit_reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  p        record;
  v_reason text;
  v_lost   integer;
  v_usage  integer;
  v_reset  timestamptz;
  v_text   text;
  v_after  timestamptz;
  v_child  uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_follow_up_run: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_acct IS NULL OR NOT account_is_active(v_acct) THEN
    RAISE EXCEPTION 'runner_follow_up_run: no active tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_parent_run_id IS NULL THEN
    RAISE EXCEPTION 'runner_follow_up_run: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.id, a.work_item_id, a.parent_run_id, a.role, a.runtime, a.status, a.head_sha, a.execution_mode, a.dispatch_repo_id, a.dispatch_pr_number,
         a.spec_version_id, a.resolved_exposure, a.exposure_digest, a.initiated_by, a.approved_by
    INTO p
    FROM public.agent_runs a
   WHERE a.account_id = v_acct AND a.id = p_parent_run_id
     FOR UPDATE;
  IF NOT FOUND OR p.runtime <> 'runner' OR p.status <> 'failed' OR p.resolved_exposure IS NULL OR p.exposure_digest IS NULL THEN
    RETURN QUERY SELECT 'not_eligible'::text, NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  -- What the parent's last move to `failed` recorded: the only place the reason lives.
  SELECT e.payload->>'failureReason' INTO v_reason
    FROM public.run_events e
   WHERE e.account_id = v_acct AND e.run_id = p.id AND e.kind = 'run.status_changed' AND e.payload->>'to' = 'failed'
   ORDER BY e.seq DESC LIMIT 1;
  IF v_reason IS NULL OR v_reason NOT IN ('runner_lost', 'usage_limit') THEN
    RETURN QUERY SELECT 'not_eligible'::text, NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  SELECT c.id INTO v_child FROM public.agent_runs c
   WHERE c.account_id = v_acct AND c.parent_run_id = p.id AND c.runtime = 'runner' LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT 'exists'::text, v_child, p.work_item_id, NULL::text;
    RETURN;
  END IF;

  -- The walk (C22 section 5), counted from the failing parent. A step to an ancestor is taken only when that ancestor is itself a
  -- failed runner run whose last move to `failed` recorded one of the two reasons; the first step that is not one ends the walk.
  WITH RECURSIVE chain(run_id, parent_id, reason, depth) AS (
    SELECT p.id, p.parent_run_id, v_reason, 1
    UNION ALL
    SELECT a.id, a.parent_run_id, hop.reason, c.depth + 1
      FROM chain c
      JOIN public.agent_runs a ON a.account_id = v_acct AND a.id = c.parent_id AND a.runtime = 'runner' AND a.status = 'failed'
      CROSS JOIN LATERAL (
        SELECT e.payload->>'failureReason' AS reason
          FROM public.run_events e
         WHERE e.account_id = v_acct AND e.run_id = a.id AND e.kind = 'run.status_changed' AND e.payload->>'to' = 'failed'
         ORDER BY e.seq DESC LIMIT 1
      ) hop
     WHERE c.depth < 16 AND hop.reason IN ('runner_lost', 'usage_limit')
  )
  SELECT count(*) FILTER (WHERE c.reason = 'runner_lost'), count(*) FILTER (WHERE c.reason = 'usage_limit')
    INTO v_lost, v_usage
    FROM chain c;

  IF v_reason = 'runner_lost' THEN
    IF v_lost >= 2 THEN
      RETURN QUERY SELECT 'exhausted'::text, NULL::uuid, p.work_item_id, 'runner_lost'::text;
      RETURN;
    END IF;
    v_after := NULL;
  ELSE
    -- A usage limit follow-up is exempt from the daily limit (C22 section 4), so the chain is bounded here: the eighth usage limit in
    -- one chain makes no child, which allows seven follow-ups of up to 24 hours each.
    IF v_usage >= 8 THEN
      RETURN QUERY SELECT 'exhausted'::text, NULL::uuid, p.work_item_id, 'usage_limit'::text;
      RETURN;
    END IF;
    -- The reset time the runner reported on its usage_limit_reached event, if it sent a well-formed one.
    SELECT e.payload->>'reset_at' INTO v_text
      FROM public.run_events e
     WHERE e.account_id = v_acct AND e.run_id = p.id AND e.kind = 'runner.event' AND e.payload->>'type' = 'usage_limit_reached'
       AND e.payload->>'reset_at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
     ORDER BY e.seq DESC LIMIT 1;
    BEGIN
      v_reset := v_text::timestamptz;
    EXCEPTION WHEN others THEN
      v_reset := NULL;
    END;
    v_after := CASE WHEN v_reset IS NULL THEN now() + interval '1 hour'
                    ELSE GREATEST(now(), LEAST(v_reset, now() + interval '24 hours')) END;
  END IF;

  -- Every run is created through agent_run_create (0750's comment): its halt check, its exposure and membership checks and its
  -- one-live-executor index all apply to the child. It runs as platform_ops, so this role needs no INSERT on agent_runs.
  BEGIN
    v_child := public.agent_run_create(
      p_id => NULL, p_account_id => v_acct, p_work_item_id => p.work_item_id, p_parent_run_id => p.id, p_role => p.role,
      p_runtime => 'runner', p_head_sha => p.head_sha, p_execution_mode => p.execution_mode, p_dispatch_repo_id => p.dispatch_repo_id,
      p_dispatch_pr_number => p.dispatch_pr_number, p_spec_version_id => p.spec_version_id, p_resolved_exposure => p.resolved_exposure,
      p_exposure_digest => p.exposure_digest, p_initiated_by => p.initiated_by);
  EXCEPTION
    WHEN SQLSTATE 'HX409' THEN
      -- The work item is halted (0750): no run is made, and none is owed. The move to `failed` stays.
      RETURN QUERY SELECT 'halted'::text, NULL::uuid, p.work_item_id, NULL::text;
      RETURN;
    WHEN unique_violation THEN
      SELECT c.id INTO v_child FROM public.agent_runs c
       WHERE c.account_id = v_acct AND c.parent_run_id = p.id AND c.runtime = 'runner' LIMIT 1;
      IF FOUND THEN
        RETURN QUERY SELECT 'exists'::text, v_child, p.work_item_id, NULL::text;
      ELSE
        -- Another live executor holds the pull request (the one-live-executor index): the work already has its next run.
        RETURN QUERY SELECT 'not_eligible'::text, NULL::uuid, p.work_item_id, NULL::text;
      END IF;
      RETURN;
    WHEN SQLSTATE 'FXR01' THEN
      -- 0762: the sandbox reaper holds a fresh claim on this pull request's sandbox (0761's lock in agent_run_create). That is a wait, not
      -- a refusal: it must NOT be answered `not_eligible`, which would leave the failed parent childless and end the work item. The error
      -- goes to the caller, whose transaction (the parent's move to `failed` and this call) rolls back, so the parent is still running with
      -- an expired lease and the next sweep tick asks again; the claim expires after 10 minutes or is marked deleted/skipped by then.
      RAISE;
    WHEN OTHERS THEN
      -- Anything else the create path refuses (the initiator has left the account: 42501; a foreign-key or check violation) must not
      -- undo the caller's move of the parent to `failed`: the sub-block is a savepoint, so the child's partial writes are undone and
      -- the answer is a non-created outcome. A childless failed parent ends the work item through the stage driver.
      RETURN QUERY SELECT 'not_eligible'::text, NULL::uuid, p.work_item_id, NULL::text;
      RETURN;
  END;
  -- The two columns agent_run_create has no argument for. The child is not visible to anyone else before this commits.
  UPDATE public.agent_runs SET approved_by = p.approved_by, claimable_after = v_after WHERE account_id = v_acct AND id = v_child;
  RETURN QUERY SELECT 'created'::text, v_child, p.work_item_id, NULL::text;
END;
$$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_lease_definer FROM CURRENT_USER;
  END IF;
END
$$;
