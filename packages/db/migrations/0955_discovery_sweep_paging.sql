-- D#483 S5-g2-f: the sweep lister names only repositories it would queue to some purpose, and pages by a keyset cursor.
-- discovery_sweep_list_due(p_limit) is replaced by discovery_sweep_list_due(p_limit, p_after_account_id, p_after_repo_id):
--  * a repository whose newest discovery_settings row says `off` is left out (it is listed again, the same UTC day, once the setting is turned back on);
--  * a repository whose account is not `active` is left out (listed again once the account is active);
--  * a repository with no setting row is still daily;
--  * the page starts strictly after (p_after_repo_id, p_after_account_id) in (repo_id, account_id) order (repo ids are random across accounts, so one account's repositories spread over the whole order and a rotating start can fall between any two of them); both null is the first page, exactly one null is refused.
-- The bracket is 0952's: the same NOLOGIN owner role, column grants for exactly what the body reads (accounts.status is added), one row policy per table, a pinned
-- search_path, the platform_ops refusal, the bad-argument refusal, EXECUTE for agent_run_writer alone after the owner transfer, the ADMIN-option checks.
-- The old signature is dropped: nothing else calls it. Numbered above main's highest (0953) and the number open work holds (0954); re-checked at open and before merge.

GRANT SELECT (status) ON accounts TO discovery_sweep_lister;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'discovery_sweep_lister'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on discovery_sweep_lister; cannot replace discovery_sweep_list_due';
    END IF;
    GRANT discovery_sweep_lister TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

DROP FUNCTION discovery_sweep_list_due(int);
GRANT CREATE ON SCHEMA public TO discovery_sweep_lister;

CREATE FUNCTION discovery_sweep_list_due(p_limit int, p_after_account_id uuid, p_after_repo_id uuid)
RETURNS TABLE (account_id uuid, repo_id uuid, period_ref text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'discovery_sweep_list_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 OR (p_after_account_id IS NULL) <> (p_after_repo_id IS NULL) THEN
    RAISE EXCEPTION 'discovery_sweep_list_due: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT r.account_id, r.id, p.ref
    FROM public.repos r
    JOIN public.accounts a ON a.id = r.account_id AND a.deleted_at IS NULL AND a.status = 'active'
    LEFT JOIN LATERAL (SELECT s.frequency FROM public.discovery_settings s WHERE s.account_id = r.account_id AND s.repo_id = r.id ORDER BY s.version DESC LIMIT 1) f ON true
    CROSS JOIN LATERAL (SELECT CASE WHEN f.frequency = 'weekly' THEN to_char(now() AT TIME ZONE 'UTC', 'IYYY-"W"IW') ELSE to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') END AS ref) p
   WHERE r.installation_id IS NOT NULL AND r.product = 'team'
     AND f.frequency IS DISTINCT FROM 'off'
     AND (p_after_account_id IS NULL OR (r.id, r.account_id) > (p_after_repo_id, p_after_account_id))
     AND NOT EXISTS (SELECT 1 FROM public.discovery_runs q WHERE q.repo_id = r.id AND q.trigger = 'sweep' AND q.trigger_ref = p.ref)
   ORDER BY r.id, r.account_id
   LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION discovery_sweep_list_due(int, uuid, uuid) FROM PUBLIC;
ALTER FUNCTION discovery_sweep_list_due(int, uuid, uuid) OWNER TO discovery_sweep_lister;
-- EXECUTE after the transfer, to the run-writer login alone, as 0952 does.
GRANT EXECUTE ON FUNCTION discovery_sweep_list_due(int, uuid, uuid) TO agent_run_writer;
REVOKE CREATE ON SCHEMA public FROM discovery_sweep_lister;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE discovery_sweep_lister FROM CURRENT_USER;
  END IF;
END
$$;
