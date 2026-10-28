-- D#519 MQ3-b-2b: the cron sweep also lists repos that hold an entry in `awaiting_work`.
--
-- A delta review's entry waits in `awaiting_work` while the workflow's durable wait drives it. When that workflow dies, nothing else looks at
-- the entry, and it would hold its place out of the queue forever. merge_queue_sweep_targets (0824) answered only a lapsed lease or queued
-- entries with no holder; it now answers a repo with an `awaiting_work` entry too, and the sweep applies the same delta-review completion
-- (including the 120-minute timeout) the workflow's wait would have.
--
-- The function keeps its signature, owner and EXECUTE grant (CREATE OR REPLACE), and reads the same columns, so the column grants and the
-- neon-shape entry of 0824 stand as they are: no grant moves and no new conf is needed. The ownership bracket is 0824's.
--
-- Numbered above the highest migration on the code plane. Re-check against main right before merging.

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'merge_queue_sweep_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on merge_queue_sweep_definer; cannot replace merge_queue_sweep_targets';
    END IF;
    GRANT merge_queue_sweep_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO merge_queue_sweep_definer;

CREATE OR REPLACE FUNCTION merge_queue_sweep_targets(p_now timestamptz, p_limit int)
RETURNS TABLE (account_id uuid, repo_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT e.account_id, e.repo_id
    FROM public.merge_queue_entries e
   WHERE (e.state = 'in_flight' AND e.lease_until <= p_now)
      OR e.state = 'awaiting_work'
      OR (e.state = 'queued'
          AND NOT EXISTS (SELECT 1 FROM public.merge_queue_entries h
                           WHERE h.account_id = e.account_id AND h.repo_id = e.repo_id
                             AND h.state = 'in_flight' AND h.lease_until > p_now))
   GROUP BY e.account_id, e.repo_id
   ORDER BY min(e.updated_at), e.account_id, e.repo_id
   LIMIT LEAST(GREATEST(p_limit, 1), 200)
$$;

REVOKE CREATE ON SCHEMA public FROM merge_queue_sweep_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE merge_queue_sweep_definer FROM CURRENT_USER;
  END IF;
END
$$;
