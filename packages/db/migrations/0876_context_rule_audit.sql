-- D#600 CX-5a2: an audit history for context rules. A rule row is deleted when it is removed (0871), so who set what and when would otherwise be lost.
-- Every save, replacement and removal now leaves ONE audit_log row, written by the definers themselves in the same transaction as the change, so a
-- refusal that rolls the transaction back (the application's pins-over-budget check, a lookup that fails after the write) takes the audit row with it,
-- and no caller can change a rule without leaving a row.
--
-- 1. audit_write is replaced whole from 0867, keeping all fifteen of its actions and adding three: 'context_rule.saved' (a new rule, or the same kind
--    saved again for a path that already had one), 'context_rule.replaced' (the other kind saved over an existing rule: pin to exclude or back) and
--    'context_rule.removed'. CREATE OR REPLACE keeps the owner, the EXECUTE grant and the pinned search path. Another open migration that also replaces
--    audit_write would drop these entries (last file wins); whoever merges second must re-carry the list.
-- 2. context_rules_definer gains EXECUTE on audit_write(text, jsonb), and nothing else. The two functions below are the only code that runs as it.
-- 3. context_rule_save and context_rule_remove are replaced (same signatures, owner, grants and pinned search path). The body of each is 0871's with the
--    audit call added; the privilege, path and lookup checks, their messages and their order are unchanged. Save reads the existing row (locked) before
--    it writes, to know the old kind; remove reads the rule's scope, kind and path before it deletes.
--
-- The row: audit_write stamps the account, the member who made the change (actor) and the time (created_at). The payload is
--    {scope, repo_id, work_item_id, rule_id, path, old_kind, new_kind}
-- with the id of the other scope null, old_kind null for a new rule and new_kind null for a removal. Paths and kinds only: no file content.
-- Append-only and tenant scoped as every audit_log row is (0008): nobody holds UPDATE or DELETE on it, and row security shows an account its own.
--
-- Additive: no table, column or existing action changes; the definers behave as before apart from the extra row. Rolling the code back leaves three
-- allowlist entries nothing calls. Numbered 0876: main holds up to 0874 and #356 holds 0875. Re-check against main right before merging.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

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

  -- The 0867 allowlist carried forward whole, plus the three context rule actions. NULL fails
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
    'ask_route.changed',
    'discovery_setting.changed',
    'build_concurrency.changed',
    'envelope.changed',
    'autostart_envelope.changed',
    'envelope_margin.changed',
    'context_rule.saved',
    'context_rule.replaced',
    'context_rule.removed'
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
-- CREATE OR REPLACE preserves the existing owner and grants on an unchanged signature. Re-run because they are idempotent (0651's pattern).
REVOKE ALL ON FUNCTION audit_write(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_write(text, jsonb) TO app_user;
-- The only other holder: the context rules definer, so its two functions can write the audit row inside their own transaction.
GRANT EXECUTE ON FUNCTION audit_write(text, jsonb) TO context_rules_definer;

-- Close the window opened above.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;

-- Ownership bracket for replacing the two definers (0871's shape): the migration role holds the definer role only for the replacement, and the role has
-- CREATE on public only for that; both are reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'context_rules_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on context_rules_definer; cannot replace its functions';
    END IF;
    GRANT context_rules_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO context_rules_definer;

CREATE OR REPLACE FUNCTION context_rule_save(p_scope text, p_repo uuid, p_item uuid, p_kind text, p_path text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct     uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr      uuid;
  v_role   text;
  v_id     uuid;
  v_old    text;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'context_rule_save: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The caller's own membership row (the policy shows this role no other); the role is re-derived on every call, never taken from the request.
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role IS NULL
     OR (p_scope = 'repo' AND v_role NOT IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'context_rule_save: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_scope IS NULL OR p_scope NOT IN ('repo', 'item') OR p_kind IS NULL OR p_kind NOT IN ('pin', 'exclude')
     OR (p_scope = 'repo' AND (p_repo IS NULL OR p_item IS NOT NULL))
     OR (p_scope = 'item' AND (p_item IS NULL OR p_repo IS NOT NULL)) THEN
    RAISE EXCEPTION 'invalid_message' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_path IS NULL OR p_path = '' OR char_length(p_path) > 512
     OR p_path ~ '[[:cntrl:]]' OR p_path ~ ('[' || chr(133) || chr(8232) || chr(8233) || ']') OR strpos(p_path, chr(92)) > 0
     OR p_path ~ '^/' OR p_path ~ '^~(/|$)' OR p_path ~ '^[A-Za-z]:/'
     OR p_path ~ '(^|/)(\.|\.\.)?(/|$)'
     OR (p_kind = 'pin' AND p_path ~ '[*?]') THEN
    RAISE EXCEPTION 'invalid_path' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_scope = 'repo' THEN
    PERFORM 1 FROM public.repos r WHERE r.id = p_repo AND r.account_id = acct;
  ELSE
    PERFORM 1 FROM public.work_items w WHERE w.id = p_item AND w.account_id = acct;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'context_rule_save: no such repository or item' USING ERRCODE = 'no_data_found';
  END IF;

  -- The rule as it stands, locked, so the audit row names the kind this save replaced. A save that loses a race to insert the same path finds the
  -- winner's row on the second look and takes the update branch.
  FOR i IN 1..2 LOOP
    IF p_scope = 'repo' THEN
      SELECT c.id, c.kind INTO v_id, v_old FROM public.context_rules c
       WHERE c.account_id = acct AND c.scope = 'repo' AND c.repo_id = p_repo AND c.path = p_path FOR UPDATE;
    ELSE
      SELECT c.id, c.kind INTO v_id, v_old FROM public.context_rules c
       WHERE c.account_id = acct AND c.scope = 'item' AND c.work_item_id = p_item AND c.path = p_path FOR UPDATE;
    END IF;
    IF FOUND THEN
      UPDATE public.context_rules c SET kind = p_kind, created_by = usr, created_at = now() WHERE c.id = v_id;
      EXIT;
    END IF;
    v_id := NULL;
    v_old := NULL;
    IF p_scope = 'repo' THEN
      INSERT INTO public.context_rules AS c (account_id, scope, repo_id, kind, path, created_by)
      VALUES (acct, 'repo', p_repo, p_kind, p_path, usr)
      ON CONFLICT (account_id, repo_id, path) WHERE scope = 'repo' DO NOTHING
      RETURNING c.id INTO v_id;
    ELSE
      INSERT INTO public.context_rules AS c (account_id, scope, work_item_id, kind, path, created_by)
      VALUES (acct, 'item', p_item, p_kind, p_path, usr)
      ON CONFLICT (account_id, work_item_id, path) WHERE scope = 'item' DO NOTHING
      RETURNING c.id INTO v_id;
    END IF;
    EXIT WHEN v_id IS NOT NULL;
  END LOOP;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'context_rule_save: could not write the rule' USING ERRCODE = 'serialization_failure';
  END IF;

  PERFORM public.audit_write(
    CASE WHEN v_old IS NOT NULL AND v_old <> p_kind THEN 'context_rule.replaced' ELSE 'context_rule.saved' END,
    jsonb_build_object('scope', p_scope, 'repo_id', p_repo, 'work_item_id', p_item, 'rule_id', v_id, 'path', p_path, 'old_kind', v_old, 'new_kind', p_kind));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION context_rule_remove(p_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct    uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr     uuid;
  v_role  text;
  v_scope text;
  v_kind  text;
  v_path  text;
  v_repo  uuid;
  v_item  uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'context_rule_remove: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'context_rule_remove: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'invalid_message' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT c.scope, c.kind, c.path, c.repo_id, c.work_item_id INTO v_scope, v_kind, v_path, v_repo, v_item
    FROM public.context_rules c WHERE c.id = p_id AND c.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'context_rule_remove: no such rule' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_scope = 'repo' AND v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'context_rule_remove: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM public.context_rules c WHERE c.id = p_id AND c.account_id = acct;
  PERFORM public.audit_write(
    'context_rule.removed',
    jsonb_build_object('scope', v_scope, 'repo_id', v_repo, 'work_item_id', v_item, 'rule_id', p_id, 'path', v_path, 'old_kind', v_kind, 'new_kind', NULL::text));
END;
$$;

-- CREATE OR REPLACE kept the owner; the grants are re-stated because they are idempotent.
REVOKE ALL ON FUNCTION context_rule_save(text, uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION context_rule_remove(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION context_rule_save(text, uuid, uuid, text, text) TO app_user;
GRANT EXECUTE ON FUNCTION context_rule_remove(uuid) TO app_user;

REVOKE CREATE ON SCHEMA public FROM context_rules_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE context_rules_definer FROM CURRENT_USER;
  END IF;
END
$$;
