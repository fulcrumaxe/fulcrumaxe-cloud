-- PROPOSAL-VERIFY-LOCAL-REPOS (TL 11-13): a Local-only ('runner_local') repository's product proposals are checked too, on that repository's runner.
-- Before this, proposal_verify_list_due (0893) listed only 'sandbox' and 'runner_verified' repos, so a Local-only repo's proposals sat "Being checked"
-- forever (verify_attempts 0) and the dial could never start one with no click. The worker starts the same light proposal-verifier job on the runner.

DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['proposal_verify_lister'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = n::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
        RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot ALTER FUNCTION ... OWNER TO %', n, n;
      END IF;
      EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', n);
    END LOOP;
  END IF;
END
$$;

DROP POLICY proposal_verify_lister_select ON repos;
CREATE POLICY proposal_verify_lister_select ON repos FOR SELECT TO proposal_verify_lister USING (execution_mode IN ('sandbox', 'runner_verified', 'runner_local'));

CREATE OR REPLACE FUNCTION proposal_verify_list_due(p_limit int)
RETURNS TABLE (account_id uuid, proposal_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'proposal_verify_list_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'proposal_verify_list_due: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT d.account_id, d.id
    FROM (
      SELECT p.account_id, p.id, p.created_at,
             row_number() OVER (PARTITION BY p.account_id ORDER BY p.created_at, p.id) AS rn
        FROM public.proposals p
        JOIN public.accounts a ON a.id = p.account_id AND a.deleted_at IS NULL
        JOIN public.repos r ON r.account_id = p.account_id AND r.id = p.repo_id AND r.execution_mode IN ('sandbox', 'runner_verified', 'runner_local')
       WHERE p.state = 'new' AND p.owner_process = 'product'
         AND (p.verification = 'pending' OR (p.verification = 'check_failed' AND p.verify_attempts < 3))
    ) d
   WHERE d.rn <= 10
   ORDER BY d.created_at, d.id
   LIMIT p_limit;
END $$;

DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['proposal_verify_lister'] LOOP
      EXECUTE format('REVOKE %I FROM CURRENT_USER', n);
    END LOOP;
  END IF;
END
$$;
