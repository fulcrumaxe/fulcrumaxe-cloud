-- PREVIEW-SLOT-FREE-EMPTY-OUTPUT: a preview whose run fails with `empty_agent_output` (the agent ran but produced no
-- text, which is our side's failure, not the customer's) frees the free preview slot like `agent_start_timeout` and
-- `clone_failed` do (0705).
--
-- The reason list lives in three places in 0705 and all three change together, or a freed preview would be miscounted
-- or be hidden from the counting definer: the platform_ops row policy, onboarding_preview_frees_in_window() and the
-- trigger's WHEN clause. Nothing else changes: the trigger function body, the 3-per-day bound, owners, grants and
-- search_path stay as 0705 left them (CREATE OR REPLACE and ALTER POLICY keep owner and grants).
-- The code value is plain text; it is recorded by the run-failure code that adds `empty_agent_output`.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

ALTER POLICY platform_ops_read_freed ON onboarding_previews
  USING (session_user <> 'platform_ops' AND state = 'void' AND void_reason IN ('agent_start_timeout', 'clone_failed', 'empty_agent_output'));

CREATE OR REPLACE FUNCTION onboarding_preview_frees_in_window(p_gh_installation_id bigint, p_gh_owner text) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT GREATEST(
    (SELECT count(*) FROM public.onboarding_previews p
      WHERE p.state = 'void' AND p.void_reason IN ('agent_start_timeout', 'clone_failed', 'empty_agent_output')
        AND p.gh_installation_id = p_gh_installation_id AND p.created_at > now() - interval '24 hours'),
    (SELECT count(*) FROM public.onboarding_previews p
      WHERE p.state = 'void' AND p.void_reason IN ('agent_start_timeout', 'clone_failed', 'empty_agent_output')
        AND p.gh_owner = p_gh_owner AND p.created_at > now() - interval '24 hours'))::integer;
$$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE TRIGGER run_events_free_preview_slot
  AFTER INSERT ON run_events FOR EACH ROW
  WHEN (NEW.kind = 'run.status_changed' AND NEW.payload->>'failureReason' IN ('agent_start_timeout', 'clone_failed', 'empty_agent_output'))
  EXECUTE FUNCTION onboarding_preview_free_slot();
