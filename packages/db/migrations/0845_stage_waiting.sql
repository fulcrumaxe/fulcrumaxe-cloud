-- D#483 S5-k1b: the stage driver's generalised waiting fact, and the cross-tenant list the parked-stage sweep starts from.
--
-- 1. work_item_driver_events (0709) gains one kind, `stage_waiting`, and two fields: `stage` (which start is waiting: a closed list) and
--    `attempt` (the attempt number of the ask that was denied). The pause itself is the row's `code`, as it is for `build_waiting`
--    (0830), which stays a legal kind and stays readable: the readers take the latest of both kinds, so a row written before this file
--    keeps working and ages out of the 45 minute window. A `build_waiting` row has no stage and reads as the build stage. A row holds
--    ids and fixed words only, as every row in this table does. No grant moves: app_user already holds table-level SELECT and INSERT.
-- 2. work_item_list_parked_stage: the cross-tenant list of items that are parked at one stage. A parked item is one whose workflow gave
--    up waiting for a spending limit (it ended `<stage>_paused:<pause>`), or whose workflow is gone: it sits at a stage position, is not
--    halted, and its LATEST waiting fact (either kind) names that stage and one of the pauses asked for, and is at least `p_min_age_s`
--    old (a live workflow refreshes its fact at every ask, so a fresh fact means a workflow is still asking). It answers the account,
--    the item, the pause and the fact's time, and nothing else: the checks that need more (the approval, the Spec, the limits) are run
--    afterwards, one item at a time, under that item's own tenant context. It writes nothing (STABLE) and refuses a platform_ops login.
--
-- Who owns it: platform_ops gains nothing. The function is owned by a role of its own, stage_resume_lister, in the shape of 0757's
-- runner_notice_lister: NOLOGIN, no members (the migration role holds it only inside this file), column grants for exactly what the body
-- reads, two row policies for this role alone, a pinned search_path, and EXECUTE for the run-writer login (the login the sweeps run as).
--
-- Numbered above the highest migration on the code plane. Re-check against main right before merging and renumber to stay above it.

-- ---- the event kind and its fields -------------------------------------------------------------------------------------------------
ALTER TABLE work_item_driver_events DROP CONSTRAINT work_item_driver_events_kind_check;
ALTER TABLE work_item_driver_events
  ADD CONSTRAINT work_item_driver_events_kind_check CHECK (kind IN (
    'build_refused', 'build_waiting', 'stage_waiting', 'review_started', 'security_review_required', 'review_verdicts',
    'fix_round_started', 'fix_round_refused', 'fix_pushed_nothing', 'fix_round_failed', 'escalated',
    'review_status', 'merge_gate', 'merged_by_gate', 'stopped', 'pr_head_pushed', 'platform_check', 'correction_applied'
  ));

ALTER TABLE work_item_driver_events
  ADD COLUMN stage text NULL,
  ADD COLUMN attempt integer NULL;
ALTER TABLE work_item_driver_events
  ADD CONSTRAINT work_item_driver_events_stage_check CHECK (stage IN ('build', 'classify', 'spec', 'respec', 'review', 'fix_round', 'panel')),
  ADD CONSTRAINT work_item_driver_events_attempt_check CHECK (attempt BETWEEN 0 AND 100000),
  -- Only a waiting fact names a stage and an attempt, and a `stage_waiting` fact always names the stage and the pause.
  ADD CONSTRAINT work_item_driver_events_stage_waiting_shape CHECK (
    (kind = 'stage_waiting' AND stage IS NOT NULL AND code IS NOT NULL) OR (kind <> 'stage_waiting' AND stage IS NULL AND attempt IS NULL)
  );

-- The latest waiting fact of an item, whichever of the two kinds wrote it (the lister and the readers both ask for exactly this).
CREATE INDEX work_item_driver_events_waiting_idx ON work_item_driver_events (account_id, work_item_id, seq DESC) WHERE kind IN ('build_waiting', 'stage_waiting');
-- The lister starts from items that are somewhere in the pipeline and not halted.
CREATE INDEX work_items_parkable_idx ON work_items (stage) WHERE halted_at IS NULL AND stage NOT IN ('merged', 'closed_unmerged', 'closed');

-- ---- the role ------------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  n text := 'stage_resume_lister';
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

-- The lister's whole reach: which items are at a stage and not halted (ids, account, stage), and their waiting facts (kind, code, stage,
-- order, time; never a run id, a head, or anything an author wrote). Two policies, for this role alone.
GRANT USAGE ON SCHEMA public TO stage_resume_lister;
GRANT SELECT (id, account_id, stage, halted_at) ON work_items TO stage_resume_lister;
GRANT SELECT (account_id, work_item_id, kind, code, stage, seq, created_at) ON work_item_driver_events TO stage_resume_lister;
CREATE POLICY stage_resume_lister_select ON work_items FOR SELECT TO stage_resume_lister USING (halted_at IS NULL);
CREATE POLICY stage_resume_lister_select ON work_item_driver_events FOR SELECT TO stage_resume_lister USING (kind IN ('build_waiting', 'stage_waiting'));

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'stage_resume_lister'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on stage_resume_lister; cannot ALTER FUNCTION ... OWNER TO stage_resume_lister';
    END IF;
    GRANT stage_resume_lister TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

GRANT CREATE ON SCHEMA public TO stage_resume_lister;

CREATE FUNCTION work_item_list_parked_stage(p_stage text, p_item_stages text[], p_pauses text[], p_min_age_s int, p_limit int)
RETURNS TABLE (account_id uuid, work_item_id uuid, pause text, waited_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'work_item_list_parked_stage: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_stage IS NULL OR p_stage NOT IN ('build', 'classify', 'spec', 'respec', 'review', 'fix_round', 'panel')
     OR p_item_stages IS NULL OR cardinality(p_item_stages) NOT BETWEEN 1 AND 6
     OR p_pauses IS NULL OR cardinality(p_pauses) NOT BETWEEN 1 AND 8
     OR p_min_age_s IS NULL OR p_min_age_s NOT BETWEEN 0 AND 86400
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'work_item_list_parked_stage: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT w.account_id, w.id, e.code, e.created_at
    FROM public.work_items w
   CROSS JOIN LATERAL (
     SELECT x.code, x.stage, x.created_at
       FROM public.work_item_driver_events x
      WHERE x.account_id = w.account_id AND x.work_item_id = w.id AND x.kind IN ('build_waiting', 'stage_waiting')
      ORDER BY x.seq DESC LIMIT 1
   ) e
   WHERE w.stage = ANY (p_item_stages) AND w.halted_at IS NULL
     AND COALESCE(e.stage, 'build') = p_stage
     AND e.code = ANY (p_pauses)
     AND e.created_at <= now() - make_interval(secs => p_min_age_s)
   ORDER BY e.created_at, w.id
   LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION work_item_list_parked_stage(text, text[], text[], int, int) FROM PUBLIC;
ALTER FUNCTION work_item_list_parked_stage(text, text[], text[], int, int) OWNER TO stage_resume_lister;
-- EXECUTE after the transfer, to the run-writer login alone, as 0734 and 0757 do for their listers.
GRANT EXECUTE ON FUNCTION work_item_list_parked_stage(text, text[], text[], int, int) TO agent_run_writer;
REVOKE CREATE ON SCHEMA public FROM stage_resume_lister;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE stage_resume_lister FROM CURRENT_USER;
  END IF;
END
$$;
