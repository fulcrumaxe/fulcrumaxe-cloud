-- D#845 FU-315: a job that ended its runner part at `push ok` is waiting on the cloud, not silent.
--
-- A project_setup job (and an engine_update job, the same shape) stays `delivered` after the runner's last report, `push ok` with the pushed commit recorded, until the cloud opens the pull request (setup_install_pr
-- for a setup, engine_update_pr_claim for an update). The runner sends nothing after that, so 1110's ten-minute silence rule failed it with job_silent in the very tick that opened the pull request, and the person saw a
-- draft pull request beside a failed setup.
--
--   1. machine_job_expire is 1111's (itself 1110's with twin_sync left out of the setup failure), every arm kept (a never-taken job's expires_at, the three-hour overrun, the setup / update / twin failures, twin_publish, twin_seed and twin_sync as before), with one change: the silence
--      limit of a job that is waiting on the cloud is one hour from its last report instead of ten minutes. Waiting on the cloud means: project_setup whose setup of that attempt is at phase install, step push, state ok,
--      with install_head_sha recorded and no pull request yet; engine_update whose update of that attempt is at phase push, step push, state ok, with head_sha recorded and no pull request yet. The three-hour overrun
--      still ends either; the step that owns the pull request (a 15-minute tick) has an hour for several tries, and a job still quiet after it is job_silent as before.
--   2. machine_jobs_owner reads the columns the check needs (it already has row policy for both tables).
--
-- Restates 1111's machine_job_expire (stacked on it), so it must stay above 1111.
-- Numbered 1114 by the Team Lead. Re-check against main right before merging and renumber to stay above its highest.

DO $$
DECLARE
  owner_name text := (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = 'public.machine_job_expire(uuid)'::regprocedure);
  super boolean := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
BEGIN
  IF owner_name IS DISTINCT FROM 'machine_jobs_owner' THEN
    RAISE EXCEPTION 'machine_job_expire is owned by %, not machine_jobs_owner', owner_name;
  END IF;
  IF NOT super THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = owner_name::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot restate machine_job_expire', owner_name;
    END IF;
    EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', owner_name);
  END IF;
  EXECUTE format('GRANT CREATE ON SCHEMA public TO %I', owner_name);
  EXECUTE format('GRANT SELECT (id, account_id, attempt, phase, sub_step, state, install_head_sha, install_pr) ON project_setups TO %I', owner_name);
  EXECUTE format('GRANT SELECT (account_id, setup_id, attempt, phase, sub_step, state, head_sha, pr) ON engine_updates TO %I', owner_name);

  -- 1111's machine_job_expire, with one change: the silence limit of a job waiting on the cloud (the mj alias and the CASE are all that differ).
  CREATE OR REPLACE FUNCTION public.machine_job_expire(p_runner uuid) RETURNS void
  LANGUAGE sql
  VOLATILE
  SET search_path = pg_catalog, public, pg_temp
  AS $e$
    WITH ex AS (
      UPDATE public.machine_jobs mj
         SET state = 'expired', ended_at = now(),
             failure_code = CASE WHEN last_seq IS NULL THEN 'job_expired' WHEN delivered_at <= now() - interval '3 hours' THEN 'job_overran' ELSE 'job_silent' END
       WHERE account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND runner_id = p_runner AND state IN ('issued', 'delivered')
         AND ((last_seq IS NULL AND expires_at <= now()) OR (last_seq IS NOT NULL AND (delivered_at <= now() - interval '3 hours' OR last_progress_at <= now() - CASE
                       WHEN (mj.kind = 'project_setup' AND EXISTS (
                               SELECT 1 FROM public.project_setups s
                                WHERE s.account_id = mj.account_id AND s.id = mj.setup_id AND s.attempt = mj.attempt AND s.phase = 'install' AND s.sub_step = 'push' AND s.state = 'ok'
                                  AND s.install_head_sha IS NOT NULL AND s.install_pr IS NULL))
                         OR (mj.kind = 'engine_update' AND EXISTS (
                               SELECT 1 FROM public.engine_updates u
                                WHERE u.account_id = mj.account_id AND u.setup_id = mj.setup_id AND u.attempt = mj.attempt AND u.phase = 'push' AND u.sub_step = 'push' AND u.state = 'ok'
                                  AND u.head_sha IS NOT NULL AND u.pr IS NULL))
                       THEN interval '1 hour' ELSE interval '10 minutes' END)))
      RETURNING setup_id, kind, attempt, repo_id, failure_code AS code
    ), up AS (
      UPDATE public.engine_updates u SET phase = 'failed', state = 'failed', failure_code = ex.code, failure_at = now(), updated_at = now()
        FROM ex WHERE ex.kind = 'engine_update' AND u.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND u.setup_id = ex.setup_id AND u.attempt = ex.attempt AND u.phase = 'push'
    ), tw AS (
      UPDATE public.repo_twins w SET state = 'failed', failure_code = ex.code, failure_reason = NULL, failure_at = now(), updated_at = now()
        FROM ex WHERE ex.kind = 'twin_seed' AND w.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND w.private_repo_id = ex.repo_id AND w.state = 'seeding'
    )
    UPDATE public.project_setups s SET state = 'failed', failure_code = ex.code, failure_reason = NULL, failure_at = now(), updated_at = now()
      FROM ex WHERE ex.kind NOT IN ('engine_update', 'twin_seed', 'twin_publish', 'twin_sync') AND s.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND s.id = ex.setup_id;
  $e$;

  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', owner_name);
  IF NOT super THEN
    EXECUTE format('REVOKE %I FROM CURRENT_USER', owner_name);
  END IF;
END
$$;
