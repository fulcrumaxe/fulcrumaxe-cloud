-- D#483 S5-k3b-1: the capacity queue's store, and nothing that starts a run. Work that cannot get one of our sandbox slots waits here; nothing in this file
-- reads the queue to refuse, cancel or fail a start, and no start site calls it yet (S5-k3b-2 wires that).
--
-- 1. capacity_queue: one row per waiting item. A row leaves the queue by getting `started_run_id` (it started) or `ended_at` (a person closed the
--    item). Nothing else ends a row, and no role holds DELETE. `class` is hosted_sandbox or runner; only hosted_sandbox is ever queued (the functions refuse
--    the other word). `attempt` is the start attempt: a lease that runs out keeps it (a replay of the same attempt is one start), and a refused start that
--    goes back bumps it. `refused_status` and `refused_code` record the provider answer (status, and its short code when it gave one) that sent the item here.
--    `repo_id` has no foreign key on purpose: a repository removed while the item waits must not delete the entry; the claim skips it (repository gone or
--    its installation removed, or the account not active) and it starts again when the repository is connected again.
-- 2. Five SECURITY DEFINER functions, all owned by capacity_queue_definer (a NOLOGIN role of its own, column grants for exactly what they read and write):
--      capacity_enqueue(...)       the session's own account (app.account_id; no account parameter) queues or re-queues one item. EXECUTE: agent_run_writer.
--      capacity_claim_next(...)    one entry under a lease, fair order. EXECUTE: agent_run_writer. FOR UPDATE SKIP LOCKED.
--      capacity_mark_started(...)  records the run an attempt started. EXECUTE: agent_run_writer.
--      capacity_queue_state(class) the slots held across all accounts (live sandbox runs plus unexpired claims) and the open entries. EXECUTE: agent_run_writer.
--      capacity_end_cancelled(id)  the ONLY writer of ended_at and ended_reason (C20): ends the session's account's waiting entry for a closed item. EXECUTE: app_user
--                                  (the close route's tenant session).
--    Fair order: across accounts the one holding the fewest slots of the class first (live sandbox runs plus unexpired claims), ties to the oldest waiting
--    entry; inside an account strict first in, first out by enqueued_at, which a returning entry keeps.
-- 3. capacity_queue_settings: the owner's two settings, append-only and versioned (the newest version of a key is current), and capacity_settings_write(key,
--    value), owned by ops_owner, EXECUTE for ops_console only, which records the staff actor. No row means the provisional default (alert_depth 20,
--    lease_seconds 120) applies and health reports capacity_queue_settings_defaulted.
--
-- Expand-only: new tables, roles and functions. Numbered above 0940; re-check against main right before merging.

CREATE TABLE capacity_queue (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id          uuid NOT NULL,
  work_item_id     uuid NOT NULL,
  run_kind         text NOT NULL CONSTRAINT capacity_queue_run_kind_check CHECK (run_kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  class            text NOT NULL CONSTRAINT capacity_queue_class_check CHECK (class IN ('hosted_sandbox', 'runner')),
  attempt          integer NOT NULL DEFAULT 1 CONSTRAINT capacity_queue_attempt_check CHECK (attempt >= 1),
  enqueued_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at       timestamptz,
  claim_expires_at timestamptz,
  started_run_id   uuid,
  refused_status   integer CONSTRAINT capacity_queue_refused_status_check CHECK (refused_status IS NULL OR refused_status BETWEEN 100 AND 599),
  refused_code     text CONSTRAINT capacity_queue_refused_code_check CHECK (refused_code IS NULL OR refused_code ~* '^[a-z0-9_.-]{1,64}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  ended_reason     text CONSTRAINT capacity_queue_ended_reason_check CHECK (ended_reason IN ('cancelled_by_person')),
  CONSTRAINT capacity_queue_ended_pair_check CHECK ((ended_at IS NULL) = (ended_reason IS NULL)),
  CONSTRAINT capacity_queue_lease_pair_check CHECK ((claimed_at IS NULL) = (claim_expires_at IS NULL)),
  CONSTRAINT capacity_queue_started_not_ended_check CHECK (started_run_id IS NULL OR ended_at IS NULL),
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE
);
-- One open entry per item: the same item queued twice is one place.
CREATE UNIQUE INDEX capacity_queue_open_item ON capacity_queue (account_id, work_item_id) WHERE ended_at IS NULL AND started_run_id IS NULL;
CREATE INDEX capacity_queue_waiting ON capacity_queue (class, enqueued_at, id) WHERE ended_at IS NULL AND started_run_id IS NULL;

-- The identity of an entry and its place never change, whatever a grant says.
CREATE FUNCTION capacity_queue_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.repo_id IS DISTINCT FROM OLD.repo_id
     OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id OR NEW.class IS DISTINCT FROM OLD.class OR NEW.enqueued_at IS DISTINCT FROM OLD.enqueued_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'capacity_queue: an entry''s identity and enqueued_at never change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION capacity_queue_identity_guard() FROM PUBLIC;
CREATE TRIGGER capacity_queue_identity_guard BEFORE UPDATE ON capacity_queue FOR EACH ROW EXECUTE FUNCTION capacity_queue_identity_guard();

ALTER TABLE capacity_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE capacity_queue FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_select ON capacity_queue FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
REVOKE ALL ON capacity_queue FROM PUBLIC;
GRANT SELECT ON capacity_queue TO app_user;

CREATE TABLE capacity_queue_settings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key        text NOT NULL,
  value      integer NOT NULL,
  version    integer NOT NULL CONSTRAINT capacity_queue_settings_version_check CHECK (version >= 1),
  actor      uuid NOT NULL REFERENCES platform_staff (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT capacity_queue_settings_value_check CHECK (
    (key = 'capacity_queue.alert_depth' AND value BETWEEN 1 AND 100000) OR (key = 'capacity_queue.lease_seconds' AND value BETWEEN 10 AND 3600)),
  UNIQUE (key, version)
);
ALTER TABLE capacity_queue_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE capacity_queue_settings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON capacity_queue_settings FROM PUBLIC;
-- The numbers are not secret and the helper reads them on the tenant session; the actor stays out of reach of app_user.
GRANT SELECT (key, value, version, created_at) ON capacity_queue_settings TO app_user;
CREATE POLICY app_user_read ON capacity_queue_settings FOR SELECT TO app_user USING (true);
GRANT SELECT (key, version), INSERT (key, value, version, actor) ON capacity_queue_settings TO ops_owner;
CREATE POLICY ops_owner_read ON capacity_queue_settings FOR SELECT TO ops_owner USING (true);
CREATE POLICY ops_owner_insert ON capacity_queue_settings FOR INSERT TO ops_owner WITH CHECK (true);

-- The definer role: NOLOGIN, no members (0894's bracket).
DO $$
DECLARE
  n text := 'capacity_queue_definer';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'role % still has a privileged attribute', n;
  END IF;
END
$$;

-- Its whole reach: the queue (read, insert, and update of the lease, attempt, start and end columns only), and the few columns of runs, repositories and accounts
-- the claim reads. It can change no identity column and no enqueued_at, and it holds no DELETE.
GRANT USAGE ON SCHEMA public TO capacity_queue_definer;
GRANT SELECT ON capacity_queue TO capacity_queue_definer;
GRANT INSERT (account_id, repo_id, work_item_id, run_kind, class, refused_status, refused_code) ON capacity_queue TO capacity_queue_definer;
GRANT UPDATE (attempt, claimed_at, claim_expires_at, started_run_id, refused_status, refused_code, ended_at, ended_reason) ON capacity_queue TO capacity_queue_definer;
GRANT SELECT (id, account_id, work_item_id, execution_mode, status) ON agent_runs TO capacity_queue_definer;
GRANT SELECT (id, account_id, installation_id) ON repos TO capacity_queue_definer;
GRANT SELECT (id, deleted_at, status) ON accounts TO capacity_queue_definer;
CREATE POLICY capacity_queue_definer_select ON capacity_queue FOR SELECT TO capacity_queue_definer USING (true);
CREATE POLICY capacity_queue_definer_insert ON capacity_queue FOR INSERT TO capacity_queue_definer WITH CHECK (true);
CREATE POLICY capacity_queue_definer_update ON capacity_queue FOR UPDATE TO capacity_queue_definer USING (true) WITH CHECK (true);
CREATE POLICY capacity_queue_definer_select ON agent_runs FOR SELECT TO capacity_queue_definer USING (true);
CREATE POLICY capacity_queue_definer_select ON repos FOR SELECT TO capacity_queue_definer USING (true);
-- A soft-deleted account is hidden from the claim here, by this policy (FORCE ROW LEVEL SECURITY applies to every role but the owner), not by a second filter in the function.
CREATE POLICY capacity_queue_definer_select ON accounts FOR SELECT TO capacity_queue_definer USING (deleted_at IS NULL);

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['capacity_queue_definer', 'ops_owner'] LOOP
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
      IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = r::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
        RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot ALTER FUNCTION ... OWNER TO it', r;
      END IF;
      EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', r);
    END IF;
    EXECUTE format('GRANT CREATE ON SCHEMA public TO %I', r);
  END LOOP;
END
$$;

CREATE FUNCTION capacity_enqueue(p_repo_id uuid, p_work_item_id uuid, p_run_kind text, p_class text, p_refused_status integer DEFAULT NULL, p_refused_code text DEFAULT NULL)
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

CREATE FUNCTION capacity_claim_next(p_class text, p_lease_seconds integer)
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
  -- Claimable: waiting, no live lease, the account live, the repository still connected. The head of an account is its oldest claimable entry; of the heads, the
  -- account holding the fewest slots goes first (a live sandbox run holds one, so does an unexpired claim), a tie to the oldest head.
  SELECT q.id INTO picked
    FROM public.capacity_queue q
   WHERE q.class = p_class AND q.ended_at IS NULL AND q.started_run_id IS NULL
     AND (q.claim_expires_at IS NULL OR q.claim_expires_at <= clock_timestamp())
     AND EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = q.account_id AND a.status = 'active')
     AND EXISTS (SELECT 1 FROM public.repos r WHERE r.account_id = q.account_id AND r.id = q.repo_id AND r.installation_id IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1 FROM public.capacity_queue p
        WHERE p.account_id = q.account_id AND p.class = q.class AND p.ended_at IS NULL AND p.started_run_id IS NULL
          AND (p.claim_expires_at IS NULL OR p.claim_expires_at <= clock_timestamp())
          AND EXISTS (SELECT 1 FROM public.repos r2 WHERE r2.account_id = p.account_id AND r2.id = p.repo_id AND r2.installation_id IS NOT NULL)
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

CREATE FUNCTION capacity_mark_started(p_entry_id uuid, p_attempt integer, p_run_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- The run must be the entry's own item's run, in its own account; only the attempt that holds the claim may record it, and only once.
  UPDATE public.capacity_queue q SET started_run_id = p_run_id
   WHERE q.id = p_entry_id AND q.attempt = p_attempt AND q.claimed_at IS NOT NULL AND q.started_run_id IS NULL AND q.ended_at IS NULL
     AND EXISTS (SELECT 1 FROM public.agent_runs u WHERE u.id = p_run_id AND u.account_id = q.account_id AND u.work_item_id = q.work_item_id);
  RETURN FOUND;
END $$;

CREATE FUNCTION capacity_queue_state(p_class text)
RETURNS TABLE (o_slots_in_use integer, o_waiting integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_class IS DISTINCT FROM 'hosted_sandbox' THEN
    RAISE EXCEPTION 'capacity_queue_state: only hosted_sandbox work is queued' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Across every account: the slots held (live sandbox runs, plus unexpired claims whose run may not exist yet) and the open entries (waiting or claimed).
  RETURN QUERY
  SELECT ((SELECT count(*) FROM public.agent_runs u WHERE u.execution_mode = 'sandbox' AND u.status IN ('pending', 'running', 'paused'))
          + (SELECT count(*) FROM public.capacity_queue c WHERE c.class = p_class AND c.ended_at IS NULL AND c.started_run_id IS NULL AND c.claim_expires_at > clock_timestamp()))::integer,
         (SELECT count(*) FROM public.capacity_queue w WHERE w.class = p_class AND w.ended_at IS NULL AND w.started_run_id IS NULL)::integer;
END $$;

CREATE FUNCTION capacity_end_cancelled(p_work_item_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  n integer;
BEGIN
  IF acct IS NULL THEN
    RAISE EXCEPTION 'capacity_end_cancelled: no app.account_id set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.capacity_queue q SET ended_at = clock_timestamp(), ended_reason = 'cancelled_by_person'
   WHERE q.account_id = acct AND q.work_item_id = p_work_item_id AND q.ended_at IS NULL AND q.started_run_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION capacity_enqueue(uuid, uuid, text, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION capacity_claim_next(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION capacity_mark_started(uuid, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION capacity_queue_state(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION capacity_end_cancelled(uuid) FROM PUBLIC;
ALTER FUNCTION capacity_enqueue(uuid, uuid, text, text, integer, text) OWNER TO capacity_queue_definer;
ALTER FUNCTION capacity_claim_next(text, integer) OWNER TO capacity_queue_definer;
ALTER FUNCTION capacity_mark_started(uuid, integer, uuid) OWNER TO capacity_queue_definer;
ALTER FUNCTION capacity_queue_state(text) OWNER TO capacity_queue_definer;
ALTER FUNCTION capacity_end_cancelled(uuid) OWNER TO capacity_queue_definer;
-- EXECUTE after the transfer: the run-writer login for the driver's three, the tenant session (app_user) for the close path's one.
GRANT EXECUTE ON FUNCTION capacity_enqueue(uuid, uuid, text, text, integer, text) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION capacity_claim_next(text, integer) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION capacity_mark_started(uuid, integer, uuid) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION capacity_queue_state(text) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION capacity_end_cancelled(uuid) TO app_user;

-- The settings writer: the owner's console only. ops_current_staff() raises unless app.staff_id is an active staff member, and that id is the recorded actor.
CREATE FUNCTION capacity_settings_write(p_key text, p_value integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  who uuid := public.ops_current_staff();
  v integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('capacity_queue_settings:' || coalesce(p_key, ''), 0));
  SELECT coalesce(max(version), 0) + 1 INTO v FROM public.capacity_queue_settings WHERE key = p_key;
  INSERT INTO public.capacity_queue_settings (key, value, version, actor) VALUES (p_key, p_value, v, who);
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION capacity_settings_write(text, integer) FROM PUBLIC;
ALTER FUNCTION capacity_settings_write(text, integer) OWNER TO ops_owner;
GRANT EXECUTE ON FUNCTION capacity_settings_write(text, integer) TO ops_console;

REVOKE CREATE ON SCHEMA public FROM capacity_queue_definer, ops_owner;
DO $$
DECLARE
  r text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH r IN ARRAY ARRAY['capacity_queue_definer', 'ops_owner'] LOOP
      EXECUTE format('REVOKE %I FROM CURRENT_USER', r);
    END LOOP;
  END IF;
END
$$;
