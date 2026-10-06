-- 0707: resolve_sandbox_run resolves a sandbox name to its one LIVE run.
--
-- Why. An executor's runs on one pull request deliberately share one sandbox name
-- (ex-{account}-{repo}-{pr}, see 0706): resume finds the sandbox by that stable name.
-- 0696 resolved a name only when exactly one agent_runs row carried it, whatever its
-- status, so from the second executor run on a PR (any fix round) the gh-proxy
-- denied every call with sandbox_not_resolved.
--
-- New rule: look only at runs that are live (pending, running or paused: the
-- non-terminal states of RUN_STATUS_TRANSITIONS, which a test in packages/github
-- keeps in step), then require exactly one. Ended runs never resolve and never
-- count, so an earlier ended run no longer shadows the live one. Two live runs on
-- one name still resolve to nothing (fail closed).
--
-- Everything else is as 0696: same columns returned, same joins and installation
-- uniqueness guard, SECURITY DEFINER owned by platform_ops with a pinned
-- search_path, EXECUTE for run_binding_resolver and nobody else. The signature and
-- return type do not change, so the function is dropped and created again rather
-- than replaced, which keeps the owner/grant steps identical to 0696.
-- Privilege brackets as in 0692.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

DROP FUNCTION resolve_sandbox_run(text);

CREATE FUNCTION resolve_sandbox_run(p_sandbox_name text)
RETURNS TABLE (
  role              text,
  product           text,
  gh_owner          text,
  gh_name           text,
  gh_installation_id bigint,
  app_kind          text,
  is_preview        boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- Only live runs are candidates, and the run must be the ONLY live match: two live runs
  -- sharing a name deny. Ended runs on the same name are ignored, so a fix round's new
  -- run resolves although the first round's run (same name) has ended.
  RETURN QUERY
  WITH m AS (
    SELECT ar.role AS m_role, r.product AS m_product, r.gh_owner AS m_owner,
           r.gh_name AS m_name, i.gh_installation_id AS m_inst, i.app_kind AS m_kind,
           EXISTS (SELECT 1 FROM public.onboarding_previews p
                    WHERE p.run_id = ar.id AND p.account_id = ar.account_id) AS m_preview
      FROM public.agent_runs ar
      JOIN public.repos r
        ON r.id = ar.dispatch_repo_id
       AND r.account_id = ar.account_id
      JOIN public.installations i
        ON i.id = r.installation_id
       AND i.account_id = r.account_id
     WHERE ar.sandbox_name = p_sandbox_name
       AND ar.status IN ('pending', 'running', 'paused')
       AND NOT EXISTS (
         SELECT 1 FROM public.installations i2
          WHERE i2.gh_installation_id = i.gh_installation_id
            AND i2.id <> i.id
       )
  )
  SELECT m.m_role, m.m_product, m.m_owner, m.m_name, m.m_inst, m.m_kind, m.m_preview
    FROM m
   WHERE (SELECT count(*) FROM m) = 1;
END
$$;

ALTER FUNCTION resolve_sandbox_run(text) OWNER TO platform_ops;
REVOKE ALL ON FUNCTION resolve_sandbox_run(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_sandbox_run(text) TO run_binding_resolver;
GRANT USAGE ON SCHEMA public TO run_binding_resolver;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
