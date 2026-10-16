-- D#7 AAP-b1: escalation routes for asks and approvals, as append-only versions.
--
-- 1. ask_routes: one row per change, keyed (account, repo or NULL, subject, decision type or '*'). A row holds the whole route: `levels`
--    (at most 4; each is {target, escalateAfterMinutes}), `hours` (working-hours windows; [] means always working) and `repeat` (0 to 3
--    extra laps). The current route for a key is its highest version. A version whose `levels` is [] is a TOMBSTONE: that key then has no
--    route of its own and the lookup (packages/decisions/src/escalation.ts, resolveAskRoute) falls to the next less specific key, then to
--    the R5 default. A tombstone must carry hours = [] and repeat = 0. Removing a route is therefore a new row, never a DELETE.
-- 2. Same shape as decision_ask_settings (0812): app_user holds SELECT and INSERT and nothing else; the INSERT policy binds changed_by to
--    the session's user and requires owner or admin; a BEFORE INSERT trigger makes version exactly max+1 per key, stamps created_at from
--    the database clock, and checks the shape of every level. A named member target must be an owner or admin of the account when the row
--    is written (owner ruling 4: no new reviewer role); the TypeScript writer checks the same first and names the error. The repo FK is
--    NO ACTION for the reason 0400 gives (a member holding DELETE on repos must not erase route history). The audit row is written by the
--    TypeScript writer in the same transaction (packages/db/src/askRoutes.ts).
-- 3. audit_write is replaced whole from 0812 (newest definition on main), adding only 'ask_route.changed'. CREATE OR REPLACE keeps the
--    owner, the EXECUTE grant and the pinned search path. Another open migration that also replaces audit_write would drop this entry
--    (last file wins), so whoever merges second must re-carry the list.
-- Additive only: no existing object is dropped, renamed or narrowed. A new file; the number is above the highest on the code plane and is
-- re-checked right before merge. Privilege bracket copied from 0812.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE TABLE ask_routes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id        uuid,
  subject        text NOT NULL CONSTRAINT ask_routes_subject_check CHECK (subject IN ('decision', 'action')),
  decision_type  text NOT NULL CONSTRAINT ask_routes_decision_type_check CHECK (decision_type = '*' OR decision_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  levels         jsonb NOT NULL CONSTRAINT ask_routes_levels_check CHECK (jsonb_typeof(levels) = 'array' AND jsonb_array_length(levels) <= 4),
  hours          jsonb NOT NULL DEFAULT '[]'::jsonb CONSTRAINT ask_routes_hours_check CHECK (jsonb_typeof(hours) = 'array' AND jsonb_array_length(hours) <= 14),
  repeat         integer NOT NULL DEFAULT 0 CONSTRAINT ask_routes_repeat_check CHECK (repeat BETWEEN 0 AND 3),
  version        integer NOT NULL CONSTRAINT ask_routes_version_check CHECK (version >= 1),
  changed_by     uuid NOT NULL REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- The tombstone: no levels means no route of its own, so it cannot carry hours or a repeat.
  CONSTRAINT ask_routes_tombstone_check CHECK (
    jsonb_array_length(levels) > 0 OR (jsonb_array_length(hours) = 0 AND repeat = 0)
  ),
  UNIQUE (account_id, repo_id, subject, decision_type, version),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE NO ACTION
);

-- A NULL repo_id is distinct in the UNIQUE above, so the account-wide key needs its own index to keep two writers from taking one version.
CREATE UNIQUE INDEX ask_routes_account_key
  ON ask_routes (account_id, subject, decision_type, version) WHERE repo_id IS NULL;

CREATE FUNCTION ask_routes_before_insert() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  expected_version integer;
  lvl              jsonb;
  tgt              jsonb;
  minutes          numeric;
BEGIN
  SELECT COALESCE(MAX(version), 0) + 1 INTO expected_version
  FROM ask_routes
  WHERE account_id = NEW.account_id
    AND repo_id IS NOT DISTINCT FROM NEW.repo_id
    AND subject = NEW.subject
    AND decision_type = NEW.decision_type;
  IF NEW.version <> expected_version THEN
    RAISE EXCEPTION 'ask_routes.version must be % (the next version for this key), got %', expected_version, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;

  -- created_at is always the database's own clock, whatever an INSERT says.
  NEW.created_at := now();

  -- Triggers run before CHECKs, so a non-array must be refused here before it is iterated.
  IF jsonb_typeof(NEW.levels) <> 'array' THEN
    RAISE EXCEPTION 'ask_routes.levels_invalid' USING ERRCODE = 'check_violation';
  END IF;

  FOR lvl IN SELECT value FROM jsonb_array_elements(NEW.levels) LOOP
    IF jsonb_typeof(lvl) <> 'object'
       OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(lvl) k) IS DISTINCT FROM ARRAY['escalateAfterMinutes', 'target']
       OR jsonb_typeof(lvl -> 'escalateAfterMinutes') <> 'number'
       OR jsonb_typeof(lvl -> 'target') <> 'object' THEN
      RAISE EXCEPTION 'ask_routes.level_invalid' USING ERRCODE = 'check_violation';
    END IF;
    minutes := (lvl -> 'escalateAfterMinutes')::numeric;
    IF minutes <> trunc(minutes) OR minutes < 5 OR minutes > 10080 THEN
      RAISE EXCEPTION 'ask_routes.escalate_after_out_of_range' USING ERRCODE = 'check_violation';
    END IF;
    tgt := lvl -> 'target';
    IF tgt ->> 'type' = 'all_owners_admins' AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(tgt) k) = ARRAY['type'] THEN
      CONTINUE;
    END IF;
    IF tgt ->> 'type' = 'member'
       AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(tgt) k) = ARRAY['memberId', 'type']
       AND jsonb_typeof(tgt -> 'memberId') = 'string'
       AND tgt ->> 'memberId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      IF NOT EXISTS (
        SELECT 1 FROM account_members m
        WHERE m.account_id = NEW.account_id
          AND m.user_id = (tgt ->> 'memberId')::uuid
          AND m.role IN ('owner', 'admin')
      ) THEN
        RAISE EXCEPTION 'ask_routes.target_not_answerer' USING ERRCODE = 'check_violation';
      END IF;
      CONTINUE;
    END IF;
    RAISE EXCEPTION 'ask_routes.target_invalid' USING ERRCODE = 'check_violation';
  END LOOP;
  RETURN NEW;
END;
$$;

-- A trigger function is not called by name, and its EXECUTE privilege is checked only when the trigger is created, so nothing else needs it.
REVOKE ALL ON FUNCTION ask_routes_before_insert() FROM PUBLIC;

CREATE TRIGGER ask_routes_before_insert
  BEFORE INSERT ON ask_routes
  FOR EACH ROW EXECUTE FUNCTION ask_routes_before_insert();

ALTER TABLE ask_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ask_routes FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON ask_routes
  FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

CREATE POLICY owner_or_admin_insert ON ask_routes
  FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND changed_by = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM account_members m
      WHERE m.account_id = ask_routes.account_id
        AND m.user_id = ask_routes.changed_by
        AND m.role IN ('owner', 'admin')
    )
  );

-- Append-only for app_user: no UPDATE and no DELETE grant, so no policy is needed for either verb.
GRANT SELECT, INSERT ON ask_routes TO app_user;

CREATE OR REPLACE FUNCTION audit_write(p_action text, p_payload jsonb DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct            uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  who             uuid := current_member_user_id();
  ts              timestamptz := clock_timestamp();
  stamped_payload jsonb := p_payload;
  new_id          uuid;
BEGIN
  IF acct IS NULL THEN
    RAISE EXCEPTION 'audit_write: no app.account_id set'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF who IS NULL THEN
    RAISE EXCEPTION 'audit_write: caller is not a verified member of account %', acct
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'audit_write: account % is not active', acct
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The 0812 allowlist carried forward whole, plus 'ask_route.changed'. NULL fails
  -- closed explicitly (note (b) above) instead of relying on
  -- `NOT (p_action = ANY(...))` evaluating to NULL (falsy for IF) on a
  -- NULL p_action.
  IF p_action IS NULL OR NOT (p_action = ANY (ARRAY[
    'decision_dial_changed',
    'model_connection.connect',
    'model_connection.replace',
    'model_connection.remove',
    'role_settings.mode_changed',
    'role_settings.guard_changed',
    'role_settings.model_changed',
    'run_limits.changed',
    'decision_ask_setting.changed',
    'ask_route.changed'
  ])) THEN
    RAISE EXCEPTION 'audit_write: action % is not on the allowlist', p_action
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'audit_write: payload must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Note (c) above: bounds a single payload's serialized size, and
  -- (D#97 fix round 1) fails closed on any TOAST-compressed argument
  -- regardless of its compressed size.
  IF p_payload IS NOT NULL AND (
    pg_column_compression(p_payload) IS NOT NULL OR pg_column_size(p_payload) > 65536
  ) THEN
    RAISE EXCEPTION 'audit_write: payload exceeds 65536 bytes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Decision (c)/note (a): a caller-supplied `actor`, `account_id` or
  -- `created_at` key inside the payload is overwritten with the stamped
  -- value, never trusted. Every other key (including nested ones) is
  -- stored exactly as sent.
  IF stamped_payload ? 'actor' THEN
    stamped_payload := stamped_payload || jsonb_build_object('actor', to_jsonb(who::text));
  END IF;
  IF stamped_payload ? 'account_id' THEN
    stamped_payload := stamped_payload || jsonb_build_object('account_id', to_jsonb(acct::text));
  END IF;
  IF stamped_payload ? 'created_at' THEN
    stamped_payload := stamped_payload || jsonb_build_object('created_at', to_jsonb(ts));
  END IF;

  INSERT INTO audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, who::text, p_action, stamped_payload, ts)
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

-- CREATE OR REPLACE preserves the existing owner and grants on an unchanged signature. Re-run because they are idempotent (0651's pattern).
REVOKE ALL ON FUNCTION audit_write(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_write(text, jsonb) TO app_user;

-- Close the window opened above.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
