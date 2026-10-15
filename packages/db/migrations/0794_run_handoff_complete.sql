-- D#599 HO-2b: finishing a handoff (0787 asked for it): the new run on the other side, the reservations that move to it, the
-- sweep's lister, and the way a handoff ends badly. Nothing here signals a runner or reads GitHub; the web tier and the worker do that
-- and call these three functions with what they found.
--
--   run_handoff_complete_definer  NOLOGIN, no members, a member of nothing. Column grants for what the three bodies read and write,
--                       row policies for this role only, a pinned search_path, EXECUTE for agent_run_writer (the worker's login,
--                       the only login that may end a run) and nobody else. platform_ops and app_user gain NOTHING: a test diffs
--                       their privileges against the migrations without this file.
--
--   run_handoff_complete(run, forced, ceiling)
--       The parent run has already been moved to `cancelled` (reason handed_off) by the caller in this same transaction. Locks the
--       live handoff and the parent. `forced` needs the deadline to have passed (a `requested` handoff past it counts, as the state
--       table allows); not forced needs `checkpointing`. Counts the item's continuations (a handoff counts as one, like a limit
--       continuation) and refuses the one past `ceiling`. Creates the child through agent_run_create (0750's halt check, the
--       one-live-executor index and 0642's invariants apply to it), copies initiated_by and approved_by, excludes the source runner from
--       the claim (`excluded_runner_id`, runner target only), keys it `<parent>:continue` with the handoff hash, moves the handoff to
--       handed_off or forced with the child's id, and attaches the held reservations to the child (`spend_reservations.run_id`), so
--       settle and release key on the child. When any of that is refused, everything the child needed is rolled back to a savepoint and
--       the handoff goes to `failed` (run_handoff_fail below): the parent stays ended, the reservations are released and the placement
--       goes back. An `FXR01` (the sandbox reaper holds the sandbox) or a retryable database error (40P01, 40001, 55P03) is re-raised: the caller's transaction rolls back and the sweep
--       tries again.
--
--   run_handoff_fail(run, reason)
--       Ends a handoff as `failed` with a fixed reason. A live handoff (requested or checkpointing) releases its unattached open
--       reservations; a completed one (handed_off or forced) is failed only once its child has ended `failed`, and releases the
--       reservations that moved to the child. Release means state `released`, never a delete. The placement goes back to its prior value
--       when nobody changed it since.
--
--   run_handoff_list_due(limit, run)
--       The live handoffs, with the run's status and whether the runner's handed_off event is stored; one run's when `run` is given.
--       With no tenant in context it lists across tenants (the sweep); with one it lists that tenant's. Answers ids, states and times; nothing else.
--
-- Also: agent_runs.excluded_runner_id (written by this role alone, by a guard trigger), the transition table gains the one edge
-- handed_off|forced -> failed (a child that could not start), the 0740 compute-hold guard also lets this role release a hold, and 0003's
-- immutability guard lets this role (and no other) give a run-less reservation its run.
--
-- Numbered above the highest migration on the code plane (0793; 0787 is HO-2a, 0784 is held by an open pull request). Re-check against
-- main right before merging.

DO $$
DECLARE
  n text := 'run_handoff_complete_definer';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'role % still has a privileged attribute', n;
  END IF;
END
$$;

-- ---- the column, the guard and the changed rules ---------------------------------------------------------------------------
-- A run the claim must not give to this runner (the source of a handoff). Read by the claim; written by run_handoff_complete only.
ALTER TABLE agent_runs ADD COLUMN excluded_runner_id uuid;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_excluded_runner_fkey
  FOREIGN KEY (account_id, excluded_runner_id) REFERENCES runners (account_id, id) ON DELETE SET NULL (excluded_runner_id);

-- The claim (the worker's run-writer login) reads it to leave the source runner out of the child's candidates; nobody else gets it.
GRANT SELECT (excluded_runner_id) ON agent_runs TO agent_run_writer;

-- A plain INVOKER trigger function (the rule of 0724), so it adds no definer.
CREATE FUNCTION agent_runs_excluded_runner_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF ((TG_OP = 'INSERT' AND NEW.excluded_runner_id IS NOT NULL) OR (TG_OP = 'UPDATE' AND NEW.excluded_runner_id IS DISTINCT FROM OLD.excluded_runner_id))
     AND current_user <> 'run_handoff_complete_definer'
     AND NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false)
     -- The foreign-key action that clears it when a runner row is deleted: nested, and nothing else changes.
     AND NOT (TG_OP = 'UPDATE' AND pg_trigger_depth() > 1 AND NEW.excluded_runner_id IS NULL AND OLD.excluded_runner_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'agent_runs.excluded_runner_id is written only by the handoff completion definer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION agent_runs_excluded_runner_guard() FROM PUBLIC;
CREATE TRIGGER agent_runs_excluded_runner_guard BEFORE INSERT OR UPDATE ON agent_runs FOR EACH ROW EXECUTE FUNCTION agent_runs_excluded_runner_guard();

-- 0787's edges, plus handed_off|forced -> failed: a child that was made but could not start. Nothing else leaves a finished row.
CREATE OR REPLACE FUNCTION run_handoffs_check_transition() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;
  IF NOT ((OLD.state = 'requested' AND NEW.state IN ('checkpointing', 'cancelled', 'failed', 'forced'))
       OR (OLD.state = 'checkpointing' AND NEW.state IN ('handed_off', 'forced', 'failed'))
       OR (OLD.state IN ('handed_off', 'forced') AND NEW.state = 'failed')) THEN
    RAISE EXCEPTION 'illegal run_handoffs.state transition: % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
ALTER TABLE run_handoffs DROP CONSTRAINT run_handoffs_child_state_check;
ALTER TABLE run_handoffs ADD CONSTRAINT run_handoffs_child_state_check CHECK (child_run_id IS NULL OR state IN ('handed_off', 'forced', 'failed'));

-- 0787's compute-hold guard, with this role added. Its releases are bounded by its row policies below (an unattached hold of a live
-- handoff, or a hold attached to the child of a completed one whose child failed).
CREATE OR REPLACE FUNCTION spend_reservations_guard_compute_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.state = 'open'
     AND NEW.state IS DISTINCT FROM OLD.state
     AND (OLD.budget IN ('foreground_compute', 'background_compute') OR OLD.purpose = 'preview')
     AND NOT (pg_has_role(session_user, 'agent_run_writer', 'USAGE')
          OR pg_has_role(session_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'USAGE')
          OR (current_user = 'run_handoff_definer' AND OLD.run_id IS NULL)
          OR current_user = 'run_handoff_complete_definer')
  THEN
    RAISE EXCEPTION 'spend_reservations: only the runner may settle or release a compute or preview reservation'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- 0003's immutability guard, with one exception: a reservation taken for a handoff with no run (run_id null) may be given the run that
-- continues the work, by this role and by nobody else. Every other change to run_id, and any change to the other five columns, is still refused.
CREATE OR REPLACE FUNCTION spend_reservations_check_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- account_id is deliberately not checked here (0003's header says why).
  IF NEW.id IS DISTINCT FROM OLD.id
     OR (NEW.run_id IS DISTINCT FROM OLD.run_id AND NOT (OLD.run_id IS NULL AND NEW.run_id IS NOT NULL AND current_user = 'run_handoff_complete_definer'))
     OR NEW.usd_reserved IS DISTINCT FROM OLD.usd_reserved
     OR NEW.budget IS DISTINCT FROM OLD.budget
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'spend_reservations: id/run_id/usd_reserved/budget/purpose/created_at are immutable after insert'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---- what the three bodies read and write, column by column -----------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO run_handoff_complete_definer;
GRANT SELECT (id, account_id, run_id, item_id, from_side, to_side, state, deadline, reserve_until, prior_placement, reservation_id, compute_reservation_id, child_run_id, created_at),
      UPDATE (state, child_run_id, updated_at) ON run_handoffs TO run_handoff_complete_definer;
GRANT SELECT (id, account_id, work_item_id, parent_run_id, role, runtime, status, head_sha, execution_mode, dispatch_repo_id, dispatch_pr_number,
              spec_version_id, resolved_exposure, exposure_digest, initiated_by, approved_by, runner_id, env_version_id, image_digest),
      UPDATE (approved_by, excluded_runner_id) ON agent_runs TO run_handoff_complete_definer;
GRANT SELECT (id, account_id, placement), UPDATE (placement) ON work_items TO run_handoff_complete_definer;
GRANT SELECT (id, account_id, run_id, state), UPDATE (run_id, state) ON spend_reservations TO run_handoff_complete_definer;
GRANT SELECT (id, account_id, execution_mode) ON repos TO run_handoff_complete_definer;
GRANT SELECT (account_id, run_id, request_hash), INSERT (account_id, idempotency_key, run_id, request_hash) ON agent_run_idempotency_keys TO run_handoff_complete_definer;
GRANT SELECT (account_id, run_id, kind, payload) ON run_events TO run_handoff_complete_definer;
GRANT SELECT (id, deleted_at) ON accounts TO run_handoff_complete_definer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO run_handoff_complete_definer;

-- Row policies for this role only. The lister runs with no tenant and reads the live handoffs, their runs and the event that says the
-- runner stopped; every other read, and every write, is held to the caller's tenant.
CREATE POLICY run_handoff_complete_definer_select ON run_handoffs FOR SELECT TO run_handoff_complete_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid OR NULLIF(current_setting('app.account_id', true), '') IS NULL);
CREATE POLICY run_handoff_complete_definer_update ON run_handoffs FOR UPDATE TO run_handoff_complete_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND state IN ('requested', 'checkpointing', 'handed_off', 'forced'))
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY run_handoff_complete_definer_select ON agent_runs FOR SELECT TO run_handoff_complete_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid OR NULLIF(current_setting('app.account_id', true), '') IS NULL);
CREATE POLICY run_handoff_complete_definer_update ON agent_runs FOR UPDATE TO run_handoff_complete_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY run_handoff_complete_definer_select ON work_items FOR SELECT TO run_handoff_complete_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY run_handoff_complete_definer_update ON work_items FOR UPDATE TO run_handoff_complete_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY run_handoff_complete_definer_select ON repos FOR SELECT TO run_handoff_complete_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY run_handoff_complete_definer_select ON agent_run_idempotency_keys FOR SELECT TO run_handoff_complete_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY run_handoff_complete_definer_insert ON agent_run_idempotency_keys FOR INSERT TO run_handoff_complete_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY run_handoff_complete_definer_select ON run_events FOR SELECT TO run_handoff_complete_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid OR NULLIF(current_setting('app.account_id', true), '') IS NULL);
CREATE POLICY run_handoff_complete_definer_select ON accounts FOR SELECT TO run_handoff_complete_definer USING (true);
CREATE POLICY run_handoff_complete_definer_audit ON audit_log FOR INSERT TO run_handoff_complete_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND action IN ('run.handoff.completed', 'run.handoff.failed'));

-- A reservation is visible to this role while it is attached to no run, or to the child of a handoff that names it. It can be changed
-- three ways and no other: released while unattached and only when a live handoff (requested or checkpointing) names it, attached to the child its handoff names (still open), and
-- released once attached when the handoff is completed and its child has failed.
CREATE POLICY run_handoff_complete_definer_select ON spend_reservations FOR SELECT TO run_handoff_complete_definer
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (run_id IS NULL OR EXISTS (SELECT 1 FROM public.run_handoffs h WHERE h.account_id = spend_reservations.account_id AND h.child_run_id = spend_reservations.run_id
                                    AND spend_reservations.id IN (h.reservation_id, h.compute_reservation_id)))
  );
CREATE POLICY run_handoff_complete_definer_release ON spend_reservations FOR UPDATE TO run_handoff_complete_definer
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND state = 'open' AND run_id IS NULL
    AND EXISTS (SELECT 1 FROM public.run_handoffs h WHERE h.account_id = spend_reservations.account_id
                 AND spend_reservations.id IN (h.reservation_id, h.compute_reservation_id) AND h.state IN ('requested', 'checkpointing'))
  )
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND run_id IS NULL AND state = 'released');
-- The attach policy's USING is as narrow as the release policy's: update policies are OR'd, so a row either one could pick is a row the
-- other's WITH CHECK could then turn into a released one. It names only a hold of a handoff that has just been completed (its child is set,
-- as run_handoff_complete does before it moves the holds).
CREATE POLICY run_handoff_complete_definer_attach ON spend_reservations FOR UPDATE TO run_handoff_complete_definer
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND state = 'open' AND run_id IS NULL
    AND EXISTS (SELECT 1 FROM public.run_handoffs h WHERE h.account_id = spend_reservations.account_id AND h.child_run_id IS NOT NULL
                 AND spend_reservations.id IN (h.reservation_id, h.compute_reservation_id) AND h.state IN ('handed_off', 'forced'))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND state = 'open' AND run_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.run_handoffs h WHERE h.account_id = spend_reservations.account_id AND h.child_run_id = spend_reservations.run_id
                 AND spend_reservations.id IN (h.reservation_id, h.compute_reservation_id))
  );
CREATE POLICY run_handoff_complete_definer_release_attached ON spend_reservations FOR UPDATE TO run_handoff_complete_definer
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND state = 'open' AND run_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.run_handoffs h WHERE h.account_id = spend_reservations.account_id AND h.child_run_id = spend_reservations.run_id
                 AND spend_reservations.id IN (h.reservation_id, h.compute_reservation_id) AND h.state IN ('handed_off', 'forced'))
  )
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND state = 'released');

-- ---- ownership brackets (as 0754 / 0787) -------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'run_handoff_complete_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on run_handoff_complete_definer; cannot ALTER FUNCTION ... OWNER TO run_handoff_complete_definer';
    END IF;
    GRANT run_handoff_complete_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO run_handoff_complete_definer;

CREATE FUNCTION run_handoff_fail(p_run_id uuid, p_reason text)
RETURNS TABLE (outcome text, handoff_id uuid, item_id uuid, placement_reverted boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  acct    uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  rec     record;
  v_child text;
  v_place text;
  v_rev   boolean := false;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'run_handoff_fail: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'run_handoff_fail: no active tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_run_id IS NULL OR p_reason IS NULL OR p_reason NOT IN ('expired', 'run_ended', 'child_not_started', 'work_item_ceiling') THEN
    RAISE EXCEPTION 'run_handoff_fail: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT h.id, h.item_id, h.state, h.to_side, h.prior_placement, h.reservation_id, h.compute_reservation_id, h.child_run_id INTO rec
    FROM public.run_handoffs h
   WHERE h.run_id = p_run_id AND h.account_id = acct AND h.state IN ('requested', 'checkpointing', 'handed_off', 'forced')
   ORDER BY h.created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'none'::text, NULL::uuid, NULL::uuid, false;
    RETURN;
  END IF;
  IF rec.state IN ('handed_off', 'forced') THEN
    -- A completed handoff fails only when its child has ended `failed` (it could not start).
    SELECT c.status INTO v_child FROM public.agent_runs c WHERE c.id = rec.child_run_id AND c.account_id = acct;
    IF v_child IS DISTINCT FROM 'failed' THEN
      RETURN QUERY SELECT 'child_live'::text, rec.id, rec.item_id, false;
      RETURN;
    END IF;
  END IF;

  -- Released, never deleted: the unattached holds of a live handoff, or the holds that moved to the child that failed. Before the state
  -- changes, because the policy that shows an attached hold reads the handoff as completed.
  UPDATE public.spend_reservations s SET state = 'released'
   WHERE s.account_id = acct AND s.state = 'open' AND s.id IN (rec.reservation_id, rec.compute_reservation_id)
     AND (s.run_id IS NULL OR s.run_id = rec.child_run_id);
  UPDATE public.run_handoffs SET state = 'failed', updated_at = clock_timestamp() WHERE id = rec.id;

  SELECT w.placement INTO v_place FROM public.work_items w WHERE w.id = rec.item_id AND w.account_id = acct FOR UPDATE;
  IF FOUND AND v_place IS NOT DISTINCT FROM rec.to_side AND rec.prior_placement IS DISTINCT FROM rec.to_side THEN
    UPDATE public.work_items SET placement = rec.prior_placement WHERE id = rec.item_id AND account_id = acct;
    v_rev := true;
  END IF;

  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, 'system', 'run.handoff.failed',
          jsonb_build_object('handoff_id', rec.id, 'run_id', p_run_id, 'item_id', rec.item_id, 'to', rec.to_side, 'reason', p_reason, 'placement_reverted', v_rev),
          clock_timestamp());
  RETURN QUERY SELECT 'failed'::text, rec.id, rec.item_id, v_rev;
END;
$$;

CREATE FUNCTION run_handoff_complete(p_run_id uuid, p_forced boolean, p_ceiling integer)
RETURNS TABLE (outcome text, handoff_id uuid, child_id uuid, item_id uuid, to_side text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  h      record;
  p      record;
  v_mode text;
  v_rt   text;
  v_total integer;
  v_want  integer;
  v_got   integer;
  v_child uuid;
  v_failed boolean := false;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'run_handoff_complete: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'run_handoff_complete: no active tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_run_id IS NULL OR p_forced IS NULL OR p_ceiling IS NULL OR p_ceiling < 1 OR p_ceiling > 1000 THEN
    RAISE EXCEPTION 'run_handoff_complete: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT x.id, x.item_id, x.state, x.to_side, x.deadline, x.reservation_id, x.compute_reservation_id INTO h
    FROM public.run_handoffs x WHERE x.run_id = p_run_id AND x.account_id = acct AND x.state IN ('requested', 'checkpointing') FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'none'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  IF p_forced THEN
    IF h.deadline > clock_timestamp() THEN
      RETURN QUERY SELECT 'not_due'::text, h.id, NULL::uuid, h.item_id, h.to_side;
      RETURN;
    END IF;
  ELSIF h.state <> 'checkpointing' THEN
    RETURN QUERY SELECT 'not_ready'::text, h.id, NULL::uuid, h.item_id, h.to_side;
    RETURN;
  END IF;

  SELECT a.id, a.work_item_id, a.role, a.status, a.head_sha, a.dispatch_repo_id, a.dispatch_pr_number, a.spec_version_id, a.resolved_exposure,
         a.exposure_digest, a.initiated_by, a.approved_by, a.runner_id, a.env_version_id, a.image_digest INTO p
    FROM public.agent_runs a WHERE a.id = p_run_id AND a.account_id = acct FOR UPDATE;
  IF NOT FOUND OR p.status <> 'cancelled' OR p.work_item_id IS DISTINCT FROM h.item_id THEN
    -- The caller ends the parent first, in this transaction; a parent that is anything else is not ours to continue.
    RETURN QUERY SELECT 'parent_not_ended'::text, h.id, NULL::uuid, h.item_id, h.to_side;
    RETURN;
  END IF;

  SELECT count(*) INTO v_total
    FROM public.agent_runs r JOIN public.agent_run_idempotency_keys k ON k.account_id = r.account_id AND k.run_id = r.id
   WHERE r.account_id = acct AND r.work_item_id = h.item_id AND r.parent_run_id IS NOT NULL AND r.status <> 'refused_spend' AND r.parent_run_id <> p_run_id
     AND k.request_hash IN (encode(sha256(convert_to('continue:auto', 'UTF8')), 'hex'), encode(sha256(convert_to('continue:manual', 'UTF8')), 'hex'),
                            encode(sha256(convert_to('continue:handoff', 'UTF8')), 'hex'));
  IF v_total >= p_ceiling THEN
    PERFORM public.run_handoff_fail(p_run_id, 'work_item_ceiling');
    RETURN QUERY SELECT 'work_item_ceiling'::text, h.id, NULL::uuid, h.item_id, h.to_side;
    RETURN;
  END IF;

  IF h.to_side = 'runner' THEN
    SELECT r.execution_mode INTO v_mode FROM public.repos r WHERE r.id = p.dispatch_repo_id AND r.account_id = acct;
    v_rt := 'runner';
    IF v_mode IS NULL OR v_mode NOT IN ('runner_local', 'runner_verified') THEN
      v_failed := true;
    END IF;
  ELSE
    v_mode := 'sandbox';
    v_rt := 'production';
  END IF;

  IF NOT v_failed THEN
    v_want := (h.reservation_id IS NOT NULL)::int + (h.compute_reservation_id IS NOT NULL)::int;
    BEGIN
      v_child := public.agent_run_create(
        p_id => NULL, p_account_id => acct, p_work_item_id => p.work_item_id, p_parent_run_id => p.id, p_role => p.role,
        p_runtime => v_rt, p_head_sha => p.head_sha, p_execution_mode => v_mode, p_dispatch_repo_id => p.dispatch_repo_id,
        p_dispatch_pr_number => p.dispatch_pr_number, p_spec_version_id => p.spec_version_id, p_resolved_exposure => p.resolved_exposure,
        p_exposure_digest => p.exposure_digest, p_initiated_by => p.initiated_by, p_env_version_id => p.env_version_id, p_image_digest => p.image_digest);
      -- The two columns agent_run_create has no argument for. Only a runner target excludes the machine the run was on.
      UPDATE public.agent_runs SET approved_by = p.approved_by, excluded_runner_id = CASE WHEN h.to_side = 'runner' THEN p.runner_id END
       WHERE id = v_child AND account_id = acct;
      INSERT INTO public.agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash)
      VALUES (acct, p.id::text || ':continue', v_child, encode(sha256(convert_to('continue:handoff', 'UTF8')), 'hex'));
      UPDATE public.run_handoffs SET state = CASE WHEN p_forced THEN 'forced' ELSE 'handed_off' END, child_run_id = v_child, updated_at = clock_timestamp()
       WHERE id = h.id;
      -- The held reservations move to the child: settle and release key on run_id.
      UPDATE public.spend_reservations s SET run_id = v_child
       WHERE s.account_id = acct AND s.state = 'open' AND s.run_id IS NULL AND s.id IN (h.reservation_id, h.compute_reservation_id);
      GET DIAGNOSTICS v_got = ROW_COUNT;
      IF v_got <> v_want THEN
        RAISE EXCEPTION 'run_handoff_complete: a held reservation is no longer open' USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
    EXCEPTION
      WHEN SQLSTATE 'FXR01' OR SQLSTATE '40P01' OR SQLSTATE '40001' OR SQLSTATE '55P03' THEN
        -- A wait, not a refusal: the sandbox reaper holds this pull request's sandbox (FXR01), or the database asked for a retry (a deadlock,
        -- a serialization failure, a lock that could not be taken). The caller's transaction rolls back, the handoff stays live and the sweep asks again.
        RAISE;
      WHEN OTHERS THEN
        v_failed := true;
    END;
  END IF;

  IF v_failed THEN
    PERFORM public.run_handoff_fail(p_run_id, 'child_not_started');
    RETURN QUERY SELECT 'child_not_created'::text, h.id, NULL::uuid, h.item_id, h.to_side;
    RETURN;
  END IF;

  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, 'system', 'run.handoff.completed',
          jsonb_build_object('handoff_id', h.id, 'run_id', p_run_id, 'child_run_id', v_child, 'item_id', h.item_id, 'to', h.to_side, 'forced', p_forced),
          clock_timestamp());
  RETURN QUERY SELECT 'created'::text, h.id, v_child, h.item_id, h.to_side;
END;
$$;

CREATE FUNCTION run_handoff_list_due(p_limit integer, p_run_id uuid)
RETURNS TABLE (account_id uuid, run_id uuid, state text, deadline timestamptz, reserve_until timestamptz, run_status text, ended_event boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'run_handoff_list_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'run_handoff_list_due: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    SELECT h.account_id, h.run_id, h.state, h.deadline, h.reserve_until, a.status,
           EXISTS (SELECT 1 FROM public.run_events e WHERE e.account_id = h.account_id AND e.run_id = h.run_id AND e.kind = 'runner.event'
                      AND e.payload->>'type' = 'run_ended' AND e.payload->>'reason' = 'handed_off')
      FROM public.run_handoffs h JOIN public.agent_runs a ON a.account_id = h.account_id AND a.id = h.run_id
     WHERE h.state IN ('requested', 'checkpointing') AND public.account_is_active(h.account_id) AND (p_run_id IS NULL OR h.run_id = p_run_id)
     ORDER BY h.deadline, h.id
     LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION run_handoff_fail(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION run_handoff_complete(uuid, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION run_handoff_list_due(integer, uuid) FROM PUBLIC;
ALTER FUNCTION run_handoff_fail(uuid, text) OWNER TO run_handoff_complete_definer;
ALTER FUNCTION run_handoff_complete(uuid, boolean, integer) OWNER TO run_handoff_complete_definer;
ALTER FUNCTION run_handoff_list_due(integer, uuid) OWNER TO run_handoff_complete_definer;
-- The owner creates the child through agent_run_create, as runner_lease_definer does (0754). A grant OF one function platform_ops owns.
GRANT EXECUTE ON FUNCTION agent_run_create(uuid, uuid, uuid, uuid, text, text, text, text, uuid, bigint, uuid, jsonb, text, uuid, text, text) TO run_handoff_complete_definer;
-- EXECUTE is granted after the transfer: changing an owner rewrites the ACL entries that named the old one.
GRANT EXECUTE ON FUNCTION run_handoff_fail(uuid, text) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION run_handoff_complete(uuid, boolean, integer) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION run_handoff_list_due(integer, uuid) TO agent_run_writer;

REVOKE CREATE ON SCHEMA public FROM run_handoff_complete_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE run_handoff_complete_definer FROM CURRENT_USER;
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
