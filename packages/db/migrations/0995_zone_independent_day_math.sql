-- Day arithmetic that does not depend on the session's time zone.
--
-- `timestamptz + interval 'N days'` counts calendar days in the session's zone, so on a zone with daylight saving a "14 days" or "30 days"
-- is 336 or 720 hours only when no clock change falls in between (one hour more or less when it does). Two places depended on that:
--
--   * decision_asks: a window of the largest size the raise definer allows (20160 minutes, added to now() as minutes, so exactly 336 hours)
--     was refused by the table's own bound when the 14 calendar days after raised_at were one hour shorter (a spring-forward inside
--     the window), and the bound moved by an hour on a fall-back. The bound is now 336 hours, the same size the definer allows, whatever the zone.
--   * the approval-protocol definers (aap_*): the 14 day deadline bound, the 7 day replay record and the 30 day / 7 day housekeeping cut-offs.
--     Inside the repeated hour of a fall-back, a decision made in the first pass was cut off an hour before the second pass counted its 30 days.
--     They now run in UTC, where a day is always 24 hours. Bodies, owners, grants and search_path are unchanged.

ALTER TABLE decision_asks DROP CONSTRAINT decision_asks_check;
ALTER TABLE decision_asks ADD CONSTRAINT decision_asks_check
  CHECK (answer_due_at >= raised_at + interval '15 minutes' AND answer_due_at <= raised_at + interval '336 hours');

-- aap_definer owns the aap_* functions, and a non-superuser migrator must hold the role to ALTER them (0838's bracket); reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'aap_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on aap_definer; cannot ALTER its functions';
    END IF;
    GRANT aap_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

ALTER FUNCTION action_approvals_idempotency_clock() SET timezone = 'UTC';
ALTER FUNCTION aap_sweep_at(timestamptz, integer) SET timezone = 'UTC';
ALTER FUNCTION aap_request_create(text, uuid, text, text, bytea, integer, text, integer, text, jsonb, integer, timestamptz) SET timezone = 'UTC';
ALTER FUNCTION aap_request_create_idempotent(text, uuid, text, text, bytea, integer, text, integer, text, jsonb, integer, timestamptz, text, text) SET timezone = 'UTC';

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE aap_definer FROM CURRENT_USER;
  END IF;
END
$$;
