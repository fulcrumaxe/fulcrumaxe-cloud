-- Engine bridge follow-up: record who halted a repo's engine.
--
-- engine_repo_controls.halted_by is the user who set the current halt. It is NULL exactly while nothing is halted, and also for a halt that
-- was set before this migration (that halt's author was never recorded; nothing is guessed). Reads go through the table's existing SELECT
-- grant to app_user; app_user still has no INSERT or UPDATE on the table, so the column can only be written by the two definer functions.
--
-- engine_halt_set stamps it from the session identity (app.user_id), which engine_halt_assert_person has just proven is a verified owner or
-- admin member of the session's active account. There is no parameter: a caller cannot choose who the halt is attributed to.
-- engine_halt_clear sets it back to NULL. Both keep their owner (engine_halt_definer, NOLOGIN) and their grants: CREATE OR REPLACE
-- changes neither.

ALTER TABLE engine_repo_controls ADD COLUMN halted_by uuid REFERENCES users (id);
ALTER TABLE engine_repo_controls ADD CONSTRAINT engine_repo_controls_halted_by_only_while_halted CHECK (halted_by IS NULL OR halted_at IS NOT NULL);

-- CREATE OR REPLACE on a function owned by engine_halt_definer needs membership of that role for a non-superuser migrator (1031's bracket):
-- taken here, dropped at the end. The owner and the grants of both functions stay as 1031 made them.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'engine_halt_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on engine_halt_definer; cannot replace its functions';
    END IF;
    GRANT engine_halt_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION engine_halt_set(p_repo_id uuid)
RETURNS TABLE (halt_epoch integer, newly_halted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := public.engine_halt_assert_person('engine_halt_set');
  -- The assert above proved this is a member of acct with role owner or admin.
  who  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  r    public.engine_repo_controls%ROWTYPE;
BEGIN
  IF p_repo_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.repos rp WHERE rp.account_id = acct AND rp.id = p_repo_id) THEN
    RAISE EXCEPTION 'engine_halt_set: no such repo' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO public.engine_repo_controls (account_id, repo_id) VALUES (acct, p_repo_id) ON CONFLICT DO NOTHING;
  SELECT * INTO r FROM public.engine_repo_controls c WHERE c.account_id = acct AND c.repo_id = p_repo_id FOR UPDATE;
  IF r.halted_at IS NOT NULL THEN
    RETURN QUERY SELECT r.halt_epoch, false;
    RETURN;
  END IF;
  UPDATE public.engine_repo_controls c
     SET halted_at = clock_timestamp(), halt_action_id = gen_random_uuid(), halt_epoch = c.halt_epoch + 1, halted_by = who, updated_at = clock_timestamp()
   WHERE c.account_id = acct AND c.repo_id = p_repo_id
  RETURNING c.halt_epoch INTO halt_epoch;
  newly_halted := true;
  RETURN NEXT;
END
$$;

CREATE OR REPLACE FUNCTION engine_halt_clear(p_repo_id uuid)
RETURNS TABLE (halt_epoch integer, newly_cleared boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := public.engine_halt_assert_person('engine_halt_clear');
  r    public.engine_repo_controls%ROWTYPE;
BEGIN
  IF p_repo_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.repos rp WHERE rp.account_id = acct AND rp.id = p_repo_id) THEN
    RAISE EXCEPTION 'engine_halt_clear: no such repo' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO public.engine_repo_controls (account_id, repo_id) VALUES (acct, p_repo_id) ON CONFLICT DO NOTHING;
  SELECT * INTO r FROM public.engine_repo_controls c WHERE c.account_id = acct AND c.repo_id = p_repo_id FOR UPDATE;
  IF r.halted_at IS NULL THEN
    RETURN QUERY SELECT r.halt_epoch, false;
    RETURN;
  END IF;
  UPDATE public.engine_repo_controls c
     SET halted_at = NULL, halt_action_id = NULL, halted_by = NULL, cleared_at = clock_timestamp(), updated_at = clock_timestamp()
   WHERE c.account_id = acct AND c.repo_id = p_repo_id
  RETURNING c.halt_epoch INTO halt_epoch;
  newly_cleared := true;
  RETURN NEXT;
END
$$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE engine_halt_definer FROM CURRENT_USER;
  END IF;
END
$$;
