-- D#483 S4-f3-f: discovery_analysis_list_due (0950, 0953) also lists a waiting analysis whose repository is no longer eligible.
--
-- 0953 listed a queued or running analysis only while its repository was connected, Cloud-run ('sandbox' or 'runner_verified') and a team repository.
-- One that was disconnected, switched to 'runner_local' or moved off 'team' after it was queued was never listed again, so it never ended and its
-- head could not be analysed afresh. Now every waiting analysis of a live account is listed, in the same order and within the same 5 per account; the
-- pass ends an ineligible one `skipped` with its reason and starts nothing for it (packages/worker/src/docsCodeAnalysis.ts).
--
-- The bracket is 0950's, as 0953 kept it: the same NOLOGIN owner role and its column grants (nothing added; repos.execution_mode, installation_id and
-- product stay granted as 0950 made them, which its neon-shape entry pins, though the body no longer filters on them), one row policy per table for
-- that role alone (the repos one now admits a repository with a waiting analysis, and nothing else), the pinned search_path, the platform_ops refusal,
-- the bad-limit refusal, EXECUTE for agent_run_writer alone (unchanged by CREATE OR REPLACE), the ADMIN-option checks.
--
-- Same signature, CREATE OR REPLACE. 0950 and 0953 stay byte-identical. Numbered above main's highest (0955) and the numbers open work holds (0956 to
-- 0958); re-checked at open and before merge.

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'discovery_analysis_lister'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on discovery_analysis_lister; cannot replace discovery_analysis_list_due';
    END IF;
    GRANT discovery_analysis_lister TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

-- The lister sees a repository only while one of its analyses waits (the policy's read is the lister's own, under its discovery_analyses policy).
DROP POLICY discovery_analysis_lister_select ON repos;
CREATE POLICY discovery_analysis_lister_select ON repos FOR SELECT TO discovery_analysis_lister
  USING (EXISTS (SELECT 1 FROM public.discovery_analyses x WHERE x.account_id = repos.account_id AND x.repo_id = repos.id AND x.state IN ('queued', 'running')));

CREATE OR REPLACE FUNCTION discovery_analysis_list_due(p_limit int)
RETURNS TABLE (account_id uuid, analysis_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'discovery_analysis_list_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'discovery_analysis_list_due: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT d.account_id, d.id
    FROM (
      SELECT x.account_id, x.id, x.created_at,
             row_number() OVER (PARTITION BY x.account_id ORDER BY x.created_at, x.id) AS rn
        FROM public.discovery_analyses x
        JOIN public.accounts a ON a.id = x.account_id AND a.deleted_at IS NULL
        JOIN public.repos r ON r.account_id = x.account_id AND r.id = x.repo_id
       WHERE x.state IN ('queued', 'running')
    ) d
   WHERE d.rn <= 5
   ORDER BY d.created_at, d.id
   LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION discovery_analysis_list_due(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION discovery_analysis_list_due(int) TO agent_run_writer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE discovery_analysis_lister FROM CURRENT_USER;
  END IF;
END
$$;
