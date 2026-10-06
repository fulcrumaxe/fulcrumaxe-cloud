-- D#2 WORK-ITEM-CANCEL-PAGING (builds on 0658, 0682 and 0683).
-- A work-item cancel cancels one page of runs per call and settles 'accepted' to
-- be claimed again. Every claim adds one attempt and the settle definer turns an
-- 'accepted' settle into 'failed' at attempt 5, so a page of progress was counted
-- like a failure: an item with more than 500 live runs ended 'failed'.
-- 1. progress_pages counts the pages an action has made progress on.
-- 2. run_action_requeue_progress(action id) is the one transition for a page of
--    progress: it puts a live claim back to 'accepted', due now, gives the claim's
--    attempt back and counts the page, up to a fixed cap. It writes no event and
--    no audit row (a re-queue is not a settle). run_action_settle and
--    run_action_claim are unchanged. At the cap it changes nothing and says so;
--    the caller then settles 'failed' through run_action_settle, which writes the
--    terminal events.
-- Privilege brackets as in 0682/0683: INHERIT on platform_ops (the 0658 REVOKE
-- from the owner needs it), CREATE on schema public for the ownership transfer.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

ALTER TABLE run_action_requests ADD COLUMN progress_pages integer NOT NULL DEFAULT 0 CHECK (progress_pages >= 0);
-- The 0658 grant shape: column-scoped, to the definers' owner only.
GRANT UPDATE (progress_pages) ON run_action_requests TO platform_ops;

CREATE FUNCTION run_action_requeue_progress(p_action_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  -- Pinned to MAX_PROGRESS_PAGES in packages/worker/src/runActions.ts by a test.
  max_pages constant int := 100;
  r public.run_action_requests;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'run_action_requeue_progress: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO r FROM public.run_action_requests q WHERE q.id = p_action_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_action_requeue_progress: no such action' USING ERRCODE = 'P0002';
  END IF;
  -- Only a live lease on a kind that pages (cancel_work_item) can make progress.
  IF r.state <> 'claimed' OR r.claimed_until IS NULL OR r.claimed_until <= now() OR r.kind <> 'cancel_work_item' THEN
    RAISE EXCEPTION 'run_action_requeue_progress: action is not a live cancel_work_item claim' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF r.progress_pages + 1 > max_pages THEN RETURN 'cap_reached'; END IF;
  UPDATE public.run_action_requests q
     SET state = 'accepted', claimed_until = NULL, not_before = now(), attempts = GREATEST(q.attempts - 1, 0),
         progress_pages = q.progress_pages + 1, updated_at = now()
   WHERE q.id = p_action_id;
  RETURN 'requeued';
END $$;

-- The 0658 ACL: EXECUTE for agent_run_writer only (revoked from the owner first).
REVOKE ALL ON FUNCTION run_action_requeue_progress(uuid) FROM PUBLIC, CURRENT_USER;
GRANT EXECUTE ON FUNCTION run_action_requeue_progress(uuid) TO agent_run_writer;
ALTER FUNCTION run_action_requeue_progress(uuid) OWNER TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
