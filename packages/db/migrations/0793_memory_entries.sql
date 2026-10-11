-- D#601 MEM-1: the memory store. One durable, reviewable memory that every run reads the same way whatever the model provider. This
-- file is the data model and the only way to write it; the proposal intake, the retriever and slot renderer, the review screens, the
-- sweeps and the import come in later changes.
--
--   memory_entries           one row per VERSION of an entry. A body is written once and never updated. An edit inserts the next
--                            version (version + 1, supersedes_id naming the old row) and the old row becomes `superseded`, so the
--                            prior text stays readable. Status and its stamps move along a fixed set of steps (below).
--   memory_propose           any active member (or the pipeline's userless tenant session, for an agent, assistant, import or runner
--                            body) records an entry as `proposed`, expiring in 14 days. A proposal is never recalled.
--   memory_write             an owner or admin (an item member for item scope) writes a person-typed entry straight to `approved`.
--   memory_decide            approve, reject, retire, and the undo steps back (see the step table).
--   memory_edit              inserts a new version; may also change the kind or the scope ("Change scope").
--   memory_delete            soft delete, with a restore inside 30 days.
--   memory_session, memory_validate, memory_assert_room
--                            internal helpers (SECURITY INVOKER, owner-only EXECUTE): the caller's rights, the input checks, the cap.
--
-- Legal steps (decide):  proposed -> approved | rejected    approved -> retired | proposed (undo)    rejected -> proposed (reconsider)
--                        retired -> approved (restore)      expired -> proposed (restore; a new 14-day expiry)
-- `expired` and `archived` are set by sweeps and the repo-change path in later changes; `superseded` and `deleted` are set here by
-- edit and delete. `superseded` is final.
--
-- Trust follows who wrote the bytes, never approval. author_kind is fixed at proposal time and an edit never changes it, so an entry an
-- agent proposed and a person later edited is still an agent-origin body. The retriever (MEM-3) renders only person-typed text outside
-- the fence. A session cannot name author_kind 'system' (the enum refuses it), and a userless session cannot claim 'person'.
-- Account entries are person-written only. Role entries are NOT restricted here: whether agents may propose role lessons is the owner's
-- ruling R-601-2, and intake (MEM-2) switches it on or off without a new migration.
--
-- Who may do what, re-derived inside each function from the session (app.account_id, app.user_id) and account_members:
--   * propose: any active member. A session with no user is accepted only for an agent, assistant, import or runner_agent body.
--   * write, decide, edit, delete: an owner or admin for account, repo and role scope; any active member for item scope (item members
--     are the account's members). A member may also edit their own `proposed` entry.
--   A member calling decide on a repo entry gets insufficient_privilege and no row changes. Another account's entry is no_data_found.
--
-- Input checks raise invalid_parameter_value (22023) with a message that starts `invalid_message:`, which the core layer maps to the
-- `invalid_message` code. The same limits are CHECKs on the table, so a direct insert is refused too (23514).
--
-- Audit. Every change writes its audit_log row in the same transaction. The action is memory.<proposed|written|approved|rejected|
-- retired|reverted|edited|deleted|restored>; the payload has fixed keys only (entry_id, scope, kind, author_kind, from_status,
-- to_status, version). The entry's text is never copied into audit_log. The audit rows are the permanent history.
--
-- Who may touch the table: platform_ops holds NOTHING on it and gains nothing anywhere. The functions and the rows belong to a role of
-- their own, memory_definer, in the shape of 0780's work_item_correction_definer: NOLOGIN, no members (the migration role holds it only
-- inside this file), column-level grants for exactly what the bodies read and write, row policies for this role only, a pinned
-- search_path, EXECUTE for app_user alone on the five entry points, and a refusal when the login itself is platform_ops. app_user can
-- only READ the table (tenant row policy); the functions are the only way to write an entry.
--
-- Numbered above the highest migration on the code plane (0783). Re-check against main right before merging.
DO $$
DECLARE
  n text := 'memory_definer';
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

CREATE TABLE memory_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- account: NULL. repo: '<GitHub repo node id>@<installation id>'. item: the work item id. role: the role name.
  scope            text NOT NULL,
  scope_ref        text,
  kind             text NOT NULL,
  body             text NOT NULL,
  why              text,
  author_kind      text NOT NULL,
  provenance       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL DEFAULT 'proposed',
  prior_status     text,
  created_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  approved_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  approved_at      timestamptz,
  expires_at       timestamptz,
  last_recalled_at timestamptz,
  deleted_at       timestamptz,
  version          integer NOT NULL DEFAULT 1,
  supersedes_id    uuid,
  content_sha256   text NOT NULL,
  -- Postgres full text for the retriever (MEM-3). No embeddings: they need a paid key (the 10-02 spend ruling).
  body_tsv         tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, body || ' ' || coalesce(why, ''))) STORED,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, supersedes_id) REFERENCES memory_entries (account_id, id) ON DELETE SET NULL (supersedes_id),
  CONSTRAINT memory_entries_scope_check CHECK (scope IN ('account', 'repo', 'item', 'role')),
  CONSTRAINT memory_entries_scope_ref_check CHECK (
    CASE scope
      WHEN 'account' THEN scope_ref IS NULL
      WHEN 'repo' THEN coalesce(scope_ref ~ '^[A-Za-z0-9_=-]{4,100}@[0-9]{1,20}$', false)
      WHEN 'item' THEN coalesce(scope_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
      WHEN 'role' THEN coalesce(scope_ref ~ '^[a-z][a-z0-9_-]{0,63}$', false)
    END
  ),
  CONSTRAINT memory_entries_kind_check CHECK (kind IN ('convention', 'command', 'fact', 'gotcha', 'preference', 'decision')),
  CONSTRAINT memory_entries_author_kind_check CHECK (author_kind IN ('person', 'agent', 'assistant', 'import', 'runner_agent')),
  CONSTRAINT memory_entries_status_check CHECK (status IN ('proposed', 'approved', 'rejected', 'expired', 'retired', 'deleted', 'archived', 'superseded')),
  CONSTRAINT memory_entries_prior_status_check CHECK (prior_status IS NULL OR prior_status IN ('proposed', 'approved', 'rejected', 'expired', 'retired', 'archived')),
  -- Bytes, not characters. Plain text: no control characters (a tab and a newline are fine), and neither fence delimiter.
  CONSTRAINT memory_entries_body_check CHECK (
    octet_length(body) BETWEEN 1 AND 1024 AND btrim(body) <> '' AND body !~ '[\x01-\x08\x0b-\x1f\x7f]'
    AND position('<<UNTRUSTED EXTERNAL CONTENT>>' IN body) = 0 AND position('<<END UNTRUSTED>>' IN body) = 0
  ),
  CONSTRAINT memory_entries_why_check CHECK (
    why IS NULL OR (octet_length(why) <= 256 AND why !~ '[\x01-\x08\x0b-\x1f\x7f]'
    AND position('<<UNTRUSTED EXTERNAL CONTENT>>' IN why) = 0 AND position('<<END UNTRUSTED>>' IN why) = 0)
  ),
  -- Fixed keys only; every one is a place to record where the bytes came from, never the bytes.
  CONSTRAINT memory_entries_provenance_check CHECK (
    jsonb_typeof(provenance) = 'object' AND length(provenance::text) <= 4096
    AND provenance - ARRAY['source_run_id', 'backend', 'model_id', 'input_trust_classes', 'source_commit', 'file_sha', 'source_path', 'receipt_id', 'evidence'] = '{}'::jsonb
  ),
  CONSTRAINT memory_entries_version_check CHECK (version >= 1 AND (version = 1) = (supersedes_id IS NULL)),
  CONSTRAINT memory_entries_hash_check CHECK (content_sha256 = encode(sha256(convert_to(body, 'UTF8')), 'hex')),
  CONSTRAINT memory_entries_deleted_shape CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);
-- An entry has at most one successor, so two concurrent edits cannot both win.
CREATE UNIQUE INDEX memory_entries_successor_idx ON memory_entries (account_id, supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX memory_entries_scope_idx ON memory_entries (account_id, scope, scope_ref, status);
CREATE INDEX memory_entries_tsv_idx ON memory_entries USING gin (body_tsv);

ALTER TABLE memory_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_entries FORCE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA public TO memory_definer;
GRANT SELECT (id, account_id, scope, scope_ref, kind, body, why, author_kind, provenance, status, prior_status, created_by, approved_by, approved_at, expires_at, deleted_at, version, supersedes_id),
      INSERT (id, account_id, scope, scope_ref, kind, body, why, author_kind, provenance, status, created_by, approved_by, approved_at, expires_at, version, supersedes_id, content_sha256),
      UPDATE (status, prior_status, approved_by, approved_at, expires_at, deleted_at, updated_at) ON memory_entries TO memory_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO memory_definer;
GRANT SELECT (id, deleted_at) ON accounts TO memory_definer;
GRANT SELECT (id, account_id) ON work_items TO memory_definer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO memory_definer;

-- Read only, for the tenant (any member). No write for anyone but the functions.
GRANT SELECT (id, account_id, scope, scope_ref, kind, body, why, author_kind, provenance, status, prior_status, created_by, approved_by, approved_at,
              expires_at, last_recalled_at, deleted_at, version, supersedes_id, content_sha256, body_tsv, created_at, updated_at)
  ON memory_entries TO app_user;

CREATE POLICY tenant_isolation_select ON memory_entries FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY memory_definer_select ON memory_entries FOR SELECT TO memory_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY memory_definer_insert ON memory_entries FOR INSERT TO memory_definer
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND status IN ('proposed', 'approved')
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY memory_definer_update ON memory_entries FOR UPDATE TO memory_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
-- Shows this role only the caller's own membership row, as 0757, 0759, 0770 and 0780 do.
CREATE POLICY memory_definer_select ON account_members FOR SELECT TO memory_definer
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
CREATE POLICY memory_definer_select ON accounts FOR SELECT TO memory_definer USING (true);
CREATE POLICY memory_definer_select ON work_items FOR SELECT TO memory_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY memory_definer_audit ON audit_log FOR INSERT TO memory_definer
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND action IN ('memory.proposed', 'memory.written', 'memory.approved', 'memory.rejected', 'memory.retired', 'memory.reverted',
                   'memory.edited', 'memory.deleted', 'memory.restored')
  );

-- Ownership bracket (0763's shape): a non-superuser migrator needs SET on the role for ALTER ... OWNER TO, and the role has CREATE on
-- public only for that transfer. Both are reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'memory_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on memory_definer; cannot ALTER FUNCTION ... OWNER TO memory_definer';
    END IF;
    GRANT memory_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO memory_definer;

-- ---- helpers (SECURITY INVOKER: they run as the calling definer; nobody else may execute them) ------------------------
-- The caller's account, user and role. A platform_ops login, a missing or inactive account, and (unless a userless driver session is
-- allowed) a non-member are refused.
CREATE FUNCTION memory_session(p_fn text, p_allow_driver boolean)
RETURNS TABLE (acct uuid, usr uuid, member_role text)
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  a uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  u uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  r text;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION '%: refused for a platform_ops login', p_fn USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF a IS NULL OR NOT account_is_active(a) THEN
    RAISE EXCEPTION '%: no active account in the session', p_fn USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF u IS NULL AND p_allow_driver THEN
    RETURN QUERY SELECT a, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  SELECT m.role INTO r FROM public.account_members m WHERE m.account_id = a AND m.user_id = u;
  IF u IS NULL OR r IS NULL THEN
    RAISE EXCEPTION '%: caller is not a member of an active account', p_fn USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT a, u, r;
END;
$$;

-- The input floor shared by propose, write and edit. Every refusal starts `invalid_message:`.
CREATE FUNCTION memory_validate(p_scope text, p_ref text, p_kind text, p_body text, p_why text, p_author text, p_prov jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  ref_bad boolean;
BEGIN
  IF p_scope IS NULL OR p_scope NOT IN ('account', 'repo', 'item', 'role') THEN
    RAISE EXCEPTION 'invalid_message: unknown scope' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  ref_bad := CASE p_scope
       WHEN 'account' THEN p_ref IS NOT NULL
       WHEN 'repo' THEN p_ref IS NULL OR p_ref !~ '^[A-Za-z0-9_=-]{4,100}@[0-9]{1,20}$'
       WHEN 'item' THEN p_ref IS NULL OR p_ref !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       ELSE p_ref IS NULL OR p_ref !~ '^[a-z][a-z0-9_-]{0,63}$'
     END;
  IF ref_bad THEN
    RAISE EXCEPTION 'invalid_message: scope_ref does not fit the scope' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('convention', 'command', 'fact', 'gotcha', 'preference', 'decision') THEN
    RAISE EXCEPTION 'invalid_message: unknown kind' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_author IS NULL OR p_author NOT IN ('person', 'agent', 'assistant', 'import', 'runner_agent') THEN
    RAISE EXCEPTION 'invalid_message: unknown author_kind' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_scope = 'account' AND p_author <> 'person' THEN
    RAISE EXCEPTION 'invalid_message: account entries are written by a person' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_body IS NULL OR octet_length(p_body) NOT BETWEEN 1 AND 1024 OR btrim(p_body) = '' THEN
    RAISE EXCEPTION 'invalid_message: body must be 1 to 1024 bytes' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_why IS NOT NULL AND octet_length(p_why) > 256 THEN
    RAISE EXCEPTION 'invalid_message: why must be at most 256 bytes' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_body ~ '[\x01-\x08\x0b-\x1f\x7f]' OR COALESCE(p_why, '') ~ '[\x01-\x08\x0b-\x1f\x7f]'
     OR position('<<UNTRUSTED EXTERNAL CONTENT>>' IN p_body || COALESCE(p_why, '')) > 0
     OR position('<<END UNTRUSTED>>' IN p_body || COALESCE(p_why, '')) > 0 THEN
    RAISE EXCEPTION 'invalid_message: body or why holds control characters or a fence delimiter' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_prov IS NULL OR jsonb_typeof(p_prov) <> 'object' OR length(p_prov::text) > 4096
     OR p_prov - ARRAY['source_run_id', 'backend', 'model_id', 'input_trust_classes', 'source_commit', 'file_sha', 'source_path', 'receipt_id', 'evidence'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid_message: provenance holds an unknown key or is too large' USING ERRCODE = 'invalid_parameter_value';
  END IF;
END;
$$;

-- The active cap of a scope (repo 200, account 100, role 50, item 30). Called when an entry is about to become approved. Each approval
-- locks only its own row, so two approvals could both count 49 and both write; a transaction-scoped advisory lock keyed on account,
-- scope and scope_ref makes them take turns, and the second one's count (a fresh statement snapshot) sees the first. Every path that can
-- raise the approved count (write, decide, edit that moves scope, restore) calls this before it writes, and the lock is held to commit.
CREATE FUNCTION memory_assert_room(p_acct uuid, p_scope text, p_ref text, p_except uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  cap integer := CASE p_scope WHEN 'repo' THEN 200 WHEN 'account' THEN 100 WHEN 'role' THEN 50 ELSE 30 END;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('memory_cap:' || p_acct::text || ':' || p_scope || ':' || COALESCE(p_ref, ''), 0));
  IF (SELECT count(*) FROM public.memory_entries e
       WHERE e.account_id = p_acct AND e.scope = p_scope AND e.scope_ref IS NOT DISTINCT FROM p_ref AND e.status = 'approved'
         AND e.id IS DISTINCT FROM p_except) >= cap THEN
    RAISE EXCEPTION 'memory_full: % scope already holds % approved entries', p_scope, cap USING ERRCODE = 'program_limit_exceeded';
  END IF;
END;
$$;

-- ---- propose --------------------------------------------------------------------------------------------------------
CREATE FUNCTION memory_propose(p_scope text, p_scope_ref text, p_kind text, p_body text, p_why text, p_author_kind text, p_provenance jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s      record;
  new_id uuid := gen_random_uuid();
  ts     timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO s FROM public.memory_session('memory_propose', true);
  PERFORM public.memory_validate(p_scope, p_scope_ref, p_kind, p_body, p_why, p_author_kind, COALESCE(p_provenance, '{}'::jsonb));
  IF s.usr IS NULL AND p_author_kind = 'person' THEN
    RAISE EXCEPTION 'memory_propose: a session with no user cannot write as a person' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_scope = 'item' AND NOT EXISTS (SELECT 1 FROM public.work_items w WHERE w.id = p_scope_ref::uuid AND w.account_id = s.acct) THEN
    RAISE EXCEPTION 'memory_propose: no such work item' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO public.memory_entries (id, account_id, scope, scope_ref, kind, body, why, author_kind, provenance, status, created_by, expires_at, version, content_sha256)
  VALUES (new_id, s.acct, p_scope, p_scope_ref, p_kind, p_body, p_why, p_author_kind, COALESCE(p_provenance, '{}'::jsonb), 'proposed', s.usr,
          ts + interval '14 days', 1, encode(sha256(convert_to(p_body, 'UTF8')), 'hex'));
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (s.acct, COALESCE(s.usr::text, 'system:pipeline'), 'memory.proposed',
          jsonb_build_object('entry_id', new_id, 'scope', p_scope, 'kind', p_kind, 'author_kind', p_author_kind, 'from_status', NULL, 'to_status', 'proposed', 'version', 1), ts);
  RETURN new_id;
END;
$$;

-- ---- write (a person's entry, straight to approved) --------------------------------------------------------------------
CREATE FUNCTION memory_write(p_scope text, p_scope_ref text, p_kind text, p_body text, p_why text, p_provenance jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s      record;
  new_id uuid := gen_random_uuid();
  ts     timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO s FROM public.memory_session('memory_write', false);
  PERFORM public.memory_validate(p_scope, p_scope_ref, p_kind, p_body, p_why, 'person', COALESCE(p_provenance, '{}'::jsonb));
  IF p_scope <> 'item' AND s.member_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'memory_write: only an owner or admin writes % entries', p_scope USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_scope = 'item' AND NOT EXISTS (SELECT 1 FROM public.work_items w WHERE w.id = p_scope_ref::uuid AND w.account_id = s.acct) THEN
    RAISE EXCEPTION 'memory_write: no such work item' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM public.memory_assert_room(s.acct, p_scope, p_scope_ref, NULL);
  INSERT INTO public.memory_entries (id, account_id, scope, scope_ref, kind, body, why, author_kind, provenance, status, created_by, approved_by, approved_at, version, content_sha256)
  VALUES (new_id, s.acct, p_scope, p_scope_ref, p_kind, p_body, p_why, 'person', COALESCE(p_provenance, '{}'::jsonb), 'approved', s.usr, s.usr, ts, 1,
          encode(sha256(convert_to(p_body, 'UTF8')), 'hex'));
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (s.acct, s.usr::text, 'memory.written',
          jsonb_build_object('entry_id', new_id, 'scope', p_scope, 'kind', p_kind, 'author_kind', 'person', 'from_status', NULL, 'to_status', 'approved', 'version', 1), ts);
  RETURN new_id;
END;
$$;

-- ---- decide -----------------------------------------------------------------------------------------------------------
CREATE FUNCTION memory_decide(p_id uuid, p_to_status text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s    record;
  cur  record;
  ts   timestamptz := clock_timestamp();
  verb text;
BEGIN
  SELECT * INTO s FROM public.memory_session('memory_decide', false);
  IF p_id IS NULL OR p_to_status IS NULL OR p_to_status NOT IN ('approved', 'rejected', 'retired', 'proposed') THEN
    RAISE EXCEPTION 'invalid_message: status is not one a person can set' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The row lock makes two concurrent decisions take turns: the second reads the first's result.
  SELECT e.id, e.scope, e.scope_ref, e.kind, e.author_kind, e.status, e.version INTO cur
    FROM public.memory_entries e WHERE e.id = p_id AND e.account_id = s.acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'memory_decide: no such entry' USING ERRCODE = 'no_data_found';
  END IF;
  IF cur.scope <> 'item' AND s.member_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'memory_decide: only an owner or admin decides % entries', cur.scope USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF cur.status = p_to_status THEN
    RETURN 'already_decided';
  END IF;
  IF NOT (
       (cur.status = 'proposed' AND p_to_status IN ('approved', 'rejected'))
    OR (cur.status = 'approved' AND p_to_status IN ('retired', 'proposed'))
    OR (cur.status = 'rejected' AND p_to_status = 'proposed')
    OR (cur.status = 'retired' AND p_to_status = 'approved')
    OR (cur.status = 'expired' AND p_to_status = 'proposed')
  ) THEN
    RAISE EXCEPTION 'invalid_transition: % to % is not a legal step', cur.status, p_to_status USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_to_status = 'approved' THEN
    PERFORM public.memory_assert_room(s.acct, cur.scope, cur.scope_ref, cur.id);
    UPDATE public.memory_entries SET status = 'approved', approved_by = s.usr, approved_at = ts, expires_at = NULL, updated_at = ts
     WHERE id = cur.id AND account_id = s.acct;
    verb := CASE WHEN cur.status = 'retired' THEN 'restored' ELSE 'approved' END;
  ELSIF p_to_status = 'proposed' THEN
    UPDATE public.memory_entries SET status = 'proposed', approved_by = NULL, approved_at = NULL, expires_at = ts + interval '14 days', updated_at = ts
     WHERE id = cur.id AND account_id = s.acct;
    verb := 'reverted';
  ELSE
    UPDATE public.memory_entries SET status = p_to_status, expires_at = NULL, updated_at = ts WHERE id = cur.id AND account_id = s.acct;
    verb := p_to_status;
  END IF;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (s.acct, s.usr::text, 'memory.' || verb,
          jsonb_build_object('entry_id', cur.id, 'scope', cur.scope, 'kind', cur.kind, 'author_kind', cur.author_kind, 'from_status', cur.status,
                             'to_status', p_to_status, 'version', cur.version), ts);
  RETURN 'decided';
END;
$$;

-- ---- edit (a new version; optionally a new kind or scope) -----------------------------------------------------------------
CREATE FUNCTION memory_edit(p_id uuid, p_body text, p_why text, p_kind text DEFAULT NULL, p_scope text DEFAULT NULL, p_scope_ref text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s       record;
  cur     record;
  new_id  uuid := gen_random_uuid();
  ts      timestamptz := clock_timestamp();
  n_scope text;
  n_ref   text;
  n_kind  text;
  moved   boolean;
BEGIN
  SELECT * INTO s FROM public.memory_session('memory_edit', false);
  SELECT e.id, e.scope, e.scope_ref, e.kind, e.author_kind, e.provenance, e.status, e.version, e.created_by, e.expires_at INTO cur
    FROM public.memory_entries e WHERE e.id = p_id AND e.account_id = s.acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'memory_edit: no such entry' USING ERRCODE = 'no_data_found';
  END IF;
  n_scope := COALESCE(p_scope, cur.scope);
  -- Naming a new scope names its ref too (account takes none); otherwise the ref stays.
  n_ref := CASE WHEN p_scope IS NULL THEN cur.scope_ref ELSE p_scope_ref END;
  n_kind := COALESCE(p_kind, cur.kind);
  moved := n_scope <> cur.scope OR n_ref IS DISTINCT FROM cur.scope_ref;
  IF NOT (
       (cur.scope = 'item' OR s.member_role IN ('owner', 'admin') OR (cur.status = 'proposed' AND cur.created_by = s.usr))
       AND (n_scope = 'item' OR s.member_role IN ('owner', 'admin') OR (NOT moved AND cur.status = 'proposed' AND cur.created_by = s.usr))
  ) THEN
    RAISE EXCEPTION 'memory_edit: not allowed to edit this entry here' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF cur.status NOT IN ('proposed', 'approved') THEN
    RAISE EXCEPTION 'invalid_transition: only a proposed or approved entry can be edited' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- author_kind is carried over unchanged: an edit never moves agent-origin bytes out of the fence.
  PERFORM public.memory_validate(n_scope, n_ref, n_kind, p_body, p_why, cur.author_kind, cur.provenance);
  IF n_scope = 'item' AND moved AND NOT EXISTS (SELECT 1 FROM public.work_items w WHERE w.id = n_ref::uuid AND w.account_id = s.acct) THEN
    RAISE EXCEPTION 'memory_edit: no such work item' USING ERRCODE = 'no_data_found';
  END IF;
  IF cur.status = 'approved' AND moved THEN
    PERFORM public.memory_assert_room(s.acct, n_scope, n_ref, cur.id);
  END IF;
  UPDATE public.memory_entries SET status = 'superseded', updated_at = ts WHERE id = cur.id AND account_id = s.acct;
  INSERT INTO public.memory_entries (id, account_id, scope, scope_ref, kind, body, why, author_kind, provenance, status, created_by, approved_by, approved_at, expires_at, version, supersedes_id, content_sha256)
  VALUES (new_id, s.acct, n_scope, n_ref, n_kind, p_body, p_why, cur.author_kind, cur.provenance, cur.status, s.usr,
          CASE WHEN cur.status = 'approved' THEN s.usr END, CASE WHEN cur.status = 'approved' THEN ts END, cur.expires_at,
          cur.version + 1, cur.id, encode(sha256(convert_to(p_body, 'UTF8')), 'hex'));
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (s.acct, s.usr::text, 'memory.edited',
          jsonb_build_object('entry_id', new_id, 'scope', n_scope, 'kind', n_kind, 'author_kind', cur.author_kind, 'from_status', cur.status,
                             'to_status', cur.status, 'version', cur.version + 1), ts);
  RETURN new_id;
END;
$$;

-- ---- delete, and restore inside 30 days ----------------------------------------------------------------------------------
CREATE FUNCTION memory_delete(p_id uuid, p_restore boolean DEFAULT false)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s   record;
  cur record;
  ts  timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO s FROM public.memory_session('memory_delete', false);
  SELECT e.id, e.scope, e.scope_ref, e.kind, e.author_kind, e.status, e.prior_status, e.deleted_at, e.version INTO cur
    FROM public.memory_entries e WHERE e.id = p_id AND e.account_id = s.acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'memory_delete: no such entry' USING ERRCODE = 'no_data_found';
  END IF;
  IF cur.scope <> 'item' AND s.member_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'memory_delete: only an owner or admin deletes % entries', cur.scope USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF COALESCE(p_restore, false) THEN
    IF cur.status <> 'deleted' THEN
      RETURN 'not_deleted';
    END IF;
    IF cur.deleted_at <= ts - interval '30 days' THEN
      RAISE EXCEPTION 'invalid_transition: the 30 days to restore it have passed' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF cur.prior_status = 'approved' THEN
      PERFORM public.memory_assert_room(s.acct, cur.scope, cur.scope_ref, cur.id);
    END IF;
    UPDATE public.memory_entries SET status = cur.prior_status, prior_status = NULL, deleted_at = NULL, updated_at = ts
     WHERE id = cur.id AND account_id = s.acct;
    INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
    VALUES (s.acct, s.usr::text, 'memory.restored',
            jsonb_build_object('entry_id', cur.id, 'scope', cur.scope, 'kind', cur.kind, 'author_kind', cur.author_kind, 'from_status', 'deleted',
                               'to_status', cur.prior_status, 'version', cur.version), ts);
    RETURN 'restored';
  END IF;
  IF cur.status = 'deleted' THEN
    RETURN 'already_deleted';
  END IF;
  -- A superseded version is history, not an entry: it stays.
  IF cur.status = 'superseded' THEN
    RAISE EXCEPTION 'invalid_transition: a superseded version cannot be deleted' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.memory_entries SET status = 'deleted', prior_status = cur.status, deleted_at = ts, updated_at = ts
   WHERE id = cur.id AND account_id = s.acct;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (s.acct, s.usr::text, 'memory.deleted',
          jsonb_build_object('entry_id', cur.id, 'scope', cur.scope, 'kind', cur.kind, 'author_kind', cur.author_kind, 'from_status', cur.status,
                             'to_status', 'deleted', 'version', cur.version), ts);
  RETURN 'deleted';
END;
$$;

REVOKE ALL ON FUNCTION memory_session(text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION memory_validate(text, text, text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION memory_assert_room(uuid, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION memory_propose(text, text, text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION memory_write(text, text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION memory_decide(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION memory_edit(uuid, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION memory_delete(uuid, boolean) FROM PUBLIC;
ALTER FUNCTION memory_session(text, boolean) OWNER TO memory_definer;
ALTER FUNCTION memory_validate(text, text, text, text, text, text, jsonb) OWNER TO memory_definer;
ALTER FUNCTION memory_assert_room(uuid, text, text, uuid) OWNER TO memory_definer;
ALTER FUNCTION memory_propose(text, text, text, text, text, text, jsonb) OWNER TO memory_definer;
ALTER FUNCTION memory_write(text, text, text, text, text, jsonb) OWNER TO memory_definer;
ALTER FUNCTION memory_decide(uuid, text) OWNER TO memory_definer;
ALTER FUNCTION memory_edit(uuid, text, text, text, text, text) OWNER TO memory_definer;
ALTER FUNCTION memory_delete(uuid, boolean) OWNER TO memory_definer;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner), to app_user alone, on the entry points only.
GRANT EXECUTE ON FUNCTION memory_propose(text, text, text, text, text, text, jsonb) TO app_user;
GRANT EXECUTE ON FUNCTION memory_write(text, text, text, text, text, jsonb) TO app_user;
GRANT EXECUTE ON FUNCTION memory_decide(uuid, text) TO app_user;
GRANT EXECUTE ON FUNCTION memory_edit(uuid, text, text, text, text, text) TO app_user;
GRANT EXECUTE ON FUNCTION memory_delete(uuid, boolean) TO app_user;
REVOKE CREATE ON SCHEMA public FROM memory_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE memory_definer FROM CURRENT_USER;
  END IF;
END
$$;
