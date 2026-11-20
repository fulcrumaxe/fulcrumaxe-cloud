-- D#587 B-5a part 3: the four reasons a runner configured for the microVM engine gives for refusing to claim. runner_sandbox_status holds one closed reason per runner whose sandbox
-- is not working (0763); the closed set grows from five to nine:
--
--   microvm_no_kvm, microvm_helper_missing, microvm_helper_not_ready, microvm_helper_out_of_date
--
-- Two places hold the set and both change, or a runner that sends a new code fails its status write and with it its claim poll:
--   1. runner_sandbox_status_reason_check (the CHECK on the table): dropped and added again with the nine.
--   2. runner_sandbox_status_record(text) (0763, the only definition so far): replaced with CREATE OR REPLACE. The body is 0763's text; the ONE difference is the list in the
--      argument check. CREATE OR REPLACE keeps the owner (runner_sandbox_status_definer), the pinned search_path, SECURITY DEFINER and the ACL; the REVOKE and GRANT after it say the
--      same thing again (nothing moves). No other role, table, grant or policy changes: platform_ops still holds nothing here.
-- The protocol number goes to 25 in the same change (a runner at 25 is the first that sends a microvm_* code); the cloud deploys first, so an older cloud never sees one.
--
-- Numbered 1044 by the Team Lead (1043 is held by another lane). Re-check against main right before merging and renumber to stay above its highest.

ALTER TABLE runner_sandbox_status DROP CONSTRAINT runner_sandbox_status_reason_check;
ALTER TABLE runner_sandbox_status ADD CONSTRAINT runner_sandbox_status_reason_check CHECK (
  reason IN ('bwrap_missing', 'socat_missing', 'userns_disabled', 'apparmor_userns_restricted', 'probe_failed_other',
             'microvm_no_kvm', 'microvm_helper_missing', 'microvm_helper_not_ready', 'microvm_helper_out_of_date')
);

-- The definer owns the function, so replacing it needs its ownership for the length of this file (0763's bracket, closed again at the end).
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'runner_sandbox_status_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_sandbox_status_definer; cannot replace runner_sandbox_status_record';
    END IF;
    GRANT runner_sandbox_status_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

GRANT CREATE ON SCHEMA public TO runner_sandbox_status_definer;

CREATE OR REPLACE FUNCTION runner_sandbox_status_record(p_reason text)
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
    RAISE EXCEPTION 'runner_sandbox_status_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct)
     OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'runner_sandbox_status_record: the session is not a runner of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NOT NULL
     AND p_reason NOT IN ('bwrap_missing', 'socat_missing', 'userns_disabled', 'apparmor_userns_restricted', 'probe_failed_other',
                          'microvm_no_kvm', 'microvm_helper_missing', 'microvm_helper_not_ready', 'microvm_helper_out_of_date') THEN
    RAISE EXCEPTION 'runner_sandbox_status_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Only a live runner of this account has a row (a revoked or foreign one is left alone).
  IF NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = raw::uuid AND r.account_id = acct AND r.revoked_at IS NULL) THEN
    RETURN;
  END IF;
  IF p_reason IS NULL THEN
    DELETE FROM public.runner_sandbox_status WHERE runner_id = raw::uuid AND account_id = acct;
  ELSE
    -- Only a change is written, so a runner that polls every few seconds with the same answer writes nothing.
    INSERT INTO public.runner_sandbox_status AS s (runner_id, account_id, reason) VALUES (raw::uuid, acct, p_reason)
    ON CONFLICT (runner_id) DO UPDATE SET reason = EXCLUDED.reason, updated_at = now() WHERE s.reason IS DISTINCT FROM EXCLUDED.reason;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION runner_sandbox_status_record(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_sandbox_status_record(text) TO app_user;
ALTER FUNCTION runner_sandbox_status_record(text) OWNER TO runner_sandbox_status_definer;
REVOKE CREATE ON SCHEMA public FROM runner_sandbox_status_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_sandbox_status_definer FROM CURRENT_USER;
  END IF;
END
$$;
