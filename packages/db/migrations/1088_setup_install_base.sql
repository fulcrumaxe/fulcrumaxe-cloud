-- D#845 ON-20a: the install merge holds the pushed commit to the job (Ruling 73): its parent is the job's `base_sha`. The signed job is not a column a person's session may read, so this one function answers the
-- single value, `base_sha` of the current attempt's job, for ONE setup of the session's own account whose install pull request is recorded (phase await_merge or finish). It is owned by setup_install_definer (1072), whose
-- grants and policies already cover exactly these reads, so it adds none. EXECUTE for app_user alone. Numbered 1088 by the Team Lead. Re-check against main right before merging.

-- The install_merged audit row is written once per setup: this marker is set in the same transaction as the row (app_user cannot read the audit log), so a click that finds the pull request already merged by our App can still write a row that was lost.
ALTER TABLE project_setups ADD COLUMN install_merge_recorded_at timestamptz;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'setup_install_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on setup_install_definer; cannot ALTER FUNCTION ... OWNER TO setup_install_definer';
    END IF;
    GRANT setup_install_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO setup_install_definer;

CREATE FUNCTION setup_install_base(p_setup uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT j.job #>> '{job,args,base_sha}'
    FROM public.project_setups s
    JOIN public.machine_jobs j ON j.account_id = s.account_id AND j.setup_id = s.id AND j.attempt = s.attempt AND j.kind = 'project_setup'
   WHERE s.id = p_setup AND s.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND s.phase IN ('await_merge', 'finish') AND s.install_pr IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION setup_install_base(uuid) FROM PUBLIC;
ALTER FUNCTION setup_install_base(uuid) OWNER TO setup_install_definer;
GRANT EXECUTE ON FUNCTION setup_install_base(uuid) TO app_user;
REVOKE CREATE ON SCHEMA public FROM setup_install_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE setup_install_definer FROM CURRENT_USER;
  END IF;
END
$$;
