-- D#6 C43-6: claim gating on the plan's usage limit. When a runner's job ends with `usage_limit_reached`, the cloud keeps the time before which
-- that runner is to be offered no run (`claim_paused_until`), so a runner that restarts during the pause does not spend claims on it, and the
-- claim route answers idle with a `retry_after` that runs up to that time.
--
--   runner_capacity.claim_paused_until
--                                  a column of the table 0777 made, so the pause is read and written under the same owner, the same row policies
--                                  and the same "only a live runner of this account has a row" rule as the capacity. Null means no pause. The row
--                                  of a runner that has not claimed since 0777 is made by the first pause (`declared` false: no capacity yet).
--   runner_claim_pause_record(p_until)
--                                  sets the pause of the runner named by app.runner_id (which only the signature-verifying runner middleware sets),
--                                  called by the events route right after a batch that ended a run `usage_limit`. A subscription runner only: an api_key runner has no plan window, so nothing is stored.
--                                  A null `p_until` (the event named no reset) means one hour, a time further off than a day is cut to a day (the
--                                  figures the follow-up run uses), and a time already past is ignored. A later call overwrites an earlier one.
--   limited_by 'usage_limit'       a runner that holds back its claims for the limit says so, so a waiting run can say why. The check on the
--                                  column and the argument check of runner_capacity_record gain the value; nothing else of that function changes.
--
-- Only a time is stored. Whether a runner is paused is always worked out from it against the clock, so there is no flag to go stale: the
-- pause ends by itself, and a revoked runner (which cannot claim) ignores it.
--
-- Numbered above the highest migration on the code plane (0778). Re-check against main right before merging and renumber to stay above its highest.
--
-- Who may touch it: the same role as 0777, runner_capacity_definer (NOLOGIN, no members, column-level grants). platform_ops gains nothing.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'runner_capacity_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_capacity_definer; cannot replace or create its functions';
    END IF;
    GRANT runner_capacity_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

ALTER TABLE runner_capacity ADD COLUMN claim_paused_until timestamptz;
-- The claim route reads it as the runner's own tenant; the definer writes it.
GRANT SELECT (claim_paused_until) ON runner_capacity TO runner_capacity_definer, app_user;
GRANT INSERT (claim_paused_until), UPDATE (claim_paused_until) ON runner_capacity TO runner_capacity_definer;
GRANT SELECT (credential_mode) ON runners TO runner_capacity_definer;

ALTER TABLE runner_capacity DROP CONSTRAINT runner_capacity_limited_by_check;
ALTER TABLE runner_capacity ADD CONSTRAINT runner_capacity_limited_by_check
  CHECK (limited_by IS NULL OR (declared AND limited_by IN ('memory', 'cpu', 'disk', 'paused', 'ceiling', 'usage_limit')));

GRANT CREATE ON SCHEMA public TO runner_capacity_definer;

CREATE OR REPLACE FUNCTION runner_capacity_record(p_light_limit integer, p_heavy_limit integer, p_limited_by text)
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
    RAISE EXCEPTION 'runner_capacity_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct)
     OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'runner_capacity_record: the session is not a runner of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Both null (declared nothing) or both inside the ceilings; anything else is a caller's bug.
  IF (p_light_limit IS NULL) <> (p_heavy_limit IS NULL)
     OR p_light_limit NOT BETWEEN 0 AND 8 OR p_heavy_limit NOT BETWEEN 0 AND 4
     OR (p_limited_by IS NOT NULL AND (p_light_limit IS NULL OR p_limited_by NOT IN ('memory', 'cpu', 'disk', 'paused', 'ceiling', 'usage_limit'))) THEN
    RAISE EXCEPTION 'runner_capacity_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Only a live runner of this account has a row (a revoked or foreign one is left alone).
  IF NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = raw::uuid AND r.account_id = acct AND r.revoked_at IS NULL) THEN
    RETURN;
  END IF;
  -- Only a change is written, so a runner that claims every few seconds with the same answer writes nothing. The pause is not part of this row's
  -- claim figures: it is neither read nor changed here.
  INSERT INTO public.runner_capacity AS c (runner_id, account_id, declared, light_limit, heavy_limit, limited_by)
  VALUES (raw::uuid, acct, p_light_limit IS NOT NULL, p_light_limit, p_heavy_limit, p_limited_by)
  ON CONFLICT (runner_id) DO UPDATE
    SET declared = EXCLUDED.declared, light_limit = EXCLUDED.light_limit, heavy_limit = EXCLUDED.heavy_limit, limited_by = EXCLUDED.limited_by, updated_at = now()
    WHERE (c.declared, c.light_limit, c.heavy_limit, c.limited_by) IS DISTINCT FROM (EXCLUDED.declared, EXCLUDED.light_limit, EXCLUDED.heavy_limit, EXCLUDED.limited_by);
END;
$$;

CREATE FUNCTION runner_claim_pause_record(p_until timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct      uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  raw       text := COALESCE(current_setting('app.runner_id', true), '');
  paused_to timestamptz;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_claim_pause_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct)
     OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'runner_claim_pause_record: the session is not a runner of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A live subscription runner of this account only: a revoked one cannot claim, and an api_key one has no plan window.
  IF NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = raw::uuid AND r.account_id = acct AND r.revoked_at IS NULL AND r.credential_mode = 'subscription') THEN
    RETURN;
  END IF;
  paused_to := CASE WHEN p_until IS NULL THEN now() + interval '1 hour' ELSE LEAST(p_until, now() + interval '24 hours') END;
  -- A time that has already passed pauses nothing, and does not clear a pause an earlier report set.
  IF paused_to <= now() THEN
    RETURN;
  END IF;
  INSERT INTO public.runner_capacity AS c (runner_id, account_id, declared, claim_paused_until)
  VALUES (raw::uuid, acct, false, paused_to)
  ON CONFLICT (runner_id) DO UPDATE SET claim_paused_until = EXCLUDED.claim_paused_until, updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION runner_claim_pause_record(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_claim_pause_record(timestamptz) TO app_user;
ALTER FUNCTION runner_claim_pause_record(timestamptz) OWNER TO runner_capacity_definer;
REVOKE CREATE ON SCHEMA public FROM runner_capacity_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_capacity_definer FROM CURRENT_USER;
  END IF;
END
$$;
