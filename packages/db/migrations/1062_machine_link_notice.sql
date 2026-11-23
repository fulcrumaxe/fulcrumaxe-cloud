-- D#845 ON-2b: the notice an account's owners and admins get when a machine is linked, and the address the link came from.
--
--   account_notices        one row per recipient (an owner or admin of the account when it was posted): kind and a ref id, never text, so no address or name
--                          is in it. A recipient reads their own rows; nobody writes one except account_notice_post. It is general: the next notice
--                          (the engine plan's "fewer engines than running") posts another kind through the same function.
--   account_notice_post    (kind, ref) -> how many recipients. Posts to the session's account (app.account_id); no EXECUTE for app_user (only the definers owned by the same
--                          role post, and only to the context's own account).
--   runner_link_facts      one row per linked machine: when, and the address its start request came from (NULL when the platform header was missing or
--                          not one address). It is a table of its own because app_user holds a table-wide SELECT on runners: a column there would be
--                          readable by every member. Here the policy is owner or admin of the account, and the row is deleted when the runner is revoked.
--   runner_device_codes.source_ip  the address the code's start request came from. app_user's column grant on that table does not name it, so no session
--                          reads it. runner_device_start takes it as a ninth argument (NULL by default); the signature changes, so it is dropped and made again
--                          whole from 1037, with the same owner and EXECUTE.
--   machine_link_record(runner_id)  called by the approve route in the approval's own transaction: moves the address from the code row to
--                          runner_link_facts and clears it from the code row, posts the notice and writes machine.linked_notified (ids and a count only).
--                          It does nothing the second time, so a retry cannot notify twice.
--
-- Numbered 1062 by the Team Lead. Re-check against main's highest right before merging and renumber to stay above it.

CREATE TABLE account_notices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind ~ '^[a-z_]+\.[a-z_]+$'),
  ref         uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_notices_user ON account_notices (account_id, user_id, created_at DESC);

ALTER TABLE runner_device_codes ADD COLUMN source_ip inet;

CREATE TABLE runner_link_facts (
  runner_id       uuid PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  linked_at       timestamptz NOT NULL DEFAULT now(),
  linked_from_ip  inet,
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE
);

DO $$
DECLARE
  t text;
  who text := 'account_id = NULLIF(current_setting(''app.account_id'', true), '''')::uuid AND EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = %I.account_id AND m.user_id = NULLIF(current_setting(''app.user_id'', true), '''')::uuid AND m.role IN (''owner'', ''admin''))';
BEGIN
  FOREACH t IN ARRAY ARRAY['account_notices', 'runner_link_facts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
  -- A recipient's own rows, and only while they are still an owner or admin of the account.
  EXECUTE format('CREATE POLICY recipient_select ON account_notices FOR SELECT TO app_user USING (%s AND user_id = NULLIF(current_setting(''app.user_id'', true), '''')::uuid)', format(who, 'account_notices'));
  EXECUTE format('CREATE POLICY owner_admin_select ON runner_link_facts FOR SELECT TO app_user USING (%s)', format(who, 'runner_link_facts'));
END
$$;
GRANT SELECT ON account_notices, runner_link_facts TO app_user;

-- ---- ownership bracket (1037's shape) ------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'onboarding_ops'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on onboarding_ops; cannot ALTER FUNCTION ... OWNER TO onboarding_ops';
    END IF;
    GRANT onboarding_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO onboarding_ops;

-- What the definers below write. The role already reads codes, members and accounts (1037).
GRANT INSERT ON account_notices, runner_link_facts TO onboarding_ops;
GRANT DELETE ON runner_link_facts TO onboarding_ops;
GRANT SELECT (runner_id, account_id) ON runner_link_facts TO onboarding_ops;
GRANT INSERT (source_ip), UPDATE (source_ip) ON runner_device_codes TO onboarding_ops;
CREATE POLICY onboarding_ops_notice ON account_notices FOR INSERT TO onboarding_ops
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY onboarding_ops_link_select ON runner_link_facts FOR SELECT TO onboarding_ops USING (true);
CREATE POLICY onboarding_ops_link_insert ON runner_link_facts FOR INSERT TO onboarding_ops
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
-- The drop trigger runs on whichever path revoked the runner, with or without an account in context.
CREATE POLICY onboarding_ops_link_delete ON runner_link_facts FOR DELETE TO onboarding_ops USING (true);
-- machine.linked_notified is written straight into audit_log, as 1037's definers write theirs (audit_write's EXECUTE list is pinned and stays so).
CREATE POLICY onboarding_ops_link_audit ON audit_log FOR INSERT TO onboarding_ops
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND action = 'machine.linked_notified');

DROP FUNCTION runner_device_start(text, text, jsonb, text, jsonb, text, integer, integer);
CREATE FUNCTION runner_device_start(p_device_hash text, p_user_hash text, p_jwk jsonb, p_jkt text, p_facts jsonb, p_ip_hash text, p_ip_limit integer, p_global_limit integer, p_source_ip inet DEFAULT NULL)
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_expires timestamptz := now() + interval '10 minutes';
BEGIN
  IF p_device_hash IS NULL OR p_device_hash !~ '^[0-9a-f]{64}$' OR p_user_hash IS NULL OR p_user_hash !~ '^[0-9a-f]{64}$'
     OR p_ip_hash IS NULL OR p_ip_hash !~ '^[0-9a-f]{64}$' OR p_jkt IS NULL OR p_jkt !~ '^[A-Za-z0-9_-]{43}$'
     OR p_ip_limit IS NULL OR p_ip_limit < 1 OR p_global_limit IS NULL OR p_global_limit < 1
     OR p_jwk IS NULL OR p_facts IS NULL THEN
    RAISE EXCEPTION 'runner_device_start: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- One start at a time, so the two counts below cannot be raced past their limits.
  PERFORM pg_advisory_xact_lock(hashtextextended('runner_device_start', 0));
  IF (SELECT count(*) FROM public.runner_device_codes c WHERE c.start_ip_hash = p_ip_hash AND c.created_at > now() - interval '1 hour') >= p_ip_limit
     OR (SELECT count(*) FROM public.runner_device_codes c WHERE c.created_at > now() - interval '1 hour') >= p_global_limit THEN
    RAISE EXCEPTION 'runner_device_start: too many starts' USING ERRCODE = 'configuration_limit_exceeded';
  END IF;
  -- A unique violation on either hash is the caller's cue to draw a new code and try again.
  INSERT INTO public.runner_device_codes (device_code_hash, user_code_hash, jkt, public_key_jwk, facts, expires_at, start_ip_hash, source_ip)
  VALUES (p_device_hash, p_user_hash, p_jkt, p_jwk, p_facts, v_expires, p_ip_hash, p_source_ip);
  RETURN v_expires;
END;
$$;

CREATE FUNCTION account_notice_post(p_kind text, p_ref uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  n     integer;
BEGIN
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'account_notice_post: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_kind IS NULL OR p_kind !~ '^[a-z_]+\.[a-z_]+$' THEN
    RAISE EXCEPTION 'account_notice_post: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.account_notices (account_id, user_id, kind, ref)
  SELECT acct, m.user_id, p_kind, p_ref FROM public.account_members m WHERE m.account_id = acct AND m.role IN ('owner', 'admin');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE FUNCTION machine_link_record(p_runner_id uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr   uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v     public.runner_device_codes;
  n     integer;
BEGIN
  IF acct IS NULL OR usr IS NULL OR NOT account_is_active(acct) OR p_runner_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'machine_link_record: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Only the code this account just approved for this runner (a runner of another account, or one with no approved code, is not found).
  SELECT * INTO v FROM public.runner_device_codes c WHERE c.runner_id = p_runner_id AND c.account_id = acct AND c.status = 'approved' FOR UPDATE;
  -- A revoked runner is not a link to tell anyone about (and its address would sit in a row nothing deletes again).
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = p_runner_id AND r.account_id = acct AND r.revoked_at IS NULL)
     OR EXISTS (SELECT 1 FROM public.runner_link_facts f WHERE f.runner_id = p_runner_id) THEN
    RETURN 0;
  END IF;
  INSERT INTO public.runner_link_facts (runner_id, account_id, linked_from_ip) VALUES (p_runner_id, acct, v.source_ip);
  UPDATE public.runner_device_codes c SET source_ip = NULL WHERE c.id = v.id;
  n := public.account_notice_post('machine.linked', p_runner_id);
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, 'user:' || usr::text, 'machine.linked_notified', jsonb_build_object('runner_id', p_runner_id, 'recipients', n), clock_timestamp());
  RETURN n;
END;
$$;

-- Revoking a runner drops its address, whichever path revoked it. A trigger on runners is the one place every revoking path passes (0712's definers, 0720's member
-- guard and any later one). The function is SECURITY DEFINER and owned by onboarding_ops, the role that holds the delete (0786's shape; the ownership guard names
-- it in its allowlist). It deletes only the row of the runner the trigger fired for, and only when that runner is revoked.
CREATE FUNCTION runner_link_facts_drop_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  DELETE FROM public.runner_link_facts f WHERE f.runner_id = NEW.id AND NEW.revoked_at IS NOT NULL;
  RETURN NULL;
END;
$$;
CREATE TRIGGER runner_link_facts_drop AFTER UPDATE OF revoked_at ON runners
  FOR EACH ROW WHEN (NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL) EXECUTE FUNCTION runner_link_facts_drop_trigger();

REVOKE ALL ON FUNCTION runner_device_start(text, text, jsonb, text, jsonb, text, integer, integer, inet) FROM PUBLIC;
REVOKE ALL ON FUNCTION account_notice_post(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION machine_link_record(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_link_facts_drop_trigger() FROM PUBLIC;
ALTER FUNCTION runner_device_start(text, text, jsonb, text, jsonb, text, integer, integer, inet) OWNER TO onboarding_ops;
ALTER FUNCTION account_notice_post(text, uuid) OWNER TO onboarding_ops;
ALTER FUNCTION machine_link_record(uuid) OWNER TO onboarding_ops;
ALTER FUNCTION runner_link_facts_drop_trigger() OWNER TO onboarding_ops;
GRANT EXECUTE ON FUNCTION runner_device_start(text, text, jsonb, text, jsonb, text, integer, integer, inet) TO app_user;
-- account_notice_post has no EXECUTE for app_user: only machine_link_record (the same owner) posts, until a session caller exists.
GRANT EXECUTE ON FUNCTION machine_link_record(uuid) TO app_user;
-- A trigger function needs no EXECUTE to fire; the one grant is the shape check's, and calling it directly only answers "trigger functions can only be called as triggers".
GRANT EXECUTE ON FUNCTION runner_link_facts_drop_trigger() TO app_user;

REVOKE CREATE ON SCHEMA public FROM onboarding_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE onboarding_ops FROM CURRENT_USER;
  END IF;
END
$$;
