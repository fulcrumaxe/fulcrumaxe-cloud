-- D#2 RC-1c: the repo-creation rate limit is now a reservation taken before
-- the GitHub call. The service takes a per-account advisory lock, counts,
-- and writes a 'github.repo_create_reserved' audit row in one short
-- transaction, so concurrent callbacks cannot all read the same count. The
-- lock is never held across a GitHub call. This replaces the body of the
-- 0673 definer (same signature, owner and grants): it counts reservations
-- only, and the nonce is "seen" once reserved. 'github.repo_created' and
-- 'github.repo_create_refused' stay as plain records and are not counted.
-- Privilege bracket copied from 0676 (needs ownership to replace).
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION github_repo_create_audit_counts(p_account uuid, p_nonce text)
RETURNS TABLE (last_hour bigint, last_day bigint, nonce_seen boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT count(*) FILTER (WHERE a.created_at > now() - interval '1 hour'),
         count(*),
         COALESCE(bool_or(a.payload->>'nonce' = p_nonce), false)
    FROM public.audit_log a
   WHERE a.account_id = p_account
     AND a.action = 'github.repo_create_reserved'
     AND a.created_at > now() - interval '1 day';
$$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
