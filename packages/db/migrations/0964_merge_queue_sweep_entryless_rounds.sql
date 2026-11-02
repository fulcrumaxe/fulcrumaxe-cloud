-- D#519 MQ4-e1-a: the cron sweep also lists repos that hold an open merge-conflict round with no queue entry.
--
-- A direct-gate item (no queue entry) gets a conflict round whose end the workflow's durable wait drives. When that workflow dies, nothing else looks at
-- the round, and the item would wait for ever. merge_queue_sweep_targets (0824, 0924) read only the entries table; it now answers a repo that holds a
-- round with `entry_id` NULL and no outcome too, and the sweep applies the same completion (and its 120-minute timeout) the workflow's wait would have.
--
-- Same function, signature, owner and EXECUTE grant (CREATE OR REPLACE). Its owner gains the 0824 pattern for the rounds table: a column SELECT on the four
-- columns the new branch reads, and a SELECT-only policy for the owner role (the table forces row-level security, so a grant alone would show it no row).
-- Nothing is written, nothing else is readable, and the other branches are 0924's text. The ownership bracket is 0824's.
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

GRANT SELECT (account_id, repo_id, entry_id, outcome) ON merge_conflict_rounds TO merge_queue_sweep_definer;
CREATE POLICY merge_queue_sweep_select ON merge_conflict_rounds FOR SELECT TO merge_queue_sweep_definer USING (true);

CREATE OR REPLACE FUNCTION merge_queue_sweep_targets(p_now timestamptz, p_limit int)
RETURNS TABLE (account_id uuid, repo_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT t.account_id, t.repo_id
    FROM (
      SELECT e.account_id, e.repo_id, min(e.updated_at) AS touched
        FROM public.merge_queue_entries e
       WHERE (e.state = 'in_flight' AND e.lease_until <= p_now)
          OR e.state = 'awaiting_work'
          OR (e.state = 'queued'
              AND NOT EXISTS (SELECT 1 FROM public.merge_queue_entries h
                               WHERE h.account_id = e.account_id AND h.repo_id = e.repo_id
                                 AND h.state = 'in_flight' AND h.lease_until > p_now))
       GROUP BY e.account_id, e.repo_id
      UNION ALL
      -- An open round with no entry has no row time to sort by (only the four columns above are readable): it sorts first, so a stranded one is never starved.
      SELECT r.account_id, r.repo_id, '-infinity'::timestamptz
        FROM public.merge_conflict_rounds r
       WHERE r.entry_id IS NULL AND r.outcome IS NULL
       GROUP BY r.account_id, r.repo_id
    ) t
   GROUP BY t.account_id, t.repo_id
   ORDER BY min(t.touched), t.account_id, t.repo_id
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
