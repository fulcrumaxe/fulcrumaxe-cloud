-- D#599 HO-2a: the state of moving a RUNNING run between the person's runner and the cloud sandbox (a handoff), and the three
-- definers that change it. Nothing here signals a runner or starts a child run: the request route, the heartbeat answer and the
-- state table are this file's; completion, the deadline sweep and the child run are HO-2b's.
--
--   run_handoffs        one row per request. `state` is requested, checkpointing, handed_off, forced, cancelled or failed; a trigger
--                       allows only the edges below, and a finished row never changes. One LIVE handoff (requested or
--                       checkpointing) per run, by a partial unique index. `from_side` / `to_side` are 'cloud' or 'runner'; the one
--                       same-side move that is allowed is runner to runner (the fleet's drain, D#605 FL-11), which the new run
--                       reaches by pull: it excludes the source runner and passes the full claim predicate like any other run.
--                       `prior_placement` is the item's placement before the request, kept so a cancel or a failed child can put
--                       it back. `reservation_id` / `compute_reservation_id` are the model and compute spend reservations taken
--                       for a cloud target BEFORE the signal (null for a runner target); they are taken with no run yet
--                       (spend_reservations.run_id null), so settling the run being moved never touches them, and HO-2b attaches
--                       them to the new run. `reserve_until` = deadline + the queue TTL: HO-2b's sweep releases what is left after it.
--
--   run_handoff_definer NOLOGIN, no members, a member of nothing. Column grants for what the three bodies read and write, row
--                       policies for this role only, a pinned search_path, EXECUTE for app_user alone. platform_ops gains NOTHING
--                       (a test diffs its privileges against the migrations without this file). app_user may read the rows of its
--                       tenant and write none.
--
--   run_handoff_request(run, to, deadline, reserve_until, reservation, compute_reservation, between_runners)
--       Owner or admin of an active account, re-derived here. Locks the run and the item. The run must be running and belong to an
--       item (55000 otherwise). The side it runs on is read from the run itself (a sandbox run is the cloud, any runner mode is the
--       runner), never from the caller. A second live request on the run is 23505. A cloud target must bring its reservations,
--       which must be open, of this account and attached to no run; a runner target brings none. Inserts the row as `requested`,
--       sets the item's placement to the target, and writes one audit row, all in the caller's transaction.
--
--   run_handoff_cancel(run)
--       Owner or admin. Only a `requested` handoff can be cancelled (a `checkpointing` one answers 55006: the side has begun and the
--       move completes). Marks it cancelled and RELEASES its two unattached open reservations (state open to released, by id;
--       a reservation row is never deleted, as 0001 decided; the ids stay on the cancelled row as the record), puts the item's placement back if nobody changed it since, and writes one audit row.
--
--   run_handoff_signal(run, min_version)
--       Called from the heartbeat, in the runner's own session (app.runner_id). Answers the deadline of the run's live handoff, and
--       moves `requested` to `checkpointing`, only when the run is running on THIS runner and the runner's stored protocol_version
--       is at least min_version (R-599-HO1: a runner that cannot read the field is never sent it). Otherwise null and nothing changes.
--
-- Numbered above the highest migration on the code plane (0783; 0784 is held by an open pull request). Re-check against main
-- right before merging.

DO $$
DECLARE
  n text := 'run_handoff_definer';
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

CREATE TABLE run_handoffs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  run_id                 uuid NOT NULL,
  item_id                uuid NOT NULL,
  from_side              text NOT NULL,
  to_side                text NOT NULL,
  state                  text NOT NULL DEFAULT 'requested',
  deadline               timestamptz NOT NULL,
  reserve_until          timestamptz NOT NULL,
  requested_by           uuid NOT NULL,
  prior_placement        text,
  reservation_id         uuid REFERENCES spend_reservations (id) ON DELETE SET NULL,
  compute_reservation_id uuid REFERENCES spend_reservations (id) ON DELETE SET NULL,
  child_run_id           uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, child_run_id) REFERENCES agent_runs (account_id, id) ON DELETE SET NULL (child_run_id),
  CONSTRAINT run_handoffs_sides_check CHECK (from_side IN ('cloud', 'runner') AND to_side IN ('cloud', 'runner') AND (from_side <> to_side OR from_side = 'runner')),
  CONSTRAINT run_handoffs_state_check CHECK (state IN ('requested', 'checkpointing', 'handed_off', 'forced', 'cancelled', 'failed')),
  CONSTRAINT run_handoffs_prior_check CHECK (prior_placement IS NULL OR prior_placement IN ('cloud', 'runner')),
  CONSTRAINT run_handoffs_reserve_check CHECK (reserve_until >= deadline),
  CONSTRAINT run_handoffs_reservation_target_check CHECK (to_side = 'cloud' OR (reservation_id IS NULL AND compute_reservation_id IS NULL)),
  CONSTRAINT run_handoffs_child_state_check CHECK (child_run_id IS NULL OR state IN ('handed_off', 'forced'))
);
CREATE UNIQUE INDEX run_handoffs_one_live_per_run ON run_handoffs (run_id) WHERE state IN ('requested', 'checkpointing');
-- Two live handoffs can never name the same hold.
CREATE UNIQUE INDEX run_handoffs_one_live_per_reservation ON run_handoffs (reservation_id) WHERE reservation_id IS NOT NULL AND state IN ('requested', 'checkpointing');
CREATE UNIQUE INDEX run_handoffs_one_live_per_compute_reservation ON run_handoffs (compute_reservation_id) WHERE compute_reservation_id IS NOT NULL AND state IN ('requested', 'checkpointing');
CREATE INDEX idx_run_handoffs_account_id ON run_handoffs (account_id);
CREATE INDEX idx_run_handoffs_item ON run_handoffs (item_id);
ALTER TABLE run_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_handoffs FORCE ROW LEVEL SECURITY;

-- The only edges. A finished row (handed_off, forced, cancelled, failed) is never changed again. A plain INVOKER trigger
-- function in the form of 0002's, so it adds no definer.
CREATE FUNCTION run_handoffs_check_transition() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;
  IF NOT ((OLD.state = 'requested' AND NEW.state IN ('checkpointing', 'cancelled', 'failed', 'forced'))
       OR (OLD.state = 'checkpointing' AND NEW.state IN ('handed_off', 'forced', 'failed'))) THEN
    RAISE EXCEPTION 'illegal run_handoffs.state transition: % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION run_handoffs_check_transition() FROM PUBLIC;
CREATE TRIGGER run_handoffs_state_transition BEFORE UPDATE OF state ON run_handoffs FOR EACH ROW EXECUTE FUNCTION run_handoffs_check_transition();

-- app_user reads its tenant's rows (the item page and the later routes) and writes none.
GRANT SELECT (id, account_id, run_id, item_id, from_side, to_side, state, deadline, reserve_until, requested_by, prior_placement, reservation_id, compute_reservation_id, child_run_id, created_at, updated_at) ON run_handoffs TO app_user;
CREATE POLICY tenant_isolation_select ON run_handoffs FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

-- What the three bodies read and write, column by column.
GRANT USAGE ON SCHEMA public TO run_handoff_definer;
GRANT SELECT (id, account_id, run_id, item_id, from_side, to_side, state, deadline, reserve_until, requested_by, prior_placement, reservation_id, compute_reservation_id),
      INSERT (account_id, run_id, item_id, from_side, to_side, deadline, reserve_until, requested_by, prior_placement, reservation_id, compute_reservation_id),
      UPDATE (state, updated_at) ON run_handoffs TO run_handoff_definer;
GRANT SELECT (id, account_id, status, execution_mode, work_item_id, runner_id), UPDATE (updated_at) ON agent_runs TO run_handoff_definer;
GRANT SELECT (id, account_id, placement), UPDATE (placement) ON work_items TO run_handoff_definer;
GRANT SELECT (id, account_id, run_id, state), UPDATE (state) ON spend_reservations TO run_handoff_definer;
GRANT SELECT (id, account_id, protocol_version, revoked_at) ON runners TO run_handoff_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO run_handoff_definer;
GRANT SELECT (id, deleted_at) ON accounts TO run_handoff_definer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO run_handoff_definer;

CREATE POLICY run_handoff_definer_select ON run_handoffs FOR SELECT TO run_handoff_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY run_handoff_definer_insert ON run_handoffs FOR INSERT TO run_handoff_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND state = 'requested');
CREATE POLICY run_handoff_definer_update ON run_handoffs FOR UPDATE TO run_handoff_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND state IN ('requested', 'checkpointing'))
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY run_handoff_definer_select ON agent_runs FOR SELECT TO run_handoff_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY run_handoff_definer_update ON agent_runs FOR UPDATE TO run_handoff_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY run_handoff_definer_select ON work_items FOR SELECT TO run_handoff_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY run_handoff_definer_update ON work_items FOR UPDATE TO run_handoff_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
-- A reservation is visible to this role only while it is attached to no run (the row after a release must stay visible too, or the UPDATE's
-- new row fails the SELECT policy), and only an open one can be changed, and only to released.
CREATE POLICY run_handoff_definer_select ON spend_reservations FOR SELECT TO run_handoff_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND run_id IS NULL);
CREATE POLICY run_handoff_definer_update ON spend_reservations FOR UPDATE TO run_handoff_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND state = 'open' AND run_id IS NULL)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND run_id IS NULL AND state = 'released');

-- 0740 lets only a runner-writer session change the state of a compute or preview hold. The handoff definer releases the compute hold of
-- a cancelled move, and only one bound to no run. current_user is the function owner inside a SECURITY DEFINER body; the role has no
-- member and no login, so no session can claim it, and a plain app_user session is still refused.
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
          OR (current_user = 'run_handoff_definer' AND OLD.run_id IS NULL))
  THEN
    RAISE EXCEPTION 'spend_reservations: only the runner may settle or release a compute or preview reservation'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE POLICY run_handoff_definer_select ON runners FOR SELECT TO run_handoff_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY run_handoff_definer_select ON account_members FOR SELECT TO run_handoff_definer
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
CREATE POLICY run_handoff_definer_select ON accounts FOR SELECT TO run_handoff_definer USING (true);
CREATE POLICY run_handoff_definer_audit ON audit_log FOR INSERT TO run_handoff_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND action IN ('run.handoff.requested', 'run.handoff.cancelled'));

-- ---- ownership brackets (as 0759 / 0781) ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'run_handoff_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on run_handoff_definer; cannot ALTER FUNCTION ... OWNER TO run_handoff_definer';
    END IF;
    GRANT run_handoff_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO run_handoff_definer;

CREATE FUNCTION run_handoff_request(
  p_run_id uuid, p_to text, p_deadline timestamptz, p_reserve_until timestamptz,
  p_reservation_id uuid, p_compute_reservation_id uuid, p_between_runners boolean
)
RETURNS TABLE (handoff_id uuid, from_side text, prior_placement text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  acct     uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr      uuid;
  v_role   text;
  v_item   uuid;
  v_status text;
  v_mode   text;
  v_from   text;
  v_place  text;
  v_id     uuid;
  v_found  integer;
  v_wanted integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'run_handoff_request: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'run_handoff_request: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_run_id IS NULL OR p_to IS NULL OR p_to NOT IN ('cloud', 'runner') OR p_between_runners IS NULL
     OR p_deadline IS NULL OR p_reserve_until IS NULL OR p_deadline <= clock_timestamp() OR p_reserve_until < p_deadline THEN
    RAISE EXCEPTION 'run_handoff_request: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.work_item_id, a.status, a.execution_mode INTO v_item, v_status, v_mode
    FROM public.agent_runs a WHERE a.id = p_run_id AND a.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_handoff_request: no such run' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_status <> 'running' OR v_item IS NULL THEN
    RAISE EXCEPTION 'run_handoff_request: the run is not a running run of a work item' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- The side it runs on comes from the run, never from the caller. Only a runner-to-runner move may name the side it is on.
  v_from := CASE WHEN v_mode = 'sandbox' THEN 'cloud' ELSE 'runner' END;
  IF p_to = v_from AND NOT (v_from = 'runner' AND p_between_runners) THEN
    RAISE EXCEPTION 'run_handoff_request: the run is already on that side' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT w.placement INTO v_place FROM public.work_items w WHERE w.id = v_item AND w.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_handoff_request: no such item' USING ERRCODE = 'no_data_found';
  END IF;
  -- The unique index is the backstop; this answers the common case without an aborted statement.
  IF EXISTS (SELECT 1 FROM public.run_handoffs h WHERE h.run_id = p_run_id AND h.account_id = acct AND h.state IN ('requested', 'checkpointing')) THEN
    RAISE EXCEPTION 'run_handoff_request: a handoff is already in progress for this run' USING ERRCODE = 'unique_violation';
  END IF;

  -- A cloud target brings the reservations it took (open, unattached, this account's, and each one once); a runner target brings none.
  v_wanted := (p_reservation_id IS NOT NULL)::int + (p_compute_reservation_id IS NOT NULL)::int;
  IF v_wanted > 0 AND (p_to <> 'cloud' OR p_reservation_id IS NOT DISTINCT FROM p_compute_reservation_id) THEN
    RAISE EXCEPTION 'run_handoff_request: invalid reservations' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_wanted > 0 THEN
    SELECT count(*) INTO v_found FROM public.spend_reservations s
     WHERE s.account_id = acct AND s.state = 'open' AND s.run_id IS NULL AND s.id IN (p_reservation_id, p_compute_reservation_id);
    IF v_found <> v_wanted THEN
      RAISE EXCEPTION 'run_handoff_request: invalid reservations' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  INSERT INTO public.run_handoffs AS h (account_id, run_id, item_id, from_side, to_side, deadline, reserve_until, requested_by, prior_placement, reservation_id, compute_reservation_id)
  VALUES (acct, p_run_id, v_item, v_from, p_to, p_deadline, p_reserve_until, usr, v_place, p_reservation_id, p_compute_reservation_id)
  RETURNING h.id INTO v_id;
  UPDATE public.work_items SET placement = p_to WHERE id = v_item AND account_id = acct;

  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'run.handoff.requested',
          jsonb_build_object('handoff_id', v_id, 'run_id', p_run_id, 'item_id', v_item, 'from', v_from, 'to', p_to, 'prior_placement', v_place),
          clock_timestamp());
  handoff_id := v_id;
  from_side := v_from;
  prior_placement := v_place;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION run_handoff_cancel(p_run_id uuid)
RETURNS TABLE (handoff_id uuid, to_side text, prior_placement text, reverted boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr    uuid;
  v_role text;
  rec    record;
  v_place text;
  v_rev  boolean := false;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'run_handoff_cancel: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'run_handoff_cancel: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'run_handoff_cancel: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT h.id, h.item_id, h.state, h.to_side, h.prior_placement, h.reservation_id, h.compute_reservation_id INTO rec
    FROM public.run_handoffs h WHERE h.run_id = p_run_id AND h.account_id = acct AND h.state IN ('requested', 'checkpointing') FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_handoff_cancel: no live handoff on this run' USING ERRCODE = 'no_data_found';
  END IF;
  IF rec.state <> 'requested' THEN
    RAISE EXCEPTION 'run_handoff_cancel: the move has begun and completes' USING ERRCODE = 'object_in_use';
  END IF;

  UPDATE public.run_handoffs SET state = 'cancelled', updated_at = clock_timestamp() WHERE id = rec.id;
  UPDATE public.spend_reservations s SET state = 'released'
   WHERE s.account_id = acct AND s.state = 'open' AND s.run_id IS NULL AND s.id IN (rec.reservation_id, rec.compute_reservation_id);

  -- The placement goes back only when nobody changed it since the request ("last write wins"; both writes are audited).
  SELECT w.placement INTO v_place FROM public.work_items w WHERE w.id = rec.item_id AND w.account_id = acct FOR UPDATE;
  IF FOUND AND v_place IS NOT DISTINCT FROM rec.to_side AND rec.prior_placement IS DISTINCT FROM rec.to_side THEN
    UPDATE public.work_items SET placement = rec.prior_placement WHERE id = rec.item_id AND account_id = acct;
    v_rev := true;
  END IF;

  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'run.handoff.cancelled',
          jsonb_build_object('handoff_id', rec.id, 'run_id', p_run_id, 'item_id', rec.item_id, 'to', rec.to_side, 'placement_reverted', v_rev),
          clock_timestamp());
  handoff_id := rec.id;
  to_side := rec.to_side;
  prior_placement := rec.prior_placement;
  reverted := v_rev;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION run_handoff_signal(p_run_id uuid, p_min_version integer)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  raw   text := COALESCE(current_setting('app.runner_id', true), '');
  v_ver integer;
  rec   record;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'run_handoff_signal: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct)
     OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'run_handoff_signal: the session is not a runner of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_run_id IS NULL OR p_min_version IS NULL OR p_min_version < 1 THEN
    RAISE EXCEPTION 'run_handoff_signal: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- R-599-HO1: the signal is for a runner whose stored version can read it. A runner with no version on record is not one.
  SELECT r.protocol_version INTO v_ver FROM public.runners r WHERE r.id = raw::uuid AND r.account_id = acct AND r.revoked_at IS NULL;
  IF NOT FOUND OR v_ver IS NULL OR v_ver < p_min_version THEN
    RETURN NULL;
  END IF;
  -- Only the runner that holds the running run is told, and only about the run's own live handoff.
  SELECT h.id, h.state, h.deadline INTO rec
    FROM public.run_handoffs h JOIN public.agent_runs a ON a.id = h.run_id AND a.account_id = h.account_id
   WHERE h.run_id = p_run_id AND h.account_id = acct AND a.runner_id = raw::uuid AND a.status = 'running' AND h.state IN ('requested', 'checkpointing')
     FOR UPDATE OF h;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF rec.state = 'requested' THEN
    UPDATE public.run_handoffs SET state = 'checkpointing', updated_at = clock_timestamp() WHERE id = rec.id;
  END IF;
  RETURN rec.deadline;
END;
$$;

REVOKE ALL ON FUNCTION run_handoff_request(uuid, text, timestamptz, timestamptz, uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION run_handoff_cancel(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION run_handoff_signal(uuid, integer) FROM PUBLIC;
ALTER FUNCTION run_handoff_request(uuid, text, timestamptz, timestamptz, uuid, uuid, boolean) OWNER TO run_handoff_definer;
ALTER FUNCTION run_handoff_cancel(uuid) OWNER TO run_handoff_definer;
ALTER FUNCTION run_handoff_signal(uuid, integer) OWNER TO run_handoff_definer;
GRANT EXECUTE ON FUNCTION run_handoff_request(uuid, text, timestamptz, timestamptz, uuid, uuid, boolean) TO app_user;
GRANT EXECUTE ON FUNCTION run_handoff_cancel(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION run_handoff_signal(uuid, integer) TO app_user;

REVOKE CREATE ON SCHEMA public FROM run_handoff_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE run_handoff_definer FROM CURRENT_USER;
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
