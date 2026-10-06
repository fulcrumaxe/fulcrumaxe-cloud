-- D#2 RC-1a: the repo-creation service's rate and replay reads (C61 section 4
-- criterion 10). Production code may not read the audit table directly, so one
-- narrow definer counts the two repo-creation actions for one account and
-- says whether a nonce was already used. The action names are fixed in the
-- body; the function returns counts and a boolean only, never a row.
--
-- Owned by platform_ops, pinned search_path, REVOKEd FROM PUBLIC. The privilege
-- bracket is copied from 0667.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;

GRANT CREATE ON SCHEMA public TO platform_ops;

CREATE FUNCTION github_repo_create_audit_counts(p_account uuid, p_nonce text)
RETURNS TABLE (last_hour bigint, last_day bigint, nonce_seen boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT count(*) FILTER (WHERE a.created_at > now() - interval '1 hour'),
         count(*),
         COALESCE(bool_or(a.action = 'github.repo_created' AND a.payload->>'nonce' = p_nonce), false)
    FROM public.audit_log a
   WHERE a.account_id = p_account
     AND a.action IN ('github.repo_created', 'github.repo_create_refused')
     AND a.created_at > now() - interval '1 day';
$$;

REVOKE ALL ON FUNCTION github_repo_create_audit_counts(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION github_repo_create_audit_counts(uuid, text) TO platform_ops;
ALTER FUNCTION github_repo_create_audit_counts(uuid, text) OWNER TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM platform_ops;
