-- D#7 AAP-a2: the customer's approval rules for tool calls, as append-only versions, and the audit door that records each change.
--
-- 1. action_rules: one row per change to a rule set, keyed (account, repo or NULL). `rules` holds the whole set ({"rules": [...]}, the shape
--    packages/decisions/src/rules.ts validates). The current set for a key is its highest version, so an edit applies to the next request.
--    An empty set is a legal version: it is how "delete all rules" is done (the undo path is a new version, never a DELETE). A rollback is a
--    new version that copies an earlier one and names it in restored_from_version. rule_count and rules_sha256 are checked against the
--    stored rules by the table itself, so no writer can store a count or hash that does not describe the row.
-- 2. Same shape as decision_ask_settings (0812): app_user holds SELECT and INSERT and nothing else; the INSERT policy binds changed_by to the
--    session's user and requires owner or admin; a BEFORE INSERT trigger makes version exactly max+1 per key. The repo FK is NO ACTION for
--    the reason 0400 gives (a member holding DELETE on repos must not be able to erase rule history).
-- 3. audit_write_action_rules(p_action, p_payload): the app_user-callable audit door for this table, on the 0713 model but owned by a NEW
--    role, action_rules_auditor (NOLOGIN, no members, a member of nothing), so platform_ops gains NOTHING (the 0781-style "gives platform_ops
--    nothing" snapshots stay true, which a platform_ops-owned function would break). SECURITY DEFINER, search_path pinned, EXECUTE for
--    app_user only, one allowed action ('action_rules.changed'). The account and actor are stamped from the tenant session, and the caller
--    must be an owner or admin of an active account. The caller's payload is checked against the table before it is written: the new
--    version and hash it names (and the previous ones, when it names any) must be rows of this account and scope, and the new row must be
--    the caller's own, so an owner or admin cannot write an audit row that describes a change that did not happen. The role reads
--    accounts(id, deleted_at), account_members(account_id, user_id, role) and five columns of action_rules through policies bound to the
--    account and user in context, and holds INSERT on five audit_log columns through a policy that lets it insert only its own action name
--    for the account in context (the 0832 shape). audit_write itself is NOT replaced, so this file stays out
--    of the audit_write chain that other open migrations also edit.
-- Additive only: no existing object is dropped, renamed or narrowed. A new file; the number is above the highest on the code plane and is
-- re-checked right before merge.
DO $$
DECLARE
  n text := 'action_rules_auditor';
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

CREATE TABLE action_rules (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id                uuid,
  version                integer NOT NULL CHECK (version >= 1),
  rules                  jsonb NOT NULL,
  rule_count             integer NOT NULL CHECK (rule_count BETWEEN 0 AND 200),
  rules_sha256           text NOT NULL CHECK (rules_sha256 ~ '^[0-9a-f]{64}$'),
  restored_from_version  integer CHECK (restored_from_version >= 1),
  changed_by             uuid NOT NULL REFERENCES users (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, repo_id, version),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE NO ACTION,
  CONSTRAINT action_rules_restored_is_earlier CHECK (restored_from_version IS NULL OR restored_from_version < version),
  CONSTRAINT action_rules_size CHECK (octet_length(rules::text) <= 262144),
  -- IS TRUE, because a CHECK passes on NULL and `rules -> 'rules'` is NULL when the document is not an object holding that key.
  CONSTRAINT action_rules_shape CHECK (
    CASE WHEN jsonb_typeof(rules) = 'object' AND jsonb_typeof(rules -> 'rules') = 'array'
         THEN rule_count = jsonb_array_length(rules -> 'rules') ELSE false END IS TRUE
  ),
  CONSTRAINT action_rules_hash CHECK (rules_sha256 = encode(sha256(convert_to(rules::text, 'UTF8')), 'hex'))
);

-- A NULL repo_id is distinct in the UNIQUE above, so the account-wide scope needs its own index to keep two writers from taking one version.
CREATE UNIQUE INDEX action_rules_account_scope
  ON action_rules (account_id, version) WHERE repo_id IS NULL;

CREATE FUNCTION action_rules_enforce_next_version() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  expected_version integer;
BEGIN
  SELECT COALESCE(MAX(version), 0) + 1 INTO expected_version
  FROM action_rules
  WHERE account_id = NEW.account_id
    AND repo_id IS NOT DISTINCT FROM NEW.repo_id;
  IF NEW.version <> expected_version THEN
    RAISE EXCEPTION 'action_rules.version must be % (the next version for this scope), got %', expected_version, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION action_rules_enforce_next_version() FROM PUBLIC;

CREATE TRIGGER action_rules_enforce_next_version
  BEFORE INSERT ON action_rules
  FOR EACH ROW EXECUTE FUNCTION action_rules_enforce_next_version();

ALTER TABLE action_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_rules FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON action_rules
  FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

CREATE POLICY owner_or_admin_insert ON action_rules
  FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND changed_by = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM account_members m
      WHERE m.account_id = action_rules.account_id
        AND m.user_id = action_rules.changed_by
        AND m.role IN ('owner', 'admin')
    )
  );

-- Append-only for app_user: no UPDATE and no DELETE grant, so no policy is needed for either verb.
GRANT SELECT, INSERT ON action_rules TO app_user;

GRANT USAGE ON SCHEMA public TO action_rules_auditor;
GRANT SELECT (id, deleted_at) ON accounts TO action_rules_auditor;
GRANT SELECT (account_id, user_id, role) ON account_members TO action_rules_auditor;
GRANT SELECT (account_id, repo_id, version, rules_sha256, changed_by) ON action_rules TO action_rules_auditor;
CREATE POLICY action_rules_auditor_select ON action_rules FOR SELECT TO action_rules_auditor
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO action_rules_auditor;
CREATE POLICY action_rules_auditor_audit ON audit_log FOR INSERT TO action_rules_auditor
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND action = 'action_rules.changed');
CREATE POLICY action_rules_auditor_select ON accounts FOR SELECT TO action_rules_auditor
  USING (id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY action_rules_auditor_definer_select ON account_members FOR SELECT TO action_rules_auditor
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

CREATE FUNCTION audit_write_action_rules(p_action text, p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct            uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  who             uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_role          text;
  v_repo          uuid;
  v_new_version   integer;
  ts              timestamptz := clock_timestamp();
  stamped_payload jsonb := p_payload;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'audit_write_action_rules: platform_ops may not call this directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- A member session of an active account: the policies show this role only the caller's own membership row and the account in context.
  IF acct IS NULL OR who IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = acct AND a.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'audit_write_action_rules: caller is not a verified member of an active account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT m.role INTO v_role FROM public.account_members m WHERE m.account_id = acct AND m.user_id = who;
  IF COALESCE(v_role, '') NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'audit_write_action_rules: caller is not an owner or admin of the account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_action IS NULL OR p_action NOT IN ('action_rules.changed') THEN
    RAISE EXCEPTION 'audit_write_action_rules: action is not allowed'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'audit_write_action_rules: payload must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payload IS NOT NULL AND (
    pg_column_compression(p_payload) IS NOT NULL OR pg_column_size(p_payload) > 65536
  ) THEN
    RAISE EXCEPTION 'audit_write_action_rules: payload exceeds 65536 bytes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The payload must describe a row that exists: this account, this scope, the version and hash it names, written by the caller.
  IF p_payload IS NULL
     OR jsonb_typeof(p_payload -> 'new_version') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_payload -> 'new_rules_sha256') IS DISTINCT FROM 'string'
     OR COALESCE(jsonb_typeof(p_payload -> 'repo_id'), 'null') NOT IN ('null', 'string') THEN
    RAISE EXCEPTION 'audit_write_action_rules: payload must name new_version, new_rules_sha256 and repo_id'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_repo := CASE WHEN jsonb_typeof(p_payload -> 'repo_id') = 'string' THEN (p_payload ->> 'repo_id')::uuid END;
  v_new_version := (p_payload ->> 'new_version')::integer;
  IF NOT EXISTS (
    SELECT 1 FROM public.action_rules r
     WHERE r.account_id = acct AND r.repo_id IS NOT DISTINCT FROM v_repo AND r.version = v_new_version
       AND r.rules_sha256 = p_payload ->> 'new_rules_sha256' AND r.changed_by = who
  ) THEN
    RAISE EXCEPTION 'audit_write_action_rules: payload does not match a rule version written by the caller'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_typeof(p_payload -> 'previous_version') = 'number' AND NOT EXISTS (
    SELECT 1 FROM public.action_rules r
     WHERE r.account_id = acct AND r.repo_id IS NOT DISTINCT FROM v_repo AND r.version = (p_payload ->> 'previous_version')::integer
       AND r.rules_sha256 IS NOT DISTINCT FROM (p_payload ->> 'previous_rules_sha256')
  ) THEN
    RAISE EXCEPTION 'audit_write_action_rules: payload does not match the previous rule version'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF stamped_payload ? 'actor' THEN
    stamped_payload := stamped_payload || jsonb_build_object('actor', to_jsonb(who::text));
  END IF;
  IF stamped_payload ? 'account_id' THEN
    stamped_payload := stamped_payload || jsonb_build_object('account_id', to_jsonb(acct::text));
  END IF;
  IF stamped_payload ? 'created_at' THEN
    stamped_payload := stamped_payload || jsonb_build_object('created_at', to_jsonb(ts));
  END IF;

  -- No RETURNING and no id back: this role holds INSERT but no SELECT on audit_log.
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, who::text, p_action, stamped_payload, ts);
END;
$$;

-- Ownership bracket (0828's shape, as 0832 copies it).
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'action_rules_auditor'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on action_rules_auditor; cannot ALTER FUNCTION ... OWNER TO action_rules_auditor';
    END IF;
    GRANT action_rules_auditor TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO action_rules_auditor;

REVOKE ALL ON FUNCTION audit_write_action_rules(text, jsonb) FROM PUBLIC;
ALTER FUNCTION audit_write_action_rules(text, jsonb) OWNER TO action_rules_auditor;
-- EXECUTE is granted after the transfer: changing an owner rewrites the ACL entries that named the old one.
GRANT EXECUTE ON FUNCTION audit_write_action_rules(text, jsonb) TO app_user;

REVOKE CREATE ON SCHEMA public FROM action_rules_auditor;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE action_rules_auditor FROM CURRENT_USER;
  END IF;
END
$$;
