-- D#2 PREVIEW-LIVE-PROGRESS: a preview whose run failed on OUR side before the agent could have done any work does
-- not use up the customer's free preview, within a bound.
--
-- Must merge after #471 (migration 0704), which is what records the failure reason `agent_start_timeout` on the run
-- (this only reads it). The clone reason `clone_failed` is recorded by #477, which is stacked on this change and merges
-- after it; this trigger only matches the reason strings and does not depend on that code.
--
-- Which failures free the slot. Only ones that cannot be raised once the agent command is running:
--   * `agent_start_timeout`: the agent never started in the sandbox.
--   * `clone_failed`: the repository copy failed or timed out (the clone runs before the agent starts).
-- Not `sandbox_error` (the metering guard also reports a mid-run kill with it, and "no agent text yet" does not prove no
-- work happened) and not `clone_too_large` (the repository is the cause; trying it again fails the same way). A preview
-- that failed for any other reason is used up.
--
-- How the slot is freed. Every limit already ignores a void preview: 0685's two unique indexes (one per GitHub user, one
-- per installation) and 0695's window counts (per installation and per owner, across accounts) all say
-- `state <> 'void'`. 0690 already lets a running preview become void with its run link kept. So the one thing that frees
-- the slot, for the same account and for any other account on the same GitHub org alike, is to void the preview, with
-- the failure reason as its void reason. A count-only change could not do that: the unique indexes would still refuse a
-- second preview, and one account cannot read another account's run events.
--
-- The bound (abuse and cost). Both reasons can be repeated on purpose (remove repo access and the clone fails every
-- time), and each attempt starts a sandbox. So at most 3 previews per GitHub installation and per owner are freed in a
-- rolling 24 hours, counted across accounts. Past that the failed preview simply stays used up (the trigger does not
-- void it, and says so with a warning). The count is read through onboarding_preview_frees_in_window(), a definer owned
-- by platform_ops, which gains SELECT on void_reason and a row policy showing it freed rows to any session but a direct
-- platform_ops login (the 0695 shape); no tenant role gains a privilege.
--
-- The trigger runs with the privileges of whoever records the event (the runner login holds the preview UPDATE grant and
-- app_user's reads). It must never make the event write fail, so every error is caught, reported with a WARNING and a
-- row in error_events (error_event_record), and the void is skipped: a skip is never silent. The panel reads whether the
-- slot was freed from the preview row itself (void plus one of the two reasons), so a skipped void is shown as used up.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

GRANT SELECT (void_reason) ON onboarding_previews TO platform_ops;
CREATE POLICY platform_ops_read_freed ON onboarding_previews FOR SELECT TO platform_ops
  USING (session_user <> 'platform_ops' AND state = 'void' AND void_reason IN ('agent_start_timeout', 'clone_failed'));

CREATE FUNCTION onboarding_preview_frees_in_window(p_gh_installation_id bigint, p_gh_owner text) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT GREATEST(
    (SELECT count(*) FROM public.onboarding_previews p
      WHERE p.state = 'void' AND p.void_reason IN ('agent_start_timeout', 'clone_failed')
        AND p.gh_installation_id = p_gh_installation_id AND p.created_at > now() - interval '24 hours'),
    (SELECT count(*) FROM public.onboarding_previews p
      WHERE p.state = 'void' AND p.void_reason IN ('agent_start_timeout', 'clone_failed')
        AND p.gh_owner = p_gh_owner AND p.created_at > now() - interval '24 hours'))::integer;
$$;
REVOKE ALL ON FUNCTION onboarding_preview_frees_in_window(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION onboarding_preview_frees_in_window(bigint, text) TO app_user;
ALTER FUNCTION onboarding_preview_frees_in_window(bigint, text) OWNER TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;

CREATE FUNCTION onboarding_preview_free_slot() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c_max_frees CONSTANT int := 3;
  gh_inst bigint;
  own     text;
BEGIN
  BEGIN
    SELECT p.gh_installation_id, p.gh_owner INTO gh_inst, own FROM public.onboarding_previews p
     WHERE p.account_id = NEW.account_id AND p.run_id = NEW.run_id AND p.state = 'running';
    IF NOT FOUND THEN
      RETURN NULL; -- not a running preview of this account (or not visible to this role): nothing to free
    END IF;
    IF public.onboarding_preview_frees_in_window(gh_inst, own) >= c_max_frees THEN
      RAISE WARNING 'onboarding_preview_free_slot: free-slot limit reached for this GitHub account; the preview stays used up';
      RETURN NULL;
    END IF;
    UPDATE public.onboarding_previews p
       SET state = 'void', void_reason = NEW.payload->>'failureReason'
     WHERE p.account_id = NEW.account_id AND p.run_id = NEW.run_id AND p.state = 'running';
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'onboarding_preview_free_slot: could not void the preview (SQLSTATE %); it stays used up', SQLSTATE;
    BEGIN
      PERFORM public.error_event_record('platform', '/preview/free_slot', 'void_preview', SQLSTATE);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'onboarding_preview_free_slot: could not record the error event (SQLSTATE %)', SQLSTATE;
    END;
  END;
  RETURN NULL;
END $$;

CREATE TRIGGER run_events_free_preview_slot
  AFTER INSERT ON run_events FOR EACH ROW
  WHEN (NEW.kind = 'run.status_changed' AND NEW.payload->>'failureReason' IN ('agent_start_timeout', 'clone_failed'))
  EXECUTE FUNCTION onboarding_preview_free_slot();
