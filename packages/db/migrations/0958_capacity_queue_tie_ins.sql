-- D#483 S5-k3b-h: two of the capacity queue's definers check one more fact at the data. Same signatures, same owner (capacity_queue_definer), same pinned
-- search_path, and EXECUTE for the same role 0941 granted (agent_run_writer); nothing else changes.
--
-- 1. capacity_enqueue refuses an item that is not on p_repo_id (foreign_key_violation, as for a repository of another account). The entry's repository is what the
--    claim checks, so an entry naming another repository's item would be claimed on the wrong repository's connection.
-- 2. capacity_mark_started answers false, and records nothing, for a run whose execution_mode is not 'sandbox'. Only hosted sandbox work is queued, so only a
--    sandbox run can be the start of an entry.
-- 3. The definer role may now read work_items.repo_id (0943 granted id, account_id, halted_at and stage, and its select policy on work_items). It already reads
--    agent_runs.execution_mode (0941).
--
-- A correction to 0941, which stays byte-identical: its comment on the accounts policy says FORCE ROW LEVEL SECURITY applies to every role but the owner. It
-- applies to the table owner too; FORCE is what removes the owner's exemption. Only superusers and BYPASSRLS roles skip the policies.
--
-- Expand-only: two replaced functions and one column grant. Numbered above 0955; re-check against main right before merging.

GRANT SELECT (repo_id) ON work_items TO capacity_queue_definer;

DO $$
DECLARE
  r text := 'capacity_queue_definer';
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = r::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot replace its functions', r;
    END IF;
    EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', r);
  END IF;
  EXECUTE format('GRANT CREATE ON SCHEMA public TO %I', r);
END
$$;

CREATE OR REPLACE FUNCTION capacity_enqueue(p_repo_id uuid, p_work_item_id uuid, p_run_kind text, p_class text, p_refused_status integer DEFAULT NULL, p_refused_code text DEFAULT NULL)
RETURNS TABLE (o_id uuid, o_attempt integer, o_enqueued_at timestamptz, o_created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
BEGIN
  IF acct IS NULL THEN
    RAISE EXCEPTION 'capacity_enqueue: no app.account_id set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_class IS DISTINCT FROM 'hosted_sandbox' THEN
    RAISE EXCEPTION 'capacity_enqueue: only hosted_sandbox work is queued' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.repos WHERE account_id = acct AND id = p_repo_id) THEN
    RAISE EXCEPTION 'capacity_enqueue: no such repository for this account' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.work_items w WHERE w.account_id = acct AND w.id = p_work_item_id AND w.repo_id = p_repo_id) THEN
    RAISE EXCEPTION 'capacity_enqueue: no such item on this repository (foreign key to work_items)' USING ERRCODE = 'foreign_key_violation';
  END IF;
  -- A new entry is a new place at the end. An entry that is waiting stays where it is (a second call is no new place). An entry that was claimed and comes back
  -- keeps its enqueued_at and starts its next attempt.
  RETURN QUERY
  INSERT INTO public.capacity_queue AS q (account_id, repo_id, work_item_id, run_kind, class, refused_status, refused_code)
  VALUES (acct, p_repo_id, p_work_item_id, p_run_kind, p_class, p_refused_status, p_refused_code)
  ON CONFLICT (account_id, work_item_id) WHERE ended_at IS NULL AND started_run_id IS NULL DO UPDATE
     SET attempt = q.attempt + CASE WHEN q.claimed_at IS NOT NULL THEN 1 ELSE 0 END,
         claimed_at = NULL, claim_expires_at = NULL,
         refused_status = COALESCE(EXCLUDED.refused_status, q.refused_status), refused_code = COALESCE(EXCLUDED.refused_code, q.refused_code)
  RETURNING q.id, q.attempt, q.enqueued_at, (xmax = 0);
END $$;

CREATE OR REPLACE FUNCTION capacity_mark_started(p_entry_id uuid, p_attempt integer, p_run_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- The run must be a sandbox run of the entry's own item, in its own account; only the attempt that holds the claim may record it, and only once.
  UPDATE public.capacity_queue q SET started_run_id = p_run_id
   WHERE q.id = p_entry_id AND q.attempt = p_attempt AND q.claimed_at IS NOT NULL AND q.started_run_id IS NULL AND q.ended_at IS NULL
     AND EXISTS (SELECT 1 FROM public.agent_runs u WHERE u.id = p_run_id AND u.account_id = q.account_id AND u.work_item_id = q.work_item_id AND u.execution_mode = 'sandbox');
  RETURN FOUND;
END $$;

-- The bracket again, so the two stay exactly as 0941 left them: owned by the definer role, no PUBLIC entry, EXECUTE for agent_run_writer only.
REVOKE ALL ON FUNCTION capacity_enqueue(uuid, uuid, text, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION capacity_mark_started(uuid, integer, uuid) FROM PUBLIC;
ALTER FUNCTION capacity_enqueue(uuid, uuid, text, text, integer, text) OWNER TO capacity_queue_definer;
ALTER FUNCTION capacity_mark_started(uuid, integer, uuid) OWNER TO capacity_queue_definer;
GRANT EXECUTE ON FUNCTION capacity_enqueue(uuid, uuid, text, text, integer, text) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION capacity_mark_started(uuid, integer, uuid) TO agent_run_writer;

REVOKE CREATE ON SCHEMA public FROM capacity_queue_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE capacity_queue_definer FROM CURRENT_USER;
  END IF;
END
$$;
