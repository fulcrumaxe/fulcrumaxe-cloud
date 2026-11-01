-- D#483 S5-k3b-2a: the capacity queue's reads, the re-queue after a refused start, and the "still asking" rule. Nothing here starts, refuses or fails a run:
-- no start site calls the queue yet (S5-k3b-2c wires that), and the close path only ends a waiting entry (capacity_end_cancelled, 0941).
--
-- 1. capacity_entry_asking(account, repo, item): ONE internal rule for "this entry counts". An entry holds a place, can be claimed and counts toward the queue's depth
--    only while all of these hold: its account is active, its repository is still connected, its item is not halted and has not left for a final stage (merged,
--    closed_unmerged, closed), and the item's latest waiting fact (stage_waiting, or the build_waiting that S5-k1 wrote) says waiting_for_capacity and is younger
--    than 2700 seconds (RESERVATION_PAUSE_WINDOW_SECONDS; a test holds the two equal). An entry that fails the rule is SKIPPED: never dropped, never ended, and it is
--    claimable again, in its original enqueued_at order, as soon as the item asks again. Owned by capacity_queue_definer, SECURITY INVOKER, no EXECUTE for anyone else:
--    only the definers below (which run as that owner) can call it.
-- 2. capacity_claim_next and capacity_queue_state: same signatures, owner, grants and order; both now use the rule (the claim for the candidate and for the head
--    of its account, the state for the waiting count that the depth alert and the direct-start test read).
-- 3. capacity_queue_place(item): the session's own item only (app.account_id; raises without it). Place in the class queue in the claim's own order, why the entry is
--    skipped if it is, and the class's start statistics (the last 50 starts that came out of the queue and whose run is not refused_spend: how many, and the median
--    wait from enqueued_at to the claimed_at of the claim that started). It gives back no other account's id.
-- 4. capacity_requeue_refused(entry, run, status, code): puts an entry back after the provider refused its start with 429. Same entry, same enqueued_at, attempt + 1.
--
-- Expand-only: functions, column grants, policies and one index. No DELETE grant anywhere. Numbered above 0941; re-check against main right before merging.

-- What the rule reads, and nothing more. The tables are FORCE ROW LEVEL SECURITY, so each needs a policy for the definer role.
GRANT SELECT (account_id, work_item_id, kind, code, created_at, seq) ON work_item_driver_events TO capacity_queue_definer;
GRANT SELECT (id, account_id, halted_at, stage) ON work_items TO capacity_queue_definer;
CREATE POLICY capacity_queue_definer_select ON work_item_driver_events FOR SELECT TO capacity_queue_definer USING (kind IN ('build_waiting', 'stage_waiting'));
CREATE POLICY capacity_queue_definer_select ON work_items FOR SELECT TO capacity_queue_definer USING (true);

-- The last-50 read: started entries of a class, newest claim first.
CREATE INDEX capacity_queue_started ON capacity_queue (class, claimed_at DESC) WHERE started_run_id IS NOT NULL;

DO $$
DECLARE
  r text := 'capacity_queue_definer';
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = r::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot own or replace its functions', r;
    END IF;
    EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', r);
  END IF;
  EXECUTE format('GRANT CREATE ON SCHEMA public TO %I', r);
END
$$;

-- Volatile on purpose: it reads the clock, and a stable label would let the planner reuse one answer across rows.
CREATE FUNCTION capacity_entry_asking(p_account_id uuid, p_repo_id uuid, p_work_item_id uuid)
RETURNS boolean
LANGUAGE sql SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = p_account_id AND a.status = 'active')
     AND EXISTS (SELECT 1 FROM public.repos r WHERE r.account_id = p_account_id AND r.id = p_repo_id AND r.installation_id IS NOT NULL)
     AND EXISTS (
       SELECT 1
         FROM public.work_items w
         JOIN LATERAL (
           SELECT x.code, x.created_at FROM public.work_item_driver_events x
            WHERE x.account_id = w.account_id AND x.work_item_id = w.id AND x.kind IN ('build_waiting', 'stage_waiting')
            ORDER BY x.seq DESC LIMIT 1
         ) e ON true
        WHERE w.account_id = p_account_id AND w.id = p_work_item_id AND w.halted_at IS NULL
          AND w.stage NOT IN ('merged', 'closed_unmerged', 'closed')
          AND e.code = 'waiting_for_capacity'
          AND e.created_at > clock_timestamp() - make_interval(secs => 2700));
$$;
REVOKE ALL ON FUNCTION capacity_entry_asking(uuid, uuid, uuid) FROM PUBLIC;
ALTER FUNCTION capacity_entry_asking(uuid, uuid, uuid) OWNER TO capacity_queue_definer;

CREATE OR REPLACE FUNCTION capacity_claim_next(p_class text, p_lease_seconds integer)
RETURNS TABLE (o_id uuid, o_account_id uuid, o_repo_id uuid, o_work_item_id uuid, o_run_kind text, o_attempt integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  picked uuid;
BEGIN
  IF p_class IS DISTINCT FROM 'hosted_sandbox' THEN
    RAISE EXCEPTION 'capacity_claim_next: only hosted_sandbox work is queued' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 3600 THEN
    RAISE EXCEPTION 'capacity_claim_next: the lease is 10 to 3600 seconds' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Claimable: waiting, no live lease, and still asking (capacity_entry_asking: account live, repository connected, item not halted or finished, latest waiting fact
  -- fresh and waiting_for_capacity). The head of an account is its oldest claimable entry; of the heads, the account holding the fewest slots goes first (a live
  -- sandbox run holds one, so does an unexpired claim), a tie to the oldest head.
  SELECT q.id INTO picked
    FROM public.capacity_queue q
   WHERE q.class = p_class AND q.ended_at IS NULL AND q.started_run_id IS NULL
     AND (q.claim_expires_at IS NULL OR q.claim_expires_at <= clock_timestamp())
     AND public.capacity_entry_asking(q.account_id, q.repo_id, q.work_item_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.capacity_queue p
        WHERE p.account_id = q.account_id AND p.class = q.class AND p.ended_at IS NULL AND p.started_run_id IS NULL
          AND (p.claim_expires_at IS NULL OR p.claim_expires_at <= clock_timestamp())
          AND public.capacity_entry_asking(p.account_id, p.repo_id, p.work_item_id)
          AND (p.enqueued_at, p.id) < (q.enqueued_at, q.id))
   ORDER BY (SELECT count(*) FROM public.agent_runs u WHERE u.account_id = q.account_id AND u.execution_mode = 'sandbox' AND u.status IN ('pending', 'running', 'paused'))
          + (SELECT count(*) FROM public.capacity_queue c WHERE c.account_id = q.account_id AND c.class = q.class AND c.ended_at IS NULL AND c.started_run_id IS NULL AND c.claim_expires_at > clock_timestamp()),
            q.enqueued_at, q.id
   LIMIT 1
   FOR UPDATE OF q SKIP LOCKED;
  IF picked IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  UPDATE public.capacity_queue q SET claimed_at = clock_timestamp(), claim_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
   WHERE q.id = picked
  RETURNING q.id, q.account_id, q.repo_id, q.work_item_id, q.run_kind, q.attempt;
END $$;

CREATE OR REPLACE FUNCTION capacity_queue_state(p_class text)
RETURNS TABLE (o_slots_in_use integer, o_waiting integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_class IS DISTINCT FROM 'hosted_sandbox' THEN
    RAISE EXCEPTION 'capacity_queue_state: only hosted_sandbox work is queued' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Across every account: the slots held (live sandbox runs, plus unexpired claims whose run may not exist yet) and the open entries that are still asking
  -- (waiting or claimed; a skipped entry holds no place and is not counted).
  RETURN QUERY
  SELECT ((SELECT count(*) FROM public.agent_runs u WHERE u.execution_mode = 'sandbox' AND u.status IN ('pending', 'running', 'paused'))
          + (SELECT count(*) FROM public.capacity_queue c WHERE c.class = p_class AND c.ended_at IS NULL AND c.started_run_id IS NULL AND c.claim_expires_at > clock_timestamp()))::integer,
         (SELECT count(*) FROM public.capacity_queue w WHERE w.class = p_class AND w.ended_at IS NULL AND w.started_run_id IS NULL
             AND public.capacity_entry_asking(w.account_id, w.repo_id, w.work_item_id))::integer;
END $$;

CREATE FUNCTION capacity_queue_place(p_work_item_id uuid)
RETURNS TABLE (o_place integer, o_skip text, o_recent_starts integer, o_median_wait_seconds double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  e public.capacity_queue%ROWTYPE;
  skip text;
  place integer;
  n integer;
  med double precision;
BEGIN
  IF acct IS NULL THEN
    RAISE EXCEPTION 'capacity_queue_place: no app.account_id set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The session's own account's open entry for this item, or nothing: another account's item answers no row.
  SELECT * INTO e FROM public.capacity_queue q
   WHERE q.account_id = acct AND q.work_item_id = p_work_item_id AND q.ended_at IS NULL AND q.started_run_id IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = acct AND a.status = 'active') THEN
    skip := 'account_not_active';
  ELSIF NOT EXISTS (SELECT 1 FROM public.repos r WHERE r.account_id = acct AND r.id = e.repo_id AND r.installation_id IS NOT NULL) THEN
    skip := 'repo_not_connected';
  ELSIF NOT public.capacity_entry_asking(acct, e.repo_id, e.work_item_id) THEN
    skip := 'not_waiting';
  END IF;
  IF skip IS NULL THEN
    IF e.claim_expires_at IS NOT NULL AND e.claim_expires_at > clock_timestamp() THEN
      place := 1;
    ELSE
      -- The claim's own order applied claim after claim: an entry's key is (slots its account holds now + the claimable entries of its account ahead of it,
      -- enqueued_at, id). My place is one more than the number of claimable, unclaimed entries of the class with a smaller key.
      WITH cand AS (
        SELECT q.id, q.enqueued_at,
               (SELECT count(*) FROM public.agent_runs u WHERE u.account_id = q.account_id AND u.execution_mode = 'sandbox' AND u.status IN ('pending', 'running', 'paused'))
               + (SELECT count(*) FROM public.capacity_queue c WHERE c.account_id = q.account_id AND c.class = q.class AND c.ended_at IS NULL AND c.started_run_id IS NULL AND c.claim_expires_at > clock_timestamp())
               + (count(*) OVER (PARTITION BY q.account_id ORDER BY q.enqueued_at, q.id) - 1) AS k
          FROM public.capacity_queue q
         WHERE q.class = e.class AND q.ended_at IS NULL AND q.started_run_id IS NULL
           AND (q.claim_expires_at IS NULL OR q.claim_expires_at <= clock_timestamp())
           AND public.capacity_entry_asking(q.account_id, q.repo_id, q.work_item_id)
      )
      SELECT 1 + count(*) INTO place FROM cand c, cand m
       WHERE m.id = e.id AND (c.k, c.enqueued_at, c.id) < (m.k, m.enqueued_at, m.id);
    END IF;
  END IF;
  -- The class's last 50 starts that came out of the queue (a direct start never waited, so it is not here), minus runs refused for spend.
  SELECT count(*)::integer, percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (s.claimed_at - s.enqueued_at)))
    INTO n, med
    FROM (SELECT q.claimed_at, q.enqueued_at
            FROM public.capacity_queue q JOIN public.agent_runs u ON u.id = q.started_run_id AND u.account_id = q.account_id
           WHERE q.class = e.class AND q.started_run_id IS NOT NULL AND q.claimed_at IS NOT NULL AND u.status <> 'refused_spend'
           ORDER BY q.claimed_at DESC, q.id DESC LIMIT 50) s;
  RETURN QUERY SELECT place, skip, n, med;
END $$;

CREATE FUNCTION capacity_requeue_refused(p_entry_id uuid, p_run_id uuid, p_status integer, p_code text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_status IS DISTINCT FROM 429 THEN
    RETURN false;
  END IF;
  -- Only the entry's own started run, and only one the platform ended before it started (cancelled). The identity guard keeps id, item and enqueued_at as they are.
  BEGIN
    UPDATE public.capacity_queue q
       SET started_run_id = NULL, claimed_at = NULL, claim_expires_at = NULL, attempt = q.attempt + 1, refused_status = p_status, refused_code = p_code
     WHERE q.id = p_entry_id AND q.started_run_id = p_run_id AND q.ended_at IS NULL
       AND EXISTS (SELECT 1 FROM public.agent_runs u WHERE u.id = p_run_id AND u.account_id = q.account_id AND u.status = 'cancelled');
    RETURN FOUND;
  EXCEPTION WHEN unique_violation THEN
    -- The item already holds another open entry: nothing changes (the subtransaction is rolled back) and the caller keeps that one.
    RETURN false;
  END;
END $$;

REVOKE ALL ON FUNCTION capacity_queue_place(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION capacity_requeue_refused(uuid, uuid, integer, text) FROM PUBLIC;
ALTER FUNCTION capacity_queue_place(uuid) OWNER TO capacity_queue_definer;
ALTER FUNCTION capacity_requeue_refused(uuid, uuid, integer, text) OWNER TO capacity_queue_definer;
GRANT EXECUTE ON FUNCTION capacity_queue_place(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION capacity_requeue_refused(uuid, uuid, integer, text) TO agent_run_writer;

REVOKE CREATE ON SCHEMA public FROM capacity_queue_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE capacity_queue_definer FROM CURRENT_USER;
  END IF;
END
$$;
