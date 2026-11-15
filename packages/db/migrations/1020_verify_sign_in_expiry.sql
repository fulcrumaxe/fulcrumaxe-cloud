-- D#749 VERIFY-SIGNIN-EXPIRY: a post-merge check waits, instead of ending `wrong_account`, while the runner's saved verify sign-in is gone.
--
-- The app drops a session on its own server side (about a day after the last sign), while the cookie in the runner's saved sign-in still looks valid on that machine. The runner's verify
-- server then reads no account, the answer carried none, and the row ended `unverified: wrong_account`: a person had to sign in again and press "Verify again". Now the runner says on its claim
-- (protocol 18) what it reckons of the saved sign-in from two dates, the cloud keeps it, and a row waits for a good one.
--
--   1. `runners.verify_sign_in` (ok | expiring_soon | expired | missing) and `runners.verify_sign_in_at`, set together or both NULL. NULL: the runner never said (an older build, or no verify
--      address set on it). Written only by `runner_verify_sign_in_record(text)`, which names the runner the signature-verifying middleware set (app.runner_id), in the shape of 0763's
--      runner_sandbox_status_record: owned by a role of its own, runner_verify_sign_in_definer (column UPDATE on exactly these two columns, row policies for itself).
--      Note: platform_ops holds a table-wide grant on runners (0711), so it can also write these two columns; the worst a wrong value does is start or hold one check.
--   2. `verify_rows.hold_reason` gains `needs_sign_in`; `verify_rows.reason_code` gains `sign_in_expired` (a row that waited 24 hours, or was parked three times, ends with it).
--      `verify_rows_hold_unstarted` (1013) is NOT touched: a hold is still allowed only on a `pending` or `deploying` row.
--   3. `verify_rows.sign_in_parks`: how many times a running check was parked for this reason. It is the run key's suffix (a re-run must not replay the first run's key) and the cap on the loop
--      "re-run, parked again". App_user may update it and nothing else new.
--   4. verify_rows_guard (1003/1009) is replaced whole. The ONE difference from 1009's body: the move running -> pending is allowed, and only when the row is written with
--      hold_reason = 'needs_sign_in' (hold_since is then set too, by 1013's pair check). Every other rule is the same text; running -> pending with any other reason, or none, is still refused.
--      The row keeps method, deployed commit and start; the run id may be cleared (a run id is only ever cleared after the run starts, as before).
-- Numbered 1020 by the Team Lead (1018 and 1019 are claimed by other lanes); it merges after both. Re-check against main right before merging.
ALTER TABLE runners ADD COLUMN verify_sign_in text NULL CONSTRAINT runners_verify_sign_in_check CHECK (verify_sign_in IN ('ok', 'expiring_soon', 'expired', 'missing'));
ALTER TABLE runners ADD COLUMN verify_sign_in_at timestamptz NULL;
ALTER TABLE runners ADD CONSTRAINT runners_verify_sign_in_pair CHECK ((verify_sign_in IS NULL) = (verify_sign_in_at IS NULL));

-- Who may write them: a role of its own, in the shape of 0763's runner_sandbox_status_definer (platform_ops gains nothing and no existing definer's grants move): NOLOGIN, no members, a member of
-- nothing, column grants for exactly what the body reads and writes, row policies for this role only, a pinned search_path, EXECUTE for app_user alone.
DO $$
DECLARE
  n text := 'runner_verify_sign_in_definer';
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
GRANT USAGE ON SCHEMA public TO runner_verify_sign_in_definer;
GRANT SELECT (id, account_id, revoked_at, protocol_version), UPDATE (verify_sign_in, verify_sign_in_at) ON runners TO runner_verify_sign_in_definer;
GRANT SELECT (id, deleted_at) ON accounts TO runner_verify_sign_in_definer;
CREATE POLICY runner_verify_sign_in_definer_select ON runners FOR SELECT TO runner_verify_sign_in_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_verify_sign_in_definer_update ON runners FOR UPDATE TO runner_verify_sign_in_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_verify_sign_in_definer_select ON accounts FOR SELECT TO runner_verify_sign_in_definer USING (true);

ALTER TABLE verify_rows DROP CONSTRAINT verify_rows_hold_reason_check;
ALTER TABLE verify_rows ADD CONSTRAINT verify_rows_hold_reason_check CHECK (hold_reason IN ('unconfigured', 'run_over_daily', 'daily_cap', 'needs_sign_in'));
ALTER TABLE verify_rows DROP CONSTRAINT verify_rows_reason_check;
ALTER TABLE verify_rows ADD CONSTRAINT verify_rows_reason_check CHECK (reason_code IN (
  'no_browser', 'chrome_not_connected', 'wrong_account', 'sign_in_refused', 'deploy_failed', 'deployment_unreachable',
  'commit_not_deployed', 'envelope_rejected', 'hollow_pass', 'journey_blocked', 'journeys_missing', 'run_failed', 'verify_disabled', 'account_unverifiable',
  'no_visible_journeys', 'sign_in_expired'));
ALTER TABLE verify_rows ADD COLUMN sign_in_parks smallint NOT NULL DEFAULT 0 CONSTRAINT verify_rows_sign_in_parks_check CHECK (sign_in_parks BETWEEN 0 AND 10);
GRANT UPDATE (sign_in_parks) ON verify_rows TO app_user;

CREATE OR REPLACE FUNCTION verify_rows_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.repo_id IS DISTINCT FROM OLD.repo_id
     OR NEW.batch_id IS DISTINCT FROM OLD.batch_id OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id OR NEW.pr_number IS DISTINCT FROM OLD.pr_number
     OR NEW.merge_sha IS DISTINCT FROM OLD.merge_sha OR NEW.journeys IS DISTINCT FROM OLD.journeys OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'verify_rows: identity and journeys are fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('verified', 'failed', 'unverified') THEN
    IF NEW.status IS DISTINCT FROM OLD.status OR NEW.method IS DISTINCT FROM OLD.method OR NEW.deployed_commit IS DISTINCT FROM OLD.deployed_commit
       OR NEW.result IS DISTINCT FROM OLD.result OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
       OR NEW.deploy_by_order IS DISTINCT FROM OLD.deploy_by_order OR NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.finished_at IS DISTINCT FROM OLD.finished_at
       OR NEW.account_check IS DISTINCT FROM OLD.account_check THEN
      RAISE EXCEPTION 'verify_rows: a finished row does not change' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NOT ((OLD.status = 'pending' AND NEW.status IN ('pending', 'deploying', 'unverified'))
         OR (OLD.status = 'deploying' AND NEW.status IN ('deploying', 'running', 'unverified'))
         OR (OLD.status = 'running' AND NEW.status IN ('running', 'verified', 'failed', 'unverified'))
         -- D#749 VERIFY-SIGNIN-EXPIRY (1020): the only new move. A running check whose sign-in is gone goes back to waiting, with its reason.
         OR (OLD.status = 'running' AND NEW.status = 'pending' AND NEW.hold_reason IS NOT DISTINCT FROM 'needs_sign_in')) THEN
      RAISE EXCEPTION 'verify_rows: % -> % is not a move', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status NOT IN ('verified', 'failed', 'unverified')
       AND (NEW.result IS DISTINCT FROM OLD.result OR NEW.reason_code IS DISTINCT FROM OLD.reason_code OR NEW.finished_at IS DISTINCT FROM OLD.finished_at OR NEW.account_check IS DISTINCT FROM OLD.account_check) THEN
      RAISE EXCEPTION 'verify_rows: the verdict is written only by the move that finishes the row' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- Who gave the deploy order is fixed when the deploy starts.
  IF NEW.deploy_by_order IS DISTINCT FROM OLD.deploy_by_order AND NOT (OLD.status = 'pending' AND NEW.status = 'deploying') THEN
    RAISE EXCEPTION 'verify_rows: deploy_by_order is set only when the deploy starts' USING ERRCODE = 'check_violation';
  END IF;
  -- What drove the run, against which commit, and since when, is fixed when the run starts. A run id may only be cleared afterwards (by the foreign key).
  IF NOT (OLD.status = 'deploying' AND NEW.status = 'running')
     AND (NEW.method IS DISTINCT FROM OLD.method OR NEW.deployed_commit IS DISTINCT FROM OLD.deployed_commit OR NEW.started_at IS DISTINCT FROM OLD.started_at
          OR (NEW.run_id IS DISTINCT FROM OLD.run_id AND NEW.run_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'verify_rows: method, deployed commit, start and run are set only when the run starts' USING ERRCODE = 'check_violation';
  END IF;
  -- A person step is a fact: it only goes up.
  IF OLD.person_step AND NOT NEW.person_step THEN
    RAISE EXCEPTION 'verify_rows: a person step is not taken back' USING ERRCODE = 'check_violation';
  END IF;
  -- The bug item: set once, on a failed row; cleared only by the foreign key's own action (a nested trigger), never by a statement.
  IF NEW.bug_item_id IS DISTINCT FROM OLD.bug_item_id THEN
    IF NEW.bug_item_id IS NULL THEN
      IF pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION 'verify_rows: the bug item is not cleared' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD.status <> 'failed' OR OLD.bug_item_id IS NOT NULL THEN
      RAISE EXCEPTION 'verify_rows: the bug item is set once, on a failed row' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- The runner's own report of its saved verify sign-in, from its claim. Writes only the runner the middleware named, never an argument, and only for a runner whose hello declared protocol 18 or later.
CREATE FUNCTION runner_verify_sign_in_record(p_state text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  raw  text := COALESCE(current_setting('app.runner_id', true), '');
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_verify_sign_in_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct)
     OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'runner_verify_sign_in_record: the session is not a runner of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_state IS NULL OR p_state NOT IN ('ok', 'expiring_soon', 'expired', 'missing') THEN
    RAISE EXCEPTION 'runner_verify_sign_in_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.runners SET verify_sign_in = p_state, verify_sign_in_at = clock_timestamp()
   WHERE id = raw::uuid AND account_id = acct AND revoked_at IS NULL AND COALESCE(protocol_version, 0) >= 18;
END;
$$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'runner_verify_sign_in_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_verify_sign_in_definer; cannot ALTER FUNCTION ... OWNER TO runner_verify_sign_in_definer';
    END IF;
    GRANT runner_verify_sign_in_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_verify_sign_in_definer;
REVOKE ALL ON FUNCTION runner_verify_sign_in_record(text) FROM PUBLIC;
ALTER FUNCTION runner_verify_sign_in_record(text) OWNER TO runner_verify_sign_in_definer;
-- EXECUTE is granted after the transfer: changing an owner rewrites the ACL entries that named the old one.
GRANT EXECUTE ON FUNCTION runner_verify_sign_in_record(text) TO app_user;
REVOKE CREATE ON SCHEMA public FROM runner_verify_sign_in_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_verify_sign_in_definer FROM CURRENT_USER;
  END IF;
END
$$;
